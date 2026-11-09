//! Version/update, preferences, safe mode, capability bindings, email and alert delivery, model launch config and downloads: `set_preference` through `set_preference`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    put,
    path = "/api/preferences/{key}",
    tag = "Preferences",
    summary = "Set a preference value",
    params(("key" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Protected preference requires its dedicated API", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn set_preference(
    State(state): State<ServerState>,
    Path(key): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SetPreferenceBody>,
) -> axum::response::Response {
    // This key controls installation destinations. Only the dedicated handler
    // may write it after app.install authorization and registry validation.
    if let Some(response) = generic_preference_write_denial(&key) {
        return response;
    }
    // Exporter-preset fields: refuse values that could never resolve, and keep
    // literal credentials out of the preferences store.
    if let Err(message) = crate::privacy::validate_otlp_preset_pref(&key, &body.value) {
        return json_error(StatusCode::BAD_REQUEST, message);
    }
    if key == crate::server::onboarding_state::USER_PERSONALIZATION_PREF_KEY
        && !crate::server::onboarding_state::can_access_user_personalization(&caller)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "personalization is not available on this node" })),
        )
            .into_response();
    }
    // GET answers a credential with a placeholder; a client that saves the form
    // unchanged sends it back, which must keep the stored credential (and skip
    // the side effects below, which would otherwise adopt the placeholder).
    if crate::server::preferences::is_secret_preference_key(&key)
        && ryu_crypto::redact::is_placeholder(&body.value)
    {
        return (StatusCode::OK, Json(json!({ "ok": true, "key": key }))).into_response();
    }
    // A whole-list write of the trusted folders waits for any in-flight
    // add/remove so it cannot land between that edit's read and write.
    let _trust_edit = if key == crate::workspace_trust::TRUSTED_WORKSPACES_PREF_KEY {
        Some(crate::workspace_trust::lock_edits().await)
    } else {
        None
    };
    // Likewise a whole-document write of the shortcut overrides waits for any
    // in-flight entry edit.
    let _keybinding_edit = if key == preferences::KEYBINDINGS_KEY {
        Some(preferences::lock_keybinding_edits().await)
    } else {
        None
    };
    match state.preferences.set(&key, &body.value).await {
        Ok(()) => {
            if key == crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY {
                let enabled = crate::privacy::diagnostics_export_enabled(&state.preferences).await;
                crate::telemetry::set_export_consent(enabled);
                crate::ryu_analytics::sync_gateway_relay_config();
                if let Err(error) = state.gateway.refresh().await {
                    tracing::warn!(error = %error, "gateway: refresh after diagnostics-consent change failed");
                }
            }
            if key == crate::privacy::DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY
                || key == crate::privacy::DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY
            {
                let previous = (
                    crate::telemetry::content_mode(),
                    crate::telemetry::max_content_bytes(),
                );
                crate::telemetry::set_content_mode(
                    crate::privacy::diagnostics_otlp_content_mode(&state.preferences).await,
                );
                crate::telemetry::set_max_content_bytes(
                    crate::privacy::diagnostics_otlp_max_content_bytes(&state.preferences).await,
                );
                let current = (
                    crate::telemetry::content_mode(),
                    crate::telemetry::max_content_bytes(),
                );
                // The Gateway only receives content settings while export is
                // consented, so a respawn (which drops in-flight requests) is
                // needed only when export is on and the value actually changed.
                if crate::telemetry::content_settings_need_gateway_refresh(
                    crate::telemetry::is_export_consented(),
                    previous,
                    current,
                ) {
                    if let Err(error) = state.gateway.refresh().await {
                        tracing::warn!(error = %error, "gateway: refresh after OTLP content-mode change failed");
                    }
                }
            }
            if crate::privacy::is_otlp_destination_pref_key(&key) {
                crate::telemetry::note_otlp_endpoint_changed();
                crate::ryu_analytics::sync_gateway_relay_config();
                if let Err(error) = state.gateway.refresh().await {
                    tracing::warn!(error = %error, "gateway: refresh after OTLP-endpoint change failed");
                }
            }
            if key == crate::exec_approval::EXEC_APPROVAL_MODE_PREF_KEY {
                crate::exec_approval::apply_from_pref(&body.value);
            }
            if key == crate::workspace_trust::TRUSTED_WORKSPACES_PREF_KEY {
                crate::workspace_trust::set_from_pref(&body.value);
            }
            if key == conversations::ConversationStore::CHAT_MEMORY_ENABLED_PREF_KEY {
                let enabled =
                    conversations::ConversationStore::parse_chat_memory_enabled(Some(&body.value));
                if let Err(error) = state.conversations.set_chat_memory_enabled(enabled).await {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": error.to_string() })),
                    )
                        .into_response();
                }
                if enabled {
                    let conversations = state.conversations.clone();
                    tokio::spawn(async move {
                        if let Err(error) = conversations.reindex_message_embeddings().await {
                            tracing::warn!(
                                error = %error,
                                "chat memory: reindex after enabling failed"
                            );
                        }
                    });
                } else if let Err(error) = state.conversations.clear_message_embeddings().await {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": error.to_string() })),
                    )
                        .into_response();
                }
            }
            // Keep the in-process Hugging Face token resolver in sync so gated
            // model search + downloads pick up the change without a restart.
            if key == crate::hf_auth::HF_TOKEN_PREF_KEY {
                crate::hf_auth::set_token(&body.value);
            }
            // Same for the Artificial Analysis API key (model-catalog stats).
            if key == crate::model_catalog::aa::AA_API_KEY_PREF_KEY {
                crate::model_catalog::aa::set_key(&body.value).await;
            }
            // Managed-inference fleet coordinates. Re-read BOTH keys (the pair is
            // meaningless half-set — a URL with no token 401s against the fleet)
            // and refresh the process-global the synchronous `pi_config::apply`
            // path consults, so pointing a self-hosted node at managed inference
            // takes effect without a Core restart.
            if key == crate::sidecar::gateway::MANAGED_FLEET_URL_PREF_KEY
                || key == crate::sidecar::gateway::MANAGED_FLEET_TOKEN_PREF_KEY
            {
                let url = state
                    .preferences
                    .get(crate::sidecar::gateway::MANAGED_FLEET_URL_PREF_KEY)
                    .await
                    .ok()
                    .flatten();
                let token = state
                    .preferences
                    .get(crate::sidecar::gateway::MANAGED_FLEET_TOKEN_PREF_KEY)
                    .await
                    .ok()
                    .flatten();
                crate::sidecar::gateway::set_managed_fleet_pref(url, token);
            }
            // The node-routing envelope is read synchronously on every gateway
            // forward. Refresh its pre-encoded carrier after the atomic JSON
            // preference write so fallback/firewall edits apply immediately.
            if key == crate::sidecar::gateway::NODE_ROUTING_PREF_KEY {
                crate::sidecar::gateway::set_node_routing_prefs_from_json(&body.value);
            }
            // And the AA fetch mode (cached daily cache vs. realtime live fetch).
            if key == crate::model_catalog::aa::AA_MODE_PREF_KEY {
                crate::model_catalog::aa::set_mode(&body.value);
            }
            // Composio API key: keep the resolver in sync AND respawn the gateway
            // so its Composio tool loop picks up the new key (the gateway reads
            // `COMPOSIO_API_KEY` from its spawn env; a refresh re-injects it).
            // Best-effort — a refresh failure must not fail the preference write.
            if key == crate::composio_auth::COMPOSIO_API_KEY_PREF_KEY {
                crate::composio_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Composio key change failed: {e}");
                }
            }
            // OpenRouter API key (A4 / #501): same pattern — keep the resolver in
            // sync and respawn the gateway so its `openrouter` provider picks up
            // the new key (the gateway reads `OPENROUTER_API_KEY` from spawn env).
            if key == crate::openrouter_auth::OPENROUTER_API_KEY_PREF_KEY {
                crate::openrouter_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after OpenRouter key change failed: {e}");
                }
            }
            // Cloud media provider keys (Replicate / Fal): same pattern — sync the
            // resolver and respawn the gateway so its `replicate` / `fal` media
            // providers pick up the new key (read from spawn env).
            if key == crate::replicate_auth::REPLICATE_API_KEY_PREF_KEY {
                crate::replicate_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Replicate key change failed: {e}");
                }
            }
            if key == crate::fal_auth::FAL_API_KEY_PREF_KEY {
                crate::fal_auth::set_key(&body.value);
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!("gateway: refresh after Fal key change failed: {e}");
                }
            }
            // Claude Code gateway-routing toggle: keep the in-process flag in sync
            // so the next Claude Code spawn injects (or omits) `ANTHROPIC_BASE_URL`.
            // No gateway respawn needed — the flag is read on Core's spawn path.
            if key == crate::claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY {
                crate::claude_config::set_enabled(&body.value);
            }
            // RTK per-agent auto-wrap (rtk Phase 2): keep the in-process flag
            // in sync and reconcile the agent's RTK PreToolUse hook. Spawned so the
            // (possibly process-launching) `rtk init` never blocks the pref write;
            // a no-op when rtk is not on PATH.
            if let Some(agent) = crate::rtk_config::WrapAgent::from_pref_key(&key) {
                crate::rtk_config::set_enabled(agent, &body.value);
                let enable = crate::rtk_config::is_enabled(agent);
                tokio::spawn(async move {
                    if let Err(e) = crate::rtk_config::configure(agent, enable).await {
                        tracing::warn!(error = %e, "rtk auto-wrap: reconfigure on pref change failed");
                    }
                });
            }
            // RTK exclude list: merge into rtk's config.toml so its hooks + the
            // `rtk.run` tool skip these commands. No-op when rtk is not installed.
            if key == crate::rtk_config::EXCLUDE_COMMANDS_PREF_KEY {
                if let Err(e) = crate::rtk_config::set_exclude_commands(&body.value) {
                    tracing::warn!(error = %e, "rtk auto-wrap: writing exclude_commands failed");
                }
            }
            // TokenEconomizer bridge: rewrite (or remove) the managed Pi's pointer
            // file so the next Pi process picks up the folder and mechanism modes.
            if crate::tokeneconomizer_config::is_pref_key(&key) {
                if let Err(e) = crate::tokeneconomizer_config::reconcile(&state.preferences).await {
                    tracing::warn!(error = %e, "tokeneconomizer: reconcile on pref change failed");
                }
            }
            // Untrusted-content wrapping toggle: keep the in-process flag in sync
            // so the next tool result wraps (or, on opt-out, does not) before it
            // re-enters the model. Read on Core's tool-result path.
            if key == crate::sidecar::untrusted::UNTRUSTED_WRAPPING_PREF_KEY {
                crate::sidecar::untrusted::set_enabled(&body.value);
            }
            // Node entitlement gate (#496): keep the in-process flag in sync so
            // the scheduler pauses (or resumes) autonomous automation the moment
            // the desktop pushes a new entitlement verdict. No gateway respawn —
            // the flag is read on Core's (sync) scheduler tick path.
            if key == crate::entitlement::ENTITLEMENT_ACTIVE_PREF_KEY {
                crate::entitlement::set_active(&body.value);
            }
            if key == crate::entitlement::MANAGED_INFERENCE_ENTITLED_PREF_KEY {
                crate::entitlement::set_managed_inference_entitled(&body.value);
            }
            // Generic per-agent gateway routing: keep the in-process map in sync so
            // the next spawn of any toggled agent injects (or omits) OPENAI_BASE_URL.
            // No gateway respawn needed — the map is read on Core's spawn path.
            if key == crate::agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY {
                crate::agent_routing::set_from_json(&body.value);
            }
            // Per-agent MCP tool bridge: keep the in-process map in sync so the
            // next ACP session for the changed agent is built with (or without)
            // Ryu's bridge. A SEPARATE key from the gateway-routing one above —
            // writing egress must never move the tool gate, and vice versa.
            if key == crate::agent_routing::AGENT_TOOL_BRIDGE_PREF_KEY {
                crate::agent_routing::set_bridge_from_json(&body.value);
            }
            // Per-agent Plane A model-routing overrides (spec §1): keep the
            // in-process map in sync so the next forwarded chat injects (or omits)
            // `ryu_smart_route` for the changed agent. No gateway respawn — the map
            // is read on Core's (async) chat-forward path.
            if key == crate::agent_routing::AGENT_SMART_ROUTE_PREF_KEY {
                crate::agent_routing::set_smart_routes_from_json(&body.value);
            }
            // Plane B agent-auto routing config (spec §2): keep the in-process
            // snapshot in sync so the next "auto" turn resolves with the new rules.
            if key == crate::agent_routing::AGENT_AUTO_ROUTING_PREF_KEY {
                crate::agent_routing::set_auto_config_from_json(&body.value);
            }
            // Keep both lane snapshots in step so interactive chat and plugin
            // model resolution see preference writes without a restart.
            if key == crate::agent_selection::GLOBAL_SELECTION_PREF
                || key == crate::agent_selection::LOCAL_SELECTION_PREF
            {
                crate::agent_selection::set_local_selection_from_json(&body.value);
            } else if key == crate::agent_selection::CLOUD_SELECTION_PREF {
                crate::agent_selection::set_cloud_selection_from_json(&body.value);
            }
            (StatusCode::OK, Json(json!({ "ok": true, "key": key }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
