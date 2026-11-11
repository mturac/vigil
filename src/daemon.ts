// Daemon: durable queue workers + GitHub polling + cron automations.
// This is the always-on "agent runtime" process.
import './core/env.js'; // load .env before anything reads process.env
import type { PrismaClient } from '@prisma/client';
import { Queue } from './core/queue.js';
import { db } from './core/db.js';
import { loadConfigFile, DEFAULT_CONFIG, type VigilConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { ensureDefaultScope } from './core/db.js';
import { buildApp } from './server.js';
import { ReviewEngine } from './review/engine.js';
import { FixEngine } from './fix/engine.js';
import { ChatAgent } from './chat/agent.js';
import { buildRegistry } from './connectors/registry.js';
import { runSkill, SKILL_LIST } from './chat/skills.js';

// ---------------------------------------------------------------------------
// minimal 5-field cron matcher (m h dom mon dow), supports * / n , -
export function cronMatches(expr: string, d = new Date()): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return fields.every((field, i) => matchField(field, values[i]));
}
function matchField(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    const step = part.includes('/') ? parseInt(part.split('/')[1], 10) : 1;
    const base = part.split('/')[0];
    let from: number, to: number;
    if (base === '*') { from = 0; to = 59; }
    else if (base.includes('-')) { const [a, b] = base.split('-'); from = parseInt(a, 10); to = parseInt(b, 10); }
    else { from = parseInt(base, 10); to = parseInt(base, 10); }
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0) return false;
    if (value < from || value > to) return false;
    return (value - from) % step === 0;
  });
}

// ---------------------------------------------------------------------------

