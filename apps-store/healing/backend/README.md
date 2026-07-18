# ryu-healing

Self-healing loop for failed runs — an extracted **Core capability crate**. When an
agent or workflow run fails, this engine asks a Gateway-governed side model to
diagnose *why* and propose a corrected instruction, then either auto-applies the fix
(re-runs) or queues it in the approvals inbox for the user.

## Role in the decomposition

A primitive lifted out of `apps/core`. It owns the diagnose→propose engine, the
loop-prevention decision logic, the per-source attempt state, and the
`/api/healing/*` HTTP surface. **The surface is now served OUT-OF-PROCESS** by the
`ryu-healing` bin (`[[bin]]`, `kind:local`, `public_mount`, `RYU_HEALING_BIN`/
`RYU_HEALING_PORT`, default `:8001`); Core proxies to it. **Design-B split:** the
sidecar computes the `HealVerdict`, but Core keeps a non-optional path-dep on this
crate for the `HealVerdict`/`HealSource` types + `apply_verdict`, and applies the
*welded action side* in-process (`apps/core/src/healing_client.rs` posts a failed run
to the sidecar, then `CoreHealingHost` runs the approvals write + agent/workflow
re-run). Every kernel coupling it needs — `healing.*` preference read/write, the
Gateway diagnosis call, re-running an agent/workflow, and delivering a proposed fix
into the approvals inbox — is inverted through the `HealingHost` trait, so the crate
has **zero dependency on `apps/core`**.

## Placement (Core vs Gateway)

Orchestrating diagnose→propose→re-dispatch and the attempt-cap/cooldown state decides
*what runs* → **Core** (the diagnose/verdict half now runs in the `ryu-healing` sidecar;
the welded `apply_verdict` action side stays in-process). The diagnosis LLM call routes through
the Gateway via `HealingHost::call_side_model`, so it is firewalled / DLP'd / budgeted
/ audited — *what is allowed and measured* stays Gateway-side.

## Key API

- `HealEngine` — the engine; Core subscribes the run-status bus and calls
  `report_failure(source_id, HealSource, instruction, failure)`.
- `HealingHost` (trait) — the inversion seam; implemented Core-side in
  `apps/core/src/healing_host.rs`.
- `decide_heal(...) -> HealDecision` — pure, unit-tested loop-prevention (never-heal-a-
  heal via the `healrun_` prefix, per-source cap, growing cooldown, give-up→escalate).
- `resolve_config` / `HealingConfigView` — client-safe resolved config.
- `routes()` / `HealingCtx` — the `/config` (get/post) + `/status` axum router.
- `truncate_context` — crate-owned length policy Core applies before reporting.

## Consumed as

Compiled-into-core crate (path dependency), merged into Core's axum router.
Attempt caps persist to `~/.ryu/healing-attempts.json` and survive a restart.

## Swap-seam

Defaults live in the `resolve_*` functions (master switch default ON;
`healing.auto-decide` default OFF = propose, dispose; max-attempts 2; 60s cooldown;
diagnose model falls back to `HealingHost::default_diagnose_model`). Nothing is
hardcoded — every knob is a `healing.*` preference, and the diagnosis model routes
through the swappable Gateway.
