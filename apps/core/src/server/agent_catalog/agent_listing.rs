//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `list_agents` through `AgentCatalogQuery`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// List agents the user can actually pick: the flagship `ryu` plus any built-in
/// agents they have added via the catalog, unioned with custom agents persisted
/// in the SQLite store. Catalog-only built-ins (Claude Code, Codex, Gemini CLI,
/// Pi, OpenClaw, …) are hidden until added — browse + add them via
/// `GET /api/agents/catalog`. Built-in rows are represented by the richer
/// registry info, so we skip their DB rows.
#[utoipa::path(
    get,
    path = "/api/agents",
    tag = "Agents",
    summary = "List installed agents",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_agents(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.view".to_owned(),
        );
    }
    // Load the registry once per request so the default_agent_id is consistent
    // across both the ACP registry entries and the DB-backed custom records.
    // Config is authoritative for `enabled` (AC4 of U041 — not a DB column).
    let registry = crate::registry::ProviderRegistry::load();
    let default_agent_id = &registry.default_agent_id;

    // Which built-in agents are in the installed set. `ryu` is always present.
    let installed_set = state.agent_store.installed_ids().await.unwrap_or_default();

    let mut agents: Vec<_> = state
        .agents
        .list_infos_with_default(default_agent_id)
        .into_iter()
        .filter(|a| {
            (a.id == "ryu" || installed_set.contains(&a.id))
                && crate::fleet::is_agent_available(&a.id)
        })
        .collect();

    match state.agent_store.list().await {
        Ok(records) => {
            for record in records {
                if !crate::fleet::is_agent_available(&record.id) {
                    continue;
                }
                // Surface the persona's custom avatar (a data URL) on the summary
                // so the chat picker / transcript can render it without a second
                // fetch of the full record. `avatar_glyph` carries non-image
                // sources as well.
                let avatar_url = record.persona.as_ref().and_then(|p| p.avatar_url.clone());
                let avatar_glyph = persona_avatar_glyph(record.persona.as_ref());
                let title = (!record.title.trim().is_empty()).then_some(record.title.clone());
                // Built-in agents are sourced from the in-code registry above (which
                // has no persona data), so their DB row is otherwise skipped. But a
                // user can still set a custom avatar on a built-in (e.g. Claude Code),
                // and it's persisted on that row — merge it onto the registry entry so
                // the sidebar/chat render the custom image instead of the engine logo.
                if record.built_in {
                    if let Some(existing) = agents.iter_mut().find(|a| a.id == record.id) {
                        existing.name =
                            builtin_agent_display_name(&existing.name, &record.name).to_owned();
                        existing.lifecycle_status =
                            Some(record.lifecycle_status.as_str().to_owned());
                        existing.safety_profile = Some(record.safety_profile.as_str().to_owned());
                    }
                    if let Some(url) = avatar_url {
                        if let Some(existing) = agents.iter_mut().find(|a| a.id == record.id) {
                            existing.avatar_url = Some(url);
                        }
                    }
                    if let Some(glyph) = avatar_glyph {
                        if let Some(existing) = agents.iter_mut().find(|a| a.id == record.id) {
                            existing.avatar_glyph = Some(glyph);
                        }
                    }
                    if let Some(title) = title {
                        if let Some(existing) = agents.iter_mut().find(|a| a.id == record.id) {
                            existing.title = Some(title);
                        }
                    }
                    continue;
                }
                let locked_flag = record.locked.then_some(true);
                let enabled = (record.id == *default_agent_id).then_some(true);
                agents.push(crate::sidecar::adapters::AgentInfo {
                    id: record.id,
                    name: record.name,
                    title,
                    description: record.description,
                    install_hint: None,
                    installed: None,
                    model: record.model,
                    system_prompt: record.system_prompt,
                    created_at: record.created_at,
                    engine: None,
                    transport: None,
                    recommended: None,
                    version: Some(record.version),
                    latest_version: None,
                    version_status: None,
                    locked: locked_flag,
                    enabled,
                    // Custom agents from the DB don't carry bypass metadata — they
                    // go through the normal OpenAI-compat path.
                    gateway_bypass: None,
                    avatar_url,
                    avatar_glyph,
                    lifecycle_status: Some(record.lifecycle_status.as_str().to_owned()),
                    safety_profile: Some(record.safety_profile.as_str().to_owned()),
                });
            }
        }
        Err(e) => tracing::error!("list_agents: failed to read agent store: {e:#}"),
    }

    // The broad `agent.view` gate above admits the collection. Each row still
    // has its own resource ACL, so a member-specific/team/org deny cannot leak
    // an agent name through the picker or make the hidden agent selectable.
    let mut visible_agents = Vec::with_capacity(agents.len());
    for agent in agents {
        if enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            &agent.id,
        )
        .await
        .is_ok()
        {
            visible_agents.push(agent);
        }
    }

    Json(json!({ "agents": visible_agents })).into_response()
}

pub(in crate::server) fn builtin_agent_display_name<'a>(
    registry_name: &'a str,
    saved_name: &'a str,
) -> &'a str {
    let saved_name = saved_name.trim();
    if saved_name.is_empty() {
        registry_name
    } else {
        saved_name
    }
}

/// The full installable agent catalog: every built-in registry agent, with two
/// independent flags so the onboarding/store UI can both *detect* what the user
/// already has and show what they have *added*:
///   - `detected`: the agent's CLI binary is on PATH (`null` for agents with no
///     detectable binary — managed sidecars like OpenClaw, and `ryu` itself).
///   - `added`: the agent is in the installed set (shows in the picker). `ryu`
///     is always `true`.
/// Query for `GET /api/agents/catalog`.
#[derive(serde::Deserialize, utoipa::IntoParams)]
pub(in crate::server) struct AgentCatalogQuery {
    /// Include the installed/latest version columns. Defaults to `true`.
    ///
    /// Those columns are the ONLY expensive part of this handler: filling them
    /// runs an npm-registry lookup per agent plus a `--version` subprocess per
    /// installed one, which is why the full catalog takes ~30s on a warm cache
    /// and is bounded only by the client's timeout. Detection (`detected`) and
    /// membership (`added`) are local filesystem reads and cost nothing.
    ///
    /// A caller that only needs "what does this machine have" — onboarding's
    /// agent step, which was silently skipping itself whenever the versioned
    /// call timed out — passes `?versions=0` and gets the same rows in
    /// milliseconds, with the version fields null. The Store, which exists to
    /// show update state, keeps the default.
    ///
    /// Typed as a string and parsed leniently on purpose: a strict `bool` field
    /// rejects `?versions=0` with a 400 for the WHOLE catalog, so the most
    /// natural spelling of the flag would break the endpoint outright rather
    /// than being understood. Anything unrecognised falls back to the default.
    pub(in crate::server) versions: Option<String>,
}

impl AgentCatalogQuery {
    /// Whether to fill the version columns. `0`/`false`/`no`/`off` opt out; every
    /// other value (including an absent param) keeps the versioned default.
    pub(in crate::server) fn with_versions(&self) -> bool {
        !matches!(
            self.versions.as_deref().map(str::trim),
            Some("0" | "false" | "no" | "off")
        )
    }
}
