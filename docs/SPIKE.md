# Takt — tech spike (24 Oct 2026)

I checked everything below against current official docs, npm and the API schemas on 24 Oct 2026. On **25 Oct 2026** the PayPal part ran against the real sandbox; see **"Sandbox verification (25 Oct 2026)"** at the end. `npm run smoke:sandbox` repeats it (14/14 checks passed).

## TL;DR: decisions and blockers

| Topic | Conclusion | Blocker? |
|---|---|---|
| Compensation mechanics | **Capture less:** one `capture` of (authorized − compensation) with `final_capture:true`. It works on the same day and the customer doesn't need to approve again. **Payout** is only for customers who already paid in full. Void-and-new-order is a last resort, because the buyer must approve again. | **No. Verified 25 Oct:** the authorization ends `CAPTURED` and a further capture is refused |
| CHF | Orders, authorizations, captures, refunds and payouts all work in CHF. The sandbox business account settles in EUR and converts; it needs **no** CHF balance. | **No. Verified 25 Oct** |
| Reauthorize | Blocked during the 3-day honor period, so we can't show it in the video. It stays as code plus README. | No |
| Agent Toolkit | `@paypal/agent-toolkit@1.11.0` has **no** Payouts, capture-authorization, void or reauthorize tools. Its `create_order` hardcodes `intent:"CAPTURE"`. | No: our own typed tools behind the same policy wrapper |
| JS SDK | v6 web SDK. `clientId` in the browser is OK. Server creates the AUTHORIZE order, then `onApprove` hands over to the server, which calls `/authorize`. | Low (the docs sample uses CAPTURE; test AUTHORIZE) |
| Bryntum trial | `@bryntum/schedulerpro-trial@7.3.7` is on public npm, no login. The **45-day clock runs per browser**, starting at first page load, stored in localStorage, with no network call. It has a watermark. | **Licence text for a public demo is unclear:** ask on Discord |
| Runtime LLM | **Claude Haiku 5.5** via our own API key, about USD 1–2 for the whole contest. The Gemini free tier is **not allowed** for EEA/CH users. | Needs **≈ USD 5 top-up**: Francisco's OK required |
| Hosting | **Render**: Starter paid with the hackathon's USD 50 credit if it can be claimed for free, otherwise free tier plus a keep-alive ping. Polling reconcile is always on. | Credit claim may need a card: Francisco's OK required |

---

## 1. PayPal REST: exact endpoints

Sandbox base is `https://api-m.sandbox.paypal.com`. To get a token, call `POST /v1/oauth2/token` with Basic `CLIENT_ID:SECRET` and `grant_type=client_credentials`.

### Orders v2 with intent AUTHORIZE
Docs: https://developer.paypal.com/docs/api/orders/v2/ and https://developer.paypal.com/docs/checkout/standard/customize/authorization/

```json
POST /v2/checkout/orders
{"intent":"AUTHORIZE","purchase_units":[{"reference_id":"RUSH-1042","invoice_id":"TAKT-1042",
  "description":"Rush: 6x harvester bracket","amount":{"currency_code":"CHF","value":"2055.00"}}],
 "payment_source":{"paypal":{"experience_context":{"brand_name":"Takt demo shop","user_action":"CONTINUE",
   "shipping_preference":"NO_SHIPPING","return_url":"…","cancel_url":"…"}}}}
```

- After buyer approval, call `POST /v2/checkout/orders/{id}/authorize`.
- The authorization id is at `purchase_units[0].payments.authorizations[0].id`, together with `status` and `expiration_time`.
- Use the `PayPal-Request-Id` header for idempotency.

### Payments v2
Schema: https://developer.paypal.com/api/payments/v2/schema.json

**Capture**
- `POST /v2/payments/authorizations/{id}/capture` with `{amount, final_capture, invoice_id, note_to_payer, soft_descriptor}`.
- Leaving out `amount` captures the full amount.
- Several partial captures are allowed while `final_capture:false`; the status is then `PARTIALLY_CAPTURED`.
- After a capture with `final_capture:true`, any further capture fails with `AUTHORIZATION_ALREADY_CAPTURED`.

