use super::*;

/// Start sidecars and the Gateway, then the sampler, reaper and engine reactors.
pub(super) fn start_engines(
    sidecars: &Arc<SidecarManager>,
    gateway: &Arc<sidecar::gateway::GatewayManager>,
    server_state: &server::ServerState,
    reactor_preferences: server::preferences::PreferencesStore,
    offline_test_bootstrap: bool,
) {
    // Start sidecars before the local Gateway. The Gateway's automatic
    // `LOCAL_LLM_URL` is now gated by the resident sidecar's verified liveness;
    // starting it after this task prevents a persisted llama.cpp selection from
    // being published while an old listener still owns the profile port.
    //
    // Threads the previous process died in the middle of are resumed from the
    // same task once the Gateway is up, since a resumed turn needs it to reach a
    // model (see `server::run_auto_resume`).
    let sidecars_ref = Arc::clone(&sidecars);
    let gateway_ref = Arc::clone(&gateway);
    let resume_state = server_state.clone();
    tokio::spawn(async move {
        if !offline_test_bootstrap {
            if let Err(e) = sidecars_ref.start_all().await {
                tracing::error!("sidecar startup failed: {e}");
            }
        }
        let gateway_started = match gateway_ref.start().await {
            Ok(true) => {
                tracing::info!("gateway: ready on {}", sidecar::gateway::gateway_url());
                true
            }
            Ok(false) => true,
            Err(e) => {
                tracing::error!(
                    "gateway: failed to start ({e}); Core chat will return an error until a gateway is available"
                );
                false
            }
        };
        if gateway_started && !offline_test_bootstrap {
            server::run_auto_resume::resume_boot_interrupted_runs(resume_state.clone()).await;
            // Harness runs a session queued behind an active run (double-texting
            // `enqueue`/`interrupt`/`rollback`) start once a model is reachable.
            server::harness::resume_queued_harness_runs(resume_state).await;
            // Workflow runs the previous process died in the middle of, and runs
            // parked on a provider limit, continue once a model is reachable (see
            // `workflow::auto_resume`).
            workflow::auto_resume::resume_after_boot().await;
        }
    });

    // Begin sampling per-engine memory/CPU for the node selector's engine list.
    // Cheap (refreshes only the known sidecar PIDs every couple seconds); the
    // numbers ride the existing `/api/sidecar/status` poll.
    sidecars.spawn_resource_sampler();

    // Idle-stop (Rivet-style scale-to-zero): if `RYU_SIDECAR_IDLE_SECS` opts any
    // heavy sidecar in (e.g. `llamacpp-rerank=900,research=1800`), a background
    // reaper stops it after the configured idle period; the next request wakes it
    // on demand. A pure no-op when unset — the task isn't even spawned — so the
    // default holds all lazy-started sidecars resident exactly as before.
    sidecars.spawn_idle_reaper();

    // Gaming mode: opt-in game detection plus the model-sidecar pause that frees
    // RAM/VRAM while a game runs (also honours a manual "Gaming" status).
    gaming::spawn(Arc::clone(&sidecars));
    presence::streaming::spawn();

    // A previous Core that crashed or was killed never ran its ACP tree reapers;
    // its agent bridges and CLIs would otherwise stay resident forever.
    acp_runtime::reap_orphaned_trees();

    // Keep the managed Pi engine and its pi-acp bridge on their newest releases.
    if !offline_test_bootstrap {
        crate::required_update_runtime::spawn_auto_update();
    }

    // React to the local-model auto-unload setting at runtime: when the user
    // changes `engine.llamacpp.sleep-idle-seconds` in settings, restart the
    // resident llama.cpp engine so the new `--sleep-idle-seconds` takes effect
    // immediately instead of waiting for the next spawn. A no-op for every other
    // local engine (their spawn paths don't read this flag) and for a non-resident
    // llama.cpp (a later `set_active_local_engine` applies the current value).
    {
        let reactor_sidecars = Arc::clone(&sidecars);
        tokio::spawn(async move {
            let mut rx = reactor_preferences.subscribe();
            loop {
                match rx.recv().await {
                    Ok(event)
                        if event.key
                            == crate::sidecar::providers::llamacpp::SLEEP_IDLE_SECS_PREF =>
                    {
                        let resident = reactor_sidecars.active_local_engine().await;
                        if resident.as_deref() == Some("llamacpp") {
                            if let Err(e) = reactor_sidecars.restart_sidecar("llamacpp").await {
                                tracing::warn!(
                                    error = %e,
                                    "could not restart llama.cpp after auto-unload setting change"
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}
