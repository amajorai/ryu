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

## How it is consumed

Compiled **into the Gateway** and into any stage crate that shares a cross-stage type (e.g.
`ryu-gw-budget` re-exports `AlertTier`). Depends only on `serde`. New cross-stage vocabulary lands
here first.
