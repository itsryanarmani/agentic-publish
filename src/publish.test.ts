import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createGuards,
  GuardError,
  getCostReport,
  resetCosts,
  VendorError,
} from "./core.js";
import {
  AllowAllApprovalHook,
  AyrshareAdapter,
  BrandQueue,
  CHANNEL_LIMITS,
  ContentRabbitAdapter,
  DenyAllApprovalHook,
  FileQueueStore,
  HttpApprovalHook,
  InstagramAdapter,
  LinkedInAdapter,
  MemoryQueueStore,
  normalizeTargets,
  Pacer,
  publishPost,
  selectAdapters,
  TikTokAdapter,
  validatePost,
  XAdapter,
  ZernioAdapter,
  type PublishAdapter,
  type PublishReceipt,
  type SocialPost,
} from "./publish.js";

const ENV_KEYS = [
  "CONTENT_RABBIT_API_KEY",
  "ZERNIO_API_KEY",
  "AYRSHARE_API_KEY",
  "X_BEARER_TOKEN",
  "LINKEDIN_ACCESS_TOKEN",
  "LINKEDIN_AUTHOR_URN",
  "TIKTOK_ACCESS_TOKEN",
  "TIKTOK_OPEN_ID",
  "INSTAGRAM_ACCESS_TOKEN",
  "INSTAGRAM_USER_ID",
  "AGENTIC_APPROVE_URL",
];

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetCosts();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

type Route = { match: string; reply: () => Response | Promise<Response> };

function stubFetch(routes: Route[]): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    for (const route of routes) {
      if (href.includes(route.match)) return route.reply();
    }
    throw new Error(`no stub route for ${href}`);
  }) as typeof fetch;
}

const POST: SocialPost = { text: "hello world", targets: ["x", "linkedin"] };

function okAdapter(name: string, id = `${name}-1`): PublishAdapter {
  return {
    name,
    publish: async (post): Promise<PublishReceipt> => ({
      adapter: name,
      id,
      targets: post.targets,
      at: "now",
    }),
  };
}

function failAdapter(name: string, message: string): PublishAdapter {
  return {
    name,
    publish: async (): Promise<PublishReceipt> => {
      throw new VendorError(`${name}: ${message}`);
    },
  };
}

describe("validatePost", () => {
  test("accepts a good post", () => {
    expect(() => validatePost(POST)).not.toThrow();
  });

  test("rejects empty text", () => {
    expect(() => validatePost({ text: "  ", targets: ["x"] })).toThrow(VendorError);
  });

  test("rejects unknown targets", () => {
    expect(() => validatePost({ text: "hi", targets: ["fax"] as never })).toThrow(VendorError);
  });

  test("rejects text past the channel limit", () => {
    expect(() => validatePost({ text: "a".repeat(281), targets: ["x"] })).toThrow(/x allows 280/);
  });

  test("rejects bad media and link urls", () => {
    expect(() => validatePost({ text: "hi", targets: ["x"], mediaUrls: ["notaurl"] })).toThrow(VendorError);
    expect(() => validatePost({ text: "hi", targets: ["x"], link: "notaurl" })).toThrow(VendorError);
  });

  test("normalizeTargets splits, dedups, and maps twitter to x", () => {
    expect(normalizeTargets(["twitter, x", "LinkedIn"])).toEqual(["x", "linkedin"]);
  });
});

