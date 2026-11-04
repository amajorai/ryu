//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs: `deactivate_plugin` through `UpdateAppBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Tear down every runtime contribution of one plugin — the symmetric
/// counterpart of [`activate_plugin`] (#444).
///
/// The single definition of "what disabling a plugin *does*" beyond flipping its
/// bit. `disable_app_handler` runs it once per plugin in the resolved disable
/// order (the target plus, under `?cascade=true`, its dependents), so a cascaded
/// dependent is torn down exactly as if the user had disabled it by hand.
///
/// Each kind enable registers is torn down here, so a disabled plugin's Runnables
/// stop being listable/callable instead of lingering:
///   - Tool     → unregister the canonical `<server>.<tool>` MCP tool id.
///   - Agent    → delete the `app__<id>` agent record.
///   - Workflow → delete the `app__<id>` workflow.
///   - Policy   → flip the gateway/sandbox policy flag OFF (`apply_policy`).
///
/// Tool teardown uses the same canonical-id helper as enable; the other
/// contribution kinds retain their separate `app__` ownership namespace so a
/// user agent/workflow can never be removed.
pub(in crate::server) async fn deactivate_plugin(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> PolicyApplyOutcome {
    deactivate_plugin_keeping_agents(state, manifest, &std::collections::HashSet::new()).await
}

/// [`deactivate_plugin`] for an update: the app agents named in `kept_agents`
/// (Runnable ids the new version still declares, see
/// [`app_agents_kept_by_update`]) stay, so the user's settings on them survive
/// the update.
pub(in crate::server) async fn deactivate_plugin_keeping_agents(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    kept_agents: &std::collections::HashSet<String>,
) -> PolicyApplyOutcome {
    let deactivation = state.plugin_runtime.begin_deactivation(&manifest.id).await;
    tracing::debug!(
        plugin = %manifest.id,
        generation = deactivation.generation().number(),
        "deactivating plugin runtime generation"
    );

    // Derived ext-API tools, dropped OUTSIDE the per-kind loop below because that loop
    // iterates `manifest.runnables` and a derived tool has no runnable entry — it was
    // lowered from the sidecar's OpenAPI document, not declared. Without this line a
    // disabled app's tools stay searchable and callable; the ext-proxy would refuse
    // them at the hop (the enabled-gate), but the model would keep being offered tools
    // that can only fail. Clearing also re-arms `has_ext_api_routes`, so a re-enable
    // lowers the app's *current* spec instead of serving the one from last boot.
    state.mcp.clear_ext_api_routes(&manifest.id);
    for entry in &manifest.runnables {
        match entry.kind {
            crate::runnable::RunnableKind::Tool => {
                if let Some(cfg) = entry.config.as_ref().and_then(|v| {
                    serde_json::from_value::<crate::plugin_manifest::schema::ToolConfig>(v.clone())
                        .ok()
                }) {
                    state
                        .mcp
                        .unregister_app_tool(&crate::sidecar::mcp::app_tool_registered_id(&cfg));
                }
            }
            crate::runnable::RunnableKind::Agent => {
                if kept_agents.contains(&entry.id) {
                    continue;
                }
                let agent_id = format!("app__{}", entry.id);
                if let Err(e) = state.agent_store.delete(&agent_id).await {
                    tracing::warn!("plugin disable: removing agent '{agent_id}' failed: {e}");
                }
            }
            crate::runnable::RunnableKind::Workflow => {
                let wf_id = format!("app__{}", entry.id);
                if let Err(e) = crate::workflow::store::delete_workflow(&wf_id) {
                    tracing::warn!("plugin disable: removing workflow '{wf_id}' failed: {e}");
                }
            }
            crate::runnable::RunnableKind::Skill => {
                // Skill ids use `app__<skill_id>` (from SkillConfig), not
                // `app__<entry.id>`, so resolve the skill_id.
                if let Some(cfg) = entry.config.as_ref().and_then(|v| {
                    serde_json::from_value::<crate::plugin_manifest::schema::SkillConfig>(v.clone())
                        .ok()
                }) {
                    state
                        .skills
                        .unregister_app_skill(&format!("app__{}", cfg.skill_id));
                }
            }
            crate::runnable::RunnableKind::Engine => {
                state
                    .app_contrib
                    .unregister_engine(&format!("app__{}", entry.id));
            }
            crate::runnable::RunnableKind::Channel => {
                state
                    .app_contrib
                    .unregister_channel(&format!("app__{}", entry.id));
            }
            crate::runnable::RunnableKind::Companion => {
                state
                    .app_contrib
                    .unregister_companion(&format!("app__{}", entry.id));
            }
            // Policy is handled by apply_policy below (one batched pass).
            crate::runnable::RunnableKind::Policy => {}
        }
    }
    // Symmetric to enable: each Policy runnable (compression / firewall / routing
    // / sandbox) is turned back OFF. The outcome reports whether the gateway was
    // actually reconfigured (vs externally managed) so the disable/uninstall
    // response can tell the truth about a security control that flipped off.
    let policy_outcome = apply_policy(state, manifest, false).await;
    // Symmetric to enable: stop + deregister the plugin's managed sidecars so a
    // disabled plugin's process stops instead of lingering (the app ⇄ sidecar
    // bridge teardown). Stop is ungated.
    apply_sidecars(state, manifest, &[], false, None).await;
    // Symmetric to enable: disabling a synth MCP-server record clears the mcp.json
    // `enabled` flag so the server stops being spawned/listed — the toggle is no
    // longer a no-op against the running server. Best-effort + a no-op for every
    // non-MCP-server manifest.
    sync_mcp_entry_for_record(state, manifest, McpEntryMutation::SetEnabled(false)).await;
    if let Err(error) = crate::sidecar::plugin_credentials::revoke(&manifest.id) {
        tracing::warn!(
            plugin_id = %manifest.id,
            %error,
            "plugin disable: credential revocation failed"
        );
    }
    // Symmetric to enable: deregister the plugin's declared `mcp_servers` from the
    // MCP registry so a disabled/uninstalled plugin's server stops being
    // spawned/listed. A no-op for every manifest with no `mcp_servers`.
    crate::sidecar::mcp::deregister_manifest_mcp_servers(&state.mcp, manifest);
    // Symmetric to enable, but files-preserving: deactivate the plugin's bundled
    // skills (flip each owned slug inactive) while LEAVING them on disk, mirroring
    // how a disabled plugin's record persists. The uninstall path deletes the files
    // separately (`remove_plugin_skills`). A no-op for a plugin with no bundled
    // skills. Spawned + best-effort.
    {
        let plugin_id = manifest.id.clone();
        tokio::task::spawn_blocking(move || {
            crate::skills_catalog::plugin_skills::deactivate_plugin_skills(&plugin_id);
        });
    }
    // Symmetric to enable, and unlike the skills above NOT files-preserving —
    // there are no files. The contributed styles leave the registry outright, which
    // is the whole enforcement mechanism behind serving `/api/output-styles`
    // ungated: a disabled plugin cannot style a turn because its styles are gone,
    // not because a route refused the caller. A user who forked one into their own
    // root still has their copy — that fork is a disk style and was never in this
    // bag.
    sync_plugin_output_styles(manifest, false);
    policy_outcome
}

/// Request body for `POST /api/apps/:id/update`.
#[derive(serde::Deserialize, Default, utoipa::ToSchema)]
pub(in crate::server) struct UpdateAppBody {
    /// When `true`, allow downgrading to an older version.
    #[serde(default)]
    pub(in crate::server) force: bool,
    /// Switch the install onto a different release train (`stable`, `beta`, `rc`,
    /// `nightly`, `canary`, …) and update to that train's current build.
    ///
    /// Absent means "stay on the pinned channel", which is what makes a routine
    /// update keep following the train the user chose at install.
    #[serde(default)]
    pub(in crate::server) channel: Option<String>,
    /// Exact historical release tag selected from the Marketplace Versions tab.
    #[serde(default)]
    pub(in crate::server) version: Option<String>,
    /// Resolve and validate the update without writing the manifest, lifecycle
    /// row, dependency installs, or channel pin.
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}
