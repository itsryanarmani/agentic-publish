#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getCostReport, GuardError, VendorError } from "./core.js";
import { DEFAULT_BRAND } from "./index.js";
import {
  allAdapters,
  AllowAllApprovalHook,
  approvalHookFromEnv,
  BrandQueue,
  CHANNEL_LIMITS,
  defaultQueuePath,
  FileQueueStore,
  normalizeTargets,
  publishPost,
  type ApprovalHook,
  type PublishAdapter,
  type QueueStore,
  type SocialPost,
} from "./publish.js";
import { VERSION } from "./version.js";
import type { CadenceItem } from "./cadence.js";
import type { FacebookPageProvider } from "./facebook.js";
import { facebookProviderFromEnv, runFacebookDaily } from "./facebook-host.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CliCommand = "publish" | "queue" | "facebook" | "pacing" | "costs" | "mcp" | "help" | "version";

export interface CliRequest {
  command: CliCommand;
  text?: string;
  file?: string;
  targets?: string[];
  media?: string[];
  link?: string;
  brand?: string;
  adapters?: string[];
  sub?: string;
  id?: string;
  limit?: number;
  key?: string;
  schedule?: number;
  items?: string;
  timezone?: string;
  window?: string;
  maxPerDay?: number;
  live: boolean;
  autoApprove: boolean;
}

const VALUE_FLAGS = new Set([
  "--text",
  "--file",
  "--targets",
  "--media",
  "--link",
  "--brand",
  "--adapter",
  "--id",
  "--limit",
  "--key",
  "--schedule",
  "--items",
  "--timezone",
  "--window",
  "--max-per-day",
]);

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readLimit(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliRequest {
  const request: CliRequest = { command: "help", live: false, autoApprove: false };
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "--help" || first === "-h") {
    return request;
  }
  if (first === "--version" || first === "-V") {
    request.command = "version";
    return request;
  }
  if (
    first !== "publish" &&
    first !== "queue" &&
    first !== "facebook" &&
    first !== "pacing" &&
    first !== "costs" &&
    first !== "mcp"
  ) {
    throw new UsageError(`unknown command "${first}"`);
  }
  request.command = first;
  if ((first === "queue" || first === "facebook") && args.length > 0 && !args[0].startsWith("--")) {
    request.sub = args.shift();
  }
  while (args.length > 0) {
    const flag = args.shift() as string;
    const canGoLive = request.command === "publish" || request.command === "queue" || request.command === "facebook";
    if (flag === "--live" && canGoLive) {
      request.live = true;
      continue;
    }
    if (flag === "--auto-approve" && canGoLive) {
      request.autoApprove = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) || args.length === 0) {
      throw new UsageError(`unknown flag "${flag}" for "${request.command}"`);
    }
    const value = args.shift() as string;
    switch (flag) {
      case "--text":
        request.text = value;
        break;
      case "--file":
        request.file = value;
        break;
      case "--targets":
        request.targets = [...(request.targets ?? []), ...splitList(value)];
        break;
      case "--media":
        request.media = [...(request.media ?? []), ...splitList(value)];
        break;
      case "--link":
        request.link = value;
        break;
      case "--brand":
        request.brand = value;
        break;
      case "--adapter":
        request.adapters = [...(request.adapters ?? []), ...splitList(value)];
        break;
      case "--id":
        request.id = value;
        break;
      case "--limit":
        request.limit = readLimit(flag, value);
        break;
      case "--key":
        request.key = value;
        break;
      case "--schedule":
        request.schedule = readLimit(flag, value);
        break;
      case "--items":
        request.items = value;
        break;
      case "--timezone":
        request.timezone = value;
        break;
      case "--window":
        request.window = value;
        break;
      case "--max-per-day":
        request.maxPerDay = readLimit(flag, value);
        break;
    }
  }
  if (request.command === "publish") {
    if (request.text === undefined && request.file === undefined) {
      throw new UsageError("publish needs --text or --file");
    }
    if (!request.targets || request.targets.length === 0) {
      throw new UsageError("publish needs --targets (x, linkedin, tiktok, instagram)");
    }
  }
  if (request.command === "queue") {
    if (request.sub !== "enqueue" && request.sub !== "list" && request.sub !== "drain" && request.sub !== "remove") {
      throw new UsageError('queue needs a subcommand: enqueue, list, drain, or remove');
    }
    if (request.sub === "enqueue") {
      if (request.text === undefined && request.file === undefined) {
        throw new UsageError("queue enqueue needs --text or --file");
      }
      if (!request.targets || request.targets.length === 0) {
        throw new UsageError("queue enqueue needs --targets (x, linkedin, tiktok, instagram)");
      }
      if (!request.brand) {
        throw new UsageError("queue enqueue needs --brand");
      }
    }
    if (request.sub === "drain" && !request.brand) {
      throw new UsageError("queue drain needs --brand");
    }
    if (request.sub === "remove" && !request.id) {
      throw new UsageError("queue remove needs --id");
    }
  }
  if (request.command === "facebook") {
    if (request.sub !== "publish" && request.sub !== "daily") {
      throw new UsageError("facebook needs a subcommand: publish or daily");
    }
    if (!request.brand) throw new UsageError(`facebook ${request.sub} needs --brand`);
    if (request.sub === "publish" && request.text === undefined && request.file === undefined) {
      throw new UsageError("facebook publish needs --text or --file");
    }
    if (request.sub === "daily" && (!request.items || !request.timezone || !request.window)) {
      throw new UsageError("facebook daily needs --items, --timezone, and --window");
    }
  }
  return request;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  adapters: PublishAdapter[];
  queueStore: QueueStore;
  approval?: ApprovalHook;
  facebook?: FacebookPageProvider;
}

