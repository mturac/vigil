// HTTP surface: dashboard (server-rendered), JSON APIs, GitHub + Slack webhooks.
import express, { type Request, type Response, type NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { Queue } from './core/queue.js';
import { ChatAgent } from './chat/agent.js';
import { ReviewEngine } from './review/engine.js';
import { connectorsHealth } from './connectors/registry.js';
import { verifySlackSignature } from './connectors/slack.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { renderConsole, renderError, renderJobs, renderOverview, renderReviewDetail, renderRunDetail, renderUsage, page } from './dashboard/views.js';
import type { ConsoleThreadVM, ConsoleVM, JobsVM, OverviewVM, ReviewDetailVM, RunDetailVM, UsageVM } from './dashboard/types.js';
import { DEFAULT_CONFIG, type VigilConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { ensureDefaultScope } from './core/db.js';

export interface ServerDeps {
  db: PrismaClient;
  cfg?: VigilConfig;
  queue: Queue;
  agent?: ChatAgent;
}

export function buildApp({ db, cfg = DEFAULT_CONFIG, queue, agent }: ServerDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const password = process.env.DASHBOARD_PASSWORD ?? '';

  // --- auth gate ------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!password || req.path.startsWith('/webhooks/') || req.path === '/api/health') return next();
    const key = (req.query.key as string) ?? bearer(req);
    if (key === password) return next();
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthorized: pass ?key= or Authorization: Bearer' });
    } else {
      res.status(401).send(page('Unauthorized', '', renderError('Unauthorized — append ?key=<DASHBOARD_PASSWORD> to the URL.')));
    }
  });

  // raw body for webhook signature verification (registered before json parser)
  app.use('/webhooks/github', express.raw({ type: '*/*', limit: '10mb' }), verifyGithubWebhook);
  app.use('/webhooks/slack', express.raw({ type: '*/*', limit: '1mb' }), verifySlackWebhook);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));

  // --- health ----------------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'vigil', time: new Date().toISOString() });
  });

  // --- dashboard pages ---------------------------------------------------------
  app.get('/', async (_req, res) => {
    const vm = await buildOverviewVM(db);
    res.send(page('Overview', 'overview', renderOverview(vm)));
  });

  app.get('/reviews', async (_req, res) => {
    const vm = await buildOverviewVM(db);
    res.send(page('Reviews', 'reviews', renderOverview(vm)));
  });

  app.get('/reviews/:id', async (req, res) => {
    const vm = await buildReviewDetailVM(db, req.params.id);
    if (!vm) { res.status(404).send(page('Not found', 'reviews', renderError('Review not found'))); return; }
    res.send(page(`Review ${vm.review.pr}`, 'reviews', renderReviewDetail(vm)));
  });

  app.get('/console', async (req, res) => {
    const vm = await buildConsoleVM(db);
    let thread: ConsoleThreadVM | null = null;
    if (req.query.thread) thread = await buildThreadVM(db, String(req.query.thread));
    res.send(page('Console', 'console', renderConsole(vm, thread)));
  });

  app.get('/usage', async (_req, res) => {
    const vm = await buildUsageVM(db);
    res.send(page('Usage', 'usage', renderUsage(vm)));
  });

  app.get('/jobs', async (_req, res) => {
    const vm = await buildJobsVM(db);
    res.send(page('Jobs', 'jobs', renderJobs(vm)));
  });

  app.get('/runs/:id', async (req, res) => {
    const vm = await buildRunDetailVM(db, req.params.id);
    if (!vm) { res.status(404).send(page('Not found', 'usage', renderError('Run not found'))); return; }
    res.send(page('Run', 'usage', renderRunDetail(vm)));
  });

  // --- console APIs (used by the dashboard inline JS) --------------------------
  app.post('/api/console/message', async (req, res) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text) { res.status(400).json({ error: 'text required' }); return; }
      if (!agent) { res.status(503).json({ error: 'agent not configured (LLM_PROVIDER)' }); return; }
      const threadId = typeof req.body?.threadId === 'string' && req.body.threadId ? req.body.threadId : null;
      let channelKey = 'console:default';
      if (threadId) {
        const conv = await db.conversation.findUnique({ where: { id: threadId } });
        if (conv) channelKey = conv.channelKey;
      }
      const r = await agent.handle({ text, channelKey, channel: channelKey.startsWith('slack:') ? 'slack' : 'console' });
      res.json({ ok: true, reply: r.reply, threadId: r.conversationId, runId: r.runId });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/console/threads/:id', async (req, res) => {
    const vm = await buildThreadVM(db, req.params.id);
    if (!vm) { res.status(404).json({ error: 'not found' }); return; }
    res.json(vm);
  });

  // --- GitHub webhook ----------------------------------------------------------
  app.post('/webhooks/github', async (req, res) => {
    try {
      const event = req.headers['x-github-event'] as string | undefined;
      const payload = (Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body) as Record<string, unknown>;
      const action = payload.action as string | undefined;
      const pr = payload.pull_request as { number: number; title: string; user?: { login?: string }; base?: { ref?: string }; head?: { ref?: string; sha?: string }; additions?: number; deletions?: number; changed_files?: number; state?: string } | undefined;
      const repoInfo = payload.repository as { full_name?: string; id?: number; name?: string; owner?: { login?: string } } | undefined;

      if (event === 'pull_request' && (action === 'opened' || action === 'synchronize') && pr && repoInfo?.full_name) {
        if (cfg.review.enabled) {
          const dedupe = `review:${repoInfo.full_name}#${pr.number}:${pr.head?.sha ?? ''}:${action}`;
          const id = await queue.enqueue('review.pr', { repo: repoInfo.full_name, number: pr.number }, { dedupeKey: dedupe });
          logger.info({ repo: repoInfo.full_name, pr: pr.number, jobId: id }, 'queued PR review from webhook');
        }
        if (cfg.automations.prSummary.enabled && action === 'opened') {
          await queue.enqueue('automation.pr_summary', { repo: repoInfo.full_name, number: pr.number, channel: cfg.automations.prSummary.channel }, { dedupeKey: `prsum:${repoInfo.full_name}#${pr.number}` });
        }
      }
      if (event === 'issue_comment' && action === 'created') {
        const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined;
        const comment = payload.comment as { body?: string; user?: { login?: string } } | undefined;
        const body = comment?.body ?? '';
        if (issue?.pull_request && (/@vigil\b/i.test(body) || body.trim().startsWith('/vigil'))) {
          await queue.enqueue('chat.github_comment', {
            repo: repoInfo?.full_name, number: issue.number, body, author: comment?.user?.login ?? 'unknown',
          }, { dedupeKey: `ghcomment:${(comment as { id?: number } | undefined)?.id ?? Date.now()}` });
        }
      }
      if (event === 'issues' && action === 'opened') {
        const issue = payload.issue as { number?: number; title?: string; body?: string; labels?: { name?: string }[] } | undefined;
        if (issue && (issue.labels ?? []).some((l) => l.name === 'vigil' || l.name === 'autofix')) {
          await queue.enqueue('fix.issue', { repo: repoInfo?.full_name, number: issue.number, issue: `Issue #${issue.number}: ${issue.title}\n${issue.body ?? ''}` });
        }
      }
      res.status(202).json({ ok: true });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'github webhook failed');
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // --- Slack events webhook ------------------------------------------------------
  app.post('/webhooks/slack', async (req, res) => {
    try {
      const body = (Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body) as Record<string, unknown>;
      if (body.type === 'url_verification') {
        res.status(200).json({ challenge: body.challenge });
        return;
      }
      const event = body.event as { type?: string; channel?: string; ts?: string; thread_ts?: string; user?: string; text?: string } | undefined;
      if (event?.type === 'app_mention' || event?.type === 'message') {
        const text = event.text ?? '';
        if (event.user && text) {
          await queue.enqueue('chat.slack', {
            channel: event.channel, threadTs: event.thread_ts ?? event.ts, text, userId: event.user,
          }, { dedupeKey: `slack:${event.channel}:${event.ts}` });
        }
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'slack webhook failed');
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return app;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function verifyGithubWebhook(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  if (!secret) return next(); // no secret configured — accept (local dev)
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  if (!sig) { res.status(401).json({ error: 'missing signature' }); return; }
  const expected = 'sha256=' + createHmac('sha256', secret).update(req.body as Buffer).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'bad signature' });
}

function verifySlackWebhook(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.SLACK_SIGNING_SECRET ?? '';
  if (!secret) return next();
  const sig = req.headers['x-slack-signature'] as string | undefined;
  const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
  if (!sig || !ts) { res.status(401).json({ error: 'missing signature' }); return; }
  // replay protection: 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) { res.status(401).json({ error: 'stale request' }); return; }
  if (verifySlackSignature(secret, ts, sig, req.body as Buffer)) return next();
  res.status(401).json({ error: 'bad signature' });
}

// ---------------------------------------------------------------------------
// view-model builders

async function buildOverviewVM(db: PrismaClient): Promise<OverviewVM> {
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const [reviews, findingsAgg, runsAgg, fixAgg, repos, recentReviews, recentRuns, connectors, automations] = await Promise.all([
    db.review.count(),
    db.finding.count(),
    db.run.aggregate({ _sum: { costUsd: true, wallMs: true }, _count: true }),
    db.fixRun.findMany({ select: { status: true, prUrl: true } }),
    db.repo.findMany({ orderBy: { updatedAt: 'desc' }, take: 20 }),
    db.review.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { pull: { include: { repo: true } } } }),
    db.run.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { _count: { select: { steps: true } } } }),
    connectorsHealth(),
    db.automation.findMany({ take: 20 }),
  ]);
  const critical = await db.finding.count({ where: { severity: 'critical' } });
  const high = await db.finding.count({ where: { severity: 'high' } });

  const repoRows = await Promise.all(
    repos.map(async (r) => {
      const reviews30 = await db.review.count({ where: { pull: { repoId: r.id }, createdAt: { gte: since30 } } });
      const critical30 = await db.finding.count({ where: { severity: 'critical', review: { pull: { repoId: r.id } }, createdAt: { gte: since30 } } });
      const high30 = await db.finding.count({ where: { severity: 'high', review: { pull: { repoId: r.id } }, createdAt: { gte: since30 } } });
      const openPulls = await db.pull.count({ where: { repoId: r.id, state: 'open' } });
      const lastReview = await db.review.findFirst({ where: { pull: { repoId: r.id } }, orderBy: { createdAt: 'desc' } });
      return {
        id: r.id, name: `${r.owner}/${r.name}`, provider: r.provider, openPulls, reviews30d: reviews30,
        critical30d: critical30, high30d: high30, lastReviewAt: lastReview?.createdAt?.toISOString(),
      };
    }),
  );

  return {
    totals: {
      reviews,
      findings: findingsAgg,
      critical,
      high,
      runs: runsAgg._count,
      costUsd: runsAgg._sum.costUsd ?? 0,
      activeMinutes: Math.round((runsAgg._sum.wallMs ?? 0) / 60000),
      fixRuns: fixAgg.length,
      fixPrs: fixAgg.filter((f) => f.prUrl).length,
    },
    repos: repoRows,
    recentReviews: recentReviews.map((r) => ({
      id: r.id, repo: `${r.pull.repo.owner}/${r.pull.repo.name}`, pr: r.pull.number, title: r.pull.title,
      risk: r.riskScore, findings: r.findingsCount, critical: r.criticalCount, high: r.highCount,
      llmUsed: r.llmUsed, at: r.createdAt.toISOString(), url: r.postedUrl ?? undefined,
    })),
    recentRuns: recentRuns.map((r) => ({
      id: r.id, kind: r.kind, goal: r.goal.slice(0, 80), status: r.status, costUsd: r.costUsd,
      wallMs: r.wallMs, steps: (r as unknown as { _count?: { steps?: number } })._count?.steps ?? 0,
      channel: r.channelKey ?? '-', at: r.createdAt.toISOString(),
    })),
    connectors,
    automations: automations.map((a) => ({ name: a.name, kind: a.kind, expr: a.expr ?? '', enabled: a.enabled, lastRunAt: a.lastRunAt?.toISOString() })),
  };
}

