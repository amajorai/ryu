//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `fire_activation_event` through `stamp_contribution_authority`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Fire an activation event (`#443`): wake every **enabled** plugin whose
/// `activation_events` match the just-fired event, activating its Runnables via
/// the same [`build_runnable_registry`] dispatch the enable path uses.
///
/// This is the live runtime driver behind the activation contract. The event is
/// recorded in the process-global fired set (so a plugin enabled *after* the
/// event still sees it via the snapshot), then every enabled plugin is run
/// through [`crate::runnable::RunnableRegistry::register_active`] against the
/// snapshot — eager plugins (empty `activation_events`) always activate, gated
/// plugins activate only once one of their declared events has fired.
///
/// Idempotent and safe to call repeatedly: the Core handlers swallow re-register
/// (the Agent handler treats UNIQUE-constraint as success; Workflow `save` and
/// Tool `register_app_tool` overwrite in place). Best-effort — a per-Runnable
/// failure is logged, never fatal.
///
/// `onStartup` is fired from `main.rs` once `ServerState` exists; `onChat` /
/// `onCommand:<id>` / `onRunnable:<id>` are data-wiring follow-ons that call this
/// same driver from the chat and command-palette paths.
pub async fn fire_activation_event(state: &ServerState, event: &str) {
    let registry = build_runnable_registry(state);
    fire_activation_event_from_parts(
        &state.app_store,
        &state.plugin_runtime,
        &state.app_manifests,
        &registry,
        &state.mcp,
        event,
    )
    .await;
}

pub(in crate::server) async fn fire_activation_event_from_parts(
    app_store: &PluginStore,
    plugin_runtime: &crate::plugins::runtime::PluginRuntime,
    app_manifests: &tokio::sync::RwLock<Vec<crate::plugin_manifest::PluginManifest>>,
    registry: &crate::runnable::RunnableRegistry,
    mcp: &Arc<McpRegistry>,
    event: &str,
) {
    let snapshot = crate::runnable::mark_activation_event_fired(event);

    // The set of installed+enabled plugins; only these may activate. Each entry
    // carries the record's GATEWAY-APPROVED grants, because the `onStartup`
    // MCP-server re-register below is gated on them exactly as `activate_plugin`
    // is — without the record in scope that boot path would be an ungated second
    // door into the same process-spawning seam.
    let enabled_ids: std::collections::HashMap<String, Vec<String>> = match app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| (r.id, r.approved_grants))
            .collect(),
        Err(e) => {
            tracing::warn!("fire_activation_event('{event}'): listing plugins failed: {e}");
            return;
        }
    };
    if enabled_ids.is_empty() {
        return;
    }

    let manifests = app_manifests.read().await.clone();
    for manifest in &manifests {
        let Some(approved_grants) = enabled_ids.get(&manifest.id) else {
            continue;
        };
        if !crate::runnable::manifest_should_activate(manifest, &snapshot) {
            continue;
        }
        let Some(activation) = plugin_runtime
            .begin_activation_if_inactive(&manifest.id)
            .await
        else {
            continue;
        };
        // The enabled snapshot was captured before the per-plugin write lease.
        // Re-check the store so a disable that won the race cannot be followed
        // by a stale registration.
        let still_enabled = app_store
            .get(&manifest.id)
            .await
            .ok()
            .flatten()
            .is_some_and(|current| current.enabled);
        if !still_enabled {
            tracing::debug!(
                plugin = %manifest.id,
                generation = activation.generation().number(),
                "activation event became stale before registration"
            );
            continue;
        }
        let results = registry.register_active(manifest, &snapshot);
        for (rid, res) in results {
            if let Err(e) = res {
                tracing::debug!(
                    "fire_activation_event('{event}'): plugin '{}' runnable '{rid}': {e}",
                    manifest.id
                );
            }
        }
        // Re-materialize the plugin's declared MCP servers into the registry, but
        // ONLY on the boot seam (`onStartup` fires once from `main.rs`).
        // `McpRegistry::load` starts from built-ins + `mcp.json` only, so without
        // this an enabled plugin's `mcp_servers` would never reappear after a
        // restart. Gated on `onStartup` because `register_server` rebuilds the whole
        // server map + clears the tool/resource caches — running it on every
        // unrelated event firing (`onChat`/`onCommand:*`/`onRoute`/…) would wipe the
        // MCP tool cache and force stdio servers to re-spawn on the next list. The
        // enable-time registration lives in `activate_plugin`, not here.
        //
        // Same tier + approved-`mcp:server` gate as the enable path: the boot
        // re-register spawns exactly the same declared commands, so it must not be
        // the door that skips the check.
        //
        // This is also the seam that RE-PROBES for a declared command that was missing
        // last time (`register_manifest_mcp_servers` skips a declaration whose binary
        // cannot be resolved, and remembers nothing): install the binary, restart Core,
        // and the server comes back. Nothing re-probes mid-process.
        if event == "onStartup" {
            if let Some(refusal) = plugin_host_access_refusal_in(app_store, manifest).await {
                tracing::warn!(
                    plugin = %manifest.id,
                    "onStartup: plugin-declared MCP servers not registered: {refusal}"
                );
            } else {
                crate::sidecar::mcp::register_manifest_mcp_servers(
                    mcp,
                    manifest,
                    crate::plugins::builtins::tier_for_manifest(manifest),
                    approved_grants,
                );
            }
            // Re-register this plugin's contributed output styles, for the same
            // reason and on the same seam: the registry's plugin bag is in-memory
            // only (deliberately — it must survive a disk `reload()`), so without
            // this an enabled plugin's styles would vanish from the picker after a
            // restart while the plugin still read as enabled. Idempotent; unlike the
            // MCP re-register above it needs no grant gate, because a style body is
            // prose nothing evaluates (design §1, the `ThemeContribution` argument).
            sync_plugin_output_styles(manifest, true);
        }
        activation.commit();
    }
}

