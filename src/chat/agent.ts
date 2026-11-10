// Chat agent: the conversational brain behind Slack / GitHub comments / console.
// Tool loop over: org-context (all connectors), review engine, fix engine,
// memory (team knowledge), sandbox commands and built-in skills.
import type { PrismaClient } from '@prisma/client';
import { llm, llmConfigured, costOf, type LlmMessage, type LlmToolDef } from '../core/llm.js';
import { Memory } from '../core/memory.js';
import { Governor } from '../core/governance.js';
import { buildRegistry } from '../connectors/registry.js';
import { ReviewEngine } from '../review/engine.js';
import { FixEngine } from '../fix/engine.js';
import { runSkill, SKILL_LIST } from './skills.js';
import { DEFAULT_CONFIG, type VigilConfig } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface AgentRequest {
  text: string;
  userId?: string;
  channelKey: string; // github:owner/repo#12 | slack:C0123 | console:default
  channel: 'github' | 'slack' | 'console' | 'api';
  conversationId?: string;
  scopeName?: string;
}

export interface AgentResponse {
  reply: string;
  runId: string;
  costUsd: number;
  wallMs: number;
  conversationId: string;
}

const MAX_STEPS = 14;

export class ChatAgent {
  private memory: Memory;
  private governor: Governor;

  constructor(
    private db: PrismaClient,
    private cfg: VigilConfig = DEFAULT_CONFIG,
  ) {
    this.memory = new Memory(db, { enabled: cfg.memory.enabled });
    this.governor = new Governor(db);
  }

