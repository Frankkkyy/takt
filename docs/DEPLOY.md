# Deploying Takt on Render

Status: **plan only.** `render.yaml` is in the repo; nothing is deployed and no Render account has been created yet. Creating the account, choosing the plan and spending hackathon credits are Francisco's decisions.

## What gets deployed

One Node web service. A single process serves the API and the built React app on `$PORT` (Render sets it).

| | |
|---|---|
| Blueprint | [`render.yaml`](../render.yaml) |
| Runtime | Node 22 (`NODE_VERSION`; `package.json` needs ≥ 20.19) |
| Build | `npm ci --include=dev && npm run build` (typecheck + Vite build to `web/dist`) |
| Start | `npm start` (`NODE_ENV=production tsx server/index.ts`) |
| Health check | `GET /healthz` → `{"ok":true,"sessions":n}` |
| Region | Frankfurt (closest to Switzerland) |
| State | In memory, one demo shop per browser (cookie, 2 h TTL). A restart resets every demo; that is fine for a demo, and "Reset demo" exists anyway |
| Proxy | Express trusts one proxy hop, so client IPs (rate limits) and `https` are right behind Render |

Do **not** set `NODE_ENV=production` as an environment variable: `npm ci` would then skip the devDependencies the build needs. `npm start` sets it for the server.

## Environment variables

| Variable | Value | Notes |
|---|---|---|
| `PAYPAL_MODE` | `sandbox` | Sandbox only. The app has no live mode |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | sandbox app credentials | Secret (`sync: false`). The browser only ever gets a 15-minute client token |
| `PAYPAL_CURRENCY` | `CHF` | Verified in the sandbox for orders, captures, refunds and payouts |
| `PAYPAL_LOCALE` | `en-CH` | PayPal pages in English until the buyer logs in (see "Language" below) |
| `PAYPAL_SANDBOX_PAYOUT_RECEIVER` | sandbox personal account email | Payouts end `SUCCESS` instead of `UNCLAIMED` |
| `PAYPAL_WEBHOOK_ID` | optional | Register `https://<service>.onrender.com/api/webhooks/paypal` in the sandbox app (events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTS-ITEM.*`). Without it the app reconciles by polling, which is enough |
| `PUBLIC_BASE_URL` | `https://<service>.onrender.com` | Optional; otherwise taken from the request host |
| `ANTHROPIC_API_KEY` | project-budget key | Optional. Without it the scripted demo inputs replay recorded Claude output and anything else uses the rules agent. Set a spend limit in the Anthropic Console |
| `LLM_MODEL`, `LLM_EFFORT`, `AGENT_MAX_*`, `DEMO_*` | as in `render.yaml` | Live-AI limits per session, IP and day, plus a per-process USD ceiling |

`PAYPAL_SANDBOX_BUYER_EMAIL` / `PASSWORD` are for local Playwright runs only. Don't set them on Render.

## Steps (when Francisco gives the go)

1. Push the repo to GitHub (public, MIT).
2. Render dashboard → New → Blueprint → select the repo. Render reads `render.yaml` and asks for the `sync: false` values.
3. Wait for the first deploy; check `https://<service>.onrender.com/healthz`.
4. Open the app, run the demo path once with the judge buyer account (below).
5. Optional: register the webhook URL in the sandbox app and set `PAYPAL_WEBHOOK_ID`; redeploy.
6. Put the URL and the judge test account into the README.

## Free tier vs hackathon credits

| | Free | Starter (hackathon credits) |
|---|---|---|
| Cost | 0 | about USD 7 / month, paid from the credits |
| Sleep | After 15 min without traffic; the first request then waits about a minute | Never |
| Hours | 750 instance hours / month: enough for one service running all month | Unlimited |
| Restarts | On every wake-up (all demos reset) | Only on deploys |

**Recommendation:** Starter on the hackathon credits from submission until judging ends (mid-December). A judge opening the link should never wait a minute or see a reset shop. Change `plan: free` to `plan: starter` in `render.yaml` (or in the dashboard) once the credits are confirmed.

**Keep-alive if we stay on Free:** an external monitor pings `GET /healthz` every 10 minutes (for example UptimeRobot or cron-job.org free plans). One service pinged 24/7 uses about 744 h per month, under the 750 h limit, so only one free service can be kept awake this way. It also keeps the in-memory demos alive between visits. This uses a free external account, so it is also Francisco's call.

## How judges test

**Hosted:** the README will give the URL and a sandbox buyer account:

```
App:            https://<service>.onrender.com           (to fill in after deploy)
PayPal sandbox buyer (test money only, not a real account):
  email:        <judge sandbox personal account>          (to create, see below)
  password:     <its sandbox password>
Card (guest checkout on the PayPal page): 4005519200000004, any future expiry, CVV 123
```

Path: open the app → "Open request" → "Let Takt read it" → "Make room" → "Send 2 offers" → answer on the two phones (chips under "Demo helper") → "Approve & send to PayPal" → in the rush checkout, **Pay with PayPal** → log in with the buyer account in the PayPal popup → "Schedule committed" → Ship / Check in PayPal / Cancel rush (void).

Board move (before or after the rush): drag Atelier Rochat's bend bar two days later → "Send offer to Atelier Rochat" → accept on the phone → "Approve & send to PayPal" → the bar slides; Ship captures CHF 70 less. Rochat +2 days replays a recorded Claude draft; dragging any other job asks Claude live (counted against the live-AI limits above) or uses the rules template. No new environment variables.

**Judge buyer account (to create, sandbox only).** The workspace's current sandbox buyer is a Spanish account (Spanish pages, CaixaBank SEPA preselected), which is wrong for an English video and for judges. Francisco should create a dedicated one in developer.paypal.com → Testing Tools → Sandbox Accounts → Create account: **Personal**, country **Switzerland**, a password we can publish, a Visa card as funding source, and some balance. Its credentials are safe to publish: sandbox accounts only hold test money and cannot touch real funds.

**Language: what we can and can't force.**
- Forced: `experience_context.locale = en-CH` on the order and `locale: 'en-CH'` in the JS SDK. The PayPal login page in the popup and on the redirect is English (verified 26 Oct 2026).
- Not forceable: after login, PayPal shows the buyer **account's** language and country settings (review page, funding choices, currency conversion). A Swiss/English judge account fixes that for the shared credentials; a judge who logs in with their own sandbox account sees their own settings.

**Local run (no hosting needed):**

```bash
git clone <repo> && cd takt
npm install
npm run dev               # mock PayPal, recorded Claude: http://localhost:5173
# with sandbox credentials in .env (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET):
npm run dev:sandbox       # real PayPal sandbox, JS SDK v6 button
npm run build && npm start   # production build on http://localhost:8787
```

## After deploy: checks

- `GET /healthz` is 200; Render's health check uses it.
- `GET /api/config` shows `"paypalMode":"sandbox"`, `"paypalLocale":"en-CH"`.
- `GET /api/paypal/client-token` is 200 (no secret in the response, only a 15-minute token).
- `npm run screenshot https://<service>.onrender.com` passes against the hosted app (with `PAYPAL_SANDBOX_BUYER_*` set locally).
- Two browsers run the demo at the same time without seeing each other's state.