**Overage**
- Default limit: 115%. "Local regulations (e.g. in PSD2 countries) prohibit overages". In CH/EU we **only capture less, never more**.

**Void**
- `POST /v2/payments/authorizations/{id}/void`.
- You can't void a reauthorization (`CANNOT_BE_VOIDED`); void the parent instead.

**Reauthorize**
- `POST /v2/payments/authorizations/{id}/reauthorize` with body `{amount}`.
- During the 3-day honor period it fails with `REAUTHORIZATION_TOO_SOON`. The authorization is valid for 29 days.

**Refund**
- `POST /v2/payments/captures/{id}/refund` with `{amount?, invoice_id, note_to_payer}`.
- An empty body refunds the remaining amount.

**Takt mapping**
- Compensation for a booked customer is a single final capture of the authorized amount minus the compensation.
- `note_to_payer` carries the reason, e.g. "CHF 50 less than authorized: thank you for moving your delivery".

### Payouts v1
Schema: https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json. Guide: https://developer.paypal.com/docs/payouts/standard/

- Create a batch with `POST /v1/payments/payouts`:
  - `sender_batch_header{sender_batch_id, email_subject}` (`sender_batch_id` is idempotent for 30 days).
  - `items[]{recipient_type:"EMAIL", receiver, amount{value,currency}, note, sender_item_id, recipient_wallet:"PAYPAL"}`.
- Check status:
  - `GET /v1/payments/payouts/{batch_id}` returns PENDING, PROCESSING, SUCCESS, DENIED or CANCELED.
  - `GET /v1/payments/payouts-item/{id}` returns the status of one item.
- Sandbox works without approval ("you can set up and test your integration in your sandbox accounts").
- **The sender must hold balance in the payout currency.** The default sandbox business account holds USD.
- The receiver must be a sandbox *personal* account, or the item stays `UNCLAIMED`.
- Payouts settle asynchronously, so we poll for the result.

### Webhooks
Docs: https://developer.paypal.com/api/rest/webhooks/event-names/ and https://developer.paypal.com/api/rest/webhooks/rest/

**Verification**
- Call `POST /v1/notifications/verify-webhook-signature` with:
  - the `PAYPAL-AUTH-ALGO`, `CERT-URL`, `TRANSMISSION-ID`, `TRANSMISSION-SIG` and `TRANSMISSION-TIME` headers,
  - `webhook_id`,
  - the raw `webhook_event`.
- Check `verification_status == SUCCESS`. I took that field name from memory: confirm it on day 1.

**Events we use**

| Area | Events |
|---|---|
| Orders | `CHECKOUT.ORDER.APPROVED` |
| Authorizations | `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED` |
| Captures | `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DECLINED`, `.REFUNDED` |
| Payout batches | `PAYMENT.PAYOUTSBATCH.SUCCESS`, `.DENIED` |
| Payout items | `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.UNCLAIMED`, `.FAILED` |

**Delivery**
- The endpoint must be public HTTPS. PayPal retries a failed delivery up to 25 times over 3 days.
- Events from the simulator can't be verified by postback.
- For local dev: a tunnel such as cloudflared, or reconcile by polling.

### JS SDK v6 (buyer approval)
Docs: https://developer.paypal.com/docsai/payments/methods/paypal/sdk/js/v6/paypal-checkout

1. Load the script from `https://www.sandbox.paypal.com/web-sdk/v6/core`, or with npm `@paypal/paypal-js@11.3.0` (`loadCoreSdkScript({environment:"sandbox"})`).
2. Create the instance with `paypal.createInstance({clientId, components:["paypal-payments"]})`.
3. Check eligibility: `findEligibleMethods()`, then `isEligible("paypal")`.
4. Create the session with `createPayPalOneTimePaymentSession({onApprove,onCancel,onError})`.
5. Start it with `session.start({presentationMode:"auto"}, createOrderPromise)`.
6. In `onApprove`, our server calls `/authorize`.

