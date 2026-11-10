// Notion connector — search pages as context ('doc' items), plus createPage /
// appendBlocks actions (markdown-lite → blocks). API version 2022-06-28.
// Docs: https://developers.notion.com/reference/post-search
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS: string[] = ['NOTION_KEY'];

const ID = 'notion';
const REQUIRED: string[] = ENV_VARS;
const API_URL = 'https://api.notion.com/v1';

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
    Authorization: `Bearer ${env('NOTION_KEY')}`,
    'Notion-Version': '2022-06-28',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** Notion page payload — only the fields we read. */
interface NotionPage {
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  properties?: Record<string, unknown>;
}

/** find the first title-type property and flatten its rich text */
function pageTitle(props: Record<string, unknown> | undefined): string {
  if (!props) return 'Untitled';
  for (const value of Object.values(props)) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as { type?: unknown; title?: Array<{ plain_text?: string }> }; // title property shape
    if (v.type === 'title' && Array.isArray(v.title)) {
      const text = v.title.map((t) => t.plain_text ?? '').join('');
      if (text.length > 0) return text;
    }
  }
  return 'Untitled';
}

type BlockType = 'heading_1' | 'heading_2' | 'heading_3' | 'bulleted_list_item' | 'paragraph';

/** map a single markdown-lite line to a Notion block object */
function lineToBlock(line: string): Record<string, unknown> {
  let type: BlockType = 'paragraph';
  let text = line;
  if (line.startsWith('### ')) {
    type = 'heading_3';
    text = line.slice(4);
  } else if (line.startsWith('## ')) {
    type = 'heading_2';
    text = line.slice(3);
  } else if (line.startsWith('# ')) {
    type = 'heading_1';
    text = line.slice(2);
  } else if (line.startsWith('- ')) {
    type = 'bulleted_list_item';
    text = line.slice(2);
  }
  return { object: 'block', type, [type]: { rich_text: [{ text: { content: text } }] } };
}

/** markdown-lite → Notion blocks; blank lines skipped, capped at 100 per request */
function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 100)
    .map(lineToBlock);
}

export function createNotionConnector(): Connector {
  function isConfigured(): boolean {
    return REQUIRED.every((name) => env(name) !== '');
  }

  async function fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('doc')) return [];
    const payload: Record<string, unknown> = { page_size: pageLimit(q) };
    if (q.text && q.text.length > 0) payload.query = q.text;
    const data = (await jfetch(`${API_URL}/search`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(payload),
    })) as { results?: unknown[] };
    return (data.results ?? [])
      .filter((r): r is NotionPage => typeof r === 'object' && r !== null && (r as { object?: unknown }).object === 'page')
      .map((page) => ({
        id: page.id,
        source: ID,
        kind: 'doc',
        title: pageTitle(page.properties),
        url: page.url,
        at: page.last_edited_time,
        meta: { created_time: page.created_time, archived: page.archived },
      }));
  }

  async function runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    if (name === 'createPage') {
      const parentPageId = argStr(args, 'parentPageId');
      const title = argStr(args, 'title');
      const markdown = typeof args.markdown === 'string' ? args.markdown : '';
      return jfetch(`${API_URL}/pages`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          parent: { page_id: parentPageId },
          properties: { title: { title: [{ text: { content: title } }] } },
          children: markdownToBlocks(markdown),
        }),
      });
    }
    if (name === 'appendBlocks') {
      const pageId = argStr(args, 'pageId');
      const lines = Array.isArray(args.lines)
        ? args.lines.filter((l): l is string => typeof l === 'string')
        : [];
      return jfetch(`${API_URL}/blocks/${encodeURIComponent(pageId)}/children`, {
        method: 'PATCH',
        headers: headers(true),
        body: JSON.stringify({ children: lines.slice(0, 100).map(lineToBlock) }),
      });
    }
    throw errUnknownAction(ID, name);
  }

  async function health(): Promise<{ ok: boolean; detail?: string }> {
    if (!isConfigured()) throw errConnectorNotConfigured(ID);
    const me = (await jfetch(`${API_URL}/users/me`, { headers: headers(false) })) as {
      name?: string;
      type?: string;
    };
    return { ok: true, detail: `connected as ${me.name ?? me.type ?? 'unknown integration'}` };
  }

  return {
    id: ID,
    label: 'Notion',
    capabilities: ['context', 'createPage', 'appendBlocks'],
    isConfigured,
    fetchContext,
    runAction,
    health,
  };
}