function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readFile: (path) => readFileSync(path, "utf8"),
    adapters: allAdapters(),
    queueStore: new FileQueueStore(defaultQueuePath()),
    approval: approvalHookFromEnv(),
  };
}

function helpText(): string {
  const command = DEFAULT_BRAND.command;
  return [
    `${DEFAULT_BRAND.name} ${VERSION}`,
    `${DEFAULT_BRAND.description}`,
    "",
    `Usage: ${command} <command> [flags]`,
    "",
    "Commands:",
    "  publish --text <t> --targets <x,linkedin> [--file <p>] [--media <urls>]",
    "       [--link <u>] [--brand <b>] [--adapter <names>] [--auto-approve] [--live]",
    "       Publish one post. Dry run is the default. Add --live to post for",
    "       real. Live posts need approval: --auto-approve or AGENTIC_APPROVE_URL.",
    "  queue enqueue --brand <b> --text <t> --targets <list> [--media <urls>]",
    "       [--link <u>]  Add one post to a brand queue.",
    "  queue list [--brand <b>]  List queued posts.",
    "  queue drain --brand <b> [--limit <n>] [--adapter <names>] [--auto-approve]",
    "       [--live]  Publish one brand queue in order. Dry run is the",
    "       default. Add --live to post for real.",
    "  queue remove --id <id>  Drop one queued post.",
    "  facebook publish --brand <b> --text <t> [--key <k>] [--link <u>]",
    "       [--schedule <unix>] [--auto-approve] [--live]  Post to one Facebook Page.",
    "       Dry run is the default. Live needs AGENTIC_PUBLISH_FACEBOOK_LIVE=1.",
    "  facebook daily --brand <b> --items <json> --timezone <tz> --window <HH:MM-HH:MM>",
    "       [--max-per-day <n>] [--auto-approve] [--live]  Publish the next due item.",
    "  pacing  Print per-channel limits and pacing gaps as JSON.",
    "  costs  Print the cost report as JSON.",
    "  mcp  Start the MCP server on stdio.",
    "",
    "Flags:",
    "  --help, -h       Print this help.",
    "  --version, -V    Print the version.",
  ].join("\n");
}

