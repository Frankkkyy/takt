# Takt — QA log

## Run 2026-10-25 (mid-build, commit `6be951b`)

**Setup.** Fresh `git clone` of the local repo into a temp dir, README steps only (`npm install`, `cp .env.example .env`, `npm test`, `npm run agent:eval`, `npm run dev`, `npm run build && npm start`). The Anthropic key was never passed: `ANTHROPIC_API_KEY=` and `AGENT_CACHE=replay-only`, so Claude output came only from the recorded responses (0 live calls, USD 0). Playwright 1.61 headless Chromium: owner console at 1440×900, customer offer pages at 390×844 (mobile emulation). Mock mode: demo path 5×, then edge cases. Sandbox mode (`PAYPAL_MODE=sandbox`, workspace credentials): one pass of the demo path, including a buyer "cancel" on PayPal's approval page.

Screenshots: `qa/mock/` (d* = owner console, m* = phone offer pages, e* = edge cases) and `qa/sandbox/` (s*). **Do not publish `qa/sandbox/`**: it shows the sandbox buyer's PayPal pages (fake data, but it's an account page).

### What passed
| Check | Result |
|---|---|
| Fresh clone → `npm install` | 2 s, 0 vulnerabilities, no friction |
| `npm test` | 18/18 pass in ~1 s · `npm run typecheck` clean |
| `npm run agent:eval` (replay) | 13/13 pass, 0 live calls, USD 0 |
| `npm run build && npm start` | Builds in 4 s; one process serves API + SPA on :8787; demo path passes; deep links return 200 |
| Demo path ×5, mock, EN sample, phones answer FR counter + DE yes | **5/5 reached "Schedule committed"**, ~6 s each, net uplift CHF 570 every time, agent badge "Claude Haiku 5.5 · recorded" throughout. No console errors on the path (see B2 for Ship) |
| Refresh owner console mid-flow (offers sent) | State survives (server-side) |
| Refresh phone after accepting | Shows "✓ Danke! Ihr neuer Liefertermin ist bestätigt." |
| Double-click "Approve & send to PayPal" | 1 payout, 1 rush order, no error shown. 3 concurrent POSTs: 1 ok, 2 × "Nothing to approve", still 1 payout |
| Accept + decline race on the same offer | First wins, no corruption |
| Decline (button, FR customer) | Re-plans without Rochat: new offer to Brunner Velos (DE, CHF 55), Meier kept. `e1-*` |
| Counter over cap (FR, recorded) "OK, but only for CHF 900." | Refused in French, counter at CHF 70 (cap 321). `e2-overcap-phone.png` |
| Prompt injection (DE customer) | Escalated to owner, nothing changed, no PayPal call |
| Empty rush request | Rejected ("Empty request") |
| Sandbox: owner approve → payout + seeded booking authorization + rush AUTHORIZE order | Link shown 6 s after approve; payout item **SUCCESS** after ~20 s; buyer approval (after a cancel, same order) → reconcile → **committed** in ~2 s; rush capture CHF 2055 OK |
| Secret scan (working tree + full git history) against the workspace `.env` values | 0 hits |

## Fix run 2026-10-26 (engineer, after mid-build review)

