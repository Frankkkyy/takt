// HTTP layer: per-session demo state, live-AI limits that ignore replays, trust proxy, PayPal cancel redirect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { createServer } from './http.js';
import { MockPayPal } from './paypal/mock.js';
import { DeterministicAgent } from './agent/deterministic.js';
import { HybridAgent } from './agent/hybrid.js';
import { ClaudeAgent } from './agent/claude.js';
import { LlmClient, type LlmTransport } from './agent/llm.js';
import { LiveCallLimiter } from './agent/limits.js';
import type { RushAgent } from './agent/agent.js';
import type { DemoState } from '../shared/types.js';

const REQUEST = 'Need 6x brackets S355 8 mm by Tuesday — Thomas Schmid, Escholzmatt';

/** Fake Claude for intake only: records the job from whatever text it gets. */
const fakeIntake = (): LlmTransport & { calls: number } => {
  const t = {
    calls: 0,
    async create(p: Anthropic.MessageCreateParamsNonStreaming) {
      t.calls++;
      const qty = Number(/(\d+)x/.exec(JSON.stringify(p.messages[0].content))?.[1] ?? 6);
      return {
        id: `m${t.calls}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'tool_use', id: `tu${t.calls}`, name: 'record_rush_job', input: { customer_name: 'Hof Schmid', contact_name: 'Thomas Schmid', city: 'Escholzmatt', language: 'en', part_family: 'bracket', part_title: 'Brackets', quantity: qty, material_grade: 'S355', thickness_mm: 8, due_day: 1, notes: '' } }],
      } as unknown as Anthropic.Message;
    },
  };
  return t;
};

async function start(agent: RushAgent, limiter?: LiveCallLimiter) {
  const { server } = createServer({ gateway: () => new MockPayPal(5), paypalMode: 'mock', agent, limiter, currency: 'CHF', serveStatic: false });
  const http = server.listen(0);
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => http.close(r)), trustProxy: server.get('trust proxy') };
}

/** A browser: keeps its own cookie. */
function client(base: string, headers: Record<string, string> = {}) {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  return {
    state: async () => (await (await call('GET', '/api/state')).json()) as DemoState,
    post: async (p: string, body?: unknown) => (await call('POST', p, body ?? {})).json() as Promise<{ ok: boolean; error?: string; state: DemoState }>,
    get: call.bind(null, 'GET'),
  };
}

test('B4: each browser session gets its own demo; Reset only resets your own', async () => {
  const s = await start(new DeterministicAgent());
  try {
    const a = client(s.base);
    const b = client(s.base);
    await a.state();
    await b.state();
    const r = await a.post('/api/rush/intake', { text: REQUEST });
    assert.equal(r.ok, true);
    assert.equal((await a.state()).stage, 'intake');
    assert.equal((await b.state()).stage, 'idle');
    await a.post('/api/rush/plan');
    await b.post('/api/demo/reset');
    assert.equal((await a.state()).stage, 'planned', "B's reset did not touch A");
    assert.equal(s.trustProxy, 1);
  } finally {
    await s.close();
  }
});

test('B3: replayed (recorded) calls are never rate-limited; live calls are limited per session, then fall back visibly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'takt-http-'));
  const fake = fakeIntake();
  const limiter = new LiveCallLimiter({ perSessionPerHour: 1, perIpPerHour: 100, perDay: 100 });
  const agent = new HybridAgent(new ClaudeAgent(new LlmClient({ model: 'claude-haiku-5-5', cacheDir: dir, cacheMode: 'replay-or-live', record: true, maxUsd: 1, limiter }, fake)));
  const s = await start(agent, limiter);
  try {
    const a = client(s.base);
    let st = (await a.post('/api/rush/intake', { text: REQUEST })).state;
    assert.equal(st.agent.last, 'live');
    for (let i = 0; i < 30; i++) {
      st = (await a.post('/api/rush/intake', { text: REQUEST })).state; // same input -> recorded response
      assert.equal(st.agent.last, 'replay', `replay ${i} must not be limited`);
    }
    assert.equal(fake.calls, 1);
    st = (await a.post('/api/rush/intake', { text: 'Need 8x brackets S355 8 mm by Tuesday — Thomas Schmid, Escholzmatt' })).state;
    assert.equal(st.agent.last, 'fallback');
    assert.match(st.agent.fallbackReason ?? '', /limit for this demo session/);
    assert.equal(st.rush?.qty, 8, 'the rules fallback still answers');
    assert.equal(st.agent.liveLeft?.session, 0);
    // another session still has its own live budget
    const b = client(s.base);
    const sb = (await b.post('/api/rush/intake', { text: 'Need 4x brackets S355 8 mm by Tuesday — Thomas Schmid, Escholzmatt' })).state;
    assert.equal(sb.agent.last, 'live');
  } finally {
    await s.close();
  }
});

test('B3: per-IP limit uses the client IP from the proxy (trust proxy) and a global daily cap protects the budget', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'takt-http-'));
  const limiter = new LiveCallLimiter({ perSessionPerHour: 10, perIpPerHour: 1, perDay: 2 });
  const agent = new HybridAgent(new ClaudeAgent(new LlmClient({ model: 'claude-haiku-5-5', cacheDir: dir, cacheMode: 'live-only', maxUsd: 1, limiter }, fakeIntake())));
  const s = await start(agent, limiter);
  try {
    const one = { 'X-Forwarded-For': '203.0.113.7' };
    const r1 = (await client(s.base, one).post('/api/rush/intake', { text: REQUEST })).state;
    assert.equal(r1.agent.last, 'live');
    const r2 = (await client(s.base, one).post('/api/rush/intake', { text: REQUEST })).state; // new session, same IP
    assert.match(r2.agent.fallbackReason ?? '', /network/);
    const r3 = (await client(s.base, { 'X-Forwarded-For': '198.51.100.9' }).post('/api/rush/intake', { text: REQUEST })).state;
    assert.equal(r3.agent.last, 'live');
    const r4 = (await client(s.base, { 'X-Forwarded-For': '192.0.2.44' }).post('/api/rush/intake', { text: REQUEST })).state;
    assert.match(r4.agent.fallbackReason ?? '', /daily live-AI cap/);
  } finally {
    await s.close();
  }
});

test('B8: PayPal cancel redirect is routed to the session that owns the order and shown there', async () => {
  const s = await start(new DeterministicAgent());
  try {
    const a = client(s.base);
    await a.post('/api/rush/intake', { text: REQUEST });
    const plan = (await a.post('/api/rush/plan')).state.plan!;
    await a.post('/api/offers/send');
    for (const o of plan.offers) await a.post(`/api/offers/${o.id}/respond`, { accept: true });
    const st = (await a.post('/api/approval/approve')).state;
    const orderId = st.rushOrder!.orderId;
    const r = await client(s.base).get(`/api/paypal/cancel?token=${orderId}`); // e.g. the buyer's own browser
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location') ?? '', /paypal=cancelled/);
    const after = await a.state();
    assert.equal(after.paypalNotice?.kind, 'cancelled');
    assert.ok(after.ledger.some((l) => l.title === 'Buyer cancelled in PayPal'));
  } finally {
    await s.close();
  }
});

test('mock mode exposes no public webhook endpoint (no fake PayPal events)', async () => {
  const s = await start(new DeterministicAgent());
  try {
    const r = await fetch(`${s.base}/api/webhooks/paypal`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
  } finally {
    await s.close();
  }
});
