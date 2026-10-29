use super::*;

/// Register a managed/enrolled node with its organization, with bounded retry.
pub(super) fn spawn_managed_node_registration(
    gateway: &Arc<sidecar::gateway::GatewayManager>,
    offline_test_bootstrap: bool,
) {
    // Organization registration (A4 / #501): managed cloud nodes use their
    // provisioned gateway key; enrolled self-hosted nodes use the persisted
    // node-control credential without requiring `RYU_MANAGED_NODE`. Both bind
    // usage to the credential's organization. A local unbound install remains a
    // no-op, and resolve failures never block Core from coming up.
    //
    // F7 (bounded retry): on a fresh managed node the FIRST `/gateway/resolve`
    // ALSO performs the single-use bootstrap→durable exchange, and Core is
    // un-chattable (`gateway_bearer` fails closed) until the durable is adopted.
    // The old durable-in-core.env model needed no exchange, so a transient
    // first-boot failure (node network not yet up, control-plane blip) never
    // stranded a node; now it could, with no auto-recovery under `Restart=always`
    // (Core does not exit). So retry with capped backoff. This does NOT worsen the
    // accepted "lost resolve RESPONSE" brick (a revoked bootstrap just 401s every
    // retry → re-provision, same as before); it recovers the common case where the
    // request never reached the server. Non-managed / no-key nodes return
    // `Ok(None)` on the first attempt and never loop.
    if !offline_test_bootstrap {
        let cp_client = reqwest::Client::new();
        let gateway_ref = Arc::clone(&gateway);
        tokio::spawn(async move {
            const MAX_ATTEMPTS: u32 = 6;
            let mut attempt: u32 = 0;
            loop {
                attempt += 1;
                match sidecar::control_plane::register_managed_node(&cp_client).await {
                    Ok(None) if fleet::enrollment_recovery_pending() && attempt < MAX_ATTEMPTS => {
                        let backoff = std::time::Duration::from_secs(2u64.pow(attempt.min(5)));
                        tracing::info!(
                            "control-plane: waiting for saved organization enrollment recovery; retrying registration in {backoff:?}"
                        );
                        tokio::time::sleep(backoff).await;
                    }
                    Ok(None) => break,
                    Ok(Some(org)) => {
                        tracing::info!(
                            org_id = %org.id,
                            org = %org.name,
                            "control-plane: node registered; usage attributes to this org"
                        );
                        ryu_analytics::sync_gateway_relay_config();
                        // The bootstrap→durable exchange updates Core's process
                        // environment after the local Gateway may already have
                        // started. Respawn once so its typed Ryu relay uses the
                        // durable node key rather than the consumed bootstrap.
                        if let Err(error) = gateway_ref.refresh().await {
                            tracing::warn!(error = %error, "gateway: refresh after managed-node registration failed");
                        }
                        break;
                    }
                    Err(e) if attempt < MAX_ATTEMPTS => {
                        // 2,4,8,16,32s (capped) — ~1 min total across the boot window.
                        let backoff = std::time::Duration::from_secs(2u64.pow(attempt.min(5)));
                        tracing::warn!(
                            "control-plane: managed-node registration attempt {attempt} failed ({e}); retrying in {backoff:?}"
                        );
                        tokio::time::sleep(backoff).await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "control-plane: managed-node registration failed after {attempt} attempts ({e}); node not org-bound until it succeeds"
                        );
                        break;
                    }
                }
            }
        });
    }
}

