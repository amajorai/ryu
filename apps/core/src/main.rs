mod activity;
mod agent_routing;
mod agents;
mod approvals;
mod auth;
mod capabilities;
mod catalog;
mod catalog_source;
mod claude_config;
mod codex_config;
mod collab;
mod composio_auth;
mod composio_catalog;
mod composio_connect;
mod composio_triggers;
mod connections;
mod crash;
mod crypto;
mod dashboard;
mod data_path;
mod downloads;
mod entitlement;
mod events;
mod experience;
mod fal_auth;
mod finetune;
mod hardware;
mod hf_auth;
mod identity;
mod healing;
mod identity_verify;
mod inference;
mod learning;
mod mcp_catalog;
mod meetings;
mod mesh;
mod model_catalog;
mod model_format;
mod monitors;
mod native_history;
mod okf;
mod openrouter_auth;
mod paths;
mod pi_config;
mod plugin_host;
mod plugin_manifest;
mod plugin_storage;
mod plugins;
mod predict;
mod privacy;
mod quests;
mod realtime;
mod recipes;
mod registry;
mod replicate_auth;
mod runnable;
mod sandbox;
mod scheduler;
mod server;
mod sidecar;
mod skills;
mod skills_catalog;
mod support_access;
mod system_info;
mod teams;
mod telemetry;
mod tool_exec;
mod update;
mod usage;
mod voice;
mod webhook_ingress;
mod workflow;

use std::sync::Arc;
use tokio::sync::Mutex;

