// Linear connector — recently updated issues as context ('ticket' items), plus
// createIssue / addComment actions via the Linear GraphQL API.
// Docs: https://developers.linear.dev/
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['LINEAR_API_KEY'];

const ID = 'linear';
const REQUIRED: string[] = ENV_VARS;
const API_URL = 'https://api.linear.app/graphql';

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

/** POST a GraphQL document; surfaces top-level GraphQL errors as exceptions. */
async function gql(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const payload = (await jfetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: env('LINEAR_API_KEY'), // Linear expects the raw key (no "Bearer" prefix)
    },
    body: JSON.stringify({ query, variables }),
  })) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`linear graphql error: ${payload.errors.map((e) => e.message ?? 'unknown').join('; ').slice(0, 300)}`);
  }
  return payload.data;
}

/** Linear issue payload — only the fields we query. */
interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  url: string;
  state?: { name?: string } | null;
}

const ISSUES_QUERY = `query($limit:Int!,$from:DateTime!){
  issues(first:$limit, orderBy: updatedAt, filter:{updatedAt:{gte:$from}}){
    nodes{ id identifier title description updatedAt url state{ name } }
  }
}`;

export function createLinearConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('ticket')) return [];
    const from = (q.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString(); // default window: last 7 days
    const data = (await gql(ISSUES_QUERY, { limit: pageLimit(q), from })) as {
      issues?: { nodes?: LinearIssue[] };
    };
    return (data.issues?.nodes ?? []).map((n) => ({
      id: n.id,
      source: ID,
      kind: 'ticket',
      title: n.title,
      body: n.description ?? undefined,
      url: n.url,
      at: n.updatedAt,
      meta: { identifier: n.identifier, state: n.state?.name },
    }));
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'createIssue') {
      const input = {
        teamId: argStr(args, 'teamId'),
        title: argStr(args, 'title'),
        description: typeof args.description === 'string' ? args.description : '',
      };
      const data = (await gql(
        'mutation CreateIssue($input: IssueCreateInput!){ issueCreate(input:$input){ success issue { id url } } }',
        { input },
      )) as { issueCreate?: { success?: boolean; issue?: { id?: string; url?: string } | null } };
      return data.issueCreate ?? null;
    }
    if (name === 'addComment') {
      const input = { issueId: argStr(args, 'issueId'), body: argStr(args, 'body') };
      const data = (await gql(
        'mutation CreateComment($input: CommentCreateInput!){ commentCreate(input:$input){ success } }',
        { input },
      )) as { commentCreate?: { success?: boolean } };
      return data.commentCreate ?? null;
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const data = (await gql('{ viewer { name } }', {})) as { viewer?: { name?: string } };
    return { ok: true, detail: `viewer: ${data.viewer?.name ?? 'unknown'}` };
  }

  return {
    id: ID,
    label: 'Linear',
    capabilities: ['context', 'createIssue', 'addComment'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
