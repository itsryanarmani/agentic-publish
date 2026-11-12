import { VendorError } from "./core.js";

// Post keys. Each queued item carries a stable key, so a cron that runs
// twice can never post the same item twice. A caller key wins; else the
// key is a hash of brand, text, and link. The hash is a dedupe key, not
// a security control.

export interface KeyedContent {
  text: string;
  link?: string;
  key?: string;
}

function hash53(input: string): string {
  // cyrb53: small, pure, and the same in Node and Workers.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function postKey(brand: string, content: KeyedContent): string {
  const given = content.key?.trim();
  if (given) return given;
  return `h-${hash53(`${brand.trim()}\u0000${content.text}\u0000${content.link ?? ""}`)}`;
}

export function idempotencyKey(provider: string, brand: string, key: string): string {
  return `${provider}:${brand.trim()}:${key}`;
}

// Publish state. One record per idempotency key. A provider writes
// "pending" before the network call and "published" or "failed" after.
// A record left "pending" means the outcome is unknown: the next run
// must reconcile it before it posts again.
//
// Implement this for any store. KV: key = record.key, list by the
// prefix of the brand. D1: one row per key, primary key on key. File:
// one JSON object keyed by key. Run one writer per brand at a time;
// the interface has no lock.

export type PublishStatus = "pending" | "published" | "failed";

export interface PublishRecord {
  key: string;
  brand: string;
  itemKey: string;
  status: PublishStatus;
  at: string;
  postId?: string;
  retryable?: boolean;
  scheduledFor?: number;
  error?: string;
}

export interface PublishStateStore {
  get(key: string): Promise<PublishRecord | undefined>;
  set(record: PublishRecord): Promise<void>;
  list(brand: string): Promise<PublishRecord[]>;
}

export class MemoryPublishStateStore implements PublishStateStore {
  private readonly records = new Map<string, PublishRecord>();

  async get(key: string): Promise<PublishRecord | undefined> {
    const found = this.records.get(key);
    return found ? { ...found } : undefined;
  }

  async set(record: PublishRecord): Promise<void> {
    this.records.set(record.key, { ...record });
  }

  async list(brand: string): Promise<PublishRecord[]> {
    return [...this.records.values()].filter((r) => r.brand === brand).map((r) => ({ ...r }));
  }
}

// Daily cadence. A pure planner: it reads approved items, history, and
// a clock, and returns the next due item or the reason there is none.
// It starts no timers. The host runs it from a cron.

export interface CadenceItem {
  key: string;
  text: string;
  link?: string;
  approved: boolean;
  scheduledAt?: number;
}

export interface DailyCadence {
  timezone: string;
  window: string;
  maxPerDay: number;
}

export interface DailyPlanInput {
  brand: string;
  items: CadenceItem[];
  cadence: DailyCadence;
  history: PublishRecord[];
  now: Date;
  provider?: string;
}

interface PlanBase {
  brand: string;
  localDate: string;
  localTime: string;
  publishedToday: number;
}

export type DailyPlan =
  | (PlanBase & { due: true; item: CadenceItem; idempotencyKey: string; retry: boolean })
  | (PlanBase & { due: false; reason: "outside-window" | "daily-cap" | "queue-empty" });

function minutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new VendorError(`cadence: bad time "${value}" (want HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function localClock(at: Date, timezone: string): { date: string; time: string } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new VendorError(`cadence: unknown timezone "${timezone}"`);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function planDaily(input: DailyPlanInput): DailyPlan {
  const { brand, cadence, now } = input;
  const provider = input.provider ?? "facebook-page";
  const [start, end] = cadence.window.split("-");
  if (start === undefined || end === undefined) {
    throw new VendorError(`cadence: bad window "${cadence.window}" (want HH:MM-HH:MM)`);
  }
  const from = minutes(start);
  const to = minutes(end);
  if (from >= to) throw new VendorError("cadence: window start must come before its end");
  if (!Number.isInteger(cadence.maxPerDay) || cadence.maxPerDay < 1) {
    throw new VendorError("cadence: maxPerDay must be an integer of 1 or more");
  }
  const clock = localClock(now, cadence.timezone);
  const byKey = new Map(input.history.filter((r) => r.brand === brand).map((r) => [r.key, r]));
  const publishedToday = input.history.filter(
    (r) => r.brand === brand && r.status === "published" && localClock(new Date(r.at), cadence.timezone).date === clock.date,
  ).length;
  const base: PlanBase = { brand, localDate: clock.date, localTime: clock.time, publishedToday };
  const nowMinutes = minutes(clock.time);
  if (nowMinutes < from || nowMinutes >= to) return { ...base, due: false, reason: "outside-window" };

  const approved = input.items.filter((item) => item.approved);
  const keyOf = (item: CadenceItem): string => idempotencyKey(provider, brand, item.key);
  // An unknown outcome goes first: the provider reconciles it, so a
  // retried cron never posts a second item in its place.
  const pending = approved.find((item) => byKey.get(keyOf(item))?.status === "pending");
  if (pending) return { ...base, due: true, item: pending, idempotencyKey: keyOf(pending), retry: true };
  if (publishedToday >= cadence.maxPerDay) return { ...base, due: false, reason: "daily-cap" };
  const next = approved.find((item) => {
    const found = byKey.get(keyOf(item));
    return !found || (found.status === "failed" && found.retryable === true);
  });
  if (!next) return { ...base, due: false, reason: "queue-empty" };
  return { ...base, due: true, item: next, idempotencyKey: keyOf(next), retry: false };
}
