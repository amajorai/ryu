//! Dispatch of one kernel capability call.

use super::*;

/// Dispatch an authenticated + grant-checked kernel capability to its in-Core
/// implementation.
///
/// The handlers keep their existing `(State, HeaderMap, Json<Body>)` shape and are
/// called directly — no HTTP hop, no signature change (they are still the same
/// functions the retired per-app routes pointed at, which is what makes this a
/// re-routing rather than a rewrite). Each re-runs [`authenticate_sidecar`]; the
/// pinned ones (`mcp.callTool`, `notify.fanout`, `spaces.fileNotes`, `email.*`,
/// `ghost.*`) also refuse a caller that is not the app they serve. Those pins are
/// deliberately preserved (see [`KernelCapability::grant`]).
pub(super) async fn dispatch_kernel_capability(
    cap: &str,
    state: ServerState,
    headers: HeaderMap,
    body: &[u8],
) -> Response {
    /// Deserialize a kernel-capability body, 400ing with the serde message rather
    /// than letting a malformed body surface as a bare rejection.
    fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Response> {
        // An empty body is a valid `{}` for the arg-less verbs.
        let raw = if body.is_empty() {
            b"{}".as_slice()
        } else {
            body
        };
        serde_json::from_slice::<T>(raw).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid capability body: {e}") })),
            )
                .into_response()
        })
    }

    macro_rules! body {
        ($t:ty) => {
            match parse::<$t>(body) {
                Ok(v) => Json(v),
                Err(resp) => return resp,
            }
        };
    }

    match cap {
        "mcp.callTool" => {
            crate::server::app_mcp_call::host_mcp_call_tool(
                State(state),
                headers,
                body!(serde_json::Value),
            )
            .await
        }
        "chat.startTurn" => {
            crate::server::host_chat::host_chat_start_turn(
                State(state),
                headers,
                body!(crate::server::host_chat::StartTurnBody),
            )
            .await
        }
        "threads.ensureMainThread" => {
            crate::server::host_hierarchy::host_ensure_main_thread(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::EnsureMainThreadBody),
            )
            .await
        }
        "threads.placeInProject" => {
            crate::server::host_hierarchy::host_place_in_project(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::PlaceInProjectBody),
            )
            .await
        }
        "scopeDefaults.set" => {
            crate::server::host_hierarchy::host_set_scope_default(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::SetScopeDefaultBody),
            )
            .await
        }
        "scopeGuidance.set" => {
            crate::server::host_hierarchy::host_set_scope_guidance(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::SetScopeGuidanceBody),
            )
            .await
        }
        "node.readings" => {
            crate::server::host_chat::host_node_readings(
                State(state),
                headers,
                body!(crate::server::host_chat::ReadingsBody),
            )
            .await
        }
        "notify.fanout" => {
            crate::server::app_notify::host_notify_fanout(
                State(state),
                headers,
                body!(crate::server::app_notify::AlertFanoutBody),
            )
            .await
        }
        "notify.deliver" => {
            crate::server::app_notify::host_notify_deliver(
                State(state),
                headers,
                body!(crate::server::app_notify::DeliverBody),
            )
            .await
        }
        "email.send" => {
            crate::server::app_email::host_email_send(
                State(state),
                headers,
                body!(crate::server::app_email::SendBody),
            )
            .await
        }
        "email.status" => crate::server::app_email::host_email_status(State(state), headers).await,
        "vault.credentialFill" => {
            crate::server::vault_agent_accounts_api::host_credential_fill(
                State(state),
                headers,
                body!(crate::server::vault_agent_accounts_api::FillBody),
            )
            .await
        }
        // Boxed: the held ceremony's future is large and would otherwise grow
        // every capability call's stack frame.
        ryu_webauthn_relay::HOST_CAPABILITY => {
            Box::pin(crate::server::security_key_relay::host_security_key_request(
                state, headers, body,
            ))
            .await
        }
        "vault.totpEnroll" => {
            crate::server::vault_agent_accounts_api::host_totp_enroll(
                State(state),
                headers,
                body!(crate::server::vault_agent_accounts_api::EnrollBody),
            )
            .await
        }
        "egress.fetch" => {
            crate::server::app_egress::host_egress_fetch(
                State(state),
                headers,
                body!(crate::server::app_egress::FetchBody),
            )
            .await
        }
        "billing.recordToolCharge" => {
            crate::server::app_tool_usage::host_tool_usage_record(
                State(state),
                headers,
                body!(crate::server::app_tool_usage::ToolUsageBody),
            )
            .await
        }
        "providers.status" => {
            crate::server::provider_router::host_provider_status(
                State(state),
                headers,
                body!(crate::server::provider_router::ProviderStatusBody),
            )
            .await
        }
        "providers.call" => {
            crate::server::provider_router::host_provider_call(
                State(state),
                headers,
                body!(ryu_app_events::ManagedProviderCall),
            )
            .await
        }
        "providers.authorize" => {
            crate::server::provider_router::host_provider_authorize(
                State(state),
                headers,
                body!(crate::server::provider_router::ProviderAuthorizeBody),
            )
            .await
        }
        "tools.call" => {
            crate::server::call_tool_for_sidecar(
                state,
                headers,
                body!(crate::server::SidecarToolCall).0,
            )
            .await
        }
        "plugins.installBundle" => {
            crate::server::install_bundle_for_sidecar(state, headers, body!(serde_json::Value).0)
                .await
        }
        "spaces.fileNotes" => {
            crate::server::app_file_notes::host_file_notes(
                State(state),
                headers,
                body!(crate::server::app_file_notes::FileNotesBody),
            )
            .await
        }
        "ghost.replay" => {
            crate::recipes_host::host_recipes_run(State(state), headers, body!(serde_json::Value))
                .await
        }
        "ghost.recordStart" => {
            crate::recipes_host::host_recipes_record_start(
                State(state),
                headers,
                body!(serde_json::Value),
            )
            .await
        }
        "ghost.recordStatus" => {
            crate::recipes_host::host_recipes_record_status(State(state), headers).await
        }
        "ghost.recordStop" => {
            crate::recipes_host::host_recipes_record_stop(State(state), headers).await
        }
        "events.emit" => host_events_emit(state, headers, body!(EventEmitBody)).await,
        "webhooks.list" | "webhooks.ingressStatus" => {
            match crate::server::app_webhooks::WebhookOp::from_name(cap) {
                Some(op) => Json(op.run(&state).await).into_response(),
                None => (
                    StatusCode::NOT_IMPLEMENTED,
                    Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
                )
                    .into_response(),
            }
        }
        "warmup.detect" | "warmup.list" | "warmup.apply" | "warmup.runNow" => {
            host_warmup(cap, state, headers, body!(serde_json::Value).0).await
        }
        "approvals.request" | "runs.rerunAgent" | "workflows.rerun" => {
            crate::server::app_runs::host_run_recovery(
                cap,
                &state,
                &headers,
                body!(serde_json::Value).0,
            )
            .await
        }
        "realtime.publish" => {
            host_realtime_publish(state, headers, body!(RealtimePublishBody)).await
        }
        // Unreachable: the caller only gets here after `kernel_capability` matched,
        // and that reads the same table this match implements. Fail closed anyway so
        // a future row added to one and not the other cannot 500 or, worse, fall
        // through to the provider path ungated.
        _ => (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
        )
            .into_response(),
    }
}

// ── Capability broker (/api/host/capability/:cap) ─────────────────────────────
