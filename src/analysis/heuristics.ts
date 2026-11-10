// Deterministic heuristic review engine — 29 rules across security, quality,
// performance, tests, maintainability and style. Pure, dependency-free, sorted output.
import type { Category, DiffFile, HeuristicFinding, Severity } from './types.js';
import { isTestPath, SEVERITY_ORDER } from './types.js';

export interface HeuristicRuleMeta {
  id: string;
  description: string;
  category: Category;
  defaultSeverity: Severity;
  languages?: string[];
  fileLevel?: boolean;
}

export interface HeuristicsOptions {
  mutedRuleIds?: string[];
  maxPerRulePerFile?: number;
}

export const HEURISTIC_RULES: HeuristicRuleMeta[] = [
  { id: 'secret-in-code', description: 'Hard-coded secrets (AWS/GitHub/OpenAI/Slack keys, private keys, generic credentials)', category: 'security', defaultSeverity: 'critical' },
  { id: 'sql-string-concat', description: 'SQL built via string concatenation or interpolation', category: 'security', defaultSeverity: 'high' },
  { id: 'eval-usage', description: 'Use of eval() or new Function()', category: 'security', defaultSeverity: 'high' },
  { id: 'debugger-statement', description: 'Leftover debugger statement', category: 'quality', defaultSeverity: 'high' },
  { id: 'console-left', description: 'Debug console.log/print left in production paths', category: 'quality', defaultSeverity: 'low' },
  { id: 'todo-left', description: 'Leftover TODO/FIXME/HACK/XXX marker', category: 'maintainability', defaultSeverity: 'info' },
  { id: 'hardcoded-ip', description: 'Hard-coded IP address', category: 'security', defaultSeverity: 'medium' },
  { id: 'weak-crypto', description: 'Weak hash/cipher (MD5, SHA1, DES, RC4, ECB mode)', category: 'security', defaultSeverity: 'high' },
  { id: 'math-random-token', description: 'Math.random() used for security-sensitive values', category: 'security', defaultSeverity: 'high' },
  { id: 'http-url', description: 'Insecure http:// URL', category: 'security', defaultSeverity: 'low' },
  { id: 'empty-catch', description: 'Empty catch/except block swallows errors', category: 'quality', defaultSeverity: 'medium' },
  { id: 'bare-except-py', description: 'Bare `except:` catches everything', category: 'quality', defaultSeverity: 'medium' },
  { id: 'pickle-load', description: 'Unsafe deserialization (pickle/marshal/yaml.load without Loader)', category: 'security', defaultSeverity: 'high' },
  { id: 'os-system', description: 'Shell execution with string building or shell=True', category: 'security', defaultSeverity: 'high' },
  { id: 'ssl-verify-disabled', description: 'TLS certificate verification disabled', category: 'security', defaultSeverity: 'critical' },
  { id: 'cors-wildcard', description: 'CORS allows any origin (*)', category: 'security', defaultSeverity: 'medium' },
  { id: 'unsafe-regex', description: 'ReDoS-prone nested quantifier regex', category: 'performance', defaultSeverity: 'medium' },
  { id: 'non-null-assertion', description: 'TypeScript non-null assertion (!)', category: 'quality', defaultSeverity: 'low', languages: ['ts', 'tsx'] },
  { id: 'any-type', description: 'TypeScript `any` weakens type safety', category: 'quality', defaultSeverity: 'low', languages: ['ts', 'tsx'] },
  { id: 'deep-nesting', description: 'Very deep nesting (>= 24 spaces)', category: 'maintainability', defaultSeverity: 'medium' },
  { id: 'long-line', description: 'Line longer than 200 characters', category: 'style', defaultSeverity: 'info' },
  { id: 'test-missing', description: 'Source changed without any test changes', category: 'tests', defaultSeverity: 'medium', fileLevel: true },
  { id: 'large-file-diff', description: 'Single-file diff larger than 400 changed lines', category: 'maintainability', defaultSeverity: 'low', fileLevel: true },
  { id: 'lockfile-only', description: 'PR contains only lockfile changes', category: 'quality', defaultSeverity: 'info', fileLevel: true },
  { id: 'mass-deletion', description: 'File deleted with more than 100 lines removed', category: 'maintainability', defaultSeverity: 'medium', fileLevel: true },
  { id: 'docker-latest', description: 'Docker FROM without a pinned tag', category: 'quality', defaultSeverity: 'low' },
  { id: 'chmod-777', description: 'chmod 777 grants world write access', category: 'security', defaultSeverity: 'medium' },
  { id: 'dom-xss', description: 'Potential DOM XSS sink (innerHTML / document.write / dangerouslySetInnerHTML)', category: 'security', defaultSeverity: 'high' },
  { id: 'process-exit', description: 'process.exit() in library code', category: 'quality', defaultSeverity: 'low' },
];

