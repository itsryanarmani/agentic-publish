# agentic-publish agent guide

Route social posts across Content Rabbit, Zernio, Ayrshare, and direct APIs.

## Mental model

A post goes in with targets. The chain tries Content Rabbit first,
then Zernio, then Ayrshare. The first win ends the walk. Direct
adapters pin one channel. One core serves all faces, so each face
returns the same shape.

## The three faces

- SDK: `import { publishPost } from "agentic-publish"`.
- CLI: `npx agentic-publish publish --text "..." --targets x`.
- MCP: `npx agentic-publish mcp`, then call a tool below.

Keywords: social, publish, private-repo-c4e6, zernio, ayrshare.

## MCP tools

| Tool | Use it for |
| --- | --- |
| publish_post | Publish one post. Dry run is the default. |
| queue_enqueue | Add one post to a brand queue. |
| queue_list | List queued posts. |
| queue_remove | Drop one queued post. |
| queue_drain | Publish one brand queue in order. Dry run is the default. |
| facebook_page_publish | Post to one brand's Facebook Page. Dry run is the default. |
| facebook_daily | Plan one daily tick and publish the due item. Dry run is the default. |
| pacing_status | Read pacing gaps and char limits. |
| get_cost_report | Read session cost totals. |

## The loop

1. Discover the tools with `tools/list`.
2. Preview a post with `publish_post` and dryRun true.
3. Enqueue brand posts with `queue_enqueue`.
4. Drain one brand with `queue_drain` and dryRun true first.
5. Run the live drain when the preview looks right.
6. Read `get_cost_report` and state the cost.

## Rules

- Preview with dry run before each live publish or drain.
- Approve each live post. Stop when approval is denied. State the reason.
- Never retry a denied call with changed text to dodge a guard.
- Respect pacing gaps. Never bypass the wait.
- Report adapter errors as errors. Never present them as success.
- State the cost report before you claim the task is done.
