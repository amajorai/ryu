# ryu-predict

Predict — the system-wide predictive-typing **brain**, an extracted **Core capability
crate**. It powers inline autocomplete (ghost text, Tab to accept) for any native app.
The native overlay (`apps-store/predict`) stays deliberately dumb: it reads the caret
context, POSTs it here, and renders whatever string comes back. No Gateway URL, key, or
model id ever lives in the overlay process.

## Role in the decomposition

A primitive lifted out of `apps/core`. This crate owns the completion **engine**: the
config (model / effort / per-app allowlist / debounce), the secure-field denylist,
prompt assembly, reply cleanup, and the `/api/predict/*` HTTP surface. Every
cross-cutting call — preferences, the agent's bound model, the default model id, the
Gateway side-model call, and the plugin-owned enabled flag — is inverted through the
`PredictHost` trait, so the crate has **zero dependency on `apps/core`**.

## Placement (Core vs Gateway)

Deciding *what runs* (assemble the prompt, enforce the app allowlist, refuse secure
fields) is **Core**. The model call is handed to the **Gateway** via
`PredictHost::call_side_model` (the same path `/btw`, goals, and double-check use), so
model routing / firewall / budgets / audit all apply.

## Key API

- `PredictHost` (trait) — the inversion seam; implemented Core-side in
  `predict_host.rs` over `ServerState`.
- `PredictConfig` — persisted `camelCase` config blob (pref key `predict-config`),
  shared with the desktop settings tab and the overlay.
- `is_secure_control(control)` — pure, fail-closed password/secure-field refusal.
- `app_allowed(allowlist, app)` — per-app basename allowlist (empty = all apps).
- `build_messages(context)` / `clean_suggestion(raw, max)` — prompt + reply hygiene.
- `routes()` / `PredictCtx` — the `/config` (get/put) + `/complete` axum router.

## What stayed in the kernel

The process-global on/off flag (`predict::set_enabled` / `is_enabled`, seeded at boot
from the built-in **Predict** plugin, flipped on plugin enable/disable) stays in
`apps/core` — it is the plugin's switch, read here via `PredictHost::is_enabled`.

## Consumed as

Compiled-into-core crate (non-optional path dependency), merged into Core's router.

## Swap-seam

The model is never hardcoded: it resolves agent-bound model → config `model` → env →
`PredictHost::default_model`, and the call routes through the swappable Gateway.
