//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `activate_plugin` through `refresh_kept_app_agents`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Run every activation side effect for one freshly-enabled plugin, returning the
/// per-Runnable outcomes.
///
/// The single definition of "what enabling a plugin *does*" beyond flipping its
/// bit. `enable_app_handler` runs it once per plugin in the resolved enable order
/// (a target and any auto-enabled dependencies), so a dependency activates
/// exactly as it would have if the user had enabled it by hand.
pub(in crate::server) async fn activate_plugin(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    record: &crate::plugins::PluginRecord,
) -> (Vec<serde_json::Value>, PolicyApplyOutcome) {
    let activation = state.plugin_runtime.begin_activation(&manifest.id).await;
    let runtime_binding = crate::plugins::runtime::RuntimeGenerationBinding::new(
        state.plugin_runtime.clone(),
        activation.generation().clone(),
    );
    // The lifecycle bit can change while the Gateway validation response is in
    // flight. Do not publish a stale activation after a concurrent disable.
    let still_enabled = state
        .app_store
        .get(&manifest.id)
        .await
        .ok()
        .flatten()
        .is_some_and(|current| current.enabled);
    if !still_enabled {
        tracing::debug!(
            plugin = %manifest.id,
            generation = activation.generation().number(),
            "plugin activation became stale before registration"
        );
        return (Vec::new(), PolicyApplyOutcome::default());
    }

    // Build and run the RunnableRegistry to activate the manifest's Runnables.
    // Handlers capture cloned subsystem handles; the registry is built per-call
    // so ServerState stays Clone (no non-Clone field added).
    //
    // Use `register_active` against the live fired-event snapshot (#443): an
    // eager plugin (empty `activation_events`, the common case) activates
    // immediately on enable exactly as before, but a plugin gated on a not-yet
    // fired event (e.g. `onCommand:x`) is correctly held back until that event
    // lands via `fire_activation_event`. This keeps the enable path and the
    // event-driven path on one activation contract.
    let fired = crate::runnable::fired_activation_events();
    let runnable_results = build_runnable_registry(state).register_active(manifest, &fired);

    // Apply async runtime side effects the sync handlers can't (gateway I/O).
    // Dispatches per Policy runnable: headroom compression / firewall / routing /
    // sandbox — turning each ON for this enable. The returned outcome tells the
    // handler whether a gateway policy actually reconfigured the running gateway.
    let policy_outcome = apply_policy(state, manifest, true).await;

    // Provision the plugin's declared external runtime (#449), if any. Gated on
    // tier + Gateway-approved grant (Core-tier auto-allowed; Community needs the
    // approved `runtime:external` grant), best-effort + spawned so a slow asset
    // fetch / pip install never blocks the enable response. The TTS sidecar
    // precedent (a Python venv) is the shape.
    //
    // Every host-access lane below (external runtime, native sidecars, declared
    // MCP servers) is skipped when the plugin is locally revoked or the node
    // requires trust for host access and nothing vouches for this plugin. Checked
    // here as well as in the enable handler so auto-enabled dependencies obey it.
    let host_refusal = plugin_host_access_refusal(state, manifest).await;
    if let Some(refusal) = &host_refusal {
        tracing::warn!(
            plugin = %manifest.id,
            "activate_plugin: host-access lanes not started: {refusal}"
        );
    } else {
        provision_external_runtime(manifest, &record.approved_grants, state.downloads.clone());

        // Register + start the plugin's declared managed sidecars (the app ⇄ sidecar
        // bridge, M3): each rides the SidecarManager lifecycle (health monitor +
        // resource sampler + `/api/sidecar/status`) like a built-in. Gated on tier +
        // approved `sidecar:process` grant; spawned + best-effort so a slow binary
        // download never blocks the enable response.
        apply_sidecars(
            state,
            manifest,
            &record.approved_grants,
            true,
            Some(runtime_binding.clone()),
        )
        .await;
    }

    // ONE plugin model: enabling a synth MCP-server record flips the mcp.json
    // `enabled` flag that actually gates spawn + tool listing, so the record's
    // enabled bit drives the running server instead of being a no-op. Best-effort
    // + a no-op for every non-MCP-server manifest.
    sync_mcp_entry_for_record(state, manifest, McpEntryMutation::SetEnabled(true)).await;

    // Register the plugin's declared `mcp_servers` into the MCP registry (the
    // manifest-owned successor to Core's hardcoded built-in servers). Idempotent +
    // a no-op for every manifest with no `mcp_servers`.
    //
    // Gated on tier + the approved `mcp:server` grant, exactly like the two sibling
    // process-spawning seams above: an `mcp_servers` entry is a verbatim
    // command+args the next tool listing hands to `Command::new`, so a manifest
    // dropped into the user-writable `~/.ryu/plugins` must not be able to run code
    // just by being enabled. `approved_grants` is read from the RECORD, never the
    // manifest's unvalidated declarations.
    let registered = if host_refusal.is_some() {
        Vec::new()
    } else {
        crate::sidecar::mcp::register_manifest_mcp_servers(
            &state.mcp,
            manifest,
            crate::plugins::builtins::tier_for_manifest(manifest),
            &record.approved_grants,
        )
    };
    if !registered.is_empty() {
        tracing::info!(
            plugin = %manifest.id,
            servers = ?registered,
            "activate_plugin: registered plugin-declared MCP server(s)"
        );
    }

    // Materialize + activate the plugin's bundled Agent Skills (folder convention:
    // `<plugin_dir>/skills/<slug>/SKILL.md`). Spawned + best-effort so a copy never
    // blocks the enable response; a no-op for a plugin with no on-disk `skills/`
    // (including every built-in — those need the compile-time embed follow-up).
    {
        let plugin_id = manifest.id.clone();
        tokio::task::spawn_blocking(move || {
            crate::skills_catalog::plugin_skills::install_plugin_skills(&plugin_id);
        });
    }

    // Register the plugin's contributed output styles into the style registry so
    // they appear in the picker and can be selected. Synchronous + in-line (not
    // spawned like the bundled-skills copy above): this is an in-memory parse of
    // text the manifest already carries, with no I/O to keep off the response, and
    // the enable response must not race the very list the caller reloads next. A
    // no-op for every manifest with no `output_styles`.
    sync_plugin_output_styles(manifest, true);

    // Publish only after every registration is complete. Detached sidecar starts
    // wait for this lease; disable cannot remove entries and then lose to stale
    // MCP registration from this activation.
    activation.commit();

    // Collect per-Runnable outcomes for the response (success + failures both
    // surfaced so the caller can observe partial failures without silent drops).
    let statuses = runnable_results
        .into_iter()
        .map(|(rid, res)| match res {
            Ok(()) => json!({ "id": rid, "ok": true }),
            Err(e) => json!({ "id": rid, "ok": false, "error": e }),
        })
        .collect();
    (statuses, policy_outcome)
}

