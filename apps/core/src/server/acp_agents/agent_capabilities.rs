//! ACP agent config, accounts, sessions, updates and capability overrides: `agent_update` through `set_agent_capabilities`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/agents/:id/update` — update the agent runtime to the latest version.
///
/// For the managed Pi (`ryu`) this stages the newest `@earendil-works/pi-coding-agent`
/// and `pi-acp` together and activates them only after the readiness probe passes.
/// For everything else the update has to reach whatever the catalog's
/// `installed_version` is PROBED from, which is the CLI on `PATH` — warming npx
/// populates `~/.npm/_npx` and moves no binary, so an update that only warmed the
/// cache left the row reporting the old version forever and the button looked dead.
/// So: the npx-fetched bridge is warmed (that genuinely is its update), the CLI is
/// re-installed through the channel that owns it, and the verdict is decided by
/// re-probing rather than asserted. When the CLI came from outside Ryu, that is
/// reported as `updated: false` plus a hint instead of a success that did nothing.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/update",
    tag = "Agents",
    summary = "Update an agent runtime to the latest version",
    params(("id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn agent_update(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    if agent_id == "ryu" {
        // Tracked like every other agent runtime fetch — this pulls the managed Pi
        // through npm and is otherwise silent to the Downloads surfaces.
        let managed = state
            .downloads
            .register_indeterminate(
                "agent:ryu".to_string(),
                crate::downloads::DownloadKind::Agent,
                "Ryu agent runtime".to_string(),
                crate::sidecar::adapters::acp::update_managed_pi(),
            )
            .await;
        return match managed {
            Ok(()) => {
                let version = crate::sidecar::adapters::acp::read_managed_pi_version();
                (
                    StatusCode::OK,
                    Json(json!({ "updated": true, "installedVersion": version })),
                )
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "updated": false, "error": e.to_string() })),
            ),
        };
    }
    use crate::sidecar::agents::acp_registry::npm_package_name;

    let probe = state
        .agents
        .find_by_prefix(&agent_id)
        .and_then(|e| e.version_probe.clone());
    let binary = probe.as_ref().and_then(|p| p.binary);
    let cli_pkg = probe.as_ref().and_then(|p| p.npm_package.clone());
    // The spawn command's package IS the bridge for an ACP agent; fall back to it
    // so agents with no `version_probe` row still get their runtime refreshed.
    let bridge_pkg = match probe.as_ref().and_then(|p| p.bridge_npm_package.clone()) {
        Some(pkg) => Some(pkg),
        None => agent_npm_package(&state, &agent_id).await,
    };

    if cli_pkg.is_none() && bridge_pkg.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "updated": false, "error": "no updatable runtime for this agent" })),
        );
    }

    let probe_installed = || async {
        match binary {
            Some(bin) if crate::sidecar::adapters::acp::binary_in_path(bin) => {
                crate::sidecar::adapters::acp::probe_cli_version(bin).await
            }
            _ => None,
        }
    };
    let before = probe_installed().await;

    // The bridge is always npx-fetched, so warming it at `@latest` is its update.
    // Tracked for the same reason the install path is: an update is a fetch of the
    // same size, and it was equally invisible on the Downloads surfaces.
    if let Some(bridge) = bridge_pkg.as_deref() {
        let tagged = format!("{}@latest", npm_package_name(bridge));
        let label = format!("{} (bridge)", npx_row_label(&tagged));
        warm_npx_package_tracked(&state.downloads, &tagged, &label).await;
    }

    // The underlying CLI, through whichever channel owns it.
    let mut hint: Option<String> = None;
    if let Some(pkg) = cli_pkg.as_deref() {
        let pkg = npm_package_name(pkg);
        let channel = binary.and_then(agent_install_channel);
        // `npm install` reports no byte progress either, so the CLI leg tracks as
        // one indeterminate row named after the package.
        let npm_row_id = format!("npm:{pkg}");
        let npm_row_label = npx_row_label(&pkg);
        let install = match &channel {
            Some(AgentInstallChannel::RyuPrefix) => Some(
                state
                    .downloads
                    .register_indeterminate(
                        npm_row_id,
                        crate::downloads::DownloadKind::Agent,
                        npm_row_label,
                        npm_install_agent_package(&pkg, Some(crate::paths::runtime_dir("npm"))),
                    )
                    .await,
            ),
            Some(AgentInstallChannel::NpmGlobal) => Some(
                state
                    .downloads
                    .register_indeterminate(
                        npm_row_id,
                        crate::downloads::DownloadKind::Agent,
                        npm_row_label,
                        npm_install_agent_package(&pkg, None),
                    )
                    .await,
            ),
            Some(AgentInstallChannel::External(path)) => {
                hint = Some(format!(
                    "{} is installed at {} — outside Ryu, so Ryu cannot upgrade it. \
                     Update it with the tool that installed it (its own `update` \
                     command, your package manager, or a reinstall).",
                    binary.unwrap_or(&pkg),
                    path.display()
                ));
                None
            }
            // Not on PATH at all: this agent is npx-fetched, and the warm above
            // (or this one, when the CLI ships separately) is the whole install.
            None => {
                let tagged = format!("{pkg}@latest");
                warm_npx_package_tracked(&state.downloads, &tagged, &npx_row_label(&tagged)).await;
                None
            }
        };
        if let Some(Err(e)) = install {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "updated": false, "error": e.to_string() })),
            );
        }
    }

    let after = probe_installed().await;
    // Truthful verdict: when there is a probeable CLI, "updated" means the probed
    // version actually moved. With nothing on PATH the npx cache is the install and
    // warming always fetches `@latest`, so that path is genuinely up to date.
    let updated = match (&before, &after) {
        (Some(b), Some(a)) => b != a,
        _ => hint.is_none(),
    };
    (
        StatusCode::OK,
        Json(json!({
            "updated": updated,
            "installedVersion": after,
            "hint": hint,
        })),
    )
}

