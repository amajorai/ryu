# ryu-gw-firewall

Ryu **Gateway** firewall **scanning core** — the pure regex detection engine, extracted from
`apps/gateway/src/firewall/mod.rs`.

## What it is

Everything with **no dependency on the Gateway pipeline's `AppState`** or the config cascade:

- Curated pattern builders: `build_pii_patterns`, `build_secret_patterns`,
  `build_outbound_patterns`, `build_injection_patterns`, `build_code_injection_patterns`,
  `build_toxicity_patterns`, `build_bias_patterns`.
- `normalize_for_scan` — Unicode-obfuscation normalization pre-pass (defeats homoglyph/zero-width
  evasion before matching).
- Post-match validators: `is_credit_card_number` (Luhn), `is_public_ipv4` (drops private ranges).
- Scan types: `FirewallMatch`, `DetectionKind` (`Pii` / `Secret` / `PromptInjection` / `Toxicity`
  / `Bias` / `CodeInjection` / `ExplicitImage` / …).
- **`cmdscan`** — the command-injection scanner (`eval`/`exec`/`system`/`subprocess`/`rm -rf`/
  `<script>`/SQLi payloads).

Toxicity and bias patterns are lexical seeds only — the real judgment is the LLM-judge evaluator
path, which stays in the Gateway.

## Role in the decomposition

A **pure "engine moves, wiring stays" core crate**. The consuming wiring — `FirewallScanner` (which
holds `FirewallConfig` and the alert/inspector/evaluator config cascade), the `FirewallBackend`
trait impl, and the `FirewallRegistry` (the swap seam) — **stays in `apps/gateway/src/firewall/`**.
This crate is the detection engine those call.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`). Depends only on `regex` / `serde` /
`tracing`. Not a sidecar. Alternate firewalls swap at the Gateway's `FirewallRegistry`; this crate
supplies the detection primitives they reuse.
