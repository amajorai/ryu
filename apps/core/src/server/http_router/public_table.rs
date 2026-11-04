//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `public_routes` through `public_routes`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The public (unauthenticated) route table of [`create_router`], before the
/// routers it merges in that authenticate in-handler.
pub(in crate::server) fn public_routes(state: &ServerState) -> Router<ServerState> {
    Router::new()
        .route(
            "/internal/dev-execution/peer-proof",
            get(crate::dev_execution::peer_proof_handler),
        )
        .route(
            "/internal/dev-execution/stop",
            post(crate::dev_execution::stop_handler),
        )
        .route(
            crate::dev_execution::ACTIVITY_PATH,
            get(
                |axum::extract::Query(query): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| async move {
                    crate::dev_execution::activity_response(
                        &query,
                        crate::sidecar::adapters::live_turn::running_turns(),
                    )
                },
            ),
        )
        .route("/api/health", get(health))
        // Credential-free proof of node-token possession, so local clients can
        // authenticate this listener before sending their bearer to it.
        .route("/api/health/identity", get(core_identity::identity_handler))
        // Managed Pi has no safe node/user bearer to carry across the ACP
        // boundary. This public mount accepts only Core-minted, session-bound
        // capabilities in its handler; it does not pass through general auth.
        .route(
            "/api/acp/tools",
            post(call_acp_tool).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        // The same capability, served as MCP to Pi's built-in client
        // (`pi.registerMcpServer` in `ryu-mcp.ts`). Stateless JSON responses;
        // the GET SSE stream is deliberately absent (405), which the MCP client
        // treats as "no server-to-client stream".
        .route(
            "/api/acp/mcp",
            post(serve_acp_mcp).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        // An ACP agent's model calls, forwarded to the local Gateway with the
        // current scoped bearer. Accepts only a live per-instance credential
        // (or a Core-signed scoped bearer) from loopback, checked in the handler.
        .route(
            "/api/acp/inference/v1/*rest",
            axum::routing::any(acp_inference_proxy::proxy)
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        // Generated OpenAPI spec for this Core (public so docs tooling can fetch it).
        .route("/api/openapi.json", get(openapi::serve_openapi))
        // ── Version + update verdict (read-only, public so every surface —
        // including the unauthenticated extension/cli — can show the toast) ──
        .route("/api/version", get(get_version))
        .route("/api/update/check", get(update_check))
        // ── Ryu Hardware Protocol (RHP v1) public surface ────────────────────
        // The realtime device link: a device presents a PER-DEVICE Bearer token,
        // which `require_auth` (which only knows the global RYU_TOKEN) would
        // reject — so the WS handler authenticates the device token against the
        // registry itself. Pairing mints a durable device credential, so it is
        // protected below even though the device also proves its nonce.
        .route("/api/hardware/ws", get(hardware_ws::hardware_ws))
        // ── Realtime room gateway (Phase 1 multi-user epic) ──────────────────
        // Room-keyed fan-out for live chat / presence / (Phase 3) doc-sync. On
        // the PUBLIC router because browsers cannot set custom authorization
        // headers on a WS upgrade. Clients exchange normal HTTP credentials for a
        // short-lived, one-use Core ticket first; only that opaque ticket is
        // accepted in the upgrade query.
        .route("/api/realtime/ws", get(realtime_ws::realtime_ws))
        // Realtime voice mode (desktop/island). Public router; it consumes the
        // same short-lived ticket before the browser upgrade.
        .route("/api/voice/ws", get(voice_ws::voice_ws))
        // Browser clients exchange their normal HTTP authentication for a
        // one-use ticket before opening either socket or a protected extension
        // WebSocket. Credentials never appear in a WS URL.
        .route(
            "/api/ws/ticket",
            post(ws_ticket::issue).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        // TRMNL display surface: the device polls these with its OWN per-device
        // Bearer token (which `require_auth`/global-RYU_TOKEN can't gate), so the
        // handlers authenticate the device token against the registry themselves —
        // the same model as the WS upgrade. Hence: public router. The handlers live
        // in the extracted `ryu_hardware::api` crate; nested here (public, ungated).
        .nest_service(
            "/api/hardware/display",
            ryu_hardware::api::display_routes(hardware_ctx(&state)),
        )
        // Inbound Composio webhook: public (external delivery can't send the bearer
        // token) but HMAC-authenticated fail-closed inside the handler.
        .route("/api/composio/webhook", post(composio_webhook))
        // Inbound per-workflow webhook trigger: public (an external integration/app
        // can't send the node bearer) but HMAC-authenticated against the trigger's
        // own secret, fail-closed inside the handler. The universal "any service
        // that can POST triggers a workflow" path, beyond Composio.
        .route("/api/workflows/:id/webhook", post(workflow_webhook))
        // Inbound agent mail: public (a mail provider/forwarder can't send the node
        // bearer) but HMAC-authenticated against the inbox's `inbound_secret`,
        // fail-closed inside the handler.
        // Governed widget asset proxy. A sandboxed widget frame (CSP `connect-src
        // 'none'`) loads declared remote images/fonts as `<img>`/`@font-face`
        // subresources, which cannot carry the node bearer — so this rides the
        // PUBLIC router and authenticates in-handler against the minted `instance`
        // id + the origin server's declared `resource_domains` allowlist, with a
        // fail-closed SSRF guard. It is the img-src analogue of the governed
        // `callTool` lane and the ONLY egress path a widget's passive assets have.
        .route("/api/widgets/asset", get(widgets::widget_asset))
        // ── Device-code pairing (public half) ────────────────────────────────
        // A client with no bearer asks for a code and polls for the result. Both
        // MUST be public: having no credential yet is the entire premise. Neither
        // grants anything on its own — issuing a token requires a human approving
        // through the PROTECTED half below, so an unauthenticated caller can only
        // create a pending request that expires unclaimed.
        .merge(
            Router::new()
                .route("/api/pair/code", post(pair_start))
                .route("/api/pair/token", post(pair_poll))
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        // External authorization servers cannot carry the node bearer. The
        // handler authenticates with the one-time PKCE flow state and returns a
        // static no-store completion page; it never returns code/token material.
        .route(
            "/api/mcp/oauth/callback",
            get(mcp_oauth_api::hosted_callback),
        )
        .route(
            "/api/mcp/oauth/client-metadata.json",
            get(mcp_oauth_api::client_metadata),
        )
}
