# ryu-gw-contracts

Shared value-types exchanged between Ryu **Gateway** stages.

## What it is

The neutral home for cross-stage vocabulary, so peer stage crates (`ryu-gw-budget`,
`ryu-gw-firewall`, …) can share a type without depending on each other. It has **no logic** — only
serde-shaped enums/structs the pipeline threads between stages.

## Role in the decomposition

The base of the Gateway stage-crate graph: stage crates depend on this, never on one another. Keeps
the extracted stages peers rather than a chain. Today it holds:

- **`AlertTier`** — the notification fan-out a policy match triggers (`Silent` < `Warn` < `Fanout`
  < `Email`), **orthogonal** to the enforcement action (`BudgetAction` / `FirewallPolicy`):
  enforcement decides what happens to the request, the tier decides who gets told. Core takes the
  `max` tier across matched rules, so the ascending-severity variant order is load-bearing — keep it.
  Named `Fanout` (not `Notify`) to avoid colliding with `BudgetAction::Notify`.
- **`credit_debit::CreditDebitReason`** — the closed set of ledger reasons the Gateway may send
  to the control plane's credit debit. The control plane rejects any other reason, so purpose
  labels (embedding, smart routing, inspector) travel in `taskLabel` instead.
  `fixtures/credit-debit-reasons.json` is the cross-surface copy the control plane tests against.
- **`capability_taxonomy`** — Ryu's first-party capability and platform ids (Treg parity B1).
  `fixtures/capability-taxonomy-v1.json` is the data, read here and by
  `@ryuhq/protocol/capability-taxonomy`; both assert `fixtures/capability-taxonomy-cases-v1.json`.
  Propose-then-promote states, a duplicate-meaning validator, the per-model comparison rule for
  generative media, and a test that every Core facade verb (`capability_tools.rs`) is one promoted
  capability.
- **`tool_price`** — per-endpoint price records (Treg parity B2): native unit, provenance
  (`vendor_page` / `vendor_api` / `ryu_measured` / `unverified`), confidence, checked date and
  source URL; `per_call`, `per_unit` and graduated `tiered` rules; an explicit `free`; exact
  micro-USD quotes through a USD rate table; and `select_price`, which merges a Ryu record with a
  Treg record under `PricePrecedence` (default: Ryu's where verified, else Treg's). Ryu's catalog
  is `fixtures/tool-price-v1.json` (vendor-cited rows only); `@ryuhq/protocol/tool-price` is the
  TypeScript twin, and
  `tools/check-tool-price-staleness.mjs` warns in CI on rows older than `staleAfterDays`.
- **`tool_catalog`** — Ryu's curated catalog tier (Treg parity B3): one entry per vendor
  endpoint, typed by `capability_taxonomy` and joined by endpoint id to `tool_price`, with the
  vendor's reference URL, verifier probes and a verification state (`unverified`, `verified`,
  `drifted`, `retired`). Only a verified entry with a paid-routable price routes a paid call;
  probe credentials are limited to `VERIFIER_CREDENTIAL_HOSTS`, each bound to its vendor host.
  The seed is `fixtures/tool-catalog-v1.json`; golden cases in `tool-catalog-cases-v1.json` are
  shared with `@ryuhq/protocol/tool-catalog`, which also holds the verifier's cheapest-first
  planner and example scrubber. The control plane (`packages/api`, `toolCatalogEntries`) is the
  live store; `tools/tool-catalog-verify.ts` and `.github/workflows/tool-catalog-drift.yml`
  verify it.
- **`tool_catalog_merge`** — how one listing shows Ryu's and Treg's catalogs together (Treg
  parity B8): every row keeps its source, rows only one catalog lists always stay, and where both
  list the same endpoint (`same_endpoint_key`: vendor and endpoint id) the `PricePrecedence`
  switch keeps one and orders the rest. Core's Integrations Store applies it
  (`RYU_TOOL_CATALOG_PRECEDENCE`, `apps/core/src/treg_catalog.rs`).

## How it is consumed

Compiled **into the Gateway** and into any stage crate that shares a cross-stage type (e.g.
`ryu-gw-budget` re-exports `AlertTier`). Depends only on `serde`, `serde_json` and `url`. New cross-stage vocabulary lands
here first.
