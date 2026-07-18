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
mod collab_host;
mod composio_host;
// Composio integration orchestration lives in the extracted `ryu-composio`
// crate; these aliases keep the in-tree `crate::composio_*` call sites unchanged.
// The workflow/agent-engine fan-out (`run_workflow_for_trigger`/`run_agent`)
// stays in Core as `composio_host` (kernel glue).
pub(crate) use ryu_composio::auth as composio_auth;
pub(crate) use ryu_composio::catalog as composio_catalog;
pub(crate) use ryu_composio::connect as composio_connect;
pub(crate) use ryu_composio::triggers as composio_triggers;
mod connections;
mod crash;
mod crypto_host;
mod memory_host;
mod dashboards_client;
mod data_path;
mod downloads;
mod entitlement;
mod events;
mod exec_approval;
mod fal_auth;
mod hardware;
mod hf_auth;
mod identity;
mod image_host;
mod sandbox_host;
mod healing_client;
mod identity_verify;
mod inference;
mod learning;
/// Re-export shim: the MCP server catalog primitive now lives in the
/// `ryu-mcp-catalog` crate. Consumers reference
/// `crate::mcp_catalog::{ServerJson, InstallPlan, plan_from_server, …}`
/// unchanged; the crate's one cross-cutting kernel coupling (the SSRF-guarded
/// registry fetch) inverts through [`mcp_catalog_host`].
pub use ryu_mcp_catalog as mcp_catalog;
mod mcp_catalog_host;
mod meetings_client;
mod mesh_host;
/// Re-export shim: the Hugging Face model catalog + device-fit primitive now
/// lives in the `ryu-model-catalog` crate. Consumers reference
/// `crate::model_catalog::{ModelCard, install_from_descriptor, device, …}`
/// unchanged; the crate's cross-cutting kernel couplings invert through
/// [`model_catalog_host`].
pub use ryu_model_catalog as model_catalog;
mod model_catalog_host;
/// Re-export shim: the model weight-format primitive (`ModelFormat` + the pure
/// format→engine capability tables) now lives in the `ryu-model-format` crate.
/// Consumers reference `crate::model_format::{ModelFormat, engines_for_format, …}`
/// unchanged.
pub use ryu_model_format as model_format;
mod monitors_client;
mod native_history;
mod notify;
/// Re-export shim: the Open Knowledge Format (OKF) primitive now lives in the
/// `ryu-knowledge` crate. Consumers reference `crate::okf::{Bundle, Concept, …}`
/// unchanged.
pub use ryu_knowledge as okf;
mod openrouter_auth;
mod paths;
mod profile;
mod pi_config;
mod plugin_host;
mod plugin_manifest;
mod rtk_config;
mod plugin_storage;
mod policy_alerts;
mod smtp_auth;
mod plugins;
mod predict;
mod predict_host;
mod privacy;
mod quests_client;
mod rag_host;
mod recipes_client;
mod recipes_host;
mod registry;
mod replicate_auth;
mod runnable;
mod sandbox;
mod scheduler;
mod search_host;
mod self_api;
mod server;
mod stt_host;
mod sidecar;
mod skills_catalog;
mod skills_host;
mod finetune_client;
mod stats_beacon;
mod support_access;
mod system_info;
mod teams_client;
mod telemetry;
mod tool_exec;
mod tool_registry_host;
mod update;
mod usage_host;
mod voice;
mod webhook_ingress;
mod webhook_ingress_host;
mod win_process;
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
        sglang::SglangManager, vllm::VllmManager,
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

/// Report an unrecoverable boot failure as a clean one-line message on stderr and
/// exit non-zero — instead of `panic!`, which dumps a Rust backtrace that reads as a
/// crash to a user. Used only for the fail-fast boot paths in `main` (opening a data
/// store, binding the listen socket), where the process genuinely cannot continue but
/// the cause (port already in use, corrupt/locked data file) is an operator condition,
/// not a bug. Expands to `!` so it drops into `match`/`unwrap_or_else` arms unchanged.
macro_rules! boot_fail {
    ($($arg:tt)*) => {{
        eprintln!("ryu-core: {}", format_args!($($arg)*));
        std::process::exit(1);
    }};
}

