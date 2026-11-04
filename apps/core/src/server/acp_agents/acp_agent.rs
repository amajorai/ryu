//! ACP agent config, accounts, sessions, updates and capability overrides: `AcpConfigQuery` through `AcpAuthRequest`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Query for the ACP-config probe: the caller's current config-option picks.
#[derive(Default, serde::Deserialize)]
pub(in crate::server) struct AcpConfigQuery {
    /// A JSON object of `{ configOptionId: valueId }` the probe should apply to
    /// its throwaway session before reading what the agent advertises.
    ///
    /// One opaque parameter rather than "every query key is a selection": config
    /// option ids and values are agent-defined strings, so a scheme that reads
    /// stray query params as selections would turn any future unrelated param
    /// (a cache-buster, a trace id) into a bogus write to the agent.
    pub(in crate::server) selections: Option<String>,
    /// `true` returns every model the agent advertises, ignoring the agent's
    /// saved allowlist and defaults. The launch-settings editor needs the full
    /// list so a model it excluded can be re-enabled.
    #[serde(default, rename = "allModels")]
    pub(in crate::server) all_models: bool,
}

/// Parse an `AcpConfigQuery::selections` blob. Unparseable ⇒ no selections, which
/// degrades to the plain `session/new` answer rather than failing the request.
pub(in crate::server) fn parse_acp_selections(
    raw: Option<&str>,
) -> crate::sidecar::adapters::acp::SessionSelections {
    raw.and_then(|s| serde_json::from_str::<std::collections::BTreeMap<String, String>>(s).ok())
        .unwrap_or_default()
}

/// Require a caller's permission on the exact agent named by an agent-management
/// route. The broad `AgentsRead`/`AgentsManage` route policy only admits the
/// request to Core; this resource gate is the authority that applies the agent's
/// ACL before Core resolves or spawns its ACP runtime.
pub(crate) async fn enforce_agent_resource_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
    agent_id: &str,
) -> Result<(), axum::response::Response> {
    enforce_permission_on(state, caller, permission, crate::acl::KIND_AGENT, agent_id)
        .await
        .map_err(|status| json_error(status, format!("insufficient permissions: {permission}")))
}

/// Run an ACP operation only after its exact-agent ACL check succeeds.
/// This narrow generic seam also lets tests prove a denied check skips an
/// injected side effect without constructing the full Core server state.
pub(in crate::server) async fn run_after_agent_resource_permission<T>(
    permission: impl std::future::Future<Output = Result<(), axum::response::Response>>,
    operation: impl std::future::Future<Output = T>,
) -> Result<T, axum::response::Response> {
    permission.await?;
    Ok(operation.await)
}

pub(in crate::server) async fn resolve_acp_spawn_cmd_authorized(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
    agent_id: &str,
) -> Result<Option<String>, axum::response::Response> {
    run_after_agent_resource_permission(
        enforce_agent_resource_permission(state, caller, permission, agent_id),
        async {
            crate::sidecar::adapters::resolve_acp_spawn_cmd(
                agent_id,
                &state.agents,
                &state.agent_store,
            )
            .await
        },
    )
    .await
}

