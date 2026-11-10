// PagerDuty connector — recent incidents as context ('incident' items), plus
// getIncident / acknowledge actions. REST API v2:
// https://developer.pagerduty.com/api-reference/
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['PAGERDUTY_TOKEN'];

const ID = 'pagerduty';
const REQUIRED: string[] = ENV_VARS;
const API_URL = 'https://api.pagerduty.com';

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

function headers(json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${env('PAGERDUTY_TOKEN')}`,
    Accept: 'application/vnd.pagerduty+json;version=2',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** PagerDuty incident payload — only the fields we read. */
interface PdIncident {
  id: string;
  summary?: string;
  description?: string | null;
  status?: string;
  urgency?: string;
  created_at?: string;
  html_url?: string;
  service?: { id?: string; summary?: string };
}

function toContext(i: PdIncident): ContextItem {
  return {
    id: i.id,
    source: ID,
    kind: 'incident',
    title: i.summary ?? i.id,
    body: i.description ?? undefined,
    url: i.html_url,
    at: i.created_at,
    meta: { status: i.status, urgency: i.urgency, service: i.service?.summary },
  };
}

/** single-resource responses are wrapped: { incident: {...} } */
function unwrapIncident(payload: unknown): unknown {
  if (payload !== null && typeof payload === 'object' && 'incident' in payload) {
    return (payload as { incident?: unknown }).incident ?? payload;
  }
  return payload;
}

export function createPagerdutyConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('incident')) return [];
    const params = new URLSearchParams({ sort_by: 'created_at:desc', limit: String(pageLimit(q)) });
    if (q.since) params.set('since', q.since.toISOString());
    const data = (await jfetch(`${API_URL}/incidents?${params.toString()}`, {
      headers: headers(false),
    })) as { incidents?: PdIncident[] };
    return (data.incidents ?? []).map(toContext);
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'getIncident') {
      const url = `${API_URL}/incidents/${encodeURIComponent(argStr(args, 'id'))}`;
      return unwrapIncident(await jfetch(url, { headers: headers(false) }));
    }
    if (name === 'acknowledge') {
      const url = `${API_URL}/incidents/${encodeURIComponent(argStr(args, 'id'))}`;
      return unwrapIncident(
        await jfetch(url, {
          method: 'PUT',
          headers: headers(true),
          body: JSON.stringify({ incident: { type: 'incident_reference', status: 'acknowledged' } }),
        }),
      );
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const data = (await jfetch(`${API_URL}/users?limit=1`, { headers: headers(false) })) as {
      users?: Array<{ name?: string }>;
    };
    return { ok: true, detail: `token valid, ${data.users?.length ?? 0} user(s) visible` };
  }

  return {
    id: ID,
    label: 'PagerDuty',
    capabilities: ['context', 'getIncident', 'acknowledge'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