/// Build a [`crate::runnable::RunnableRegistry`] with default Core handlers
/// wired to the live subsystem handles in `state`.
///
/// Every Core-owned kind receives a built-in handler:
/// - **Agent** - upserts into [`AgentStore`] using the app-namespaced id.
/// - **Workflow** - persists a skeleton workflow via the file-backed store.
/// - **Tool** - registers an in-memory tool in [`McpRegistry`].
/// - **Skill** - registers an in-memory skill in the [`SkillRegistry`]'s
///   `app_skills` bag so it is listable + injectable like a first-party skill.
/// - **Engine** - registers an engine binding in the [`app_contrib`] registry so
///   it becomes selectable via `GET /api/engines`.
/// - **Channel** - registers a channel adapter in the [`app_contrib`] registry so
///   an enabled plugin's channel becomes a usable adapter.
/// - **Companion** - registers the companion surface descriptor in the
///   [`app_contrib`] registry so the desktop can render it (also already visible
///   in the full manifest served by `GET /api/apps`).
///
/// Each handler is idempotent (re-enable is a no-op) and returns `Err(String)`
/// (never panics) so one failing entry never aborts the rest.
///
/// Only **Policy** has a validate-only handler: policy *enforcement* is a Gateway
/// concern (the Core-vs-Gateway rule), so Core validates the declared policy but
/// does no inline enforcement — the actual activation is done by the async
/// [`apply_policy`] pass. Every kind now has a handler, so a plugin declaring any
/// Runnable kind is no longer inert.
///
/// [`app_contrib`]: crate::plugins::app_contrib
pub(in crate::server) fn build_runnable_registry(
    state: &ServerState,
) -> crate::runnable::RunnableRegistry {
    build_runnable_registry_from_parts(
        &state.agent_store,
        &state.mcp,
        &state.skills,
        &state.app_contrib,
    )
}

/// The agent record Core creates for an app's `kind: "agent"` Runnable.
///
/// The manifest may set the identity mode; an absent one keeps Core's default
/// (`managed`). Account access is never read from a manifest: the agent starts
/// with no allowlist, and the user narrows it on their own node. A config that
/// does not parse is refused rather than replaced by defaults, so a malformed
/// `identity_mode` can never land the agent on a wider mode.
pub(in crate::server) fn manifest_agent_create(
    entry: &crate::plugin_manifest::schema::RunnableEntry,
) -> Result<crate::agents::CreateAgent, String> {
    crate::plugin_manifest::schema::validate_runnable(entry)?;
    let cfg: crate::plugin_manifest::schema::AgentConfig = match entry.config.as_ref() {
        Some(raw) => serde_json::from_value(raw.clone())
            .map_err(|e| format!("agent '{}': invalid config: {e}", entry.id))?,
        None => crate::plugin_manifest::schema::AgentConfig::default(),
    };
    Ok(crate::agents::CreateAgent {
        name: entry.name.clone(),
        system_prompt: cfg.system_prompt,
        tools: cfg.tools,
        model: cfg.model,
        identity_mode: cfg.identity_mode.map(Into::into).unwrap_or_default(),
        account_access: None,
        ..Default::default()
    })
}

