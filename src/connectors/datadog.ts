// Datadog connector — recent events as context ('event' items), plus a
// getMonitor action. Docs: https://docs.datadoghq.com/api/latest/events/
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['DATADOG_HOST', 'DATADOG_API_KEY', 'DATADOG_APP_KEY'];

const ID = 'datadog';
/** DATADOG_HOST falls back to api.datadoghq.com, so only the keys are strictly required. */
const REQUIRED: string[] = ['DATADOG_API_KEY', 'DATADOG_APP_KEY'];

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
  const raw = env('DATADOG_HOST') || 'https://api.datadoghq.com';
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
  return { 'DD-API-KEY': env('DATADOG_API_KEY'), 'DD-APPLICATION-KEY': env('DATADOG_APP_KEY') };
}

/** Datadog event payload — only the fields we read. */
interface DatadogEvent {
  id: number | string;
  title?: string | null;
  text?: string | null;
  url?: string | null;
  date_happened?: number; // epoch seconds
  host?: string | null;
  tags?: string[] | null;
  alert_type?: string;
  priority?: string | null;
}

function toContext(e: DatadogEvent): ContextItem {
  return {
    id: String(e.id),
    source: ID,
    kind: 'event',
    title: e.title ?? `event ${String(e.id)}`,
    body: e.text ?? undefined,
    url: e.url ?? undefined,
    at: typeof e.date_happened === 'number' ? new Date(e.date_happened * 1000).toISOString() : undefined,
    meta: { host: e.host, tags: e.tags ?? undefined, alert_type: e.alert_type, priority: e.priority },
  };
}

export function createDatadogConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('event')) return [];
    const startMs = q.since ? q.since.getTime() : Date.now() - 24 * 60 * 60 * 1000; // default window: last 24h
    const params = new URLSearchParams({
      start: String(startMs), // epoch milliseconds (per task spec)
      end: String(Date.now()),
      per_page: String(pageLimit(q)),
    });
    const data = (await jfetch(`${apiBase()}/api/v1/events?${params.toString()}`, {
      headers: headers(),
    })) as { events?: DatadogEvent[] };
    return (data.events ?? []).map(toContext);
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'getMonitor') {
      return jfetch(`${apiBase()}/api/v1/monitor/${encodeURIComponent(argStr(args, 'id'))}`, {
        headers: headers(),
      });
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const data = (await jfetch(`${apiBase()}/api/v1/validate`, { headers: headers() })) as { valid?: boolean };
    return {
      ok: data.valid === true,
      detail: data.valid === true ? 'API and application keys valid' : 'key validation failed',
    };
  }

  return {
    id: ID,
    label: 'Datadog',
    capabilities: ['context', 'getMonitor'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
