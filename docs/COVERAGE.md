# CodeRabbit Agent → Vigil coverage matrix

Feature-by-feature comparison against the public CodeRabbit Agent (for Slack) page
(https://www.coderabbit.ai/agent), as captured 2026-11-10. "Vigil" column states
what actually ships in this repository — nothing aspirational.

## Core agentic SDLC

| CodeRabbit claim | Vigil | Where |
|---|---|---|
| Investigates, plans, opens PRs, captures knowledge | ✅ ChatAgent tool loop (LLM + tools), fix engine opens PRs, memory captures decisions | `src/chat/agent.ts`, `src/fix/engine.ts`, `src/core/memory.ts` |
| One agent across the whole SDLC | ✅ review / fix / debug / postmortem / standup / chat in one runtime | `src/` |
| Works in the channel where the team already works | ✅ Slack app-mention threads, GitHub PR comments, web console, CLI | `src/server.ts`, `src/daemon.ts` |

## Connectors ("connect your stack")

| CodeRabbit | Vigil | Notes |
|---|---|---|
| GitHub | ✅ | PRs, reviews (inline + summary), issues, contents, branches, merge — `src/connectors/github.ts` |
| GitLab | ✅ | MRs + notes — `src/connectors/gitlab.ts` |
| Slack | ✅ | messages, threads, search-based context, HMAC-verified events — `src/connectors/slack.ts` |
| Jira | ✅ | search, create issue, comment — `src/connectors/jira.ts` |
| Linear | ✅ | issues, create, comment (GraphQL) — `src/connectors/linear.ts` |
| Sentry | ✅ | unresolved issues as alerts — `src/connectors/sentry.ts` |
| Datadog | ✅ | events + monitor lookup — `src/connectors/datadog.ts` |
| PagerDuty | ✅ | incidents + acknowledge — `src/connectors/pagerduty.ts` |
| Notion | ✅ | search, create page, append blocks — `src/connectors/notion.ts` |
| Figma, Canva, Google Drive, Gong, HubSpot, Intercom, Zendesk, Pylon, Asana, PostHog, CircleCI, AWS, OneDrive | ❌ not built | Connector interface is 1-file small (`src/connectors/types.ts`); each missing vendor needs its own credentials/API mapping. Datadog/PostHog-style analytics vendors share the same fetchContext shape. |
| Custom integrations via MCP servers and APIs | ✅ | MCP stdio client (initialize handshake, tools/list, tools/call) — `src/connectors/mcp.ts` |

## Org operating context

| CodeRabbit | Vigil | Where |
|---|---|---|
| Code: repos, recent changes, opened PRs | ✅ github connector context + poller | `src/connectors/github.ts`, `src/daemon.ts` |
| Tickets: Jira/Linear | ✅ | connectors |
| Docs: Notion | ✅ (Confluence ❌) | `src/connectors/notion.ts` |
| Monitoring: Sentry, Datadog | ✅ (PostHog ❌) | connectors |
| Cloud: AWS/GCP | ❌ | no cloud connectors shipped |
| Aggregated cross-tool context for the agent | ✅ `org__context` tool merges all configured connectors in one snapshot | `src/chat/agent.ts` |

## Memory

| CodeRabbit | Vigil | Where |
|---|---|---|
| Team knowledge, shared across teams/repos | ✅ `team:global` scope | `src/core/memory.ts` |
| Channel memory (runbooks, conventions) | ✅ `channel:owner/repo` + `channel:slack:C…` scopes | same |
| Thread memory (carries the task forward) | ✅ `thread:<conversationId>` + conversation history replay | same |
| Refined through daily use | ✅ auto-captured from verified fix runs + explicit `memory__save` tool + CLI | `src/fix/engine.ts`, `src/chat/agent.ts` |
| Applied to future reviews | ✅ recalled bullets appear in reports ("Applied team knowledge") | `src/review/engine.ts` |

## Multi-player collaboration

| CodeRabbit | Vigil | Where |
|---|---|---|
| Synchronous: agent lives in the thread | ✅ Slack threads, GitHub PR comment threads, console | `src/server.ts` |
| Steerable: redirect mid-task | ✅ next message lands in the same conversation; governance re-checked per message | `src/chat/agent.ts` |
| Resumable: stop, come back later | ✅ conversations + messages + runs persisted in PostgreSQL | schema `Conversation`, `ChatMessage`, `Run` |

## Governance

| CodeRabbit | Vigil | Where |
|---|---|---|
| Access scoped to who you are | ✅ scope user allowlists (external identities) | `src/core/governance.ts` |
| Repos per scope | ✅ glob allowlist (`acme/*`, `*`) | same |
| Tool control: which integrations available where | ✅ connector allowlist per scope; tools hidden from the model when not allowed | `src/chat/agent.ts` |
| Spend control, attributed per team/channel | ✅ per-scope daily USD budget; token-accurate cost per run AND per step; usage dashboard by day/kind/tool | `src/core/governance.ts`, `src/core/llm.ts`, `src/dashboard/` |
| Every run explainable and attributed | ✅ Run + RunStep tables record every LLM call and tool call with cost + duration | schema `Run`, `RunStep` |

## Customized

| CodeRabbit | Vigil | Where |
|---|---|---|
| Skills files | ✅ built-in skills (standup, stale-prs, postmortem, debug) + user memory items (`fact/decision/runbook/preference`); skill modules are plain TS | `src/chat/skills.ts` |
| Custom sandboxes | ✅ per-repo `.vigil.yml` sandbox config: local allowlist or Docker profile (`--network none`), timeout, deny patterns | `src/core/sandbox.ts` |

## Triggers & automations

| CodeRabbit | Vigil | Where |
|---|---|---|
| PR summaries posted to channels | ✅ `pr.opened` event automation → digest into channel | `src/daemon.ts`, `src/server.ts` |
| Scheduled standup digest | ✅ cron (`0 9 * * 1-5` default) merges/stale/alerts/deploys | `src/chat/skills.ts` |
| Stale PR sweep | ✅ hourly cron, idle > N hours | same |
| Signal-driven work (Sentry spike → debug) | ✅ `debug` skill correlates alerts with recent PRs and proposes root cause + revert | same |
| Postmortems filed to trackers | ✅ `postmortem` skill drafts and files to Linear/Jira/Notion | same |

## Pricing model

| CodeRabbit | Vigil |
|---|---|
| Billed per active agent minute ($0.4/min) | N/A — self-hosted: your model tokens, your compute. Internal cost attribution exists (per-run USD) so you can charge back teams the same way. |

## Code review specifics (shared engine)

| Capability | Vigil |
|---|---|
| Review on PR open + push | ✅ webhook (HMAC-verified) + poller fallback, deduped by head SHA |
| Inline comments + summary report | ✅ up to N inline comments, REQUEST_CHANGES threshold configurable (auto-fallback to COMMENT on own PRs) |
| Risk score, severity taxonomy | ✅ 0-100 weighted, critical→info |
| Walkthrough + file graph | ✅ per-file auto-narrative, mermaid graph |
| Repo config file | ✅ `.vigil.yml` (like `.coderabbit.yaml`) |
| Similar past findings ("learn from history") | ✅ 90-day lookback per rule+repo from PostgreSQL |
| Path filters, muted rules | ✅ `review.paths.ignore/only`, `heuristics.mutedRules` |
| Missing-test warning | ✅ rule 22 + report section |

## Honest gaps (not covered)

1. **Vendor-specific connectors** not shipped: Figma, Canva, Google Drive, Gong, HubSpot, Intercom, Zendesk, Pylon, Asana, PostHog, CircleCI, AWS/GCP cloud, Confluence, OneDrive. The `Connector` interface + registry makes each a ~150-line file.
2. **Usage tab granularity**: CodeRabbit bills minutes; Vigil reports token cost + wall time per run/step. No per-user billing statements page.
3. **Slack privacy-boundary knowledge bases** (private-channel scoping of the knowledge base itself) — Vigil scopes memory by conversation/channel keys, but does not mirror Slack's public/private knowledge separation semantics.
4. **Roles UI** (primary user / admin / scope admin management screens) — scopes exist in the DB and are enforced, but there is no admin UI to edit them (SQL/CLI only today).
5. **GitHub App flow** — Vigil authenticates as a token (PAT or GitHub App installation token supplied via env); the marketplace-style App install UX is not included.
6. **Hosted multi-tenant SaaS** — single-tenant by design (self-hosted product).

## Changelog 2026-11-11 (hardening pass after live demo)

Live end-to-end demo executed against this very repository (PR mturac/vigil#1,
opened with intentionally flawed code):

- `vigil review mturac/vigil 1` posted a **real GitHub review** (risk 100/100,
  14 inline comments, heuristics + LLM merged findings) — visible on the PR.
- `vigil ask` ran the full agent tool-loop (github getPr/getPrFiles → review__pr)
  with every step and USD cost attributed in the `Run`/`RunStep` tables.
- Web console chat verified over HTTP (`POST /api/console/message`).

Fixes landed as a result:

- **LLM_HEADERS** env: JSON object of extra HTTP headers for OpenAI-compatible
  gateways that require side-car auth (X-Token style gateways, Azure APIM,
  corporate proxies). Unit-tested in `tests/llm.test.ts`.
- **Price-table bug**: variant models resolved to the wrong price family
  (`glm-4.5-flash` inherited `glm-4.5` pricing). Longest-match now wins.
- **dashboard command** now constructs the ChatAgent — the web console
  previously returned 503 in dashboard-only mode.
- **.env loading**: `dotenv` was a declared dependency but never imported;
  entrypoints (`index`, `server`, `daemon`) now load it (explicit env still wins).
- **PostgreSQL-only guard**: a `DATABASE_URL` that is not `postgres://` fails
  fast with a clear message instead of a cryptic Prisma error.
- **devdb.ts** ignores stray non-postgres `DATABASE_URL` values from the
  surrounding environment.
- **Duplicate-review 422**: GitHub rejects a PR review whose body is byte-identical
  to a previously submitted one (same token user, same head SHA); re-reviews after
  a DB reset marked themselves `failed`. Review bodies now carry an invisible
  per-run stamp (`<!-- vigil-review <id> <ts> -->`), verified live on PR #2.