async function buildReviewDetailVM(db: PrismaClient, id: string): Promise<ReviewDetailVM | null> {
  const r = await db.review.findUnique({ where: { id }, include: { findings: true, pull: { include: { repo: true } } } });
  if (!r) return null;
  const similar = await db.finding.findMany({
    where: { ruleId: { in: r.findings.map((f) => f.ruleId).filter((x): x is string => !!x).slice(0, 5) }, reviewId: { not: r.id }, review: { pull: { repoId: r.pull.repoId } } },
    orderBy: { createdAt: 'desc' }, take: 5, include: { review: { include: { pull: true } } },
  });
  const learnings = await db.knowledgeItem.findMany({
    where: { scopeKey: { in: ['team:global', `channel:${r.pull.repo.owner}/${r.pull.repo.name}`] } },
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: 5,
  });
  return {
    review: {
      id: r.id, repo: `${r.pull.repo.owner}/${r.pull.repo.name}`, pr: r.pull.number, title: r.pull.title,
      risk: r.riskScore, findings: r.findingsCount, critical: r.criticalCount, high: r.highCount,
      llmUsed: r.llmUsed, at: r.createdAt.toISOString(), url: r.postedUrl ?? undefined,
    },
    repo: `${r.pull.repo.owner}/${r.pull.repo.name}`,
    headSha: r.headSha, status: r.status, risk: r.riskScore, walkthrough: r.walkthrough ?? '', summary: r.summary,
    llmUsed: r.llmUsed,
    similarFindings: similar.map((s) => ({ path: s.path, message: s.message.slice(0, 150), prNumber: s.review.pull.number, when: s.createdAt.toISOString() })),
    learnings: learnings.map((l) => `[${l.kind}] ${l.title}: ${l.body.slice(0, 200)}`),
    findings: r.findings.map((f) => ({
      id: f.id, severity: f.severity, category: f.category, source: f.source, path: f.path, line: f.line,
      message: f.message, suggestion: f.suggestion ?? undefined, confidence: f.confidence,
    })),
  };
}