/// Optional query for `GET /api/agents/:id/capabilities` — when the composer has
/// picked a model that differs from the agent's bound slot, pass it here so the
/// GGUF probe targets the selection (Jan-style per-model capabilities).
#[derive(serde::Deserialize)]
pub(in crate::server) struct AgentCapabilitiesQuery {
    #[serde(default)]
    pub(in crate::server) model: Option<String>,
    /// The caller's ACP config-option picks, same shape and purpose as
    /// [`AcpConfigQuery::selections`].
    ///
    /// Load-bearing for the reasoning flag: `reasoning` is derived from whether
    /// the probe reported a thought-level option, and an agent whose reasoning
    /// option only exists for some models advertises none on its default one.
    /// Without the picks this endpoint would answer `reasoning: false` for a
    /// model that reasons — and the composer HIDES a reasoning option whenever
    /// this says false, so the two answers must be probed with the same
    /// selections or they contradict each other.
    #[serde(default)]
    pub(in crate::server) selections: Option<String>,
}

/// Resolve the model ref to probe for capability detection: an explicit query
/// override wins, then the agent's chat slot, then the node's active local model.
pub(in crate::server) async fn resolve_capability_model_ref(
    state: &ServerState,
    agent_id: &str,
    query_model: Option<String>,
) -> Option<String> {
    if let Some(m) = query_model.filter(|s| !s.trim().is_empty()) {
        return Some(m);
    }
    let bound = match state.agent_store.get(agent_id).await {
        Ok(Some(r)) => r.chat_model.and_then(|s| s.model_id).or(r.model),
        _ => None,
    };
    match bound {
        Some(m) => Some(m),
        None => state
            .preferences
            .get(crate::model_catalog::installed::ACTIVE_MODEL_PREF)
            .await
            .ok()
            .flatten()
            .and_then(|raw| {
                crate::model_catalog::installed::parse_active_pref(&raw).map(|a| a.r#ref)
            }),
    }
}

/// `GET /api/agents/:id/capabilities` — the agent's effective tool / reasoning /
/// vision capabilities, Jan-style.
///
/// Detection branches by plane: an ACP agent's reasoning support is read from its
/// `session/new` config options (tools always supported via the MCP bridge); a
/// local / openai-compat agent's flags are read from the bound model's GGUF chat
/// template ([`crate::model_catalog::capabilities`]). The auto-detected result is
/// the default; a persisted per-agent override (set via PUT) wins. The desktop
/// gates its composer and edit-page controls on the effective flags. Nothing is
/// hardcoded — detection is data-driven from the agent's own model/probe.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/capabilities",
    tag = "Agents",
    summary = "Resolve an agent's capabilities (tools / reasoning / vision)",
    params(("id" = String, Path), ("model" = Option<String>, Query, description = "Override the model ref to probe")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn agent_capabilities(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<AgentCapabilitiesQuery>,
) -> axum::response::Response {
    use crate::model_catalog::capabilities::{self as caps, CapabilityReport, DetectedCaps};

    let overrides = match run_after_agent_resource_permission(
        enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            &agent_id,
        ),
        async { caps::load_override(&agent_id) },
    )
    .await
    {
        Ok(overrides) => overrides,
        Err(response) => return response,
    };
    let acp_selections = parse_acp_selections(query.selections.as_deref());
    let model_ref = resolve_capability_model_ref(&state, &agent_id, query.model).await;
    let local_detected = model_ref.as_deref().and_then(caps::detect_local);

    // ACP plane: tools flow through the MCP bridge (always supported); reasoning
    // is whatever the agent advertises at session/new. Vision/diffusion come from
    // the bound local GGUF when one resolves (Ryu/Pi + Gemma, …).
    if let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        // Same selections the composer's `/acp-config` read used, so the
        // reasoning flag and the advertised options describe the SAME session.
        let (detected, source) = match crate::sidecar::adapters::acp::probe_acp_config_with(
            spawn_cmd,
            cwd,
            acp_selections,
        )
        .await
        {
            Ok(v) => {
                let acp = DetectedCaps {
                    tools: true,
                    reasoning: caps::acp_probe_reasoning(&v),
                    vision: false,
                    diffusion: false,
                };
                let merged = caps::merge_acp_with_local(acp, local_detected);
                let source = if local_detected.is_some() {
                    "acp_probe+gguf"
                } else {
                    "acp_probe"
                };
                (merged, source)
            }
            // Probe failed (agent binary missing, etc.) — assume a tool loop
            // is available so we don't hide controls on a transient error.
            Err(_) => {
                let fallback = DetectedCaps {
                    tools: true,
                    reasoning: false,
                    vision: false,
                    diffusion: false,
                };
                let merged = caps::merge_acp_with_local(fallback, local_detected);
                let source = if local_detected.is_some() {
                    "default+gguf"
                } else {
                    "default"
                };
                (merged, source)
            }
        };
        return Json(CapabilityReport::build(detected, overrides, source)).into_response();
    }

    // Local / openai-compat plane: read the bound model's GGUF chat template.
    let (detected, source) = match local_detected {
        Some(d) => (d, "gguf"),
        // No installed GGUF resolves (remote provider / non-GGUF / not
        // downloaded). Default to tool support (most remote providers do);
        // reasoning/vision unknown. The user can override on the edit page.
        None => (
            DetectedCaps {
                tools: true,
                reasoning: false,
                vision: false,
                diffusion: false,
            },
            "default",
        ),
    };
    Json(CapabilityReport::build(detected, overrides, source)).into_response()
}

