use super::*;

/// The sidecar manager and the setup state built around it.
pub(super) struct SidecarBoot {
    pub(super) setup: Arc<SetupManager>,
    pub(super) install_status: Arc<InstallStatusStore>,
    pub(super) download_center: crate::downloads::DownloadCenter,
    pub(super) bind_addr: String,
    pub(super) seed_names: Vec<String>,
    pub(super) sidecars: Arc<SidecarManager>,
}

/// Build the download center, every built-in sidecar and the sidecar manager.
pub(super) async fn build_sidecars() -> SidecarBoot {
    // Initialize setup manager
    let setup = Arc::new(SetupManager::new());
    let install_status = Arc::new(InstallStatusStore::new());

    // Global download state manager (#456). Created BEFORE the sidecars so each
    // downloading manager can hold a clone (field injection) and route its
    // install through the center — both its auto-spawn `start()` path and the
    // `install_sidecar` route reach the one center. Reload interrupted downloads
    // + reconcile orphan `.part` files (auto-resume when RYU_DOWNLOADS_AUTORESUME=1).
    let download_center = crate::downloads::DownloadCenter::with_default_client();
    download_center.load().await;
    crate::needle2::install_downloads(download_center.clone());
    crate::needle3::install_downloads(download_center.clone());

    let bind_addr = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("--bind="))
        .and_then(|a| a.strip_prefix("--bind=").map(str::to_string))
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_else(|| format!("127.0.0.1:{}", crate::profile::port(7980)));
    let tunnel_port = bind_addr
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .unwrap_or_else(|| crate::profile::port(7980));
    // OpenTunnel and plugin adapters dial Core where it actually listens.
    let tunnel_target = sidecar::tunnel_target(&bind_addr, tunnel_port);

    // Island is a desktop-owned companion, not a Core sidecar: Core never starts
    // it and it stays out of the node selector while the feature is disabled. Its
    // bundle is still preinstalled here so the future launch toggle is a product
    // switch, not a reinstall. Using the same DownloadCenter also makes the
    // disabled companion's initial download and later refresh visible in Desktop's
    // global Downloads surface.
    // `RYU_SKIP_LOCAL_STACK_INSTALL=1` skips the preinstall like every other
    // automatic download.
    #[cfg(not(debug_assertions))]
    if !crate::sidecar::onboarding::local_stack_auto_install_skipped() {
        let island_downloads = download_center.clone();
        tokio::spawn(async move {
            let version = env!("CARGO_PKG_VERSION");
            if let Err(error) =
                crate::sidecar::tools::island::ensure_installed(&island_downloads, version, false)
                    .await
            {
                tracing::warn!(error = %error, "Island preinstall/update failed");
            }
        });
    }

    // Define all available sidecars
    let all_sidecars: Vec<Arc<dyn sidecar::Sidecar>> = vec![
        // Providers
        Arc::new(LlamaCppManager::new().with_downloads(download_center.clone())),
        // Dedicated embeddings server (runs alongside the chat engine) — serves
        // the nomic GGUF for real semantic RAG with zero setup.
        Arc::new(LlamaCppEmbedManager::new().with_downloads(download_center.clone())),
        // Dedicated reranker server — serves the bge cross-encoder GGUF for
        // neural reranking of Spaces RAG. Off by default (NOT in startup_order):
        // lazily started by the Spaces search path on first use. The model is
        // still auto-downloaded during onboarding.
        Arc::new(LlamaCppRerankManager::new().with_downloads(download_center.clone())),
        // Dedicated classify server — serves the 270M gemma GGUF as the cheap
        // "classify tier" the gateway's firewall inspector and smart-routing
        // classifier route to (instead of the user's full-size resident chat
        // engine). Off by default (NOT in startup_order): Core's gateway
        // config-push path lazily starts it when a pushed config selects the tier.
        // The model is still auto-downloaded during onboarding.
        Arc::new(LlamaCppClassifyManager::new().with_downloads(download_center.clone())),
        // Dedicated Speech Processing server — serves S1-mini for optional
        // post-ASR cleanup. It is lazy and shares the llama.cpp binary with the
        // other local tiers, so disabling cleanup stops new calls without
        // affecting the resident chat or Voice Recognition engine.
        Arc::new(LlamaCppSpeechManager::new().with_downloads(download_center.clone())),
        // Opt-in guard model server for the node's own hazard screener. Off by
        // default (NOT in startup_order, no onboarding download): started only
        // when the operator enables the guard screener kind
        // (`sidecar::node_screener`), and that start fetches its pinned GGUF.
        Arc::new(LlamaCppGuardManager::new().with_downloads(download_center.clone())),
        Arc::new(OllamaManager::new().with_downloads(download_center.clone())),
        Arc::new(VllmManager::new()),
        Arc::new(SglangManager::new()),
        // MLX — Apple Silicon only. Registered on every platform so the catalog
        // can show it (disabled) on non-Mac nodes; the node-gate in the provider
        // + install route refuses to actually run/install it off Apple Silicon.
        Arc::new(MlxManager::new()),
        // MLX-VLM — vision/omni MLX engine (recommended default MLX on Apple
        // Silicon). Same node-gate as mlx-lm.
        Arc::new(MlxVlmManager::new()),
        // mlx-serve — native Zig, model-directory MLX + GGUF server. It is
        // opt-in and uses the same active-engine swap as the Python MLX lanes.
        Arc::new(MlxServeManager::new()),
        // oMLX — high-performance Apple-Silicon server (PATH-adopted, opt-in).
        Arc::new(OmlxManager::new()),
        // Docker Model Runner — adopt-only: Ryu downloads/spawns nothing, it just
        // routes to Docker's built-in OpenAI-compatible model server on :12434.
        Arc::new(DockerModelRunnerManager::new()),
        Arc::new(sidecar::providers::LemonadeManager::new()),
        Arc::new(sidecar::providers::MagnitudeManager::new()),
        Arc::new(sidecar::providers::LlamaSwapManager::new()),
        Arc::new(sidecar::providers::FreeTokenManager::new()),
        // apfel — Apple Foundation Models (Apple Silicon macOS 26+). Adopt-a-binary
        // (PATH/`brew`), serves Apple Intelligence as an OpenAI-compat local engine.
        // Registered on every platform so the catalog shows it (disabled) off a
        // supported Mac; the node-gate refuses to run/install it elsewhere.
        Arc::new(ApfelManager::new()),
        // Mesh LLM — an OpenAI-compatible distributed local engine. Ryu adopts
        // or starts the user's executable and routes it through the existing
        // Gateway `local` provider; it does not vendor Mesh LLM or its models.
        Arc::new(MeshLlmManager::new()),
        // Voice engines (STT/TTS) — opt-in, run alongside the resident chat engine.
        Arc::new(WhisperCppManager::new().with_downloads(download_center.clone())),
        Arc::new(ParakeetManager::new().with_downloads(download_center.clone())),
        Arc::new(AudioCppManager::new()),
        Arc::new(OuteTtsManager::new().with_downloads(download_center.clone())),
        // Ryu TTS sidecar — universal multi-engine text-to-speech (Python runtime
        // fronting KittenTTS, Pocket TTS, …). Opt-in; NOT in startup_order — it
        // only starts once a user installs it or runs `bun run dev:tts`.
        Arc::new(RyuTtsManager::new().with_downloads(download_center.clone())),
        // Generative-media engine (text-to-image / -video) — opt-in, runs
        // alongside the resident chat engine (NOT in startup_order: diffusion
        // models are multi-GB, so it only starts once a user installs it).
        Arc::new(StableDiffusionManager::new().with_downloads(download_center.clone())),
        // (The Unsloth fine-tuning sidecar is no longer Core-managed — it is a
        // manifest-declared managed sidecar OWNED by the `@ryu/finetune` app,
        // started on plugin-enable + boot-reconcile. Core keeps NO in-process finetune
        // code: the `ryu-finetune` sidecar owns the store, the adapter catalog, the
        // worker HTTP client, and the `/api/finetune/*` surface; the Companion reaches
        // it through the generic ext-proxy and the learning loop through the
        // `finetune.start` / `finetune.merge` capabilities.)
        // Tools
        // (Spider is now a declarative `command` plugin — fixtures/spider.manifest.json —
        // with no in-process manager; the `spider` CLI is user-installed and reached
        // via the command-tool allowlist, so there is no SpiderManager sidecar here.)
        // (The Python autoresearch engine is NOT managed here: the `@ryu/research`
        // app's own manifest sidecar (`ryu-research`, port via the injected
        // `RYU_RESEARCH_PORT`) supervises it through its `EngineSupervisor`.)
        Arc::new(LlmFit::new()),
        Arc::new(ShadowManager::new().with_downloads(download_center.clone())),
        Arc::new(GhostManager::new().with_downloads(download_center.clone())),
        // Agents
        Arc::new(ZeroClawManager::new().with_downloads(download_center.clone())),
        Arc::new(OpenClawManager::new()),
        Arc::new(HermesManager::new()),
        // Network backends: Tailscale, Headscale, Tailcat, Cloudflared, OpenTunnel,
        // and the bound `network.tunnel` plugin adapter.
        // Opt-in via the mesh setting; only the selected backend is marked installed.
        Arc::new(TailscaleManager::new().with_downloads(download_center.clone())),
        Arc::new(TailcatManager::new()),
        Arc::new(CloudflaredManager::new(tunnel_port)),
        Arc::new(OpenTunnelManager::new(tunnel_port, tunnel_target.clone())),
        Arc::new(PluginTunnelManager::new(tunnel_port, tunnel_target)),
    ];

    let startup_order = default_startup_order();

    // Keep the names so we can seed the installed set from disk before
    // `start_all` runs (see the `seed_installed_from_disk` call below).
    let seed_names = startup_order.clone();
    let sidecars = SidecarManager::new(all_sidecars, startup_order, Arc::clone(&setup));

    // Publish the manager to the gateway config-push path so it can lazily start
    // the off-by-default classify tier when a pushed `/v1/config` selects it. The
    // gateway is a separate process and cannot start a Core sidecar itself, and
    // `push_config` is a free function with no `ServerState` in scope — so the
    // handle travels as a process-global, seeded here at the single build site.
    crate::sidecar::gateway::register_sidecar_manager(Arc::clone(&sidecars));

    // Preflight the OS permissions the native capture/automation sidecars (ghost,
    // shadow) depend on. Core only detects and reports — it is a background
    // service and cannot show the system dialogs; prompting is the desktop app's
    // and `ghost setup`'s job. Missing grants are logged loudly so a degraded
    // sidecar has an obvious cause instead of failing silently downstream.
    for cap in ghost_permissions::ALL {
        if ghost_permissions::required(cap) && !ghost_permissions::granted(cap) {
            tracing::warn!(
                "{} permission not granted — ghost/shadow capture will be degraded until it is enabled (desktop onboarding, System Settings, or `ghost setup`)",
                cap.label()
            );
        }
    }
    SidecarBoot {
        setup,
        install_status,
        download_center,
        bind_addr,
        seed_names,
        sidecars,
    }
}
