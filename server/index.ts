import dotenv from 'dotenv';
dotenv.config({ quiet: true });
// Local workspace convenience: credentials may live in the parent workspace's .env (never in this repo).
// dotenv never overrides variables that are already set, so the project .env and the real environment win.
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createPayPal } from './paypal/index.js';
import { createAgent } from './agent/hybrid.js';
import { TaktApp } from './app.js';

const paypal = createPayPal();
const publicBase = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
const app = new TaktApp(paypal, createAgent(), process.env.PAYPAL_CURRENCY ?? 'CHF', {
  returnUrl: `${publicBase}/api/paypal/return`,
  payoutReceiver: process.env.PAYPAL_SANDBOX_PAYOUT_RECEIVER || undefined,
});
const server = express();

// Webhook needs the raw body for signature verification -> register before json parser.
server.post('/api/webhooks/paypal', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  try {
    if (!(await paypal.verifyWebhook(headers, raw))) return res.status(400).json({ error: 'signature verification failed' });
    paypal.dispatch(JSON.parse(raw));
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

server.use(express.json({ limit: '200kb' }));

const wrap = (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req);
    res.json({ ok: true, result: out ?? null, state: app.snapshot() });
  } catch (e) {
    next(e);
  }
};

// Endpoints that may call Claude: small per-IP limit for the public demo (the LLM client also has a spend ceiling).
const hits = new Map<string, number[]>();
const llmLimit = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? 'local';
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= Number(process.env.AGENT_MAX_REQ_PER_IP_HOUR ?? 60)) return res.status(429).json({ ok: false, error: 'Demo rate limit reached, try again later' });
  list.push(now);
  hits.set(ip, list);
  next();
};
server.get('/healthz', (_req, res) => res.json({ ok: true }));
server.get('/api/state', (_req, res) => res.json(app.snapshot()));
server.get('/api/config', (_req, res) => res.json({ paypalMode: paypal.mode, paypalClientId: paypal.clientId ?? null, currency: app.state.modes.currency }));
server.post('/api/demo/reset', wrap(() => app.reset()));
server.post('/api/rush/intake', llmLimit, wrap((req) => app.intake(String(req.body?.text ?? ''))));
server.post('/api/rush/plan', llmLimit, wrap(() => app.plan()));
server.post('/api/offers/send', wrap(() => app.sendOffers()));
server.post('/api/offers/:id/reply', llmLimit, wrap((req) => app.reply(String(req.params.id), String(req.body?.text ?? ''))));
server.post('/api/approval/approve', wrap(() => app.approve()));
server.post('/api/offers/:id/respond', wrap((req) => app.respond(String(req.params.id), Boolean(req.body?.accept))));
server.post('/api/rush/mock-approve', wrap(() => app.mockApprove()));
// Sandbox: JS SDK onApprove -> server authorizes the order (commit still waits for the webhook / reconcile).
server.post('/api/rush/authorize', wrap((req) => app.authorizeRush(String(req.body?.orderId ?? ''))));
// Sandbox redirect flow: PayPal sends the buyer back here with ?token={orderId} after approval.
server.get('/api/paypal/return', async (req, res) => {
  try {
    await app.authorizeRush(String(req.query.token ?? ''));
  } catch (e) {
    console.error('authorize on return failed:', e instanceof Error ? e.message : e);
  }
  res.redirect('/');
});
server.post('/api/jobs/:id/ship', wrap((req) => app.ship(String(req.params.id))));
server.post('/api/jobs/:id/cancel', wrap((req) => app.cancel(String(req.params.id))));

server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
});

// Production: serve the built web app.
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../web/dist');
if (existsSync(dist)) {
  server.use(express.static(dist));
  server.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(`Takt API on http://localhost:${port} (PayPal: ${paypal.mode}, agent: ${app.state.agent.configured} ${app.state.agent.model}${process.env.ANTHROPIC_API_KEY ? '' : ', replay/fallback only'})`));
