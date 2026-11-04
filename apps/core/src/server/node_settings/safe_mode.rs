//! Safe Mode.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Safe Mode ────────────────────────────────────────────────────────────────

/// Read the node's Safe Mode state, why it is in that state, and what it is
/// holding back.
///
/// The counts are the point. A bare on/off switch tells a user nothing about
/// whether it did anything; "34 plugins, 12 skills and 5 MCP servers suppressed"
/// is a measurement they can act on. They are computed against the RAW records —
/// the masked read would report zero enabled plugins and the payload would say
/// safe mode is suppressing nothing, which is precisely backwards.
#[utoipa::path(
    get,
    path = "/api/safe-mode",
    tag = "Safe Mode",
    summary = "Safe Mode state and what it suppresses",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_safe_mode(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let source = crate::safe_mode::source();
    let records = state.app_store.list_all_records().await.unwrap_or_default();
    let (kernel, suppressible): (Vec<_>, Vec<_>) = records
        .iter()
        .filter(|r| r.enabled)
        .partition(|r| crate::safe_mode::keeps_plugin_enabled(&r.id));
    let counts = crate::safe_mode::SuppressedCounts {
        plugins: suppressible.len(),
        kernel_plugins: kernel.len(),
        skills: state.skills.enabled().len(),
        mcp_servers: crate::sidecar::mcp::McpRegistry::user_configured_server_count(),
    };
    // The stored preference is reported separately from the effective state: an
    // env-forced node has `enabled = true` with the pref still false, and a UI
    // that bound its switch to the effective flag alone would show a control the
    // user cannot move.
    let pref = state
        .preferences
        .get(crate::safe_mode::SAFE_MODE_PREF_KEY)
        .await
        .ok()
        .flatten();
    (
        StatusCode::OK,
        Json(json!({
            "enabled": crate::safe_mode::is_active(),
            "source": source.as_str(),
            "user_clearable": source.is_user_clearable(),
            "preference_enabled": crate::safe_mode::parse_enabled(pref.as_deref()),
            "suppressed": counts,
        })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetSafeModeBody {
    pub(in crate::server) enabled: bool,
}

/// Turn Safe Mode on or off for the NEXT boot.
///
/// Writes both persistence tiers — the preference (so every surface sees the flip
/// over the existing preferences stream) and the `<data dir>/state/safe-mode` sentinel (so
/// the next boot is safe even if this process dies before it restarts, and so a
/// Core that cannot serve HTTP can still be brought up safe). Never touches the
/// plugin lifecycle table: safe mode is a read mask, and leaving it must restore
/// the user's apps exactly, with no bookkeeping to replay.
///
/// Returns `restart_required: true` always, and that is not a cop-out. Applying
/// live would leave every sidecar, MCP child and scheduler loop that already
/// spawned still running — the switch would report success while the CPU cost it
/// exists to remove kept being paid.
#[utoipa::path(
    put,
    path = "/api/safe-mode",
    tag = "Safe Mode",
    summary = "Enable or disable Safe Mode (applies on restart)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 409, description = "Forced on by RYU_SAFE_MODE"),
    )
)]
pub(in crate::server) async fn set_safe_mode(
    State(state): State<ServerState>,
    Json(body): Json<SetSafeModeBody>,
) -> axum::response::Response {
    // An env-forced node cannot be talked out of safe mode by a preference write:
    // the env tier outranks both persisted tiers, so honouring this would produce
    // a switch that flips in the UI and changes nothing on reboot.
    if !body.enabled && crate::safe_mode::source() == crate::safe_mode::SafeModeSource::Env {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!(
                    "safe mode is forced on by {}; unset it and restart to leave safe mode",
                    crate::safe_mode::SAFE_MODE_ENV
                ),
                "source": "env",
            })),
        )
            .into_response();
    }
    if let Err(e) = crate::safe_mode::write_sentinel(body.enabled) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not write the safe-mode sentinel: {e}") })),
        )
            .into_response();
    }
    let value = if body.enabled { "true" } else { "false" };
    if let Err(e) = state
        .preferences
        .set(crate::safe_mode::SAFE_MODE_PREF_KEY, value)
        .await
    {
        // The sentinel already landed, so the next boot is correct either way;
        // report the failure rather than pretending the fan-out happened.
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not persist the safe-mode preference: {e}") })),
        )
            .into_response();
    }
    tracing::warn!(
        enabled = body.enabled,
        "safe mode {} for the next boot",
        if body.enabled { "ARMED" } else { "cleared" }
    );
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "enabled": body.enabled,
            "active_now": crate::safe_mode::is_active(),
            "restart_required": true,
        })),
    )
        .into_response()
}

// -- Capability bindings (the override-mutation API — Track A/B) ------------------

