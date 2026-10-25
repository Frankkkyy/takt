import dotenv from 'dotenv';
dotenv.config({ quiet: true });
// Local workspace convenience: credentials may live in the parent workspace's .env (never in this repo).
// dotenv never overrides variables that are already set, so the project .env and the real environment win.
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
import { createPayPal } from './paypal/index.js';
import { createAgent } from './agent/hybrid.js';
import { LiveCallLimiter } from './agent/limits.js';
import { createServer } from './http.js';

const env = process.env;
const shared = createPayPal();
const limiter = new LiveCallLimiter({
  perSessionPerHour: Number(env.AGENT_MAX_LIVE_PER_SESSION_HOUR ?? 12),
  perIpPerHour: Number(env.AGENT_MAX_LIVE_PER_IP_HOUR ?? 40),
  perDay: Number(env.AGENT_MAX_LIVE_PER_DAY ?? 300),
});
const agent = createAgent(env, limiter);
const { server } = createServer({
  // Mock: each session gets its own offline gateway. Sandbox: one REST client shared by all sessions.
  gateway: () => (shared.mode === 'mock' ? createPayPal() : shared),
  webhookGateway: shared.mode === 'sandbox' ? shared : undefined,
  paypalMode: shared.mode,
  paypalClientId: shared.clientId ?? null,
  agent,
  limiter,
  currency: env.PAYPAL_CURRENCY ?? 'CHF',
  publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  payoutReceiver: env.PAYPAL_SANDBOX_PAYOUT_RECEIVER || undefined,
  sessionTtlMs: Number(env.DEMO_SESSION_TTL_MIN ?? 120) * 60_000,
  maxSessions: Number(env.DEMO_MAX_SESSIONS ?? 300),
});

const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`Takt API on http://localhost:${port} (PayPal: ${shared.mode}, agent: ${agent.status().configured} ${agent.status().model}${env.ANTHROPIC_API_KEY ? '' : ', replay/fallback only'}; one demo per browser session)`));
