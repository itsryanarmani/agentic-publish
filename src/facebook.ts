import { idempotencyKey, postKey, type PublishRecord, type PublishStateStore } from "./cadence.js";
import type { ApprovalHook } from "./publish.js";

// Facebook Page provider. Posts text, with an optional link, to
// /{page-id}/feed on the Graph API. Every outcome is a typed result;
// nothing secret is thrown. A live post needs dryRun false, an approval
// hook that approves the item, and the provider switch (live: true).

export type TokenResolver = (brand: string) => string | Promise<string>;
export type PageIdResolver = (brand: string) => string | Promise<string>;

function envName(prefix: string, brand: string): string {
  return `${prefix}_${brand.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

// The only resolver error whose text is shown: it names env vars, never values.
class MissingEnvError extends Error {}

function fromEnv(prefix: string, brand: string): string {
  const env = typeof process === "undefined" ? {} : process.env;
  const found = env[envName(prefix, brand)] ?? env[prefix];
  if (!found?.trim()) throw new MissingEnvError(`set ${envName(prefix, brand)} or ${prefix}`);
  return found.trim();
}

// Default resolvers. They read FACEBOOK_PAGE_TOKEN_<BRAND> then
// FACEBOOK_PAGE_TOKEN, and FACEBOOK_PAGE_ID_<BRAND> then
// FACEBOOK_PAGE_ID. Inject your own to read a secret store or binding.
export const envTokenResolver: TokenResolver = (brand) => fromEnv("FACEBOOK_PAGE_TOKEN", brand);
export const envPageIdResolver: PageIdResolver = (brand) => fromEnv("FACEBOOK_PAGE_ID", brand);

export interface FacebookPageOptions {
  state: PublishStateStore;
  token?: TokenResolver;
  pageId?: PageIdResolver;
  live?: boolean;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  // A pending post not found on the Page is posted again only after
  // this long, so a slow Page feed cannot cause a second post.
  reconcileGraceMs?: number;
}

export interface FacebookPageItem {
  brand: string;
  text: string;
  key?: string;
  link?: string;
  scheduledAt?: number;
}

export interface FacebookPublishOptions {
  dryRun?: boolean;
  approval?: ApprovalHook;
}

export type FacebookErrorKind = "invalid-input" | "token-unavailable" | "token-expired" | "permission-missing"
  | "rate-limited" | "content-rejected" | "unknown-outcome" | "graph-error";

export interface FacebookPageError {
  kind: FacebookErrorKind;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  graphCode?: number;
  status?: number;
}

type Keyed = { idempotencyKey: string; brand: string; key: string };

export type FacebookPageResult =
  | (Keyed & { status: "preview"; request: { method: "POST"; path: string; fields: Record<string, string> }; existing?: PublishRecord["status"] })
  | (Keyed & { status: "published" | "scheduled"; postId: string; scheduledFor?: number })
  | (Keyed & { status: "duplicate"; postId?: string; reconciled?: boolean })
  | (Keyed & { status: "blocked"; reason: "provider-switch-off" | "no-approval-hook" | "approval-denied" | "approval-failed"; detail?: string })
  | (Keyed & { status: "failed"; error: FacebookPageError });

const MIN_AHEAD = 10 * 60;
const MAX_AHEAD = 30 * 86_400;

export function scrubSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out
    .replace(/(access_token=|Bearer\s+)[^\s&"']+/gi, "$1[redacted]")
    .replace(/\bEAA[A-Za-z0-9]{8,}/g, "[redacted]")
    .slice(0, 300);
}

function classify(status: number, body: unknown, retryAfter: string | null): Omit<FacebookPageError, "message"> {
  const error = (body as { error?: { code?: number; error_subcode?: number } })?.error ?? {};
  const code = typeof error.code === "number" ? error.code : undefined;
  const base = { status, ...(code === undefined ? {} : { graphCode: code }) };
  if (code === 190 || code === 102) return { ...base, kind: "token-expired", retryable: false };
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || status === 403) {
    return { ...base, kind: "permission-missing", retryable: false };
  }
  if (status === 429 || [4, 17, 32, 613, 80001].includes(code ?? -1)) {
    const seconds = Number(retryAfter);
    return { ...base, kind: "rate-limited", retryable: true, ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}) };
  }
  if (code === 368 || code === 506 || code === 1500) return { ...base, kind: "content-rejected", retryable: false };
  return { ...base, kind: "graph-error", retryable: code === 1 || code === 2 };
}

// Per-key locks, shared by every provider that uses the same store.
const LOCKS = new WeakMap<PublishStateStore, Map<string, Promise<unknown>>>();

export class FacebookPageProvider {
  readonly name = "facebook-page";

  constructor(private readonly options: FacebookPageOptions) {}

  private get base(): string {
    return (this.options.baseUrl ?? "https://graph.facebook.com/v21.0").replace(/\/$/, "");
  }

  private nowSeconds(): number {
    return Math.floor((this.options.now ?? Date.now)() / 1000);
  }

  private async call(path: string, token: string, init: RequestInit = {}, timeoutMs = this.options.timeoutMs ?? 10_000): Promise<Response> {
    const run = this.options.fetchFn ?? fetch;
    return run(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // Looks for a post with the same text that went out after the claim.
  // Returns its id, null when absent, or throws when the lookup fails.
  private async findExisting(pageId: string, token: string, record: PublishRecord, text: string): Promise<string | null> {
    const edge = record.scheduledFor ? "scheduled_posts" : "feed";
    const since = Math.floor(Date.parse(record.at) / 1000) - 60;
    let after = "";
    // Read every page; a post on page two still counts. Give up, and
    // stay pending, rather than post again after an incomplete lookup.
    for (let page = 0; page < 10; page += 1) {
      const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
      const response = await this.call(`/${encodeURIComponent(pageId)}/${edge}?fields=id,message,created_time&since=${since}&limit=50${cursor}`, token);
      if (!response.ok) throw new Error(`lookup got status ${response.status}`);
      const body = (await response.json()) as { data?: { id?: string; message?: string }[]; paging?: { next?: string; cursors?: { after?: string } } };
      const found = (body.data ?? []).find((row) => row.message === text && typeof row.id === "string");
      if (found?.id) return found.id;
      after = body.paging?.next ? (body.paging.cursors?.after ?? "") : "";
      if (!after) return null;
    }
    throw new Error("lookup stopped after 10 pages");
  }

  // Calls for one key and one store run one at a time in this process.
  // Across processes, run one writer per store.
  async publish(item: FacebookPageItem, options: FacebookPublishOptions = {}): Promise<FacebookPageResult> {
    const brand = (item.brand ?? "").trim();
    const key = postKey(brand, { text: item.text ?? "", link: item.link, key: item.key });
    const keyed: Keyed = { idempotencyKey: idempotencyKey(this.name, brand, key), brand, key };
    const locks = LOCKS.get(this.options.state) ?? new Map<string, Promise<unknown>>();
    LOCKS.set(this.options.state, locks);
    const run = (locks.get(keyed.idempotencyKey) ?? Promise.resolve()).then(() => this.publishOnce(item, options, keyed));
    locks.set(keyed.idempotencyKey, run.catch(() => undefined));
    return run;
  }

  private async publishOnce(item: FacebookPageItem, options: FacebookPublishOptions, keyed: Keyed): Promise<FacebookPageResult> {
    const { brand, key } = keyed;
    const invalid = (message: string): FacebookPageResult => ({ ...keyed, status: "failed", error: { kind: "invalid-input", message, retryable: false } });
    if (!brand) return invalid("brand must not be empty");
    if (typeof item.text !== "string" || !item.text.trim()) return invalid("text must not be empty");
    if (item.link !== undefined && !/^https?:\/\/.+/.test(item.link)) return invalid("link needs an http(s) URL");
    const now = this.nowSeconds();
    const existing = await this.options.state.get(keyed.idempotencyKey);
    if (existing?.status === "published") return { ...keyed, status: "duplicate", ...(existing.postId ? { postId: existing.postId } : {}) };
    // Checked again before a new POST, so a pending item can still reconcile.
    const ahead = (item.scheduledAt ?? 0) - now;
    const badSchedule = item.scheduledAt !== undefined && (!Number.isInteger(item.scheduledAt) || ahead < MIN_AHEAD || ahead > MAX_AHEAD);
    const scheduleError = "scheduledAt must be unix seconds, 10 minutes to 30 days ahead";
    if (badSchedule && existing?.status !== "pending") return invalid(scheduleError);
    let pageId: string;
    try {
      pageId = (await (this.options.pageId ?? envPageIdResolver)(brand)).trim();
      if (!pageId) throw new Error("empty page id");
    } catch (error) {
      return invalid(`page id unavailable: ${scrubSecrets(String(error instanceof Error ? error.message : error))}`);
    }
    const fields: Record<string, string> = { message: item.text };
    if (item.link) fields.link = item.link;
    if (item.scheduledAt !== undefined) {
      fields.published = "false";
      fields.scheduled_publish_time = String(item.scheduledAt);
    }
    if (options.dryRun ?? true) {
      const path = `/${pageId}/feed`;
      return { ...keyed, status: "preview", request: { method: "POST", path, fields }, ...(existing ? { existing: existing.status } : {}) };
    }
    if (!this.options.live) return { ...keyed, status: "blocked", reason: "provider-switch-off" };
    if (!options.approval) return { ...keyed, status: "blocked", reason: "no-approval-hook" };
    try {
      const post = { text: item.text, targets: ["facebook" as const], brand, ...(item.link ? { link: item.link } : {}) };
      const decision = await options.approval.requestApproval(post, { brand, live: true, key: keyed.idempotencyKey });
      if (!decision.approved) {
        return { ...keyed, status: "blocked", reason: "approval-denied", ...(decision.reason ? { detail: decision.reason } : {}) };
      }
    } catch (error) {
      return { ...keyed, status: "blocked", reason: "approval-failed", detail: scrubSecrets(String(error instanceof Error ? error.message : error)) };
    }
    let token: string;
    try {
      token = (await (this.options.token ?? envTokenResolver)(brand)).trim();
      if (!token) throw new Error("empty token");
    } catch (error) {
      const detail = error instanceof MissingEnvError ? error.message : "the token resolver failed";
      const message = `token unavailable: ${detail}`;
      return { ...keyed, status: "failed", error: { kind: "token-unavailable", message, retryable: false } };
    }
    const scrub = (text: string): string => scrubSecrets(text, [token]);
    const unknown = (detail: string): FacebookPageResult => ({
      ...keyed,
      status: "failed",
      error: { kind: "unknown-outcome", message: scrub(`outcome unknown, will reconcile on retry: ${detail}`), retryable: true },
    });
    if (existing?.status === "pending") {
      try {
        const found = await this.findExisting(pageId, token, existing, item.text);
        if (found) {
          await this.options.state.set({ ...existing, status: "published", postId: found });
          return { ...keyed, status: "duplicate", postId: found, reconciled: true };
        }
      } catch (error) {
        return unknown(`lookup failed: ${String(error instanceof Error ? error.message : error)}`);
      }
      if (now * 1000 - Date.parse(existing.at) < (this.options.reconcileGraceMs ?? 600_000)) {
        return unknown("earlier post not visible on the Page yet");
      }
    }
    if (badSchedule) return invalid(scheduleError);
    const record: PublishRecord = {
      key: keyed.idempotencyKey,
      brand,
      itemKey: key,
      status: "pending",
      at: new Date(now * 1000).toISOString(),
      ...(item.scheduledAt !== undefined ? { scheduledFor: item.scheduledAt } : {}),
    };
    await this.options.state.set(record);
    let response: Response;
    let body: unknown;
    try {
      response = await this.call(`/${encodeURIComponent(pageId)}/feed`, token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      return unknown(String(error instanceof Error ? error.message : error));
    }
    const id = (body as { id?: unknown })?.id;
    if (response.ok && typeof id === "string" && id) {
      await this.options.state.set({ ...record, status: "published", postId: id });
      const scheduled = item.scheduledAt !== undefined;
      return { ...keyed, status: scheduled ? "scheduled" : "published", postId: id, ...(scheduled ? { scheduledFor: item.scheduledAt } : {}) };
    }
    if (response.ok) return unknown("reply had no post id");
    // A 5xx may hide a post that went out: keep it pending and reconcile.
    if (response.status >= 500) return unknown(`Graph status ${response.status}`);
    const graphMessage = (body as { error?: { message?: string } })?.error?.message ?? `status ${response.status}`;
    const error: FacebookPageError = { ...classify(response.status, body, response.headers.get("retry-after")), message: scrub(graphMessage) };
    await this.options.state.set({ ...record, status: "failed", retryable: error.retryable, error: error.kind });
    return { ...keyed, status: "failed", error };
  }
}
