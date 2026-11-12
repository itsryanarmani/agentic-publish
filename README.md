# agentic-publish

[![npm version](https://img.shields.io/npm/v/agentic-publish)](https://www.npmjs.com/package/agentic-publish)
[![Monthly downloads](https://img.shields.io/npm/dm/agentic-publish)](https://www.npmjs.com/package/agentic-publish)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-publish) · [Setup](#preview-your-first-post) · [API and commands](#runtime-surfaces) · [Comparisons](#compare) · [llms.txt](https://github.com/pooriaarab/agentic-publish/blob/main/llms.txt)

agentic-publish is an open-source social publishing router for developers who use multiple posting APIs.
It provides a TypeScript software development kit (SDK), command-line interface (CLI), and Model Context Protocol (MCP) server.
Brand queues and approval hooks support local workflows; publishing defaults to previews.

## Install

```sh
npm install agentic-publish
```

Use Node.js 18 or later. TypeScript declarations are included; the package has three direct runtime dependencies.

## Preview your first post

Run a preview without credentials or environment variables:

```sh
npx agentic-publish publish --text "Hello" --targets x,linkedin
```

Expect `dryRun: true`, targets `x` and `linkedin`, and adapters `private-repo-c4e6`, `zernio`, and `ayrshare`.
No vendor request runs. A preview validates shared inputs, not vendor credentials or account permissions.

| Adapter | Setup | Posts through |
| --- | --- | --- |
| postiz | POSTIZ_API_KEY plus POSTIZ_BASE_URL and POSTIZ_INTEGRATION_<PLATFORM> | Self-hosted Postiz posts API |
| phone | none; queues a task for agentic-device | Phone post task on your own iPhone |

Save this as `preview.mjs`, then run `node preview.mjs`:

```js
import { publishPost, defaultAdapters } from 'agentic-publish';

const preview = await publishPost(
  { text: 'Hello', targets: ['x', 'linkedin'] },
  { adapters: defaultAdapters() },
);
console.log(preview);
```

Expect the same dry-run plan.

## How it works

```text
SDK / CLI / MCP -> shared validation -> preview plan
                                   -> approval -> optional pacer
                                               -> Content Rabbit
                                               -> Zernio on failure
                                               -> Ayrshare on failure
Explicit adapter selection --------------------> selected adapter chain
Brand queue -> drain --------------------------> same publish flow
```

## Why it exists

Content Rabbit, Zernio, and Ayrshare expose different publishing APIs.
agentic-publish tries an ordered adapter chain and reports failed attempts.
It also offers direct channel adapters and brand queues in your own process.

## Compare

Scope checked on 2026-10-14 against [Ayrshare documentation](https://www.ayrshare.com/docs/introduction).

| Aspect | agentic-publish | Ayrshare |
| --- | --- | --- |
| Scope | Local router and queue library | Managed social media API |
| Configuration | Adapter instances, flags, environment | Vendor API and connected accounts |
| Queue storage | Local file or supplied store | Vendor service |
| Coverage here | Four target names | This wrapper passes four target names to Ayrshare |

The wrapper exposes only the operations implemented below, rather than the full vendor API.

## Coverage

The source contains seven network adapters: three aggregators and four direct adapters.
The target registry contains four channels. No adapter is scaffold-only.

| Aggregator | Implemented route | Fields forwarded |
| --- | --- | --- |
| Content Rabbit | ✓ Draft, then publish | Text, targets, optional first comment; no media URLs or link |
| Zernio | ✓ Create with publish-now | Text, targets, media URLs; no link or first comment |
| Ayrshare | ✓ Post | Text, targets, media URLs; link appended to text |

| Direct channel | Implemented route | Media behavior | Shared text limit |
| --- | --- | --- | --- |
| X (Twitter) | ✓ Create tweet | Text only; rejects media URLs | 280 |
| LinkedIn | ✓ UGC post | Text or article link; rejects media URLs | 3,000 |
| TikTok | ✓ Download, upload, read status once | First video URL only | 2,200 |
| Meta Instagram | ✓ Container, then publish | First image or video URL only | 2,200 |

These are code paths tested with mocked responses, not a claim of current vendor certification.
This rewrite includes zero credential-checked integrations. Remote permissions and API compatibility require live validation.
The text limits above are package constants, not a complete statement of platform limits.

## Common use cases

1. Launch teams: preview text for X and LinkedIn before sending through a selected aggregator.
2. Agency developers: separate brand queues in a Node.js application and drain one brand at a time.
3. Agent developers: review MCP publishing plans before enabling an approval-backed live send.
4. Media teams: select the direct TikTok or Instagram adapter for a single public media URL.

## Features

- Ordered fallback returns a receipt and attempt history after the first adapter success.
- Brand queues use memory or local JSON file storage.
- Approval hooks support explicit allow, deny, and HTTP decisions.
- Optional SDK guards check text before dispatch.
- A reusable `Pacer` tracks per-channel intervals in memory.
- Process-local cost reports record successful text-length units and zero units for failed adapter attempts.

## Runtime surfaces

SDK exports include `publishPost`, adapter selectors, seven adapter classes, `BrandQueue`, two queue stores, `Pacer`, and three approval hooks.
Core router, logging, guards, text-summary, and cost helpers are also re-exported.
CLI commands are `publish`, `queue`, `facebook`, `pacing`, `costs`, and `mcp`.
Queue subcommands are `enqueue`, `list`, `remove`, and `drain`.
Use `--help` or `-h` for help, and `--version` or `-V` for the version.
`--adapter all` selects the three-aggregator default chain, not all seven adapters.

Start stdio MCP with `npx agentic-publish mcp` or `npx --package agentic-publish agentic-publish-mcp`.
Its nine tools are `publish_post`, `queue_enqueue`, `queue_list`, `queue_remove`, `queue_drain`, `facebook_page_publish`, `facebook_daily`, `pacing_status`, and `get_cost_report`.
Publishing and drains default to dry runs. Pass `dryRun: false` for a live MCP request.
The source Worker has `GET /health`, `GET /limits`, and `POST /preview`; it has no live publishing route.

## Delivery and behavior limits

Preview each post and drain first. Obtain approval for every live post and honor guard denials.
The SDK requires an approval hook for live publishing. CLI and MCP can obtain one from the environment.
A preview does not call individual adapters, validate media requirements, or confirm account access.
Select a direct adapter with its matching single target; direct adapters do not enforce target-to-adapter matching.

Fallback stops after the first successful adapter, not after each channel succeeds.
Partial remote publication followed by an error can produce duplicates through a later adapter.
The adapter chain has no idempotency keys or reconciliation. Inspect vendor state before retrying uncertain results.
The `facebook-page` provider has both; see [Facebook Page](#facebook-page).
HTTP requests default to ten-second timeouts; the chain proceeds to another adapter after a failure.
TikTok reads status once and can return a receipt while processing continues.
Instagram reels default to ten status reads, five seconds apart.

Content Rabbit ignores media URLs and links. Do not route media through its default-first position and expect uploads.
X ignores the separate `link` field; include links in its text.
Only the SDK exposes `firstComment`, and only Content Rabbit forwards it.
Appended links can exceed limits because validation checks the original text length.

SDK guards and pacing apply only when supplied. CLI publishing and drains supply neither guards nor a pacer.
The CLI `pacing` command prints character-limit metadata only.
MCP creates a shared pacer, but guards still require injection.
Default pacer gaps are 90 seconds for X, 180 seconds for LinkedIn, and 300 seconds for TikTok and Instagram.
The pacer adds less than 15 seconds of jitter. State resets with the process and is not shared across workers.
Pacing does not guarantee platform policy compliance or prevent account restrictions.

Queue previews list planned IDs without publishing or removing entries.
Live drains remove successful entries and retain failed entries with increased attempt counts; a failure does not stop later entries.
File storage has no concurrent-writer lock or background scheduler.
Cost reports are process-local text units, not currency; separate CLI invocations do not retain totals.

## Integration guides

Export credentials in your shell or secret store. The package does not load `.env` files automatically.

| Adapter | Environment |
| --- | --- |
| Content Rabbit | `CONTENT_RABBIT_API_KEY` |
| Zernio | `ZERNIO_API_KEY` |
| Ayrshare | `AYRSHARE_API_KEY` |
| X (Twitter) | `X_BEARER_TOKEN` with user context |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` |
| TikTok | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_OPEN_ID` |
| Meta Instagram | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID` |
| Facebook Page | `FACEBOOK_PAGE_TOKEN[_<BRAND>]`, `FACEBOOK_PAGE_ID[_<BRAND>]`; see [Facebook Page](#facebook-page) |

Network adapters accept constructor `apiKey`, `fetchFn`, `baseUrl`, and `timeoutMs` options.
Live CLI publishing needs `--live` plus an approval source.
Set `AGENTIC_APPROVE_URL` to an HTTP approval service; optional `AGENTIC_APPROVE_KEY` supplies bearer authentication.
The service receives `{ post, context }` and must return `{ approved: boolean }`.
Use `--auto-approve` or `AGENTIC_PUBLISH_AUTO_APPROVE=1` only for posts already authorized by the user.
Auto-approval takes precedence over the HTTP hook.

```sh
npx agentic-publish queue enqueue --brand acme --text "Hello" --targets x
npx agentic-publish queue list --brand acme
npx agentic-publish queue drain --brand acme
```

Expect a queued entry, its list, and a drain plan. No post is published.
The default queue file is `.agentic-publish-queue.json`; set `AGENTIC_PUBLISH_QUEUE` to change it.
Read `getCostReport()` or MCP `get_cost_report` in the same process after live work.

- [Ayrshare social API setup](https://www.ayrshare.com/docs/introduction)
- [Package onboarding](https://github.com/pooriaarab/agentic-publish/blob/main/docs/onboarding.md)
- [Core contract reference](https://github.com/pooriaarab/agentic-publish/blob/main/docs/agentic-core.md)

## Facebook Page

The `facebook-page` provider posts text, with an optional link, to one Facebook Page per brand through the Graph API `/{page-id}/feed` edge.
It suits a daily post across many Pages: each brand has its own Page, token, timezone, and posting window.
It runs beside the adapter chain, not inside it, and returns typed results instead of throwing.

### One-time setup

1. Make sure your business owns or manages the Page. A system user or a Page admin needs the **Create content** task on that Page.
2. Create a Meta app and add the Pages API. Standard access is enough for Pages that your own business owns. App Review and advanced access are only for Pages owned by other people.
3. Get a Page access token with `pages_manage_posts` and `pages_read_engagement`. A system user token from Business Settings does not expire after 60 days the way a user token does.
4. Store the token in your secret store. Never commit it.

### Credentials

Inject resolvers so each project reads tokens its own way, from env, a secret store, or a Worker binding:

```ts
import { FacebookPageProvider, MemoryPublishStateStore } from 'agentic-publish';

const facebook = new FacebookPageProvider({
  state: new MemoryPublishStateStore(), // use a KV, D1, or file store in production
  pageId: (brand) => pages[brand].pageId,
  token: async (brand) => secrets.get(`fb-token-${brand}`),
  live: true, // the provider switch; leave it off until previews look right
});
```

Without resolvers, the provider reads `FACEBOOK_PAGE_TOKEN_<BRAND>` then `FACEBOOK_PAGE_TOKEN`, and `FACEBOOK_PAGE_ID_<BRAND>` then `FACEBOOK_PAGE_ID`.
`<BRAND>` is the brand in upper case, with other characters replaced by `_`.
The provider reads no other env names and no files on its own.
The CLI and `facebookProviderFromEnv()` also read `AGENTIC_PUBLISH_FACEBOOK_LIVE=1` (the switch), `AGENTIC_PUBLISH_FACEBOOK_STATE` (state file path), `FACEBOOK_GRAPH_BASE_URL`, and `FACEBOOK_GRAPH_TIMEOUT_MS`.

### Live posts need three things

A post goes live only when all three are true. Otherwise you get a `preview` or a `blocked` result.

- `dryRun: false` (CLI `--live`).
- An approval hook that approves the item. The hook context carries the idempotency key.
- The provider switch: `live: true` (CLI `AGENTIC_PUBLISH_FACEBOOK_LIVE=1`).

### Post keys and retries

Each item has a stable key: the one you give, or a hash of brand, text, and link.
The idempotency key is `facebook-page:<brand>:<key>`. A second publish of a published key returns `duplicate` and makes no Graph call.
Before the Graph call, the provider writes a `pending` record. If the call times out or Graph answers with a 5xx, the record stays `pending`.
The next run looks for the post on the Page and marks it `published`, so a retried cron does not post twice.
If the Page does not show the post yet, the provider waits until the record is 10 minutes old (`reconcileGraceMs`) before it posts again.
The lookup matches on the post text, so give each item unique text.

A state store has three methods: `get(key)`, `set(record)`, and `list(brand)`.
`MemoryPublishStateStore` ships for tests. `FilePublishStateStore` ships for the CLI.
For Workers, back the same three methods with KV (key is `record.key`) or D1 (one row per key).
Calls for one key run one at a time inside a process. Stores have no lock across processes, so run one cron writer per state store at a time.

### Results

| `status` | Meaning |
| --- | --- |
| `preview` | Dry run. Shows the request, never the token. |
| `published` / `scheduled` | Graph returned a post id. |
| `duplicate` | The key was already published, or a retry found the earlier post (`reconciled: true`). |
| `blocked` | `provider-switch-off`, `no-approval-hook`, `approval-denied`, or `approval-failed`. |
| `failed` | `error.kind` is `token-expired`, `permission-missing`, `rate-limited` (with `retryAfterSeconds`), `content-rejected`, `unknown-outcome`, `token-unavailable`, `invalid-input`, or `graph-error`. |

Error messages are scrubbed of the token. The token goes in the `Authorization` header, never in a URL.
`scheduledAt` takes unix seconds 10 minutes to 30 days ahead; without it the post goes out now.

### Daily posts from a cron

`planDaily()` is a pure function. It takes approved items, a timezone, a local window, a daily cap, history, and the time. It returns the next due item or a reason: `outside-window`, `daily-cap`, or `queue-empty`.
`runFacebookDaily()` plans and then publishes. The library starts no timers; schedule it with a Cloudflare cron trigger or a GitHub Actions schedule.

Example for a made-up Page, brand `acme-bakery`, Page id `100000000000001`:

```sh
export FACEBOOK_PAGE_ID_ACME_BAKERY=100000000000001
export FACEBOOK_PAGE_TOKEN_ACME_BAKERY=...   # from your secret store
cat > items.json <<'JSON'
[{ "key": "2026-03-10", "text": "Fresh sourdough at 8.", "link": "https://example.com/bread", "approved": true }]
JSON

# 1. Preview. No Graph call.
npx agentic-publish facebook daily --brand acme-bakery --items items.json \
  --timezone America/Toronto --window 09:00-11:00 --max-per-day 1

# 2. Go live only after the preview looks right.
AGENTIC_PUBLISH_FACEBOOK_LIVE=1 npx agentic-publish facebook daily --brand acme-bakery \
  --items items.json --timezone America/Toronto --window 09:00-11:00 --live --auto-approve
```

Run the same command every 15 minutes. Inside the window it posts at most once a day. Outside the window it does nothing.
Keep the state file between runs; it is what stops a second post.
For a single post, use `facebook publish --brand <b> --key <k> --text <t> [--link <u>] [--schedule <unix>]`.
MCP exposes the same two flows as `facebook_page_publish` and `facebook_daily`.

## Status

Version 0.1.0 is pre-1.0; interfaces can change.
[Report reproducible issues](https://github.com/pooriaarab/agentic-publish/issues) with redacted credentials.
Public case studies are not yet published in this repository.

## FAQ

### What is agentic-publish?

agentic-publish routes social posts through a selected adapter chain.
It also exposes local brand queues, previews, and approval hooks.

### Which integrations are verified?

agentic-publish has mocked tests for its adapter behavior.
This rewrite does not credential-check any of the seven network adapters.

### Does agentic-publish provide a managed publishing service?

agentic-publish runs in your environment and uses your vendor accounts.
It does not host a scheduler or connect social accounts for you.

### How is agentic-publish different from Ayrshare?

agentic-publish is a local router that can call Ayrshare or other adapters.
Ayrshare supplies a managed social media API with its own connected-account setup.

### Does a dry run verify credentials?

agentic-publish previews shared validation and adapter selection.
It makes no vendor calls and cannot verify credentials or platform permissions.

### Does the CLI enforce pacing?

agentic-publish CLI calls do not instantiate a pacer.
Use the MCP server's shared pacer or supply a reusable SDK `Pacer` for paced publishing.

### Can fallback create duplicate posts?

agentic-publish can try another adapter after a partial remote success raises an error.
Inspect vendor state before retrying; the router does not deduplicate posts.

### Does the default chain forward media everywhere?

agentic-publish's Content Rabbit adapter does not forward media URLs.
Choose an adapter whose payload supports the required fields.

### Are queued posts scheduled automatically?

agentic-publish drains only when called.
It does not run a background scheduler, and a preview leaves all entries queued.

## Development

```sh
npm ci
npm run build
npm run typecheck
npm test
```

## License

MIT
