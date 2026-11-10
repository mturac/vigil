// Jira Cloud connector — recently updated issues as context ('ticket' items),
// plus createIssue / addComment actions via REST API v3.
// Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['JIRA_HOST', 'JIRA_EMAIL', 'JIRA_TOKEN'];

const ID = 'jira';
const REQUIRED: string[] = ENV_VARS;

const env = (name: string): string => (process.env[name] ?? '').trim();

/** fetch + parse a JSON response with a 15s timeout; non-2xx throws Error with status + body snippet. */
async function jfetch(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  try {
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${url} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

/** JIRA_HOST is a bare host like "myteam.atlassian.net" — normalize to an https base URL. */
function apiBase(): string {
  const raw = env('JIRA_HOST');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/** clamp query limit: default 10, minimum 1, maximum 50 */
function pageLimit(q: ConnectorQuery): number {
  const n = typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : 10;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

/** required action argument: non-empty string or finite number */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Error(`${ID}: action argument "${key}" is required`);
}

/** Basic auth from email + API token. */
function authHeaders(): Record<string, string> {
  const basic = Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_TOKEN')}`).toString('base64');
  return { Authorization: `Basic ${basic}` };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

/** JQL date literal "YYYY-MM-DD HH:mm" (UTC). */
function jqlDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** best-effort flatten of a Jira ADF rich-text document to plain text */
function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).filter(Boolean).join(' ');
  if (node !== null && typeof node === 'object') {
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') return n.text;
    return adfText(n.content ?? []);
  }
  return '';
}

/** plain text → minimal ADF document (API v3 requires rich-text bodies) */
function adfDoc(text: string): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** Jira issue search payload — only the fields we request. */
interface JiraSearchResult {
  issues?: Array<{
    id: string;
    key: string;
    fields?: {
      summary?: string;
      description?: unknown; // ADF doc
      status?: { name?: string };
      updated?: string;
    };
  }>;
}

export function createJiraConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('ticket')) return [];
    const from = q.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default window: last 7 days
    const params = new URLSearchParams({
      jql: `updated >= "${jqlDate(from)}" ORDER BY updated DESC`,
      maxResults: String(pageLimit(q)),
      fields: 'summary,description,status,updated',
    });
    const data = (await jfetch(`${apiBase()}/rest/api/3/search?${params.toString()}`, {
      headers: authHeaders(),
    })) as JiraSearchResult;
    return (data.issues ?? []).map((issue) => ({
      id: issue.key,
      source: ID,
      kind: 'ticket',
      title: issue.fields?.summary ?? issue.key,
      body: adfText(issue.fields?.description) || undefined,
      url: `${apiBase()}/browse/${issue.key}`,
      at: issue.fields?.updated,
      meta: { issueId: issue.id, status: issue.fields?.status?.name },
    }));
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'createIssue') {
      const project = argStr(args, 'project');
      const summary = argStr(args, 'summary');
      const description = typeof args.description === 'string' ? args.description : '';
      const created = (await jfetch(`${apiBase()}/rest/api/3/issue`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          fields: {
            project: { key: project },
            summary,
            description: adfDoc(description),
            issuetype: { name: 'Task' },
          },
        }),
      })) as { id?: string; key?: string }; // create-issue response: only fields we use
      return {
        id: created.id,
        key: created.key,
        url: created.key ? `${apiBase()}/browse/${created.key}` : undefined,
      };
    }
    if (name === 'addComment') {
      const issueKey = argStr(args, 'issueKey');
      return jfetch(`${apiBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ body: adfDoc(argStr(args, 'body')) }),
      });
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const me = (await jfetch(`${apiBase()}/rest/api/3/myself`, { headers: authHeaders() })) as {
      displayName?: string;
    };
    return { ok: true, detail: `authenticated as ${me.displayName ?? 'unknown user'}` };
  }

  return {
    id: ID,
    label: 'Jira',
    capabilities: ['context', 'createIssue', 'addComment'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