describe("private-repo-c4e6 adapter", () => {
  test("creates then publishes", async () => {
    setEnv("CONTENT_RABBIT_API_KEY", "k");
    const seen: string[] = [];
    const adapter = new ContentRabbitAdapter({
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        const href = String(url);
        seen.push(`${init?.method} ${href}`);
        if (href.endsWith("/posts/cr_1/publish")) {
          return jsonResponse({ data: { results: [{ platform: "twitter", success: true, status: "published" }] } });
        }
        return jsonResponse({ data: { id: "cr_1" } }, 201);
      }) as typeof fetch,
    });
    const receipt = await adapter.publish(POST);
    expect(receipt).toMatchObject({ adapter: "private-repo-c4e6", id: "cr_1" });
    expect(seen.some((line) => line.includes("/publish"))).toBe(true);
  });

  test("throws when a platform fails", async () => {
    setEnv("CONTENT_RABBIT_API_KEY", "k");
    const adapter = new ContentRabbitAdapter({
      fetchFn: (async (url: unknown) => {
        if (String(url).includes("/publish")) {
          return jsonResponse({ data: { results: [{ platform: "twitter", success: false, error: "banned" }] } });
        }
        return jsonResponse({ data: { id: "cr_2" } }, 201);
      }) as typeof fetch,
    });
    await expect(adapter.publish(POST)).rejects.toThrow(/banned/);
  });

  test("needs a key", async () => {
    await expect(new ContentRabbitAdapter().publish(POST)).rejects.toThrow(/CONTENT_RABBIT_API_KEY/);
  });
});

describe("zernio and ayrshare adapters", () => {
  test("zernio posts once", async () => {
    setEnv("ZERNIO_API_KEY", "k");
    let body: Record<string, unknown> = {};
    const adapter = new ZernioAdapter({
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ data: { id: "z_1" } });
      }) as typeof fetch,
    });
    const receipt = await adapter.publish(POST);
    expect(receipt).toMatchObject({ adapter: "zernio", id: "z_1" });
    expect(body).toMatchObject({ content: "hello world", publishNow: true });
  });

  test("ayrshare appends the link", async () => {
    setEnv("AYRSHARE_API_KEY", "k");
    let body: Record<string, unknown> = {};
    const adapter = new AyrshareAdapter({
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: "a_1" });
      }) as typeof fetch,
    });
    const receipt = await adapter.publish({ ...POST, link: "https://example.com/p" });
    expect(receipt).toMatchObject({ adapter: "ayrshare", id: "a_1" });
    expect(body).toMatchObject({ post: "hello world https://example.com/p" });
  });

  test("both need keys", async () => {
    await expect(new ZernioAdapter().publish(POST)).rejects.toThrow(/ZERNIO_API_KEY/);
    await expect(new AyrshareAdapter().publish(POST)).rejects.toThrow(/AYRSHARE_API_KEY/);
  });
});

