import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryPublishStateStore } from "./cadence.js";
import { FacebookPageProvider, type FacebookPageOptions } from "./facebook.js";
import { startFakeGraph, type FakeGraph } from "./fake-graph.js";
import { AllowAllApprovalHook, DenyAllApprovalHook, type ApprovalHook } from "./publish.js";

// Failure modes, written before the code (issue #10). Each test runs
// the provider against a fake Graph API server over real HTTP.
// 1. token expired  2. permission missing  3. rate limit + Retry-After
// 4. content rejected  5. duplicate key  6. live post without approval,
// with a denial, or with the switch off  7. schedule out of range
// 8. token leaks into an error  9. cron retry after a timeout where the
// first call actually succeeded.
// Review round (Codex): 10. two calls at once both post. 11. a pending
// post not yet visible gets posted again. 12. a 5xx that hid a real
// post is retried as a new post.

const NOW = 1_773_158_400; // 2026-03-10T16:00:00Z
const TOKEN = "EAAfakePageToken0123456789abcdef";
let graph: FakeGraph;

beforeEach(async () => {
  graph = await startFakeGraph({ slowMs: 300, now: () => NOW });
});
afterEach(async () => {
  await graph.close();
});

function provider(pageId: string, extra: Partial<FacebookPageOptions> = {}): FacebookPageProvider {
  return new FacebookPageProvider({
    token: async () => TOKEN,
    pageId: () => pageId,
    state: new MemoryPublishStateStore(),
    live: true,
    baseUrl: graph.url,
    now: () => NOW * 1000,
    ...extra,
  });
}

const LIVE = { dryRun: false, approval: new AllowAllApprovalHook() as ApprovalHook };
const ITEM = { brand: "acme", key: "tip-001", text: "Tip of the day", link: "https://example.com/tip" };

