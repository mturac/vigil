// Connector contracts: every external system Vigil can pull context from or act on.
// Connectors are the "Connect your stack" layer (Jira, Linear, Sentry, Datadog,
// PagerDuty, Notion, GitHub, GitLab, Slack, MCP servers, ...).

export interface ContextItem {
  id: string; // stable id at the source
  source: string; // connector id, e.g. "sentry"
  kind: string; // e.g. "issue" | "ticket" | "alert" | "pr" | "doc" | "page"
  title: string;
  body?: string;
  url?: string;
  at?: string; // ISO timestamp
  meta?: Record<string, unknown>;
}

export interface ConnectorQuery {
  text?: string; // free-text search where supported
  since?: Date; // items newer than this
  limit?: number; // default 10
  kinds?: string[]; // filter by kind where supported
}

export type ConnectorCapability = 'context' | string; // 'context' + action names

export interface Connector {
  /** stable id used in config, scopes and the registry */
  id: string;
  /** human label shown in dashboards and reports */
  label: string;
  /** 'context' plus any action names this connector can run */
  capabilities: string[];
  /** true when required credentials/env are present */
  isConfigured(): boolean;
  /** pull context items for org-context aggregation and automations */
  fetchContext(q: ConnectorQuery): Promise<ContextItem[]>;
  /** run a named action (e.g. jira.createIssue, linear.createIssue) */
  runAction(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** lightweight availability probe */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export function errConnectorNotConfigured(id: string): Error {
  return new Error(`connector "${id}" is not configured (missing credentials in environment)`);
}

export function errUnknownAction(id: string, name: string): Error {
  return new Error(`connector "${id}" has no action "${name}"`);
}
