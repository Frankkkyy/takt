// HTTP layer: Express app with per-session demo state, live-AI limits and the PayPal redirect / webhook routes.
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TaktApp } from './app.js';
import type { RushAgent } from './agent/agent.js';
import { liveScope, type LiveCallLimiter } from './agent/limits.js';
import type { PayPalGateway } from './paypal/gateway.js';
import { SESSION_COOKIE, SessionStore, readCookie, type Session } from './sessions.js';

export interface ServerDeps {
  /** Mock: a fresh gateway per session. Sandbox: one shared REST client (apps filter webhooks by their own ids). */
  gateway: () => PayPalGateway;
  /** Shared gateway for webhook verification (sandbox), undefined in mock mode. */
  webhookGateway?: PayPalGateway;
  paypalMode: 'mock' | 'sandbox';
  paypalClientId?: string | null;
  agent: RushAgent;
  limiter?: LiveCallLimiter;
  currency: string;
  /** PUBLIC_BASE_URL; when empty, derived from the first request of each session (works behind Render's proxy). */
  publicBaseUrl?: string;
  payoutReceiver?: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  /** experience_context.locale and JS SDK v6 locale (default en-CH). */
  paypalLocale?: string;
  /** Serve web/dist when it exists (production). */
  serveStatic?: boolean;
}

