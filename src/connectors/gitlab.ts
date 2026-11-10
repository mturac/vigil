// GitLab connector — surfaces open merge requests as context, and can fetch
// details for (or comment on) a specific MR via GitLab API v4.
// Docs: https://docs.gitlab.com/ee/api/rest.html
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['GITLAB_URL', 'GITLAB_TOKEN'];

const ID = 'gitlab';
/** GITLAB_URL falls back to gitlab.com, so only the token is strictly required. */
const REQUIRED: string[] = ['GITLAB_TOKEN'];

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

function apiBase(): string {
  const raw = env('GITLAB_URL') || 'https://gitlab.com';
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

/** GitLab API v4 merge_request payload — only the fields we read. */
interface GitlabMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  updated_at: string;
  web_url: string;
  author?: { username?: string };
  source_branch?: string;
  target_branch?: string;
}

function toContext(mr: GitlabMr): ContextItem {
  return {
    id: String(mr.id),
    source: ID,
    kind: 'mr',
    title: mr.title,
    body: mr.description ?? undefined,
    url: mr.web_url,
    at: mr.updated_at,
    meta: {
      iid: mr.iid,
      project_id: mr.project_id,
      state: mr.state,
      author: mr.author?.username,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
    },
  };
}

export function createGitlabConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  function headers(): Record<string, string> {
    return { 'PRIVATE-TOKEN': env('GITLAB_TOKEN') };
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('mr')) return [];
    const limit = pageLimit(q);
    const url = `${apiBase()}/api/v4/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${limit}`;
    // the global MR list endpoint has no `since` param — filter client-side on updated_at
    const mrs = (await jfetch(url, { headers: headers() })) as GitlabMr[];
    return (Array.isArray(mrs) ? mrs : [])
      .filter((mr) => !q.since || new Date(mr.updated_at).getTime() >= q.since.getTime())
      .slice(0, limit)
      .map(toContext);
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'getMr') {
      const mrUrl = `${apiBase()}/api/v4/projects/${encodeURIComponent(argStr(args, 'project_id'))}/merge_requests/${encodeURIComponent(argStr(args, 'mr_iid'))}`;
      const mr = (await jfetch(mrUrl, { headers: headers() })) as GitlabMr;
      const withChanges = (await jfetch(`${mrUrl}/changes`, { headers: headers() })) as { changes?: unknown[] };
      return { ...mr, changes: withChanges.changes ?? [] };
    }
    if (name === 'commentMr') {
      const notesUrl = `${apiBase()}/api/v4/projects/${encodeURIComponent(argStr(args, 'project_id'))}/merge_requests/${encodeURIComponent(argStr(args, 'mr_iid'))}/notes`;
      return jfetch(notesUrl, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: argStr(args, 'body') }),
      });
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const user = (await jfetch(`${apiBase()}/api/v4/user`, { headers: headers() })) as { username?: string };
    return { ok: true, detail: `authenticated as ${user.username ?? 'unknown user'}` };
  }

  return {
    id: ID,
    label: 'GitLab',
    capabilities: ['context', 'getMr', 'commentMr'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
