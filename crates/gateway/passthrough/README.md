# ryu-gw-passthrough

Ryu **Gateway** passthrough wire-format **redaction engine** (decomposition W6), extracted from
`apps/gateway/src/passthrough`.

## What it is

The *pure* text-processing core of the native-format passthrough proxy — the path that governs
Claude Code and Codex chat egress while preserving the caller's own subscription/bearer:

- **Request-body DLP** — `redact_request_body` dispatches on `WireFormat`:
  `redact_anthropic_body` (Anthropic Messages) / `redact_responses_body` (OpenAI Responses).
- **Streaming-SSE response redaction** — `drain_complete_events` reassembles SSE events across
  network-chunk boundaries; `redact_sse_event` sanitizes each text delta.
- **URL/path helpers** — `build_upstream_url`, `is_messages_path`, `is_responses_path`.
- **`WireFormat`** — `Anthropic` (`/v1/messages`) / `OpenAiResponses` (`/responses`) marker.

It touches the firewall only through the narrow **`PassthroughFirewall`** trait
(`sanitize` + `redact_outbound`), so it carries no `SharedState` / `reqwest` / `axum` dependency —
its only dep is `serde_json`.

## Role in the decomposition

A **pure "engine moves, wiring stays" core crate** (mirrors `ryu-gw-firewall`). The SharedState-bound
wiring — the `forward` reverse-proxy orchestration, audit emission, the loopback boundary, and the
`PassthroughBackend` trait + `PassthroughRegistry` (the swap seam) — **stays in
`apps/gateway/src/passthrough`** and consumes this crate. The Gateway's `FirewallScanner` /
`dyn FirewallBackend` implement `PassthroughFirewall`, so the engine reuses the real config-gated
redaction.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`). Not a sidecar.
