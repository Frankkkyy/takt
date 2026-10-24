# Takt — architecture

> Airline bumping for factory schedules. When a job shop is full and a rush order arrives, Takt finds booked customers
> willing to wait, pays them for it through PayPal, and sells the freed slot to the rush customer.

## Diagram

```mermaid
flowchart LR
  subgraph Browser
    OW[Owner console<br/>board + flow + PayPal log]
    OF[Customer offer page<br/>phone view, DE/FR/EN]
    SDK[PayPal JS SDK v6<br/>rush customer approval]
  end

  subgraph Server["Node / Express (one process)"]
    API[REST API /api/*]
    APP[TaktApp<br/>flow state machine]
    PL[Planner<br/>re-sequencing search]
    SC[Scheduler<br/>finite capacity sim]
    PR[Pricing policy<br/>rate card, caps, margin floor]
    AG[Negotiator<br/>LLM or deterministic]
    GW{{PayPalGateway interface}}
    MOCK[MockPayPal<br/>offline, emits webhook-shaped events]
    REST[RestPayPal<br/>fetch → api-m.sandbox.paypal.com]
    WH[/api/webhooks/paypal<br/>verify signature → dispatch/]
  end

  PP[(PayPal sandbox<br/>Orders v2 · Payments v2 · Payouts v1 · Webhooks)]
  LLM[(Claude Haiku API<br/>optional)]

  OW --> API
  OF --> API
  SDK -- onApprove(orderId) --> API
  API --> APP
  APP --> PL --> SC
  PL --> PR
  APP --> AG -.-> LLM
  APP --> GW
  GW --> MOCK
  GW --> REST --> PP
  PP -- webhooks --> WH --> GW
  MOCK -- events --> GW
  GW -- onEvent --> APP
```

## Money flow (the core mechanic)

```mermaid
sequenceDiagram
  participant R as Rush customer
  participant T as Takt
  participant P as PayPal
  participant B as Booked customer (authorization)
  participant M as Booked customer (prepaid)
  T->>T: Planner simulates re-sequencing, prices bumps (code, not LLM)
  T->>B: Offer (DE/FR/EN): deliver +1 day, CHF 50 less
  T->>M: Offer: deliver +1 day, CHF 45 now
  B-->>T: Accept
  M-->>T: Accept
  T->>P: POST /v1/payments/payouts (M, CHF 45)
  T->>P: POST /v2/checkout/orders intent=AUTHORIZE (rush price)
  R->>P: Approve (JS SDK v6)
  T->>P: POST /v2/checkout/orders/{id}/authorize
  P-->>T: webhook PAYMENT.AUTHORIZATION.CREATED
  T->>T: Commit new schedule (only now)
  Note over T,P: At shipment of B's job
  T->>P: POST /v2/payments/authorizations/{B}/capture amount = authorized − 50, final_capture=true
```

## Modules

| Path | Role |
|---|---|
| `shared/types.ts` | Domain types shared by server and web |
| `server/domain/seed.ts` | Fictional shop "Werkstatt Reuss": 4 machines, 7 customers, 24 jobs. Due dates come from the baseline schedule plus slack |
| `server/domain/scheduler.ts` | Deterministic finite-capacity dispatch simulation: hour grid, 8 h/day, release days, operation precedence |
| `server/domain/planner.ts` | "Make room" search over the insert position × subsets of flexible jobs. Feasibility: the rush job is on time, firm promises are kept, and a bumped job waits ≤ its max delay. Objective: lowest compensation |
| `server/domain/pricing.ts` | Rate card and policy: compensation cap 12 %, margin floor CHF 150, rush factor |
| `server/agent/negotiator.ts` | `Negotiator` interface. Deterministic version: intake parsing and DE/FR/EN offer templates. The LLM version slots in behind it |
| `server/paypal/gateway.ts` | `PayPalGateway` interface: every money move |
| `server/paypal/mock.ts` | Offline implementation, used until credentials exist and for tests |
| `server/paypal/rest.ts` | Sandbox REST client: OAuth, Orders, Payments, Payouts, webhook verification |
| `server/app.ts` | Flow state machine: intake → plan → offers → accept/decline → rush authorization → commit on webhook → ship (capture less) / cancel (void) |
| `web/src/*` | React UI: owner console (board, flow panel, PayPal log) and the `#/offer/:id` customer page |

## Principles

- **The LLM words things; code decides.** Prices, compensation caps, margin and feasibility are all deterministic, so the agent can't give money away.
- **The schedule only commits when PayPal confirms** (the webhook, or a reconcile poll). The UI polls every 1 s, which also covers webhooks that arrive late.
- **Compensation follows how the customer paid:**
  - booked with an authorization → capture less at shipment, so no extra money movement is needed;
  - prepaid → Payout.
- **Demo safety:**
  - offline mock gateway and deterministic agent;
  - "Reset demo";
  - `npm test` runs the full demo path 10 times.

## Next (phase 2)

1. Bryntum Scheduler Pro replaces `Board.tsx` (trial starts ≥ 31 Oct). Machines become resources and ops become events; ghost events show the proposal, and the accepted plan animates in.
2. RestPayPal day-1 checks (see SPIKE.md); JS SDK v6 button for the rush customer.
3. LLM negotiator (Claude Haiku), plus free-text reply parsing for counter-offers.
4. Typed agent tools over the gateway next to `@paypal/agent-toolkit` tools.
5. Hosting on Render, plus README and THIRD_PARTY.md.
