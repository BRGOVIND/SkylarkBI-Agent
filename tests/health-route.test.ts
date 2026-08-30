import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * The health endpoint drives the UI's connection indicator. A cached response
 * would let the UI report a live monday.com connection while the backend is
 * actually down or unconfigured — observed in production QA, where a stale
 * "333 deals connected" was shown by a server that was reporting
 * not_configured. These tests lock the no-store behaviour in.
 */

const ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  for (const k of [
    'MONDAY_API_TOKEN', 'MONDAY_DEALS_BOARD_ID', 'MONDAY_WORK_ORDERS_BOARD_ID',
    'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'LLM_PROVIDER',
  ]) delete process.env[k];
});
afterEach(() => {
  process.env = { ...ENV };
});

describe('/api/health caching', () => {
  it('marks an unconfigured response no-store', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('never leaks a secret value in the unconfigured payload', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'AIzaSECRETVALUE';
    const { GET } = await import('@/app/api/health/route');
    const body = await (await GET()).text();
    expect(body).not.toContain('AIzaSECRETVALUE');
    // It may name the variable, never its value.
    expect(body).toMatch(/MONDAY_API_TOKEN/);
  });

  it('reports the selected provider and model without any key material', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'AIzaSECRETVALUE';
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    const { GET } = await import('@/app/api/health/route');
    const body = JSON.parse(await (await GET()).text());
    expect(body.llm).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash' });
    expect(JSON.stringify(body)).not.toMatch(/AIza/);
  });
});