### Server SDK and Agent Toolkit
**`@paypal/paypal-server-sdk@2.5.0`**
- Covers Orders and Payments.
- It does **not** cover Payouts or webhook verification.
- Decision: use our own thin `fetch` client (`server/paypal/rest.ts`). It maps 1:1 to the docs.

**`@paypal/agent-toolkit@1.11.0`** (46 tools)
- Covers invoices, orders create/get/pay (CAPTURE only), refunds, disputes, shipment tracking, catalog, subscriptions, transactions and insights.
- It has none of Takt's core money moves.
- Plan:
  - Use toolkit tools where they fit: `get_order`, `create_refund`, `create_shipment_tracking`, `list_transactions`.
  - Register our own typed tools next to them, behind the same policy wrapper: `authorize_order`, `capture_less`, `void_authorization`, `send_payout`.
  - Say this honestly in the README.

## 2. Bryntum Scheduler Pro (trial)

**Packages**
- `@bryntum/schedulerpro-trial@7.3.7` (24 Sep 2026, licence "Commercial", public npm, no login).
- React wrapper: `@bryntum/schedulerpro-react@7.3.7`.
- Install with `npm i @bryntum/schedulerpro@npm:@bryntum/schedulerpro-trial@7.3.7`.
- Import CSS: `schedulerpro.css`, a theme such as `svalbard-light.css`, and FontAwesome.
- Docs: https://bryntum.com/products/schedulerpro/docs/guide/SchedulerPro/npm-repository