/// Fire the `onChat` activation event exactly once per process, off the hot
/// chat path.
///
/// Called from the `chat_stream` handler on every request, but guarded by a
/// process-global atomic so the expensive part (`fire_activation_event` lists
/// plugins, builds the runnable registry, and runs the register loop) happens
/// only on the very first chat turn. Concurrent first requests all race the
/// `swap`, and exactly one wins — the rest return immediately, so we never
/// rebuild the registry per-request (let alone per-chunk).
///
/// The winning firing is spawned, not awaited: the chat path must never block
/// streaming to wake activation-gated plugins. A plugin gated on `onChat`
/// therefore activates just after the first turn begins, not before it — an
/// intentional trade in favor of latency (the task's "never block streaming").
///
/// Note: turns initiated off the HTTP entry (e.g. the voice loop calling
/// `route_chat_stream` directly in `voice/session.rs`) bypass this and do not
/// fire `onChat`. The HTTP chat entry is the canonical trigger.
pub(in crate::server) fn fire_on_chat_once(state: &ServerState) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ON_CHAT_FIRED: AtomicBool = AtomicBool::new(false);
    // `swap` returns the previous value: `true` means someone already fired.
    if ON_CHAT_FIRED.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        fire_activation_event(&state, "onChat").await;
    });
}

/// Collect the `policy_type` of every `Policy` runnable in a manifest.
pub(in crate::server) fn manifest_policy_types(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Vec<String> {
    manifest_policies(manifest)
        .into_iter()
        .map(|c| c.policy_type)
        .collect()
}

/// Snapshot of every **enabled** plugin's record, keyed by id.
///
/// Factored out because two readers must agree on what "enabled" means: the
/// desktop's `GET /api/plugins/contributions` and the channel bots'
/// `GET /api/channels/commands`. If they drifted, a bot would publish a command
/// menu entry for a plugin whose `pre_user_turn` hook is not registered — tapping
/// it would send a literal `/proof` to the model and get a shrug back, which is
/// worse than the command not existing.
///
/// Returns the full records (not just ids) because the contributions handler also
/// needs each record's GATEWAY-APPROVED grants for the companions payload.
pub(in crate::server) async fn enabled_plugin_records(
    state: &ServerState,
) -> Result<std::collections::HashMap<String, crate::plugins::PluginRecord>, String> {
    match state.app_store.list().await {
        Ok(records) => Ok(records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| (r.id.clone(), r))
            .collect()),
        Err(e) => Err(e.to_string()),
    }
}

/// Walk the manifests and collect the `slash_commands` of every enabled plugin
/// that targets `surface`, each tagged in place with its owning `plugin` id.
///
/// The entries stay `serde_json::Value` for the same reason the manifest contract
/// stores them that way: a desktop newer than the node it talks to must not lose
/// keys this Core build has never heard of.
///
/// `surface = None` means "no filter" (an absent/unknown `x-ryu-surface`), which
/// is the case for every non-desktop reader — a channel bot is not one of the
/// declared surfaces, so it sees the unfiltered set rather than nothing.
pub(in crate::server) fn collect_plugin_slash_commands(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_ids: &std::collections::HashSet<String>,
    surface: Option<crate::plugin_manifest::Surface>,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for manifest in manifests {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        out.extend(c.slash_commands.iter().cloned().map(|mut v| {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("plugin".to_string(), serde_json::json!(manifest.id));
            }
            v
        }));
    }
    out
}

/// Resolve + validate the server-owned HTTP authority stamped onto declarative
/// contributions. A manifest id never grants this: only exact compiled bytes or
/// a digest-bound verified official package can resolve to Core tier.
pub(in crate::server) fn declarative_http_policy(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Result<&'static str, String> {
    let core = crate::plugins::builtins::tier_for_manifest(manifest)
        == crate::plugin_manifest::PluginTier::Core;
    manifest.validate_declarative_http_policy(core)?;
    Ok(if core { "core" } else { "owner" })
}

pub(in crate::server) fn stamp_contribution_authority(
    manifest: &crate::plugin_manifest::PluginManifest,
    value: &mut serde_json::Value,
    http_policy: &str,
) {
    if let Some(object) = value.as_object_mut() {
        object.insert("plugin".to_string(), serde_json::json!(manifest.id));
        // Always overwrite a publisher-supplied lookalike. This field is an
        // authorization decision made by Core, never manifest data.
        object.insert("http_policy".to_string(), serde_json::json!(http_policy));
    }
}
