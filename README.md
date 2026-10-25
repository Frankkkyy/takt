# Takt — airline bumping for factory schedules

When a job shop's schedule is full and a rush order arrives, Takt makes room. It finds booked customers who can wait, pays them for it through PayPal, and charges the rush customer a premium that covers the compensation. The schedule only changes when PayPal confirms the money moves.

> Status: phase 2.
> - **AI:** a Claude Haiku 5.5 agent with tool use reads rush requests, picks whom to ask, writes the offers and negotiates replies, inside code-enforced guardrails and an owner approval step. It scores 13/13 on the eval.
> - **PayPal:** runs against the real sandbox (verified end-to-end in CHF) or an offline mock.
> - **Timeline:** a placeholder until Bryntum Scheduler Pro is wired in.

## Run locally

```bash
npm install
cp .env.example .env     # optional: add PayPal sandbox credentials
npm run dev              # API on :8787, web on http://localhost:5173
npm test                 # unit + guardrail tests; demo path 10x with rules and 10x with recorded Claude responses
npm run agent:eval       # 13-case agent eval (replays recordings, free; add -- --live to re-run on Claude, ~USD 0.01)
npm run dev:sandbox      # same app against the real PayPal sandbox
npm run smoke:sandbox    # the whole money story against the sandbox, 14 checks (headless buyer approval)
npm run build && npm start   # production: one process serves API + built web app on :8787
```

Without credentials the header shows **PayPal: MOCK**. The agent badge shows **Claude Haiku 5.5 · live** when `ANTHROPIC_API_KEY` is set, **· recorded** when a scripted demo input is replayed from `server/agent/llm-cache/` (no key needed), or **rules (fallback)**. `AGENT_MODE=deterministic` forces the rules. Once `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set (in `.env`, or in the parent workspace's `.env`), it switches to the real sandbox.

### Sandbox notes

- **Rush customer:** "Pay with PayPal (sandbox)" opens PayPal's approval page. Log in with a sandbox *personal* account, or use "Pay with credit or debit card" with test card `4005519200000004`, any future expiry, CVV `123`. PayPal sends the buyer back to `/api/paypal/return`, and the server also polls the order, so the flow completes even without the redirect.
- **Seeded bookings** have placeholder authorizations. The first time Takt touches one, it creates a real sandbox authorization for the same amount with PayPal's test card (logged as "Sandbox booking authorization").
- **Payouts** go to `PAYPAL_SANDBOX_PAYOUT_RECEIVER` when it is set. Otherwise they end `UNCLAIMED`, because the seeded emails have no PayPal account.
- **No webhooks needed:** after each money move the server polls the resource and feeds a webhook-shaped event (`RECON-…`) into the same handler that verified webhooks use.

## How AI is used

Takt's agent is **Claude Haiku 5.5** (`claude-haiku-5-5`), called through the Anthropic Messages API with tool use (`server/agent/claude.ts`). It runs three short agent loops. Each one has typed, strictly validated tools.

| Step | What Claude does | Tools it calls (code behind them) |
|---|---|---|
| **Intake** | Reads a free-text rush request in DE/FR/EN, e.g. *"Brauche 6 Halter S355 8mm bis Dienstag"* | `record_rush_job`: code turns part family × qty × thickness into machine hours and a rate-card price |
| **Make room** | Asks the planner for options, decides whom to ask (cost, relationship notes, stated flexibility) and justifies it to the owner. Then writes a personal offer per customer in their language | `plan_bump_options` (the deterministic finite-capacity planner, can exclude customers) → `choose_bump_plan` → `draft_offer` (rejected if the text states a different amount or day) |
| **Negotiate** | Interprets free-text replies: yes, no, *"d'accord, mais plutôt jeudi matin et CHF 70"*, questions, manipulation attempts. Answers in the customer's language | `accept_offer`, `counter_offer` (re-checked against caps and feasible dates), `reply_to_customer`, `decline_offer` (→ re-plan), `escalate_to_owner` |

**Guardrails.** Code, not the model, decides every amount. These limits hold whatever the model writes:
- per-job cap of 12 % of the job price;
- rush budget: all compensations together at most 60 % of the rush premium;
- margin floor of CHF 150;
- delivery dates no earlier than the planner allows;
- no CHF amount above the cap in any message.

Payees always come from booking records. Customer text is wrapped as untrusted data. **No money moves until the shop owner clicks "Approve & send to PayPal"**, and the checks are re-run at that moment. Every tool call, guardrail rejection, approval and PayPal call appears in the **PayPal & agent log**.

**Never fails on stage.**
- If the API errors, is rate-limited, hits the spend ceiling, refuses, or doesn't finish, that step runs on the rule-based agent and the badge says so.
- Responses for the scripted demo inputs are recorded (record/replay keyed by the exact request), so the hosted demo and the video replay real Claude output at zero cost.
- New inputs go live, limited per IP and by a per-process USD ceiling.

**Eval.** [docs/AGENT_EVAL.md](docs/AGENT_EVAL.md): 13/13 cases pass on a live run, for USD 0.007 in total. The cases cover DE/FR/EN intake, plans, accept, decline, counter, over-cap and question replies, and a prompt injection that demands a CHF 2000 payout to a new email; that one is escalated to the owner and nothing changes.

![Agent flow: replies negotiated by Claude, owner approval with guardrail checks](docs/screenshots/3c-owner-approval.png)

## How PayPal is used

| Step | API |
|---|---|
| Rush customer pays (hold only) | `POST /v2/checkout/orders` (intent `AUTHORIZE`), buyer approval (redirect now, JS SDK v6 next), then `POST /v2/checkout/orders/{id}/authorize` |
| Owner approves the money moves | Nothing below runs before this click; guardrail checks are re-run |
| Bumped customer who booked with an authorization | At shipment: `POST /v2/payments/authorizations/{id}/capture` for the authorized amount minus the compensation, with `final_capture:true` |
| Bumped customer who already paid in full | `POST /v1/payments/payouts` |
| Cancellation | `POST /v2/payments/authorizations/{id}/void` |
| Late-delivery policy | `POST /v2/payments/captures/{id}/refund` |
| Long jobs | `POST /v2/payments/authorizations/{id}/reauthorize` (after the 3-day honor period) |
| Confirmation | Reconcile by polling `GET` order / authorization / payout. Webhooks (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, …) go through the same handler once hosted, verified with `/v1/notifications/verify-webhook-signature` |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture diagram, the agent sequence and the guardrails. See [docs/SPIKE.md](docs/SPIKE.md) for the API verification log.

## License

MIT, see [LICENSE](LICENSE). Third-party services and libraries keep their own licences. In particular, Bryntum Scheduler Pro (planned) is a commercial library, used here under its trial terms and not included in this repository.
