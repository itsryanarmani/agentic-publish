import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A fake Graph API for tests and the CLI end-to-end run. Not shipped:
// tsup does not bundle it. Page ids pick the failure to play back:
//   page-noperm   403, code 200 (permission missing)
//   page-busy     400, code 32, Retry-After: 120 (rate limited)
//   page-slow     stores the post, then answers after slowMs
//   page-down     stores the post, then answers 500
// GET pages with `limit` and an `after` cursor, as Graph does.
// A token that starts with "expired" gets code 190, and the error text
// echoes the token, as a leak trap. Text with "BLOCKED" gets code 368.

export interface FakePost {
  id: string;
  pageId: string;
  message: string;
  link?: string;
  createdTime: number;
  scheduledFor?: number;
}

export interface FakeGraph {
  url: string;
  posts: FakePost[];
  requests: { method: string; path: string; auth: string; body: string }[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeGraph(options: { slowMs?: number; now?: () => number } = {}): Promise<FakeGraph> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const posts: FakePost[] = [];
  const requests: FakeGraph["requests"] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const auth = String(req.headers.authorization ?? "");
    requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth, body });
    const token = auth.replace(/^Bearer\s*/i, "").trim();
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const fail = (status: number, code: number, message: string, headers?: Record<string, string>): void =>
      send(status, { error: { message, type: "OAuthException", code, fbtrace_id: "fake" } }, headers);
    const match = /^\/v[\d.]+\/([^/]+)\/(feed|scheduled_posts)$/.exec(url.pathname);
    if (!match) return fail(404, 803, "unknown path");
    const [, pageId, edge] = match;
    if (!token) return fail(400, 104, "An access token is required");
    if (token.startsWith("expired")) {
      return fail(400, 190, `Error validating access token: Session has expired. token=${token}`);
    }
    if (pageId === "page-noperm") {
      return fail(403, 200, "(#200) requires pages_manage_posts and pages_read_engagement");
    }
    if (pageId === "page-busy") {
      return fail(400, 32, "Page request limit reached", { "retry-after": "120" });
    }
    if (req.method === "GET") {
      const scheduled = edge === "scheduled_posts";
      // Newest first, in pages of `limit`, with an index cursor in `after`.
      const all = posts
        .filter((p) => p.pageId === pageId && (p.scheduledFor !== undefined) === scheduled)
        .reverse()
        .map((p) => ({ id: p.id, message: p.message, created_time: new Date(p.createdTime * 1000).toISOString() }));
      const from = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const more = from + limit < all.length;
      const paging = more ? { cursors: { after: String(from + limit) }, next: `${url.pathname}?after=${from + limit}` } : {};
      return send(200, { data: all.slice(from, from + limit), paging });
    }
    const form = new URLSearchParams(body);
    const message = form.get("message") ?? "";
    if (message.includes("BLOCKED")) return fail(400, 368, "This content goes against our Community Standards");
    const scheduledRaw = form.get("scheduled_publish_time");
    const post: FakePost = {
      id: `${pageId}_${posts.length + 1}`,
      pageId,
      message,
      ...(form.get("link") ? { link: form.get("link") as string } : {}),
      createdTime: now(),
      ...(scheduledRaw ? { scheduledFor: Number(scheduledRaw) } : {}),
    };
    posts.push(post);
    if (pageId === "page-slow") await new Promise((r) => setTimeout(r, options.slowMs ?? 500));
    if (pageId === "page-down") return fail(500, 2, "Service temporarily unavailable");
    send(200, { id: post.id });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v21.0`,
    posts,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
