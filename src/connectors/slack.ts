// Slack connector — chat surface (Agent-for-Slack style) + webhook signature verification.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];

interface SlackResponse { ok: boolean; error?: string; [k: string]: unknown }

async function slackFetch(method: string, payload: Record<string, unknown>): Promise<SlackResponse> {
  const token = process.env.SLACK_BOT_TOKEN ?? '';
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`slack: ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as SlackResponse;
  if (body.ok !== true) throw new Error(`slack: ${method} failed: ${body.error ?? 'unknown error'}`);
  return body;
}

interface Args { [k: string]: unknown }
function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`slack: missing required string arg "${key}"`);
  return v;
}

/** Slack HMAC-SHA256 signing verification (versioned "v0=..." scheme). */
export function verifySlackSignature(signingSecret: string, timestamp: string, signature: string, rawBody: string | Buffer): boolean {
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSlackConnector(): Connector {
  const configured = () => !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);

  return {
    id: 'slack',
    label: 'Slack',
    capabilities: ['context', 'postMessage', 'postThreadReply', 'fetchHistory', 'lookupUser'],
    isConfigured: configured,

    async fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
      if (!configured()) throw errConnectorNotConfigured('slack');
      // Search-based context only: without a query there is no meaningful default surface.
      if (!q.text) return [];
      const limit = Math.min(Math.max(q.limit ?? 10, 1), 20); // Slack search count max 100; keep small
      const body = await slackFetch('search.messages', { query: q.text, count: limit, sort: 'ts', sort_dir: 'desc' });
      const matches = ((body as { messages?: { matches?: unknown[] } }).messages?.matches ?? []) as {
        ts: string; text: string; permalink?: string; username?: string; channel?: { name?: string };
      }[];
      const sinceMs = q.since?.getTime() ?? 0;
      return matches
        .filter((m) => Number(m.ts) * 1000 >= sinceMs)
        .map((m) => ({
          id: `${m.channel?.name ?? 'unknown'}:${m.ts}`,
          source: 'slack',
          kind: 'message',
          title: m.username ?? m.channel?.name ?? 'slack message',
          body: m.text.slice(0, 2000),
          url: m.permalink,
          at: new Date(Number(m.ts) * 1000).toISOString(),
          meta: { channel: m.channel?.name },
        }));
    },

    async runAction(name: string, args: Args): Promise<unknown> {
      if (!configured()) throw errConnectorNotConfigured('slack');
      switch (name) {
        case 'postMessage': {
          const channel = str(args, 'channel'); const text = str(args, 'text');
          const body = await slackFetch('chat.postMessage', {
            channel, text,
            ...(typeof args.threadTs === 'string' ? { thread_ts: args.threadTs } : {}),
            ...(Array.isArray(args.blocks) ? { blocks: args.blocks } : {}),
          });
          return body;
        }
        case 'postThreadReply': {
          const body = await slackFetch('chat.postMessage', {
            channel: str(args, 'channel'), text: str(args, 'text'), thread_ts: str(args, 'threadTs'),
          });
          return body;
        }
        case 'fetchHistory': {
          const channel = str(args, 'channel');
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const body = await slackFetch('conversations.history', { channel, limit });
          return (body as { messages?: unknown }).messages ?? [];
        }
        case 'lookupUser': {
          const body = await slackFetch('users.lookupByEmail', { email: str(args, 'email') });
          return body;
        }
        default:
          throw errUnknownAction('slack', name);
      }
    },

    async health() {
      if (!configured()) return { ok: false, detail: 'SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET not set' };
      try {
        await slackFetch('auth.test', {});
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
