# Takt — tech spike (24 Oct 2026)

I checked everything below against current official docs, npm and the API schemas on 24 Oct 2026. Nothing has run against the PayPal sandbox yet, because the credentials don't exist yet. The section "Day-1 checks" lists what to test first.

## TL;DR: decisions and blockers

| Topic | Conclusion | Blocker? |
|---|---|---|
| Compensation mechanics | **Capture less:** one `capture` of (authorized − compensation) with `final_capture:true`. It works on the same day and the customer doesn't need to approve again. **Payout** is only for customers who already paid in full. Void-and-new-order is a last resort, because the buyer must approve again. | No (verify that the remainder is released) |
| CHF | Listed as a supported currency. Payouts need the sender's balance in CHF. The default sandbox accounts are US/USD. | **Maybe:** we may need CH sandbox accounts. Fallback: EUR/USD |
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

## Day-1 checks (once `.env` has sandbox credentials)

1. Does a CHF AUTHORIZE order work, and its capture, with the default sandbox accounts? If not, create CH business and personal accounts, or switch `PAYPAL_CURRENCY=EUR`.
2. Capture less than authorized with `final_capture:true`: the authorization should end `CAPTURED` with the rest released.
3. Does a CHF Payout work from the sandbox business balance? If not, use USD or EUR.
4. Does JS SDK v6 `onApprove` work with an AUTHORIZE order?
5. Webhook verify: confirm the response field name, and test via a tunnel or once hosted.
