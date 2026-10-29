use super::*;

/// Spawn connect-event workers, the headroom proxy and the webhook ingress.
pub(super) fn spawn_edge_services(
    server_state: &server::ServerState,
    headroom: &Arc<sidecar::headroom::HeadroomManager>,
    bind_addr: &str,
    offline_test_bootstrap: bool,
) {
    server::connect_events::spawn_workers(server_state.clone());

    // Start the optional headroom compression proxy before the gateway so it is
    // reachable when the gateway's compression transform first runs. Best-effort
    // and fully graceful: disabled by default, and a missing binary just leaves
    // compression inactive (the gateway passes requests through uncompressed).
    if !offline_test_bootstrap {
        let headroom_ref = Arc::clone(&headroom);
        tokio::spawn(async move {
            match headroom_ref.start().await {
                Ok(true) => tracing::info!(
                    "headroom: compression proxy ready on {}",
                    sidecar::headroom::headroom_url()
                ),
                Ok(false) => {}
                Err(e) => tracing::warn!("headroom: start error (compression inactive): {e}"),
            }
        });
    }

    // (The `ryu-mail` sidecar is spawned by the generic plugin-sidecar loader when
    // the `@ryu/mail` app is reconciled — no bespoke startup here.)

    // Webhook ingress seam (#479, P6a): build the configured ingress backend
    // (default RyuRelay; pref `webhook.ingress.backend`; env override
    // `RYU_WEBHOOK_INGRESS_URL` ⇒ OwnRelay), start it, and cache its public URL
    // for `GET /api/webhook-ingress/status`. Tunnels point Composio at Core's
    // existing `POST /api/composio/webhook` (composio_triggers fires unchanged).
    // Runs after composio_triggers::set_global so a future RyuRelay push loop can
    // dispatch in-process. Best-effort: a backend that cannot start (no public
    // URL, mesh off, Phase-6b) just leaves the public URL unset — never blocks Core.
    if !offline_test_bootstrap {
        let server_url = format!("http://{bind_addr}");
        tokio::spawn(async move {
            let prefs = match server::preferences::PreferencesStore::open_default() {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("webhook-ingress: preferences unavailable ({e}); skipping");
                    return;
                }
            };
            let ingress = crate::webhook_ingress::from_prefs(&prefs, &server_url).await;
            let kind = ingress.kind();
            match ingress.start().await {
                Ok(()) => match ingress.public_url().await {
                    Ok(url) => {
                        tracing::info!("webhook-ingress: {} ready at {url}", kind.as_str());
                        crate::webhook_ingress::set_public_url(Some(url));
                    }
                    Err(e) => tracing::info!(
                        "webhook-ingress: {} started but no public URL yet ({e})",
                        kind.as_str()
                    ),
                },
                Err(e) => tracing::info!("webhook-ingress: {} not active ({e})", kind.as_str()),
            }
        });
    }
}

/// Start the scheduled-job tick loop unless Safe Mode or the offline bootstrap is active.
pub(super) async fn spawn_scheduler(
    scheduler_apps: crate::plugins::PluginStore,
    offline_test_bootstrap: bool,
) {
    // Start the scheduled-job tick loop (reloads jobs from disk so schedules
    // survive a Core restart). The App store rides along so a job an App created
    // stops firing while that App is disabled or uninstalled.
    //
    // Not spawned under Safe Mode. A scheduler is a background CPU source that
    // fires work the user did not ask for during the run they are measuring —
    // cron jobs, monitor checks, warmup pings. Jobs are reloaded from disk on
    // every boot, so nothing is lost: a normal restart resumes the schedule.
    if crate::safe_mode::is_active() || offline_test_bootstrap {
        tracing::info!("scheduled-job tick loop not started (safe mode or offline test bootstrap)");
    } else {
        // Seed the Patrol bot's hourly patrol and daily report once per schedule
        // version, before the tick loop loads jobs. Deleting them is final (see
        // `agents::patrol`); removing Patrol from the catalog pauses them.
        if let Some(agents) = crate::agents::global() {
            if let Err(e) = crate::agents::patrol::seed_schedules(agents).await {
                tracing::warn!("failed to seed Patrol schedules: {e:#}");
            }
        }
        scheduler::Scheduler::new()
            .with_apps(scheduler_apps)
            .spawn();
    }
}

/// Adopt the durable token and start the analytics, fleet, license and scope loops.
pub(super) async fn spawn_control_plane_loops(
    server_state: &server::ServerState,
    offline_test_bootstrap: bool,
) {
    // F7 boot precedence: BEFORE any control-plane spawn reads the gateway env,
    // re-adopt a durable token persisted by a prior bootstrap exchange. On a
    // RESTARTED managed node `core.env` still carries the now expired+revoked
    // bootstrap KEY; if the loader did not run first, both `resolve_scope` (just
    // below) and `register_managed_node` would grab that stale key and 401 for the
    // whole process lifetime. The loader overrides BOTH `RYU_GATEWAY_KEY` and
    // `RYU_GATEWAY_TOKEN` with the durable when the file is present; a fresh node
    // (no file) is untouched and exchanges its bootstrap normally.
    sidecar::control_plane::load_persisted_durable_token();

    // The Ryu Axiom diagnostics mirror is a typed, content-free relay separate
    // from the customer's OTLP span destination. It no-ops on unbound local
    // nodes and re-reads diagnostics consent and endpoint configuration every
    // tick, so opt-out stops future mirror egress without a restart.
    ryu_analytics::spawn();

    // Enrolled nodes pull signed fleet desired state over an outbound-only
    // long poll. Unenrolled/local-only nodes sleep without touching the network.
    fleet::spawn_reconciler(server_state.clone());

    // Re-check licenses of enabled paid Marketplace items in the background and
    // disable an item whose purchase was refunded, disputed, or lapsed.
    server::marketplace_license_watch::spawn(server_state.clone());

    // Resolve the hierarchy-scoped tool set from the control plane (U30) when a
    // gateway key is configured, and keep it live. This narrows the local
    // config-driven MCP registry (U13) to what the org/team/project has granted
    // and loads the org tool policy (C2) once the node is registered. The loop
    // re-resolves on a jittered interval and immediately when the control
    // plane's `policyVersion` changes; a failed fetch keeps the last known good
    // scope. Best-effort: a missing key means local-only mode, and a resolve
    // failure never blocks Core from coming up.
    // Republish the persisted managed governance locks first so a restart
    // never runs with the managed values but without their locks.
    sidecar::control_plane::restore_managed_locks(
        &server_state.preferences,
        &server_state.app_store,
    )
    .await;
    if !offline_test_bootstrap {
        tokio::spawn(sidecar::control_plane::run_scope_refresh_loop(
            server_state.clone(),
        ));
        // The picker's Ryu Router "Free" tags (control-plane projection).
        tokio::spawn(sidecar::control_plane::run_free_models_refresh_loop());
    }
}