describe("facebook-page provider", () => {
  test("previews by default and calls nothing", async () => {
    const result = await provider("page-1").publish(ITEM);
    expect(result).toMatchObject({
      status: "preview",
      idempotencyKey: "facebook-page:acme:tip-001",
      request: { method: "POST", path: "/page-1/feed", fields: { message: "Tip of the day", link: "https://example.com/tip" } },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(graph.requests).toHaveLength(0);
  });

  test("publishes once, keeps the token out of the URL, and skips a second publish of the key", async () => {
    const fb = provider("page-1");
    const first = await fb.publish(ITEM, LIVE);
    expect(first).toMatchObject({ status: "published", postId: "page-1_1" });
    expect(graph.requests[0].path).not.toContain(TOKEN);
    expect(graph.requests[0].auth).toBe(`Bearer ${TOKEN}`);
    const second = await fb.publish(ITEM, LIVE);
    expect(second).toMatchObject({ status: "duplicate", postId: "page-1_1" });
    expect(graph.posts).toHaveLength(1);
  });

  test("blocks a live post without approval, on denial, or with the switch off", async () => {
    expect(await provider("page-1").publish(ITEM, { dryRun: false })).toMatchObject({ status: "blocked", reason: "no-approval-hook" });
    expect(await provider("page-1").publish(ITEM, { dryRun: false, approval: new DenyAllApprovalHook() })).toMatchObject({
      status: "blocked",
      reason: "approval-denied",
    });
    expect(await provider("page-1", { live: false }).publish(ITEM, LIVE)).toMatchObject({ status: "blocked", reason: "provider-switch-off" });
    expect(graph.posts).toHaveLength(0);
  });

  test("classifies an expired token and never echoes it", async () => {
    const result = await provider("page-1", { token: async () => `expired-${TOKEN}` }).publish(ITEM, LIVE);
    expect(result).toMatchObject({ status: "failed", error: { kind: "token-expired", graphCode: 190, retryable: false } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("classifies missing permission, a rate limit with Retry-After, and rejected content", async () => {
    expect(await provider("page-noperm").publish(ITEM, LIVE)).toMatchObject({
      error: { kind: "permission-missing", graphCode: 200, retryable: false },
    });
    expect(await provider("page-busy").publish(ITEM, LIVE)).toMatchObject({
      error: { kind: "rate-limited", retryAfterSeconds: 120, retryable: true },
    });
    expect(await provider("page-1").publish({ ...ITEM, text: "BLOCKED words" }, LIVE)).toMatchObject({
      error: { kind: "content-rejected", graphCode: 368, retryable: false },
    });
  });

  test("two calls at once post once", async () => {
    const fb = provider("page-1");
    const results = await Promise.all([fb.publish(ITEM, LIVE), fb.publish(ITEM, LIVE)]);
    expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "published"]);
    expect(graph.posts).toHaveLength(1);
  });

  test("a 5xx stays pending, and a pending post not yet visible is not posted again", async () => {
    const state = new MemoryPublishStateStore();
    expect(await provider("page-down", { state }).publish(ITEM, LIVE)).toMatchObject({ error: { kind: "unknown-outcome" } });
    expect((await state.get("facebook-page:acme:tip-001"))?.status).toBe("pending");
    graph.posts.length = 0; // the Page feed does not show it yet
    expect(await provider("page-1", { state }).publish(ITEM, LIVE)).toMatchObject({ error: { kind: "unknown-outcome" } });
    expect(graph.posts).toHaveLength(0);
    const later = provider("page-1", { state, now: () => (NOW + 601) * 1000 });
    expect(await later.publish(ITEM, LIVE)).toMatchObject({ status: "published" });
  });

  test("schedules 10 minutes to 30 days ahead and rejects anything else", async () => {
    const fb = provider("page-1");
    for (const offset of [9 * 60, 31 * 86_400, -60]) {
      const result = await fb.publish({ ...ITEM, key: `s${offset}`, scheduledAt: NOW + offset }, LIVE);
      expect(result).toMatchObject({ status: "failed", error: { kind: "invalid-input" } });
    }
    const ok = await fb.publish({ ...ITEM, scheduledAt: NOW + 3600 }, LIVE);
    expect(ok).toMatchObject({ status: "scheduled", scheduledFor: NOW + 3600 });
    expect(graph.posts[0]).toMatchObject({ scheduledFor: NOW + 3600 });
    expect(new URLSearchParams(graph.requests[0].body).get("published")).toBe("false");
  });

  test("a token resolver that throws a secret returns token-unavailable without the secret", async () => {
    const result = await provider("page-1", {
      token: async () => {
        throw new Error(`vault said no for ${TOKEN.slice(3)}`);
      },
    }).publish(ITEM, LIVE);
    expect(result).toMatchObject({ status: "failed", error: { kind: "token-unavailable" } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(graph.requests).toHaveLength(0);
  });

  test("a cron retry after a timeout finds the first post and does not post again", async () => {
    const state = new MemoryPublishStateStore();
    const fb = provider("page-slow", { state, timeoutMs: 100 });
    const first = await fb.publish(ITEM, LIVE);
    expect(first).toMatchObject({ status: "failed", error: { kind: "unknown-outcome", retryable: true } });
    expect((await state.get("facebook-page:acme:tip-001"))?.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 400));
    const retry = await provider("page-slow", { state }).publish(ITEM, LIVE);
    expect(retry).toMatchObject({ status: "duplicate", reconciled: true, postId: "page-slow_1" });
    expect(graph.posts).toHaveLength(1);
    expect((await state.get("facebook-page:acme:tip-001"))?.status).toBe("published");
  });

  test("a retry after a definite failure may post again", async () => {
    const state = new MemoryPublishStateStore();
    await provider("page-busy", { state }).publish(ITEM, LIVE);
    expect((await state.get("facebook-page:acme:tip-001"))).toMatchObject({ status: "failed", retryable: true });
    expect(await provider("page-1", { state }).publish(ITEM, LIVE)).toMatchObject({ status: "published" });
  });
});