// ---------------------------------------------------------------------------
// helpers

function base(rule: HeuristicRuleMeta, file: DiffFile, line: number, message: string, suggestion: string, snippet: string, confidence: number): HeuristicFinding {
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.defaultSeverity,
    confidence,
    path: file.path,
    line,
    message,
    suggestion,
    snippet: snippet.length > 120 ? snippet.slice(0, 117) + '...' : snippet,
  };
}

function isJsTs(file: DiffFile): boolean {
  return ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(file.language);
}
function isPy(file: DiffFile): boolean {
  return file.language === 'py';
}
function isShellLike(file: DiffFile): boolean {
  const b = file.path.split('/').pop() ?? '';
  return ['sh', 'bash', 'mk'].includes(file.language) || b === 'Dockerfile' || b.startsWith('Dockerfile.') || b === 'Makefile';
}
function isDockerfile(file: DiffFile): boolean {
  const b = file.path.split('/').pop() ?? '';
  return b === 'Dockerfile' || b.startsWith('Dockerfile.');
}

const KNOWN_SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { re: /gh[pousr]_[A-Za-z0-9]{36}/, label: 'GitHub token' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'OpenAI-style API key' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |PGP |)?PRIVATE KEY-----/, label: 'private key block' },
  { re: /AIza[0-9A-Za-z_\-]{35}/, label: 'Google API key' },
  { re: /hooks\.slack\.com\/services\/T[A-Za-z0-9/]+/, label: 'Slack webhook URL' },
];