#[tokio::main]
async fn main() {
    // Emit the OpenAPI spec and exit — keeps stdout clean (before tracing init)
    // so `ryu-core --dump-openapi > core-openapi.json` is well-formed. The spec
    // is static (derived from handler annotations), so no server state is needed.
    if std::env::args().any(|a| a == "--dump-openapi") {
        // `api_doc()` folds in the feature-gated leaf sub-docs (research/clips/
        // recipes) so the dumped spec matches what `GET /api/openapi.json` serves.
        let spec = crate::server::openapi::api_doc();
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

    // RYU_PROFILE stack isolation: seed the profile-derived env defaults (data
    // dir, core bind, gateway URL + config, Shadow URL, embed/rerank URLs) BEFORE
    // anything caches a path/port or resolves the data dir. No-op on the default
    // `release` profile, and any env var the user already set wins. The matching
    // sidecar SPAWN ports are threaded through `profile::port` in `sidecar/**`.
    crate::profile::apply_env_defaults();

    // Install the crypto host BEFORE any store opens (the first `global_cipher()`
    // caller is `ConversationStore::open_default` further down). This inverts the
    // extracted `ryu-crypto` primitive's two kernel couplings — profile-scoped
    // keychain suffix + `~/.ryu` dir — back into Core. Unconditional: crypto is a
    // non-optional dep (memory/chat encrypt every row in every build).
    crate::crypto_host::install();

    // Install the collab host so the extracted `ryu-collab` primitive can resolve
    // the `~/.ryu` data dir for `collab.db`. Unconditional and BEFORE the first
    // `CollabStore::open_default` below: collab is a non-optional dep (`ServerState`
    // holds a `DocRegistry` in every build).
    crate::collab_host::install();

    // Install the mesh host so the extracted `ryu-mesh` primitive can reach the
    // `tailscale`/`tailscaled` shell-outs (the "what runs" half of the mesh) when
    // the mesh is enabled. Unconditional: mesh is a non-optional dep (the
    // fail-closed startup gate reads `is_enabled()`/placeholder-check in every
    // build); the enabled-side entry points short-circuit before the host is
    // consulted on the default mesh-off install.
    crate::mesh_host::install();

    // Install the downloads host BEFORE any artifact fetch can run. This inverts
    // the extracted `ryu-downloads` primitive's three kernel couplings — the
    // `~/.ryu` data dir, the version-store checksum-skip, and Hugging Face auth —
    // back into Core. Unconditional: downloads is a non-optional dep (the sidecar
    // loader, model catalog, engines, and marketplace install all fetch through it).
    crate::downloads::install();

    // Install the VAD host so the extracted `ryu-vad` primitive can resolve its one
    // kernel coupling — the active `~/.ryu` data dir the Silero VAD model lives
    // under. Unconditional: VAD is a per-frame hot-path primitive the voice session
    // drives per uplink hop, and `silero_download_spec()` (onboarding) resolves the
    // model dest through this host.
    crate::voice::vad::install();

    // Install the model-catalog host so the extracted `ryu-model-catalog`
    // primitive can resolve its five kernel couplings — the `~/.ryu` data dir, HF
    // bearer auth, the per-node engine-support gate, the bundled default-model
    // repos, and the active-model preference. Unconditional: the catalog routes
    // are mounted in every build. Only reachable over HTTP, so it is never
    // consulted before this boot-time install.
    crate::model_catalog_host::install();

    // Install the MCP-catalog host so the extracted `ryu-mcp-catalog` primitive
    // can reach its one kernel coupling — the SSRF-guarded registry fetch
    // (`server::guarded_get_bytes`). Unconditional: the MCP catalog routes are
    // mounted in every build. Only reachable over HTTP, so it is never consulted
    // before this boot-time install.
    crate::mcp_catalog_host::install();

    // Install the usage host so the extracted `ryu-usage` primitive can resolve
    // the Ryu-isolated `CODEX_HOME` (the last `auth.json` candidate the Codex
    // reader probes). Unconditional: usage is a non-optional dep (the
    // `GET /api/agents/:id/usage` route is mounted in every build). Poll-driven,
    // so it is never on a hot path; the reader skips the candidate if unset.
    crate::usage_host::install();

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

    // Hand the extracted `ryu-tool-exec` sandbox crate Core's single-source
    // security scrubbers (untrusted-marker strip + child-env scrub) so the PTC
    // sandbox never runs with drift-prone duplicates. Idempotent; safe before any
    // request-path sandbox use.
    tool_exec::install_tool_exec_host_hooks();

    // Hand the extracted `ryu-sandbox` crate Core's host couplings (Gateway
    // metering url/bearer, ryu-dir for the persisted default backend, the
    // registered org id, and the preferences-backed default run budget) so the
    // sandbox metering + backend selection stay single-source with Core.
    // Idempotent; safe before any request-path sandbox use.
    sandbox_host::install_sandbox_host();

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
        // (The Unsloth fine-tuning sidecar is no longer Core-managed — it is a
        // manifest-declared managed sidecar OWNED by the `com.ryu.finetune` app,
        // started on plugin-enable + boot-reconcile. Core keeps NO in-process finetune
        // code: the `ryu-finetune` sidecar owns the store, the adapter catalog, the
        // worker HTTP client, and the `/api/finetune/*` surface; Core reaches only its
        // `host.finetune_*` bridge over loopback via `finetune_client`.)
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

    // Mail runs as the `com.ryu.mail` app: the generic sidecar loader spawns the
    // out-of-process `ryu-mail` binary and proxies `/api/mail/*` to it via the
    // manifest's `public_mount` (Track C). No hand-coded MailManager here anymore.

    // Start HTTP server for setup control
    let catalog = Arc::new(crate::catalog::CatalogManager::new());
    let auth_state = Arc::new(Mutex::new(auth::AuthState::new()));
    let agent_registry = Arc::new(AcpAgentRegistry::new());
    // Persisted agent config store (SQLite). Seeds the built-in registry agents
    // as durable rows so they survive a restart and stay selectable.
    let agent_store = match crate::agents::AgentStore::open(&agent_registry) {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open agent store: {e:#}"),
    };
    // Persisted agent teams (collections of agents + a coordination strategy) now
    // live OUT-OF-PROCESS in the `ryu-teams` sidecar (single owner of `teams.db`).
    // Core reaches them over loopback via `TeamsClient`, constructed below once the
    // manifests are loaded (so the sidecar port resolves from the manifest, not a
    // hardcoded constant).
    let conversations = match server::conversations::ConversationStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open conversation store: {e:#}"),
    };
    // Semantic message index backing the `search_conversations` builtin tool.
    // Opened best-effort: if the vec0 index can't be created, conversations still
    // work (search just returns no index). Wired into the store so append-on-write
    // indexing + lazy-backfill search are available.
    let conversations = match search_host::open_default_message_index() {
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
    let conversations = match search_host::open_default_message_fts() {
        Ok(index) => conversations.with_message_fts_index(index),
        Err(e) => {
            tracing::warn!("fts message index unavailable; fts session search disabled: {e:#}");
            conversations
        }
    };
    let memory = match memory_host::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open memory store: {e:#}"),
    };
    let spaces = match server::spaces::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open spaces store: {e:#}"),
    };
    // Ensure the default, undeletable "Artifacts" system space exists — where chat
    // artifacts and agent-generated files (pptx/xlsx/csv/pdf/html/png) are filed.
    if let Err(e) = spaces
        .ensure_system_space("Artifacts", Some("Files created by Ryu and agents"))
        .await
    {
        tracing::warn!("failed to ensure Artifacts system space: {e:#}");
    }
    // The "Clips" system space seed moved out with the clips capability: clips is now
    // the out-of-process `com.ryu.clips` sidecar and no longer links into the kernel,
    // so there is no in-process `CLIPS_SPACE_NAME/DESC` seed here. (Auto-filing a clip
    // into that Space is a `ClipsHost` coupling the standalone sidecar degrades
    // cleanly — see `apps-store/clips/backend/src/main.rs`.)
    // Ensure the "Canvas" system space and import any legacy file-store boards into
    // it as `com.ryu.canvas` app documents (the built-in creative canvas was ported
    // to a Ryu App; see `server::canvas_migrate`). Idempotent — migrated files are
    // renamed so a restart never re-imports them.
    match spaces
        .ensure_system_space("Canvas", Some("Node-based creative canvases"))
        .await
    {
        Ok(space_id) => {
            server::canvas_migrate::migrate_legacy_canvases(&spaces, &space_id).await;
        }
        Err(e) => tracing::warn!("failed to ensure Canvas system space: {e:#}"),
    }
    // Ensure the "Whiteboard" system space where `com.ryu.whiteboard` app documents
    // (freeform boards) live. Unlike Canvas there is no legacy file-store to import,
    // so just ensure the space. Idempotent.
    if let Err(e) = spaces
        .ensure_system_space("Whiteboard", Some("Freeform whiteboards"))
        .await
    {
        tracing::warn!("failed to ensure Whiteboard system space: {e:#}");
    }
    let retrieval = match rag_host::open_retrieval_store() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open retrieval store: {e:#}"),
    };
    let media = match server::media::MediaStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open media store: {e:#}"),
    };
    // Default-path choice stays Core-side wiring; the crate takes an explicit
    // path (`ryu-tracing` has zero dependency on apps/core).
    let traces = match ryu_tracing::TraceStore::open(crate::paths::ryu_dir().join("traces.db")) {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open trace store: {e:#}"),
    };
    let preferences = match server::preferences::PreferencesStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open preferences store: {e:#}"),
    };
    // Local support-access diagnostic channel (#546, P5): the append-only audit
    // log, plus the startup auto-disable sweep. Re-checking the hard expiry HERE
    // (a real write, not just a read-time gate) is what makes the AC's "auto-
    // disable when expired + survives a restart" true — a grant whose expiry has
    // passed is flipped off in the prefs before any request can use it.
    let support_audit = match support_access::SupportAccessStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open support-access audit store: {e:#}"),
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
    // Load the user's capability→provider binding overrides into the active
    // BindingConfig so capability resolution (enable/disable/broker) honours them
    // from boot, not only after the first PUT /api/capabilities/bindings.
    if let Ok(Some(json)) = preferences
        .get(plugins::binding::BINDING_OVERRIDES_PREF_KEY)
        .await
    {
        plugins::binding::set_active_config(plugins::binding::config_from_overrides_json(&json));
    }
    // Load the BYO SMTP transport (non-secret host/port/username/from/starttls)
    // and password into the in-process email sink so self-host alert/inbox email
    // works without an env var or restart. Both are prefs-first, env-fallback.
    // Secret custody stays kernel-side: the extracted `ryu-email-send` sink resolves
    // the password through this injected hook over Core's `smtp_auth` store. Wire it
    // before any alert can fire.
    ryu_email_send::set_password_resolver(smtp_auth::password);
    if let Ok(Some(json)) = preferences
        .get(ryu_email_send::SMTP_TRANSPORT_PREF_KEY)
        .await
    {
        ryu_email_send::apply_transport_prefs_json(&json);
    }
    if let Ok(Some(password)) = preferences.get(smtp_auth::SMTP_PASSWORD_PREF_KEY).await {
        smtp_auth::set_password(&password);
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
    // RTK per-agent auto-wrap (rtk plugin, Phase 2): seed each agent's wrap flag and
    // reconcile its RTK PreToolUse hook (install when on, uninstall when off). A
    // no-op when rtk is not on PATH; best-effort so a slow/failed `rtk init` never
    // blocks the rest of boot.
    rtk_config::seed_and_apply(&preferences).await;
    // Command-approval gate: seed `RYU_EXEC_APPROVAL_MODE` from the pref so every
    // ACP agent's native tool calls (Claude/Codex `Bash`/`Write`/`Edit`) are
    // scanned at the `request_permission` seam. Off by default; seeded once here
    // (before request threads) so there is no concurrent env race — restart to
    // apply, like the crash/OTLP prefs.
    if let Ok(Some(value)) = preferences
        .get(exec_approval::EXEC_APPROVAL_MODE_PREF_KEY)
        .await
    {
        exec_approval::seed_from_pref(&value);
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
    // Per-agent Plane A model-routing overrides (spec §1). One pref holds a JSON
    // map of agent id → SmartRoutingConfig; seed the in-process map so the (async)
    // chat-forward path can inject `ryu_smart_route` for agents that have one.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_SMART_ROUTE_PREF_KEY)
        .await
    {
        agent_routing::set_smart_routes_from_json(&value);
    }
    // Plane B agent-auto routing config (spec §2). Seed the in-process snapshot so
    // resolving the "auto" sentinel to a concrete agent needs no pref-store handle.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_AUTO_ROUTING_PREF_KEY)
        .await
    {
        agent_routing::set_auto_config_from_json(&value);
    }
    // Apply the user's saved default embedding model (if any) to the Spaces store,
    // re-indexing in the background when it differs from what the store opened with.
    server::spaces::apply_saved_embedding_pref(&spaces, &preferences).await;
    // App manifests: wrapped in RwLock so self-build tools can hot-install new
    // apps without restarting Core (U57). The self-build tools write into this
    // store and `GET /api/apps` reads from it; no restart required.
    let app_manifests = Arc::new(tokio::sync::RwLock::new(
        crate::plugin_manifest::PluginManifestLoader::load(),
    ));
    // Loopback client for the out-of-process `ryu-teams` sidecar (single owner of
    // `teams.db`). Port resolved from the just-loaded manifests, profile-shifted.
    let teams = crate::teams_client::TeamsClient::new(crate::teams_client::sidecar_port(
        &*app_manifests.read().await,
    ));
    // Loopback client for the out-of-process `ryu-finetune` sidecar (single owner of
    // `finetune.db` + the Python `unsloth` worker). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `teams`.
    let finetune = crate::finetune_client::FinetuneClient::new(
        crate::finetune_client::sidecar_port(&*app_manifests.read().await),
    );
    // Loopback client for the out-of-process `ryu-quests` sidecar (single owner of
    // `quests.db` + the detection engine). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `finetune`/`teams`. Published as
    // a process-global so the scheduler (`JobTarget::Quest`) and the MCP quest-board
    // widget can reach it without `ServerState`.
    let quests = crate::quests_client::QuestsClient::new(crate::quests_client::sidecar_port(
        &*app_manifests.read().await,
    ));
    crate::quests_client::set_global_client(quests.clone());
    // Loopback client for the out-of-process `ryu-monitors` sidecar (single owner of
    // `monitors.db` + the monitor engine). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `quests`. Published as a
    // process-global so the scheduler (`JobTarget::Monitor`) can reach it without
    // `ServerState`; the reconcile loop is spawned once `activity`/`ServerState` exist.
    let monitors = crate::monitors_client::MonitorsClient::new(
        crate::monitors_client::sidecar_port(&*app_manifests.read().await),
    );
    crate::monitors_client::set_global_client(monitors.clone());
    // Loopback client for the out-of-process `ryu-dashboards` sidecar (single owner
    // of `dashboards.db` + the refresh loop + the `/api/dashboards/*` surface). Port
    // resolved from the just-loaded manifests, profile-shifted — same posture as
    // `monitors`. Published as a process-global so the state-free `dashboard_builder`
    // MCP runnable can reach it; also backs the kernel hardware device-dashboard
    // renderer + nudge loop through the `ryu_hardware::DashboardFeed` seam.
    let dashboards = crate::dashboards_client::DashboardsClient::new(
        crate::dashboards_client::sidecar_port(&*app_manifests.read().await),
    );
    crate::dashboards_client::set_global_client(dashboards.clone());
    // Loopback client for the out-of-process `ryu-meetings` sidecar (single owner of
    // `meetings.db` + the engine/audio pipeline + the `/api/meetings/*` surface). Port
    // resolved from the just-loaded manifests, profile-shifted — same posture as
    // `dashboards`. Backs the kernel hardware ambient-audio path through the
    // `ryu_hardware::MeetingIngest` seam; the activity-feed fold is spawned once
    // `activity`/`ServerState` exist.
    let meetings = crate::meetings_client::MeetingsClient::new(
        crate::meetings_client::sidecar_port(&*app_manifests.read().await),
    );
    // Resolve the `ryu-healing` sidecar port now, while `app_manifests` is still in
    // scope (it is moved into `ServerState` below); the healing client is built
    // later, once `server_state` exists.
    let healing_sidecar_port =
        crate::healing_client::sidecar_port(&*app_manifests.read().await);
    let app_store = match crate::plugins::PluginStore::open() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open app store: {e:#}"),
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
    // Seed system-wide predictive typing from the Predict plugin's persisted
    // enabled state (opt-in, Core-tier): installing/enabling the plugin is the
    // single on/off switch, so a restart must preserve it before
    // `/api/predict/complete` first reads `predict::is_enabled()`. No record
    // (never installed) ⇒ stays off (the AtomicBool default).
    if let Ok(Some(rec)) = app_store.get(crate::predict::PREDICT_PLUGIN_ID).await {
        crate::predict::set_enabled(rec.enabled);
    }
    // Default-on plugin seeding (#444) — the ONE definition lives in
    // `plugins::seed`. It seeds every `CORE_DEFAULT_ON` plugin INSTALLED +
    // ENABLED on a fresh install (the three companions with their grants +
    // prebuilt `ui_code` bundle, everything else with empty grants), in
    // DEPENDENCY ORDER, and refuses to enable a plugin whose `requires` cannot be
    // satisfied from the default-on set.
    //
    // It writes the store directly rather than calling `lifecycle::enable_app`
    // because the Gateway is not spawned until further below and `enable_app`
    // fails closed on an unreachable Gateway — routing the seed through it would
    // disable every default-on plugin on every fresh install. The dependency
    // GRAPH is still honoured (see the module docs); only the Gateway grant call
    // is bypassed, for a fixed first-party grant set.
    //
    // One-time and user-respecting: a plugin with any existing record (enabled OR
    // disabled) is left alone, so a user's disable survives restarts.
    {
        let manifests = app_manifests.read().await.clone();
        crate::plugins::seed::seed_default_on(&app_store, &manifests).await;
    }
    // Agent Skill registry (M3 / issue #145). Loads from the universal Agent
    // Skills directory `~/.claude/skills/<id>/SKILL.md` (overridable via
    // `RYU_SKILLS_DIR`), the same location Claude Code and the skills CLI read.
    // A missing directory is not an error — Core runs without skills until the user
    // installs any. Skills are injected into outgoing chat requests by the adapter.
    // Publish the Ryu data folder to the extracted `ryu_skills` crate BEFORE
    // `SkillRegistry::load()`, whose `ensure_active_set_seeded` + `migrate_legacy_skills`
    // touch `~/.ryu` — so they resolve against the real (possibly relocated) folder,
    // not the crate's `$RYU_DIR`/`~/.ryu` fallback.
    ryu_skills::set_data_dir(crate::paths::ryu_dir());
    let skill_registry = ryu_skills::SkillRegistry::load();

    // Per-run worktree diff cache, shared by the chat path and the off-chat agent
    // runner. Built once here so both `ServerState`, the runner, and the in-process
    // `ryu.worktree` app (via the MCP registry below) hold the same handle (a
    // per-run diff captured during a workflow agent turn is visible to chat too).
    let worktree_diffs: crate::server::WorktreeDiffStore =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    // Wire self-build context into the MCP registry (U57). The registry holds
    // Arc references to the manifest store and app store so scaffold_runnable /
    // install_app / write_ryu_json can hot-install without a process restart.
    let mcp_registry = Arc::new(
        sidecar::mcp::McpRegistry::load()
            .with_self_build(Arc::clone(&app_manifests), Arc::new(app_store.clone()))
            // Wire the agent store so the `agent_builder` tools can edit agent
            // records in chat (the desktop agent-edit page's builder pane).
            .with_agent_store(agent_store.clone())
            // Wire the teams sidecar client so `agent_builder__create_agent_team`
            // can mint a roster of agents and persist them as a reusable team over
            // loopback HTTP (the sidecar owns the store).
            .with_teams_client(teams.clone())
            // Wire the conversation store so the `search_conversations` built-in
            // tool can run semantic search over past chat messages.
            .with_conversations(conversations.clone())
            // Wire the skill registry so the `skills` built-in tools can discover +
            // load Agent Skills on demand (progressive disclosure).
            .with_skills(skill_registry.clone())
            // Wire the preferences store so the built-in `advisor` tool resolves
            // the configured `advisor-model` (the stronger reviewer model).
            .with_preferences(preferences.clone())
            // Wire the per-run worktree diff store so the in-process `ryu.worktree`
            // app can resolve a run's diff and apply/discard it (widget callTool).
            .with_worktree_diffs(Arc::clone(&worktree_diffs))
            // Wire the Spaces store so the built-in `artifact__create` tool can save
            // agent-generated files into a Space (default: the Artifacts space).
            .with_spaces(spaces.clone()),
    );

    // Website-monitoring engine (#456 monitoring feature). Opens its own SQLite
    // store and reuses the MCP registry (for the Spider fetch backend) + a shared
    // HTTP client. Published as a process-global so the state-free scheduler can
    // run a monitor when its `JobTarget::Monitor` job fires.
    // Kernel notification-delivery store (adjudicated NOT-a-capability): the
    // app-inbox feed, push tokens, policy-alert dedupe, and node-level alert
    // delivery targets. Stays compiled into Core and keeps serving
    // notifications_api / policy_alerts / workflow / approvals even once the
    // monitor engine moves out-of-process. Published as a process-global so the
    // state-free scheduler + workflow executor + policy-alert deliverer reach it.
    let notify_store = match crate::notify::NotifyStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open notify store: {e:#}"),
    };
    crate::notify::set_global_store(notify_store.clone());

    // Website monitors now run OUT-OF-PROCESS: the `ryu-monitors` sidecar owns
    // `monitors.db` + the engine + the `/api/monitors/*` surface (served via the
    // manifest `public_mount`). Core reaches it over loopback via the `monitors`
    // client built above; the scheduler run (`JobTarget::Monitor`) and the backing-job
    // reconcile are wired through `monitors_client::spawn`, and the sidecar's Spider
    // fetch + alert fan-out reach BACK into Core via the ext-bearer host callbacks in
    // `monitors_client`. Core links NO monitor code.

    // (Mail's store lives in the out-of-process `ryu-mail` sidecar now — Track C.)

    // Meeting notes run OUT-OF-PROCESS: the `ryu-meetings` sidecar owns `meetings.db`,
    // the engine + audio/diarize pipeline, and the `/api/meetings/*` surface (served to
    // the desktop through the ext-proxy `public_mount`). Core links NO meeting code; it
    // reaches the sidecar over loopback via the `meetings` client built above. The
    // Spaces note-filing coupling moved to the `save-notes` host callback
    // (`meetings_client::host_save_notes`), so notes still land in the "Meetings" Space
    // under the background owner.

    // Hardware device registry (RHP v1, PROTOCOL.md §6): paired watch/necklace/
    // desk devices + their revocable per-device tokens + presence. Opens its own
    // SQLite store (`~/.ryu/hardware.db`). Read by the `/api/hardware/*` REST
    // surface and the `/api/hardware/ws` realtime handler.
    // The registry moved to the extracted `ryu_hardware` crate; the host computes
    // the db path (`~/.ryu/hardware.db`) and injects it at open (the crate never
    // reaches Core's `paths` module).
    let hardware_store =
        match ryu_hardware::DeviceStore::open(crate::paths::ryu_dir().join("hardware.db")) {
            Ok(store) => store,
            Err(e) => boot_fail!("failed to open hardware device registry: {e:#}"),
        };

    // Quests (auto-detecting todo list) now runs OUT-OF-PROCESS: the `ryu-quests`
    // sidecar owns `quests.db` + the detection engine. Core reaches it over loopback
    // via the `quests` client built above; the scheduler judge, the `JobTarget::Quest`
    // job reconcile, and the activity feed are wired through `quests_client::spawn`.

    // Recipes host (ghost-os record→replay), from the extracted `ryu_recipes`
    // crate. Installed UNCONDITIONALLY — the workflow executor's `Recipe`/
    // `GhostAction` nodes call `ryu_recipes::run` in every build (kernel), so the
    // host must be present even in the lean kernel (only the HTTP routes are
    // feature-gated). The shim carries the two live-ghost couplings the crate can't
    // own: the shared MCP registry (replay) and the dedicated recording subprocess.
    ryu_recipes::set_global_host(std::sync::Arc::new(crate::recipes_host::CoreRecipesHost));

    // Install the webhook-ingress host BEFORE any ingress code runs (the ingress
    // start task below, and the public webhook routes in `server/mod.rs`, both
    // reach the extracted `ryu-webhook-ingress` engine through this seam). The
    // shim carries the kernel couplings the crate can't own (composio verify/run,
    // workflow-secret lookup, mesh Funnel, auth token, data dir).
    ryu_webhook_ingress::set_global_host(std::sync::Arc::new(
        crate::webhook_ingress_host::CoreWebhookIngressHost,
    ));

    // Home dashboards run OUT-OF-PROCESS: the `ryu-dashboards` sidecar owns
    // `dashboards.db`, the refresh loop, and the `/api/dashboards/*` surface (served
    // to the desktop through the ext-proxy `public_mount`). Core links NO dashboard
    // code; it reaches the sidecar over loopback via the `dashboards` client built
    // above. The `CoreDashboardsHost` (Composio/agent/HTTP widget couplings) moved to
    // the sidecar's own host impl — Agent/HTTP widgets degrade out-of-process until a
    // broker-back hop lands (documented in the sidecar).
    //
    // Live display nudge for hardware: when a device-bound dashboard's data changes,
    // push the RHP `display` re-poll signal to that device's live WS so the desk
    // e-ink reflects edits promptly (TRMNL push-to-refresh; review gap #4). Cost-
    // guarded — only connected devices are nudged, per-device debounced. The nudge
    // loop now consumes the sidecar's `/events` SSE (as an internal, non-viewer
    // subscriber) through the `DashboardFeed` seam, reconnecting across a restart.
    ryu_hardware::nudge::spawn(std::sync::Arc::new(dashboards.clone()), hardware_store.clone());

    // Approval inbox (human-in-the-loop). Opens its own SQLite store and reuses a
    // shared HTTP client (mobile Expo push) + the kernel notify store's registered
    // push tokens, so a phone learns about a pending decision while away. Published
    // as a process-global so the state-free scheduler and the workflow executor can
    // raise requests when a `require_approval` job fires or an `Awakeable` gate
    // suspends. A background sweep expires stale pending requests.
    let approval_store = match crate::approvals::store::ApprovalStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open approvals store: {e:#}"),
    };
    let approval_engine =
        crate::approvals::ApprovalEngine::new(approval_store, reqwest::Client::new())
            .with_push_store(notify_store.clone())
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
    // `open` takes an explicit path — the default-path choice (`~/.ryu/activity.db`)
    // stays Core-side wiring so the `ryu-activity` crate has zero apps/core dep.
    let activity_store =
        match ryu_activity::ActivityStore::open(crate::paths::ryu_dir().join("activity.db")) {
            Ok(store) => store,
            Err(e) => boot_fail!("failed to open activity store: {e:#}"),
        };
    crate::activity::ingest::spawn(activity_store.clone(), &approval_engine);
    // Meetings → activity. Meetings is out-of-process (`ryu-meetings` sidecar): Core
    // folds the sidecar's `/api/meetings/stream` SSE into the activity store (the
    // dep-free successor to the old in-process `MeetingEvent` subscribe-loop).
    crate::meetings_client::spawn(meetings.clone(), activity_store.clone());
    // Quests → activity + `JobTarget::Quest` job lifecycle. Quests is out-of-process
    // (`ryu-quests` sidecar): Core folds the sidecar's `/api/quests/events` SSE into
    // the activity store and reconciles the backing scheduler jobs from the quest
    // list on a background loop.
    crate::quests_client::spawn(quests.clone(), activity_store.clone());
    // Monitors → `JobTarget::Monitor` job lifecycle. Monitors is out-of-process
    // (`ryu-monitors` sidecar): Core reconciles the backing scheduler jobs from the
    // monitor list on a background loop. Alert fan-out + activity arrive over the
    // `monitors_client` host-alert callback, not a spawned loop.
    crate::monitors_client::spawn(monitors.clone());

    // Identity Vault (#517): crypto-sealed per-domain agent connections. Opens its
    // own SQLite store under ~/.ryu/identities.db and is published as a
    // process-global so off-`ServerState` callers — the health-check loop and the
    // shared elicitation seam (later units) — reach it without threading it
    // through. Credential state is sealed via `ryu_crypto::global_cipher()`.
    match crate::identity::IdentityStore::open(crate::paths::ryu_dir()) {
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
    match crate::plugin_storage::open_default() {
        Ok(store) => crate::plugin_storage::set_global(store),
        Err(e) => tracing::warn!("plugin storage unavailable: {e:#}"),
    }
    // Composio event-trigger store: registers trigger instances with Composio and
    // fires the bound agent when the webhook arrives. Published as a process-global
    // so the webhook + CRUD handlers reach it without threading through ServerState.
    // Install Core's ComposioHost (workflow/agent run fan-out) before publishing
    // the store, so a webhook that arrives during startup can fire.
    crate::composio_host::install();
    match crate::composio_triggers::ComposioTriggerStore::open(
        reqwest::Client::new(),
        crate::paths::ryu_dir().join("composio-triggers.db"),
    ) {
        Ok(store) => crate::composio_triggers::set_global(store),
        Err(e) => tracing::warn!("composio triggers store unavailable: {e:#}"),
    }

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
    // Clone the preferences handle for the opt-in anonymous community-savings
    // beacon (OFF by default) before `preferences` moves into ServerState below.
    let stats_preferences = preferences.clone();

    // Auto-rename (ChatGPT/Claude-style): the store sends each conversation that
    // gets its first user message on this channel; the consumer (spawned below,
    // once `ServerState` exists) asks the default local model for a concise title.
    let (auto_title_tx, auto_title_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // Room-keyed realtime fan-out registry (Phase 1). Built ONCE here and shared
    // (Clone is Arc-backed) between the conversation store — which publishes a live
    // `Events` frame on every persisted turn — and `ServerState` below, which the
    // `/api/realtime/ws` handler subscribes against. Both MUST be the same instance
    // or publishes reach a registry no socket is listening to.
    let realtime = ryu_realtime::RoomRegistry::new();
    let conversations = conversations
        .with_auto_title(auto_title_tx)
        .with_realtime(realtime.clone());

    // Authoritative CRDT document engine (Phase 3). Backed by `~/.ryu/collab.db`
    // (an append-only update log + compacted snapshots), keyed by document id.
    // Driven by the `kind:"document"` path of `/api/realtime/ws`. Built ONCE here
    // and shared (Clone is Arc-backed) into `ServerState` below so every socket
    // resolves the same in-memory replica per live document.
    let collab = ryu_collab::DocRegistry::new(Arc::new(
        ryu_collab::CollabStore::open_default()
            .unwrap_or_else(|e| boot_fail!("failed to open collab store: {e:#}")),
    ));

    // Fine-tuning is now OUT-OF-PROCESS: the `ryu-finetune` sidecar owns `finetune.db`
    // + the adapter catalog + the Python `unsloth` worker, and serves `/api/finetune/*`
    // via the manifest `public_mount`. Core reaches its one reverse-coupling (the
    // `host.finetune_*` plugin-host bridge) over loopback through the `finetune`
    // client constructed above — no in-process store is opened here.

    // Experience buffer (continual-learning loop). Durable record of captured
    // (user, assistant) turns + PRM scores; populated by sweeping conversations
    // at cycle time, consumed by the reward-filtered retrain.
    // The experience buffer now lives in the extracted `ryu-learning` crate; point
    // it at the SAME `~/.ryu` data dir Core resolves before opening `experience.db`.
    ryu_learning::init_data_dir(crate::paths::ryu_dir());
    let experience_store = match ryu_learning::ExperienceStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open experience store: {e:#}"),
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
        meetings,
        quests,
        dashboards,
        approvals: approval_engine,
        activity: activity_store,
        mesh: ryu_mesh::MeshHandle::new(),
        connections: crate::connections::ConnectionRegistry::new(),
        hardware: hardware_store,
        // Room-keyed realtime fan-out registry (Phase 1). Production tunables
        // (5-min hibernation, 30s presence TTL). Already Arc-backed, cloned into
        // each request via `ServerState`.
        realtime,
        // Authoritative CRDT document engine (Phase 3). Same instance the
        // `kind:"document"` realtime path applies/persists/rebroadcasts against.
        collab,
        finetune,
        experience: experience_store,
        // Captured for the public `/api/realtime/ws` handler's in-handler node
        // token enforcement (the public router has no `auth_token` Extension).
        // Same env source the protected router resolves below.
        node_token: std::env::var("RYU_TOKEN").ok(),
    };
    // Publish the state for the scheduler's continual-learning job (it has no
    // `State` extractor), mirroring the monitor/quest/identity-health engines.
    crate::learning::set_global_state(server_state.clone());
    // Install the process-global plugin-hook dispatcher so off-chat-path phases
    // (pre/post tool use, subagent stop, session end, notification) can fire hooks
    // from code that has no `ServerState` in scope. Mirrors plugin_storage::global.
    crate::server::install_global_hook_dispatcher(server_state.clone());
    // Self-healing: the diagnose→propose ENGINE runs out-of-process in the
    // `ryu-healing` sidecar (`com.ryu.healing`); Core only drives it. Publish the
    // loopback client (so the scheduler + workflow executor can reach it without
    // `ServerState`) and spawn the run-status bus loop, which reads a failed run's
    // context from the kernel conversation store and posts it to the sidecar,
    // applying the returned verdict (Core owns the approvals write + the re-run).
    let healing =
        crate::healing_client::HealingClient::new(healing_sidecar_port, server_state.clone());
    crate::healing_client::set_global_client(healing.clone());
    crate::healing_client::spawn(healing, server_state.clone());
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

    // Reconcile manifest-declared managed sidecars (the app ⇄ sidecar bridge):
    // re-register + start every enabled plugin's declared sidecar. These are not in
    // the SidecarManager's `startup_order`, so nothing else restarts them after a
    // Core restart — without this an enabled plugin's process stays dead while the
    // plugin still reads as enabled. Spawned (not awaited) so slow binary downloads
    // never delay the listener bind; idempotent with the enable path.
    {
        let sidecar_state = server_state.clone();
        tokio::spawn(async move {
            crate::server::reconcile_plugin_sidecars(&sidecar_state).await;
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
        .unwrap_or_else(|| format!("127.0.0.1:{}", crate::profile::port(7980)));

    let router = server::create_router(server_state, auth_token, &bind_addr);

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Another Core instance is already running on this address — treat as success.
            tracing::info!("ryu-core already running on {bind_addr}, exiting");
            std::process::exit(0);
        }
        Err(e) => boot_fail!("failed to bind {bind_addr}: {e}"),
    };

    tracing::info!(
        "HTTP server listening on {}",
        listener
            .local_addr()
            .unwrap_or_else(|e| boot_fail!("failed to read local address of {bind_addr}: {e}"))
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

    // (The `ryu-mail` sidecar is spawned by the generic plugin-sidecar loader when
    // the default-on `com.ryu.mail` app is reconciled — no bespoke startup here.)

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

    // Start the opt-in anonymous community-savings beacon. A no-op every tick
    // until the user opts in (`community-stats-enabled` pref or
    // `RYU_COMMUNITY_STATS_ENABLED`). OFF by default and fail-open, so this never
    // alters default behaviour, sends identity data, or blocks startup.
    stats_beacon::spawn_stats_beacon(stats_preferences);

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

    // Idle-stop (Rivet-style scale-to-zero): if `RYU_SIDECAR_IDLE_SECS` opts any
    // heavy sidecar in (e.g. `llamacpp-rerank=900,research=1800`), a background
    // reaper stops it after the configured idle period; the next request wakes it
    // on demand. A pure no-op when unset — the task isn't even spawned — so the
    // default holds all lazy-started sidecars resident exactly as before.
    sidecars.spawn_idle_reaper();

    // Serve HTTP API. `into_make_service_with_connect_info` threads the peer
    // `SocketAddr` so `/api/realtime/ws` can distinguish a genuine loopback peer
    // (the local single user) from a remote holder of the shared `RYU_TOKEN` when
    // deciding access to unpersisted rooms. Handlers that don't extract
    // `ConnectInfo` are unaffected — it is a superset of the plain make-service.
    if let Err(e) = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    {
        boot_fail!("HTTP server error: {e}");
    }
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
