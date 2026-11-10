// Connector registry — instantiates all built-in connectors + MCP servers.
import type { Connector } from './types.js';
import { createGithubConnector } from './github.js';
import { createSlackConnector } from './slack.js';
import { createGitlabConnector } from './gitlab.js';
import { createJiraConnector } from './jira.js';
import { createLinearConnector } from './linear.js';
import { createSentryConnector } from './sentry.js';
import { createDatadogConnector } from './datadog.js';
import { createPagerdutyConnector } from './pagerduty.js';
import { createNotionConnector } from './notion.js';
import { createMcpConnector, type McpServerConfig } from './mcp.js';

let warnedMcpEnv = false;

export function mcpServersFromEnv(): McpServerConfig[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as McpServerConfig[];
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.filter((c) => c && typeof c.name === 'string' && typeof c.command === 'string');
  } catch {
    if (!warnedMcpEnv) {
      warnedMcpEnv = true;
      console.warn('vigil: MCP_SERVERS env is set but not a valid JSON array of {name, command, args?, env?} — ignoring');
    }
    return [];
  }
}

export function buildRegistry(mcpServers?: McpServerConfig[]): Map<string, Connector> {
  const servers = mcpServers ?? mcpServersFromEnv();
  const list: Connector[] = [
    createGithubConnector(),
    createGitlabConnector(),
    createSlackConnector(),
    createJiraConnector(),
    createLinearConnector(),
    createSentryConnector(),
    createDatadogConnector(),
    createPagerdutyConnector(),
    createNotionConnector(),
    ...servers.map((s) => createMcpConnector(s)),
  ];
  return new Map(list.map((c) => [c.id, c]));
}

export function getConnectorList(mcpServers?: McpServerConfig[]): Connector[] {
  return Array.from(buildRegistry(mcpServers).values());
}

export async function connectorsHealth(mcpServers?: McpServerConfig[]): Promise<{ id: string; label: string; configured: boolean; ok?: boolean }[]> {
  const list = getConnectorList(mcpServers);
  return Promise.all(
    list.map(async (c) => {
      if (!c.isConfigured()) return { id: c.id, label: c.label, configured: false, ok: undefined as boolean | undefined };
      try {
        const h = await c.health();
        return { id: c.id, label: c.label, configured: true, ok: h.ok };
      } catch {
        return { id: c.id, label: c.label, configured: true, ok: false };
      }
    }),
  );
}