Evidence (all on the fix commit):
- `npm test`: **35/35 pass** (was 18). New: B1/B2 repeat-run Ship ×5 after Reset on one mock gateway (the mock now rejects a reused `invoice_id` with `DUPLICATE_TRANSACTION`, like PayPal), double-click Ship captures once, FR squeeze, no "too late" text when it fits, B6 one-step concession then owner, B7 "hello" → owner question, B8 cancel → notice and later approval, B4 two apps on one gateway ignore each other's events, B19 retry after a PayPal 503 pays once, B13 declined link, HTTP tests (separate sessions and resets, 30 replays not limited while the 2nd live call falls back with a visible reason, per-IP limit via `X-Forwarded-For` + daily cap, cancel redirect routed to the owning session, no webhook route in mock), recorded DE and FR paths replay with 0 live calls.
- `npm run agent:eval`: **17/17** (new FR intake/plan + Rochat FR counter and Meier DE yes on the DE and FR paths recorded live). Live spend for re-recording: **USD 0.0034** (7 calls).
- `npm run smoke:sandbox`: **14/14** (buyer login now picks the card funding instead of SEPA).
- Playwright demo path, mock (`DEMO_RUNS=3`, Reset between runs, buyer cancel then pay): **18/18 checks**, Ship J-2044 "captured CHF 2'610 of CHF 2'680" on all 3 runs, 0 console errors.
- Playwright demo path, **sandbox** (`DEMO_CANCEL_FIRST=1`): **9/9 checks**. Buyer pressed "Cancelar y volver" on PayPal → back at `/?paypal=cancelled`, console notice shown; then approved → committed → **Ship J-2044 captured CHF 2'610 of 2'680 with no DUPLICATE_TRANSACTION** (this sandbox account had already used `TAKT-J-2044` in the QA run, so the old code would have failed here).
- Secret scan of the working tree and full git history against the workspace `.env` values: 0 hits. `qa/sandbox/` is now in `.gitignore`.
- Screenshots: `docs/screenshots/` (mock, incl. `0-cold-open`, `4d-buyer-cancelled`, `m-offer-rochat` at 390 px) and `docs/screenshots/sandbox/`.

New in the UI: a cold open (machine utilisation, the rush email slides in, hook line "Airlines pay passengers who can wait. Takt does it for factories, with PayPal."), board at 1-week zoom with customer names first, plain-language log with tool JSON behind a toggle, "Open … page on a phone" links, a visible note whenever the rules fallback answers, localised offer pages.

Still open (at that time): B9 account setting, B10 (JS SDK v6 rush phone), B20 (PayPal page locale), Bryntum (from 31 Oct).

## Engineer run 2026-10-26 (JS SDK v6, PayPal timeline, deploy plan) — for qa-tester to re-check

What changed:
- **Rush checkout with the PayPal JS SDK v6** (`web/src/components/PayPal.tsx`): inline in the console and at `#/pay` (phone). Browser-safe client token from `GET /api/paypal/client-token` (client id fallback), `createInstance({ …, locale: 'en-CH' })`, `findEligibleMethods({ currencyCode: 'CHF' })`, `createPayPalOneTimePaymentSession`, `start({ presentationMode: 'auto' }, Promise.resolve({ orderId }))`. `onApprove` → `POST /api/rush/authorize`, `onCancel` → `POST /api/rush/buyer-cancelled`. Redirect link kept as fallback (and shown as the main button if the SDK fails to load).
- **English PayPal pages:** `experience_context.locale = en-CH` on the rush order (`PAYPAL_LOCALE`). Login page is English; after login PayPal uses the buyer account's language (see B20).
- **PayPal timeline per job** in Settle (and for the rush order while it waits): every PayPal id with status, marked call / buyer / PayPal-confirmed / live check; authorization, capture and refund ids link to the sandbox merchant view. **Check in PayPal** runs live `GET`s. **Cancel rush (void)** before shipment, **Parts returned: refund** after shipment; the yield drops by the premium, compensations stay.
- Seeded bookings: no buyer flow applies (they are past bookings), so they keep the sandbox test-card authorizations; documented, unchanged.
- `docs/DEPLOY.md` + `render.yaml` (not deployed, no accounts created).

