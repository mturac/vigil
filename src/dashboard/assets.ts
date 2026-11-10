// Vigil dashboard — stylesheet and static assets.
// Single CSS string, inlined into every page by views.ts `page()`.
// No external assets, no CDNs, no frameworks.

export const css: string = `
/* ------------------------------------------------------------------ */
/* Design tokens                                                       */
/* ------------------------------------------------------------------ */
:root {
  --bg: #0b0e14;
  --panel: #121722;
  --panel-border: #1f2735;
  --text: #e6ebf2;
  --muted: #8b96a8;
  --accent: #4f8cff;
  --ok: #34d399;
  --warn: #fbbf24;
  --danger: #ef4444;
  --high: #f97316;
  --low: #60a5fa;
  --track: #1a2233;
  --stripe: rgba(255, 255, 255, 0.016);
  --hover: rgba(79, 140, 255, 0.06);
  --code-bg: #0d1117;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--bg);
  background-image: radial-gradient(1100px 420px at 50% -160px, rgba(79, 140, 255, 0.07), transparent 70%);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.55;
}
a { color: var(--accent); text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #82b0ff; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::selection { background: rgba(79, 140, 255, 0.35); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #263043; border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: #313d55; }
::-webkit-scrollbar-track { background: transparent; }

/* ------------------------------------------------------------------ */
/* Top navigation                                                      */
/* ------------------------------------------------------------------ */
.topnav {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 56px;
  padding: 6px 24px;
  background: rgba(18, 23, 34, 0.92);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--panel-border);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.brand:hover { color: var(--text); }
.brand-mark {
  color: var(--accent);
  display: block;
  filter: drop-shadow(0 0 6px rgba(79, 140, 255, 0.45));
}
.nav-links { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.nav-links a {
  padding: 6px 12px;
  border-radius: 6px;
  color: var(--muted);
  font-weight: 500;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.nav-links a:hover { color: var(--text); background: rgba(79, 140, 255, 0.08); }
.nav-links a.active { color: var(--accent); background: rgba(79, 140, 255, 0.13); }

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */
.wrap { flex: 1 1 auto; width: 100%; max-width: 1200px; margin: 0 auto; padding: 24px 24px 40px; }
.footer {
  padding: 16px 24px;
  border-top: 1px solid var(--panel-border);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
.card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  padding: 16px 18px 18px;
}
.card.span-2 { grid-column: span 2; }
.card.mt { margin-top: 16px; }
.card > h2,
.threads > h2 {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
}

/* ------------------------------------------------------------------ */
/* Page header                                                         */
/* ------------------------------------------------------------------ */
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.head-title { color: var(--muted); font-weight: 400; font-size: 15px; }
.page-head-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }

/* ------------------------------------------------------------------ */
/* Stat tiles                                                          */
/* ------------------------------------------------------------------ */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.tile {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  padding: 14px 16px;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.tile:hover { border-color: #2b3a5c; transform: translateY(-1px); }
.tile-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.tile-num {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.tile-num.small { font-size: 20px; }
.tile-num.accent { color: var(--accent); }
.tile-num.danger { color: var(--danger); }
.tile-num.high { color: var(--high); }
.tile-num.ok { color: var(--ok); }

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td {
  padding: 8px 10px;
  text-align: left;
  vertical-align: middle;
  border-bottom: 1px solid var(--panel-border);
  white-space: nowrap;
}
thead th {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--muted);
  border-bottom-color: #26324a;
}
tbody tr:nth-child(even) { background: var(--stripe); }
tbody tr { transition: background-color 0.12s ease; }
tbody tr:hover { background: var(--hover); }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.wrap-cell { white-space: normal; min-width: 140px; max-width: 360px; }
.muted-cell { color: var(--muted); }
.yes { color: var(--ok); font-weight: 600; }
.err-text { color: var(--danger); }
.sev-num.danger { color: var(--danger); font-weight: 600; }
.sev-num.high { color: var(--high); font-weight: 600; }
.empty { color: var(--muted); text-align: center; padding: 20px 8px; font-size: 13px; }

/* ------------------------------------------------------------------ */
/* Badges, tags, dots                                                  */
/* ------------------------------------------------------------------ */
.badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.5;
  text-transform: capitalize;
  color: #0b0e14;
  white-space: nowrap;
}
.badge-critical { background: var(--danger); }
.badge-high { background: var(--high); }
.badge-medium { background: var(--warn); }
.badge-low { background: var(--low); }
.badge-info { background: #46536b; color: var(--text); }
.badge-ok { background: var(--ok); }
.badge-warn { background: var(--warn); }
.badge-danger { background: var(--danger); }
.badge-accent { background: var(--accent); }
.badge-muted { background: #46536b; color: var(--text); }

.tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 5px;
  border: 1px solid rgba(79, 140, 255, 0.3);
  background: rgba(79, 140, 255, 0.1);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
}
.tag-heuristic {
  border-color: rgba(139, 150, 168, 0.3);
  background: rgba(139, 150, 168, 0.1);
  color: var(--muted);
}

.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #3a465c;
  margin-right: 8px;
  vertical-align: middle;
}
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.15); }
.dot.off { background: #3a465c; }

/* ------------------------------------------------------------------ */
/* Risk gauge                                                          */
/* ------------------------------------------------------------------ */
.gauge-cell { display: inline-flex; align-items: center; gap: 8px; vertical-align: middle; }
.gauge { display: block; width: 110px; height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
.gauge-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--ok) 0%, var(--warn) 55%, var(--danger) 100%);
  transition: width 0.3s ease;
}
.gauge-num { font-family: var(--mono); font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------------ */
/* Code, monospace, markdown-lite                                      */
/* ------------------------------------------------------------------ */
.mono, code, pre { font-family: var(--mono); }
code {
  background: var(--code-bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}
code.path {
  display: inline-block;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
code.payload {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
}
pre {
  margin: 0;
  padding: 12px 14px;
  background: var(--code-bg);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.md { font-size: 13.5px; }
.md h3, .md h4, .md h5 { margin: 16px 0 6px; line-height: 1.3; font-weight: 600; }
.md h3 { font-size: 16px; }
.md h4 { font-size: 14px; }
.md h5 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.md > :first-child { margin-top: 0; }
.md p { margin: 8px 0; }
.md ul { margin: 8px 0; padding-left: 20px; }
.md li { margin: 4px 0; }
.md code { background: rgba(79, 140, 255, 0.1); border-color: rgba(79, 140, 255, 0.22); color: #a8c7ff; }
.md strong { color: #ffffff; }

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */
.finding-group { margin-bottom: 18px; }
.finding-group:last-child { margin-bottom: 0; }
.finding-group > h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.finding {
  background: var(--code-bg);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
  transition: border-color 0.15s ease;
}
.finding:last-child { margin-bottom: 0; }
.finding:hover { border-color: #2b3a5c; }
.finding-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.finding-msg { margin: 10px 0 0; font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
.finding-suggest {
  margin-top: 10px;
  padding: 6px 12px;
  border-left: 3px solid #2b3a5c;
  color: var(--muted);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}
.suggest-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
  opacity: 0.8;
  margin-bottom: 2px;
}
.finding-conf { margin-left: auto; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.clean-panel {
  padding: 14px 16px;
  border-radius: 8px;
  border: 1px solid rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.07);
  color: var(--ok);
  font-weight: 600;
}
.plain-list { margin: 0; padding-left: 18px; }
.plain-list li { margin: 10px 0; font-size: 13px; }

/* ------------------------------------------------------------------ */
/* Console: threads, chat bubbles, form                                */
/* ------------------------------------------------------------------ */
.console {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  margin-top: 16px;
}
.threads {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  max-height: 72vh;
  overflow-y: auto;
}
.threads > h2 {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel);
  margin: 0;
  padding: 12px 14px;
  border-bottom: 1px solid var(--panel-border);
}
.thread-item {
  display: block;
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border);
  color: var(--text);
  transition: background-color 0.12s ease;
}
.thread-item:last-child { border-bottom: 0; }
.thread-item:hover { background: var(--hover); color: var(--text); }
.thread-item.active { background: rgba(79, 140, 255, 0.1); box-shadow: inset 3px 0 0 var(--accent); }
.thread-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-last { margin-top: 2px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-time { margin-top: 3px; color: var(--muted); font-size: 11px; font-family: var(--mono); }

.chat {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-head { padding: 12px 16px; border-bottom: 1px solid var(--panel-border); font-weight: 600; font-size: 14px; }
.chat-scroll { display: flex; flex-direction: column; gap: 12px; padding: 16px; max-height: 62vh; overflow-y: auto; }
.msg {
  max-width: 88%;
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  background: var(--code-bg);
  padding: 10px 13px;
}
.msg-role { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; margin-bottom: 5px; }
.msg-body { font-family: var(--mono); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.msg-time { margin-top: 6px; font-size: 11px; color: var(--muted); font-family: var(--mono); }
.msg-user { border-color: rgba(79, 140, 255, 0.4); background: rgba(79, 140, 255, 0.08); }
.msg-user .msg-role { color: var(--accent); }
.msg-assistant { border-color: rgba(52, 211, 153, 0.32); }
.msg-assistant .msg-role { color: var(--ok); }

.console-form { display: flex; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--panel-border); background: var(--panel); }
.console-form input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--panel-border);
  background: var(--code-bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.console-form input::placeholder { color: var(--muted); }
.console-form input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79, 140, 255, 0.15); }
.console-form button {
  flex: 0 0 auto;
  padding: 10px 20px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #071120;
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.05s ease;
}
.console-form button:hover { filter: brightness(1.12); }
.console-form button:active { transform: translateY(1px); }
.console-form button:disabled { opacity: 0.55; cursor: default; }

/* ------------------------------------------------------------------ */
/* Horizontal chart bars                                               */
/* ------------------------------------------------------------------ */
.cost-cell { display: flex; align-items: center; gap: 10px; min-width: 200px; }
.cost-cell .bar { flex: 1 1 auto; }
.bar {
  display: block;
  height: 10px;
  min-width: 60px;
  border-radius: 5px;
  background: var(--track);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--accent), var(--low));
  transition: width 0.3s ease;
}

/* ------------------------------------------------------------------ */
/* Error panel                                                         */
/* ------------------------------------------------------------------ */
.error-wrap { min-height: 55vh; display: flex; align-items: center; justify-content: center; }
.error-panel {
  max-width: 560px;
  padding: 26px 30px;
  border-radius: var(--radius);
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.06);
  text-align: center;
}
.error-panel h1 { margin: 0 0 8px; color: var(--danger); font-size: 17px; }
.error-panel p {
  margin: 0;
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ------------------------------------------------------------------ */
/* Responsive                                                          */
/* ------------------------------------------------------------------ */
@media (max-width: 800px) {
  .topnav { flex-wrap: wrap; padding: 8px 16px; gap: 8px 16px; }
  .nav-links { order: 2; width: 100%; }
  .wrap { padding: 16px 16px 32px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid { grid-template-columns: minmax(0, 1fr); }
  .card.span-2 { grid-column: auto; }
  .console { grid-template-columns: minmax(0, 1fr); }
  .threads { max-height: 240px; }
  .gauge { width: 70px; }
  .msg { max-width: 100%; }
  code.path, code.payload { max-width: 180px; }
}
@media (max-width: 480px) {
  .tiles { grid-template-columns: minmax(0, 1fr); }
  .cost-cell { min-width: 140px; }
}
`;
