import { describe, expect, test } from "vitest";
import { VendorError } from "./core.js";
import {
  idempotencyKey,
  MemoryPublishStateStore,
  planDaily,
  postKey,
  type CadenceItem,
  type DailyCadence,
  type PublishRecord,
} from "./cadence.js";
import { BrandQueue, MemoryQueueStore } from "./publish.js";

// Failure modes, written before the code (issue #9):
// 1. A retried cron enqueues the same item twice.
// 2. The planner picks an item that already has a published record.
// 3. The planner picks an item that is not approved.
// 4. The local day uses UTC instead of the brand timezone.
// 5. now is outside the window, or the daily cap is reached.
// 6. An unknown timezone or a bad window string is accepted.
// 7. A retry after an unknown outcome skips the pending item and
//    posts a second item on the same day.
// Review round (Codex): 8. derived keys ignore targets or media.
// 9. a ":" in brand or key collides. 10. a key with spaces never
// matches its record. 11. a scheduled post counts on the wrong day.
// 12. an item scheduled for tomorrow ignores tomorrow's cap.

const CADENCE: DailyCadence = { timezone: "America/Vancouver", window: "09:00-11:00", maxPerDay: 1 };
const ITEMS: CadenceItem[] = [
  { key: "tip-001", text: "Tip one", approved: true },
  { key: "tip-002", text: "Tip two", link: "https://example.com/two", approved: true },
];

// 2026-03-10 17:30 UTC is 10:30 in Vancouver (PDT, UTC-7).
const IN_WINDOW = new Date("2026-03-10T17:30:00Z");

function record(key: string, status: PublishRecord["status"], at: string, retryable?: boolean): PublishRecord {
  return { key: idempotencyKey("facebook-page", "acme", key), brand: "acme", itemKey: key, status, at, ...(retryable === undefined ? {} : { retryable }) };
}

describe("post keys", () => {
  test("a caller key wins, and a derived key is stable across calls", () => {
    expect(postKey("acme", { text: "Hi", key: "day-1" })).toBe("day-1");
    const a = postKey("acme", { text: "Hi", link: "https://example.com" });
    expect(a).toBe(postKey("acme", { text: "Hi", link: "https://example.com" }));
    expect(a).not.toBe(postKey("globex", { text: "Hi", link: "https://example.com" }));
    expect(a).not.toBe(postKey("acme", { text: "Hi" }));
    expect(postKey("acme", { text: "Hi", parts: ["x"] })).not.toBe(postKey("acme", { text: "Hi", parts: ["linkedin"] }));
    expect(idempotencyKey("p", "acme:eu", "daily")).not.toBe(idempotencyKey("p", "acme", "eu:daily"));
  });

  test("queue keys include targets and media", () => {
    const queue = new BrandQueue(new MemoryQueueStore());
    queue.enqueue("acme", { text: "Same", targets: ["x"] });
    queue.enqueue("acme", { text: "Same", targets: ["linkedin"] });
    queue.enqueue("acme", { text: "Same", targets: ["x"], mediaUrls: ["https://example.com/a.png"] });
    expect(queue.list("acme")).toHaveLength(3);
  });

  test("a retried enqueue returns the existing entry, not a second one", () => {
    const queue = new BrandQueue(new MemoryQueueStore());
    const post = { text: "Daily tip", targets: ["x" as const] };
    const first = queue.enqueue("acme", post, { key: "2026-03-10" });
    const again = queue.enqueue("acme", post, { key: "2026-03-10" });
    expect(again.id).toBe(first.id);
    expect(queue.list("acme")).toHaveLength(1);
    const derived = queue.enqueue("acme", { text: "Other", targets: ["x"] });
    expect(queue.enqueue("acme", { text: "Other", targets: ["x"] }).id).toBe(derived.id);
    expect(queue.enqueue("globex", post, { key: "2026-03-10" }).id).not.toBe(first.id);
    expect(queue.list()).toHaveLength(3);
  });
});

