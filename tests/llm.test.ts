import { afterEach, describe, expect, it } from 'vitest';
import { llmExtraHeaders, priceFor, llmConfigured } from '../src/core/llm.js';

describe('llm extra headers (LLM_HEADERS)', () => {
  const ORIGINAL = process.env.LLM_HEADERS;
  const ORIGINAL_PROVIDER = process.env.LLM_PROVIDER;
  const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
  const ORIGINAL_BASE = process.env.OPENAI_BASE_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LLM_HEADERS; else process.env.LLM_HEADERS = ORIGINAL;
    if (ORIGINAL_PROVIDER === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = ORIGINAL_PROVIDER;
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_BASE === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = ORIGINAL_BASE;
  });

  it('returns empty object when unset or blank', () => {
    delete process.env.LLM_HEADERS;
    expect(llmExtraHeaders()).toEqual({});
    process.env.LLM_HEADERS = '   ';
    expect(llmExtraHeaders()).toEqual({});
  });

  it('parses a JSON object of string headers', () => {
    process.env.LLM_HEADERS = '{"X-Token":"abc","X-Z-AI-From":"Z"}';
    expect(llmExtraHeaders()).toEqual({ 'X-Token': 'abc', 'X-Z-AI-From': 'Z' });
  });

  it('ignores non-string values, arrays and invalid JSON', () => {
    process.env.LLM_HEADERS = '{"a":"ok","b":123}';
    expect(llmExtraHeaders()).toEqual({ a: 'ok' });
    process.env.LLM_HEADERS = '["x"]';
    expect(llmExtraHeaders()).toEqual({});
    process.env.LLM_HEADERS = 'not json';
    expect(llmExtraHeaders()).toEqual({});
  });
});

describe('price table', () => {
  it('knows GLM pricing and treats flash/community models as free', () => {
    expect(priceFor('glm-4.6')).toEqual([0.6, 2.2]);
    expect(priceFor('glm-4.5-flash')).toEqual([0, 0]);
    expect(priceFor('gemma-3-27b-it')).toEqual([0, 0]);
  });

  it('lets env override any model price', () => {
    const pin = process.env.LLM_PRICE_IN_PER_M;
    const pout = process.env.LLM_PRICE_OUT_PER_M;
    process.env.LLM_PRICE_IN_PER_M = '1';
    process.env.LLM_PRICE_OUT_PER_M = '2';
    expect(priceFor('whatever-model')).toEqual([1, 2]);
    if (pin === undefined) delete process.env.LLM_PRICE_IN_PER_M; else process.env.LLM_PRICE_IN_PER_M = pin;
    if (pout === undefined) delete process.env.LLM_PRICE_OUT_PER_M; else process.env.LLM_PRICE_OUT_PER_M = pout;
  });
});

describe('llmConfigured', () => {
  it('mock provider is always configured', () => {
    process.env.LLM_PROVIDER = 'mock';
    expect(llmConfigured()).toBe(true);
  });

  it('openai provider needs a key or base url', () => {
    process.env.LLM_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    expect(llmConfigured()).toBe(false);
    process.env.OPENAI_BASE_URL = 'https://example.internal/v1';
    expect(llmConfigured()).toBe(true);
  });
});