describe("direct adapters", () => {
  test("x posts text", async () => {
    setEnv("X_BEARER_TOKEN", "k");
    const adapter = new XAdapter({
      fetchFn: stubFetch([{ match: "/2/tweets", reply: () => jsonResponse({ data: { id: "t_1" } }) }]),
    });
    const receipt = await adapter.publish({ text: "hi", targets: ["x"] });
    expect(receipt).toMatchObject({ adapter: "x", id: "t_1" });
  });

  test("x refuses media", async () => {
    setEnv("X_BEARER_TOKEN", "k");
    await expect(
      new XAdapter().publish({ text: "hi", targets: ["x"], mediaUrls: ["https://example.com/a.png"] }),
    ).rejects.toThrow(/text only/);
  });

  test("linkedin posts and reads the restli id", async () => {
    setEnv("LINKEDIN_ACCESS_TOKEN", "k");
    setEnv("LINKEDIN_AUTHOR_URN", "urn:li:person:abc");
    const adapter = new LinkedInAdapter({
      fetchFn: stubFetch([
        { match: "/v2/ugcPosts", reply: () => jsonResponse({}, 201, { "x-restli-id": "li_1" }) },
      ]),
    });
    const receipt = await adapter.publish({ text: "hi", targets: ["linkedin"] });
    expect(receipt).toMatchObject({ adapter: "linkedin", id: "li_1" });
  });

  test("linkedin needs an author urn", async () => {
    setEnv("LINKEDIN_ACCESS_TOKEN", "k");
    await expect(new LinkedInAdapter().publish({ text: "hi", targets: ["linkedin"] })).rejects.toThrow(
      /LINKEDIN_AUTHOR_URN/,
    );
  });

  test("tiktok runs init, upload, and status", async () => {
    setEnv("TIKTOK_ACCESS_TOKEN", "k");
    setEnv("TIKTOK_OPEN_ID", "open_1");
    const calls: string[] = [];
    const adapter = new TikTokAdapter({
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        const href = String(url);
        calls.push(`${init?.method ?? "GET"} ${href}`);
        if (href.startsWith("https://cdn.example.com/")) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        if (href.includes("/content/init/")) {
          return jsonResponse({ data: { publish_id: "tt_1", upload_url: "https://up.example.com/put" } });
        }
        if (href.includes("up.example.com")) return new Response(null, { status: 200 });
        return jsonResponse({ data: { status: "PROCESSING" } });
      }) as typeof fetch,
    });
    const receipt = await adapter.publish({
      text: "hi",
      targets: ["tiktok"],
      mediaUrls: ["https://cdn.example.com/v.mp4"],
    });
    expect(receipt).toMatchObject({ adapter: "tiktok", id: "tt_1" });
    expect(calls.some((line) => line.startsWith("PUT"))).toBe(true);
  });

  test("tiktok needs a video", async () => {
    setEnv("TIKTOK_ACCESS_TOKEN", "k");
    setEnv("TIKTOK_OPEN_ID", "open_1");
    await expect(new TikTokAdapter().publish({ text: "hi", targets: ["tiktok"] })).rejects.toThrow(
      /need one video/,
    );
  });

  test("instagram publishes an image in two calls", async () => {
    setEnv("INSTAGRAM_ACCESS_TOKEN", "k");
    setEnv("INSTAGRAM_USER_ID", "u_1");
    const calls: string[] = [];
    const adapter = new InstagramAdapter({
      fetchFn: (async (url: unknown) => {
        const href = String(url);
        calls.push(href);
        if (href.includes("/media_publish")) return jsonResponse({ id: "ig_1" });
        return jsonResponse({ id: "c_1" });
      }) as typeof fetch,
    });
    const receipt = await adapter.publish({
      text: "hi",
      targets: ["instagram"],
      mediaUrls: ["https://cdn.example.com/a.jpg"],
    });
    expect(receipt).toMatchObject({ adapter: "instagram", id: "ig_1" });
    expect(calls).toHaveLength(2);
  });

  test("instagram waits for a reel then publishes", async () => {
    setEnv("INSTAGRAM_ACCESS_TOKEN", "k");
    setEnv("INSTAGRAM_USER_ID", "u_1");
    let polls = 0;
    const adapter = new InstagramAdapter({
      sleepMs: async () => {},
      fetchFn: (async (url: unknown) => {
        const href = String(url);
        if (href.includes("status_code")) {
          polls += 1;
          return jsonResponse(polls < 2 ? { status_code: "IN_PROGRESS" } : { status_code: "FINISHED" });
        }
        if (href.includes("/media_publish")) return jsonResponse({ id: "ig_2" });
        return jsonResponse({ id: "c_2" });
      }) as typeof fetch,
    });
    const receipt = await adapter.publish({
      text: "hi",
      targets: ["instagram"],
      mediaUrls: ["https://cdn.example.com/v.mp4"],
    });
    expect(receipt).toMatchObject({ id: "ig_2" });
    expect(polls).toBe(2);
  });

  test("instagram fails when the reel errors", async () => {
    setEnv("INSTAGRAM_ACCESS_TOKEN", "k");
    setEnv("INSTAGRAM_USER_ID", "u_1");
    const adapter = new InstagramAdapter({
      sleepMs: async () => {},
      fetchFn: (async (url: unknown) => {
        if (String(url).includes("status_code")) return jsonResponse({ status_code: "ERROR" });
        return jsonResponse({ id: "c_3" });
      }) as typeof fetch,
    });
    await expect(
      adapter.publish({ text: "hi", targets: ["instagram"], mediaUrls: ["https://cdn.example.com/v.mp4"] }),
    ).rejects.toThrow(/reel processing failed/);
  });
});

