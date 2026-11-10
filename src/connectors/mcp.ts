// Minimal MCP (Model Context Protocol) stdio client — lets Vigil plug into any
// MCP server's tools. NDJSON over stdin/stdout, JSON-RPC 2.0.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Connector, ConnectorQuery, ContextItem } from './types.js';
import { errUnknownAction } from './types.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { message: string } }
interface JsonRpcRequest { jsonrpc: '2.0'; id?: number; method: string; params?: unknown }
interface McpTool { name: string; description?: string; inputSchema?: unknown }

export async function listMcpTools(cfg: McpServerConfig): Promise<McpTool[]> {
  const client = new McpClient(cfg);
  try {
    await client.initialize();
    return await client.listTools();
  } finally {
    client.kill();
  }
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private ready = false;

  constructor(private cfg: McpServerConfig) {}

  private start(): void {
    if (this.proc && this.proc.exitCode === null) return;
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.resume(); // drain stderr to avoid blocking
    this.proc.on('exit', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`mcp: server ${this.cfg.name} exited`)); }
      this.pending.clear();
      this.proc = null;
      this.ready = false;
    });
  }

  kill(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse | JsonRpcRequest;
      try { msg = JSON.parse(line); } catch { continue; }
      // responses to our requests
      if ('id' in msg && (msg as JsonRpcResponse).id !== undefined && this.pending.has((msg as JsonRpcResponse).id)) {
        const id = (msg as JsonRpcResponse).id;
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const resp = msg as JsonRpcResponse;
        if (resp.error) p.reject(new Error(`mcp: ${resp.error.message}`));
        else p.resolve(resp.result);
        continue;
      }
      // server requests: answer ping, ignore others
      if ('method' in msg && msg.method === 'ping') {
        const reqMsg = msg as JsonRpcRequest;
        if (typeof reqMsg.id === 'number') this.send({ jsonrpc: '2.0', id: reqMsg.id, result: {} });
      }
    }
  }

  private send(msg: JsonRpcRequest | JsonRpcResponse): void {
    if (!this.proc?.stdin.writable) throw new Error('mcp: process not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill(); // dead/timeout server: respawn on next call
        reject(new Error(`mcp: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    this.start();
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vigil', version: '0.1.0' },
    }, 10000);
    this.notify('notifications/initialized');
    this.ready = true;
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request('tools/call', { name, arguments: args })) as { content?: { type: string; text?: string }[] };
    if (result?.content) {
      const texts = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
      if (texts.length > 0) return texts.join('\n');
    }
    return result;
  }
}

export function createMcpConnector(cfg: McpServerConfig): Connector {
  const client = new McpClient(cfg);
  let tools: McpTool[] | null = null;

  const ensureTools = async (): Promise<McpTool[]> => {
    if (!tools) {
      await client.initialize();
      tools = await client.listTools();
    }
    return tools;
  };

  return {
    id: `mcp.${cfg.name}`,
    label: `MCP: ${cfg.name}`,
    // capabilities: ['context', ...tool names] — context itself is [] (tools are actions)
    get capabilities() { return ['context']; },
    isConfigured: () => !!cfg.command,
    async fetchContext(_q: ConnectorQuery): Promise<ContextItem[]> {
      // MCP servers expose *tools* (actions), not a generic search surface.
      void _q;
      return [];
    },
    async runAction(name: string, args: Record<string, unknown>): Promise<unknown> {
      await ensureTools();
      if (!tools!.some((t) => t.name === name)) throw errUnknownAction(`mcp.${cfg.name}`, name);
      return client.callTool(name, args);
    },
    async health() {
      try {
        const list = await listMcpTools(cfg);
        return { ok: true, detail: `${list.length} tools` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
