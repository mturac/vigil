// LLM layer — bring-your-own-model. Providers: openai (any OpenAI-compatible
// endpoint: OpenAI, Ollama, vLLM, OpenRouter, DeepSeek, Groq, LM Studio...),
// anthropic, and mock (deterministic, for tests/offline). No z-ai SDK anywhere.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type LlmProvider = 'openai' | 'anthropic' | 'mock';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string; // for role 'tool' (openai) / tool_result blocks
  toolName?: string;
  toolCalls?: { id: string; name: string; arguments: string }[]; // assistant history
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface LlmToolCall { id: string; name: string; arguments: string }

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// Rough public list prices (USD per 1M tokens) for cost attribution; env can override.
const PRICE_TABLE: Record<string, [number, number]> = {
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4-turbo': [10, 30],
  'gpt-4': [30, 60],
  'gpt-3.5-turbo': [0.5, 1.5],
  'o1': [15, 60],
  'o3-mini': [1.1, 4.4],
  'claude-3-5-sonnet-latest': [3, 15],
  'claude-3-5-sonnet-20241022': [3, 15],
  'claude-3-5-haiku-latest': [0.8, 4],
  'claude-3-opus-latest': [15, 75],
  'claude-3-haiku-20240307': [0.25, 1.25],
  // Z.ai / Zhipu public list prices (USD per 1M tokens) — override via env for exact billing
  'glm-4.6': [0.6, 2.2],
  'glm-4.5': [0.6, 2.2],
  'glm-4.5-air': [0.2, 1.1],
  'glm-4.5-flash': [0, 0], // free tier
  'gemma': [0, 0], // free community models (gemma-3-27b-it etc.)
  'deepseek-chat': [0.27, 1.1],
  'deepseek-reasoner': [0.55, 2.19],
};

export function priceFor(model: string): [number, number] {
  const pin = parseFloat(process.env.LLM_PRICE_IN_PER_M ?? '');
  const pout = parseFloat(process.env.LLM_PRICE_OUT_PER_M ?? '');
  if (Number.isFinite(pin) && Number.isFinite(pout)) return [pin, pout];
  const m = model.toLowerCase();
  // Longest matching key wins so versioned/variant models resolve to their
  // own entry (glm-4.5-flash must not inherit glm-4.5 pricing).
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICE_TABLE[key] : ([3, 15] as [number, number]); // conservative default
}

export function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const [pin, pout] = priceFor(model);
  return (promptTokens / 1e6) * pin + (completionTokens / 1e6) * pout;
}

export function llmConfigured(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? '') as LlmProvider;
  if (provider === 'mock') return true;
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY || !!process.env.OPENAI_BASE_URL;
  return false;
}

/**
 * Extra HTTP headers for the LLM endpoint, as a JSON object in LLM_HEADERS.
 * Needed by gateways that require side-car auth headers alongside the API key
 * (e.g. X-Token on some Z.ai gateway deployments, Azure apim subscription keys,
 * corporate proxies). Invalid JSON is ignored with a warning at call time.
 */
export function llmExtraHeaders(): Record<string, string> {
  const raw = process.env.LLM_HEADERS ?? '';
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  console.warn('vigil: LLM_HEADERS is set but is not a valid JSON object string; ignoring');
  return {};
}

export class Llm {
  readonly provider: LlmProvider;
  readonly model: string;
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;
  private mockCallCount = 0;

