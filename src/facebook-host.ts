import { createRequire } from "node:module";
import { planDaily, type CadenceItem, type DailyCadence, type DailyPlan, type PublishRecord, type PublishStateStore } from "./cadence.js";
import { VendorError } from "./core.js";
import { FacebookPageProvider, type FacebookPageResult } from "./facebook.js";
import type { ApprovalHook } from "./publish.js";

const require = createRequire(import.meta.url);

// Host helpers for the CLI and MCP server. The SDK never calls these on
// its own; a host that wants env and file defaults opts in here.

export function defaultFacebookStatePath(): string {
  return process.env.AGENTIC_PUBLISH_FACEBOOK_STATE ?? ".agentic-publish-facebook-state.json";
}

// One JSON object keyed by idempotency key. Writes go to a temp file
// and then rename, so a crash never leaves half a file. No lock: run one
// writer per state file at a time.
export class FilePublishStateStore implements PublishStateStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, PublishRecord> {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new VendorError(`state: ${this.path} must hold a JSON object`);
      }
      return parsed as Record<string, PublishRecord>;
    } catch (error) {
      if (error instanceof VendorError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw new VendorError(`state: cannot read ${this.path}: ${String(error)}`, { cause: error });
    }
  }

  async get(key: string): Promise<PublishRecord | undefined> {
    return this.read()[key];
  }

  async set(record: PublishRecord): Promise<void> {
    const { writeFileSync, renameSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { dirname } = require("node:path") as typeof import("node:path");
    const all = { ...this.read(), [record.key]: record };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    renameSync(temp, this.path);
  }

  async list(brand: string): Promise<PublishRecord[]> {
    return Object.values(this.read()).filter((r) => r.brand === brand);
  }
}

// Env defaults: AGENTIC_PUBLISH_FACEBOOK_LIVE=1 turns the provider
// switch on; FACEBOOK_GRAPH_BASE_URL and FACEBOOK_GRAPH_TIMEOUT_MS
// override the Graph base and timeout. Tokens and Page ids come from
// the default env resolvers.
export function facebookProviderFromEnv(state?: PublishStateStore): FacebookPageProvider {
  const timeout = Number(process.env.FACEBOOK_GRAPH_TIMEOUT_MS);
  return new FacebookPageProvider({
    state: state ?? new FilePublishStateStore(defaultFacebookStatePath()),
    live: process.env.AGENTIC_PUBLISH_FACEBOOK_LIVE === "1",
    ...(process.env.FACEBOOK_GRAPH_BASE_URL ? { baseUrl: process.env.FACEBOOK_GRAPH_BASE_URL } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

export interface FacebookDailyOptions {
  provider: FacebookPageProvider;
  brand: string;
  items: CadenceItem[];
  cadence: DailyCadence;
  now?: Date;
  dryRun?: boolean;
  approval?: ApprovalHook;
}

export interface FacebookDailyResult {
  plan: DailyPlan;
  result?: FacebookPageResult;
}

// One cron tick: plan, then publish the due item (a preview unless
// dryRun is false). Call it from a Cloudflare cron or a GitHub Action.
export async function runFacebookDaily(options: FacebookDailyOptions): Promise<FacebookDailyResult> {
  const brand = options.brand.trim();
  const plan = planDaily({
    brand,
    items: options.items,
    cadence: options.cadence,
    history: await options.provider.history(brand),
    now: options.now ?? new Date(),
    provider: options.provider.name,
  });
  if (!plan.due) return { plan };
  const { key, text, link, scheduledAt } = plan.item;
  const result = await options.provider.publish(
    { brand, key, text, ...(link ? { link } : {}), ...(scheduledAt !== undefined ? { scheduledAt } : {}) },
    { dryRun: options.dryRun ?? true, approval: options.approval },
  );
  return { plan, result };
}
