use super::*;

/// Publish `ServerState` to the process-global consumers and spawn its workers.
pub(super) fn wire_server_state(server_state: &server::ServerState) {
    server_state
        .mcp
        .set_plugin_runtime(server_state.plugin_runtime.clone());
    // An app's keyless stdio MCP server forwards to the app's lazy sidecar; the
    // registry wakes it before a tool call, as the ext-proxy does for a route.
    server_state
        .mcp
        .set_sidecar_manager(server_state.manager.clone());
    // Publish the state for the scheduler's continual-learning job (it has no
    // `State` extractor), mirroring the monitor/quest/identity-health engines.
    crate::learning::set_global_state(server_state.clone());
    // Install the process-global plugin-hook dispatcher so off-chat-path phases
    // (pre/post tool use, subagent stop, session end, notification) can fire hooks
    // from code that has no `ServerState` in scope. Mirrors plugin_storage::global.
    crate::server::install_global_hook_dispatcher(server_state.clone());
    // Sidecar event subscriptions (`subscribes`): app events from `events.emit` and
    // kernel events from `emit_kernel_event` fan out to subscriber sidecars.
    crate::sidecar::event_subscribers::install_global(
        crate::sidecar::event_subscribers::EventFanout::from_state(&server_state),
    );
    // Failed runs: the run-status bus loop reads a failed chat/agent run's context
    // from the kernel conversation store and raises `core#run.failed` (the scheduler
    // and workflow executor raise it inline). Subscribers (Self-Healing) receive it
    // through the fan-out installed above and act through grant-gated kernel
    // capabilities; Core names no consumer.
    crate::run_failures::spawn_bus_listener(server_state.clone());
    // "Agent finished" pushes to the conversation owner's opted-in phones, from
    // the agent (name + avatar) — covers runs the app's local alert cannot,
    // because the app was suspended or closed.
    crate::notify::run_push::spawn(server_state.clone());
    server::agent_sync::spawn_worker(server_state.clone());
    if !crate::safe_mode::is_active() {
        server::memory_dream::spawn_automatic_review(server_state.clone());
    } else {
        tracing::info!("safe mode: automatic Dream review not started");
    }
}

/// Install default marketplace plugins, fire `onStartup` and reconcile packs.
pub(super) async fn materialize_and_activate(
    server_state: &server::ServerState,
    offline_test_bootstrap: bool,
) {
    // Ordinary first-party plugins are official marketplace packages, not
    // compiled runtime entries. Install the default package set through the
    // same verified catalog path as the Store, then reload the runtime list
    // before activation and pre-installed seeding.
    if !crate::safe_mode::is_active() && !offline_test_bootstrap {
        const DEFAULT_MARKETPLACE_STARTUP_WAIT: std::time::Duration =
            std::time::Duration::from_secs(15);
        let materialization_state = server_state.clone();
        let mut materialization = tokio::spawn(async move {
            let newly_materialized =
                crate::server::install_default_official_plugins(&materialization_state).await;
            let runtime = crate::plugin_manifest::PluginManifestLoader::load_runtime();
            *materialization_state.app_manifests.write().await = runtime.clone();
            crate::plugins::seed::seed_preinstalled_with_materialized(
                &materialization_state.app_store,
                &runtime,
                &newly_materialized,
            )
            .await;
        });
        match tokio::time::timeout(DEFAULT_MARKETPLACE_STARTUP_WAIT, &mut materialization).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "default marketplace materialization task failed");
            }
            Err(_) => {
                tracing::warn!(
                    wait_secs = DEFAULT_MARKETPLACE_STARTUP_WAIT.as_secs(),
                    "default marketplace materialization exceeded startup wait; awaiting required mounts before routing"
                );
                if let Err(error) = materialization.await {
                    tracing::warn!(%error, "default marketplace materialization task failed");
                }
            }
        }
    }

    // Fire the `onStartup` activation event (#443) now that `ServerState` exists.
    // This is the live runtime driver behind the plugin activation contract: every
    // enabled plugin is run through `register_active` against the fired-event
    // snapshot, so eager plugins activate unconditionally and a plugin gated on
    // `onStartup` wakes here. Spawned (not awaited) so a slow registration never
    // delays the listener bind. onChat/onCommand are data-wiring follow-ons that
    // call the same `fire_activation_event` driver from the chat/palette paths.
    // Sidecar reconciliation follows this activation pass in the same task so
    // its generation binding cannot race the initial runnable registration.
    {
        let startup_state = server_state.clone();
        tokio::spawn(async move {
            crate::server::fire_activation_event(&startup_state, "onStartup").await;
            crate::server::reconcile_plugin_sidecars(&startup_state).await;
        });
    }

    // Drop any sidecar-registered provider entry left in models.json by an unclean
    // exit. `deregister_sidecar_provider` only runs from a sidecar's own `stop()`, so
    // a SIGKILL/panic/power-loss leaves a `baseUrl` at a loopback port plus that
    // plugin's minted ext token persisted — and Pi dials `baseUrl` DIRECTLY, bypassing
    // the ext-proxy and its registration gate. If any other process now holds that
    // port, it is handed the token and every inference body. Synchronous and BEFORE
    // the reconcile below: the healthy sidecars re-register their entries moments
    // later, so the purge window is exactly the "not healthy yet" state the entry is
    // meant to represent.
    match crate::pi_config::purge_sidecar_providers() {
        Ok(0) => {}
        Ok(n) => tracing::info!("purged {n} stale sidecar provider entr(ies) from models.json"),
        Err(e) => tracing::warn!("purging stale sidecar provider entries failed: {e}"),
    }

    // Reconcile the administrator-selected external skill packs in the
    // background. A fresh node has no selection, so this task is a no-op until
    // onboarding explicitly saves one; embedded Ryu/pstack skills are seeded
    // separately and remain available offline. Spawned (not awaited) so a slow
    // network sync never delays the listener bind.
    if !offline_test_bootstrap {
        let sync_state = server_state.clone();
        let sync_preferences = server_state.preferences.clone();
        tokio::spawn(async move {
            crate::skills_catalog::system_skills::run_on_boot(
                &sync_state.client,
                &sync_preferences,
            )
            .await;
        });
    }
}
