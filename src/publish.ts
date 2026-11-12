import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { postKey } from "./cadence.js";
import { GuardError, VendorError, recordCost, type Guards, type Logger } from "./core.js";

const require = createRequire(import.meta.url);

// Channels. Four direct channels, each with a char limit. TikTok and
// Instagram need media; a text-only direct post to them fails fast.

export type Channel = "x" | "linkedin" | "tiktok" | "instagram";

export const CHANNELS: Channel[] = ["x", "linkedin", "tiktok", "instagram"];

export interface ChannelLimit {
  channel: Channel;
  maxChars: number;
  needsMedia: boolean;
}

export const CHANNEL_LIMITS: Record<Channel, ChannelLimit> = {
  x: { channel: "x", maxChars: 280, needsMedia: false },
  linkedin: { channel: "linkedin", maxChars: 3000, needsMedia: false },
  tiktok: { channel: "tiktok", maxChars: 2200, needsMedia: true },
  instagram: { channel: "instagram", maxChars: 2200, needsMedia: true },
};

// Post shapes. One post feeds every adapter. Aggregators take the
// targets as platform names; direct adapters take one channel each.

export interface SocialPost {
  text: string;
  targets: Channel[];
  mediaUrls?: string[];
  link?: string;
  firstComment?: string;
  brand?: string;
}

export interface PublishReceipt {
  adapter: string;
  id: string;
  targets: Channel[];
  at: string;
  detail?: string;
}

export interface PublishAdapter {
  readonly name: string;
  publish(post: SocialPost): Promise<PublishReceipt>;
}

function isChannel(value: unknown): value is Channel {
  return (
    typeof value === "string" && (CHANNELS as string[]).includes(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/.+/.test(value);
}

export function normalizeTargets(value: unknown): Channel[] {
  const list = Array.isArray(value) ? value : [value];
  const out: Channel[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") {
      throw new VendorError("publish: each target must be a channel name");
    }
    for (const part of raw.split(",")) {
      const name = part.trim().toLowerCase();
      if (name.length === 0) continue;
      const alias = name === "twitter" ? "x" : name;
      if (!isChannel(alias)) {
        throw new VendorError(
          `publish: unknown target "${part.trim()}" (want ${CHANNELS.join(", ")})`,
        );
      }
      if (!out.includes(alias)) out.push(alias);
    }
  }
  if (out.length === 0) {
    throw new VendorError("publish: targets needs at least one channel");
  }
  return out;
}

export function validatePost(post: SocialPost): void {
  if (!post || typeof post !== "object") {
    throw new VendorError("publish: post must be an object");
  }
  if (typeof post.text !== "string" || post.text.trim().length === 0) {
    throw new VendorError("publish: text must not be empty");
  }
  const targets = normalizeTargets(post.targets);
  for (const target of targets) {
    const limit = CHANNEL_LIMITS[target];
    if (post.text.length > limit.maxChars) {
      throw new VendorError(
        `publish: text has ${post.text.length} chars, ${target} allows ${limit.maxChars}`,
      );
    }
  }
  if (post.mediaUrls !== undefined) {
    if (!Array.isArray(post.mediaUrls)) {
      throw new VendorError("publish: mediaUrls must be an array");
    }
    for (const url of post.mediaUrls) {
      if (!isHttpUrl(url)) {
        throw new VendorError("publish: each mediaUrl needs an http(s) URL");
      }
    }
  }
  if (post.link !== undefined && !isHttpUrl(post.link)) {
    throw new VendorError("publish: link needs an http(s) URL");
  }
}

// Remote base. Adapters throw VendorError on missing keys, on network
// faults, and on non-2xx replies. They never swallow a failure.

export interface AdapterOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  sleepMs?: (ms: number) => Promise<void>;
}

type Row = Record<string, unknown>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function object(value: unknown, what: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VendorError(`bad payload: expected object for ${what}`);
  }
  return value as Row;
}

function receiptId(value: unknown, adapter: string, fields: string[]): string {
  const row = object(value, `${adapter} receipt`);
  for (const field of fields) {
    const found = row[field];
    if (typeof found === "string" && found.length > 0) return found;
    if (typeof found === "number") return String(found);
  }
  throw new VendorError(`${adapter}: bad payload, missing receipt id`);
}

