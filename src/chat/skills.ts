// Built-in skills: standup, stale-prs, postmortem, debug — the "Triggers &
// Automations" and incident workflows, callable from chat and cron automations.
import type { PrismaClient, Pull } from '@prisma/client';
import type { VigilConfig } from '../core/config.js';
import { llm, llmConfigured } from '../core/llm.js';
import { buildStandupReport, buildPostmortem, type PostmortemInput } from '../analysis/report.js';
import type { StandupData } from '../analysis/types.js';
import { buildRegistry } from '../connectors/registry.js';
import { DEFAULT_CONFIG } from '../core/config.js';

export interface SkillContext {
  db: PrismaClient;
  cfg: VigilConfig;
}

export interface SkillDef {
  id: string;
  description: string;
  run(ctx: SkillContext, args: Record<string, unknown>): Promise<unknown>;
}

export const SKILL_LIST: SkillDef[] = [
  {
    id: 'standup',
    description: 'Build a daily standup digest: merges, stale PRs, alerts from monitoring, deploys. Args: {repos?: string[], sinceHours?: number}',
    async run(ctx, args) {
      const sinceHours = typeof args.sinceHours === 'number' ? args.sinceHours : 24;
      const since = new Date(Date.now() - sinceHours * 3600_000);
      const repos = (Array.isArray(args.repos) ? args.repos : typeof args.repos === 'string' ? [args.repos] : reposFromEnvOrDb(ctx)).filter(
        (r: unknown): r is string => typeof r === 'string' && r.length > 0,
      );

      const github = buildRegistry().get('github')!;
      const data: StandupData = { since: since.toISOString(), merges: [], stale: [], alerts: [], deploys: [] };

      if (github.isConfigured()) {
        for (const repo of repos.slice(0, 5)) {
          try {
            const prs = (await github.runAction('listOpenPrs', { repo })) as { number: number; title: string; updated_at: string; user?: { login?: string } }[];
            for (const pr of prs) {
              const idleHours = Math.floor((Date.now() - new Date(pr.updated_at).getTime()) / 3600_000);
              if (idleHours >= 24) data.stale.push({ repo, number: pr.number, title: pr.title, idleHours, author: pr.user?.login });
            }
            const closed = (await github.runAction('listPrs', { repo, state: 'closed' })) as { number: number; title: string; merged_at: string | null; user?: { login?: string } }[];
            for (const pr of closed) {
              if (pr.merged_at && new Date(pr.merged_at).getTime() >= since.getTime()) {
                data.merges.push({ repo, title: pr.title, author: pr.user?.login ?? 'unknown', number: pr.number });
              }
            }
          } catch { /* repo inaccessible */ }
        }
      }

      // alerts from configured monitoring connectors
      const registry = buildRegistry();
      for (const id of ['sentry', 'datadog', 'pagerduty']) {
        const c = registry.get(id);
        if (!c?.isConfigured()) continue;
        try {
          const items = await c.fetchContext({ since, limit: 5 });
          for (const item of items) {
            data.alerts.push({ source: id, title: item.title, when: item.at ?? since.toISOString(), url: item.url });
          }
        } catch { /* connector error — skip */ }
      }

      const report = buildStandupReport(data);
      return { report, data };
    },
  },
  {
    id: 'stale-prs',
    description: 'Find pull requests idle for more than N hours. Args: {repos?: string[], idleHours?: number}',
    async run(ctx, args) {
      const idleHours = typeof args.idleHours === 'number' ? args.idleHours : 24;
      const repos = (Array.isArray(args.repos) ? args.repos : typeof args.repos === 'string' ? [args.repos] : reposFromEnvOrDb(ctx)).filter(
        (r: unknown): r is string => typeof r === 'string' && r.length > 0,
      );
      const github = buildRegistry().get('github')!;
      const stale: { repo: string; number: number; title: string; idleHours: number; author?: string; url?: string }[] = [];
      if (github.isConfigured()) {
        for (const repo of repos.slice(0, 10)) {
          try {
            const prs = (await github.runAction('listOpenPrs', { repo })) as { number: number; title: string; updated_at: string; html_url: string; user?: { login?: string } }[];
            for (const pr of prs) {
              const idle = Math.floor((Date.now() - new Date(pr.updated_at).getTime()) / 3600_000);
              if (idle >= idleHours) stale.push({ repo, number: pr.number, title: pr.title, idleHours: idle, author: pr.user?.login, url: pr.html_url });
            }
          } catch { /* skip */ }
        }
      }
      const report = stale.length === 0
        ? `No stale PRs (idle > ${idleHours}h).`
        : `## Stale PRs (idle > ${idleHours}h)\n` + stale.map((s) => `- ${s.repo}#${s.number} idle ${s.idleHours}h — ${s.title}${s.author ? ` · @${s.author}` : ''}`).join('\n');
      return { report, stale };
    },
  },
  {
    id: 'postmortem',
    description: 'Draft a postmortem from an incident description and optionally file it (Linear/Jira/Notion). Args: {title, severity, context, postTo?: "linear"|"jira"|"notion", teamId? (linear), project? (jira), parentPageId? (notion)}',
    async run(_ctx, args) {
      const title = String(args.title ?? 'Incident');
      const severity = String(args.severity ?? 'SEV-3');
      const context = String(args.context ?? args.description ?? '');
      if (!context) throw new Error('postmortem skill: provide incident context');

      let input: PostmortemInput;
      if (llmConfigured()) {
        const res = await llm.chat([
          { role: 'system', content: 'You are Vigil, an SRE lead writing an incident postmortem. Respond with STRICT JSON only: {"rootCause": "...", "impact": "...", "timeline": [{"at": "HH:MM", "text": "..."}], "remediation": ["..."], "links": [{"label": "...", "url": "..."}]}. Derive everything from the incident description; mark unknowns as "to be confirmed".' },
          { role: 'user', content: `Incident: ${title}\nSeverity: ${severity}\n\nDescription/observations:\n${context}` },
        ], undefined, { temperature: 0.2 });
        try {
          const parsed = JSON.parse(res.content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')) as Partial<PostmortemInput>;
          input = {
            title, severity,
            rootCause: String(parsed.rootCause ?? 'to be confirmed'),
            impact: String(parsed.impact ?? 'to be confirmed'),
            timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map((t) => ({ at: String(t.at ?? ''), text: String(t.text ?? '') })) : [],
            remediation: Array.isArray(parsed.remediation) ? parsed.remediation.map(String) : [],
            relatedLinks: Array.isArray((parsed as Record<string, unknown>).links) ? ((parsed as Record<string, unknown>).links as { label?: unknown; url?: unknown }[]).map((l) => ({ label: String(l.label ?? 'link'), url: String(l.url ?? '') })).filter((l) => l.url) : [],
          };
        } catch {
          input = fallbackPostmortem(title, severity, context);
        }
      } else {
        input = fallbackPostmortem(title, severity, context);
      }

      const markdown = buildPostmortem(input);
      const postTo = String(args.postTo ?? '');
      let filed: { where: string; url?: string } | null = null;
      if (postTo) {
        const registry = buildRegistry();
        const c = registry.get(postTo);
        if (!c?.isConfigured()) throw new Error(`postmortem skill: connector "${postTo}" not configured`);
        if (postTo === 'linear') {
          const teamId = String(args.teamId ?? '');
          if (!teamId) throw new Error('postmortem skill: linear requires teamId arg');
          const r = (await c.runAction('createIssue', { teamId, title: `[${severity}] ${title}`, description: markdown })) as { issue?: { url?: string } };
          filed = { where: 'linear', url: r?.issue?.url };
        } else if (postTo === 'jira') {
          const project = String(args.project ?? '');
          if (!project) throw new Error('postmortem skill: jira requires project arg');
          const r = (await c.runAction('createIssue', { project, summary: `[${severity}] ${title}`, description: markdown })) as { key?: string; html_url?: string };
          filed = { where: `jira ${r.key ?? ''}`, url: (r as { html_url?: string }).html_url };
        } else if (postTo === 'notion') {
          const parentPageId = String(args.parentPageId ?? '');
          if (!parentPageId) throw new Error('postmortem skill: notion requires parentPageId arg');
          const r = (await c.runAction('createPage', { parentPageId, title: `[${severity}] ${title}`, markdown })) as { url?: string };
          filed = { where: 'notion', url: r?.url };
        }
      }
      return { markdown, filed };
    },
  },
  {
    id: 'debug',
    description: 'Investigate an error/issue: correlate monitoring alerts with recent PRs and repo code, propose root cause. Args: {query, repo?, sinceHours?}',
    async run(_ctx, args) {
      const query = String(args.query ?? args.description ?? '');
      if (!query) throw new Error('debug skill: provide a query describing the failure');
      const sinceHours = typeof args.sinceHours === 'number' ? args.sinceHours : 48;
      const since = new Date(Date.now() - sinceHours * 3600_000);
      const registry = buildRegistry();
      const github = registry.get('github')!;

      // 1) alerts matching the query
      const alerts: { source: string; title: string; url?: string; at?: string; body?: string }[] = [];
      for (const id of ['sentry', 'datadog', 'pagerduty']) {
        const c = registry.get(id);
        if (!c?.isConfigured()) continue;
        try {
          const items = await c.fetchContext({ since, limit: 5, text: query.split(/\s+/).slice(0, 3).join(' ') });
          alerts.push(...items.map((i) => ({ source: id, title: i.title, url: i.url, at: i.at, body: i.body?.slice(0, 500) })));
        } catch { /* skip */ }
      }

      // 2) recently updated PRs on the named repo (or first alert's repo if inferable)
      const repo = typeof args.repo === 'string' ? args.repo : inferRepo(alerts) ?? reposFromEnv({ cfg: DEFAULT_CONFIG })[0];
      const recentPrs: { repo: string; number: number; title: string; url?: string; updatedAt?: string }[] = [];
      if (github.isConfigured() && repo) {
        try {
          const prs = (await github.runAction('listOpenPrs', { repo })) as { number: number; title: string; html_url: string; updated_at: string }[];
          recentPrs.push(...prs.slice(0, 10).map((p) => ({ repo, number: p.number, title: p.title, url: p.html_url, updatedAt: p.updated_at })));
        } catch { /* skip */ }
      }

      if (!llmConfigured()) {
        return {
          report: `## Debug: ${query}\n\n### Matching alerts\n${alerts.map((a) => `- [${a.source}] ${a.title} (${a.at ?? ''})`).join('\n') || '(none found)'}\n\n### Recently updated PRs on ${repo ?? '(unknown repo)'}\n${recentPrs.map((p) => `- #${p.number} ${p.title}`).join('\n') || '(none)'}\n\n(Configure an LLM provider for automated root-cause correlation.)`,
          alerts, recentPrs,
        };
      }

      const res = await llm.chat([
        { role: 'system', content: 'You are Vigil, an incident investigator. Correlate monitoring alerts with recent code changes to find the root cause. Respond in markdown with sections: ## Hypothesis, ## Evidence, ## Most likely root cause, ## Suggested next steps (including a possible revert PR). Be concrete; cite alert titles and PR numbers.' },
        {
          role: 'user',
          content: `Failure under investigation: ${query}\n\nMonitoring alerts:\n${JSON.stringify(alerts, null, 2)}\n\nRecently updated PRs on ${repo ?? 'unknown'}:\n${JSON.stringify(recentPrs, null, 2)}`,
        },
      ], undefined, { temperature: 0.2, maxTokens: 2000 });

      return { report: res.content, alerts, recentPrs };
    },
  },
];

export function runSkill(agent: unknown, id: string, args: Record<string, unknown>): Promise<unknown> {
  const skill = SKILL_LIST.find((s) => s.id === id);
  if (!skill) throw new Error(`unknown skill "${id}"`);
  // agent is a ChatAgent; extract db+cfg through its public shape
  const a = agent as { db?: PrismaClient; cfg?: VigilConfig };
  const ctx: SkillContext = { db: a.db as PrismaClient, cfg: a.cfg ?? DEFAULT_CONFIG };
  return skill.run(ctx, args);
}

function fallbackPostmortem(title: string, severity: string, context: string): PostmortemInput {
  return {
    title, severity,
    rootCause: 'to be confirmed — no LLM configured, template postmortem',
    impact: context.slice(0, 500),
    timeline: [{ at: new Date().toISOString().slice(11, 16), text: 'Incident reported (template entry)' }],
    remediation: ['Investigate root cause', 'Add monitoring/alerting for this failure mode', 'Document runbook'],
    relatedLinks: [],
  };
}

function reposFromEnvOrDb(ctx: SkillContext): string[] {
  return reposFromEnv(ctx);
}

function reposFromEnv(ctx: { cfg: VigilConfig }): string[] {
  const raw = process.env.REPOS ?? '';
  if (raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function inferRepo(alerts: { body?: string; title?: string }[]): string | null {
  const text = alerts.map((a) => `${a.title ?? ''} ${a.body ?? ''}`).join(' ');
  const m = text.match(/([\w.-]+\/[\w.-]+)/);
  return m ? m[1] : null;
}