use sidecar::{
    adapters::AcpAgentRegistry,
    agents::{HermesManager, OpenClawManager, ZeroClawManager},
    install_state::InstallStatusStore,
    onboarding::SetupManager,
    providers::{
        apfel::ApfelManager, llamacpp::LlamaCppEmbedManager, llamacpp::LlamaCppManager,
        llamacpp::LlamaCppRerankManager, mlx::MlxManager, mlx_vlm::MlxVlmManager,
        ollama::OllamaManager, omlx::OmlxManager, outetts::OuteTtsManager,
        parakeet::ParakeetManager, ryutts::RyuTtsManager, sdcpp::StableDiffusionManager,
        sglang::SglangManager, unsloth::UnslothManager, vllm::VllmManager,
        whispercpp::WhisperCppManager, DockerModelRunnerManager,
    },
    tailscale::TailscaleManager,
    tools::{
        ghost::GhostManager, llmfit::LlmFit, research::ResearchManager, shadow::ShadowManager,
        spider::SpiderManager,
    },
    SidecarManager,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() {
    // Emit the OpenAPI spec and exit — keeps stdout clean (before tracing init)
    // so `ryu-core --dump-openapi > core-openapi.json` is well-formed. The spec
    // is static (derived from handler annotations), so no server state is needed.
    if std::env::args().any(|a| a == "--dump-openapi") {
        use utoipa::OpenApi;
        let spec = crate::server::openapi::ApiDoc::openapi();
        match spec.to_pretty_json() {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("failed to serialize OpenAPI spec: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    // One-shot data-folder maintenance: `ryu-core data-path <migrate|import|export>`.
    // Runs while the desktop has Core STOPPED (so no SQLite handles are open) and
    // streams `@@PROGRESS {json}` lines to stdout. Done before tracing init to keep
    // that stream clean. On success it updates the pointer; the desktop then restarts
    // Core, which re-resolves the data dir from the pointer.
    {
        let args: Vec<String> = std::env::args().collect();
        if crate::data_path::run_cli(&args) {
            return;
        }
    }

    // OpenTelemetry export seam (#539, P1): build an OPTIONAL OTLP layer that is
    // installed ONLY when the user consented (`diagnostics-export-enabled`) AND a
    // destination is set (`diagnostics-otlp-endpoint` / `OTEL_EXPORTER_OTLP_ENDPOINT`).
    // With the pref off this resolves to `None` — `Option<Layer>` is itself a
    // `Layer` whose `None` does nothing, so zero spans egress and the always-on
    // local sinks (stdout `fmt` + the `server/trace.rs` SQLite store) are untouched.
    // The provider is held for the process lifetime (leaked) so batched spans flush.
    let otel = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => crate::telemetry::build_otlp_layer(&prefs).await,
        Err(e) => {
            // No subscriber yet — eprintln so the failure is visible without spans.
            eprintln!("telemetry: could not open preferences store; OTLP export off: {e}");
            None
        }
    };
    let (otel_layer, otel_provider) = match otel {
        Some((layer, provider)) => (Some(layer), Some(provider)),
        None => (None, None),
    };

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "ryu_core=debug,info".into()))
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .init();

    // Keep the tracer provider alive for the whole process so the batch exporter
    // continues to flush; leaking is intentional (mirrors a process-global sink).
    if let Some(provider) = otel_provider {
        std::mem::forget(provider);
    }

    tracing::info!("Starting ryu-core v{}", env!("CARGO_PKG_VERSION"));

    // Crash reporting tier (#544, P3): init Sentry for PANICS ONLY, gated on the
    // `crash-reports-enabled` pref (a consent tier SEPARATE from product analytics)
    // AND a DSN env (`SENTRY_DSN`/`RYU_SENTRY_DSN`). With the pref off or no DSN
    // this is a true no-op. The guard is BOUND for the whole `main` (NOT leaked
    // like the OTel provider) so it flushes a pending panic event on shutdown;
    // dropping it early would tear down the transport before a panic could send.
    // PII-scrubbed in `before_send` (home-dir paths stripped, no PII, no hostname);
    // we never feed `tracing`/log events to Sentry, so prompt/agent content cannot
    // reach it. Restart-to-apply (Rust reads the pref once at boot).
    let _crash_guard = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => crate::crash::init(&prefs).await,
        Err(e) => {
            tracing::warn!("crash reporting: could not open preferences store; Sentry off: {e}");
            None
        }
    };

    // Mesh authkey scrub (#478, security HIGH V2): read `RYU_MESH_AUTHKEY` once
    // HERE — before ANY child process is spawned (gateway, headroom, onboarding,
    // sidecars all spawn later) — write it to a `0600` keyfile, and remove it from
    // this process's env. Otherwise the long-lived `tailscaled` daemon and every
    // ACP `npx`/gateway child would inherit the secret via `/proc/self/environ`.
    // The `tailscale up` enrollment in the sidecar reads the keyfile, not the env.
    crate::sidecar::tailscale::scrub_authkey_to_keyfile().await;

    // Clean up the `<exe>.old` backup left by a prior self-update, if any.
    crate::update::apply::cleanup_stale_backup();

    // Load the unified provider/model/strategy registry at startup so the
    // resolved defaults are visible in logs (env > ~/.ryu/registry.json > literal).
    {
        let reg = crate::registry::ProviderRegistry::load();
        tracing::info!(
            default_llm_base_url = %reg.default_llm_base_url,
            default_llm_model = %reg.default_llm_model,
            embed_model = %reg.embedder.id,
            embed_dims = reg.embedder.dims,
            reranker_model = %reg.reranker.id,
            providers_count = reg.providers.len(),
            strategies_count = reg.strategies.len(),
            "registry: loaded provider/model/strategy defaults"
        );
    }

    // Ensure ~/.ryu/bin is in PATH for binary execution
    if let Err(e) = sidecar::path_manager::PathManager::add_to_path() {
        tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
    }

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
        // oMLX — high-performance Apple-Silicon server (PATH-adopted, opt-in).
        Arc::new(OmlxManager::new()),
        // Docker Model Runner — adopt-only: Ryu downloads/spawns nothing, it just
        // routes to Docker's built-in OpenAI-compatible model server on :12434.
        Arc::new(DockerModelRunnerManager::new()),
        // apfel — Apple Foundation Models (Apple Silicon macOS 26+). Adopt-a-binary
        // (PATH/`brew`), serves Apple Intelligence as an OpenAI-compat local engine.
        // Registered on every platform so the catalog shows it (disabled) off a
        // supported Mac; the node-gate refuses to run/install it elsewhere.
        Arc::new(ApfelManager::new()),
        // Voice engines (STT/TTS) — opt-in, run alongside the resident chat engine.
        Arc::new(WhisperCppManager::new().with_downloads(download_center.clone())),
        Arc::new(ParakeetManager::new().with_downloads(download_center.clone())),
        Arc::new(OuteTtsManager::new().with_downloads(download_center.clone())),
        // Ryu TTS sidecar — universal multi-engine text-to-speech (Python runtime
        // fronting KittenTTS, Pocket TTS, …). Opt-in; NOT in startup_order — it
        // only starts once a user installs it or runs `bun run dev:tts`.
        Arc::new(RyuTtsManager::new().with_downloads(download_center.clone())),
        // Generative-media engine (text-to-image / -video) — opt-in, runs
        // alongside the resident chat engine (NOT in startup_order: diffusion
        // models are multi-GB, so it only starts once a user installs it).
        Arc::new(StableDiffusionManager::new().with_downloads(download_center.clone())),
        // Unsloth fine-tuning sidecar — Python LoRA/QLoRA training runtime. Opt-in;
        // NOT in startup_order — training is heavy + on-demand and needs a CUDA
        // GPU, so it only starts once a user installs it or runs `bun run dev:unsloth`.
        Arc::new(UnslothManager::new().with_downloads(download_center.clone())),
        // Tools
        Arc::new(SpiderManager::new()),
        // Autoresearch experiment runner (Python stdlib HTTP service). Opt-in;
        // NOT in startup_order — it only starts once a user installs it or runs
        // `python -m ryu_research` (adopt-mode) and the /api/research path or the
        // research__* tools reach it lazily.
        Arc::new(ResearchManager::new().with_downloads(download_center.clone())),
        Arc::new(LlmFit::new()),
        Arc::new(ShadowManager::new().with_downloads(download_center.clone())),
        Arc::new(GhostManager::new().with_downloads(download_center.clone())),
        // Agents
        Arc::new(ZeroClawManager::new().with_downloads(download_center.clone())),
        Arc::new(OpenClawManager::new()),
        Arc::new(HermesManager::new()),
        // Mesh daemon (Tailscale/Headscale, #478). Opt-in via RYU_MESH_ENABLED;
        // registered here so the catalog/install routes can reach it, but
        // deliberately NOT in `startup_order` — it never auto-starts.
        Arc::new(TailscaleManager::new().with_downloads(download_center.clone())),
    ];

    let startup_order = vec![
        // Tools first
        "spider".into(),
        "llmfit".into(),
        "shadow".into(),
        "ghost".into(),
        // Then providers
        "llamacpp".into(),
        // Embeddings server auto-starts so RAG has real embeddings on launch.
        "llamacpp-embed".into(),
        // Ryu TTS sidecar auto-starts when installed so the default TTS engine
        // (Kokoro 82M) is live out of the box. `start_all` skips it when it was
        // never provisioned (no venv / model), so this has no cost on nodes that
        // don't have the sidecar — TTS falls back to on-demand OuteTTS there.
        "ryutts".into(),
        "ollama".into(),
        "vllm".into(),
        "sglang".into(),
        "mlx".into(),
        // Docker Model Runner is adopt-only (never spawned/downloaded), but it
        // MUST be in startup_order: `seed_names = startup_order.clone()` drives
        // `seed_installed_from_disk`, so without it a persisted install would not
        // re-seed the installed set on restart. `start_all` skips non-resident
        // local engines, so listing it here has no spawn cost.
        "docker-model-runner".into(),
        // apfel (Apple Foundation Models). Like docker-model-runner it never
        // auto-spawns (`start_all` skips non-resident local engines), but it MUST
        // be in startup_order so `seed_installed_from_disk` re-seeds a persisted
        // install on restart — otherwise a Mac that chose Apple Intelligence would
        // lose the selection across Core restarts.
        "apfel".into(),
        // Finally agents
        "zeroclaw".into(),
        "openclaw".into(),
        // nanoclaw is deliberately NOT auto-started: it is a message-driven Node
        // orchestrator (its own WhatsApp/Telegram/Slack ingress) with no HTTP/ACP
        // endpoint for Core to health-check or route a chat turn to, so its
        // Sidecar::start() bails by design. Kept registered for the docker-sandbox
        // installer only; not a Ryu-routable agent (issue #509 abandoned).
        "picoclaw".into(),
        "nemoclaw".into(),
        "ironclaw".into(),
        "hermes".into(),
    ];

    // Keep the names so we can seed the installed set from disk before
    // `start_all` runs (see the `seed_installed_from_disk` call below).
    let seed_names = startup_order.clone();
    let sidecars = SidecarManager::new(all_sidecars, startup_order, Arc::clone(&setup));

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

    // Local ryu-gateway (data plane). Created before the server state so the
    // `/api/engine/active` swap endpoint can re-point the gateway's `local`
    // provider at the active engine after a swap (U19).
    let gateway = Arc::new(sidecar::gateway::GatewayManager::new());

    // Optional headroom compression proxy (M2 / #425). Started before the
    // gateway so it is reachable when the gateway's egress compression transform
    // (enabled in the same step) first runs. Off unless RYU_HEADROOM_ENABLED=1.
    let headroom = Arc::new(sidecar::headroom::HeadroomManager::new());

    // Start HTTP server for setup control
    let catalog = Arc::new(crate::catalog::CatalogManager::new());
    let auth_state = Arc::new(Mutex::new(auth::AuthState::new()));
    let agent_registry = Arc::new(AcpAgentRegistry::new());
    // Persisted agent config store (SQLite). Seeds the built-in registry agents
    // as durable rows so they survive a restart and stay selectable.
    let agent_store = match crate::agents::AgentStore::open(&agent_registry) {
        Ok(store) => store,
        Err(e) => panic!("failed to open agent store: {e:#}"),
    };
    // Persisted agent teams (collections of agents + a coordination strategy).
    let teams = match crate::teams::TeamStore::open() {
        Ok(store) => store,
        Err(e) => panic!("failed to open team store: {e:#}"),
    };
    let conversations = match server::conversations::ConversationStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open conversation store: {e:#}"),
    };
    // Semantic message index backing the `search_conversations` builtin tool.
    // Opened best-effort: if the vec0 index can't be created, conversations still
    // work (search just returns no index). Wired into the store so append-on-write
    // indexing + lazy-backfill search are available.
    let conversations = match server::message_index::MessageIndex::open_default() {
        Ok(index) => conversations.with_message_index(index),
        Err(e) => {
            tracing::warn!("message index unavailable; search_conversations disabled: {e:#}");
            conversations
        }
    };
    // Full-text (FTS5) message index backing the FTS session-search recall layer.
    // Opened best-effort (fail-open, same as the semantic index): if the FTS table
    // can't be created, conversations still work — the FTS recall source just
    // returns no index. Population is lazy-on-search and default-OFF, so wiring the
    // index here materializes nothing until a user opts into FTS recall.
    let conversations = match server::message_fts::MessageFtsIndex::open_default() {
        Ok(index) => conversations.with_message_fts_index(index),
        Err(e) => {
            tracing::warn!("fts message index unavailable; fts session search disabled: {e:#}");
            conversations
        }
    };
    let memory = match server::memory::MemoryStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open memory store: {e:#}"),
    };
    let spaces = match server::spaces::SpaceStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open spaces store: {e:#}"),
    };
    let retrieval = match server::retrieval::RetrievalStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open retrieval store: {e:#}"),
    };
    let media = match server::media::MediaStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open media store: {e:#}"),
    };
    let traces = match server::trace::TraceStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open trace store: {e:#}"),
    };
    let preferences = match server::preferences::PreferencesStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open preferences store: {e:#}"),
    };
    // Local support-access diagnostic channel (#546, P5): the append-only audit
    // log, plus the startup auto-disable sweep. Re-checking the hard expiry HERE
    // (a real write, not just a read-time gate) is what makes the AC's "auto-
    // disable when expired + survives a restart" true — a grant whose expiry has
    // passed is flipped off in the prefs before any request can use it.
    let support_audit = match support_access::SupportAccessStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open support-access audit store: {e:#}"),
    };
    match support_access::sweep_expired(&preferences).await {
        Ok(true) => tracing::info!("support-access: expired local grant auto-disabled at startup"),
        Ok(false) => {}
        Err(e) => tracing::warn!("support-access: startup expiry sweep failed: {e:#}"),
    }
    // Load any user-configured Hugging Face token into the in-process resolver so
    // gated model search + downloads authenticate without an env var or restart.
    if let Ok(Some(token)) = preferences.get(hf_auth::HF_TOKEN_PREF_KEY).await {
        hf_auth::set_token(&token);
    }
    // Same for the Composio API key: load it into the in-process resolver so the
    // gateway (spawned below) inherits `COMPOSIO_API_KEY` and enables its tool
    // loop, and the composio_catalog browse endpoints authenticate.
    if let Ok(Some(key)) = preferences
        .get(composio_auth::COMPOSIO_API_KEY_PREF_KEY)
        .await
    {
        composio_auth::set_key(&key);
    }
    // Same for the OpenRouter API key (A4 / #501): load it into the in-process
    // resolver so the gateway (spawned below) inherits `OPENROUTER_API_KEY` and
    // activates its `openrouter` provider. On a managed node the operator sets
    // this once (env/pref) and every end user gets OpenRouter with zero setup.
    if let Ok(Some(key)) = preferences
        .get(openrouter_auth::OPENROUTER_API_KEY_PREF_KEY)
        .await
    {
        openrouter_auth::set_key(&key);
    }
    // Same for the cloud media provider keys (Replicate / Fal): load them into
    // their in-process resolvers so the gateway inherits `REPLICATE_API_KEY` /
    // `FAL_API_KEY` and activates its `replicate` / `fal` media providers.
    if let Ok(Some(key)) = preferences
        .get(replicate_auth::REPLICATE_API_KEY_PREF_KEY)
        .await
    {
        replicate_auth::set_key(&key);
    }
    if let Ok(Some(key)) = preferences.get(fal_auth::FAL_API_KEY_PREF_KEY).await {
        fal_auth::set_key(&key);
    }
    // Node entitlement gate (#496): seed the in-process flag so the scheduler
    // pauses autonomous automation when the desktop's trial has hard-expired
    // with no subscription/license. Absent ⇒ default-ON (headless / OSS Core /
    // still-entitled desktop run automations normally).
    if let Ok(Some(v)) = preferences
        .get(entitlement::ENTITLEMENT_ACTIVE_PREF_KEY)
        .await
    {
        entitlement::set_active(&v);
    }
    // Same for the Artificial Analysis API key, which enriches the model catalog
    // with independent benchmark stats (intelligence/speed/price).
    if let Ok(Some(key)) = preferences
        .get(model_catalog::aa::AA_API_KEY_PREF_KEY)
        .await
    {
        model_catalog::aa::set_key(&key).await;
    }
    // And the AA fetch mode (cached daily cache vs. realtime). Defaults to cached
    // when unset, so the rate-limited API is hit at most once a day out of the box.
    if let Ok(Some(mode)) = preferences.get(model_catalog::aa::AA_MODE_PREF_KEY).await {
        model_catalog::aa::set_mode(&mode);
    }
    // Claude Code gateway-routing toggle: seed the in-process flag so the (sync)
    // ACP spawn path injects `ANTHROPIC_BASE_URL` only when the user opted in.
    // Off by default — it changes how the subscription credential flows.
    if let Ok(Some(value)) = preferences
        .get(claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        claude_config::set_enabled(&value);
    }
    // Untrusted-content wrapping toggle: external/tool RESULTS re-entering the
    // model are boundary-wrapped + chat-template-token-stripped. Default-ON (safe:
    // only untrusted tool output, never user text); seed only to honour an
    // explicit opt-OUT persisted by the desktop.
    if let Ok(Some(value)) = preferences
        .get(sidecar::untrusted::UNTRUSTED_WRAPPING_PREF_KEY)
        .await
    {
        sidecar::untrusted::set_enabled(&value);
    }
    // Codex gateway-routing toggle (subscription passthrough). Same opt-in story
    // as Claude: seed the in-process flag so the (sync) ACP spawn path points the
    // Codex subprocess at an isolated CODEX_HOME → gateway passthrough only when
    // the user opted in.
    if let Ok(Some(value)) = preferences
        .get(codex_config::CODEX_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        codex_config::set_enabled(&value);
    }
    // Generic per-agent gateway-routing toggles (the "point any agent at the
    // gateway via the OpenAI base-URL swap" feature). One pref holds a JSON map of
    // agent id → enabled; seed the in-process map so the (sync) ACP spawn path
    // injects OPENAI_BASE_URL only for the agents the user opted in.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        agent_routing::set_from_json(&value);
    }
    // Apply the user's saved default embedding model (if any) to the Spaces store,
    // re-indexing in the background when it differs from what the store opened with.
    spaces.apply_saved_embedding_pref(&preferences).await;
    // App manifests: wrapped in RwLock so self-build tools can hot-install new
    // apps without restarting Core (U57). The self-build tools write into this
    // store and `GET /api/apps` reads from it; no restart required.
    let app_manifests = Arc::new(tokio::sync::RwLock::new(
        crate::plugin_manifest::PluginManifestLoader::load(),
    ));
    let app_store = match crate::plugins::PluginStore::open() {
        Ok(store) => store,
        Err(e) => panic!("failed to open app store: {e:#}"),
    };

    // Seed gateway egress compression from the headroom plugin's persisted state
    // (#425, policy-driven). The plugin's enabled flag is the single source of
    // truth: if it is installed, its state wins (so a Core/gateway restart never
    // silently reverts what the plugin set); otherwise the `RYU_HEADROOM_ENABLED`
    // dev seed (read lazily by `headroom::is_enabled`) stands. This runs before
    // the headroom proxy + gateway are spawned below, so both see the right state.
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::headroom::HEADROOM_PLUGIN_ID)
        .await
    {
        crate::sidecar::headroom::set_enabled(rec.enabled);
        // Also seed the data-driven compression policy (service URL/token/timeout/
        // min) from the plugin manifest, so a restart preserves the configured
        // service — not just the on/off flag. Find the compression Policy runnable
        // in the headroom manifest and parse its `definition`.
        if rec.enabled {
            if let Some(def) = crate::plugin_manifest::PluginManifestLoader::load()
                .iter()
                .find(|m| m.id == crate::sidecar::headroom::HEADROOM_PLUGIN_ID)
                .and_then(|m| {
                    m.runnables
                        .iter()
                        .filter(|r| r.kind == crate::runnable::RunnableKind::Policy)
                        .filter_map(|r| r.config.as_ref())
                        .filter_map(|c| {
                            serde_json::from_value::<crate::plugin_manifest::schema::PolicyConfig>(
                                c.clone(),
                            )
                            .ok()
                        })
                        .find(|c| c.policy_type == "compression")
                        .map(|c| c.definition)
                })
            {
                crate::sidecar::headroom::set_compression_policy(
                    crate::sidecar::headroom::CompressionPolicy::from_definition(&def),
                );
            }
        }
    }
    // Seed the gateway-policy plugin flags (#447) from their persisted enabled
    // state, exactly like headroom above: if the firewall/routing plugin is
    // installed, its stored enabled flag wins so a gateway restart never reverts
    // what the user set; otherwise the dev env seed (GATEWAY_FIREWALL_ENABLED /
    // GATEWAY_SMART_ROUTING_ENABLED, read lazily) stands. Runs before the gateway
    // is spawned so `gateway_spawn_env` reads the right state.
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::gateway_policy::FIREWALL_PLUGIN_ID)
        .await
    {
        crate::sidecar::gateway_policy::set_firewall_enabled(rec.enabled);
    }
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::gateway_policy::ROUTING_PLUGIN_ID)
        .await
    {
        crate::sidecar::gateway_policy::set_routing_enabled(rec.enabled);
    }
    // Two-tier registry default-on seeding (#444): Core-tier plugins flagged
    // default-on (`CORE_DEFAULT_ON`, e.g. the local engines plugin) are seeded
    // INSTALLED + ENABLED on a fresh install. The seed is one-time and respects a
    // user's explicit choice: it only acts when there is NO prior record for the
    // plugin (a record present — enabled OR disabled — always wins), so a user who
    // later disables a Core plugin keeps it disabled across restarts. Community
    // plugins are never auto-seeded (install-then-enable opt-in).
    for &plugin_id in crate::plugins::builtins::CORE_DEFAULT_ON {
        match app_store.get(plugin_id).await {
            Ok(Some(_)) => {} // record exists — user choice wins, do not re-seed.
            Ok(None) => {
                // Resolve the manifest version for the install record.
                let version = {
                    let manifests = app_manifests.read().await;
                    manifests
                        .iter()
                        .find(|m| m.id == plugin_id)
                        .map(|m| m.version.clone())
                };
                if let Some(version) = version {
                    if let Err(e) = app_store.insert(plugin_id, &version).await {
                        tracing::warn!("core-tier seed: insert '{plugin_id}' failed: {e}");
                    } else if let Err(e) = app_store.set_enabled(plugin_id, &[]).await {
                        tracing::warn!("core-tier seed: enable '{plugin_id}' failed: {e}");
                    } else {
                        tracing::info!("core-tier seed: enabled default-on plugin '{plugin_id}'");
                    }
                }
            }
            Err(e) => tracing::warn!("core-tier seed: lookup '{plugin_id}' failed: {e}"),
        }
    }
    // Agent Skill registry (M3 / issue #145). Loads from the universal Agent
    // Skills directory `~/.claude/skills/<id>/SKILL.md` (overridable via
    // `RYU_SKILLS_DIR`), the same location Claude Code and the skills CLI read.
    // A missing directory is not an error — Core runs without skills until the user
    // installs any. Skills are injected into outgoing chat requests by the adapter.
    let skill_registry = crate::skills::SkillRegistry::load();

    // Wire self-build context into the MCP registry (U57). The registry holds
    // Arc references to the manifest store and app store so scaffold_runnable /
    // install_app / write_ryu_json can hot-install without a process restart.
    let mcp_registry = Arc::new(
        sidecar::mcp::McpRegistry::load()
            .with_self_build(Arc::clone(&app_manifests), Arc::new(app_store.clone()))
            // Wire the agent store so the `agent_builder` tools can edit agent
            // records in chat (the desktop agent-edit page's builder pane).
            .with_agent_store(agent_store.clone())
            // Wire the conversation store so the `search_conversations` built-in
            // tool can run semantic search over past chat messages.
            .with_conversations(conversations.clone())
            // Wire the skill registry so the `skills` built-in tools can discover +
            // load Agent Skills on demand (progressive disclosure).
            .with_skills(skill_registry.clone())
            // Wire the preferences store so the built-in `advisor` tool resolves
            // the configured `advisor-model` (the stronger reviewer model).
            .with_preferences(preferences.clone()),
    );

    // Website-monitoring engine (#456 monitoring feature). Opens its own SQLite
    // store and reuses the MCP registry (for the Spider fetch backend) + a shared
    // HTTP client. Published as a process-global so the state-free scheduler can
    // run a monitor when its `JobTarget::Monitor` job fires.
    let monitor_store = match crate::monitors::store::MonitorStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open monitors store: {e:#}"),
    };
    let monitor_engine = crate::monitors::MonitorEngine::new(
        monitor_store,
        Arc::clone(&mcp_registry),
        reqwest::Client::new(),
    );
    crate::monitors::set_global_engine(monitor_engine.clone());

    // Meeting-notes engine (Granola/Notion-AI style). Opens its own SQLite store
    // and reuses a shared HTTP client for transcription proxy, gateway note-gen,
    // and driving device-local Shadow capture. Published as a process-global so
    // off-`ServerState` callers (Shadow control, future scheduled summaries) reach
    // it. Audio capture itself is a device-bound sensor and lives in Shadow.
    let meeting_store = match crate::meetings::store::MeetingStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open meetings store: {e:#}"),
    };
    let meeting_engine = crate::meetings::MeetingEngine::new(meeting_store, reqwest::Client::new());
    crate::meetings::set_global_engine(meeting_engine.clone());

    // Hardware device registry (RHP v1, PROTOCOL.md §6): paired watch/necklace/
    // desk devices + their revocable per-device tokens + presence. Opens its own
    // SQLite store (`~/.ryu/hardware.db`). Read by the `/api/hardware/*` REST
    // surface and the `/api/hardware/ws` realtime handler.
    let hardware_store = match crate::hardware::store::DeviceStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open hardware device registry: {e:#}"),
    };

    // Quests engine (auto-detecting todo list). Opens its own SQLite store and
    // reuses the MCP registry (for Shadow context), a shared HTTP client (for the
    // gateway judge call), and the preferences store (for the detection mode +
    // judge model). Published as a process-global so the state-free scheduler can
    // run a quest's detection pass when its `JobTarget::Quest` job fires.
    let quest_store = match crate::quests::store::QuestStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open quests store: {e:#}"),
    };
    let quest_engine = crate::quests::QuestEngine::new(
        quest_store,
        Arc::clone(&mcp_registry),
        reqwest::Client::new(),
        preferences.clone(),
    );
    crate::quests::set_global_engine(quest_engine.clone());

    // Home dashboards engine (customizable live widget grid). Opens its own SQLite
    // store and reuses a shared HTTP client for loopback Core self-calls (curated
    // endpoint widgets), the Gateway (Composio widgets), and external GETs (HTTP
    // widgets). Published as a process-global and driven by a dashboard-owned
    // refresh loop that re-resolves each due widget and broadcasts fresh values
    // over SSE — skipping expensive sources when no client is watching.
    let dashboard_store = match crate::dashboard::store::DashboardStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open dashboards store: {e:#}"),
    };
    let dashboard_engine =
        crate::dashboard::DashboardEngine::new(dashboard_store, reqwest::Client::new());
    crate::dashboard::set_global_engine(dashboard_engine.clone());
    crate::dashboard::refresh::spawn(dashboard_engine.clone());
    // Live display nudge for hardware: when a device-bound dashboard's data changes,
    // push the RHP `display` re-poll signal to that device's live WS so the desk
    // e-ink reflects edits promptly (TRMNL push-to-refresh; review gap #4). Cost-
    // guarded — only connected devices are nudged, and per-device debounced.
    crate::hardware::nudge::spawn(dashboard_engine.clone(), hardware_store.clone());

    // Approval inbox (human-in-the-loop). Opens its own SQLite store and reuses a
    // shared HTTP client (mobile Expo push) + the monitors store's registered
    // push tokens, so a phone learns about a pending decision while away. Published
    // as a process-global so the state-free scheduler and the workflow executor can
    // raise requests when a `require_approval` job fires or an `Awakeable` gate
    // suspends. A background sweep expires stale pending requests.
    let approval_store = match crate::approvals::store::ApprovalStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open approvals store: {e:#}"),
    };
    let approval_engine =
        crate::approvals::ApprovalEngine::new(approval_store, reqwest::Client::new())
            .with_monitors(monitor_engine.store.clone())
            .with_registry(Arc::clone(&mcp_registry))
            .with_preferences(preferences.clone())
            .with_skills(skill_registry.clone());
    crate::approvals::set_global_engine(approval_engine.clone());
    {
        let sweep_engine = approval_engine.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                if let Err(e) = sweep_engine.sweep_expired().await {
                    tracing::warn!("approvals: expiry sweep failed: {e:#}");
                }
            }
        });
    }

    // Unified activity feed. Opens its own SQLite store (`~/.ryu/activity.db`) and
    // aggregates every producing engine's events into one cross-module timeline via
    // background subscribe-loops (`crate::activity::ingest`). Records *what happened*
    // ⇒ Core; nothing about it is policy. Wired sources: monitors + quests +
    // approvals + meetings (all four expose a broadcast bus); the manual POST
    // endpoint keeps the slice testable regardless.
    let activity_store = match crate::activity::ActivityStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open activity store: {e:#}"),
    };
    crate::activity::ingest::spawn(
        activity_store.clone(),
        &monitor_engine,
        &quest_engine,
        &approval_engine,
        &meeting_engine,
    );

    // Identity Vault (#517): crypto-sealed per-domain agent connections. Opens its
    // own SQLite store under ~/.ryu/identities.db and is published as a
    // process-global so off-`ServerState` callers — the health-check loop and the
    // shared elicitation seam (later units) — reach it without threading it
    // through. Credential state is sealed via `crypto::global_cipher()`.
    match crate::identity::IdentityStore::open() {
        Ok(store) => {
            crate::identity::set_global(store.clone());
            // Publish the health-check engine (#524) and ensure its single
            // backing scheduler job so the sweep rides the same tick loop as
            // monitors. The engine resolves each connection's backend from the
            // per-domain `CredentialSourceRegistry` (default `manual`, env
            // overridable) and flips stale `AUTHENTICATED` connections back to
            // `NEEDS_AUTH`. The interval is the swappable
            // `RYU_IDENTITY_HEALTH_INTERVAL` env knob.
            let registry = crate::identity::CredentialSourceRegistry::from_env();
            let health_engine = crate::identity::health::HealthEngine::new(store, registry);
            crate::identity::health::set_global_engine(health_engine);
            if let Err(e) = ensure_identity_health_job() {
                tracing::warn!("identity health job not scheduled: {e}");
            }
        }
        Err(e) => tracing::warn!("identity store unavailable: {e:#}"),
    }

    // Ensure the single continual-learning cycle job exists so it rides the
    // scheduler tick loop. It no-ops unless the user opted in (and, if configured,
    // only fires inside the sleep window), so scheduling it is always safe.
    if let Err(e) = ensure_learning_cycle_job() {
        tracing::warn!("learning cycle job not scheduled: {e}");
    }

    // Publish the MCP registry globally so the workflow `Tool` node can invoke
    // tools (the executor is a free function with no ServerState handle).
    crate::sidecar::mcp::set_global_registry(Arc::clone(&mcp_registry));
    // Plugin-owned KV storage (the plugin turn-hook runtime's `storage:kv`
    // capability). Published as a process-global so the sandbox bridge reaches it
    // without threading through ServerState. Best-effort: a plugin's `host.storage`
    // call surfaces a clean error if the store could not open.
    match crate::plugin_storage::PluginStorage::open_default() {
        Ok(store) => crate::plugin_storage::set_global(store),
        Err(e) => tracing::warn!("plugin storage unavailable: {e:#}"),
    }
    // Composio event-trigger store: registers trigger instances with Composio and
    // fires the bound agent when the webhook arrives. Published as a process-global
    // so the webhook + CRUD handlers reach it without threading through ServerState.
    match crate::composio_triggers::ComposioTriggerStore::open(reqwest::Client::new()) {
        Ok(store) => crate::composio_triggers::set_global(store),
        Err(e) => tracing::warn!("composio triggers store unavailable: {e:#}"),
    }

    // Per-run worktree diff cache, shared by the chat path and the off-chat agent
    // runner. Built once here so both `ServerState` and the runner hold the same
    // handle (a per-run diff captured during a workflow agent turn is visible to
    // the chat surfaces too).
    let worktree_diffs: crate::server::WorktreeDiffStore =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    // Publish the global agent runner so off-chat callers (workflow `Prompt`
    // nodes, the scheduler's `JobTarget::Agent`, Composio triggers) can invoke
    // the *configured* agent through the real chat path instead of POSTing a bare
    // prompt to the gateway. Built from the same store handles `ServerState` holds.
    crate::sidecar::agent_runner::set_global_agent_runner(
        crate::sidecar::agent_runner::AgentRunner::new(
            Arc::clone(&agent_registry),
            conversations.clone(),
            agent_store.clone(),
            Arc::clone(&sidecars),
            memory.clone(),
            Arc::clone(&worktree_diffs),
            Arc::clone(&mcp_registry),
            skill_registry.clone(),
            traces.clone(),
        ),
    );

    // Clone the conversation + preferences stores (both cheap Arc-backed handles)
    // for the opt-in cross-device sync loop before they move into ServerState.
    let sync_conversations = conversations.clone();
    let sync_preferences = preferences.clone();

    // Auto-rename (ChatGPT/Claude-style): the store sends each conversation that
    // gets its first user message on this channel; the consumer (spawned below,
    // once `ServerState` exists) asks the default local model for a concise title.
    let (auto_title_tx, auto_title_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // Room-keyed realtime fan-out registry (Phase 1). Built ONCE here and shared
    // (Clone is Arc-backed) between the conversation store — which publishes a live
    // `Events` frame on every persisted turn — and `ServerState` below, which the
    // `/api/realtime/ws` handler subscribes against. Both MUST be the same instance
    // or publishes reach a registry no socket is listening to.
    let realtime = crate::realtime::RoomRegistry::new();
    let conversations = conversations
        .with_auto_title(auto_title_tx)
        .with_realtime(realtime.clone());

    // Authoritative CRDT document engine (Phase 3). Backed by `~/.ryu/collab.db`
    // (an append-only update log + compacted snapshots), keyed by document id.
    // Driven by the `kind:"document"` path of `/api/realtime/ws`. Built ONCE here
    // and shared (Clone is Arc-backed) into `ServerState` below so every socket
    // resolves the same in-memory replica per live document.
    let collab = crate::collab::DocRegistry::new(Arc::new(
        crate::collab::CollabStore::open_default().expect("opening collab.db"),
    ));

    // Fine-tuning job store (Unsloth integration). Durable record of fine-tune
    // jobs; the training itself runs in the opt-in `unsloth` sidecar.
    let finetune_store = match crate::finetune::FinetuneStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open finetune store: {e:#}"),
    };

    // Experience buffer (continual-learning loop). Durable record of captured
    // (user, assistant) turns + PRM scores; populated by sweeping conversations
    // at cycle time, consumed by the reward-filtered retrain.
    let experience_store = match crate::experience::ExperienceStore::open_default() {
        Ok(store) => store,
        Err(e) => panic!("failed to open experience store: {e:#}"),
    };

    let server_state = server::ServerState {
        setup: Arc::clone(&setup),
        manager: Arc::clone(&sidecars),
        install_status: Arc::clone(&install_status),
        catalog,
        client: reqwest::Client::new(),
        auth: Arc::clone(&auth_state),
        agents: Arc::clone(&agent_registry),
        agent_store,
        teams,
        conversations,
        memory,
        mcp: mcp_registry,
        spaces,
        media,
        gateway: Arc::clone(&gateway),
        headroom: Arc::clone(&headroom),
        retrieval,
        worktree_diffs: Arc::clone(&worktree_diffs),
        app_manifests,
        app_store,
        catalog_client: Arc::new(crate::plugins::catalog::PluginCatalogClient::new()),
        skills: skill_registry,
        app_contrib: crate::plugins::app_contrib::AppContribRegistry::new(),
        traces,
        preferences,
        support_audit,
        catalog_sources: Arc::new(crate::catalog_source::CatalogSourceRegistry::new()),
        downloads: download_center.clone(),
        monitors: monitor_engine,
        meetings: meeting_engine,
        quests: quest_engine,
        dashboards: dashboard_engine,
        approvals: approval_engine,
        activity: activity_store,
        mesh: crate::mesh::MeshHandle::new(),
        connections: crate::connections::ConnectionRegistry::new(),
        hardware: hardware_store,
        // Room-keyed realtime fan-out registry (Phase 1). Production tunables
        // (5-min hibernation, 30s presence TTL). Already Arc-backed, cloned into
        // each request via `ServerState`.
        realtime,
        // Authoritative CRDT document engine (Phase 3). Same instance the
        // `kind:"document"` realtime path applies/persists/rebroadcasts against.
        collab,
        finetune: finetune_store,
        experience: experience_store,
        // Captured for the public `/api/realtime/ws` handler's in-handler node
        // token enforcement (the public router has no `auth_token` Extension).
        // Same env source the protected router resolves below.
        node_token: std::env::var("RYU_TOKEN").ok(),
    };
    // Publish the state for the scheduler's continual-learning job (it has no
    // `State` extractor), mirroring the monitor/quest/identity-health engines.
    crate::learning::set_global_state(server_state.clone());
    // Self-healing loop: watch the run-status bus and diagnose/propose fixes for
    // failed runs (auto-apply or queue to the approvals inbox, per `healing.*`).
    crate::healing::HealEngine::new(server_state.clone()).spawn();
    let auth_token = std::env::var("RYU_TOKEN").ok();

    // Fire the `onStartup` activation event (#443) now that `ServerState` exists.
    // This is the live runtime driver behind the plugin activation contract: every
    // enabled plugin is run through `register_active` against the fired-event
    // snapshot, so eager plugins activate unconditionally and a plugin gated on
    // `onStartup` wakes here. Spawned (not awaited) so a slow registration never
    // delays the listener bind. onChat/onCommand are data-wiring follow-ons that
    // call the same `fire_activation_event` driver from the chat/palette paths.
    {
        let startup_state = server_state.clone();
        tokio::spawn(async move {
            crate::server::fire_activation_event(&startup_state, "onStartup").await;
        });
    }

    // Background auto-rename consumer: drains conversation ids whose first user
    // message just landed and titles each with the default local model.
    {
        let title_state = server_state.clone();
        tokio::spawn(async move {
            crate::server::auto_title::run_auto_title_loop(title_state, auto_title_rx).await;
        });
    }

    // Resolve the bind address ONCE (the same chain the listener uses below) and
    // hand it to the fail-closed gate so a `--bind=0.0.0.0` flag cannot bypass the
    // RYU_BIND-only check (#478 V1).
    let bind_addr = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("--bind="))
        .and_then(|a| a.strip_prefix("--bind=").map(str::to_string))
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_else(|| "127.0.0.1:7980".to_string());

    let router = server::create_router(server_state, auth_token, &bind_addr);

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Another Core instance is already running on this address — treat as success.
            tracing::info!("ryu-core already running on {bind_addr}, exiting");
            std::process::exit(0);
        }
        Err(e) => panic!("failed to bind {bind_addr}: {e}"),
    };

    tracing::info!(
        "HTTP server listening on {}",
        listener.local_addr().unwrap()
    );

    // Start the optional headroom compression proxy before the gateway so it is
    // reachable when the gateway's compression transform first runs. Best-effort
    // and fully graceful: disabled by default, and a missing binary just leaves
    // compression inactive (the gateway passes requests through uncompressed).
    {
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

    // Start the local ryu-gateway (data plane) so Core hands every model call
    // it makes to the gateway, which forwards to the engine/provider (U18).
    // Runs in the background: a missing/unhealthy gateway must not block the
    // Core HTTP API from coming up — chat requests surface a clear error.
    {
        let gateway_ref = Arc::clone(&gateway);
        tokio::spawn(async move {
            match gateway_ref.start().await {
                Ok(true) => tracing::info!("gateway: ready on {}", sidecar::gateway::gateway_url()),
                Ok(false) => {}
                Err(e) => tracing::error!(
                    "gateway: failed to start ({e}); Core chat will return an error until a gateway is available"
                ),
            }
        });
    }

    // Webhook ingress seam (#479, P6a): build the configured ingress backend
    // (default RyuRelay; pref `webhook.ingress.backend`; env override
    // `RYU_WEBHOOK_INGRESS_URL` ⇒ OwnRelay), start it, and cache its public URL
    // for `GET /api/webhook-ingress/status`. Tunnels point Composio at Core's
    // existing `POST /api/composio/webhook` (composio_triggers fires unchanged).
    // Runs after composio_triggers::set_global so a future RyuRelay push loop can
    // dispatch in-process. Best-effort: a backend that cannot start (no public
    // URL, mesh off, Phase-6b) just leaves the public URL unset — never blocks Core.
    {
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

    // Start the scheduled-job tick loop (reloads jobs from disk so schedules
    // survive a Core restart).
    scheduler::Scheduler::new().spawn();

    // Start the opt-in cross-device conversation sync loop (M10). A no-op every
    // tick until the user opts in (env `RYU_SYNC_ENABLED` or the
    // `cloud-sync-enabled` pref). OFF by default per the local-first rule, so
    // this never alters default behaviour or blocks startup.
    server::sync::spawn_sync_loop(sync_conversations, sync_preferences);

    // Resolve the hierarchy-scoped tool set from the control plane (U30) when a
    // gateway key is configured. This narrows the local config-driven MCP
    // registry (U13) to what the org/team/project has granted. Best-effort: a
    // missing key means local-only mode, and a resolve failure must not block
    // Core from coming up — chat still works with the local registry.
    {
        let cp_client = reqwest::Client::new();
        tokio::spawn(async move {
            match sidecar::control_plane::resolve_scope(&cp_client).await {
                Ok(None) => tracing::info!(
                    "control-plane: no gateway key (RYU_GATEWAY_KEY) set; using local MCP registry only"
                ),
                Ok(Some(scope)) => {
                    let mcp = scope.allowed_slugs("mcp");
                    let composio = scope.allowed_slugs("composio");
                    tracing::info!(
                        mcp = ?mcp,
                        composio = ?composio,
                        grant_scoped_composio = scope.has_grant_scoped_composio(),
                        "control-plane: resolved {} granted tool(s) for this gateway scope",
                        scope.tools.len()
                    );
                }
                Err(e) => tracing::warn!(
                    "control-plane: registry resolution failed ({e}); falling back to local MCP registry"
                ),
            }
        });
    }

    // Managed-node registration (A4 / #501): on a node flagged
    // `RYU_MANAGED_NODE`, bind this node to its org via the gateway key so usage
    // attributes to the right wallet (the credits debit resolves the same org).
    // Best-effort: a non-managed install or a missing key is a no-op, and a
    // resolve failure logs a warning but never blocks Core from coming up.
    {
        let cp_client = reqwest::Client::new();
        tokio::spawn(async move {
            match sidecar::control_plane::register_managed_node(&cp_client).await {
                Ok(None) => {}
                Ok(Some(org)) => tracing::info!(
                    org_id = %org.id,
                    org = %org.name,
                    "control-plane: managed node registered; usage attributes to this org"
                ),
                Err(e) => tracing::warn!(
                    "control-plane: managed-node registration failed ({e}); node not org-bound until it succeeds"
                ),
            }
        });
    }

    // Auto-install the local inference stack (llama.cpp binary + GGUF model)
    // on first run. Idempotent: LlamaCppDownloader and GgufDownloader both
    // check for existing files on disk before downloading. The desktop polls
    // GET /api/catalog to track progress; it must not trigger this itself.
    {
        let setup_ref = Arc::clone(&setup);
        let install_status_ref = Arc::clone(&install_status);
        // The default chat + embedding GGUFs download through the global
        // DownloadCenter (#456), so they stream to disk and show in the overlay.
        let downloads_ref = download_center.clone();
        tokio::spawn(async move {
            let stack = setup_ref.install_local_stack(&downloads_ref).await;
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
            // Surface the default-installed tool apps (agentbrowser, spider,
            // shadow, ghost, llmfit) as "installed" in the catalog. The catalog's
            // install_state is read from InstallStatusStore, so onboarding's
            // SetupManager mark alone is not enough — seed both. shadow + ghost
            // are built into Core (MCP registry); the rest are managed sidecars.
            for tool in ["agentbrowser", "spider", "shadow", "ghost", "llmfit"] {
                if !setup_ref.is_installed(tool).await {
                    setup_ref.mark_installed(tool).await;
                }
                install_status_ref
                    .set_installed(tool, "builtin".to_string())
                    .await;
            }
        });
    }

    // Ensure the default ACP agent (acp:pi by default, overridable via
    // RYU_DEFAULT_AGENT / registry.json) is installed on first run (U041 AC1).
    // Runs in the background so Core's HTTP API is not blocked by the npx
    // install. Non-fatal: failure is logged as a warning, not a panic.
    {
        let setup_ref = Arc::clone(&setup);
        tokio::spawn(async move {
            setup_ref.ensure_default_agent_installed().await;
        });
    }

    // Seed the installed set from the persisted `versions.json` BEFORE starting
    // sidecars. `install_local_stack` + `start_all` are spawned concurrently, so
    // without this `start_all` can win the race and skip the already-on-disk
    // resident local engine (`llamacpp`) for the whole session — leaving the
    // gateway with no provider and hanging every chat through it (e.g. `ryu`).
    // Awaited (not spawned) so the seed is in place before `start_all` reads it.
    setup.seed_installed_from_disk(&seed_names).await;

    // Start sidecars in background (only installed ones will actually start)
    let sidecars_ref = Arc::clone(&sidecars);
    tokio::spawn(async move {
        if let Err(e) = sidecars_ref.start_all().await {
            tracing::error!("sidecar startup failed: {e}");
        }
    });

    // Begin sampling per-engine memory/CPU for the node selector's engine list.
    // Cheap (refreshes only the known sidecar PIDs every couple seconds); the
    // numbers ride the existing `/api/sidecar/status` poll.
    sidecars.spawn_resource_sampler();

    // Serve HTTP API. `into_make_service_with_connect_info` threads the peer
    // `SocketAddr` so `/api/realtime/ws` can distinguish a genuine loopback peer
    // (the local single user) from a remote holder of the shared `RYU_TOKEN` when
    // deciding access to unpersisted rooms. Handlers that don't extract
    // `ConnectInfo` are unaffected — it is a superset of the plain make-service.
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("server error");
}

/// Ensure the single Identity Vault health-check scheduled job exists (#524).
///
/// Unlike monitors (one backing job per monitor, created in the monitors CRUD
/// API), the health sweep validates *all* connections, so it is one fixed-id
/// job ensured at startup. Idempotent: re-running rewrites the same `id`,
/// re-baking the current [`crate::identity::health::interval_setting`] into the
/// schedule while preserving the existing execution history. The scheduler
/// re-reads jobs from disk every tick, so this needs no ordering relative to
/// the scheduler spawn.
fn ensure_identity_health_job() -> Result<(), String> {
    use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

    const JOB_ID: &str = "identity-health";

    let interval = crate::identity::health::interval_setting();
    let now = chrono::Utc::now().to_rfc3339();
    let existing = job_store::load_job(JOB_ID).ok();
    let job = ScheduledJob {
        id: JOB_ID.to_owned(),
        name: "identity vault health check".to_owned(),
        schedule: Schedule::Every {
            interval: interval.clone(),
        },
        target: JobTarget::IdentityHealth,
        enabled: true,
        require_approval: false,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    job_store::save_job(&job).map_err(|e| e.to_string())
}

/// Ensure the single continual-learning cycle job exists (MetaClaw-style periodic
/// retrain). Ticks hourly (default; `RYU_LEARNING_INTERVAL` knob) so it reliably
/// catches the configured sleep window, but the job body no-ops unless the user
/// opted in, only fires inside the window, and a persisted min-gap keeps it to at
/// most one retrain per ~day (and prevents fire-on-every-restart). Mirrors
/// [`ensure_identity_health_job`].
fn ensure_learning_cycle_job() -> Result<(), String> {
    use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

    const JOB_ID: &str = "learning-cycle";

    let interval = std::env::var("RYU_LEARNING_INTERVAL").unwrap_or_else(|_| "1h".to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let existing = job_store::load_job(JOB_ID).ok();
    let job = ScheduledJob {
        id: JOB_ID.to_owned(),
        name: "continual-learning cycle".to_owned(),
        schedule: Schedule::Every { interval },
        target: JobTarget::LearningCycle,
        enabled: true,
        require_approval: false,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    job_store::save_job(&job).map_err(|e| e.to_string())
}