export function createServer(deps: ServerDeps) {
  const sessions = new SessionStore(
    (id) => new TaktApp(deps.gateway(), deps.agent, deps.currency, {
      returnUrl: `${baseFor.get(id)}/api/paypal/return`,
      cancelUrl: `${baseFor.get(id)}/api/paypal/cancel`,
      payoutReceiver: deps.payoutReceiver,
      locale: deps.paypalLocale,
      liveLeft: deps.limiter ? () => deps.limiter!.remaining(id) : undefined,
    }),
    { ttlMs: deps.sessionTtlMs ?? 2 * 3_600_000, max: deps.maxSessions ?? 300, onDrop: (id) => { baseFor.delete(id); deps.limiter?.forget(id); } },
  );
  const baseFor = new Map<string, string>();
  const server = express();
  // Render (and most PaaS) terminate TLS in one proxy hop: trust it, so req.ip / req.protocol are the client's.
  server.set('trust proxy', 1);

  const publicBase = (req: Request) => (deps.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  /** Session for this request (cookie), created on first contact. */
  const sessionOf = (req: Request, res: Response): Session => {
    const cookieId = readCookie(req.headers.cookie, SESSION_COOKIE);
    const known = sessions.peek(cookieId);
    if (known) return sessions.get(known.id).session;
    const id = SessionStore.validId(cookieId) ? cookieId : SessionStore.newId();
    baseFor.set(id, publicBase(req));
    const { session } = sessions.get(id);
    res.cookie(SESSION_COOKIE, session.id, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: deps.sessionTtlMs ?? 2 * 3_600_000, path: '/' });
    return session;
  };

  // Webhook needs the raw body for signature verification -> register before the json parser. Mock mode has no
  // public webhooks (the mock gateway emits its events internally), so nobody can inject fake PayPal events.
  server.post('/api/webhooks/paypal', express.raw({ type: '*/*' }), async (req, res) => {
    const gw = deps.webhookGateway;
    if (!gw || deps.paypalMode !== 'sandbox') return res.status(404).json({ error: 'webhooks are only used in sandbox mode' });
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    try {
      if (!(await gw.verifyWebhook(headers, raw))) return res.status(400).json({ error: 'signature verification failed' });
      gw.dispatch(JSON.parse(raw));
      res.sendStatus(200);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  server.use(express.json({ limit: '200kb' }));

  const wrap = (fn: (app: TaktApp, req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response, next: NextFunction) => {
    const s = sessionOf(req, res);
    try {
      // Live Claude calls made while handling this request are counted against this session and IP.
      const out = await liveScope.run({ sessionId: s.id, ip: req.ip }, () => fn(s.app, req));
      res.json({ ok: true, result: out ?? null, state: s.app.snapshot() });
    } catch (e) {
      next(e);
    }
  };

  server.get('/healthz', (_req, res) => res.json({ ok: true, sessions: sessions.size }));
  server.get('/api/state', (req, res) => res.json(sessionOf(req, res).app.snapshot()));
  server.get('/api/config', (_req, res) => res.json({ paypalMode: deps.paypalMode, paypalClientId: deps.paypalClientId ?? null, currency: deps.currency, paypalLocale: deps.paypalLocale ?? 'en-CH' }));
  // JS SDK v6: browser-safe client token (15 min, generated server-side; the secret never reaches the browser).
  server.get('/api/paypal/client-token', async (_req, res) => {
    const gw = deps.webhookGateway;
    if (deps.paypalMode !== 'sandbox' || !gw?.clientToken) return res.status(404).json({ error: 'client tokens exist only in sandbox mode' });
    try {
      res.set('Cache-Control', 'no-store').json(await gw.clientToken());
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.post('/api/demo/reset', wrap((app) => app.reset()));
  server.post('/api/rush/intake', wrap((app, req) => app.intake(String(req.body?.text ?? ''))));
  server.post('/api/rush/plan', wrap((app) => app.plan()));
  server.post('/api/offers/send', wrap((app) => app.sendOffers()));
  server.post('/api/offers/:id/reply', wrap((app, req) => app.reply(String(req.params.id), String(req.body?.text ?? ''))));
  server.post('/api/approval/approve', wrap((app) => app.approve()));
  server.post('/api/offers/:id/respond', wrap((app, req) => app.respond(String(req.params.id), Boolean(req.body?.accept))));
  server.post('/api/rush/mock-approve', wrap((app) => app.mockApprove()));
  server.post('/api/rush/mock-cancel', wrap((app) => app.mockCancel()));
  // Sandbox: JS SDK onApprove -> server authorizes the order (commit still waits for the webhook / reconcile).
  server.post('/api/rush/authorize', wrap((app, req) => app.authorizeRush(String(req.body?.orderId ?? ''), 'sdk')));
  // JS SDK onCancel: the buyer closed the PayPal window. Same handling as the redirect cancel_url.
  server.post('/api/rush/buyer-cancelled', wrap((app, req) => app.buyerCancelled(String(req.body?.orderId ?? ''), 'sdk')));

  // Sandbox redirect flow: PayPal sends the buyer back with ?token={orderId} (approved) or to cancel_url (cancelled).
  const owner = (req: Request) => {
    const token = String(req.query.token ?? '');
    const mine = sessions.peek(readCookie(req.headers.cookie, SESSION_COOKIE));
    return { token, s: mine?.app.ownsOrder(token) ? mine : sessions.findByOrder(token) };
  };
  server.get('/api/paypal/return', async (req, res) => {
    const { token, s } = owner(req);
    if (!s) {
      console.warn('PayPal return for an unknown order (session expired?)');
      return res.redirect('/?paypal=unknown');
    }
    try {
      await s.app.authorizeRush(token, 'redirect');
      res.redirect('/?paypal=approved');
    } catch (e) {
      // The app logged it and shows a notice in the console; keep a server trace too.
      console.warn('authorize on return failed:', e instanceof Error ? e.message : e);
      res.redirect('/?paypal=not-approved');
    }
  });
  server.get('/api/paypal/cancel', (req, res) => {
    const { token, s } = owner(req);
    if (s?.app.buyerCancelled(token)) console.info('PayPal buyer cancelled the rush order (session notified)');
    res.redirect('/?paypal=cancelled');
  });
  server.post('/api/jobs/:id/ship', wrap((app, req) => app.ship(String(req.params.id))));
  server.post('/api/jobs/:id/cancel', wrap((app, req) => app.cancel(String(req.params.id))));
  server.post('/api/jobs/:id/refund', wrap((app, req) => app.refund(String(req.params.id))));
  server.post('/api/jobs/:id/paypal-check', wrap((app, req) => app.checkPayPal(String(req.params.id))));

  server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });

  if (deps.serveStatic !== false) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.resolve(here, '../web/dist');
    if (existsSync(dist)) {
      server.use(express.static(dist));
      server.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    }
  }

  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();
  return { server, sessions };
}
