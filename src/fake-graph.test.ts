import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startFakeGraph, type FakeGraph } from "./fake-graph.js";

// The fixture must play back each failure the provider tests rely on,
// or those tests prove nothing (issue #13).

let graph: FakeGraph;
beforeEach(async () => {
  graph = await startFakeGraph({ slowMs: 50, now: () => 1000 });
});
afterEach(async () => {
  await graph.close();
});

async function post(page: string, token: string, message: string): Promise<{ status: number; retry: string | null; body: any }> {
  const response = await fetch(`${graph.url}/${page}/feed`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message }).toString(),
  });
  return { status: response.status, retry: response.headers.get("retry-after"), body: await response.json() };
}

describe("fake Graph API", () => {
  test("plays back each scripted failure", async () => {
    expect((await post("page-1", "expired-abc", "x")).body.error).toMatchObject({ code: 190, message: expect.stringContaining("expired-abc") });
    expect(await post("page-noperm", "t", "x")).toMatchObject({ status: 403, body: { error: { code: 200 } } });
    expect(await post("page-busy", "t", "x")).toMatchObject({ status: 400, retry: "120", body: { error: { code: 32 } } });
    expect(await post("page-1", "t", "BLOCKED")).toMatchObject({ body: { error: { code: 368 } } });
    expect(await post("page-1", "", "x")).toMatchObject({ body: { error: { code: 104 } } });
    expect(graph.posts).toHaveLength(0);
  });

  test("stores posts, even when the reply is slow or a 500, and lists them", async () => {
    expect(await post("page-1", "t", "hello")).toMatchObject({ status: 200, body: { id: "page-1_1" } });
    expect(await post("page-slow", "t", "slow")).toMatchObject({ status: 200 });
    expect(await post("page-down", "t", "down")).toMatchObject({ status: 500, body: { error: { code: 2 } } });
    const feed = await fetch(`${graph.url}/page-down/feed?fields=id,message`, { headers: { authorization: "Bearer t" } });
    expect((await feed.json()).data).toEqual([{ id: "page-down_3", message: "down", created_time: new Date(1_000_000).toISOString() }]);
    expect(graph.requests.at(-1)).toMatchObject({ method: "GET", auth: "Bearer t" });
    await post("page-1", "t", "second");
    const page1 = await (await fetch(`${graph.url}/page-1/feed?limit=1`, { headers: { authorization: "Bearer t" } })).json();
    expect(page1).toMatchObject({ data: [{ message: "second" }], paging: { cursors: { after: "1" } } });
    const page2 = await (await fetch(`${graph.url}/page-1/feed?limit=1&after=1`, { headers: { authorization: "Bearer t" } })).json();
    expect(page2).toEqual({ data: [expect.objectContaining({ message: "hello" })], paging: {} });
  });
});
