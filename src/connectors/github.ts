// GitHub connector — the primary VCS surface: PRs, reviews, issues, contents, branches.
import { Octokit } from '@octokit/rest';
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errConnectorNotConfigured, errUnknownAction } from './types.js';

export const ENV_VARS = ['GITHUB_TOKEN', 'GITHUB_API_BASE'];

interface Args { [k: string]: unknown }

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`github: missing required string arg "${key}"`);
  return v;
}
function num(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`github: missing required number arg "${key}"`);
  return v;
}

export function createGithubConnector(): Connector {
  const token = process.env.GITHUB_TOKEN ?? '';
  const apiBase = process.env.GITHUB_API_BASE ?? '';
  const octokit = (): Octokit => {
    if (!token) throw errConnectorNotConfigured('github');
    return new Octokit({ auth: token, ...(apiBase ? { baseUrl: apiBase } : {}), request: { timeout: 20000 } });
  };
  const wrap = async <T>(p: Promise<T>): Promise<T> => p.catch((e: unknown) => { throw new Error('github: ' + (e as Error).message); });

  return {
    id: 'github',
    label: 'GitHub',
    capabilities: ['context', 'listOpenPrs', 'getPr', 'getPrFiles', 'commentPr', 'createPrReview', 'openPr', 'createBranch', 'updateFile', 'createFile', 'listIssues', 'getIssue', 'createIssue', 'commentIssue', 'getRepoContent', 'mergePr'],
    isConfigured: () => !!token,

    async fetchContext(q: ConnectorQuery): Promise<ContextItem[]> {
      if (!token) throw errConnectorNotConfigured('github');
      const limit = Math.min(Math.max(q.limit ?? 10, 1), 50);
      const text = q.text?.trim();
      // Without a target (owner/repo or user) there is nothing sensible to list — see docs.
      if (!text) return [];
      const ok = await octokit();
      if (/^[\w.-]+\/[\w.-]+$/.test(text)) {
        const [owner, repo] = text.split('/');
        const prs = await wrap(ok.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open', sort: 'updated', direction: 'desc', per_page: limit }));
        return (prs.data as { number: number; title: string; body?: string | null; html_url: string; updated_at: string; user?: { login?: string } }[]).map((p) => ({
          id: `pr_${p.number}`,
          source: 'github',
          kind: 'pr',
          title: `#${p.number} ${p.title}`,
          body: p.body ?? undefined,
          url: p.html_url,
          at: p.updated_at,
          meta: { author: p.user?.login, repo: `${owner}/${repo}` },
        }));
      }
      const repos = await wrap(ok.request('GET /users/{username}/repos', { username: text, sort: 'pushed', per_page: limit }));
      return (repos.data as { id: number; full_name: string; description?: string | null; html_url: string; pushed_at: string }[]).map((r) => ({
        id: `repo_${r.id}`,
        source: 'github',
        kind: 'repo',
        title: r.full_name,
        body: r.description ?? undefined,
        url: r.html_url,
        at: r.pushed_at,
      }));
    },

    async runAction(name: string, args: Args): Promise<unknown> {
      if (!token) throw errConnectorNotConfigured('github');
      const ok = await octokit();
      switch (name) {
        case 'listOpenPrs': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('GET /repos/{owner}/{repo}/pulls', { owner, repo: r, state: 'open', sort: 'updated', direction: 'desc', per_page: 50 }));
          return res.data;
        }
        case 'getPr': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo: r, pull_number: num(args, 'number') }));
          return res.data;
        }
        case 'getPrFiles': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const pr = num(args, 'number');
          const files: unknown[] = [];
          let page = 1;
          while (files.length < 300) {
            const res = await wrap(ok.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo: r, pull_number: pr, per_page: 100, page }));
            files.push(...(res.data as unknown[]));
            if ((res.data as unknown[]).length < 100) break;
            page++;
          }
          return files;
        }
        case 'commentPr': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo: r, issue_number: num(args, 'number'), body: str(args, 'body') }));
          return res.data;
        }
        case 'createPrReview': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const event = (typeof args.event === 'string' ? args.event : 'COMMENT') as 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
          const body = str(args, 'body');
          const comments = Array.isArray(args.comments) ? (args.comments as { path: string; line?: number; start_line?: number; side?: string; body: string }[]).map((c) => ({
            path: c.path, line: c.line ?? c.start_line ?? 1, side: 'RIGHT' as const, body: c.body,
          })) : undefined;
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
            owner, repo: r, pull_number: num(args, 'number'), event, body, ...(comments ? { comments } : {}),
          }));
          return res.data;
        }
        case 'openPr': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/pulls', {
            owner, repo: r, title: str(args, 'title'), head: str(args, 'head'), base: str(args, 'base'), body: typeof args.body === 'string' ? args.body : '',
          }));
          return res.data;
        }
        case 'createBranch': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const branch = str(args, 'branch'); const from = typeof args.from === 'string' && args.from ? args.from : 'main';
          const ref = await wrap(ok.request('GET /repos/{owner}/{repo}/git/ref/heads/{ref}', { owner, repo: r, ref: from }));
          const sha = (ref.data as { object: { sha: string } }).object.sha;
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/git/refs', { owner, repo: r, ref: `refs/heads/${branch}`, sha }));
          return res.data;
        }
        case 'updateFile':
        case 'createFile': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const path = str(args, 'path'); const branch = str(args, 'branch');
          const content = str(args, 'content'); const message = str(args, 'message');
          let sha: string | undefined;
          if (name === 'updateFile' && args.sha === undefined) {
            try {
              const cur = await wrap(ok.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo: r, path, ref: branch }));
              sha = (cur.data as { sha?: string }).sha;
            } catch { sha = undefined; }
          } else if (typeof args.sha === 'string') {
            sha = args.sha;
          }
          const res = await wrap(ok.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner, repo: r, path, branch, message, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}),
          }));
          return res.data;
        }
        case 'listIssues': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const state = (typeof args.state === 'string' && ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open') as 'open' | 'closed' | 'all';
          const labels = typeof args.labels === 'string' ? args.labels : undefined;
          const res = await wrap(ok.request('GET /repos/{owner}/{repo}/issues', { owner, repo: r, state, labels, per_page: 50 }));
          return (res.data as { pull_request?: unknown }[]).filter((i) => !i.pull_request);
        }
        case 'getIssue': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo: r, issue_number: num(args, 'number') }));
          return res.data;
        }
        case 'createIssue': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/issues', {
            owner, repo: r, title: str(args, 'title'), body: typeof args.body === 'string' ? args.body : '', ...(Array.isArray(args.labels) ? { labels: args.labels as string[] } : {}),
          }));
          return res.data;
        }
        case 'commentIssue': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const res = await wrap(ok.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo: r, issue_number: num(args, 'number'), body: str(args, 'body') }));
          return res.data;
        }
        case 'getRepoContent': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const path = typeof args.path === 'string' ? args.path : '';
          const ref = typeof args.ref === 'string' ? args.ref : undefined;
          const res = await wrap(ok.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo: r, path, ...(ref ? { ref } : {}) }));
          const data = res.data as { type?: string; content?: string; encoding?: string } | { type?: string }[];
          if (Array.isArray(data)) return data;
          if (data.type === 'file' && data.content && data.encoding === 'base64') {
            return { ...data, content: Buffer.from(data.content, 'base64').toString('utf8'), decoded: true };
          }
          return data;
        }
        case 'mergePr': {
          const repo = str(args, 'repo'); const [owner, r] = repo.split('/');
          const method = (typeof args.method === 'string' && ['squash', 'merge', 'rebase'].includes(args.method) ? args.method : 'squash') as 'squash' | 'merge' | 'rebase';
          const res = await wrap(ok.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { owner, repo: r, pull_number: num(args, 'number'), merge_method: method }));
          return res.data;
        }
        default:
          throw errUnknownAction('github', name);
      }
    },

    async health() {
      if (!token) return { ok: false, detail: 'GITHUB_TOKEN not set' };
      try {
        await wrap(octokit().request('GET /user'));
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