export interface DaemonOptions {
  cfg?: VigilConfig;
  withServer?: boolean;
  port?: number;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ stop: () => void; port?: number }> {
  const cfg = opts.cfg ?? loadConfigFile('.vigil.yml');
  await ensureDefaultScope();

  const queue = new Queue(db, { logger, pollMs: 1500, batchSize: 3 });
  const agent = new ChatAgent(db, cfg);
  const reviewEngine = new ReviewEngine(db, cfg);
  const fixEngine = new FixEngine(db, cfg);
  const github = buildRegistry().get('github')!;

  // ---- queue handlers --------------------------------------------------------
  queue.register({
    type: 'review.pr',
    async handle(payload) {
      const r = await reviewEngine.review({ repo: String(payload.repo), number: Number(payload.number) });
      logger.info({ repo: payload.repo, pr: payload.number, risk: r.riskScore, findings: r.findings.length }, 'review completed');
    },
  });
  queue.register({
    type: 'automation.pr_summary',
    async handle(payload) {
      const r = await reviewEngine.review({ repo: String(payload.repo), number: Number(payload.number), dryRun: false });
      const convKey = String(payload.channel ?? 'console:default');
      await agent.handle({ text: `Summarize PR ${payload.repo}#${payload.number} for the team channel. Risk ${r.riskScore}/100, ${r.findings.length} findings. Summary:\n${r.report.slice(0, 3000)}`, channelKey: convKey, channel: convKey.startsWith('slack:') ? 'slack' : 'console' }).catch(() => {});
    },
  });
  queue.register({
    type: 'chat.github_comment',
    async handle(payload) {
      const reply = await agent.handle({
        text: String(payload.body), userId: String(payload.author),
        channelKey: `github:${payload.repo}#${payload.number}`, channel: 'github',
      });
      if (github.isConfigured() && reply.reply) {
        await github.runAction('commentPr', { repo: String(payload.repo), number: Number(payload.number), body: reply.reply }).catch((e) => {
          logger.error({ err: (e as Error).message }, 'failed to reply on github comment');
        });
      }
    },
  });
  queue.register({
    type: 'chat.slack',
    async handle(payload) {
      const slack = buildRegistry().get('slack')!;
      const reply = await agent.handle({
        text: String(payload.text), userId: String(payload.userId),
        channelKey: `slack:${payload.channel}`, channel: 'slack',
      });
      if (slack.isConfigured() && reply.reply) {
        await slack.runAction('postThreadReply', { channel: String(payload.channel), threadTs: String(payload.threadTs), text: reply.reply.slice(0, 3500) }).catch((e) => {
          logger.error({ err: (e as Error).message }, 'failed to reply in slack');
        });
      }
    },
  });
  queue.register({
    type: 'fix.issue',
    async handle(payload) {
      const r = await fixEngine.fix({ repo: String(payload.repo), issue: String(payload.issue), origin: String(payload.origin ?? 'issue') });
      logger.info({ repo: payload.repo, status: r.status, pr: r.prUrl }, 'fix run finished');
    },
  });
  queue.register({
    type: 'automation.run',
    async handle(payload) {
      const name = String(payload.name);
      const skillId = name.includes('standup') ? 'standup' : name.includes('stale') ? 'stale-prs' : String(payload.skill ?? name);
      const ctx = { db, cfg };
      const out = await runSkill({ db, cfg } as never, skillId, (payload.args ?? {}) as Record<string, unknown>);
      const report = (out as { report?: string }).report ?? JSON.stringify(out).slice(0, 2000);
      const channelKey = String(payload.channel ?? 'console:default');
      await db.automation.update({ where: { name }, data: { lastRunAt: new Date() } }).catch(() => {});
      await agent.handle({ text: `Automation "${name}" result:\n\n${report.slice(0, 3500)}`, channelKey, channel: channelKey.startsWith('slack:') ? 'slack' : 'console' }).catch(() => {});
      void ctx;
    },
  });

  // ---- cron automations --------------------------------------------------------
  const timers: NodeJS.Timeout[] = [];
  const automationDefs = [
    { name: 'standup', enabled: cfg.automations.standup.enabled, expr: cfg.automations.standup.cron, skill: 'standup', channel: cfg.automations.standup.channel, args: {} },
    { name: 'stale-prs', enabled: cfg.automations.stalePrs.enabled, expr: cfg.automations.stalePrs.cron, skill: 'stale-prs', channel: cfg.automations.stalePrs.channel, args: { idleHours: cfg.automations.stalePrs.idleHours } },
  ];
  // sync DB automations from config (idempotent)
  for (const def of automationDefs) {
    await db.automation.upsert({
      where: { name: def.name },
      create: { name: def.name, kind: 'cron', expr: def.expr, channelKey: def.channel, prompt: def.skill, skill: def.skill, enabled: def.enabled },
      update: { expr: def.expr, channelKey: def.channel, skill: def.skill, enabled: def.enabled },
    }).catch(() => {});
  }
  const lastCronRun = new Map<string, number>();
  timers.push(setInterval(() => {
    const now = new Date();
    const minuteKey = `${now.getHours()}:${now.getMinutes()}`;
    for (const def of automationDefs) {
      if (!def.enabled || !def.expr) continue;
      const key = `${def.name}:${minuteKey}`;
      if (lastCronRun.has(key)) continue;
      if (cronMatches(def.expr, now)) {
        lastCronRun.set(key, Date.now());
        void queue.enqueue('automation.run', { name: def.name, skill: def.skill, channel: def.channel, args: def.args }).then(() => {
          logger.info({ automation: def.name }, 'cron automation fired');
        });
      }
    }
    // prune map occasionally
    if (lastCronRun.size > 500) lastCronRun.clear();
  }, 30_000));
  timers[timers.length - 1].unref?.();

  // ---- github polling (for repos without webhooks) ------------------------------
  const reposEnv = (process.env.REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pollIntervalMs = Math.max(30, (parseInt(process.env.POLL_INTERVAL_SEC ?? '60', 10) || 60)) * 1000;
  const seenHeads = new Map<string, string>();
  if (github.isConfigured() && reposEnv.length > 0) {
    const poll = async () => {
      for (const repo of reposEnv.slice(0, 10)) {
        try {
          const prs = (await github.runAction('listOpenPrs', { repo })) as { number: number; head: { sha: string }; updated_at: string }[];
          for (const pr of prs) {
            const key = `${repo}#${pr.number}`;
            if (seenHeads.get(key) !== pr.head.sha) {
              const first = !seenHeads.has(key);
              seenHeads.set(key, pr.head.sha);
              if (first) continue; // first poll only records state
              if (cfg.review.enabled) {
                await queue.enqueue('review.pr', { repo, number: pr.number }, { dedupeKey: `review:${key}:${pr.head.sha}` });
                logger.info({ repo, pr: pr.number }, 'poller queued review');
              }
            }
          }
        } catch (e) {
          logger.warn({ repo, err: (e as Error).message }, 'poll failed');
        }
      }
    };
    await poll(); // record initial state
    const t = setInterval(() => void poll(), pollIntervalMs);
    t.unref?.();
    timers.push(t);
  }

  // ---- optional HTTP surface ------------------------------------------------------
  let port: number | undefined;
  if (opts.withServer !== false) {
    port = opts.port ?? (parseInt(process.env.PORT ?? '8080', 10) || 8080);
    const app = buildApp({ db, cfg, queue, agent });
    const server = app.listen(port, () => {
      logger.info({ port }, `vigil daemon listening on http://localhost:${port}`);
    });
    timers.push({ unref: () => server.close(), } as unknown as NodeJS.Timeout);
  }

  queue.start();
  logger.info({ repos: reposEnv }, 'vigil daemon started');

  return {
    stop: () => {
      queue.stop();
      for (const t of timers) t.unref?.();
    },
    port,
  };
}