function dataOf(value: unknown, adapter: string): Row {
  const row = object(value, `${adapter} reply`);
  if ("data" in row) return object(row.data, `${adapter} data`);
  return row;
}

abstract class RemoteAdapter implements PublishAdapter {
  abstract readonly name: string;

  constructor(protected options: AdapterOptions = {}) {}

  abstract publish(post: SocialPost): Promise<PublishReceipt>;

  protected key(env: string): string {
    const found = this.options.apiKey ?? process.env[env];
    if (!found?.trim()) {
      throw new VendorError(`${this.name}: missing ${env}`);
    }
    return found;
  }

  protected opt(env: string): string | undefined {
    const found = process.env[env];
    return found?.trim() ? found : undefined;
  }

  protected sleep(ms: number): Promise<void> {
    return (this.options.sleepMs ?? defaultSleep)(ms);
  }

  protected async request(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = this.options.timeoutMs ?? 10000,
  ): Promise<Response> {
    let response: Response;
    try {
      const run = this.options.fetchFn ?? fetch;
      response = await run(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new VendorError(`${this.name}: request failed: ${String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const hint = body.trim().slice(0, 200);
      throw new VendorError(
        `${this.name}: got status ${response.status} from ${url}${hint ? ` (${hint})` : ""}`,
        { status: response.status },
      );
    }
    return response;
  }

  protected async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(url, init);
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new VendorError(`${this.name}: bad JSON from ${url}`, { cause: error });
    }
  }

  protected receipt(targets: Channel[], id: string, detail?: string): PublishReceipt {
    return { adapter: this.name, id, targets: [...targets], at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  }
}

function bearer(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

function aggregatorPlatforms(targets: Channel[]): string[] {
  return targets.map((target) => (target === "x" ? "twitter" : target));
}

// Content Rabbit. First in the chain. Creates a draft post, then
// publishes it to each target. Base:
// https://contentrabbitai.com/api/public/v1

export class ContentRabbitAdapter extends RemoteAdapter {
  readonly name = "private-repo-c4e6";

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const apiKey = this.key("CONTENT_RABBIT_API_KEY");
    const base =
      this.options.baseUrl ??
      this.opt("CONTENT_RABBIT_BASE_URL") ??
      "https://contentrabbitai.com/api/public/v1";
    const platforms = aggregatorPlatforms(post.targets);
    const created = dataOf(
      await this.json(`${base}/posts`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          platformType: platforms[0],
          content: post.text,
          publishedPlatforms: platforms,
        }),
      }),
      this.name,
    );
    const id = receiptId(created, this.name, ["id"]);
    const body: Record<string, unknown> = { platforms };
    if (post.firstComment) body.firstComment = post.firstComment;
    const published = dataOf(
      await this.json(`${base}/posts/${id}/publish`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify(body),
      }),
      this.name,
    );
    const results = Array.isArray(published.results) ? published.results : [];
    const failures = results
      .map((entry) => object(entry, `${this.name} result`))
      .filter((entry) => entry.success === false);
    if (failures.length > 0) {
      const detail = failures
        .map((entry) => `${String(entry.platform ?? "?")}: ${String(entry.error ?? "failed")}`)
        .join("; ");
      throw new VendorError(`${this.name}: publish failed (${detail})`);
    }
    return this.receipt(post.targets, id);
  }
}

// Zernio. Backup when Content Rabbit fails. One call creates and
// publishes the post. Base: https://zernio.com/api/v1

export class ZernioAdapter extends RemoteAdapter {
  readonly name = "zernio";

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const apiKey = this.key("ZERNIO_API_KEY");
    const base =
      this.options.baseUrl ?? this.opt("ZERNIO_BASE_URL") ?? "https://zernio.com/api/v1";
    const created = dataOf(
      await this.json(`${base}/posts`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          content: post.text,
          platforms: aggregatorPlatforms(post.targets).map((platform) => ({ platform })),
          mediaUrls: post.mediaUrls ?? [],
          publishNow: true,
        }),
      }),
      this.name,
    );
    return this.receipt(post.targets, receiptId(created, this.name, ["id", "postId"]));
  }
}

// Ayrshare. Second backup. One call posts to each target.
// Base: https://app.ayrshare.com/api

export class AyrshareAdapter extends RemoteAdapter {
  readonly name = "ayrshare";

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const apiKey = this.key("AYRSHARE_API_KEY");
    const base =
      this.options.baseUrl ?? this.opt("AYRSHARE_BASE_URL") ?? "https://app.ayrshare.com/api";
    const created = dataOf(
      await this.json(`${base}/post`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          post: `${post.text}${post.link ? ` ${post.link}` : ""}`,
          platforms: aggregatorPlatforms(post.targets),
          ...(post.mediaUrls?.length ? { mediaUrls: post.mediaUrls } : {}),
        }),
      }),
      this.name,
    );
    return this.receipt(post.targets, receiptId(created, this.name, ["id"]));
  }
}

// Direct X. Posts text to X with a user-context bearer token.
// Postiz. Self-hosted, so no per-profile fee. You run the server and
// supply one integration id per channel: POSTIZ_INTEGRATION_INSTAGRAM,
// POSTIZ_INTEGRATION_TIKTOK, and so on. Base: POSTIZ_BASE_URL.

export class PostizAdapter extends RemoteAdapter {
  readonly name = "postiz";

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const apiKey = this.key("POSTIZ_API_KEY");
    const base = this.options.baseUrl ?? this.opt("POSTIZ_BASE_URL") ?? "http://localhost:3000/api";
    const platforms = aggregatorPlatforms(post.targets);
    const posts = platforms.map((platform) => {
      const integration = this.opt(`POSTIZ_INTEGRATION_${platform.toUpperCase()}`);
      if (!integration) {
        throw new VendorError(`postiz: set POSTIZ_INTEGRATION_${platform.toUpperCase()} for ${platform}`);
      }
      return {
        integration: { id: integration },
        value: [{ content: post.text, ...(post.mediaUrls?.length ? { image: post.mediaUrls.map((path) => ({ path })) } : {}) }],
        settings: {},
      };
    });
    const created = dataOf(
      await this.json(`${base}/public/v1/posts`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({ type: "now", date: new Date().toISOString(), posts }),
      }),
      this.name,
    );
    return this.receipt(post.targets, receiptId(created, this.name, ["id", "postId"]));
  }
}

// Phone. Queues a post task for agentic-device on the owner's phone.
// It never posts by itself; the phone claims and runs the task.

export interface PhoneAdapterOptions extends AdapterOptions {
  enqueue?: (task: { platform: string; text: string; mediaUrls?: string[] }) => string;
}

export class PhoneAdapter extends RemoteAdapter {
  readonly name = "phone";
  private readonly enqueueFn?: PhoneAdapterOptions["enqueue"];

  constructor(options: PhoneAdapterOptions = {}) {
    super(options);
    this.enqueueFn = options.enqueue;
  }

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const targets = aggregatorPlatforms(post.targets);
    const ids = targets.map((platform) =>
      this.enqueueFn
        ? this.enqueueFn({ platform, text: post.text, mediaUrls: post.mediaUrls })
        : `phone-task-${platform}-${Date.now()}`,
    );
    return this.receipt(post.targets, ids.join(","));
  }
}

// Media needs uploaded media ids, which this adapter does not mint.

export class XAdapter extends RemoteAdapter {
  readonly name = "x";

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    if (post.mediaUrls?.length) {
      throw new VendorError(
        "x: direct posts take text only; route media posts via private-repo-c4e6",
      );
    }
    const apiKey = this.key("X_BEARER_TOKEN");
    const base = this.options.baseUrl ?? this.opt("X_BASE_URL") ?? "https://api.x.com";
    const created = dataOf(
      await this.json(`${base}/2/tweets`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({ text: post.text }),
      }),
      this.name,
    );
    return this.receipt(post.targets, receiptId(created, this.name, ["id"]));
  }
}

// Direct LinkedIn. Posts text, or an article share when the post
// carries a link. Needs an author URN for the member or org.

export interface LinkedInOptions extends AdapterOptions {
  authorUrn?: string;
}

export class LinkedInAdapter extends RemoteAdapter {
  readonly name = "linkedin";

  constructor(protected override options: LinkedInOptions = {}) {
    super(options);
  }

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    if (post.mediaUrls?.length) {
      throw new VendorError(
        "linkedin: direct posts take text or a link; route media posts via private-repo-c4e6",
      );
    }
    const apiKey = this.key("LINKEDIN_ACCESS_TOKEN");
    const author =
      this.options.authorUrn ?? process.env.LINKEDIN_AUTHOR_URN ?? "";
    if (!/^urn:li:(person|organization):.+/.test(author)) {
      throw new VendorError(
        "linkedin: missing LINKEDIN_AUTHOR_URN (urn:li:person:... or urn:li:organization:...)",
      );
    }
    const base =
      this.options.baseUrl ?? this.opt("LINKEDIN_BASE_URL") ?? "https://api.linkedin.com";
    const shareContent: Row = {
      shareCommentary: { text: post.text },
      shareMediaCategory: post.link ? "ARTICLE" : "NONE",
    };
    if (post.link) {
      shareContent.media = [{ status: "READY", originalUrl: post.link }];
    }
    const response = await this.request(`${base}/v2/ugcPosts`, {
      method: "POST",
      headers: {
        ...bearer(apiKey),
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author,
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": shareContent },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const id = response.headers.get("x-restli-id") ?? "";
    if (!id) {
      throw new VendorError("linkedin: bad payload, missing receipt id");
    }
    return this.receipt(post.targets, id);
  }
}

function videoExt(url: string): boolean {
  return /\.(mp4|mov|webm)(\?|#|$)/i.test(url);
}

// Direct TikTok. Fetches the first media URL, inits a file upload,
// sends the bytes, then reads the publish status once. Needs a video:
// TikTok has no text-only post.

export interface TikTokOptions extends AdapterOptions {
  openId?: string;
}

export class TikTokAdapter extends RemoteAdapter {
  readonly name = "tiktok";

  constructor(protected override options: TikTokOptions = {}) {
    super(options);
  }

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const media = post.mediaUrls?.[0];
    if (!media || !videoExt(media)) {
      throw new VendorError("tiktok: direct posts need one video mediaUrl (.mp4, .mov, .webm)");
    }
    const apiKey = this.key("TIKTOK_ACCESS_TOKEN");
    const openId = this.options.openId ?? process.env.TIKTOK_OPEN_ID ?? "";
    if (!openId.trim()) {
      throw new VendorError("tiktok: missing TIKTOK_OPEN_ID");
    }
    const mediaResponse = await this.request(media);
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (bytes.length === 0) {
      throw new VendorError("tiktok: media download came back empty");
    }
    const base =
      this.options.baseUrl ?? this.opt("TIKTOK_BASE_URL") ?? "https://open.tiktokapis.com";
    const init = dataOf(
      await this.json(`${base}/v2/post/publish/content/init/`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          post_info: { title: post.text, privacy_level: "PUBLIC_TO_EVERYONE" },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: bytes.length,
            chunk_size: bytes.length,
            total_chunk_count: 1,
          },
        }),
      }),
      this.name,
    );
    const publishId = receiptId(init, this.name, ["publish_id", "publishId"]);
    const uploadUrl = object(init, `${this.name} init`).upload_url;
    if (typeof uploadUrl !== "string" || !uploadUrl) {
      throw new VendorError("tiktok: bad payload, missing upload url");
    }
    await this.request(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "video/mp4",
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      // fetch types accept BufferSource; cast keeps older lib defs happy.
      body: bytes as unknown as BodyInit,
    });
    const status = dataOf(
      await this.json(`${base}/v2/post/publish/status/fetch/`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({ open_id: openId, publish_id: publishId }),
      }),
      this.name,
    );
    const state = String(object(status, `${this.name} status`).status ?? "");
    if (state === "FAILED") {
      throw new VendorError("tiktok: publish failed on TikTok status read");
    }
    return this.receipt(post.targets, publishId, state ? `status ${state}` : undefined);
  }
}

// Direct Instagram. Creates a media container, waits while a reel
// processes, then publishes the container. Needs one media URL.

export interface InstagramOptions extends AdapterOptions {
  userId?: string;
  statusTries?: number;
  statusWaitMs?: number;
}

export class InstagramAdapter extends RemoteAdapter {
  readonly name = "instagram";

  constructor(protected override options: InstagramOptions = {}) {
    super(options);
  }

  async publish(post: SocialPost): Promise<PublishReceipt> {
    validatePost(post);
    const media = post.mediaUrls?.[0];
    if (!media) {
      throw new VendorError("instagram: direct posts need one mediaUrl");
    }
    const apiKey = this.key("INSTAGRAM_ACCESS_TOKEN");
    const userId = this.options.userId ?? process.env.INSTAGRAM_USER_ID ?? "";
    if (!userId.trim()) {
      throw new VendorError("instagram: missing INSTAGRAM_USER_ID");
    }
    const base =
      this.options.baseUrl ?? this.opt("INSTAGRAM_BASE_URL") ?? "https://graph.facebook.com/v21.0";
    const auth = `access_token=${encodeURIComponent(apiKey)}`;
    const isReel = videoExt(media);
    const container = dataOf(
      await this.json(
        `${base}/${userId}/media?${auth}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            isReel
              ? { media_type: "REELS", video_url: media, caption: post.text }
              : { image_url: media, caption: post.text },
          ),
        },
      ),
      this.name,
    );
    const containerId = receiptId(container, this.name, ["id"]);
    if (isReel) {
      const tries = this.options.statusTries ?? 10;
      const waitMs = this.options.statusWaitMs ?? 5000;
      for (let attempt = 0; attempt < tries; attempt += 1) {
        const state = dataOf(
          await this.json(`${base}/${containerId}?fields=status_code&${auth}`),
          this.name,
        );
        const code = String(object(state, `${this.name} status`).status_code ?? "");
        if (code === "FINISHED") break;
        if (code === "ERROR") {
          throw new VendorError("instagram: reel processing failed");
        }
        if (attempt === tries - 1) {
          throw new VendorError("instagram: reel still processing after status reads");
        }
        await this.sleep(waitMs);
      }
    }
    const published = dataOf(
      await this.json(`${base}/${userId}/media_publish?${auth}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creation_id: containerId }),
      }),
      this.name,
    );
    return this.receipt(post.targets, receiptId(published, this.name, ["id"]));
  }
}

// Pacer. Anti-flag pacing: each channel keeps a minimum gap between
// posts, plus a random jitter so posts never fall on a fixed beat.

export interface PacerOptions {
  minIntervalMs?: Partial<Record<Channel, number>>;
  jitterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PacerChannelStatus {
  channel: Channel;
  minIntervalMs: number;
  lastSentAt: number | null;
  nextAllowedAt: number | null;
  delayMs: number;
}

const DEFAULT_INTERVALS: Record<Channel, number> = {
  x: 90_000,
  linkedin: 180_000,
  tiktok: 300_000,
  instagram: 300_000,
};

export class Pacer {
  private readonly intervals: Record<Channel, number>;
  private readonly jitterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastSent = new Map<Channel, number>();

  constructor(options: PacerOptions = {}) {
    this.intervals = { ...DEFAULT_INTERVALS, ...(options.minIntervalMs ?? {}) };
    for (const channel of CHANNELS) {
      const value = this.intervals[channel];
      if (!Number.isFinite(value) || value < 0) {
        throw new VendorError(`pacer: minIntervalMs for ${channel} must be 0 or more`);
      }
    }
    this.jitterMs = options.jitterMs ?? 15_000;
    if (!Number.isFinite(this.jitterMs) || this.jitterMs < 0) {
      throw new VendorError("pacer: jitterMs must be 0 or more");
    }
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  delayFor(channel: Channel): number {
    const last = this.lastSent.get(channel);
    if (last === undefined) return 0;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    return Math.max(0, last + this.intervals[channel] + jitter - this.now());
  }

  markSent(channel: Channel): void {
    this.lastSent.set(channel, this.now());
  }

  async waitForSlot(channel: Channel): Promise<number> {
    const delay = this.delayFor(channel);
    if (delay > 0) await this.sleep(delay);
    return delay;
  }

  status(): PacerChannelStatus[] {
    return CHANNELS.map((channel) => {
      const last = this.lastSent.get(channel) ?? null;
      const delay = this.delayFor(channel);
      return {
        channel,
        minIntervalMs: this.intervals[channel],
        lastSentAt: last,
        nextAllowedAt: last === null ? null : last + this.intervals[channel],
        delayMs: delay,
      };
    });
  }
}

// Brand queues. Each brand holds its own FIFO queue so one loud
// brand never blocks another. Draining paces, approves, and
// publishes each entry in order.

export interface QueuedPost {
  id: string;
  brand: string;
  // Stable post key; see postKey(). Entries saved before keys existed
  // have none.
  key?: string;
  post: SocialPost;
  enqueuedAt: string;
  attempts: number;
}

export interface QueueStore {
  load(): QueuedPost[];
  save(items: QueuedPost[]): void;
}

export function defaultQueuePath(): string {
  return process.env.AGENTIC_PUBLISH_QUEUE ?? ".agentic-publish-queue.json";
}

export class MemoryQueueStore implements QueueStore {
  private items: QueuedPost[] = [];

  load(): QueuedPost[] {
    return this.items.map((item) => ({ ...item, post: { ...item.post } }));
  }

  save(items: QueuedPost[]): void {
    this.items = items.map((item) => ({ ...item, post: { ...item.post } }));
  }
}

export class FileQueueStore implements QueueStore {
  constructor(private readonly path: string) {}

  load(): QueuedPost[] {
    // Dynamic import keeps the worker bundle free of node:fs.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new VendorError(`queue: ${this.path} must hold a JSON array`);
      }
      return parsed.map((entry) => {
        const row = object(entry, "queue entry");
        if (typeof row.id !== "string" || typeof row.brand !== "string") {
          throw new VendorError(`queue: ${this.path} holds a bad entry`);
        }
        validatePost(row.post as SocialPost);
        return {
          id: row.id,
          brand: row.brand,
          ...(typeof row.key === "string" ? { key: row.key } : {}),
          post: row.post as SocialPost,
          enqueuedAt: typeof row.enqueuedAt === "string" ? row.enqueuedAt : new Date(0).toISOString(),
          attempts: typeof row.attempts === "number" ? row.attempts : 0,
        };
      });
    } catch (error) {
      if (error instanceof VendorError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new VendorError(`queue: cannot read ${this.path}: ${String(error)}`, { cause: error });
    }
  }

  save(items: QueuedPost[]): void {
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { dirname } = require("node:path") as typeof import("node:path");
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new VendorError(`queue: cannot write ${this.path}: ${String(error)}`, { cause: error });
    }
  }
}

// Approval hooks. A live publish asks the hook first. Wire the HTTP
// hook to agentic-approve: it posts { post, context } and reads
// { approved, reason?, approver? }.

export interface ApprovalContext {
  brand?: string;
  live: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  approver?: string;
}

export interface ApprovalHook {
  readonly name: string;
  requestApproval(post: SocialPost, context: ApprovalContext): Promise<ApprovalDecision>;
}

export class AllowAllApprovalHook implements ApprovalHook {
  readonly name = "allow-all";

  async requestApproval(
    _post: SocialPost,
    _context: ApprovalContext,
  ): Promise<ApprovalDecision> {
    return { approved: true, approver: "allow-all" };
  }
}

export class DenyAllApprovalHook implements ApprovalHook {
  readonly name = "deny-all";

  async requestApproval(
    _post: SocialPost,
    _context: ApprovalContext,
  ): Promise<ApprovalDecision> {
    return { approved: false, reason: "deny-all hook refuses every live publish" };
  }
}

export interface HttpApprovalOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  apiKey?: string;
}

export class HttpApprovalHook implements ApprovalHook {
  readonly name = "http";
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(url?: string, options: HttpApprovalOptions = {}) {
    const resolved = url ?? process.env.AGENTIC_APPROVE_URL ?? "";
    if (!isHttpUrl(resolved)) {
      throw new VendorError("approval: hook needs an http(s) AGENTIC_APPROVE_URL");
    }
    this.url = resolved;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.apiKey = options.apiKey ?? process.env.AGENTIC_APPROVE_KEY;
  }

  async requestApproval(post: SocialPost, context: ApprovalContext): Promise<ApprovalDecision> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ post, context }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`approval: hook request failed: ${String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new VendorError(`approval: hook got status ${response.status}`, { status: response.status });
    }
    let parsed: unknown;
    try {
      parsed = (await response.json()) as unknown;
    } catch (error) {
      throw new VendorError("approval: hook returned bad JSON", { cause: error });
    }
    const row = object(parsed, "approval reply");
    if (typeof row.approved !== "boolean") {
      throw new VendorError("approval: hook reply needs an approved boolean");
    }
    return {
      approved: row.approved,
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
      ...(typeof row.approver === "string" ? { approver: row.approver } : {}),
    };
  }
}

export function approvalHookFromEnv(): ApprovalHook | undefined {
  if (process.env.AGENTIC_PUBLISH_AUTO_APPROVE === "1") {
    return new AllowAllApprovalHook();
  }
  if (process.env.AGENTIC_APPROVE_URL) {
    return new HttpApprovalHook();
  }
  return undefined;
}

// Publish entry. Dry run is the default: it checks guards, calls no
// adapter, and records no cost. A live publish checks guards, asks
// approval, paces each target, then walks the chain in order until
// one adapter wins. Every failed adapter is recorded and reported.

export interface PublishOptions {
  adapters: PublishAdapter[];
  guards?: Guards;
  logger?: Logger;
  dryRun?: boolean;
  approval?: ApprovalHook;
  pacer?: Pacer;
}

export interface ChainAttempt {
  adapter: string;
  ok: boolean;
  error?: string;
}

export type PublishResult =
  | { dryRun: true; targets: Channel[]; adapters: string[] }
  | { dryRun: false; receipt: PublishReceipt; attempts: ChainAttempt[]; approval: ApprovalDecision };

export async function publishPost(post: SocialPost, options: PublishOptions): Promise<PublishResult> {
  validatePost(post);
  if (options.adapters.length === 0) {
    throw new VendorError("publish: select at least one adapter");
  }
  const targets = normalizeTargets(post.targets);
  options.guards?.checkDispatch(post.text);
  if (options.dryRun ?? true) {
    options.logger?.info(`dry run: would publish ${post.text.length} chars to ${targets.join(",")}`);
    return { dryRun: true, targets, adapters: options.adapters.map((a) => a.name) };
  }
  const approval = options.approval;
  if (!approval) {
    throw new VendorError(
      "publish: live send needs an approval hook (set AGENTIC_APPROVE_URL or AGENTIC_PUBLISH_AUTO_APPROVE=1)",
    );
  }
  options.guards?.recordDispatch();
  const decision = await approval.requestApproval(post, { brand: post.brand, live: true });
  if (!decision.approved) {
    throw new GuardError(`approval denied${decision.reason ? `: ${decision.reason}` : ""}`);
  }
  const pacer = options.pacer;
  if (pacer) {
    for (const target of targets) {
      const waited = await pacer.waitForSlot(target);
      if (waited > 0) options.logger?.info(`pacer: waited ${waited}ms for ${target}`);
    }
  }
  const attempts: ChainAttempt[] = [];
  for (const adapter of options.adapters) {
    options.logger?.debug(`publish via ${adapter.name}`);
    try {
      const receipt = await adapter.publish({ ...post, targets });
      recordCost({ kind: "publish", adapter: adapter.name, units: post.text.length });
      if (pacer) for (const target of targets) pacer.markSent(target);
      options.logger?.info(`published via ${adapter.name} as ${receipt.id}`);
      attempts.push({ adapter: adapter.name, ok: true });
      return { dryRun: false, receipt, attempts, approval: decision };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      options.logger?.error(`${adapter.name}: ${text}`);
      attempts.push({ adapter: adapter.name, ok: false, error: text });
      recordCost({ kind: "publish", adapter: adapter.name, units: 0 });
    }
  }
  throw new VendorError(
    `publish: every adapter failed (${attempts.map((a) => `${a.adapter}: ${a.error}`).join("; ")})`,
  );
}

// Adapter sets. The default chain tries Content Rabbit first, then
// Zernio, then Ayrshare. Name direct adapters to pin one channel.

export interface AdapterSetOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export const CHAIN_ADAPTERS = ["private-repo-c4e6", "zernio", "ayrshare", "postiz"] as const;

export function defaultAdapters(options: AdapterSetOptions = {}): PublishAdapter[] {
  const shared = { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs };
  return [new ContentRabbitAdapter(shared), new ZernioAdapter(shared), new AyrshareAdapter(shared), new PostizAdapter(shared)];
}

export function allAdapters(options: AdapterSetOptions = {}): PublishAdapter[] {
  const shared = { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs };
  return [
    ...defaultAdapters(options),
    new XAdapter(shared),
    new LinkedInAdapter(shared),
    new TikTokAdapter(shared),
    new InstagramAdapter(shared),
    new PhoneAdapter(shared),
  ];
}

export function selectAdapters(names: string[], options: AdapterSetOptions = {}): PublishAdapter[] {
  const wanted = names.map((name) => name.trim().toLowerCase()).filter((n) => n.length > 0);
  if (wanted.length === 0 || wanted.includes("all")) {
    return defaultAdapters(options);
  }
  const all = allAdapters(options);
  return wanted.map((name) => {
    const found = all.find((adapter) => adapter.name === name);
    if (!found) {
      throw new VendorError(`publish: unknown adapter "${name}"`);
    }
    return found;
  });
}

// Queue drain. Publishes one brand queue in FIFO order with pacing
// and approval. Sent entries leave the queue; failed entries stay
// with a raised attempt count.

export interface DrainOptions extends PublishOptions {
  brand: string;
  limit?: number;
}

export interface DrainFailure {
  id: string;
  error: string;
}

export interface DrainResult {
  brand: string;
  sent: string[];
  failed: DrainFailure[];
  remaining: number;
  planned?: string[];
}

export class BrandQueue {
  constructor(private readonly store: QueueStore) {}