function readInput(request: CliRequest, io: CliIo): string {
  if (request.file !== undefined) {
    return io.readFile(request.file);
  }
  return request.text ?? "";
}

function pickAdapters(request: CliRequest, io: CliIo): PublishAdapter[] {
  if (!request.adapters || request.adapters.includes("all")) {
    return io.adapters.filter((adapter) => ["private-repo-c4e6", "zernio", "ayrshare", "postiz"].includes(adapter.name));
  }
  return request.adapters.map((name) => {
    const found = io.adapters.find((adapter) => adapter.name === name.toLowerCase());
    if (!found) {
      throw new UsageError(`unknown adapter "${name}"`);
    }
    return found;
  });
}

function pickApproval(request: CliRequest, io: CliIo): ApprovalHook | undefined {
  if (request.autoApprove) return new AllowAllApprovalHook();
  return io.approval;
}

function buildPost(request: CliRequest, io: CliIo): SocialPost {
  return {
    text: readInput(request, io),
    targets: normalizeTargets(request.targets ?? []),
    ...(request.media ? { mediaUrls: request.media } : {}),
    ...(request.link ? { link: request.link } : {}),
    ...(request.brand ? { brand: request.brand } : {}),
  };
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let request: CliRequest;
  try {
    request = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
    return 2;
  }
  try {
    switch (request.command) {
      case "help":
        io.out(helpText());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "pacing":
        io.out(JSON.stringify({ limits: CHANNEL_LIMITS }));
        return 0;
      case "publish": {
        const result = await publishPost(buildPost(request, io), {
          adapters: pickAdapters(request, io),
          approval: request.live ? pickApproval(request, io) : undefined,
          dryRun: !request.live,
        });
        io.out(JSON.stringify(result));
        return 0;
      }
      case "queue": {
        const queue = new BrandQueue(io.queueStore);
        if (request.sub === "enqueue") {
          const entry = queue.enqueue(request.brand as string, buildPost(request, io));
          io.out(JSON.stringify(entry));
          return 0;
        }
        if (request.sub === "list") {
          io.out(JSON.stringify(queue.list(request.brand)));
          return 0;
        }
        if (request.sub === "remove") {
          const removed = queue.remove(request.id as string);
          io.out(JSON.stringify({ removed, id: request.id }));
          return removed ? 0 : 1;
        }
        const result = await queue.drain({
          brand: request.brand as string,
          adapters: pickAdapters(request, io),
          approval: request.live ? pickApproval(request, io) : undefined,
          dryRun: !request.live,
          limit: request.limit,
        });
        io.out(JSON.stringify(result));
        return result.failed.length > 0 ? 1 : 0;
      }
      case "facebook": {
        const provider = io.facebook ?? facebookProviderFromEnv();
        const approval = request.live ? pickApproval(request, io) : undefined;
        if (request.sub === "daily") {
          const items = JSON.parse(io.readFile(request.items as string)) as CadenceItem[];
          const cadence = { timezone: request.timezone as string, window: request.window as string, maxPerDay: request.maxPerDay ?? 1 };
          const run = await runFacebookDaily({ provider, brand: request.brand as string, items, cadence, dryRun: !request.live, approval });
          io.out(JSON.stringify(run));
          return run.result && ["failed", "blocked"].includes(run.result.status) ? 1 : 0;
        }
        const result = await provider.publish(
          {
            brand: request.brand as string,
            text: readInput(request, io),
            ...(request.key ? { key: request.key } : {}),
            ...(request.link ? { link: request.link } : {}),
            ...(request.schedule !== undefined ? { scheduledAt: request.schedule } : {}),
          },
          { dryRun: !request.live, approval },
        );
        io.out(JSON.stringify(result));
        return ["failed", "blocked"].includes(result.status) ? 1 : 0;
      }
      case "costs":
        io.out(JSON.stringify(getCostReport()));
        return 0;
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp();
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof GuardError || error instanceof VendorError || error instanceof UsageError) {
      io.err(`${error.name}: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.err(`file not found: ${request.file ?? ""}`);
      return 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
