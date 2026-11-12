import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "./mcp.js";
import {
  AllowAllApprovalHook,
  DenyAllApprovalHook,
  MemoryQueueStore,
  Pacer,
  type PublishReceipt,
  type SocialPost,
} from "./publish.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

async function linked(deps: Parameters<typeof createMcpServer>[0] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

const chain = [
  {
    name: "private-repo-c4e6",
    publish: async (post: SocialPost): Promise<PublishReceipt> => ({
      adapter: "private-repo-c4e6",
      id: "cr_1",
      targets: post.targets,
      at: "now",
    }),
  },
];

describe("mcp server", () => {
  test("serves nine tools over a client link", async () => {
    const { client, server } = await linked({
      adapters: chain,
      queueStore: new MemoryQueueStore(),
      approval: new AllowAllApprovalHook(),
      pacer: new Pacer({
        minIntervalMs: { x: 0, linkedin: 0, tiktok: 0, instagram: 0 },
        jitterMs: 0,
      }),
    });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "facebook_daily",
        "facebook_page_publish",
        "get_cost_report",
        "pacing_status",
        "publish_post",
        "queue_drain",
        "queue_enqueue",
        "queue_list",
        "queue_remove",
      ]);

      const preview = await client.callTool({
        name: "publish_post",
        arguments: { text: "hi", targets: ["x"], dryRun: true },
      });
      expect(JSON.parse(textOf(preview))).toMatchObject({ dryRun: true });

      const live = await client.callTool({
        name: "publish_post",
        arguments: { text: "hi", targets: ["x"], dryRun: false },
      });
      expect(JSON.parse(textOf(live)).receipt).toMatchObject({ adapter: "private-repo-c4e6" });

      const enqueued = await client.callTool({
        name: "queue_enqueue",
        arguments: { brand: "acme", text: "hi", targets: ["x"] },
      });
      const entry = JSON.parse(textOf(enqueued));
      expect(entry.brand).toBe("acme");

      const listed = await client.callTool({ name: "queue_list", arguments: { brand: "acme" } });
      expect(JSON.parse(textOf(listed))).toHaveLength(1);

      const drained = await client.callTool({
        name: "queue_drain",
        arguments: { brand: "acme", dryRun: false },
      });
      expect(JSON.parse(textOf(drained)).sent).toEqual([entry.id]);

      const pacing = await client.callTool({ name: "pacing_status", arguments: {} });
      expect(JSON.parse(textOf(pacing)).limits).toHaveProperty("x");

      const report = await client.callTool({ name: "get_cost_report", arguments: {} });
      expect(JSON.parse(textOf(report))).toHaveProperty("dispatches");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("reports a denied publish as an error", async () => {
    const { client, server } = await linked({
      adapters: chain,
      queueStore: new MemoryQueueStore(),
      approval: new DenyAllApprovalHook(),
    });
    try {
      const result = await client.callTool({
        name: "publish_post",
        arguments: { text: "hi", targets: ["x"], dryRun: false },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