const GENERIC_SECRET_RE = /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']([^"']{8,})["']/i;
const GENERIC_SECRET_EXCLUDE = ['example', 'test', 'dummy', 'placeholder', 'changeme', 'sample', 'your_', 'xxxxxx', '<', '${', 'process.env'];

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock', 'go.sum'];
const NON_SOURCE_EXT = ['json', 'yml', 'yaml', 'md', 'txt', 'toml', 'lock', 'map'];

function isSourceFile(file: DiffFile): boolean {
  if (file.changeType !== 'added' && file.changeType !== 'modified') return false;
  const p = file.path.toLowerCase();
  if (p.includes('config') || p.includes('.github') || p.includes('docker')) return false;
  const ext = file.language;
  if (NON_SOURCE_EXT.includes(ext)) return false;
  if (!ext) return false; // e.g. Dockerfile has no extension but contains "docker" path filter anyway
  return true;
}

// ---------------------------------------------------------------------------
// rule implementations (line rules operate on added lines only)

type LineDetect = (file: DiffFile, line: number, text: string) => HeuristicFinding | null;

interface LineRuleDef { meta: HeuristicRuleMeta; noTests?: boolean; languageFilter?: (f: DiffFile) => boolean; detect: LineDetect }

const RULES: LineRuleDef[] = [
  {
    meta: HEURISTIC_RULES[0],
    detect: (file, line, text) => {
      for (const { re, label } of KNOWN_SECRET_PATTERNS) {
        const m = text.match(re);
        if (m) {
          return base(HEURISTIC_RULES[0], file, line, `Possible ${label} hard-coded in source: \`${m[0].slice(0, 12)}...\`.`, 'Move the secret to an environment variable or secret manager and rotate the exposed credential.', text, 92);
        }
      }
      const g = text.match(GENERIC_SECRET_RE);
      if (g) {
        const value = g[2].toLowerCase();
        if (!GENERIC_SECRET_EXCLUDE.some((x) => value.includes(x))) {
          return base(HEURISTIC_RULES[0], file, line, `Hard-coded credential \`${g[1]}\` with a literal value — this looks like a real secret.`, 'Load credentials from environment variables or a secrets manager instead of literals.', text, 55);
        }
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[1],
    detect: (file, line, text) => {
      const sql = /(select|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|database))/i.test(text);
      if (!sql) return null;
      const concat = /\+\s*\w/.test(text) || /["']\s*\+/.test(text);
      const interp = /\$\{/.test(text);
      const mixed = (text.includes('%s') || text.includes('?')) && /["']/.test(text);
      if (concat || interp || mixed) {
        return base(HEURISTIC_RULES[1], file, line, 'SQL query built with string concatenation/interpolation — this is an injection risk.', 'Use parameterized queries / prepared statements instead of building SQL strings.', text, 75);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[2],
    detect: (file, line, text) => {
      if (/\beval\s*\(/.test(text) || /new\s+Function\s*\(/.test(text)) {
        return base(HEURISTIC_RULES[2], file, line, 'Use of `eval()` / `new Function()` executes arbitrary strings as code.', 'Remove eval; parse data with JSON.parse or restructure the logic.', text, 85);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[3],
    detect: (file, line, text) => {
      if (/^\s*debugger\s*[;]?\s*$/.test(text)) {
        return base(HEURISTIC_RULES[3], file, line, '`debugger` statement left in the code — this halts execution in devtools-enabled browsers.', 'Remove the debugger statement.', text, 95);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[4],
    noTests: true,
    detect: (file, line, text) => {
      const isPyFile = isPy(file);
      const hit = isJsTs(file) ? /console\.(log|debug)\s*\(/.test(text) : isPyFile && /\/(src|lib|app)\//.test(file.path) && /\bprint\(/.test(text);
      if (hit) {
        return base(HEURISTIC_RULES[4], file, line, 'Debug logging left in code paths.', 'Remove the debug log or route it through a leveled logger.', text, 60);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[5],
    detect: (file, line, text) => {
      const m = text.match(/(TODO|FIXME|HACK|XXX)\b(.{0,80})/);
      if (m) {
        return base(HEURISTIC_RULES[5], file, line, `Leftover marker \`${m[1]}${(m[2] ?? '').trim().slice(0, 80)}\` — unfinished work tracked in code.`, 'Resolve the marker or file a ticket and reference it here.', text, 90);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[6],
    detect: (file, line, text) => {
      if (/version/i.test(text)) return null;
      const m = text.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      if (m && !['0.0.0.0', '127.0.0.1', '255.255.255.255'].includes(m[1])) {
        return base(HEURISTIC_RULES[6], file, line, `Hard-coded IP address \`${m[1]}\` — environment-specific config baked into code.`, 'Move the address to configuration/environment variables.', text, 55);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[7],
    detect: (file, line, text) => {
      const hit =
        /createHash\s*\(\s*["'](md5|sha1)["']/.test(text) ||
        /\bmd5\s*\(/.test(text) ||
        /\bsha1\s*\(/.test(text) ||
        /["'](DES|RC4)["']/.test(text) ||
        /mode\s*=\s*ECB/.test(text) ||
        /["']ECB["']/.test(text);
      if (hit) {
        return base(HEURISTIC_RULES[7], file, line, 'Weak cryptographic primitive (MD5/SHA1/DES/RC4/ECB) — vulnerable to collision and cryptanalysis attacks.', 'Use SHA-256+ for hashes and AES-GCM for encryption.', text, 80);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[8],
    detect: (file, line, text) => {
      if (/Math\.random/.test(text) && /(token|secret|password|key|salt|session|uuid|nonce)/i.test(text)) {
        return base(HEURISTIC_RULES[8], file, line, '`Math.random()` used for a security-sensitive value — it is not cryptographically random.', 'Use crypto.randomUUID() / crypto.getRandomValues() / secrets module.', text, 75);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[9],
    detect: (file, line, text) => {
      if (/http:\/\//.test(text)) {
        const ok = ['localhost', '127.0.0.1', '0.0.0.0', 'example.com', 'www.w3.org', 'json-schema.org'].some((h) => text.includes(`http://${h}`));
        const anyHttpHost = text.match(/http:\/\/([^/\s"']+)/);
        if (!ok && anyHttpHost) {
          return base(HEURISTIC_RULES[9], file, line, `Insecure \`http://\` URL to \`${anyHttpHost[1]}\`.`, 'Use https:// for external URLs.', text, 55);
        }
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[10],
    detect: (file, line, text) => {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text) || /catch\s*\{\s*\}/.test(text) || /except\s*[^:]*:\s*pass/.test(text)) {
        return base(HEURISTIC_RULES[10], file, line, 'Empty catch block silently swallows errors.', 'At minimum log the error; ideally handle or rethrow it.', text, 85);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[11],
    languageFilter: isPy,
    detect: (file, line, text) => {
      if (/^\s*except\s*:/.test(text)) {
        return base(HEURISTIC_RULES[11], file, line, 'Bare `except:` catches every exception including SystemExit and KeyboardInterrupt.', 'Catch specific exception types instead.', text, 85);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[12],
    detect: (file, line, text) => {
      if (/pickle\.loads?\s*\(/.test(text) || /marshal\.loads?\s*\(/.test(text) || (/yaml\.load\s*\(/.test(text) && !/Loader\s*=/.test(text))) {
        return base(HEURISTIC_RULES[12], file, line, 'Unsafe deserialization — pickle/marshal/yaml.load can execute arbitrary code.', 'Use JSON, or yaml.safe_load / pickle only over trusted, signed data.', text, 80);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[13],
    detect: (file, line, text) => {
      const osSys = /os\.system\s*\(/.test(text) || /shell\s*=\s*True/.test(text);
      const nodeExec = /exec\s*\(\s*["'`][^"'`]*(\$\{|\s*\+)/.test(text);
      if (osSys || nodeExec) {
        return base(HEURISTIC_RULES[13], file, line, 'Shell command built from dynamic strings (or shell=True) — command injection risk.', 'Use execFile/spawn with an args array, or subprocess.run with a list and shell=False.', text, 75);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[14],
    detect: (file, line, text) => {
      const hit =
        /rejectUnauthorized\s*:\s*false/.test(text) ||
        /InsecureSkipVerify\s*:\s*true/.test(text) ||
        /verify\s*=\s*False/.test(text) ||
        /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/.test(text);
      if (hit) {
        return base(HEURISTIC_RULES[14], file, line, 'TLS certificate verification is disabled — man-in-the-middle attacks become possible.', 'Enable certificate verification; fix the trust store instead of disabling checks.', text, 90);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[15],
    detect: (file, line, text) => {
      if (/Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']/.test(text) || /origin\s*:\s*["']\*["']/.test(text)) {
        return base(HEURISTIC_RULES[15], file, line, 'CORS configured to allow any origin (`*`).', 'Restrict allowed origins to a known allowlist.', text, 65);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[16],
    detect: (file, line, text) => {
      if (/new\s*RegExp\s*\(/.test(text) || /\/.*\/[gimsuy]*\s*[,;)]/.test(text) || /=\s*\/.*\/[gimsuy]*\s*;/.test(text)) {
        if (/(\.\*)[*+]/.test(text) || /(\w\+)\+/.test(text) || /\(([^()\\]{1,60}[*+])\)[*+]/.test(text)) {
          return base(HEURISTIC_RULES[16], file, line, 'ReDoS-prone regex: nested quantifiers can cause catastrophic backtracking.', 'Simplify the pattern, add length bounds, or use a non-backtracking approach.', text, 55);
        }
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[17],
    languageFilter: (f) => f.language === 'ts' || f.language === 'tsx',
    detect: (file, line, text) => {
      const m = text.match(/(?<![=!<>])(\w+)!\s*[.;)]/);
      if (m && !/!==|!=/.test(text.slice(Math.max(0, (m.index ?? 0) - 1), (m.index ?? 0) + m[0].length + 1))) {
        return base(HEURISTIC_RULES[17], file, line, `Non-null assertion \`${m[1]}!\` bypasses null checking.`, 'Narrow the type explicitly or provide a default/fallback.', text, 55);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[18],
    languageFilter: (f) => f.language === 'ts' || f.language === 'tsx',
    detect: (file, line, text) => {
      if (/:\s*any\b/.test(text)) {
        return base(HEURISTIC_RULES[18], file, line, '`any` disables TypeScript checking for this value.', 'Use a precise type, `unknown` with narrowing, or generics.', text, 70);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[19],
    detect: (file, line, text) => {
      const indentMatch = text.match(/^[\t ]*/);
      const indent = (indentMatch?.[0] ?? '').replace(/\t/g, '    ').length;
      if (indent >= 24 && text.trim().length > 0) {
        return base(HEURISTIC_RULES[19], file, line, `Nesting depth is very high (${indent} spaces of indentation).`, 'Extract inner logic into functions or early-return guards.', text, 50);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[20],
    detect: (file, line, text) => {
      if (text.length > 200) {
        return base(HEURISTIC_RULES[20], file, line, `Line is ${text.length} characters long.`, 'Wrap long lines (target < 120 chars) for readability.', `${text.slice(0, 60)}...`, 80);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[25],
    languageFilter: isDockerfile,
    detect: (file, line, text) => {
      const m = text.match(/^FROM\s+(\S+)/i);
      if (m) {
        const image = m[1];
        if (!image.includes(':') || image.endsWith(':latest')) {
          return base(HEURISTIC_RULES[25], file, line, `Docker image ${image} is not pinned to a tag/digest.`, 'Pin an explicit version tag (or digest) for reproducible builds.', text, 75);
        }
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[26],
    languageFilter: isShellLike,
    detect: (file, line, text) => {
      if (/chmod\s+777/.test(text)) {
        return base(HEURISTIC_RULES[26], file, line, '`chmod 777` makes a file world-writable.', 'Grant only the permissions actually needed (e.g. chmod 755).', text, 75);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[27],
    detect: (file, line, text) => {
      if (/innerHTML\s*=/.test(text) || /document\.write\s*\(/.test(text) || /dangerouslySetInnerHTML/.test(text)) {
        return base(HEURISTIC_RULES[27], file, line, 'DOM sink for unescaped HTML — potential XSS.', 'Use textContent or sanitize the HTML before inserting it.', text, 65);
      }
      return null;
    },
  },
  {
    meta: HEURISTIC_RULES[28],
    noTests: true,
    detect: (file, line, text) => {
      if (/process\.exit\s*\(/.test(text) && !/(\/bin\/|\/scripts?\/|\/cmd\/)/.test(file.path)) {
        return base(HEURISTIC_RULES[28], file, line, '`process.exit()` aborts the process abruptly in library/server code.', 'Throw an error or shut down gracefully instead.', text, 60);
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------

export function runHeuristics(files: DiffFile[], opts?: HeuristicsOptions): HeuristicFinding[] {
  const muted = new Set(opts?.mutedRuleIds ?? []);
  const maxPerFile = opts?.maxPerRulePerFile ?? 5;
  const out: HeuristicFinding[] = [];

  // per-file rules
  for (const file of files) {
    // file-level rules independent of line scanning
    if (file.changeType === 'deleted' && file.deletions > 100) {
      if (!muted.has('mass-deletion')) {
        out.push(base(HEURISTIC_RULES.find((r) => r.id === 'mass-deletion')!, file, 1, `File deleted with ${file.deletions} lines removed — large loss of logic.`, 'Confirm the deletion is intentional and functionality is replaced elsewhere.', `${file.path} (-${file.deletions})`, 80));
      }
      continue; // no line rules for deleted files
    }
    if (file.additions + file.deletions > 400 && !muted.has('large-file-diff')) {
      out.push(base(HEURISTIC_RULES.find((r) => r.id === 'large-file-diff')!, file, 1, `This diff changes ${file.additions + file.deletions} lines in a single file.`, 'Split large changes into smaller, reviewable commits.', `${file.path} (+${file.additions}/-${file.deletions})`, 80));
    }

    if (file.isBinary) continue;

    // line rules
    const isTest = isTestPath(file.path);
    const perRuleCount = new Map<string, number>();
    for (const rule of RULES) {
      if (muted.has(rule.meta.id)) continue;
      if (rule.noTests && isTest) continue;
      if (rule.languageFilter && !rule.languageFilter(file)) continue;
      let count = 0;
      for (const added of file.addedLines) {
        if (count >= maxPerFile) break;
        const f = rule.detect(file, added.line, added.text);
        if (f) {
          out.push(f);
          count++;
        }
      }
      perRuleCount.set(rule.meta.id, count);
    }
  }

  // array-level rules
  const hasTestChange = files.some((f) => isTestPath(f.path) && f.changeType !== 'deleted');
  const sourceFiles = files.filter(isSourceFile);
  if (!muted.has('test-missing') && sourceFiles.length > 0 && !hasTestChange) {
    const anchor = sourceFiles[0];
    out.push(base(HEURISTIC_RULES.find((r) => r.id === 'test-missing')!, anchor, 1, `Source files changed without any test changes — consider adding tests for the new behavior (${sourceFiles.length} source file(s) changed).`, 'Add or update tests covering the changed behavior.', sourceFiles.map((f) => f.path).join(', ').slice(0, 120), 75));
  }
  if (!muted.has('lockfile-only') && files.length > 0 && files.every((f) => LOCKFILES.includes((f.path.split('/').pop() ?? '').toLowerCase()))) {
    out.push(base(HEURISTIC_RULES.find((r) => r.id === 'lockfile-only')!, files[0], 1, 'Lockfile-only change.', 'Fine if intentional (dependency bump); otherwise include the code changes.', files.map((f) => f.path).join(', ').slice(0, 120), 70));
  }

  // sort: severity desc, then path, then line
  out.sort((a, b) => {
    const s = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (s !== 0) return s;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return out;
}