describe("pacer", () => {
  test("first post has no delay, second waits the gap", async () => {
    let clock = 1_000_000;
    const slept: number[] = [];
    const pacer = new Pacer({
      minIntervalMs: { x: 60_000 },
      jitterMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    expect(pacer.delayFor("x")).toBe(0);
    pacer.markSent("x");
    expect(pacer.delayFor("x")).toBe(60_000);
    await pacer.waitForSlot("x");
    expect(slept).toEqual([60_000]);
    pacer.markSent("x");
    expect(pacer.delayFor("x")).toBe(60_000);
  });

  test("channels pace alone", () => {
    const pacer = new Pacer({ jitterMs: 0, now: () => 500 });
    pacer.markSent("x");
    expect(pacer.delayFor("x")).toBeGreaterThan(0);
    expect(pacer.delayFor("linkedin")).toBe(0);
  });

  test("status reports each channel", () => {
    const pacer = new Pacer({ jitterMs: 0 });
    const status = pacer.status();
    expect(status).toHaveLength(5);
    expect(status[0]).toMatchObject({ channel: "x", delayMs: 0 });
    expect(CHANNEL_LIMITS.x.maxChars).toBe(280);
  });
});

describe("brand queue", () => {
  test("enqueue, list, and remove keep brands apart", () => {
    const queue = new BrandQueue(new MemoryQueueStore());
    const first = queue.enqueue("acme", POST);
    queue.enqueue("globex", POST);
    expect(queue.list("acme")).toHaveLength(1);
    expect(queue.list()).toHaveLength(2);
    expect(queue.remove(first.id)).toBe(true);
    expect(queue.remove(first.id)).toBe(false);
    expect(queue.list("acme")).toHaveLength(0);
  });

  test("drain previews by default and sends when live", async () => {
    const queue = new BrandQueue(new MemoryQueueStore());
    const entry = queue.enqueue("acme", POST);
    const preview = await queue.drain({ brand: "acme", adapters: [okAdapter("private-repo-c4e6")] });
    expect(preview.planned).toEqual([entry.id]);
    expect(preview.sent).toEqual([]);
    expect(queue.list("acme")).toHaveLength(1);
    const live = await queue.drain({
      brand: "acme",
      adapters: [okAdapter("private-repo-c4e6")],
      approval: new AllowAllApprovalHook(),
      dryRun: false,
    });
    expect(live.sent).toEqual([entry.id]);
    expect(live.remaining).toBe(0);
    expect(queue.list("acme")).toHaveLength(0);
  });

  test("failed drains stay queued with a raised count", async () => {
    const queue = new BrandQueue(new MemoryQueueStore());
    queue.enqueue("acme", POST);
    const result = await queue.drain({
      brand: "acme",
      adapters: [failAdapter("private-repo-c4e6", "down")],
      approval: new AllowAllApprovalHook(),
      dryRun: false,
    });
    expect(result.sent).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.remaining).toBe(1);
    expect(queue.list("acme")[0].attempts).toBe(1);
  });

  test("file store round-trips and starts empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "apq-"));
    const path = join(dir, "sub", "queue.json");
    const queue = new BrandQueue(new FileQueueStore(path));
    expect(queue.list()).toEqual([]);
    const entry = queue.enqueue("acme", POST);
    const again = new BrandQueue(new FileQueueStore(path));
    expect(again.list("acme")).toHaveLength(1);
    expect(again.list("acme")[0].id).toBe(entry.id);
  });

  test("file store rejects a bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "apq-"));
    const path = join(dir, "queue.json");
    writeFileSync(path, "not json", "utf8");
    expect(() => new BrandQueue(new FileQueueStore(path)).list()).toThrow(VendorError);
  });
});

describe("approval hooks", () => {
  test("allow-all approves, deny-all refuses", async () => {
    await expect(new AllowAllApprovalHook().requestApproval(POST, { live: true })).resolves.toMatchObject({
      approved: true,
    });
    await expect(new DenyAllApprovalHook().requestApproval(POST, { live: true })).resolves.toMatchObject({
      approved: false,
    });
  });

  test("http hook reads the decision", async () => {
    const hook = new HttpApprovalHook("https://approve.example.com/decide", {
      fetchFn: stubFetch([
        { match: "approve.example.com", reply: () => jsonResponse({ approved: true, approver: "sam" }) },
      ]),
    });
    await expect(hook.requestApproval(POST, { live: true })).resolves.toMatchObject({
      approved: true,
      approver: "sam",
    });
  });

  test("http hook needs a url and a boolean reply", async () => {
    expect(() => new HttpApprovalHook("notaurl")).toThrow(VendorError);
    const hook = new HttpApprovalHook("https://approve.example.com/decide", {
      fetchFn: stubFetch([{ match: "approve.example.com", reply: () => jsonResponse({ ok: 1 }) }]),
    });
    await expect(hook.requestApproval(POST, { live: true })).rejects.toThrow(/approved boolean/);
  });
});

