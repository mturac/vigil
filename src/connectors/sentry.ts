// Sentry connector — unresolved issues from the last 24h as context ('alert'
// items), plus a getIssue action. Docs: https://docs.sentry.io/api/
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['SENTRY_HOST', 'SENTRY_TOKEN', 'SENTRY_ORG'];

const ID = 'sentry';
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

/** SENTRY_HOST is a base URL like "https://sentry.io" — normalize it. */
function apiBase(): string {
  const raw = env('SENTRY_HOST');
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

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${env('SENTRY_TOKEN')}` };
}

/** Sentry issue payload — only the fields we read. */
interface SentryIssue {
  id: string;
  shortId?: string | null;
  title: string;
  permalink?: string;
  level?: string;
  status?: string;
  count?: string | number;
  culprit?: string;
  lastSeen?: string;
  firstSeen?: string;
  metadata?: { type?: string | number | null };
}

function toContext(issue: SentryIssue): ContextItem {
  const metaType = issue.metadata?.type;
  return {
    id: issue.id,
    source: ID,
    kind: 'alert',
    title: issue.title,
    body: `${metaType ?? 'unknown'} · ${issue.shortId ?? issue.id}`,
    url: issue.permalink,
    at: issue.lastSeen,
    meta: { level: issue.level, status: issue.status, count: issue.count, culprit: issue.culprit },
  };
}

export function createSentryConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('alert')) return [];
    const org = env('SENTRY_ORG');
    const params = new URLSearchParams({
      query: 'is:unresolved',
      sort: 'date',
      statsPeriod: '24h',
      perPage: String(pageLimit(q)),
    });
    const issues = (await jfetch(`${apiBase()}/api/0/organizations/${encodeURIComponent(org)}/issues/?${params.toString()}`, {
      headers: headers(),
    })) as SentryIssue[];
    return (Array.isArray(issues) ? issues : [])
      // statsPeriod is pinned to 24h; narrow further client-side when `since` is more recent
      .filter((i) => !q.since || !i.lastSeen || new Date(i.lastSeen).getTime() >= q.since.getTime())
      .map(toContext);
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'getIssue') {
      const org = env('SENTRY_ORG');
      const url = `${apiBase()}/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(argStr(args, 'issueId'))}/`;
      return jfetch(url, { headers: headers() });
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const orgs = (await jfetch(`${apiBase()}/api/0/organizations/`, { headers: headers() })) as Array<{
      name?: string;
      slug?: string;
    }>;
    const n = Array.isArray(orgs) ? orgs.length : 0;
    return { ok: true, detail: `${n} organization(s) visible` };
  }

  return {
    id: ID,
    label: 'Sentry',
    capabilities: ['context', 'getIssue'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
