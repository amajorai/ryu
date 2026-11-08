/**
 * Plan catalog: the single source of truth for Ryu's subscription / license
 * plans (epic #496 — Ryu Cloud + organization pricing, Unit 0).
 *
 * CLAUDE.md placement rule (§1): "what is allowed, shared, measured, or paid
 * for" is control-plane. Plans decide *what a user is entitled to* (desktop
 * access, managed inference, included credit pool, seats), so they live next to
 * billing in `@ryu/auth`.
 *
 * NOTHING HARDCODED: every Polar product/price id reads from an env var with a
 * documented placeholder default. The dollar figures (credit pools, deposit
 * fee) are enforced from here. Marketing copy keeps presentational mirrors so
 * this catalog never ships to a browser bundle: `@ryu/blocks/web/pricing.tsx`
 * (plan list prices) and `PUBLISHED_PRICING` in
 * `@ryu/blocks/web/data/standalone-pricing.ts` (deposit fees and hosted-mail
 * allowances, which `standalone-pricing.test.ts` checks against this file).
 * To swap a plan's pricing you change its row here and update those mirrors in
 * the same commit; to swap a Polar product you set its env var. See `docs/polar-products.md` for the products/prices/benefits that
 * must be created in Polar and which env vars carry their ids.
 *
 * Pricing decisions (defaults, unified organization catalog, 2026-08-19):
 *  - Desktop license  one-time $200 list (launch $129 via the LIFETIME129 discount;
 *                     Polar license-key benefit, 7-day trial, 1yr updates).
 *                     Grants desktop access, NO managed inference.
 *  - A Major Pass      $20/month or $200/year for one individual user;
 *                     supported paid Marketplace access and publisher-pool funding.
 *  - Plus             private $39/mo individual Pro companion; fixed $9 pool
 *                     with the same CX23 managed capacity and lower usage.
 *  - Pro              $49/mo individual plan; shown on the public individual
 *                     shelf; fixed $14 pool. Existing $39 contracts remain
 *                     grandfathered at their recorded pricing version.
 *  - Max              $99/mo individual plan; shown on the public individual
 *                     shelf; fixed $30 pool.
 *  - Teams            $50/member seat/mo, five-seat minimum ($250 floor),
 *                     organization-owned; pooled credits grow by $50 per five
 *                     billed seats in the current pricing version.
 *  - Teams Lite       private $150/month five-seat floor ($100 below Teams),
 *                     then $50 per additional seat; pooled credits grow by $20
 *                     per five billed seats.
 *  - Business         $300/month for five seats, then $50 per seat; pooled
 *                     credits grow by $100 per completed five-seat bundle.
 *  - Hosted services  {@link SERVICE_RATES}: Box capacity, Notify events,
 *                     Passport connections and fetches, and Mail overage,
 *                     settled against the org wallet (2026-10-12).
 *  - Credits top-up   deposit fee 27% base (26.5% Plus/Pro, 26% Max/org) + $5
 *                     floor, capped so Ryu keeps at most $10 per top-up;
 *                     usage debits AT COST (markup 0). Manual presets
 *                     are $100, $250, and $1,000 face values, with custom
 *                     $5–$1,000 amounts; bundles do not discount the face.
 *
 * The credit pool / markup is captured at DEPOSIT, not per-usage. The wallet is
 * USD-denominated in micro-USD (millionths of a dollar) to match
 * `CreditWallet.balanceMicroUsd`.
 *
 * Usage that debits at cost is BOTH model tokens (reason `gateway_usage`,
 * OpenRouter pass-through) AND tool calls. Composio is not free — it charges per
 * action execution — so each executed `composio.*` tool call debits the wallet
 * at cost under reason `composio`, separately from the token debit. The managed
 * gateway meters tool calls and the per-call rate is provisioned per managed node
 * (`GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD`); builtin/MCP/app tools are free.
 */

export * from "./plan-catalog.ts";
export * from "./plan-core.ts";
export * from "./plan-desktop-gate.ts";
export * from "./plan-fees.ts";
export * from "./plan-inbox-lifecycle.ts";
export * from "./plan-limits.ts";
export * from "./plan-quotas.ts";
export * from "./plan-service-rates.ts";
export * from "./plan-subscription.ts";
export * from "./plan-updates-window.ts";
export * from "./plan-version-catalog.ts";
export * from "./plan-version-rows.ts";