describe("publishPost chain", () => {
  test("dry run is the default and records no cost", async () => {
    const result = await publishPost(POST, { adapters: [okAdapter("private-repo-c4e6")] });
    expect(result).toMatchObject({ dryRun: true, targets: ["x", "linkedin"] });
    expect(getCostReport().dispatches).toBe(0);
  });

  test("live publish falls to the next adapter on failure", async () => {
    const result = await publishPost(POST, {
      adapters: [failAdapter("private-repo-c4e6", "down"), okAdapter("zernio")],
      approval: new AllowAllApprovalHook(),
      dryRun: false,
    });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.receipt.adapter).toBe("zernio");
      expect(result.attempts).toEqual([
        { adapter: "private-repo-c4e6", ok: false, error: "private-repo-c4e6: down" },
        { adapter: "zernio", ok: true },
      ]);
    }
    expect(getCostReport().entries.map((entry) => entry.adapter)).toEqual(["private-repo-c4e6", "zernio"]);
  });

  test("live publish throws when every adapter fails", async () => {
    await expect(
      publishPost(POST, {
        adapters: [failAdapter("private-repo-c4e6", "one"), failAdapter("zernio", "two")],
        approval: new AllowAllApprovalHook(),
        dryRun: false,
      }),
    ).rejects.toThrow(/every adapter failed/);
  });

  test("live publish needs approval", async () => {
    await expect(publishPost(POST, { adapters: [okAdapter("private-repo-c4e6")], dryRun: false })).rejects.toThrow(
      /approval hook/,
    );
    await expect(
      publishPost(POST, {
        adapters: [okAdapter("private-repo-c4e6")],
        approval: new DenyAllApprovalHook(),
        dryRun: false,
      }),
    ).rejects.toThrow(GuardError);
  });

  test("guards block before any adapter runs", async () => {
    const guards = createGuards({ blocklist: ["spam"] });
    await expect(
      publishPost(
        { text: "spam spam", targets: ["x"] },
        { adapters: [okAdapter("private-repo-c4e6")], guards, dryRun: true },
      ),
    ).rejects.toThrow(GuardError);
  });

  test("pacer waits and marks each target", async () => {
    const pacer = new Pacer({ minIntervalMs: { x: 30_000, linkedin: 0 }, jitterMs: 0, sleep: async () => {} });
    pacer.markSent("x");
    const before = pacer.delayFor("x");
    expect(before).toBeGreaterThan(0);
    await publishPost(POST, {
      adapters: [okAdapter("private-repo-c4e6")],
      approval: new AllowAllApprovalHook(),
      pacer,
      dryRun: false,
    });
    expect(pacer.delayFor("linkedin")).toBe(0);
  });

  test("selectAdapters resolves the chain and direct pins", () => {
    expect(selectAdapters([]).map((adapter) => adapter.name)).toEqual(["private-repo-c4e6", "zernio", "ayrshare", "postiz"]);
    expect(selectAdapters(["all"]).map((adapter) => adapter.name)).toEqual([
      "private-repo-c4e6",
      "zernio",
      "ayrshare",
      "postiz",
    ]);
    expect(selectAdapters(["phone"]).map((adapter) => adapter.name)).toEqual(["phone"]);
    expect(selectAdapters(["postiz"]).map((adapter) => adapter.name)).toEqual(["postiz"]);
    expect(selectAdapters(["x", "tiktok"]).map((adapter) => adapter.name)).toEqual(["x", "tiktok"]);
    expect(() => selectAdapters(["fax"])).toThrow(/unknown adapter/);
  });
});