/// `GET /api/agents/:id/acp-config` — the agent's advertised ACP session config.
///
/// Opens a throwaway ACP session (no prompt) and returns `{ modes, models,
/// configOptions }` exactly as the agent reports them at `session/new` (each
/// `null` when unsupported). This is the data the desktop's per-agent permission
/// mode / reasoning effort / model pickers are built from — fully agent-driven,
/// nothing hardcoded. Non-ACP agents return all-null. Cached per spawn command.
///
/// `?selections={"model":"…"}` applies those picks to the probe session first, so
/// the answer includes options the agent only offers for that selection (an
/// agent's option set can depend on its model — see `probe_acp_config_with`).
#[utoipa::path(
    get,
    path = "/api/agents/{id}/acp-config",
    tag = "Agents",
    summary = "Get an agent's ACP configuration",
    params(("id" = String, Path), ("selections" = Option<String>, Query)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_config(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<AcpConfigQuery>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        // An ACP agent whose saved launch settings cannot be applied resolves to
        // no route. Report it so the settings panel stays reachable to fix them.
        if crate::sidecar::adapters::resolve_acp_agent_settings(
            &agent_id,
            &state.agents,
            &state.agent_store,
        )
        .await
        .is_some()
        {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "error": "this agent's launch settings could not be applied: paths must be absolute, and a custom Codex command must be a codex-acp executable",
                })),
            )
                .into_response();
        }
        // Not an ACP agent → no session/new advertisement to read.
        return Json(serde_json::json!({
            "modes": null,
            "models": null,
            "configOptions": null,
        }))
        .into_response();
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let selections = parse_acp_selections(query.selections.as_deref());
    let settings = if query.all_models {
        None
    } else {
        crate::sidecar::adapters::resolve_acp_agent_settings(
            &agent_id,
            &state.agents,
            &state.agent_store,
        )
        .await
    };
    match crate::sidecar::adapters::acp::probe_acp_config_with(spawn_cmd, cwd, selections).await {
        Ok(mut v) => {
            // The per-agent model allowlist narrows what the composer offers,
            // and saved defaults become the advertised current values so an
            // untouched composer picker starts from them.
            if let Some(settings) = settings.as_ref() {
                crate::acp_agent_settings::filter_models(&mut v, &settings.allowed_models);
                crate::acp_agent_settings::project_defaults(&mut v, settings);
            }
            Json(v).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Serializes `acp-agent-settings` read-merge-write cycles so two saves for
/// different agents cannot drop each other's entry.
pub(in crate::server) static ACP_AGENT_SETTINGS_WRITE: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

/// The settings editor's view of one agent: the effective settings and which
/// key they come from (the agent itself, or an engine / registry entry it
/// inherits from), plus which agent-specific knobs apply. Support is classified
/// from the agent's default launcher, so it is available even when the agent
/// fails to start and does not move when a custom command is set.
pub(in crate::server) async fn acp_agent_settings_view(
    state: &ServerState,
    agent_id: &str,
) -> Option<serde_json::Value> {
    let kind = crate::sidecar::adapters::resolve_acp_agent_kind(
        agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await?;
    let effective = crate::sidecar::adapters::resolve_acp_agent_settings_with_source(
        agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await;
    let (source, settings) = match effective {
        Some((source, settings)) => (Some(source), settings),
        None => (None, crate::acp_agent_settings::AcpAgentSettings::default()),
    };
    Some(json!({
        "agentId": agent_id,
        "settings": settings,
        "inheritedFrom": source.filter(|source| source != agent_id),
        "support": crate::acp_agent_settings::supported_knobs(kind),
    }))
}

pub(in crate::server) fn not_an_acp_agent(agent_id: &str) -> axum::response::Response {
    json_error(
        StatusCode::NOT_FOUND,
        format!("`{agent_id}` is not an external ACP agent, so it has no launch settings"),
    )
}

/// `GET /api/agents/:id/acp-settings` — the agent's effective ACP launch and
/// session settings. Requires `agent.edit`: the environment map can hold
/// credentials, and the values become the agent's launch command.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/acp-settings",
    tag = "Agents",
    summary = "Get an agent's ACP launch settings",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value),
        (status = 404, description = "Not an external ACP agent", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn get_acp_agent_settings(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        return response;
    }
    match acp_agent_settings_view(&state, &agent_id).await {
        Some(view) => Json(view).into_response(),
        None => not_an_acp_agent(&agent_id),
    }
}

/// `PUT /api/agents/:id/acp-settings` — replace this agent's own ACP launch and
/// session settings (an empty object clears them). Requires `agent.edit`,
/// validates the target is an external ACP agent and that the settings apply to
/// its launcher, then updates only this agent's entry atomically.
#[utoipa::path(
    put,
    path = "/api/agents/{id}/acp-settings",
    tag = "Agents",
    summary = "Set an agent's ACP launch settings",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Settings cannot be applied to this agent", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value),
        (status = 404, description = "Not an external ACP agent", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn put_acp_agent_settings(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(settings): Json<crate::acp_agent_settings::AcpAgentSettings>,
) -> axum::response::Response {
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        return response;
    }
    let Some(kind) = crate::sidecar::adapters::resolve_acp_agent_kind(
        &agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return not_an_acp_agent(&agent_id);
    };
    let settings = settings.normalized();
    if let Err(error) = crate::acp_agent_settings::launch_overrides(&settings, kind) {
        return json_error(StatusCode::BAD_REQUEST, error.to_string());
    }
    let _write = ACP_AGENT_SETTINGS_WRITE.lock().await;
    let key = crate::acp_agent_settings::ACP_AGENT_SETTINGS_PREF_KEY;
    let stored = match state.preferences.get(key).await {
        Ok(stored) => stored,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let next = match crate::acp_agent_settings::merge_entry(stored.as_deref(), &agent_id, &settings)
    {
        Ok(next) => next,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if let Err(error) = state.preferences.set(key, &next).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    // The next spawn and turn of the changed agent read the new map. The spawn
    // declaration changes with it, so pooled sessions and probe caches key off
    // it naturally.
    crate::acp_agent_settings::set_from_json(&next);
    match acp_agent_settings_view(&state, &agent_id).await {
        Some(view) => Json(view).into_response(),
        None => not_an_acp_agent(&agent_id),
    }
}

/// Body for `POST /api/agents/:id/authenticate`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct AcpAuthRequest {
    /// One of the `authMethods[].id` values from the agent's `acp-config`.
    pub(in crate::server) method_id: String,
    /// Optional subscription provider this login is meant to connect
    /// ("openai-codex" / "claude-pro-max" / "github-copilot"). When present the
    /// route VERIFIES the outcome against Pi's stored credentials instead of
    /// trusting the RPC result — see [`acp_authenticate`].
    #[serde(default)]
    pub(in crate::server) provider_id: Option<String>,
}