  // A second enqueue of the same post key for one brand returns the
  // existing entry, so a retried cron cannot queue an item twice.
  enqueue(brand: string, post: SocialPost, options: { key?: string } = {}): QueuedPost {
    const name = brand.trim();
    if (!name) throw new VendorError("queue: brand must not be empty");
    validatePost(post);
    const key = postKey(name, { text: post.text, link: post.link, key: options.key });
    const items = this.store.load();
    const existing = items.find((item) => item.brand === name && item.key === key);
    if (existing) return existing;
    const entry: QueuedPost = {
      id: randomUUID(),
      brand: name,
      key,
      post: { ...post, targets: normalizeTargets(post.targets), brand: name },
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
    items.push(entry);
    this.store.save(items);
    return entry;
  }

  list(brand?: string): QueuedPost[] {
    const items = this.store.load();
    if (!brand) return items;
    return items.filter((item) => item.brand === brand);
  }

  remove(id: string): boolean {
    const items = this.store.load();
    const kept = items.filter((item) => item.id !== id);
    if (kept.length === items.length) return false;
    this.store.save(kept);
    return true;
  }

  async drain(options: DrainOptions): Promise<DrainResult> {
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new VendorError("queue: limit must be an integer of 1 or more");
    }
    const brand = options.brand.trim();
    if (!brand) throw new VendorError("queue: brand must not be empty");
    const items = this.store.load();
    const mine = items.filter((item) => item.brand === brand).slice(0, limit);
    if (options.dryRun ?? true) {
      return {
        brand,
        sent: [],
        failed: [],
        remaining: items.filter((item) => item.brand === brand).length,
        planned: mine.map((item) => item.id),
      };
    }
    const sent: string[] = [];
    const failed: DrainFailure[] = [];
    for (const entry of mine) {
      try {
        const result = await publishPost(entry.post, { ...options, dryRun: false });
        if (!result.dryRun) {
          sent.push(entry.id);
          options.logger?.info(`queue: sent ${entry.id} via ${result.receipt.adapter}`);
        }
      } catch (error) {
        entry.attempts += 1;
        failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const sentSet = new Set(sent);
    this.store.save(items.filter((item) => !sentSet.has(item.id)));
    const remaining = this.store.load().filter((item) => item.brand === brand).length;
    return { brand, sent, failed, remaining };
  }
}