  constructor() {
    const p = (process.env.LLM_PROVIDER ?? '') as LlmProvider;
    this.provider = p === 'anthropic' || p === 'mock' ? p : 'openai';
    this.model =
      process.env.LLM_MODEL ??
      (this.provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : this.provider === 'mock' ? 'mock-1' : 'gpt-4o');
    if (this.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY ?? 'missing',
        baseURL: process.env.OPENAI_BASE_URL || undefined,
        defaultHeaders: llmExtraHeaders(),
        timeout: 120000,
        maxRetries: 2,
      });
    } else if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'missing', defaultHeaders: llmExtraHeaders(), timeout: 120000, maxRetries: 2 });
    }
  }

  get configured(): boolean {
    if (this.provider === 'mock') return true;
    if (this.provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
    return !!process.env.OPENAI_API_KEY || !!process.env.OPENAI_BASE_URL;
  }

  async chat(messages: LlmMessage[], tools?: LlmToolDef[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmResponse> {
    if (!this.configured) throw new Error('llm: no provider configured (set LLM_PROVIDER + credentials)');
    if (this.provider === 'mock') return this.mockChat(messages);
    if (this.provider === 'anthropic') return this.anthropicChat(messages, tools, opts);
    return this.openaiChat(messages, tools, opts);
  }

  // ---- OpenAI-compatible ----
  private async openaiChat(messages: LlmMessage[], tools?: LlmToolDef[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmResponse> {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        msgs.push({ role: 'tool', tool_call_id: m.toolCallId ?? 'x', content: m.content });
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        msgs.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
        });
      } else {
        msgs.push({ role: m.role as 'system' | 'user' | 'assistant', content: m.content });
      }
    }
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: msgs,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature ?? 0.2,
    };
    if (tools && tools.length > 0) {
      params.tools = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const res = await this.openai!.chat.completions.create(params);
    const choice = res.choices[0]?.message;
    const toolCalls = (choice?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    return {
      content: choice?.content ?? '',
      toolCalls,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      model: this.model,
    };
  }

  // ---- Anthropic ----
  private async anthropicChat(messages: LlmMessage[], tools?: LlmToolDef[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmResponse> {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const blocks: Anthropic.MessageParam[] = [];
    for (const m of rest) {
      if (m.role === 'tool') {
        blocks.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? 'x', content: m.content }],
        });
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments || '{}') as Record<string, unknown> });
        }
        blocks.push({ role: 'assistant', content });
      } else {
        blocks.push({ role: m.role as 'user' | 'assistant', content: [{ type: 'text', text: m.content }] });
      }
    }
    const res = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature ?? 0.2,
      ...(sys ? { system: sys } : {}),
      messages: blocks,
      ...(tools && tools.length > 0
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
        : {}),
    });
    let content = '';
    const toolCalls: LlmToolCall[] = [];
    for (const b of res.content) {
      if (b.type === 'text') content += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
    return {
      content,
      toolCalls,
      promptTokens: res.usage.input_tokens,
      completionTokens: res.usage.output_tokens,
      model: this.model,
    };
  }

  // ---- Mock (tests / offline demos) ----
  private mockChat(messages: LlmMessage[]): LlmResponse {
    this.mockCallCount++;
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // scripted fix flow: exercises the full FixEngine pipeline deterministically
    if (system.includes('autonomous software engineer')) {
      const lastWasTool = messages[messages.length - 1]?.role === 'tool';
      if (!lastWasTool) {
        const patchPath = process.env.VIGIL_MOCK_FIX_PATH ?? 'VIGIL_FIX.md';
        const patchBody = process.env.VIGIL_MOCK_FIX_BODY ?? 'Fixed by Vigil (mock provider scripted fix).\n';
        return {
          content: '',
          toolCalls: [{ id: 'mock-1', name: 'write_file', arguments: JSON.stringify({ path: patchPath, content: patchBody }) }],
          promptTokens: 50, completionTokens: 20, model: 'mock-1',
        };
      }
      return {
        content: '',
        toolCalls: [{ id: 'mock-2', name: 'finish', arguments: JSON.stringify({ summary: 'Mock fix applied marker file (scripted).' }) }],
        promptTokens: 60, completionTokens: 15, model: 'mock-1',
      };
    }

    let content = '';
    const lower = lastUser.toLowerCase();
    if (lower.includes('json') || lower.includes('finding') || lower.includes('review')) {
      content = JSON.stringify({
        walkthrough: { 'src/app.ts': 'Adds a helper function and wires it into the module exports.' },
        findings: [
          {
            path: 'src/app.ts',
            line: 3,
            severity: 'medium',
            category: 'quality',
            title: 'Unhandled promise',
            detail: 'The async call on line 3 has no await or .catch, so rejections become unhandled.',
            suggestion: 'Await the call or attach a .catch handler.',
            confidence: 80,
          },
        ],
      });
    } else {
      content = `MOCK RESPONSE ${this.mockCallCount}: I analyzed "${lastUser.slice(0, 120)}". No further tools needed. Conclusion: mock analysis complete.`;
    }
    return {
      content,
      toolCalls: [],
      promptTokens: Math.ceil(lastUser.length / 4) + 10,
      completionTokens: Math.ceil(content.length / 4) + 5,
      model: 'mock-1',
    };
  }
}

export const llm = new Llm();
