// Sandbox: verified command execution for fix verification.
// Profiles: local (allowlisted binaries, no network via env, timeout) and
// docker (docker run --network none) when docker is available.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { VigilConfig } from './config.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class Sandbox {
  constructor(private cfg: VigilConfig) {}

  private workRoot(): string {
    const root = resolve(process.cwd(), this.cfg.sandbox.workdir);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    return root;
  }

  newWorkspace(name: string): string {
    const ws = join(this.workRoot(), `${name}-${Date.now().toString(36)}`);
    mkdirSync(ws, { recursive: true });
    return ws;
  }

  releaseWorkspace(ws: string): void {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  async exec(command: string, cwd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? this.cfg.sandbox.timeoutMs;
    for (const bad of this.cfg.sandbox.denyPatterns) {
      if (command.includes(bad.trim()) && bad.trim().length > 1) {
        return { code: 126, stdout: '', stderr: `sandbox: command matches deny pattern "${bad.trim()}"`, durationMs: 0, timedOut: false };
      }
    }
    if (this.cfg.sandbox.profile === 'docker') {
      return this.execDocker(command, cwd, timeoutMs);
    }
    return this.execLocal(command, cwd, timeoutMs);
  }

  private async execLocal(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
    const bin = command.trim().split(/\s+/)[0] ?? '';
    if (!this.cfg.sandbox.allow.includes(bin)) {
      return { code: 126, stdout: '', stderr: `sandbox: binary "${bin}" is not in the allowlist (sandbox.allow in .vigil.yml)`, durationMs: 0, timedOut: false };
    }
    const start = Date.now();
    return new Promise<ExecResult>((resolve_) => {
      const child = spawn('sh', ['-c', command], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: cwd,
          CI: '1',
          NO_COLOR: '1',
          ...(this.cfg.sandbox.network ? {} : { http_proxy: 'http://0.0.0.0:9', https_proxy: 'http://0.0.0.0:9', npm_config_offline: 'true' }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 500_000) stdout = stdout.slice(-500_000); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve_({ code: 127, stdout, stderr: stderr + String(e), durationMs: Date.now() - start, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve_({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - start, timedOut });
      });
    });
  }

  private async execDocker(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
    const abs = resolve(cwd);
    const image = this.cfg.sandbox.docker.image;
    const network = this.cfg.sandbox.docker.network;
    const dockerCmd = `docker run --rm -v ${JSON.stringify(abs)}:/workspace -w /workspace --network ${network} --memory 2g --cpus 2 ${JSON.stringify(image)} sh -c ${JSON.stringify(command)}`;
    const start = Date.now();
    return new Promise<ExecResult>((resolve_) => {
      const child = spawn('sh', ['-c', dockerCmd], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 500_000) stdout = stdout.slice(-500_000); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve_({ code: 127, stdout, stderr: `docker profile unavailable: ${e.message}; falling back is NOT automatic — set sandbox.profile=local`, durationMs: Date.now() - start, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve_({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - start, timedOut });
      });
    });
  }
}