async function buildConsoleVM(db: PrismaClient): Promise<ConsoleVM> {
  const threads = await db.conversation.findMany({ orderBy: { updatedAt: 'desc' }, take: 30, include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  return {
    threads: threads.map((t) => ({
      id: t.id, channelKey: t.channelKey, title: t.title ?? undefined, updatedAt: t.updatedAt.toISOString(),
      lastMessage: t.messages[0]?.body.slice(0, 60) ?? '',
    })),
  };
}

async function buildThreadVM(db: PrismaClient, id: string): Promise<ConsoleThreadVM | null> {
  const t = await db.conversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } } });
  if (!t) return null;
  return {
    id: t.id, channelKey: t.channelKey, title: t.title ?? undefined, updatedAt: t.updatedAt.toISOString(),
    messages: t.messages.map((m) => ({ role: m.role, author: m.authorId ?? undefined, body: m.body, at: m.createdAt.toISOString() })),
  };
}

async function buildJobsVM(db: PrismaClient): Promise<JobsVM> {
  const jobs = await db.job.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return {
    jobs: jobs.map((j) => ({
      id: j.id, type: j.type, status: j.status, attempts: j.attempts, runAt: j.runAt.toISOString(),
      lastError: j.lastError ?? undefined, payload: JSON.stringify(j.payload).slice(0, 120),
    })),
  };
}