pub(in crate::server) fn log_app_identity_outcome(
    agent_id: &str,
    outcome: crate::agents::AppIdentityOutcome,
) {
    use crate::agents::AppIdentityOutcome;
    match outcome {
        AppIdentityOutcome::Created | AppIdentityOutcome::Unchanged => {}
        AppIdentityOutcome::Narrowed { from, to } => tracing::info!(
            agent_id,
            from = from.as_str(),
            to = to.as_str(),
            "app update narrowed the agent's identity mode"
        ),
        AppIdentityOutcome::Pending { current, requested } => tracing::info!(
            agent_id,
            current = current.as_str(),
            requested = requested.as_str(),
            "app update asks for another identity mode; left for the user to accept"
        ),
    }
}

/// What an app update did to one of its agents' identity mode, as reported in
/// the update response. Only a change or a request is reported.
pub(in crate::server) fn app_identity_outcome_json(
    agent_id: &str,
    outcome: crate::agents::AppIdentityOutcome,
) -> Option<serde_json::Value> {
    use crate::agents::AppIdentityOutcome;
    match outcome {
        AppIdentityOutcome::Created | AppIdentityOutcome::Unchanged => None,
        AppIdentityOutcome::Narrowed { from, to } => Some(json!({
            "agent_id": agent_id,
            "status": "narrowed",
            "from": from.as_str(),
            "identity_mode": to.as_str(),
        })),
        AppIdentityOutcome::Pending { current, requested } => Some(json!({
            "agent_id": agent_id,
            "status": "pending",
            "identity_mode": current.as_str(),
            "pending_identity_mode": requested.as_str(),
        })),
    }
}

/// Bring the identity modes of an app's existing agents in line with the modes
/// its (new) manifest declares; see [`crate::agents::AgentStore::reconcile_app_identity`].
/// Agents that do not exist (a disabled app's) are skipped, and so is an entry
/// whose config does not parse, which changes nothing. Returns the reportable
/// outcomes for the update response.
pub(in crate::server) async fn reconcile_app_agent_identities(
    agent_store: &AgentStore,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Vec<serde_json::Value> {
    let mut changes = Vec::new();
    for entry in manifest
        .runnables
        .iter()
        .filter(|entry| entry.kind == crate::runnable::RunnableKind::Agent)
    {
        let declared = match manifest_agent_create(entry) {
            Ok(create) => create.identity_mode,
            Err(error) => {
                tracing::warn!(plugin = %manifest.id, runnable = %entry.id, %error, "app agent identity not reconciled");
                continue;
            }
        };
        let agent_id = format!("{}{}", crate::agents::APP_AGENT_ID_PREFIX, entry.id);
        match agent_store
            .reconcile_app_identity(&agent_id, declared)
            .await
        {
            Ok(Some(outcome)) => {
                log_app_identity_outcome(&agent_id, outcome);
                changes.extend(app_identity_outcome_json(&agent_id, outcome));
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(agent_id, %error, "app agent identity not reconciled");
            }
        }
    }
    changes
}

/// The app agents an update keeps: every agent Runnable the old manifest
/// declared that the new one still declares. Deactivating the old version for
/// an update leaves these in place, so the user's settings on them (identity
/// mode, account access, everything else) survive and the new version's
/// activation reconciles them instead of recreating them.
pub(in crate::server) fn app_agents_kept_by_update(
    old_manifest: &crate::plugin_manifest::PluginManifest,
    new_manifest: &crate::plugin_manifest::PluginManifest,
) -> std::collections::HashSet<String> {
    let declared = |manifest: &crate::plugin_manifest::PluginManifest| {
        manifest
            .runnables
            .iter()
            .filter(|entry| entry.kind == crate::runnable::RunnableKind::Agent)
            .map(|entry| entry.id.clone())
            .collect::<std::collections::HashSet<_>>()
    };
    declared(old_manifest)
        .intersection(&declared(new_manifest))
        .cloned()
        .collect()
}

/// Refresh the parts of a kept app agent its manifest owns (name, prompt,
/// tools, model) from the new version, as recreating it used to, so a prompt
/// or model the new version drops is cleared
/// ([`crate::agents::AgentStore::refresh_app_agent`]). A locked agent is left
/// as it is, and nothing the user set elsewhere is touched.
pub(in crate::server) async fn refresh_kept_app_agents(
    agent_store: &AgentStore,
    manifest: &crate::plugin_manifest::PluginManifest,
    kept: &std::collections::HashSet<String>,
) {
    for entry in manifest.runnables.iter().filter(|entry| {
        entry.kind == crate::runnable::RunnableKind::Agent && kept.contains(&entry.id)
    }) {
        let Ok(create) = manifest_agent_create(entry) else {
            continue;
        };
        let agent_id = format!("{}{}", crate::agents::APP_AGENT_ID_PREFIX, entry.id);
        if let Err(error) = agent_store.refresh_app_agent(&agent_id, &create).await {
            tracing::info!(agent_id, %error, "kept app agent not refreshed from the update");
        }
    }
}
