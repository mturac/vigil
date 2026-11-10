// Configuration: env vars + per-repo .vigil.yml (like .coderabbit.yaml).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface VigilConfig {
  review: {
    enabled: boolean;
    requestChangesAt: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'never';
    maxInlineComments: number;
    minSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    paths: { ignore: string[]; only: string[] };
    tests: { missingTestWarning: boolean };
    walkthrough: { mermaidGraph: boolean };
  };
  heuristics: { enabled: boolean; mutedRules: string[] };
  llm: { review: boolean; ask: boolean; fix: boolean };
  fix: { verifyCommand: string; maxIterations: number; branchPrefix: string };
  sandbox: {
    profile: 'local' | 'docker';
    workdir: string;
    timeoutMs: number;
    network: boolean;
    allow: string[];
    denyPatterns: string[];
    docker: { image: string; network: string };
  };
  memory: { enabled: boolean; autoLearn: boolean };
  governance: { enabled: boolean; defaultScope: { allowedUsers: string[]; allowedRepos: string[]; allowedConnectors: string[]; spendLimitPerDayUsd: number } };
  automations: {
    standup: { enabled: boolean; cron: string; channel: string };
    stalePrs: { enabled: boolean; cron: string; idleHours: number; channel: string };
    prSummary: { enabled: boolean; event: string; channel: string };
    sentrySignal: { enabled: boolean; channel: string };
  };
}

export const DEFAULT_CONFIG: VigilConfig = {
  review: {
    enabled: true,
    requestChangesAt: 'critical',
    maxInlineComments: 25,
    minSeverity: 'info',
    paths: { ignore: ['**/*.lock', '**/*.min.js', 'dist/**'], only: [] },
    tests: { missingTestWarning: true },
    walkthrough: { mermaidGraph: true },
  },
  heuristics: { enabled: true, mutedRules: [] },
  llm: { review: true, ask: true, fix: true },
  fix: { verifyCommand: 'npm test', maxIterations: 3, branchPrefix: 'vigil/fix' },
  sandbox: {
    profile: 'local',
    workdir: '.vigil-sandboxes',
    timeoutMs: 180000,
    network: false,
    allow: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3', 'pip', 'go', 'cargo', 'make', 'git', 'rg', 'ls', 'cat', 'echo', 'sh', 'bash', 'diff', 'grep', 'find', 'mkdir', 'cp', 'mv', 'touch', 'jest', 'vitest', 'tsc'],
    denyPatterns: ['rm -rf /', 'sudo ', 'shutdown', 'reboot', ':(){:|:&};:', 'curl ', 'wget ', 'nc ', 'ssh '],
    docker: { image: 'node:22-slim', network: 'none' },
  },
  memory: { enabled: true, autoLearn: true },
  governance: {
    enabled: true,
    defaultScope: { allowedUsers: [], allowedRepos: ['*'], allowedConnectors: ['*'], spendLimitPerDayUsd: 5.0 },
  },
  automations: {
    standup: { enabled: false, cron: '0 9 * * 1-5', channel: 'console:default' },
    stalePrs: { enabled: true, cron: '0 * * * *', idleHours: 24, channel: 'console:default' },
    prSummary: { enabled: true, event: 'pr.opened', channel: 'console:default' },
    sentrySignal: { enabled: false, channel: 'console:default' },
  },
};

/** Deep merge of partial YAML config onto defaults (arrays replace). */
function merge<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in (base as Record<string, unknown>) ? merge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function loadConfigFile(path: string): VigilConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return loadConfigFromString(readFileSync(path, 'utf8'));
}

export function loadConfigFromString(yamlText: string): VigilConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    throw new Error(`vigil: failed to parse config: ${(e as Error).message}`);
  }
  return merge(DEFAULT_CONFIG, parsed);
}

/** Look for .vigil.yml in a repo working dir (checked out copy), else defaults. */
export function loadRepoConfig(repoDir: string): VigilConfig {
  for (const name of ['.vigil.yml', '.vigil.yaml', '.vigil.yaml']) {
    const p = join(repoDir, name);
    if (existsSync(p)) return loadConfigFile(p);
  }
  return DEFAULT_CONFIG;
}

export function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Simple glob: supports ** (any depth), * (within segment), ? (single char). */
export function globMatch(pattern: string, path: string): boolean {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`).test(path);
}

export function pathIgnored(cfg: VigilConfig, path: string): boolean {
  if (cfg.review.paths.only.length > 0 && !cfg.review.paths.only.some((p) => globMatch(p, path))) return true;
  return cfg.review.paths.ignore.some((p) => globMatch(p, path));
}
