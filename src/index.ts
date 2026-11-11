#!/usr/bin/env node
// Vigil CLI: serve (daemon), review, fix, ask, scan, config, memory, automations.
import './core/env.js'; // load .env before anything reads process.env
import { Command } from 'commander';
import { PrismaClient } from '@prisma/client';
import { startDaemon } from './daemon.js';
import { buildApp } from './server.js';
import { ReviewEngine, scanWorkingTree } from './review/engine.js';
import { FixEngine } from './fix/engine.js';
import { ChatAgent } from './chat/agent.js';
import { Queue } from './core/queue.js';
import { loadConfigFile } from './core/config.js';
import { llm, llmConfigured } from './core/llm.js';
import { ensureDefaultScope } from './core/db.js';
import { connectorsHealth } from './connectors/registry.js';
import { SKILL_LIST } from './chat/skills.js';
import { logger } from './core/logger.js';

const program = new Command();
program.name('vigil').description('Self-hosted AI engineer for your whole SDLC').version('0.1.0');

function getDb(): PrismaClient {
  return new PrismaClient({ log: ['error'] });
}

program
  .command('serve')
  .description('Run the full daemon: queue workers, cron automations, GitHub polling, dashboard')
  .option('-p, --port <port>', 'HTTP port', process.env.PORT ?? '8080')
  .action(async (opts: { port: string }) => {
    const { stop } = await startDaemon({ withServer: true, port: parseInt(opts.port, 10) });
    const shutdown = () => { stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('dashboard')
  .description('Run only the dashboard/API server (no workers)')
  .option('-p, --port <port>', 'HTTP port', process.env.PORT ?? '8080')
  .action(async (opts: { port: string }) => {
    const db = getDb();
    await ensureDefaultScope().catch(() => {});
    const queue = new Queue(db);
    const agent = new ChatAgent(db, loadConfigFile('.vigil.yml'));
    const app = buildApp({ db, queue, agent });
    const port = parseInt(opts.port, 10);
    app.listen(port, () => console.log(`vigil dashboard on http://localhost:${port}`));
  });

program
  .command('review <repo> <pr>')
  .description('Review a GitHub pull request (owner/name + PR number)')
  .option('--dry-run', 'Do not post anything to GitHub')
  .action(async (repo: string, pr: string, opts: { dryRun?: boolean }) => {
    const db = getDb();
    try {
      const engine = new ReviewEngine(db, loadConfigFile('.vigil.yml'));
      const res = await engine.review({ repo, number: parseInt(pr, 10), dryRun: opts.dryRun });
      console.log(res.report);
      console.log(`\n--- risk ${res.riskScore}/100 · ${res.findings.length} findings · llm=${res.llmUsed}${res.postedUrl ? ` · ${res.postedUrl}` : ''}`);
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('fix <repo>')
  .description('Autonomously fix an issue: branch, patch, sandbox-verify, open PR')
  .argument('<issue...>', 'Issue description (or "owner/repo#123" for a GitHub issue)')
  .option('--base <branch>', 'Base branch', 'main')
  .option('--verify <cmd>', 'Verification command (default from .vigil.yml)')
  .option('--dry-run', 'Do not push or open a PR')
  .option('--max-iterations <n>', 'Max agent iterations', '3')
  .action(async (repo: string, issueArgs: string[], opts: { base?: string; verify?: string; dryRun?: boolean; maxIterations?: string }) => {
    const db = getDb();
    try {
      let issue = issueArgs.join(' ');
      const github = (await import('./connectors/registry.js')).buildRegistry().get('github')!;
      const m = issue.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
      if (m) {
        // fetch the GitHub issue body
        const ghIssue = (await github.runAction('getIssue', { repo: m[1], number: parseInt(m[2], 10) })) as { title: string; body?: string };
        issue = `Issue #${m[2]}: ${ghIssue.title}\n\n${ghIssue.body ?? ''}`;
      }
      const engine = new FixEngine(db, loadConfigFile('.vigil.yml'));
      const res = await engine.fix({
        repo, issue, baseBranch: opts.base, verifyCommand: opts.verify,
        dryRun: opts.dryRun, maxIterations: parseInt(opts.maxIterations ?? '3', 10),
      });
      console.log(`status: ${res.status}${res.prUrl ? `\nPR: ${res.prUrl}` : ''}`);
      console.log(res.log.join('\n'));
      process.exitCode = res.status === 'failed' ? 1 : 0;
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('ask [text...]')
  .description('Chat with the agent (console channel). Pipe stdin or pass text.')
  .action(async (textParts: string[]) => {
    const db = getDb();
    try {
      let text = textParts.join(' ').trim();
      if (!text && !process.stdin.isTTY) {
        text = await new Promise<string>((resolve_) => {
          let buf = '';
          process.stdin.on('data', (d) => (buf += d));
          process.stdin.on('end', () => resolve_(buf.trim()));
        });
      }
      if (!text) { console.error('provide text or pipe stdin'); process.exitCode = 1; return; }
      const agent = new ChatAgent(db, loadConfigFile('.vigil.yml'));
      const res = await agent.handle({ text, channelKey: 'console:default', channel: 'console' });
      console.log(res.reply);
      console.error(`\n[run ${res.runId} · $${res.costUsd.toFixed(4)} · ${(res.wallMs / 1000).toFixed(1)}s]`);
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('scan [dir]')
  .description('Scan a working tree diff (vs HEAD) with heuristics — no PR needed')
  .action(async (dir = '.') => {
    const db = getDb();
    try {
      const findings = await scanWorkingTree(dir, db);
      if (findings.length === 0) { console.log('No findings.'); return; }
      for (const f of findings) {
        console.log(`${f.severity.toUpperCase().padEnd(8)} ${f.path}:${f.line} — ${f.message}`);
      }
      process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('skill <id>')
  .description(`Run a built-in skill: ${SKILL_LIST.map((s) => s.id).join(', ')}`)
  .option('--args <json>', 'JSON args for the skill', '{}')
  .action(async (id: string, opts: { args: string }) => {
    const db = getDb();
    try {
      const skill = SKILL_LIST.find((s) => s.id === id);
      if (!skill) { console.error(`unknown skill "${id}"`); process.exitCode = 1; return; }
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(opts.args); } catch { console.error('--args must be valid JSON'); process.exitCode = 1; return; }
      const out = await skill.run({ db, cfg: loadConfigFile('.vigil.yml') }, args);
      console.log((out as { report?: string }).report ?? JSON.stringify(out, null, 2));
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('memory')
  .description('List / add team knowledge')
  .option('--add <title>', 'Add a knowledge item')
  .option('--body <body>', 'Body for --add')
  .option('--kind <kind>', 'fact|decision|runbook|preference', 'fact')
  .option('--forget <id>', 'Delete an item by id')
  .action(async (opts: { add?: string; body?: string; kind?: string; forget?: string }) => {
    const db = getDb();
    try {
      if (opts.forget) {
        const ok = await db.knowledgeItem.deleteMany({ where: { id: opts.forget } });
        console.log(ok.count > 0 ? 'deleted' : 'not found');
        return;
      }
      if (opts.add) {
        if (!opts.body) { console.error('--body required with --add'); process.exitCode = 1; return; }
        const item = await db.knowledgeItem.create({
          data: { kind: opts.kind ?? 'fact', title: opts.add, body: opts.body, scope: 'team', scopeKey: 'team:global' },
        });
        console.log(`saved ${item.id}`);
        return;
      }
      const items = await db.knowledgeItem.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 });
      for (const i of items) console.log(`${i.pinned ? '*' : ' '} [${i.scope}/${i.kind}] ${i.title}\n    ${i.body.slice(0, 160)}\n    (${i.id})`);
    } finally {
      await db.$disconnect();
    }
  });

program
  .command('doctor')
  .description('Check configuration health: DB, LLM, connectors')
  .action(async () => {
    const db = getDb();
    try {
      await db.$queryRaw`SELECT 1`;
      console.log('database: OK');
    } catch (e) {
      console.log(`database: FAIL — ${(e as Error).message}`);
    }
    console.log(`llm: ${llmConfigured() ? `OK (${llm.provider}/${llm.model})` : 'not configured (heuristics still work)'}`);
    const health = await connectorsHealth();
    for (const c of health) {
      console.log(`connector ${c.id}: ${c.configured ? (c.ok ? 'OK' : 'ERROR') : 'not configured'}`);
    }
    await db.$disconnect().catch(() => {});
  });

program
  .command('automations')
  .description('List cron automations')
  .action(async () => {
    const db = getDb();
    try {
      const autos = await db.automation.findMany({ orderBy: { name: 'asc' } });
      if (autos.length === 0) { console.log('no automations (start the daemon to sync config automations)'); return; }
      for (const a of autos) {
        console.log(`${a.enabled ? '[on] ' : '[off]'} ${a.name} (${a.kind}${a.expr ? ` ${a.expr}` : ''}) → ${a.channelKey ?? '-'}${a.lastRunAt ? ` · last ${a.lastRunAt.toISOString()}` : ''}`);
      }
    } finally {
      await db.$disconnect();
    }
  });

program.parseAsync().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
