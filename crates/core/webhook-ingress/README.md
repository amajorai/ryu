# ryu-webhook-ingress

The swappable **public-reachability seam** (unified-tool-gateway epic #479, P6a) that
lets a loopback-bound Ryu Core receive third-party webhooks — Composio triggers (which
are webhook-delivered, with no event-pull API) and per-workflow webhooks — by giving
Core a publicly-reachable URL pointed at its existing handler.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default (no IPC on any hot path). Exposing a tunnel + deciding which backend runs is
*what runs* → **Core**; there is no policy here. Public webhook **routes** stay
kernel-ingress in Core and forward inbound deliveries into this engine.

Zero dependency on `apps/core`. The kernel couplings (Composio verify/run,
workflow-secret lookup, mesh funnel, auth token, data dir) invert through the
**`WebhookIngressHost`** trait, installed by Core at boot via `set_global_host`.

## Nothing hardcoded — the backend swap seam

The backend is a swappable `Ingress` enum selected by the `webhook.ingress.backend`
pref (`IngressKind`, kebab-case wire form), default `RyuRelay`:

- **RyuRelay** — the managed default: outbound SSE push (no inbound port).
- **TailscaleFunnel** — via `ryu-mesh`'s `ensure_funnel`.
- **Cloudflared** — a quick tunnel subprocess.
- **OwnRelay** — BYO public base URL (`RYU_WEBHOOK_INGRESS_URL` env override, else the
  `webhook.ingress.url` pref).

Backend dispatch uses native `async fn` trait methods + a closed enum match — no
`async-trait`/`dyn` (the host seam is the one `dyn` boundary).

## Key surface

- `Ingress` / `IngressKind` + backend sources (`RyuRelaySource`,
  `TailscaleFunnelSource`, `CloudflaredSource`, `OwnRelaySource`).
- `deliver_inbound` / `deliver_workflow_webhook` — the path-routed inbound dispatcher
  with fail-closed HMAC re-verification, a replay window, and delivery dedup.
- `record_delivery` / `last_delivery` / `timestamp_fresh` / `workflow_webhook_path`.

## Consumed as

Compiled-into-Core crate; Core's public webhook routes forward into it.

Deps: tokio, reqwest, futures-util, serde/serde_json, anyhow, async-trait.
