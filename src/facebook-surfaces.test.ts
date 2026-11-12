import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryPublishStateStore } from "./cadence.js";
import { FacebookPageProvider } from "./facebook.js";
import { startFakeGraph, type FakeGraph } from "./fake-graph.js";
import { createMcpServer } from "./mcp.js";
import { AllowAllApprovalHook } from "./publish.js";

// End to end, issue #11. The built CLI runs as a child process against
// a fake Graph API; every run lands in artifacts/facebook-cli-e2e.txt.
// Failure modes, written before the code:
// 1. The CLI posts live without AGENTIC_PUBLISH_FACEBOOK_LIVE=1.
// 2. A cron that runs `facebook daily` twice posts twice.
// 3. A timeout, then a retry in a new process, posts twice.
// 4. The token shows up on stdout or stderr.
// 5. CLI and MCP return different shapes for the same item.

const TOKEN = "EAAe2eFakeToken0123456789";
const CLI = join(process.cwd(), "dist", "cli.js");
const transcript: string[] = [];
let graph: FakeGraph;
let dir: string;

beforeAll(async () => {
  // Rebuild when dist is missing or older than any source file.
  const built = existsSync(CLI) ? statSync(CLI).mtimeMs : 0;
  const newest = Math.max(...readdirSync("src").map((f) => statSync(join("src", f)).mtimeMs));
  if (built < newest) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
  graph = await startFakeGraph({ slowMs: 1500 });
  dir = mkdtempSync(join(tmpdir(), "ap-fb-e2e-"));
});

afterAll(async () => {
  await graph.close();
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(join("artifacts", "facebook-cli-e2e.txt"), `${transcript.join("\n")}\n`);
});

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string; json: Record<string, unknown> }> {
  const fullEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    FACEBOOK_GRAPH_BASE_URL: graph.url,
    FACEBOOK_PAGE_ID_ACME: "page-1",
    FACEBOOK_PAGE_TOKEN_ACME: TOKEN,
    FACEBOOK_PAGE_ID_DAILY: "page-1",
    FACEBOOK_PAGE_TOKEN_DAILY: TOKEN,
    FACEBOOK_PAGE_ID_SLOW: "page-slow",
    FACEBOOK_PAGE_TOKEN_SLOW: TOKEN,
    FACEBOOK_PAGE_ID_STALE: "page-1",
    FACEBOOK_PAGE_TOKEN_STALE: `expired-${TOKEN}`,
    AGENTIC_PUBLISH_FACEBOOK_STATE: join(dir, "state.json"),
    ...env,
  };
  const shown = Object.entries(env).map(([k, v]) => `${k}=${v} `).join("");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: fullEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const line = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ").split(dir).join("$TMP");
      transcript.push(`$ ${shown}agentic-publish ${line}`, out.trim(), err.trim(), `exit ${code}`, "");
      expect(out + err).not.toContain(TOKEN);
      resolve({ code: code ?? -1, out, err, json: out.trim() ? (JSON.parse(out) as Record<string, unknown>) : {} });
    });
  });
}

const PUB = ["facebook", "publish", "--brand", "acme", "--key", "tip-001", "--text", "Tip of the day", "--link", "https://example.com/tip"];
const SWITCH = { AGENTIC_PUBLISH_FACEBOOK_LIVE: "1" };

describe("facebook CLI end to end", () => {
  test("preview, switch, approval, publish, duplicate", async () => {
    expect((await cli(PUB)).json).toMatchObject({ status: "preview", request: { path: "/page-1/feed" } });
    expect(graph.requests).toHaveLength(0);
    expect((await cli([...PUB, "--live", "--auto-approve"])).json).toMatchObject({ status: "blocked", reason: "provider-switch-off" });
    expect((await cli([...PUB, "--live"], SWITCH)).json).toMatchObject({ status: "blocked", reason: "no-approval-hook" });
    const live = await cli([...PUB, "--live", "--auto-approve"], SWITCH);
    expect(live).toMatchObject({ code: 0, json: { status: "published", postId: "page-1_1" } });
    expect((await cli([...PUB, "--live", "--auto-approve"], SWITCH)).json).toMatchObject({ status: "duplicate" });
    expect(graph.posts).toHaveLength(1);
  });

  test("an expired token fails typed and stays out of the output", async () => {
    const run = await cli(["facebook", "publish", "--brand", "stale", "--text", "Hi", "--live", "--auto-approve"], SWITCH);
    expect(run).toMatchObject({ code: 1, json: { status: "failed", error: { kind: "token-expired" } } });
  });

  test("a daily cron run twice posts once", async () => {
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify([{ key: "d-1", text: "Daily one", approved: true }, { key: "d-2", text: "Daily two", approved: true }]));
    const daily = ["facebook", "daily", "--brand", "daily", "--items", items, "--timezone", "UTC", "--window", "00:00-23:59", "--max-per-day", "1"];
    expect((await cli(daily)).json).toMatchObject({ plan: { due: true, item: { key: "d-1" } }, result: { status: "preview" } });
    expect((await cli([...daily, "--live", "--auto-approve"], SWITCH)).json).toMatchObject({ result: { status: "published" } });
    expect((await cli([...daily, "--live", "--auto-approve"], SWITCH)).json).toMatchObject({ plan: { due: false, reason: "daily-cap" } });
    expect(graph.posts.filter((p) => p.message.startsWith("Daily"))).toHaveLength(1);
  });

  test("a timeout, then a retry in a new process, posts once", async () => {
    const slow = ["facebook", "publish", "--brand", "slow", "--key", "s-1", "--text", "Slow one", "--live", "--auto-approve"];
    const first = await cli(slow, { ...SWITCH, FACEBOOK_GRAPH_TIMEOUT_MS: "300" });
    expect(first.json).toMatchObject({ status: "failed", error: { kind: "unknown-outcome", retryable: true } });
    await new Promise((r) => setTimeout(r, 1600));
    expect((await cli(slow, SWITCH)).json).toMatchObject({ status: "duplicate", reconciled: true });
    expect(graph.posts.filter((p) => p.pageId === "page-slow")).toHaveLength(1);
  });
});

describe("surface parity", () => {
  test("SDK, CLI and MCP return the same preview for one item", async () => {
    const provider = new FacebookPageProvider({ state: new MemoryPublishStateStore(), pageId: () => "page-1", token: () => TOKEN, baseUrl: graph.url });
    const item = { brand: "acme", key: "p-1", text: "Same everywhere" };
    const sdk = await provider.publish(item);
    const viaCli = (await cli(["facebook", "publish", "--brand", "acme", "--key", "p-1", "--text", "Same everywhere"])).json;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ facebook: provider, approval: new AllowAllApprovalHook() }).connect(serverT);
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(clientT);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["facebook_page_publish", "facebook_daily"]));
    const res = (await client.callTool({ name: "facebook_page_publish", arguments: item })) as { content: { text: string }[] };
    const viaMcp = JSON.parse(res.content[0].text) as unknown;
    expect(viaCli).toEqual(sdk);
    expect(viaMcp).toEqual(sdk);
    await client.close();
  });
});