  /** Parse "@vigil <command>" style messages. */
  static parseCommand(text: string): { command: string; args: string } | null {
    const m = text.match(/^\s*@(vigil|coderabbit)\s+(\/?\w+)?\s*([\s\S]*)$/i) ?? text.match(/^\s*(\/\w+)\s*([\s\S]*)$/);
    if (!m) return null;
    const command = (m[2] ?? m[1] ?? '').replace(/^\//, '').toLowerCase();
    return { command, args: (m[3] ?? '').trim() };
  }

  async handle(req: AgentRequest): Promise<AgentResponse> {
    const started = Date.now();

    // conversation upsert
    let conv = await this.db.conversation.findUnique({ where: { channel_channelKey: { channel: req.channel, channelKey: req.channelKey } } });
    if (!conv) {
      conv = await this.db.conversation.create({
        data: { channel: req.channel, channelKey: req.channelKey, title: req.text.slice(0, 80) },
      });
    }

    // scope + governance
    const scope = await this.governor.resolveScope({ scopeName: req.scopeName, channelKey: req.channelKey });
    const userCheck = this.governor.check(scope, { userId: req.userId });
    if (!userCheck.allowed) {
      return { reply: `Vigil: ${userCheck.reason}`, runId: '', costUsd: 0, wallMs: 0, conversationId: conv.id };
    }

    // run record
    const run = await this.db.run.create({
      data: {
        conversationId: conv.id,
        scopeId: scope.id,
        kind: 'chat',
        goal: req.text.slice(0, 2000),
        channelKey: req.channelKey,
        userId: req.userId,
        status: 'running',
      },
    });
    await this.db.chatMessage.create({
      data: { conversationId: conv.id, role: 'user', authorId: req.userId, body: req.text, runId: run.id },
    });

    let totalIn = 0;
    let totalOut = 0;
    let cost = 0;
    let seq = 0;
    const step = async (kind: string, name: string, detail: unknown, ok: boolean, durMs: number, tin = 0, tout = 0, c = 0) => {
      seq++;
      totalIn += tin; totalOut += tout; cost += c;
      await this.db.runStep.create({
        data: { runId: run.id, seq, kind, name, detail: detail as object, ok, durationMs: durMs, tokensIn: tin, tokensOut: tout, costUsd: c },
      }).catch(() => {});
    };

    const reply = await (async () => {
      try {
        // ---- memory recall (team knowledge) ---------------------------------
        const repoFromChannel = req.channelKey.match(/^github:([^#]+)#\d+$/)?.[1];
        const learnings = await this.memory.recall({ repoFullName: repoFromChannel, conversationId: conv.id }, 8);

        // ---- build tool surface ----------------------------------------------
        const registry = buildRegistry();
        const tools: LlmToolDef[] = [];
        const toolImpls = new Map<string, { kind: string; run: (args: Record<string, unknown>) => Promise<unknown> }>();

        // governance: only allowed connectors are exposed
        for (const c of registry.values()) {
          if (!c.isConfigured()) continue;
          const g = this.governor.check(scope, { connector: c.id });
          if (!g.allowed) continue;
          for (const cap of c.capabilities) {
            if (cap === 'context') continue; // context aggregated below
            const name = `${c.id.replace(/\./g, '_')}__${cap}`;
            tools.push({
              name,
              description: `Call ${c.label} action "${cap}".`,
              parameters: { type: 'object', properties: { argsJson: { type: 'string', description: 'JSON object of action arguments' } }, required: ['argsJson'] },
            });
            toolImpls.set(name, {
              kind: 'connector',
              run: async (a) => {
                await this.governor.assertSpend(scope, 0);
                const parsed = typeof a.argsJson === 'string' ? safeParse(a.argsJson) : (a as Record<string, unknown>);
                return c.runAction(cap, parsed);
              },
            });
          }
        }

        // skills
        for (const skill of SKILL_LIST) {
          tools.push({
            name: `skill__${skill.id}`,
            description: skill.description,
            parameters: { type: 'object', properties: { argsJson: { type: 'string', description: 'JSON args for the skill' } }, required: ['argsJson'] },
          });
          toolImpls.set(`skill__${skill.id}`, {
            kind: 'tool',
            run: async (a) => {
              const parsed = typeof a.argsJson === 'string' ? safeParse(a.argsJson) : (a as Record<string, unknown>);
              return runSkill(this, skill.id, parsed);
            },
          });
        }

        // review + fix + memory
        tools.push({
          name: 'review__pr',
          description: 'Run a full code review on a GitHub pull request.',
          parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, number: { type: 'number' } }, required: ['repo', 'number'] },
        });
        toolImpls.set('review__pr', {
          kind: 'tool',
          run: async (a) => {
            const engine = new ReviewEngine(this.db, this.cfg);
            return engine.review({ repo: String(a.repo), number: Number(a.number) });
          },
        });
        tools.push({
          name: 'fix__issue',
          description: 'Autonomously fix an issue in a repo: branch, patch, verify in sandbox, open a PR.',
          parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, issue: { type: 'string', description: 'what to fix' } }, required: ['repo', 'issue'] },
        });
        toolImpls.set('fix__issue', {
          kind: 'tool',
          run: async (a) => {
            const g = this.governor.check(scope, { repo: String(a.repo) });
            if (!g.allowed) throw new Error(g.reason);
            const engine = new FixEngine(this.db, this.cfg);
            return engine.fix({ repo: String(a.repo), issue: String(a.issue), origin: `chat:${req.channelKey}` });
          },
        });
        tools.push({
          name: 'memory__save',
          description: 'Persist a durable team fact/decision/runbook for future conversations.',
          parameters: { type: 'object', properties: { kind: { type: 'string', description: 'fact|decision|runbook|preference' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['kind', 'title', 'body'] },
        });
        toolImpls.set('memory__save', {
          kind: 'tool',
          run: async (a) => {
            const id = await this.memory.remember({
              kind: (['fact', 'decision', 'runbook', 'preference'].includes(String(a.kind)) ? String(a.kind) : 'fact') as 'fact',
              title: String(a.title ?? 'note'),
              body: String(a.body ?? ''),
              repoFullName: repoFromChannel,
              conversationId: conv.id,
              sourceRunId: run.id,
            });
            return { saved: true, id };
          },
        });
        tools.push({
          name: 'memory__search',
          description: 'Search the team knowledge base.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        });
        toolImpls.set('memory__search', {
          kind: 'tool',
          run: async () => ({ results: learnings }),
        });

        // org context snapshot (cheap aggregation of connectors)
        const contextTool: LlmToolDef = {
          name: 'org__context',
          description: 'Fetch a cross-tool context snapshot: open PRs (GitHub), tickets (Jira/Linear), alerts (Sentry/Datadog/PagerDuty), docs (Notion).',
          parameters: { type: 'object', properties: { sinceHours: { type: 'number', description: 'lookback window in hours (default 24)' } } },
        };
        tools.push(contextTool);
        toolImpls.set('org__context', {
          kind: 'connector',
          run: async (a) => {
            const sinceHours = typeof a.sinceHours === 'number' ? a.sinceHours : 24;
            const since = new Date(Date.now() - sinceHours * 3600_000);
            const out: Record<string, unknown[]> = {};
            for (const c of registry.values()) {
              if (!c.isConfigured() || !c.capabilities.includes('context')) continue;
              const g = this.governor.check(scope, { connector: c.id });
              if (!g.allowed) continue;
              const t0 = Date.now();
              try {
                const items = await c.fetchContext({ since, limit: 5 });
                if (items.length > 0) out[c.id] = items.map((i) => ({ kind: i.kind, title: i.title, url: i.url, at: i.at }));
                await step('connector', `context:${c.id}`, { count: items.length }, true, Date.now() - t0);
              } catch (e) {
                await step('connector', `context:${c.id}`, { error: (e as Error).message }, false, Date.now() - t0);
              }
            }
            return out;
          },
        });

        // ---- messages ---------------------------------------------------------
        const system = `You are Vigil, a self-hosted autonomous SDLC agent embedded in your team's tools. You review code, investigate incidents, fix issues end-to-end, and remember what the team learns. Today: ${new Date().toISOString().slice(0, 10)}. Channel: ${req.channel}.${learnings.length > 0 ? `\nTeam memory:\n${learnings.join('\n')}` : ''}\nUse tools to act and fetch context; answer concisely in markdown; when you fixed/created something, link it. Cost-aware: avoid redundant tool calls.`;
        const history = await this.db.chatMessage.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'asc' },
          take: 20,
        });
        const messages: LlmMessage[] = [
          { role: 'system', content: system },
          ...history.slice(0, -1).map((m) => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.body.slice(0, 4000) })),
          { role: 'user', content: req.text },
        ];

        // ---- loop -------------------------------------------------------------
        let finalReply = '';
        for (let i = 0; i < MAX_STEPS; i++) {
          await this.governor.assertSpend(scope, cost);
          const t0 = Date.now();
          const res = await llm.chat(messages, tools, { temperature: 0.2, maxTokens: 3500 });
          const c = costOf(res.model, res.promptTokens, res.completionTokens);
          await step('llm', `chat:${res.model}`, { toolCalls: res.toolCalls.map((t) => t.name) }, true, Date.now() - t0, res.promptTokens, res.completionTokens, c);

          if (res.toolCalls.length === 0) {
            finalReply = res.content || '(no content)';
            break;
          }
          messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
          for (const call of res.toolCalls) {
            const impl = toolImpls.get(call.name);
            const t1 = Date.now();
            let out: unknown;
            let ok = true;
            if (!impl) {
              out = { error: `unknown tool ${call.name}` };
              ok = false;
            } else {
              try {
                out = await impl.run(safeParse(call.arguments));
              } catch (e) {
                out = { error: (e as Error).message };
                ok = false;
              }
            }
            await step(impl?.kind ?? 'tool', call.name, { ok, preview: JSON.stringify(out)?.slice(0, 400) }, ok, Date.now() - t1);
            messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: JSON.stringify(out)?.slice(0, 12_000) ?? 'null' });
          }
          if (i === MAX_STEPS - 1) finalReply = res.content || 'Reached step limit — partial result above.';
        }

        return finalReply || 'Done.';
      } catch (e) {
        logger.error({ err: (e as Error).message }, 'agent run failed');
        return `Vigil error: ${(e as Error).message}`;
      }
    })();

    const wallMs = Date.now() - started;
    await this.db.run.update({
      where: { id: run.id },
      data: { status: 'succeeded', costUsd: cost, promptTokens: totalIn, completionTokens: totalOut, wallMs, finishedAt: new Date() },
    }).catch(() => {});
    await this.db.chatMessage.create({
      data: { conversationId: conv.id, role: 'assistant', body: reply, runId: run.id },
    }).catch(() => {});
    await this.db.conversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } }).catch(() => {});

    return { reply, runId: run.id, costUsd: cost, wallMs, conversationId: conv.id };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