async function buildUsageVM(db: PrismaClient): Promise<UsageVM> {
  const since = new Date(Date.now() - 14 * 86400_000);
  const runs = await db.run.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
  const steps = await db.runStep.findMany({ where: { run: { createdAt: { gte: since } } }, take: 5000 });
  const dayMap = new Map<string, { runs: number; costUsd: number; minutes: number; promptTokens: number; completionTokens: number }>();
  for (const r of runs) {
    const day = r.createdAt.toISOString().slice(0, 10);
    const cur = dayMap.get(day) ?? { runs: 0, costUsd: 0, minutes: 0, promptTokens: 0, completionTokens: 0 };
    cur.runs++; cur.costUsd += r.costUsd; cur.minutes += r.wallMs / 60000; cur.promptTokens += r.promptTokens; cur.completionTokens += r.completionTokens;
    dayMap.set(day, cur);
  }
  const kindMap = new Map<string, { runs: number; costUsd: number; minutes: number }>();
  for (const r of runs) {
    const cur = kindMap.get(r.kind) ?? { runs: 0, costUsd: 0, minutes: 0 };
    cur.runs++; cur.costUsd += r.costUsd; cur.minutes += r.wallMs / 60000;
    kindMap.set(r.kind, cur);
  }
  const stepMap = new Map<string, { kind: string; calls: number; costUsd: number; totalMs: number }>();
  for (const s of steps) {
    const key = s.name;
    const cur = stepMap.get(key) ?? { kind: s.kind, calls: 0, costUsd: 0, totalMs: 0 };
    cur.calls++; cur.costUsd += s.costUsd; cur.totalMs += s.durationMs;
    stepMap.set(key, cur);
  }
  return {
    days: Array.from(dayMap.entries()).map(([day, v]) => ({ day, runs: v.runs, costUsd: v.costUsd, minutes: Math.round(v.minutes * 10) / 10, promptTokens: v.promptTokens, completionTokens: v.completionTokens })),
    byKind: Array.from(kindMap.entries()).map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    topSteps: Array.from(stepMap.entries()).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.costUsd - a.costUsd).slice(0, 15),
  };
}

async function buildRunDetailVM(db: PrismaClient, id: string): Promise<RunDetailVM | null> {
  const r = await db.run.findUnique({ where: { id }, include: { steps: { orderBy: { seq: 'asc' } }, conversation: true } });
  if (!r) return null;
  return {
    run: {
      id: r.id, kind: r.kind, goal: r.goal.slice(0, 80), status: r.status, costUsd: r.costUsd, wallMs: r.wallMs,
      steps: r.steps.length, channel: r.channelKey ?? '-', at: r.createdAt.toISOString(),
    },
    goal: r.goal,
    steps: r.steps.map((s) => ({
      seq: s.seq, kind: s.kind, name: s.name, ok: s.ok, durationMs: s.durationMs, tokensIn: s.tokensIn,
      tokensOut: s.tokensOut, costUsd: s.costUsd, detail: JSON.stringify(s.detail ?? {}).slice(0, 100),
    })),
  };
}