/// Auto-install the local inference stack and the default ACP agent on first run.
pub(super) fn spawn_first_run_installs(
    setup: &Arc<SetupManager>,
    install_status: &Arc<InstallStatusStore>,
    download_center: &crate::downloads::DownloadCenter,
    sidecars: &Arc<SidecarManager>,
    offline_test_bootstrap: bool,
) {
    // Auto-install the local inference stack (llama.cpp binary + GGUF model)
    // on first run. Idempotent: LlamaCppDownloader and GgufDownloader both
    // check for existing files on disk before downloading. The desktop polls
    // GET /api/catalog to track progress; it must not trigger this itself.
    //
    // `RYU_SKIP_LOCAL_STACK_INSTALL=1` (provider-key-only nodes) skips the whole
    // task: no engine or model downloads, and the tools it marks stay unmarked.
    let skip_local_stack = crate::sidecar::onboarding::local_stack_auto_install_skipped();
    if skip_local_stack {
        tracing::info!(
            "local inference stack auto-install skipped (RYU_SKIP_LOCAL_STACK_INSTALL=1); \
             chat uses a configured provider until a local model is installed"
        );
    }
    if !offline_test_bootstrap && !skip_local_stack {
        let setup_ref = Arc::clone(&setup);
        let install_status_ref = Arc::clone(&install_status);
        // The default chat + embedding GGUFs download through the global
        // DownloadCenter (#456), so they stream to disk and show in the overlay.
        let downloads_ref = download_center.clone();
        // The voice engines this install just provisioned have to be started HERE.
        // `start_all` is spawned concurrently with this task and reads the installed
        // set from `seed_installed_from_disk`, which on a FIRST run is empty for
        // anything onboarding is still downloading — so it skipped both voice
        // engines and they stayed down until the user restarted Core. That restart
        // requirement is invisible and nobody performs it, which is a large part of
        // why voice reads as broken on a fresh install.
        let voice_sidecars_ref = Arc::clone(&sidecars);
        tokio::spawn(async move {
            let stack = setup_ref.install_local_stack(&downloads_ref).await;
            // The install's warnings (the image tier a node got, why chat fell back
            // to a smaller model) reach no route or UI, so the log is where they
            // are shown.
            for warning in &stack.warnings {
                tracing::warn!("onboarding: {warning}");
            }
            // The return value used to be dropped, so a failed first-run install
            // left Core serving with no local model and only a buried mid-install
            // warning. Emit a loud, single summary line when the default chat
            // stack did not come up so the failure is visible in logs (and, via
            // the catalog/install-status the desktop polls, to the user).
            if !(stack.llamacpp_installed && stack.gguf_installed) {
                tracing::error!(
                    ?stack,
                    "local inference stack did not fully install on first run — \
                     the default local model is unavailable; chat will hang or \
                     error until a model/provider is configured"
                );
            }
            // Surface the default-installed tool apps (agentbrowser,
            // shadow, ghost, llmfit) as "installed" in the catalog. The catalog's
            // install_state is read from InstallStatusStore, so onboarding's
            // SetupManager mark alone is not enough — seed both. shadow + ghost
            // are built into Core (MCP registry); the rest are managed sidecars.
            // (Spider is a declarative `command` plugin, user-installed CLI — not
            // a managed sidecar — so it is not seeded here.)
            for tool in ["agentbrowser", "shadow", "ghost", "llmfit"] {
                if !setup_ref.is_installed(tool).await {
                    setup_ref.mark_installed(tool).await;
                }
                install_status_ref
                    .set_installed(tool, "builtin".to_string())
                    .await;
            }

            // Bring up the voice engines onboarding just installed, without waiting
            // for a Core restart (see `voice_sidecars_ref`). Both are idempotent:
            // `start_sidecar` no-ops when already running (the common case on every
            // boot after the first, where `seed_installed_from_disk` let `start_all`
            // handle them), and skips anything still not installed. Best-effort —
            // a voice engine that will not start is a warning, never a boot failure.
            for name in ["parakeet", "ryutts"] {
                if !setup_ref.is_installed(name).await {
                    continue;
                }
                if let Err(e) = voice_sidecars_ref.start_sidecar(name).await {
                    tracing::warn!("post-onboarding start of {name} failed: {e:#}");
                }
            }
        });
    }

    // Ensure the default ACP agent (acp:pi by default, overridable via
    // RYU_DEFAULT_AGENT / registry.json) is installed on first run (U041 AC1).
    // Runs in the background so Core's HTTP API is not blocked by the npx
    // install. Non-fatal: failure is logged as a warning, not a panic.
    if !offline_test_bootstrap {
        let setup_ref = Arc::clone(&setup);
        tokio::spawn(async move {
            setup_ref.ensure_default_agent_installed().await;
        });
    }
}