describe("planDaily", () => {
  test("picks the first approved item with no publish record", () => {
    const plan = planDaily({
      brand: "acme",
      items: [{ key: "draft", text: "Not yet", approved: false }, ...ITEMS],
      cadence: CADENCE,
      history: [record("tip-001", "published", "2026-03-09T17:00:00Z")],
      now: IN_WINDOW,
    });
    expect(plan).toMatchObject({ due: true, localDate: "2026-03-10", item: { key: "tip-002" } });
    if (plan.due) expect(plan.idempotencyKey).toBe("facebook-page:acme:tip-002");
  });

  test("counts the day in the brand timezone, not UTC", () => {
    // 05:30 UTC on the 11th is still 22:30 on the 10th in Vancouver.
    const history = [record("tip-001", "published", "2026-03-11T05:30:00Z")];
    const plan = planDaily({ brand: "acme", items: ITEMS, cadence: CADENCE, history, now: IN_WINDOW });
    expect(plan).toMatchObject({ due: false, reason: "daily-cap", publishedToday: 1 });
    const nextDay = planDaily({
      brand: "acme",
      items: ITEMS,
      cadence: CADENCE,
      history,
      now: new Date("2026-03-11T17:30:00Z"),
    });
    expect(nextDay).toMatchObject({ due: true, localDate: "2026-03-11", item: { key: "tip-002" } });
  });

  test("matches a key with spaces to its record", () => {
    const plan = planDaily({
      brand: " acme ",
      items: [{ key: " tip-001 ", text: "Tip one", approved: true }, ...ITEMS.slice(1)],
      cadence: { ...CADENCE, maxPerDay: 5 },
      history: [record("tip-001", "published", "2026-03-01T17:00:00Z")],
      now: IN_WINDOW,
    });
    expect(plan).toMatchObject({ due: true, item: { key: "tip-002" } });
  });

  test("counts a scheduled post on the day it goes out", () => {
    // Sent on the 9th, scheduled for 10:00 on the 10th (17:00 UTC).
    const sent = { ...record("tip-001", "published", "2026-03-09T17:00:00Z"), scheduledFor: Date.parse("2026-03-10T17:00:00Z") / 1000 };
    const plan = planDaily({ brand: "acme", items: ITEMS, cadence: CADENCE, history: [sent], now: IN_WINDOW });
    expect(plan).toMatchObject({ due: false, reason: "daily-cap" });
  });

  test("checks the cap on the day a scheduled item goes out", () => {
    const tomorrow = Date.parse("2026-03-11T17:00:00Z") / 1000;
    const sent = { ...record("tip-001", "published", "2026-03-10T16:30:00Z"), scheduledFor: tomorrow };
    const items: CadenceItem[] = [
      { key: "later", text: "Later", approved: true, scheduledAt: tomorrow + 600 },
      { key: "now", text: "Now", approved: true },
    ];
    const plan = planDaily({ brand: "acme", items, cadence: CADENCE, history: [sent], now: IN_WINDOW });
    expect(plan).toMatchObject({ due: true, item: { key: "now" } });
    const capped = planDaily({ brand: "acme", items: items.slice(0, 1), cadence: CADENCE, history: [sent], now: IN_WINDOW });
    expect(capped).toMatchObject({ due: false, reason: "daily-cap" });
  });

  test("returns no item outside the window", () => {
    const early = planDaily({ brand: "acme", items: ITEMS, cadence: CADENCE, history: [], now: new Date("2026-03-10T15:59:00Z") });
    expect(early).toMatchObject({ due: false, reason: "outside-window", localTime: "08:59" });
    const late = planDaily({ brand: "acme", items: ITEMS, cadence: CADENCE, history: [], now: new Date("2026-03-10T18:00:00Z") });
    expect(late).toMatchObject({ due: false, reason: "outside-window" });
  });

  test("reports an empty queue when every item is done or not approved", () => {
    const plan = planDaily({
      brand: "acme",
      items: ITEMS,
      cadence: { ...CADENCE, maxPerDay: 5 },
      history: [
        record("tip-001", "published", "2026-03-01T17:00:00Z"),
        record("tip-002", "failed", "2026-03-02T17:00:00Z", false),
      ],
      now: IN_WINDOW,
    });
    expect(plan).toMatchObject({ due: false, reason: "queue-empty" });
  });

  test("retries a pending item first, even when the cap is reached", () => {
    const plan = planDaily({
      brand: "acme",
      items: ITEMS,
      cadence: CADENCE,
      history: [record("tip-001", "pending", "2026-03-10T17:00:00Z")],
      now: IN_WINDOW,
    });
    expect(plan).toMatchObject({ due: true, retry: true, item: { key: "tip-001" } });
  });

  test("retries an item whose last failure is retryable", () => {
    const plan = planDaily({
      brand: "acme",
      items: ITEMS,
      cadence: CADENCE,
      history: [record("tip-001", "failed", "2026-03-10T16:05:00Z", true)],
      now: IN_WINDOW,
    });
    expect(plan).toMatchObject({ due: true, item: { key: "tip-001" } });
  });

  test("rejects a bad timezone, window, or cap", () => {
    const base = { brand: "acme", items: ITEMS, history: [], now: IN_WINDOW };
    expect(() => planDaily({ ...base, cadence: { ...CADENCE, timezone: "Mars/Olympus" } })).toThrow(VendorError);
    expect(() => planDaily({ ...base, cadence: { ...CADENCE, window: "9-11" } })).toThrow(VendorError);
    expect(() => planDaily({ ...base, cadence: { ...CADENCE, window: "11:00-09:00" } })).toThrow(VendorError);
    expect(() => planDaily({ ...base, cadence: { ...CADENCE, maxPerDay: 0 } })).toThrow(VendorError);
  });
});

describe("MemoryPublishStateStore", () => {
  test("keeps records apart per brand and returns copies", async () => {
    const store = new MemoryPublishStateStore();
    await store.set(record("tip-001", "published", "2026-03-10T17:00:00Z"));
    await store.set({ ...record("tip-001", "pending", "2026-03-10T17:00:00Z"), brand: "globex", key: "facebook-page:globex:tip-001" });
    const got = await store.get("facebook-page:acme:tip-001");
    expect(got?.status).toBe("published");
    if (got) got.status = "failed";
    expect((await store.get("facebook-page:acme:tip-001"))?.status).toBe("published");
    expect(await store.list("acme")).toHaveLength(1);
    expect(await store.get("missing")).toBeUndefined();
  });
});