Evidence:
- `npm test`: **39/39** (new: SDK onApprove + webhook arrive together → one authorization and a full timeline; rush void before shipment with yield and compensations; refund after shipment + live check + payout confirmation on the job timeline; HTTP onCancel route, `en-CH` config, no client token in mock). `npm run typecheck` and `npm run build` clean.
- `npm run smoke:sandbox`: **16/16** (new: client token issued, 900 s; rush cancelled after shipment → refund the rest, capture `REFUNDED`).
- Playwright **sandbox, JS SDK popup** (`DEMO_CANCEL_FIRST=1`, final run): **14/14**: SDK button rendered with client token and locale `en-CH`; closing the popup shows the onCancel notice; popup on `www.sandbox.paypal.com` with `<html lang="en-CH">`; authorized through `onApprove`; committed; Ship J-2044 captured CHF 2'610 of 2'680; Check in PayPal; Cancel rush (void). Over the session 6 of 8 SDK runs passed first time (see SPIKE.md: one popup that didn't close, one race now fixed). Redirect fallback (`PAY_VIA=redirect`): 2/2.
- Playwright **mock** (`DEMO_RUNS=3`): **20/20**, 0 console errors. Production build (`npm start`): `/healthz` 200, SPA 200, client-token 404 in mock.
- Screenshots: `docs/screenshots/` (mock) and `docs/screenshots/sandbox/` (new: `4a-sandbox-sdk-button`, `4b-sandbox-paypal-popup-login` (English login, no account data), `5b-paypal-timeline`, `6-rush-cancelled-void`). PayPal pages after the buyer's login go to `qa/sandbox/` (gitignored). The old `4b-sandbox-paypal-checkout.png` (Spanish account page) was removed from `docs/`.

Still open: B9/B20 need a Swiss/English sandbox buyer account (Francisco), Bryntum (from 31 Oct), deploy (Francisco's go). The sandbox merchant-view links (`/activity/payment/{id}`) need the sandbox business login and were not opened in this run.

### Bugs

| # | Sev | Title | Status |
|---|---|---|---|
| B1 | **blocker** | Sandbox "Ship" (capture less) fails with `422 DUPLICATE_TRANSACTION` | **fixed** (run id in invoice_id, stable PayPal-Request-Id) |
| B2 | **major** | Mock: after "Reset demo", Ship J-2044 fails `AUTHORIZATION_ALREADY_CAPTURED` | **fixed** (seed auth ids per run) |
| B3 | **major** | Per-IP limit counts free replayed calls and ignores proxies: hosted demo locks everyone out after ~15 runs/hour | **fixed** (only live calls counted; per session/IP/day; trust proxy) |
| B4 | **major** | One global in-memory demo for all visitors (hosted demo) | **fixed** (cookie session → own TaktApp, 2 h TTL) |
| B5 | **major** | FR sample contradicts itself and bumps nobody | **fixed** (new FR sample, conditional texts) |
| B6 | **major** | Rules fallback concedes the full cap in negotiation | **fixed** (minimal-concession policy, also for Claude) |
| B7 | **major** | Rules fallback invents a rush job from any text | **fixed** (asks the owner) |
| B8 | **major** | Buyer cancels on PayPal → console gives no feedback | **fixed** (cancel_url route, log + notice) |
| B9 | major (test data) | Sandbox buyer defaults to SEPA bank funding in Spanish; headless helper hangs | mitigated in scripts (card funding picked); account setting still open (Francisco) |
| B10 | minor | Rush customer pays from the owner console; plain link, not JS SDK v6 | **fixed** (JS SDK v6 button, `#/pay` phone checkout, redirect fallback) |
| B11 | minor | Demo reply chips (incl. "Injection") shown to customers, all languages on every offer | **fixed** (same-language chips in a collapsed "Demo helper") |
| B12 | minor | Offer page dates not localized ("Tue 27.10." on FR/DE pages) | **fixed** |
| B13 | minor | Declined customer's link shows "Offer not found or expired." | **fixed** |
| B14 | minor | Phone bezel drawn inside a real phone at 390 px | **fixed** |
| B15 | minor | Board unreadable in a video; raw JSON tool dumps dominate the log | partly fixed (1-week zoom default, log humanised, header); Bryntum pending |
| B16 | minor | `npm run agent:eval` overwrites docs/AGENT_EVAL.md with a 0-token replay report | **fixed** (replay-only runs do not write the report) |
| B17 | minor | README lists refund / void / reauthorize, but the app UI can't trigger them | **fixed** (README labels void/refund/reauthorize as API/smoke-verified) |
| B18 | minor | `PUBLIC_BASE_URL` defaults to :5173, so the sandbox return URL breaks under `npm start` / hosting | **fixed** (derived from request host when unset; documented for Render) |
| B19 | minor (code review) | Approval can get stuck if a PayPal call fails halfway through approve() | **fixed** (per-move retry, no double payout) |
| B20 | minor | PayPal approval page language is German (CH) even with an English browser | partly fixed: `locale en-CH` → English login page; after login PayPal uses the buyer account's language (needs a Swiss/English sandbox buyer) |

#### B1 — blocker — Sandbox capture-less fails with DUPLICATE_TRANSACTION
- **Steps:** sandbox mode → full demo path → Schedule committed → Settle → "Ship" on J-2044 (Atelier Rochat, capture CHF 2610 of 2680).
- **Expected:** `POST /v2/payments/authorizations/{id}/capture` CHF 2610, `final_capture=true` → COMPLETED.
- **Actual:** red callout `PayPal 422 DUPLICATE_TRANSACTION`. The rush job's capture (unique id) works. Cause: `ship()` sends `invoice_id: TAKT-${job.id}` (`server/app.ts`), which is the same on every demo run. PayPal rejects a second capture with an invoice id the merchant account has already used, so **every sandbox run after the first fails at the "CHF 70 less" moment**, the core mechanic, in the video and on the hosted demo. Fix: suffix the invoice id per run (as `createRushOrder` already does).
- **Screenshot:** `qa/sandbox/s7-settled.png`

#### B2 — major — Mock: Ship fails after Reset demo
- **Steps:** mock mode → demo path → Ship J-2044 (works) → Reset demo → demo path again → Ship J-2044.
- **Expected:** capture CHF 2610. **Actual:** HTTP 400 `AUTHORIZATION_ALREADY_CAPTURED` (4 of 5 runs). `MockPayPal` keeps its authorization map across resets, and seeded ids are deterministic (`SEED-AUTH-J-2044-000OFW`).
- This breaks rehearsals and any hosted mock demo after the first visitor.

#### B3 — major — Rate limit vs hosted demo
- **Steps:** run the demo path ~13–15 times within an hour from one IP.
- **Actual:** intake/plan/reply return `429 Demo rate limit reached` even though every call was a free replay. (Hit during this QA run; I re-ran with `AGENT_MAX_REQ_PER_IP_HOUR=100000`.)
- Express has no `trust proxy` set, so behind Render's proxy all visitors share one `req.ip`: **60 requests/hour for all judges together**.
- Fix: count only live Claude calls; set `app.set('trust proxy', 1)`.

#### B4 — major — Single shared demo state (hosted)
- All visitors share one `TaktApp`. Judge A's "Reset demo" wipes judge B's flow mid-way, and two judges can't run the path at the same time.
- A Render restart or free-tier sleep wipes the state, and open offer links then show "Offer not found or expired."
- Fix: one demo instance per browser session (cookie → `TaktApp`, with a TTL).

#### B5 — major — FR sample: "Takt can make room" with no one to ask, plus contradictory text
- **Steps:** chip "FR email" → Let Takt read it → Make room.
- **Actual:**
  - The intake callout says "The laser and press brake are fully booked".
  - The plan says "Without moving anyone, the earliest delivery would be Friday 6 Nov — too late", next to Claude's "The rush job fits into the existing schedule without bumping anyone" and option 1A at CHF 0.
  - "Send offers" is shown with zero offers.
  - So the French intake never reaches a negotiation.
- **Screenshot:** `qa/mock/e6-fr-sample-plan.png`

#### B6 — major — Rules fallback concedes the whole cap
- **Steps:** any reply that is not recorded, while Claude is unavailable (no key, replay-only, spend ceiling or rate limit). Example: DE customer "Gerne, aber nur für CHF 900."
- **Actual:** the shop replies "höchstens CHF 288" and the offer jumps from CHF 45 to CHF 288 for a one-day delay (6×). Within guardrails, but it gives away CHF 243 of a CHF 685 premium. A judge typing their own counter on a hosted demo without a live key sees this.

#### B7 — major — Rules fallback invents a job
- **Steps:** type "hello" → Let Takt read it.
- **Actual:** it becomes "1× Parts (rush), S355 3 mm, Hof Schmid (farm), due Tue 27 Oct, base CHF 355", with a feasible plan and rush price CHF 535. It should ask for the missing part, quantity and date instead.
- **Screenshot:** `qa/mock/e5-garbage-intake.png`

#### B8 — major — Buyer cancels on PayPal: silent
- **Steps:** sandbox → Pay with PayPal → on PayPal, "Abbrechen und zurück zu Takt demo shop".
- **Actual:**
  - PayPal redirects to `cancel_url` = the return URL.
  - The server tries `/authorize`, gets `422 ORDER_NOT_APPROVED`, logs it to stdout only, and redirects to `/`.
  - The console keeps saying "Waiting for the buyer to approve in PayPal…", with nothing in the PayPal & agent log.
- **Good:** the same order can still be approved afterwards (verified).
- **Expected:** a distinct `cancel_url` and a log entry plus UI note, e.g. "Buyer cancelled in PayPal: the link is still valid".
- **Screenshot:** `qa/sandbox/s3-after-paypal-cancel.png`

#### B9 — major for judge testing — Sandbox buyer account funding
- **What happens:** logging in with the workspace sandbox personal account shows the review page in Spanish, with CaixaBank SEPA preselected (`s4-paypal-review.png`). "Continue" then opens a SEPA direct-debit mandate (`s4b-paypal-after-submit.png`).
- **Impact:** `scripts/paypal-approve.ts` doesn't handle this, so it waits until timeout. A judge would see a Spanish SEPA mandate.
- **Workaround:** choosing "Visa" completes the approval.
- **Fix (test data):** set the sandbox buyer's preferred funding to card or balance, and English or German locale. Use that account in the Devpost testing instructions.

#### B10 — minor — Rush customer UX
The rush customer's "Pay with PayPal (sandbox)" is an underlined link inside the owner console (`s1-awaiting-payment.png`), so the owner seems to pay for the customer. Planned: JS SDK v6 button on a rush-customer phone page.

#### B11 — minor — Demo chips on the customer page
Every offer page shows "Counter (FR) · Yes (DE) · No (EN) · Injection" to the customer (`m-offer-rochat.png`). Clicking the FR counter on the DE customer goes to the rules fallback. Fix: show only same-language chips, in a "demo helper" drawer.

#### B12 — minor — Dates not localized
The FR and DE offer pages show "Tue 27.10. → Wed 28.10.". Should read "mar. 27.10." / "Di 27.10.".

#### B13 — minor — Declined link expires
Right after Rochat declines, reloading his link shows "Offer not found or expired." (re-planning replaces the offers). Expected: "Pas de souci — votre date reste."

#### B14 — minor — Bezel inside a phone
At 390 px the offer page draws a phone frame inside the phone, which costs about 50 px of width (`m-offer-*.png`). Drop the frame below ~500 px.

#### B15 — minor — Video readability
- **Board at 1440:** labels are truncated over 2 weeks ("J-204 / Kelle"). A one-day bump moves bars by only a few hours, so the "moved" moment is nearly invisible (`d3-plan.png`, `d6b-committed-top.png`).
- **Log:** raw `{"job_id":…}` tool JSON fills the PayPal & agent log (`d7-settled.png`).
- **390 px:** the owner console is unusable (`e7-owner-console-390.png`); acceptable if the console is desktop-only.
- **1280 px:** the header wraps.

#### B16 — minor — Eval overwrites evidence
`npm run agent:eval` (the README command) rewrites `docs/AGENT_EVAL.md` with "0 input / 0 output tokens", which dirties the tree and replaces the live-run evidence. Write replay runs to stdout only.

#### B17 — minor — README vs app
"How PayPal is used" lists the late-delivery refund, cancellation void and reauthorize. The UI only has Ship (capture). `/api/jobs/:id/cancel` has no button, and refund/reauthorize exist only in `sandbox-smoke.ts`. Rules: the project "must function as depicted … in the text description". Add UI for refund and void, or label them "verified by smoke script".

#### B18 — minor — Return URL in production
`PUBLIC_BASE_URL` defaults to `http://localhost:5173`. Under `npm start` (port 8787) or on Render, PayPal sends the buyer to a dead URL; the reconcile poll still commits, but the buyer lands on an error page. Make it required in sandbox+production, and document it for Render.

#### B19 — minor (code review, not reproduced) — Stuck approval
`approve()` sets `approval.status='approved'` before the PayPal calls. If a payout or order call throws, the stage stays `awaiting-approval` with status `approved`, and every retry returns "Nothing to approve". Only "Reset demo" recovers.

#### B20 — minor — PayPal page language
The approval page opens in German (`s2-paypal-login.png`). For an English video, pass `experience_context.locale` (e.g. `en-CH`).
