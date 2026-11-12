import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createLogger,
  getCostReport,
  GuardError,
  VendorError,
  type Guards,
  type Logger,
} from "./core.js";
import { DEFAULT_BRAND } from "./index.js";
import {
  allAdapters,
  approvalHookFromEnv,
  BrandQueue,
  CHANNEL_LIMITS,
  defaultQueuePath,
  FileQueueStore,
  Pacer,
  publishPost,
  selectAdapters,
  type ApprovalHook,
  type PublishAdapter,
  type QueueStore,
  type SocialPost,
} from "./publish.js";
import type { FacebookPageProvider } from "./facebook.js";
import { facebookProviderFromEnv, runFacebookDaily } from "./facebook-host.js";

export interface McpDeps {
  adapters?: PublishAdapter[];
  guards?: Guards;
  logger?: Logger;
  queueStore?: QueueStore;
  approval?: ApprovalHook;
  pacer?: Pacer;
  facebook?: FacebookPageProvider;
}

const postShape = {
  text: z.string().describe("The post text."),
  targets: z.array(z.string()).describe("Channels: x, linkedin, tiktok, instagram."),
  mediaUrls: z.array(z.string()).optional().describe("Media URLs for the post."),
  link: z.string().optional().describe("Link to attach."),
  brand: z.string().optional().describe("Brand that owns the post."),
};

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toPost(input: {
  text: string;
  targets: string[];
  mediaUrls?: string[];
  link?: string;
  brand?: string;
}): SocialPost {
  return {
    text: input.text,
    targets: input.targets as SocialPost["targets"],
    ...(input.mediaUrls ? { mediaUrls: input.mediaUrls } : {}),
    ...(input.link ? { link: input.link } : {}),
    ...(input.brand ? { brand: input.brand } : {}),
  };
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const logger = deps.logger ?? createLogger({ quiet: true });
  const guards = deps.guards;
  const store = deps.queueStore ?? new FileQueueStore(defaultQueuePath());
  const queue = new BrandQueue(store);
  const pacer = deps.pacer ?? new Pacer();
  const defaultSet = deps.adapters ?? allAdapters();
  const approval = deps.approval === undefined ? approvalHookFromEnv() : deps.approval;
  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  const pick = (names?: string[]): PublishAdapter[] => {
    if (!names || names.length === 0 || names.includes("all")) {
      return defaultSet.filter((adapter) =>
        ["private-repo-c4e6", "zernio", "ayrshare"].includes(adapter.name),
      );
    }
    return selectAdapters(names);
  };

  server.registerTool(
    "publish_post",
    {
      description: "Publish one social post through the adapter chain. Dry run is the default.",
      inputSchema: {
        ...postShape,
        adapters: z.array(z.string()).optional().describe("Adapter names, or all for the chain."),
        dryRun: z.boolean().optional().describe("Preview the route without delivery."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text, targets, mediaUrls, link, brand, adapters, dryRun }) => {
      try {
        const live = (dryRun ?? true) === false;
        return okResult(
          await publishPost(toPost({ text, targets, mediaUrls, link, brand }), {
            adapters: pick(adapters),
            guards,
            logger,
            dryRun: !live,
            approval: live ? approval : undefined,
            pacer: live ? pacer : undefined,
          }),
        );
      } catch (error) {
        if (error instanceof GuardError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "queue_enqueue",
    {
      description: "Add one post to a brand queue.",
      inputSchema: {
        ...postShape,
        brand: z.string().describe("Brand that owns the post."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ text, targets, mediaUrls, link, brand }) => {
      try {
        return okResult(queue.enqueue(brand, toPost({ text, targets, mediaUrls, link, brand })));
      } catch (error) {
        if (error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "queue_list",
    {
      description: "List queued posts, for one brand or for all brands.",
      inputSchema: {
        brand: z.string().optional().describe("Brand to filter by."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ brand }) => okResult(queue.list(brand)),
  );

  server.registerTool(
    "queue_remove",
    {
      description: "Drop one queued post by id.",
      inputSchema: {
        id: z.string().describe("Queued post id."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ id }) => okResult({ removed: queue.remove(id), id }),
  );

  server.registerTool(
    "queue_drain",
    {
      description: "Publish one brand queue in order. Dry run is the default.",
      inputSchema: {
        brand: z.string().describe("Brand to drain."),
        limit: z.number().int().positive().optional().describe("Max entries to drain."),
        adapters: z.array(z.string()).optional().describe("Adapter names, or all for the chain."),
        dryRun: z.boolean().optional().describe("Preview the drain without delivery."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand, limit, adapters, dryRun }) => {
      try {
        const live = (dryRun ?? true) === false;
        return okResult(
          await queue.drain({
            brand,
            limit,
            adapters: pick(adapters),
            guards,
            logger,
            dryRun: !live,
            approval: live ? approval : undefined,
            pacer: live ? pacer : undefined,
          }),
        );
      } catch (error) {
        if (error instanceof GuardError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  let facebook = deps.facebook;
  const fb = (): FacebookPageProvider => (facebook ??= facebookProviderFromEnv());
  const liveHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    "facebook_page_publish",
    {
      description:
        "Post text and an optional link to a brand's Facebook Page. Dry run is the default. A second publish of one key is skipped.",
      inputSchema: {
        brand: z.string().describe("Brand that owns the Page."),
        text: z.string().describe("The post text."),
        key: z.string().optional().describe("Stable post key; derived from brand, text, and link when absent."),
        link: z.string().optional().describe("Link to attach."),
        scheduledAt: z.number().int().optional().describe("Unix seconds, 10 minutes to 30 days ahead."),
        dryRun: z.boolean().optional().describe("Preview without delivery."),
      },
      annotations: liveHint,
    },
    async ({ brand, text, key, link, scheduledAt, dryRun }) => {
      const live = (dryRun ?? true) === false;
      const item = { brand, text, ...(key ? { key } : {}), ...(link ? { link } : {}), ...(scheduledAt !== undefined ? { scheduledAt } : {}) };
      return okResult(await fb().publish(item, { dryRun: !live, approval: live ? approval : undefined }));
    },
  );

  server.registerTool(
    "facebook_daily",
    {
      description: "Plan one daily tick for a brand and publish the next due item. Dry run is the default.",
      inputSchema: {
        brand: z.string().describe("Brand that owns the Page."),
        items: z
          .array(z.object({ key: z.string(), text: z.string(), link: z.string().optional(), approved: z.boolean() }))
          .describe("Queued items in order."),
        timezone: z.string().describe("IANA timezone of the brand."),
        window: z.string().describe("Local window, HH:MM-HH:MM."),
        maxPerDay: z.number().int().positive().optional().describe("Max posts per local day. Default 1."),
        dryRun: z.boolean().optional().describe("Preview without delivery."),
      },
      annotations: liveHint,
    },
    async ({ brand, items, timezone, window, maxPerDay, dryRun }) => {
      try {
        const live = (dryRun ?? true) === false;
        const cadence = { timezone, window, maxPerDay: maxPerDay ?? 1 };
        return okResult(await runFacebookDaily({ provider: fb(), brand, items, cadence, dryRun: !live, approval: live ? approval : undefined }));
      } catch (error) {
        if (error instanceof VendorError) return errorResult(error);
        throw error;
      }
    },
  );

  server.registerTool(
    "pacing_status",
    {
      description: "Read per-channel pacing gaps and char limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult({ limits: CHANNEL_LIMITS, pacer: pacer.status() }),
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