/// Body for `PUT /api/agents/:id/capabilities` — a tri-state capability override.
/// Each field omitted or `null` means "auto-detect"; `true`/`false` forces the
/// flag. Mirrors Jan's per-model `_userConfiguredCapabilities`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct CapabilityOverridePatch {
    #[serde(default)]
    pub(in crate::server) tools: Option<bool>,
    #[serde(default)]
    pub(in crate::server) reasoning: Option<bool>,
    #[serde(default)]
    pub(in crate::server) vision: Option<bool>,
}

/// `PUT /api/agents/:id/capabilities` — persist the agent's capability overrides
/// and return the recomputed report.
#[utoipa::path(
    put,
    path = "/api/agents/{id}/capabilities",
    tag = "Agents",
    summary = "Persist an agent's capability overrides",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn set_agent_capabilities(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(patch): Json<CapabilityOverridePatch>,
) -> axum::response::Response {
    use crate::model_catalog::capabilities::CapabilityOverrides;

    let overrides = CapabilityOverrides {
        tools: patch.tools,
        reasoning: patch.reasoning,
        vision: patch.vision,
    };
    let save_result = match run_after_agent_resource_permission(
        enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT,
            &agent_id,
        ),
        async { crate::model_catalog::capabilities::save_override(&agent_id, &overrides) },
    )
    .await
    {
        Ok(save_result) => save_result,
        Err(response) => return response,
    };
    if let Err(e) = save_result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response();
    }
    // Re-resolve so the response reflects the new effective flags. No explicit
    // model override here: report the agent's own effective capabilities.
    agent_capabilities(
        State(state),
        axum::Extension(caller),
        Path(agent_id),
        axum::extract::Query(AgentCapabilitiesQuery {
            model: None,
            selections: None,
        }),
    )
    .await
}
