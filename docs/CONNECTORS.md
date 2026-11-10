# Connectors

Every connector implements one interface (`src/connectors/types.ts`):

```ts
interface Connector {
  id: string;                    // registry key, e.g. "github"
  label: string;                 // dashboard label
  capabilities: string[];        // "context" + action names
  isConfigured(): boolean;       // credentials present?
  fetchContext(q): Promise<ContextItem[]>;   // org-context aggregation
  runAction(name, args): Promise<unknown>;   // typed actions
  health(): Promise<{ ok, detail? }>;
}
```

The registry (`src/connectors/registry.ts`) instantiates everything that has
credentials. The ChatAgent exposes each configured connector's actions as tools
(`github__commentPr`, `jira__createIssue`, ...) — scoped by governance — and the
`org__context` tool aggregates `fetchContext` across all of them.

## Built-in connectors

| id | Env vars | Context | Actions |
|---|---|---|---|
| `github` | `GITHUB_TOKEN`, `GITHUB_API_BASE` (optional) | open PRs (owner/repo query), repos | listOpenPrs, getPr, getPrFiles, commentPr, createPrReview, openPr, createBranch, updateFile, createFile, listIssues, getIssue, createIssue, commentIssue, getRepoContent, mergePr |
| `gitlab` | `GITLAB_URL`, `GITLAB_TOKEN` | open MRs | getMr, commentMr |
| `slack` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | search matches | postMessage, postThreadReply, fetchHistory, lookupUser |
| `jira` | `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN` | recently updated tickets | createIssue, addComment |
| `linear` | `LINEAR_API_KEY` | recently updated issues | createIssue, addComment |
| `sentry` | `SENTRY_HOST`, `SENTRY_TOKEN`, `SENTRY_ORG` | unresolved issues (24h) | getIssue |
| `datadog` | `DATADOG_HOST`, `DATADOG_API_KEY`, `DATADOG_APP_KEY` | events | getMonitor |
| `pagerduty` | `PAGERDUTY_TOKEN` | incidents | getIncident, acknowledge |
| `notion` | `NOTION_KEY` | pages (search) | createPage, appendBlocks |

## MCP servers

Any [Model Context Protocol](https://modelcontext.io) stdio server plugs in via
`MCP_SERVERS` (JSON array):

```bash
export MCP_SERVERS='[
  {"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/repos"]},
  {"name":"fetch","command":"uvx","args":["mcp-server-fetch"]}
]'
```

Each server becomes a connector `mcp.<name>` whose tools are exposed to the
agent (initialize handshake → tools/list → tools/call over NDJSON). Health
checks spawn + list + kill.

## Adding a connector

1. Create `src/connectors/<vendor>.ts` exporting `ENV_VARS` and
   `create<Vendor>Connector()`.
2. Register it in `src/connectors/registry.ts`.
3. Add env vars to `.env.example` and a row to this table.

Guidelines: `fetch` with `AbortSignal.timeout`, non-2xx → `Error` with status +
body snippet, no `any` (local payload interfaces), map everything to
`ContextItem`, default limit 10 / max 50.

## Governance interplay

Scopes carry `allowedConnectors` (`["*"]` or explicit ids). The agent hides
disallowed connectors entirely — the model never sees their tools, and
`org__context` skips them.