/// `GET /api/capabilities` — the read model behind the layer picker: every
/// capability any ENABLED plugin provides, its candidate providers, whether the
/// capability is *selectable* (many providers may be enabled and one is picked, the
/// engine-style UX) and which provider is bound right now.
///
/// Resolved over the ENABLED set, not the installed set, because that is the set the
/// binding registry's invariants are stated over and the set a call actually sees. A
/// capability whose provider is merely installed therefore reads as unbound, which is
/// the truth: nothing would serve a call to it.
#[utoipa::path(
    get,
    path = "/api/capabilities",
    tag = "Plugins",
    summary = "List capabilities, their providers, and the current selection",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_capabilities(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let records = match state.app_store.list().await {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let enabled_ids: std::collections::HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();
    // `known` is every manifest Core has, enabled or not. The read model needs both:
    // `enabled` decides what actually binds, `known` is what keeps a capability
    // whose providers are all disabled VISIBLE (with its candidates listed under
    // `available`) instead of vanishing from the response entirely.
    let (enabled, known): (
        Vec<crate::plugin_manifest::PluginManifest>,
        Vec<crate::plugin_manifest::PluginManifest>,
    ) = {
        let manifests = state.app_manifests.read().await;
        let known: Vec<_> = manifests.iter().cloned().collect();
        let enabled: Vec<_> = known
            .iter()
            .filter(|m| enabled_ids.contains(&m.id))
            .cloned()
            .collect();
        (enabled, known)
    };

    let json = state
        .preferences
        .get(crate::plugins::binding::BINDING_OVERRIDES_PREF_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "{}".to_owned());
    let cfg = crate::plugins::binding::config_from_overrides_json(&json);
    let capabilities = crate::plugins::binding::describe_capabilities(&enabled, &known, &cfg);

    // The stable verb ids the facade currently serves, so a picker can show what a
    // layer actually exposes rather than only which app is selected.
    let verbs: Vec<serde_json::Value> =
        crate::sidecar::mcp::capability_tools::resolve_verbs(&enabled, &cfg)
            .into_iter()
            .map(|r| {
                json!({
                    "id": r.verb.id,
                    "capability": r.verb.capability,
                    "provider": r.provider_id,
                    "target": r.binding.tool,
                })
            })
            .collect();

    (
        StatusCode::OK,
        Json(json!({ "capabilities": capabilities, "verbs": verbs })),
    )
        .into_response()
}

/// `GET /api/capabilities/bindings` — the user's capability→provider overrides
/// (the tie-breaker when 2+ enabled apps provide the same capability). Empty = the
/// zero-config auto-pick (single provider, or an explicit Ambiguous refusal).
#[utoipa::path(
    get,
    path = "/api/capabilities/bindings",
    tag = "Plugins",
    summary = "Get capability binding overrides",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_capability_bindings(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let json = state
        .preferences
        .get(crate::plugins::binding::BINDING_OVERRIDES_PREF_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "{}".to_owned());
    let cfg = crate::plugins::binding::config_from_overrides_json(&json);
    (StatusCode::OK, Json(json!({ "overrides": cfg.overrides }))).into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetBindingsBody {
    /// `capability name → provider app-id`.
    #[serde(default)]
    pub(in crate::server) overrides: std::collections::BTreeMap<String, String>,
}

/// `PUT /api/capabilities/bindings` — replace the override map. Validated against
/// the CURRENTLY ENABLED set before it is persisted or applied: an override that
/// would leave an enabled consumer unbound/ambiguous (e.g. naming a non-provider,
/// or a provider that is not enabled) is refused (409). On success it persists and
/// applies live via `set_active_config`, so the next capability resolution / enable
/// / disable uses it; already-lowered runtime edges refresh on the next
/// enable/disable of the affected plugins.
#[utoipa::path(
    put,
    path = "/api/capabilities/bindings",
    tag = "Plugins",
    summary = "Set capability binding overrides",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_capability_bindings(
    State(state): State<ServerState>,
    Json(body): Json<SetBindingsBody>,
) -> axum::response::Response {
    use crate::plugins::binding;
    let new_cfg = binding::BindingConfig {
        overrides: body.overrides,
    };

    // Validate over the ENABLED set: no enabled consumer may become unbound/ambiguous.
    let records = match state.app_store.list().await {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let enabled_ids: std::collections::HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();
    let enabled: Vec<crate::plugin_manifest::PluginManifest> = {
        let manifests = state.app_manifests.read().await;
        manifests
            .iter()
            .filter(|m| enabled_ids.contains(&m.id))
            .cloned()
            .collect()
    };
    if let Some((plugin, err)) = binding::first_binding_error(&enabled, &new_cfg) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": err.to_string(),
                "plugin": plugin,
                "binding_error": err.code(),
            })),
        )
            .into_response();
    }

    // Persist + apply live.
    let json = binding::overrides_to_json(&new_cfg);
    if let Err(e) = state
        .preferences
        .set(binding::BINDING_OVERRIDES_PREF_KEY, &json)
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    binding::set_active_config(new_cfg.clone());
    // A re-pinned `network.tunnel` must move a live plugin tunnel, not just the
    // status read: stop the old provider's tunnel and start the new one.
    tokio::spawn(crate::sidecar::plugin_tunnel::reconcile_binding());
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "overrides": new_cfg.overrides })),
    )
        .into_response()
}
