# Vigil

**Self-hosted AI engineer for your whole SDLC.** Autonomous code review, incident investigation, sandbox-verified fixes, team memory, connectors and automations — running on your infrastructure, your PostgreSQL, your model.

> Think "CodeRabbit Agent", but open, self-hosted, bring-your-own-model, with a PostgreSQL-backed long-term memory and no vendor lock-in. No sqlite anywhere. No proprietary SDKs.

```bash
$ npm install && npm run db:boot          # embedded PostgreSQL 18 (dev/CI)
$ vigil review acme/app 42                 # autonomous review, posted to GitHub
$ vigil fix acme/app "memory leak in worker pool"   # branch → patch → verify → PR
$ vigil ask "why did checkout latency spike last night?"
$ vigil serve                              # daemon: webhooks, cron automations, dashboard
```

## What it does

| Capability | How |
|---|---|
| **Autonomous code review** | 29 deterministic heuristic rules (secrets, SQLi, weak crypto, ReDoS, XSS sinks, TLS-off, test coverage gaps...) + optional LLM deep-review layer. Findings posted as inline PR comments with a full report, risk score 0-100 and a mermaid file graph. |
| **Autonomous fixes** | `vigil fix` clones the repo, branches, runs an agent loop (read/list/write/apply-patch/run-command/finish tools), verifies with your test command in a sandbox (allowlisted binaries, deny patterns, timeout, optional Docker isolation), then pushes and opens a PR. Every fix run is persisted with its full log. |
| **Chat surfaces** | Slack (mention the bot in any channel/thread), GitHub PR comments (`@vigil ...`), the built-in web console, and the CLI. Multi-player by design: shared threads, resumable, steerable mid-task. |
| **Org context** | One `org__context` tool aggregates GitHub PRs, Jira/Linear tickets, Sentry/Datadog/PagerDuty alerts and Notion docs into a single snapshot the agent can reason over. |
| **Team memory** | Durable knowledge items (facts, decisions, runbooks, preferences) scoped to team / channel / thread, auto-captured from verified fix runs, recalled into every review and conversation. |
| **Triggers & automations** | Cron automations (standup digest, stale-PR sweep), event automations (PR-opened summaries), signal-driven debugging (`debug` skill correlates monitoring alerts with recent PRs). |
| **Governance** | Scopes gate who can invoke the agent, which repos and which connectors are reachable, plus per-scope daily spend limits (USD, token-accurate cost attribution per run and per step). |
| **Extensibility** | MCP (Model Context Protocol) client: plug in any MCP server's tools. Skills are plain modules. Connectors are ~150 lines each. |
| **Ops** | Server-rendered dashboard (overview, reviews, runs, usage, jobs, console), durable Postgres job queue with retries + dedupe, GitHub webhook ingestion with HMAC verification, Slack webhook with signature verification + replay protection. |

## Quick start

```bash
git clone https://github.com/mturac/vigil && cd vigil
npm install
cp .env.example .env                       # fill in what you have
npm run db:boot                            # boots embedded PostgreSQL 18 on :5433 + migrations
export DATABASE_URL=postgresql://vigil:vigil@localhost:5433/vigil

# no LLM key? heuristics-only mode still reviews.
GITHUB_TOKEN=ghp_xxx npx tsx src/index.ts review owner/repo 123

# with any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, OpenRouter, DeepSeek, Groq, LM Studio, Z.ai...):
LLM_PROVIDER=openai LLM_MODEL=gpt-4o OPENAI_API_KEY=sk-xxx npx tsx src/index.ts review owner/repo 123
LLM_PROVIDER=openai OPENAI_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.1 npx tsx src/index.ts ask "summarize our open PRs"

# gateways that need side-car auth headers next to the key (JSON object):
LLM_HEADERS='{"X-Token":"<jwt>","X-Z-AI-From":"Z"}' LLM_MODEL=glm-4.6 npx tsx src/index.ts ask "hi"

# or Anthropic:
LLM_PROVIDER=anthropic LLM_MODEL=claude-3-5-sonnet-latest ANTHROPIC_API_KEY=sk-ant-xxx npx tsx src/index.ts serve
```

The dashboard (and webhook receivers) ship with the daemon:

```bash
npx tsx src/index.ts serve             # http://localhost:8080  (set DASHBOARD_PASSWORD to gate it)
```

### GitHub webhook setup

Repository → Settings → Webhooks → `https://your-host:8080/webhooks/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`. Events: pull requests, issue comments, issues. PRs get reviewed on `opened`/`synchronize` (deduped by head SHA); `@vigil ...` comments on PRs start agent threads; issues labeled `vigil` or `autofix` trigger the fix engine.

Without webhooks, set `REPOS=owner/one,owner/two` and the daemon polls for new head SHAs every `POLL_INTERVAL_SEC`.

### Slack setup

Create a Slack app with `chat:write`, `app_mentions:read`, `search:read`. Set `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`, point the Events API at `https://your-host:8080/webhooks/slack`. Mention the bot anywhere; replies land in the thread.

## Configuration

Repo-level `.vigil.yml` (commit it next to your code, like `.coderabbit.yaml`) — see [`.vigil.example.yml`](.vigil.example.yml) for every knob: review thresholds, path filters, muted rules, sandbox profile (local allowlist vs Docker), verify command, governance defaults, automations.

Env vars — see [`.env.example`](.env.example). Database is **PostgreSQL only** (managed, self-hosted, or the bundled embedded PG for dev/CI).

## Architecture (short version)

```
Slack / GitHub / Console / CLI  ──►  express server (webhooks, dashboard, APIs)
        │                                │
        ▼                                ▼
   ChatAgent ──tools──► connectors (GitHub, GitLab, Slack, Jira, Linear,
        │                 Sentry, Datadog, PagerDuty, Notion, MCP servers)
        │                 review engine (heuristics + LLM) · fix engine (sandbox)
        │                 memory (team knowledge) · governance (scopes, spend)
        ▼
   PostgreSQL: jobs, runs, steps, reviews, findings, conversations,
               knowledge items, automations, scopes, fix runs
```

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Connectors: [`docs/CONNECTORS.md`](docs/CONNECTORS.md) · CodeRabbit feature parity: [`docs/COVERAGE.md`](docs/COVERAGE.md)

## Demo

[`mturac/vigil-demo`](https://github.com/mturac/vigil-demo) is a live demo repo:

- [PR #1](https://github.com/mturac/vigil-demo/pull/1) — intentionally flawed diff (hard-coded AWS key, SQL string concat, `eval`, MD5, `Math.random` tokens, TLS verification disabled, empty catch, http URL, TODO, no tests). Vigil review: **risk 100/100, 14 findings, 2 critical**, posted with inline comments.
- [PR #2](https://github.com/mturac/vigil-demo/pull/2) — autonomous fix (branch → patch → sandbox-verified → PR) replacing `Math.random` session tokens with `crypto.randomBytes`. Re-review: **risk 5/100**, math-random findings gone, fix decision auto-learned into team memory.

## Development

```bash
npm run build        # tsc
npm test             # 51 tests: heuristics, reports, integration (real PG), fix E2E (real git)
npm run typecheck
npm run db:boot      # embedded PostgreSQL + prisma migrate deploy
```

The test suite runs against a real embedded PostgreSQL and a real spawned MCP server (a mock NDJSON JSON-RPC server), plus a real `git clone` of a `file://` remote for the fix pipeline. `LLM_PROVIDER=mock` provides a deterministic scripted model so the full agent loop is testable offline.

## License

MIT © mturac
