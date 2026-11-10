// Vigil dashboard — pure HTML string views over the view models in types.ts.
// No frameworks, no external assets. All user data is escaped via esc().
// Formatting conventions:
//   dates  -> new Date(x).toISOString().slice(0, 19).replace('T', ' ')
//   costs  -> '$' + n.toFixed(4)

import type {
  OverviewVM,
  ReviewDetailVM,
  ConsoleVM,
  ConsoleThreadVM,
  JobsVM,
  UsageVM,
  RunDetailVM,
} from './types.js';
import { css } from './assets.js';

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(x?: string): string {
  if (!x) return '—';
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtCost(n: number): string {
  return '$' + (Number.isFinite(n) ? n : 0).toFixed(4);
}

function fmtNum(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function badge(text: string, cls: string): string {
  return `<span class="badge badge-${cls}">${esc(text)}</span>`;
}

const SEV_CLASSES = new Set(['critical', 'high', 'medium', 'low', 'info']);

function sevBadge(sev: string): string {
  const s = sev.toLowerCase();
  return badge(sev, SEV_CLASSES.has(s) ? s : 'info');
}

function statusBadge(status: string): string {
  const s = status.toLowerCase();
  if (['done', 'success', 'succeeded', 'completed', 'ok', 'passed', 'fixed', 'merged'].includes(s)) {
    return badge(status, 'ok');
  }
  if (['failed', 'error', 'crashed', 'dead'].includes(s)) {
    return badge(status, 'danger');
  }
  if (['cancelled', 'canceled', 'timeout', 'timed_out', 'skipped'].includes(s)) {
    return badge(status, 'warn');
  }
  if (['running', 'pending', 'queued', 'in_progress', 'active', 'scheduled', 'waiting', 'retrying'].includes(s)) {
    return badge(status, 'accent');
  }
  return badge(status, 'muted');
}

function sourceTag(source: string): string {
  if (source.toLowerCase() === 'llm') return '<span class="tag">llm</span>';
  return `<span class="tag tag-heuristic">${esc(source)}</span>`;
}

function riskPct(risk: number): number {
  const r = Number.isFinite(risk) ? risk : 0;
  return Math.max(0, Math.min(100, Math.round(r)));
}

function gauge(risk: number): string {
  const num = Number.isFinite(risk) ? Math.round(risk) : 0;
  return `<span class="gauge-cell"><span class="gauge"><span class="gauge-fill" style="width:${riskPct(risk)}%"></span></span><span class="gauge-num">${num}</span></span>`;
}

function confPct(conf: number): number {
  const c = Number.isFinite(conf) ? conf : 0;
  const pct = c > 1 ? c : c * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function emptyRow(colspan: number, msg: string): string {
  return `<tr><td colspan="${colspan}" class="empty">${esc(msg)}</td></tr>`;
}

/* ------------------------------------------------------------------ */
/* Markdown-lite (headings #/##/###, bullets '-', bold **, code \`...\`) */
/* Input is escaped first, then inline spans are applied.              */
/* ------------------------------------------------------------------ */

function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function mdLite(md: string): string {
  if (!md) return '<p class="muted-cell">No content.</p>';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) {
      out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      out.push(`<ul>${list.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length + 2; // '#' -> h3, '##' -> h4, '###' -> h5
      out.push(`<h${level}>${inlineMd(esc(h[2]))}</h${level}>`);
      continue;
    }
    const b = /^\s*-\s+(.*)$/.exec(line);
    if (b) {
      flushPara();
      list.push(esc(b[1]));
      continue;
    }
    flushList();
    para.push(esc(line));
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Findings grouping                                                   */
/* ------------------------------------------------------------------ */

type FindingVM = ReviewDetailVM['findings'][number];

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function groupFindingsBySeverity(findings: FindingVM[]): Array<[string, FindingVM[]]> {
  const groups = new Map<string, FindingVM[]>();
  for (const f of findings) {
    const key = f.severity.toLowerCase();
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = SEVERITY_ORDER.indexOf(a);
    const ib = SEVERITY_ORDER.indexOf(b);
    const ra = ia === -1 ? SEVERITY_ORDER.length : ia;
    const rb = ib === -1 ? SEVERITY_ORDER.length : ib;
    return ra - rb || a.localeCompare(b);
  });
  return keys.map((k): [string, FindingVM[]] => [k, groups.get(k)!]);
}

/* ------------------------------------------------------------------ */
/* Page shell                                                          */
/* ------------------------------------------------------------------ */

const BRAND_SVG =
  '<svg class="brand-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 2l8 3v6c0 5-3.4 9.2-8 11-4.6-1.8-8-6-8-11V5l8-3z"></path>' +
  '<path d="M6.8 11c1.5-2.6 3.3-3.9 5.2-3.9s3.7 1.3 5.2 3.9c-1.5 2.6-3.3 3.9-5.2 3.9S8.3 13.6 6.8 11z"></path>' +
  '<circle cx="12" cy="11" r="2.2"></circle>' +
  '</svg>';

export function page(title: string, activeNav: string, body: string): string {
  const links: Array<[string, string]> = [
    ['Overview', '/'],
    ['Reviews', '/reviews'],
    ['Console', '/console'],
    ['Usage', '/usage'],
    ['Jobs', '/jobs'],
  ];
  const nav = links
    .map(([label, href]) => `<a href="${href}"${href === activeNav ? ' class="active"' : ''}>${label}</a>`)
    .join('\n    ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Vigil — ${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<nav class="topnav">
  <a class="brand" href="/" aria-label="Vigil home">${BRAND_SVG}<span>VIGIL</span></a>
  <div class="nav-links">
    ${nav}
  </div>
</nav>
<main class="wrap">
${body}
</main>
<footer class="footer">Vigil — self-hosted SDLC agent</footer>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export function renderOverview(vm: OverviewVM): string {
  const t = vm.totals;

  const repoRows =
    vm.repos.length > 0
      ? vm.repos
          .map(
            (r) => `
    <tr>
      <td class="wrap-cell"><strong>${esc(r.name)}</strong></td>
      <td><span class="tag tag-heuristic">${esc(r.provider)}</span></td>
      <td class="num">${fmtNum(r.openPulls)}</td>
      <td class="num">${fmtNum(r.reviews30d)}</td>
      <td class="num"><span class="sev-num danger">${fmtNum(r.critical30d)}</span> / <span class="sev-num high">${fmtNum(r.high30d)}</span></td>
      <td class="muted-cell">${fmtDate(r.lastReviewAt)}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(6, 'No repositories connected yet.');

  const reviewRows =
    vm.recentReviews.length > 0
      ? vm.recentReviews
          .map((rv) => {
            const sevBadges =
              (rv.critical > 0 ? badge(`critical ${rv.critical}`, 'critical') : '') +
              (rv.high > 0 ? badge(`high ${rv.high}`, 'high') : '') +
              (rv.critical === 0 && rv.high === 0 && rv.findings === 0 ? badge('clean', 'ok') : '');
            return `
    <tr>
      <td class="wrap-cell"><a href="/reviews/${encodeURIComponent(rv.id)}"><strong>${esc(rv.repo)}</strong>#${rv.pr}</a></td>
      <td class="wrap-cell" title="${esc(rv.title)}">${esc(trunc(rv.title, 60))}</td>
      <td>${gauge(rv.risk)}</td>
      <td class="num">${fmtNum(rv.findings)}</td>
      <td>${sevBadges || '<span class="muted-cell">—</span>'}</td>
      <td>${rv.llmUsed ? '<span class="yes">Yes</span>' : '<span class="muted-cell">No</span>'}</td>
      <td class="muted-cell">${fmtDate(rv.at)}</td>
      <td>${rv.url ? `<a href="${esc(rv.url)}" target="_blank" rel="noopener">Open</a>` : '<span class="muted-cell">—</span>'}</td>
    </tr>`;
          })
          .join('')
      : emptyRow(8, 'No reviews yet.');

  const runRows =
    vm.recentRuns.length > 0
      ? vm.recentRuns
          .map(
            (run) => `
    <tr>
      <td><span class="tag">${esc(run.kind)}</span></td>
      <td class="wrap-cell"><a href="/runs/${encodeURIComponent(run.id)}" title="${esc(run.goal)}">${esc(trunc(run.goal, 80))}</a></td>
      <td>${statusBadge(run.status)}</td>
      <td class="num mono">${fmtCost(run.costUsd)}</td>
      <td class="num">${fmtDuration(run.wallMs)}</td>
      <td class="num">${fmtNum(run.steps)}</td>
      <td class="muted-cell">${esc(run.channel)}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(7, 'No runs yet.');

  const connectorRows =
    vm.connectors.length > 0
      ? vm.connectors
          .map(
            (c) => `
    <tr>
      <td class="wrap-cell">${esc(c.label)}</td>
      <td><span class="dot ${c.configured ? 'ok' : 'off'}"></span>${c.configured ? 'Configured' : 'Not configured'}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(2, 'No connectors registered.');

  const automationRows =
    vm.automations.length > 0
      ? vm.automations
          .map(
            (a) => `
    <tr>
      <td class="wrap-cell"><strong>${esc(a.name)}</strong></td>
      <td><span class="tag">${esc(a.kind)}</span></td>
      <td><code>${esc(a.expr)}</code></td>
      <td>${a.enabled ? '<span class="yes">Enabled</span>' : '<span class="muted-cell">Disabled</span>'}</td>
      <td class="muted-cell">${fmtDate(a.lastRunAt)}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(5, 'No automations configured.');

  return `
<header class="page-head"><h1>Overview</h1></header>
<section class="tiles">
  <div class="tile"><div class="tile-label">Reviews</div><div class="tile-num">${fmtNum(t.reviews)}</div></div>
  <div class="tile"><div class="tile-label">Findings</div><div class="tile-num">${fmtNum(t.findings)}</div></div>
  <div class="tile"><div class="tile-label">Critical</div><div class="tile-num danger">${fmtNum(t.critical)}</div></div>
  <div class="tile"><div class="tile-label">High</div><div class="tile-num high">${fmtNum(t.high)}</div></div>
  <div class="tile"><div class="tile-label">Runs</div><div class="tile-num">${fmtNum(t.runs)}</div></div>
  <div class="tile"><div class="tile-label">Cost</div><div class="tile-num small accent">${fmtCost(t.costUsd)}</div></div>
  <div class="tile"><div class="tile-label">Active minutes</div><div class="tile-num">${fmtNum(t.activeMinutes)}</div></div>
  <div class="tile"><div class="tile-label">Fix runs / PRs</div><div class="tile-num">${fmtNum(t.fixRuns)} / ${fmtNum(t.fixPrs)}</div></div>
</section>
<div class="grid">
  <section class="card span-2">
    <h2>Repositories</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Repository</th><th>Provider</th><th>Open PRs</th><th>Reviews 30d</th><th>Crit / High 30d</th><th>Last review</th></tr></thead>
        <tbody>${repoRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card span-2">
    <h2>Recent reviews</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Repo#PR</th><th>Title</th><th>Risk</th><th>Findings</th><th>Severity</th><th>LLM</th><th>Time</th><th>PR</th></tr></thead>
        <tbody>${reviewRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card span-2">
    <h2>Recent runs</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Kind</th><th>Goal</th><th>Status</th><th>Cost</th><th>Duration</th><th>Steps</th><th>Channel</th></tr></thead>
        <tbody>${runRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card">
    <h2>Connectors</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Connector</th><th>Status</th></tr></thead>
        <tbody>${connectorRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card">
    <h2>Automations</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>Schedule</th><th>State</th><th>Last run</th></tr></thead>
        <tbody>${automationRows}</tbody>
      </table>
    </div>
  </section>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Review detail                                                       */
/* ------------------------------------------------------------------ */

export function renderReviewDetail(vm: ReviewDetailVM): string {
  const r = vm.review;

  const findingsHtml =
    vm.findings.length === 0
      ? '<div class="clean-panel">No findings — clean diff.</div>'
      : groupFindingsBySeverity(vm.findings)
          .map(
            ([sev, group]) => `
    <div class="finding-group">
      <h3>${esc(sev)} <span class="muted-cell">(${group.length})</span></h3>
      ${group
        .map(
          (f) => `
      <article class="finding">
        <div class="finding-head">
          ${sevBadge(f.severity)}
          <span class="tag tag-heuristic">${esc(f.category)}</span>
          ${sourceTag(f.source)}
          <code class="path" title="${esc(f.path)}:${f.line}">${esc(f.path)}:${f.line}</code>
          <span class="finding-conf">confidence ${confPct(f.confidence)}%</span>
        </div>
        <p class="finding-msg">${esc(f.message)}</p>
        ${f.suggestion ? `<div class="finding-suggest"><span class="suggest-label">Suggestion</span>${esc(f.suggestion)}</div>` : ''}
      </article>`,
        )
        .join('')}
    </div>`,
          )
          .join('');

  const similarHtml =
    vm.similarFindings.length > 0
      ? `<ul class="plain-list">${vm.similarFindings
          .map(
            (s) => `
      <li><code>${esc(s.path)}</code><span class="muted-cell"> · PR #${s.prNumber} · ${fmtDate(s.when)}</span><br>${esc(s.message)}</li>`,
          )
          .join('')}
      </ul>`
      : '<div class="empty">No similar past findings.</div>';

  const learningsHtml =
    vm.learnings.length > 0
      ? `<ul class="plain-list">${vm.learnings.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      : '<div class="empty">No team knowledge applied to this review.</div>';

  const metaBits = [
    statusBadge(vm.status),
    gauge(vm.risk),
    vm.headSha ? `<code title="${esc(vm.headSha)}">${esc(vm.headSha.slice(0, 10))}</code>` : '',
    `<span class="muted-cell">${fmtDate(r.at)}</span>`,
    `<span class="muted-cell">LLM: ${vm.llmUsed ? 'yes' : 'no'}</span>`,
    r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Open PR</a>` : '',
  ]
    .filter(Boolean)
    .join('\n      ');

  return `
<header class="page-head">
  <div>
    <h1>${esc(vm.repo)}#${r.pr} <span class="head-title">${esc(r.title)}</span></h1>
    <div class="page-head-meta">
      ${metaBits}
    </div>
  </div>
</header>
<div class="grid">
  <section class="card span-2">
    <h2>Walkthrough</h2>
    <div class="md">${mdLite(vm.walkthrough)}</div>
  </section>
  <section class="card span-2">
    <h2>Summary</h2>
    <div class="md">${mdLite(vm.summary)}</div>
  </section>
  <section class="card span-2">
    <h2>Findings (${vm.findings.length})</h2>
    ${findingsHtml}
  </section>
  <section class="card">
    <h2>Similar past findings</h2>
    ${similarHtml}
  </section>
  <section class="card">
    <h2>Applied team knowledge</h2>
    ${learningsHtml}
  </section>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Console                                                             */
/* ------------------------------------------------------------------ */

export function renderConsole(vm: ConsoleVM, thread: ConsoleThreadVM | null): string {
  const threadItems =
    vm.threads.length > 0
      ? vm.threads
          .map((th) => {
            const active = thread !== null && th.id === thread.id ? ' active' : '';
            return `<a class="thread-item${active}" href="/console?thread=${encodeURIComponent(th.id)}">
  <div class="thread-title">${esc(th.title || th.channelKey)}</div>
  <div class="thread-last">${esc(trunc(th.lastMessage, 60))}</div>
  <div class="thread-time">${fmtDate(th.updatedAt)}</div>
</a>`;
          })
          .join('')
      : '<div class="empty">No threads yet.</div>';

  const messages = thread ? thread.messages : [];
  const chatBody =
    messages.length > 0
      ? messages
          .map((m) => {
            const roleCls = m.role === 'user' ? 'msg-user' : 'msg-assistant';
            const author = m.author ? ` (${esc(m.author)})` : '';
            return `<div class="msg ${roleCls}">
  <div class="msg-role">${esc(m.role)}${author}</div>
  <div class="msg-body">${esc(m.body)}</div>
  <div class="msg-time">${fmtDate(m.at)}</div>
</div>`;
          })
          .join('')
      : '<div class="empty">No messages yet. Ask Vigil something below.</div>';

  const chatTitle = thread ? thread.title || thread.channelKey : 'New conversation';

  // Inline script values: JSON-stringified thread id ('<' escaped so a hostile
  // id can never break out of the script element), and whether the last
  // message is still awaiting an assistant reply.
  const threadIdJs = thread ? JSON.stringify(thread.id).replace(/</g, '\\u003c') : 'null';
  const lastMsg = thread !== null && thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
  const polling = lastMsg !== null && lastMsg.role === 'user' ? 'true' : 'false';

  const script = `<script>
(function () {
  'use strict';
  var form = document.getElementById('console-form');
  if (!form) { return; }
  var threadId = ${threadIdJs};
  var pollPending = ${polling};
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = form.querySelector('input[name="text"]');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { return; }
    var button = form.querySelector('button');
    if (button) { button.disabled = true; }
    fetch('/api/console/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, threadId: threadId })
    }).then(function () {
      location.reload();
    }).catch(function () {
      if (button) { button.disabled = false; }
    });
  });
  if (threadId !== null && pollPending) {
    var timer = setInterval(function () {
      fetch('/api/console/threads/' + encodeURIComponent(threadId))
        .then(function (r) { return r.json(); })
        .then(function (t) {
          var msgs = (t && t.messages) || [];
          var last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          if (last && last.role && last.role !== 'user') {
            clearInterval(timer);
            location.reload();
          }
        })
        .catch(function () { /* transient error: keep polling */ });
    }, 3000);
  }
})();
</script>`;

  return `<header class="page-head"><h1>Console</h1></header>
<div class="console">
  <aside class="threads">
    <h2>Threads</h2>
    ${threadItems}
  </aside>
  <section class="chat">
    <div class="chat-head">${esc(chatTitle)}</div>
    <div class="chat-scroll">
${chatBody}
    </div>
    <form id="console-form">
      <input name="text" placeholder="Ask Vigil to investigate, fix, summarize..." autocomplete="off" required>
      <button type="submit">Send</button>
    </form>
  </section>
</div>
${script}`;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export function renderJobs(vm: JobsVM): string {
  const rows =
    vm.jobs.length > 0
      ? vm.jobs
          .map(
            (j) => `
    <tr>
      <td><span class="tag">${esc(j.type)}</span></td>
      <td>${statusBadge(j.status)}</td>
      <td class="num">${fmtNum(j.attempts)}</td>
      <td class="muted-cell">${fmtDate(j.runAt)}</td>
      <td class="wrap-cell">${j.lastError ? `<span class="err-text" title="${esc(j.lastError)}">${esc(trunc(j.lastError, 80))}</span>` : '<span class="muted-cell">—</span>'}</td>
      <td><code class="payload" title="${esc(j.payload)}">${esc(trunc(j.payload, 100))}</code></td>
    </tr>`,
          )
          .join('')
      : emptyRow(6, 'No jobs queued.');

  return `
<header class="page-head"><h1>Jobs</h1></header>
<section class="card">
  <h2>Job queue</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Last error</th><th>Payload</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export function renderUsage(vm: UsageVM): string {
  const maxDayCost = vm.days.reduce((m, d) => Math.max(m, d.costUsd), 0);

  const dayRows =
    vm.days.length > 0
      ? vm.days
          .map((d) => {
            const pct = maxDayCost > 0 ? Math.round((d.costUsd / maxDayCost) * 100) : 0;
            return `
    <tr>
      <td class="muted-cell mono">${esc(d.day)}</td>
      <td class="num">${fmtNum(d.runs)}</td>
      <td>
        <span class="cost-cell"><span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span><span class="mono">${fmtCost(d.costUsd)}</span></span>
      </td>
      <td class="num">${fmtNum(d.minutes)}</td>
      <td class="num">${fmtNum(d.promptTokens)} / ${fmtNum(d.completionTokens)}</td>
    </tr>`;
          })
          .join('')
      : emptyRow(5, 'No usage recorded yet.');

  const kindRows =
    vm.byKind.length > 0
      ? vm.byKind
          .map(
            (k) => `
    <tr>
      <td><span class="tag">${esc(k.kind)}</span></td>
      <td class="num">${fmtNum(k.runs)}</td>
      <td class="num mono">${fmtCost(k.costUsd)}</td>
      <td class="num">${fmtNum(k.minutes)}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(4, 'No runs by kind yet.');

  const stepRows =
    vm.topSteps.length > 0
      ? vm.topSteps
          .map(
            (s) => `
    <tr>
      <td class="wrap-cell"><strong>${esc(s.name)}</strong></td>
      <td><span class="tag tag-heuristic">${esc(s.kind)}</span></td>
      <td class="num">${fmtNum(s.calls)}</td>
      <td class="num mono">${fmtCost(s.costUsd)}</td>
      <td class="num">${fmtDuration(s.totalMs)}</td>
    </tr>`,
          )
          .join('')
      : emptyRow(5, 'No steps recorded yet.');

  return `
<header class="page-head"><h1>Usage</h1></header>
<div class="grid">
  <section class="card span-2">
    <h2>By day</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Day</th><th>Runs</th><th>Cost</th><th>Minutes</th><th>Tokens in / out</th></tr></thead>
        <tbody>${dayRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card">
    <h2>By kind</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Kind</th><th>Runs</th><th>Cost</th><th>Minutes</th></tr></thead>
        <tbody>${kindRows}</tbody>
      </table>
    </div>
  </section>
  <section class="card">
    <h2>Top steps</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Step</th><th>Kind</th><th>Calls</th><th>Cost</th><th>Total time</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </div>
  </section>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Run detail                                                          */
/* ------------------------------------------------------------------ */

export function renderRunDetail(vm: RunDetailVM): string {
  const run = vm.run;

  const stepRows =
    vm.steps.length > 0
      ? vm.steps
          .map(
            (s) => `
    <tr>
      <td class="num mono">${s.seq}</td>
      <td><span class="tag tag-heuristic">${esc(s.kind)}</span></td>
      <td class="wrap-cell"><strong>${esc(s.name)}</strong></td>
      <td>${s.ok ? '<span class="yes">OK</span>' : '<span class="err-text">FAIL</span>'}</td>
      <td class="num">${fmtDuration(s.durationMs)}</td>
      <td class="num">${fmtNum(s.tokensIn)} / ${fmtNum(s.tokensOut)}</td>
      <td class="num mono">${fmtCost(s.costUsd)}</td>
      <td><code class="payload" title="${esc(s.detail)}">${esc(trunc(s.detail, 100))}</code></td>
    </tr>`,
          )
          .join('')
      : emptyRow(8, 'No steps recorded for this run.');

  return `
<header class="page-head">
  <div>
    <h1>Run <span class="head-title mono">${esc(run.id)}</span></h1>
    <div class="page-head-meta">
      <span class="tag">${esc(run.kind)}</span>
      ${statusBadge(run.status)}
      <span class="mono">${fmtCost(run.costUsd)}</span>
      <span class="muted-cell">${fmtDuration(run.wallMs)}</span>
      <span class="muted-cell">${fmtNum(run.steps)} steps</span>
      <span class="muted-cell">${esc(run.channel)}</span>
      <span class="muted-cell">${fmtDate(run.at)}</span>
    </div>
  </div>
</header>
<section class="card">
  <h2>Goal</h2>
  <pre>${esc(vm.goal)}</pre>
</section>
<section class="card mt">
  <h2>Steps (${vm.steps.length})</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Kind</th><th>Name</th><th>Result</th><th>Duration</th><th>Tokens in / out</th><th>Cost</th><th>Detail</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table>
  </div>
</section>`;
}

/* ------------------------------------------------------------------ */
/* Error                                                              */
/* ------------------------------------------------------------------ */

export function renderError(message: string): string {
  return `<section class="error-wrap">
  <div class="error-panel">
    <h1>Error</h1>
    <p>${esc(message)}</p>
  </div>
</section>`;
}