**Trial clock**
- Advertised as "Full functionality for 45 days" (https://bryntum.com/download/).
- We tested it in headless Chromium on 24 Oct:
  - `npm install` writes a random UUID into the bundle.
  - The first page load writes `localStorage["b-schedulerpro-trial-start"]`.
  - It makes no network call.
  - With the start date backdated by 50 days, the scheduler shows "Trial expired" and stops working.
- So the 45 days are counted **per browser**, and every judge's browser starts fresh.
- The ≥ 31 Oct activation rule matters for **our own recording and dev browsers**: record the video in a browser profile first used on or after 31 Oct.
- We never reset the key in code; that would circumvent the licence.

**Limitations:** a "Bryntum Trial Version" watermark, which will show in the video. Bundles are not minified. A console banner appears.

**Licence**
- No public trial EULA was found.
- https://bryntum.com/products/schedulerpro/license/ covers only paid licences.
- The sponsor brief clearly expects the trial to be used.
- **Ask Bryntum on the PayPal hackathon Discord:** is a public hosted demo with a watermark OK, and an MIT repo that depends on the trial package?
- The repo never vendors Bryntum files; it only lists the npm dependency. THIRD_PARTY.md will say so.

## 3. Runtime LLM (negotiation agent: DE/FR/EN, tool calling)

Estimate: 2,000 calls × 3k tokens in / 500 out = 6 MTok in and 1 MTok out.

| Option | USD per MTok (in/out) | Estimated cost | Notes |
|---|---|---|---|
| **Claude Haiku 5.5** (`claude-haiku-5-5`) | 0.10 / 0.50 | **≈ 1.10** | Tool use, multilingual, prompt caching. https://platform.claude.com/docs/en/about-claude/pricing |
| Claude Haiku 4.5 | 1 / 5 | ≈ 11 | Older model |
| Gemini 3.1 Flash-Lite (paid) | 0.25 / 1.50 | ≈ 3 | https://ai.google.dev/gemini-api/docs/pricing |
| Gemini free tier | 0 | — | **Not allowed:** "You may use only Paid Services when making API Clients available to users in the EEA, Switzerland, or the UK" (https://ai.google.dev/gemini-api/terms) |
| OpenRouter `:free` | 0 | — | 50 requests/day, or 1,000/day after buying ≥ 10 credits. Too fragile (https://openrouter.ai/docs/api-reference/limits) |
| Groq free | 0 | — | 8k tokens/min, so only about 2 calls/min with our prompts (https://console.groq.com/docs/rate-limits) |

**Decision (proposed):** Claude Haiku 5.5 with a key paid from the project budget (≈ USD 5 top-up, well under the 30 CHF cap). Controls:
- A Console spend limit.
- A per-IP rate limit.
- Prompt caching.
- Responses cached by input hash for the demo path.

**Fallback (already built):** `DeterministicNegotiator`.
- Rate-card pricing and the planner are plain code.
- Offers come from DE/FR/EN templates.
- Replies are parsed with regex.
- The demo never depends on a live LLM call.

## 4. Hosting until 15 Dec, with webhooks

| Host | Card needed | Sleeps | Notes |
|---|---|---|---|
| Render Free | no | yes, after 15 min (≈ 1 min to wake) | 750 h/month covers one service 24/7. Works with a keep-alive ping. https://render.com/docs/free |
| **Render Starter on the hackathon's USD 50 credit** | probably | never | Best option. Also qualifies for the Render prize (needs a Render Workflow). |
| Koyeb Free | yes | after 1 h | |
| Fly.io | yes | — | No free tier for new organizations |
| Vercel Hobby | no | serverless | Non-commercial use only, and no server state |
| Cloudflare Workers + D1 | no | no | 10 ms CPU per request and not full Node; would need a port |
| Cloud Run / Oracle | yes | — | |

**Decision (proposed):** Render, with the app built to work on any host:
1. In-memory seeded state plus a "Reset demo" button.
2. Webhooks are treated as confirmations, not the only source of truth. The app reconciles by polling `GET` order / authorization / payout. The UI already polls state every 1 s.
3. Webhooks are processed idempotently by event id.

## Sandbox verification (25 Oct 2026)

Run against `api-m.sandbox.paypal.com` with the app's own sandbox credentials (kept in the workspace `.env`, never in this repo). Reproduce with `npm run smoke:sandbox`. The last run passed 14 of 14 checks. The live app in `npm run dev:sandbox` also completed the whole demo: screenshots are in `docs/screenshots/sandbox/`.

### Day-1 checks: results

| # | Question | Result |
|---|---|---|
| 1 | CHF AUTHORIZE order, then capture | **Works.** See "Orders v2" below. |
| 2 | Capture less with `final_capture:true` releases the rest | **Works.** Authorized CHF 2150, captured 2100: capture `COMPLETED`, authorization `CAPTURED`. A further capture fails with `422 AUTHORIZATION_ALREADY_CAPTURED`, so the CHF 50 can't be taken later. |
| 3 | CHF Payout from the sandbox business balance | **Works without a CHF balance.** PayPal converted EUR 51.38 to CHF 45.90 (CHF 45 plus a CHF 0.90 fee). |
| 4 | JS SDK v6 `onApprove` with an AUTHORIZE order | **Works (26 Oct).** Server-created AUTHORIZE order, `session.start({ presentationMode: 'auto' }, Promise.resolve({ orderId }))`, popup approval, `onApprove` → server `/authorize`. See "JS SDK v6" below. |
| 5 | Webhook verification field name | **Not tested.** Not needed now: the app reconciles by polling. Test once hosted, or through a tunnel. |

### Sandbox accounts
- **Business (payee):** `sb-m9rlt53529812@business.example.com`, merchant id `RV856RCW9WEJ4`. It's read from `purchase_units[0].payee` in any order response. Its primary currency is **EUR**: captures in CHF settle as EUR, e.g. `receivable_amount` EUR 639.35, fee CHF 20.65.
- **Personal (buyer):** there is **no API to list or create sandbox accounts.** The token has no such scope, and `/v1/reporting/balances` returns 403 `NOT_AUTHORIZED`. Francisco must copy the default personal account's email from developer.paypal.com > Testing Tools > Sandbox Accounts.
- I created **no accounts.** On the CH guest-checkout page, "open a PayPal account" asks for a password, birth date and ID number, so I didn't use it.

### Orders v2 with intent AUTHORIZE (CHF)
- **A wallet order starts as `PAYER_ACTION_REQUIRED`, not `CREATED`.** The approval link has `rel: "payer-action"` and points to `https://www.sandbox.paypal.com/checkoutnow?token={orderId}`.
- **Buyer approval is automated in headless Chromium** (`scripts/paypal-approve.ts`):
  - It uses the guest option "Mit Kredit- oder Debitkarte zahlen" with test card **4005519200000004**.
  - Cards 4032039317984658 and 5555555555554444 are rejected there ("Wir konnten Ihre Karte nicht hinzufügen").
  - The order then moves to `APPROVED`. The payer is a guest (`account_status: UNVERIFIED`, country CH).
  - PayPal redirects to `return_url?token={orderId}&PayerID=…`, and `http://localhost` return URLs work.
- **Flaky: PayPal A/B-tests the card page.** One variant has "Nein danke" (guest); the other forces account creation. The helper detects the forced-signup variant and retries in a fresh browser context.
  - A failed or abandoned attempt can break that order: it then shows `checkoutweb/genericError?code=DEFAULT`.
  - So create a new order when that happens.
  - For the video, use a real sandbox personal account. Set `PAYPAL_SANDBOX_BUYER_EMAIL/PASSWORD`, and the helper logs in instead.
- **`POST /v2/checkout/orders/{id}/authorize`** returns `COMPLETED`, with `purchase_units[0].payments.authorizations[0]` = `{id, status: "CREATED", amount, expiration_time}`. **`expiration_time` is +29 days.**
- **A card-funded order needs no buyer step:** `payment_source.card` with test Visa 4032039317984658 returns `201 COMPLETED` with the authorization already `CREATED`. The app uses this **only to give the seeded bookings real authorizations** (`createCardAuthorization`), and logs it as such.

### Payments v2
| Call | Result |
|---|---|
| Capture | `201`; `status COMPLETED`, `final_capture`, and `seller_receivable_breakdown` with fee and FX |
| Void | With `Prefer: return=representation`: `200` and the authorization with `status: "VOIDED"`. Without it, the docs say `204` |
| Refund (partial CHF 30, CHF 20) | `201`, `status COMPLETED` |
| Reauthorize on day 0 | `422 REAUTHORIZATION_TOO_SOON`: "only allowed once from Day 4 to Day 29". As expected: it can't be shown in the video |

### Payouts v1 (CHF)
- `POST /v1/payments/payouts` returns `201` with `batch_status: PENDING`.
- Polling `GET /v1/payments/payouts/{id}`: `PENDING`, then `PROCESSING` after about 10 s, then `SUCCESS` after about 20–30 s.
- To an email with **no** PayPal account, the item ends `UNCLAIMED`, `errors.name: RECEIVER_UNREGISTERED`. PayPal emails a claim link and returns the money after 30 days. The batch is still `SUCCESS`.
- A guest checkout payer email is also `RECEIVER_UNREGISTERED`.
- A payout that ends with item `SUCCESS` needs a **sandbox personal account email** in `PAYPAL_SANDBOX_PAYOUT_RECEIVER`. That run is **still to do** once Francisco provides the email.

### Webhooks
Not used for now. After every money move, `RestPayPal` polls the resource (order until `APPROVED`, authorization, payout batch until each item is final). It then dispatches a webhook-shaped event with id `RECON-…` into the same `onEvent` handler that verified webhooks use. The schedule still commits only when PayPal confirms. Real webhooks and signature checks: once hosted on Render.

### Re-run with the sandbox personal account (25 Oct 2026, evening)
Francisco added `PAYPAL_SANDBOX_PAYOUT_RECEIVER` and `PAYPAL_SANDBOX_BUYER_EMAIL` / `PAYPAL_SANDBOX_BUYER_PASSWORD` to the workspace `.env` (single-quoted values; `dotenv` reads them correctly). `npm run smoke:sandbox` passed **14 of 14**:
- **Buyer approval with the PayPal wallet login works:** the order went `PAYER_ACTION_REQUIRED` → `APPROVED` with the payer being the sandbox personal account (`…@personal.example.com`), no guest card form.
- **The payout item now ends `SUCCESS`** (not `UNCLAIMED`): batch `SUCCESS` after about 23 s, fee CHF 0.90.

### Blockers and to-dos
1. ~~Sandbox personal account for payouts and wallet approval~~: done, see above.
2. ~~JS SDK v6 popup button~~: done, see below.
3. Webhook signature verification: test once hosted.

## JS SDK v6 and PayPal page language (26 Oct 2026)

Sources: developer.paypal.com "JavaScript SDK v6 / PayPal checkout" and the `paypal-examples/v6-web-sdk-sample-integration` repo (via context7), read 26 Oct 2026.

- **Client token:** `POST /v1/oauth2/token` with `grant_type=client_credentials&response_type=client_token&intent=sdk_init` (Basic auth with the app credentials) returns `200`, `token_type: Bearer`, `expires_in: 900`. The server caches it and serves it at `GET /api/paypal/client-token`. The docs also allow `clientId` for the PayPal button; the app falls back to it.
- **Script:** `https://www.sandbox.paypal.com/web-sdk/v6/core`. `createInstance({ clientToken, components: ['paypal-payments'], pageType: 'checkout', locale: 'en-CH' })` accepted `en-CH`.
- **Eligibility:** `findEligibleMethods({ currencyCode: 'CHF' }).isEligible('paypal')` is true.
- **Session:** `createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })`. `start({ presentationMode: 'auto' }, promise)` must get the promise un-awaited; it resolves to `{ orderId }`. Our order already exists, so the promise is `Promise.resolve({ orderId })`. In headless Chromium `auto` opens a **popup** (`www.sandbox.paypal.com`).
- **AUTHORIZE intent works with the SDK:** `onApprove({ orderId })` → `POST /v2/checkout/orders/{id}/authorize` → authorization `CREATED`. Having `return_url` / `cancel_url` in `experience_context` (needed for the redirect fallback) did not interfere: the popup closed and `onApprove` fired.
- **Closing the popup** calls `onCancel`; the order stays `PAYER_ACTION_REQUIRED` and the same button works again.
- **Headless runs (Playwright, popup approval with the sandbox buyer login):** 8 runs. 6 passed end to end through `onApprove`. In 1 run (the first) the popup did not close within 90 s after "Complete purchase"; the helper now records the popup's navigations, not reproduced since. In 1 run the server's reconcile poll authorized the order a moment before `onApprove` arrived (correct result, wrong label); a reconcile poll now waits 4 s so the buyer's callback goes first. Redirect fallback: 2 of 2.

**Language.** `experience_context.locale` accepts `en-CH`, `en-GB` and `en-US` for CHF AUTHORIZE orders (201/200). With `en-CH`, the PayPal login page in the popup and on the redirect is English (`<html lang="en-CH">`, language switcher Deutsch | Français | **English**). **After login, PayPal switches to the buyer account's own language and country**: our workspace sandbox buyer is a Spanish account (es-ES, CaixaBank + Visa), so the review page is Spanish ("Completar compra") and shows an EUR conversion. This cannot be forced from the API or the SDK. Fix on the account side: a sandbox personal account created with country **Switzerland** and language English (developer.paypal.com > Testing Tools > Sandbox Accounts > Create account), with a card as funding source. `testBuyerCountry` in the SDK only affects eligibility, not the page language.

## Runtime LLM verification (25 Oct 2026)

- `claude-haiku-5-5` through `@anthropic-ai/sdk@1.3.0` (`client.messages.create`), with strict custom tools, adaptive thinking at effort `low`, and top-level `cache_control`. The key is in the workspace `.env` and is never committed.
- `npm run agent:eval -- --live`: **13 of 13 cases passed**, with 20 live calls, about 48.5k input and 8.2k output tokens, for **USD 0.007**. Details are in `docs/AGENT_EVAL.md`.
- Total API spend during development (five eval runs, including prompt tuning and re-recording) is about **USD 0.04** of the USD 5 credit.
- Haiku 5.5 accepts forced `tool_choice`, but then skips thinking. We use `auto` plus prompt steering, and code enforces "exactly one terminal tool".
