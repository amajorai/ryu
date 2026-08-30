mod a2a;
mod acl;
mod acp_runtime;
mod activity;
mod agent_control;
mod agent_execution;
mod agent_routing;
mod agent_selection;
mod agents;
mod approvals;
mod auth;
mod authorization;
mod background_processes;
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
mod config_file;
mod connections;
mod crash;
mod crypto_host;
mod dashboards_client;
mod data_path;
/// The `document.parse` extraction facade. Shipped in `9bf1e2023` **without a
/// `mod` line**, so it was never in the module tree and never compiled — the
/// deepest form of the gap it was written to close. Declared here so
/// [`space_file_index`] can call it.
mod document_parse;
mod downloads;
mod entitlement;
mod events;
mod exec_approval;
/// Derived app-API tools: an installed app's own OpenAPI document lowered into
/// `ryu_ext.*` tools addressed through the ext-proxy. Sibling of [`self_api`],
/// which does the same for Core's own generated document.
mod ext_api;
mod fal_auth;
mod fleet;
mod governance;
mod hardware;
mod healing_client;
mod hf_auth;
mod identity;
mod identity_verify;
mod image_host;
/// Scan a user-picked local folder and import the *setup* it contains (agent
/// instructions, skills, MCP servers, plugins, Claude project memories) into
/// Ryu's own stores — the setup-side companion to [`native_history`].
mod import;
mod inference;
mod learning;
mod lsp;
/// Telegram "managed bots" (Bot API 9.6) pairing: how a per-user child bot's token
/// reaches this node without the user ever visiting @BotFather. Client for the
/// hosted manager (`apps/cloud-bot`) plus the pending-pairing store; the HTTP
/// surface lives in [`server::managed_bot_api`].
mod managed_bot;
mod memory_host;
mod memory_policy;
mod memory_provider;
mod sandbox_host;
/// Re-export shim: the MCP server catalog primitive now lives in the
/// `ryu-mcp-catalog` crate. Consumers reference
/// `crate::mcp_catalog::{ServerJson, InstallPlan, plan_from_server, …}`
/// unchanged; the crate's one cross-cutting kernel coupling (the SSRF-guarded
/// registry fetch) inverts through [`mcp_catalog_host`].
pub use ryu_mcp_catalog as mcp_catalog;
mod mcp_catalog_host;
mod mcp_oauth;
mod meetings_client;
mod mesh_host;
mod midnight_wipe;
/// OpenAPI/Swagger spec → `http`-backed tool descriptors (integrations.sh REST
/// install-abstraction). Pure transform; install/persist wiring lives in `server`.
mod openapi_import;
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
mod node_token;
mod notify;
/// Re-export shim: the Open Knowledge Format (OKF) primitive now lives in the
/// `ryu-knowledge` crate. Consumers reference `crate::okf::{Bundle, Concept, …}`
/// unchanged.
pub use ryu_knowledge as okf;
mod dictation;
mod finetune_client;
mod openrouter_auth;
mod pairing;
mod paths;
mod payment;
mod pi_config;
mod plugin_host;
mod plugin_manifest;
mod plugin_secrets;
mod plugin_storage;
mod plugins;
mod policy_alerts;
mod portable_packages;
mod predict;
mod predict_host;
mod privacy;
mod profile;
mod prompt_evals;
mod quests_client;
mod rag_host;
mod recipes_client;
mod recipes_host;
mod registry;
mod replicate_auth;
mod routing_policy;
mod rtk_config;
mod runnable;
mod ryu_analytics;
mod ryu_platform;
mod safe_actions;
/// The OS-style "boot with the extension layer off" switch (apps, plugins,
/// skills, user MCP servers, the scheduler). Resolved once, below, BEFORE
/// anything it suppresses has a chance to spawn.
mod safe_mode;
mod sandbox;
mod scheduler;
mod search_host;
mod self_api;
mod server;
mod sidecar;
mod skills_catalog;
mod skills_host;
mod smtp_auth;
/// The one path that puts an uploaded file's *contents* into a Space index —
/// `create_file` + [`document_parse`] + a durable per-document index status.
mod space_file_index;
mod stats_beacon;
mod stt_host;
mod support_access;
mod system_info;
mod teams_client;
mod telemetry;
mod tool_exec;
mod tool_registry_host;
mod treg_catalog;
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
        apfel::ApfelManager, llamacpp::LlamaCppClassifyManager, llamacpp::LlamaCppEmbedManager,
        llamacpp::LlamaCppManager, llamacpp::LlamaCppRerankManager,
        llamacpp::LlamaCppSpeechManager, mesh_llm::MeshLlmManager, mlx::MlxManager,
        mlx_serve::MlxServeManager, mlx_vlm::MlxVlmManager, ollama::OllamaManager,
        omlx::OmlxManager, outetts::OuteTtsManager, parakeet::ParakeetManager,
        ryutts::RyuTtsManager, sdcpp::StableDiffusionManager, sglang::SglangManager,
        vllm::VllmManager, whispercpp::WhisperCppManager, DockerModelRunnerManager,
    },
    tailcat::TailcatManager,
    tailscale::TailscaleManager,
    tools::{
        ghost::GhostManager, llmfit::LlmFit, research::ResearchManager, shadow::ShadowManager,
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

/// Seed the profile-aware env vars the Ghost MCP server needs, which its plugin
/// manifest (`fixtures/ghost.manifest.json`) can't express statically. Called once,
/// early in `main` (before threads spawn), so the values are present when the
/// manifest decl is lowered and when the Ghost child is later spawned:
/// - `RYU_GHOST_BIN` → the profile-scoped `~/.ryu{profile}/bin/ghost` path,
///   consumed at lowering time by `mcp_server_config_from_decl` (`command_env`);
/// - `RYU_GHOST_OVERLAY_URL` → the island loopback overlay endpoint (profile port
///   math mirrors `control.ts`: base 7989, +1000 for dev), so Ghost's pointer
///   actions drive the visible ghost-cursor overlay (fire-and-forget; a dead port
///   is a harmless no-op);
/// - `GHOST_DATA_DIR` → the per-profile `~/.ryu{profile}/ghost` recipe/model store
///   (isolating dev vs release), read by Ghost's `RecipeStore`.
///
/// Set-if-unset: a user-provided value wins, matching `profile::apply_env_defaults`.
/// The latter two reach the scrubbed Ghost child via the `mcp_safe_env` allowlist.
fn seed_ghost_sidecar_env() {
    let set_if_unset = |key: &str, value: String| {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    };
    set_if_unset(
        "RYU_GHOST_BIN",
        crate::sidecar::tools::ghost::ghost_bin_path()
            .to_string_lossy()
            .into_owned(),
    );
    set_if_unset(
        "RYU_GHOST_OVERLAY_URL",
        format!(
            "http://127.0.0.1:{}/ghost-cursor",
            crate::profile::port(7989)
        ),
    );
    set_if_unset(
        "GHOST_DATA_DIR",
        crate::paths::ryu_dir()
            .join("ghost")
            .to_string_lossy()
            .into_owned(),
    );
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

    // Load non-secret node defaults from the structured config before any
    // component resolves its own environment fallback. Explicit environment
    // values remain higher precedence, so deployments can override a local file
    // and rollback is simply removing the file.
    if let Err(error) = crate::config_file::load() {
        boot_fail!("failed to load structured node config: {error:#}");
    }

    // Prompt Studio suites/runs/reviews are Core-owned durable resources. Install
    // the store after profile defaults so the database follows the active node
    // data directory, before any HTTP router can serve the prompt-eval surface.
    let prompt_eval_store =
        crate::prompt_evals::PromptEvalStore::open().expect("open prompt eval store");
    crate::prompt_evals::PromptEvalStore::install_global(prompt_eval_store)
        .expect("install prompt eval store");

    // PATH enrichment: add the user's own bin directories that a GUI launcher
    // does not pass down. Must run before ANY CLI probe or spawn, so agent
    // detection and agent execution resolve names against the same PATH — see
    // `PathManager::enrich_process_path` for why a desktop-launched Core would
    // otherwise report every installed agent CLI as missing.
    crate::sidecar::path_manager::PathManager::enrich_process_path();

    // Node auth token: resolve `RYU_TOKEN` (operator env > persisted file > mint a
    // fresh one) and EXPORT it back into this process's environment.
    //
    // Placed here deliberately — after `apply_env_defaults` so the token file lands
    // in the right profile's data dir (`~/.ryu-dev` vs `~/.ryu`), and before ANY
    // sidecar spawn or server thread so that every one of the ~9 direct
    // `env::var("RYU_TOKEN")` readers, plus every spawned child that inherits the
    // environment, observes the same value. `sidecar/gateway.rs` copying it into the
    // gateway child's `CORE_TOKEN` is the load-bearing one: miss it and the
    // gateway's tool-catalog calls back into Core start 401ing.
    //
    // Before this, a default desktop install ran with NO token, and `require_auth`
    // treats "no token configured" as "allow everything" — so any local process (or
    // any page from an allowlisted CORS origin) could drive the whole local API.
    match crate::node_token::resolve_and_export() {
        Some(resolved) => tracing::info!(
            source = ?resolved.source,
            "node auth token resolved; protected routes require a bearer"
        ),
        // Not fatal on loopback (Core behaves exactly as it did before this
        // existed). `enforce_remote_auth` below still REFUSES to expose a tokenless
        // node beyond loopback, so an unwritable home cannot yield an open node on
        // a public IP.
        None => {
            tracing::warn!("no node auth token could be established; local API is UNAUTHENTICATED")
        }
    }

    // Ghost sidecar env: the Ghost MCP server moved from a hardcoded built-in to
    // its plugin manifest's `mcp_servers` (fixtures/ghost.manifest.json). A static
    // manifest can't express Ghost's three profile-aware values, so Core seeds
    // them into its own process env HERE — early, before threads spawn and before
    // `fire_activation_event` lowers the manifest decl — and the child inherits
    // them: `RYU_GHOST_BIN` (the `~/.ryu{profile}/bin/ghost` path) is read at
    // lowering time by `mcp_server_config_from_decl`, while `RYU_GHOST_OVERLAY_URL`
    // (island cursor overlay) and `GHOST_DATA_DIR` (per-profile recipe store) reach
    // the spawned Ghost via the `mcp_safe_env` allowlist. Set-if-unset so a user
    // override still wins, matching `apply_env_defaults`.
    seed_ghost_sidecar_env();

    // Midnight auto-wipe (canary/nightly profiles only, OFF by default): if a
    // calendar day has turned since the last one, ARM the node reset below. This
    // only writes the marker — the delete itself is the audited reset path, one
    // line down, in this same boot. Placed here so it runs after
    // `apply_env_defaults` (the data dir must resolve against the active profile)
    // and before anything opens a store. Every guard is in `midnight_wipe::decide`.
    crate::midnight_wipe::arm_if_due();

    // Full node reset: if `POST /api/node/reset` armed a wipe, delete every store
    // DB / download / preference under the data dir (preserving only the encryption
    // key so the node still boots) BEFORE anything opens a store. The API handler
    // can't wipe live — the SQLite files are open — so it drops a marker and asks
    // the desktop to restart Core; this is where the marker is consumed. Runs after
    // `apply_env_defaults` so the data dir resolves against the active profile.
    crate::paths::apply_pending_reset();

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
        Ok(prefs) => {
            crate::ryu_analytics::seed_product_analytics(&prefs).await;
            crate::telemetry::build_otlp_layer(&prefs).await
        }
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

    // Seed the command-tool allowlist from the TRUSTED compiled-in manifests
    // (spider/rtk), so a granted built-in `command` tool resolves its bin out of
    // the box. Only `load_builtins()` feeds this — an untrusted `~/.ryu/plugins`
    // manifest can never self-allowlist a bin (it still needs the `tool:command:*`
    // grant + explicit allowlist). Idempotent; must run before any command-tool
    // dispatch.
    tool_exec::seed_builtin_command_allowlist();

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

    // Load the unified provider/model registry at startup so the resolved defaults
    // are visible in logs (env > ~/.ryu/registry.json > literal).
    //
    // # Every value printed here is one the running system will actually use
    //
    // That is a property of the *fields chosen*, not of the constructor, and it was
    // not true before. This block used to print `load()`'s answer for `embed_model`
    // and `embed_dims` while their consumers (`spaces::open_default`,
    // `rag_host::open_retrieval_store`, `search_host`) built with `from_env()` and
    // never opened the file: an operator who wrote `{"embed_model":"X"}` read
    // `embed_model=X` here and reasonably concluded Spaces now embed with X. A log
    // line that corroborates a false belief is worse than no log line. It was
    // patched by ALSO logging a warning naming the divergent fields — printing the
    // lie and the correction side by side.
    //
    // The divergence itself is now gone: the embed trio and all four local-GGUF
    // triples have no `registry.json` key, so `load()` and `from_env()` return the
    // same values for them, and every other field printed here is read by consumers
    // that all use `load()`. Hence one line and no warning — there is nothing left
    // for a warning to name. `registry::from_env_and_load_agree_on_every_field_a_from_env_consumer_reads`
    // is what keeps that true; if it ever fails, this log is lying again.
    //
    // `embed_model`/`embed_dims` are still printed because they are still the values
    // in force — env or literal now, never file. `strategies_count` is NOT printed
    // any more: nothing ever read a `strategies` entry, so the count advertised a
    // knob that did not exist, and the field is deleted.
    {
        let reg = crate::registry::ProviderRegistry::load();
        tracing::info!(
            default_llm_base_url = %reg.default_llm_base_url,
            default_llm_model = %reg.default_llm_model,
            embed_model = %reg.embedder.id,
            embed_dims = reg.embedder.dims,
            reranker_model = %reg.reranker.id,
            rag_strategy = %reg.rag_strategy,
            providers_count = reg.providers.len(),
            "registry: loaded provider/model defaults"
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

    // Island is a desktop-owned companion, not a Core sidecar: Core never starts
    // it and it stays out of the node selector while the feature is disabled. Its
    // bundle is still preinstalled here so the future launch toggle is a product
    // switch, not a reinstall. Using the same DownloadCenter also makes the
    // disabled companion's initial download and later refresh visible in Desktop's
    // global Downloads surface.
    #[cfg(not(debug_assertions))]
    {
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
        // worker HTTP client, and the `/api/finetune/*` surface; Core reaches only its
        // `host.finetune_*` bridge over loopback via `finetune_client`.)
        // Tools
        // (Spider is now a declarative `command` plugin — fixtures/spider.manifest.json —
        // with no in-process manager; the `spider` CLI is user-installed and reached
        // via the command-tool allowlist, so there is no SpiderManager sidecar here.)
        // Autoresearch experiment runner (Python stdlib HTTP service). Opt-in;
        // NOT in startup_order — it only starts once a user installs it or runs
        // `python -m ryu_research` (adopt-mode). Its consumers are both
        // out-of-process now (the `@ryu/research` app's sidecar for /api/research,
        // and its `ryu-research mcp` stdio server for the research.* tools); they
        // reach this engine over loopback, so Core keeps only its lifecycle.
        Arc::new(ResearchManager::new().with_downloads(download_center.clone())),
        Arc::new(LlmFit::new()),
        Arc::new(ShadowManager::new().with_downloads(download_center.clone())),
        Arc::new(GhostManager::new().with_downloads(download_center.clone())),
        // Agents
        Arc::new(ZeroClawManager::new().with_downloads(download_center.clone())),
        Arc::new(OpenClawManager::new()),
        Arc::new(HermesManager::new()),
        // Network backends (Tailscale/Headscale + Tailcat, #478). Opt-in via
        // RYU_MESH_ENABLED; registered here so the config/start routes can reach
        // them. Only the selected backend is marked installed at boot.
        Arc::new(TailscaleManager::new().with_downloads(download_center.clone())),
        Arc::new(TailcatManager::new()),
    ];

    let startup_order = vec![
        // Tools first
        "llmfit".into(),
        // Release Core treats Shadow and Ghost as first-party preinstalled tools.
        // Their managers download through the global DownloadCenter on a fresh
        // node and start normally here; debug Core leaves eligibility to the
        // local turbo/dev processes.
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
        // Parakeet (the default STT engine, `default_stt_engine()`) auto-starts for
        // the same reason: its model is downloaded unconditionally during onboarding,
        // so a node that has the bits should have the engine loaded rather than
        // reporting itself dead. Being absent here is what made the Voice settings
        // row read "Not running — install + start it from Services first" on every
        // install forever: nothing ever called `start()`, so `loaded` stayed false —
        // while transcription silently worked anyway, because `transcribe_wav_bytes`
        // preloads on first use. Listing it here makes `running` mean what it says
        // and warms the first dictation. `start_all` skips it when the model is not
        // installed, and a lean build (no `voice-parakeet`) refuses in `start()` and
        // reports the missing feature — neither reports a false "Running".
        "parakeet".into(),
        "ollama".into(),
        "vllm".into(),
        "sglang".into(),
        "mlx".into(),
        "mlx-serve".into(),
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
        "mesh-llm".into(),
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
        // Network backends (Tailscale/Headscale + Tailcat, #478). Listed in
        // startup_order so an enabled node auto-starts its selected backend on boot.
        // `start_all` skips them
        // unless it was explicitly marked installed, which `main()` does just
        // below only when `ryu_mesh::is_enabled()`. A mesh-off install is never
        // marked and so never runs (nor logs) anything.
        //
        // It USED to be PATH-adopted only, and therefore never in `versions.json`.
        // It can be there now — `sidecar/tailscale/downloader.rs` installs a
        // managed pair when no client is on PATH — which would otherwise make
        // `seed_installed_from_disk` mark it installed on every boot and produce a
        // failed-start log for users who never enabled the mesh. That function
        // skips this one name for exactly that reason; the mesh pref stays the
        // single source of installed-ness here. That skip is now load-bearing for
        // the DEFAULT node, not just an unusual one: first run pre-installs the
        // client (see `MESH_PREINSTALL_PREF_KEY`), so a mesh-OFF machine has a
        // `versions.json` tailscale row from boot 2 onward. Seeding from it would
        // start a tailnet daemon nobody asked for.
        "tailscale".into(),
        "tailcat".into(),
    ];

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

    // Local ryu-gateway (data plane). Created before the server state so the
    // `/api/engine/active` swap endpoint can re-point the gateway's `local`
    // provider at the active engine after a swap (U19).
    let gateway = Arc::new(sidecar::gateway::GatewayManager::new());

    // Optional headroom compression proxy (M2 / #425). Started before the
    // gateway so it is reachable when the gateway's egress compression transform
    // (enabled in the same step) first runs. Off unless RYU_HEADROOM_ENABLED=1.
    let headroom = Arc::new(sidecar::headroom::HeadroomManager::new());

    // Mail runs as the `@ryu/mail` app: the generic sidecar loader spawns the
    // out-of-process `ryu-mail` binary and proxies `/api/mail/*` to it via the
    // manifest's `public_mount` (Track C). No hand-coded MailManager here anymore.

    // Start HTTP server for setup control
    let catalog = Arc::new(crate::catalog::CatalogManager::new());
    let auth_state = Arc::new(Mutex::new(auth::AuthState::new()));
    // The registry snapshot below is frozen for the process lifetime, so the ACP
    // registry cache has to exist BEFORE it is built — otherwise a cold first
    // launch serves only the hardcoded curated agents until the next restart.
    // Bounded and best-effort; see `ensure_registry_cached`.
    crate::sidecar::agents::acp_registry::ensure_registry_cached().await;
    let agent_registry = Arc::new(AcpAgentRegistry::new());
    // Persisted agent config store (SQLite). Seeds the built-in registry agents
    // as durable rows so they survive a restart and stay selectable.
    let agent_store = match crate::agents::AgentStore::open(&agent_registry) {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open agent store: {e:#}"),
    };
    crate::agents::set_global(agent_store.clone());
    // Output-style profiles now belong to agents. Initialise the shared registry
    // before plugin activation and migrate the retired node-wide selection once,
    // copying it to every existing agent so an upgrade does not change anyone's
    // voice unexpectedly. New agents start with the explicit "agent's own voice"
    // default; the old selection file is cleared only after the copy succeeds.
    ryu_output_styles::set_data_dir(crate::paths::ryu_dir());
    let legacy_output_style = ryu_output_styles::load_selection();
    ryu_output_styles::set_global_registry(ryu_output_styles::OutputStyleRegistry::load());
    if !crate::safe_mode::is_active() {
        if let Some(style_id) = legacy_output_style {
            match agent_store.migrate_legacy_output_style(&style_id).await {
                Ok(migrated) => {
                    tracing::info!(
                        style = %style_id,
                        agents = migrated,
                        "migrated node-wide output style to agent personality profiles"
                    );
                    ryu_output_styles::set_selection(None);
                }
                Err(error) => tracing::warn!(
                    style = %style_id,
                    error = %error,
                    "could not migrate node-wide output style; keeping the legacy selection"
                ),
            }
        }
    } else if legacy_output_style.is_some() {
        tracing::info!("safe mode: deferring output-style profile migration");
    }
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
    // returns no index. Population is lazy-on-search and disabled by default, so wiring the
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
    // Ensure the default, undeletable "Uploads" system space — where **user**-
    // initiated files land (chat attachments, page/editor media, `ui.uploadFile`).
    // Twin of Artifacts (agent-created). Seeded here so it exists even if Spaces
    // UI is disabled; the ungated `/api/uploads` surface writes into it.
    if let Err(e) = spaces
        .ensure_system_space(
            server::spaces::UPLOADS_SPACE_NAME,
            Some("Files you upload in chat and pages"),
        )
        .await
    {
        tracing::warn!("failed to ensure Uploads system space: {e:#}");
    }
    // NOTE — "Clips" / "Canvas" / "Whiteboard" are DELIBERATELY not seeded here.
    //
    // All three used to be `ensure_system_space`d unconditionally on every boot,
    // right next to Artifacts/Uploads. That was wrong in a way the Artifacts and
    // Uploads seeds are not: those two back **kernel** surfaces that run whatever
    // the user has installed (agent file output; the ungated `/api/uploads`
    // mount). Clips/Canvas/Whiteboard back three OPT-IN APPS — `@ryu/clips`,
    // `@ryu/canvas`, `@ryu/whiteboard`, none of them pre-installed — so seeding their
    // Spaces created three
    // undeletable, permanently empty Spaces on machines whose owner had never
    // installed the apps and could not delete them (`ensure_system_space` marks
    // them system ⇒ undeletable). It also survived a full node reset, because the
    // reset wipes state and this runs on the very next boot, which is what made it
    // read as "Ryu keeps re-creating Spaces I deleted".
    //
    // Nothing needs the eager create; every writer already get-or-creates by name:
    //   - Canvas/Whiteboard — `server::mod::{list_app_docs, create_app_doc}` call
    //     `ensure_system_space(app_space_name(id))` on every `/api/apps/:id/docs`
    //     request, so the Space appears the first time the app lists or creates a
    //     board and not before.
    //   - Clips — filing is `ClipsHost::store_clip`, documented as an idempotent
    //     get-or-create at file-time. Core has no in-process `CoreClipsHost` at
    //     all any more (see the note above `clips` routes in `server::mod`), so on
    //     the current build this Space had no writer whatsoever.
    //
    // The one thing that genuinely had to run at boot is the legacy-canvas import,
    // and only for a user who actually has a legacy store — so it is gated on that
    // instead of on nothing. `has_pending_legacy_canvases` is a cheap directory
    // read that is false on every install that never used the pre-App canvas.
    if server::canvas_migrate::has_pending_legacy_canvases() {
        match spaces
            .ensure_system_space("Canvas", Some("Node-based creative canvases"))
            .await
        {
            Ok(space_id) => {
                server::canvas_migrate::migrate_legacy_canvases(&spaces, &space_id).await;
            }
            Err(e) => tracing::warn!("failed to ensure Canvas system space: {e:#}"),
        }
    }
    // `&spaces` is what lets `RetrievalOptions::space_ids` reach a real Space: the
    // retrieval store delegates the Spaces half of every recall back to the Spaces
    // store, where each Space's own `retrieval_mode` (vector or graph) decides how
    // it is answered. See `rag_host::SpacesRecall`.
    let retrieval = match rag_host::open_retrieval_store(&spaces) {
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
    if let Ok(raw) = preferences
        .get(server::conversations::ConversationStore::CHAT_MEMORY_ENABLED_PREF_KEY)
        .await
    {
        let enabled =
            server::conversations::ConversationStore::parse_chat_memory_enabled(raw.as_deref());
        if let Err(error) = conversations.set_chat_memory_enabled(enabled).await {
            tracing::warn!(error = %error, "could not apply saved chat-memory preference");
        }
    }
    // ── Safe Mode (see `crate::safe_mode`) ────────────────────────────────────
    //
    // Resolved HERE and nowhere else. Everything the flag suppresses — the
    // pre-installed plugin seed, the MCP registry, the sidecar `start_all`, the
    // scheduler tick loop — is constructed further down this function, so this
    // read has to land ahead of all of them. Consulting the flag at request time
    // instead would mean boot already paid every cost the user is trying to
    // measure away, and the switch would look like it did nothing.
    //
    // Three tiers, env → sentinel file → preference. The sentinel exists so a node
    // that cannot come up (wedged store, hanging boot) can still be forced into
    // safe mode without HTTP or a healthy `preferences.db`.
    {
        let pref = preferences
            .get(crate::safe_mode::SAFE_MODE_PREF_KEY)
            .await
            .ok()
            .flatten();
        let env = std::env::var(crate::safe_mode::SAFE_MODE_ENV).ok();
        let source = crate::safe_mode::resolve_from(env.as_deref(), pref.as_deref());
        crate::safe_mode::set_resolved(source);
        if source != crate::safe_mode::SafeModeSource::Off {
            tracing::warn!(
                source = source.as_str(),
                "SAFE MODE: booting with apps, plugins, skills, user MCP servers and \
                 the scheduler disabled. Chat, agents and settings stay available."
            );
        }
    }
    // Mesh enable (#478): seed the desktop-driven `mesh-enabled` pref into the
    // process-global that `ryu_mesh::is_enabled()` consults. The `RYU_MESH_ENABLED`
    // env still wins when set. Placed here — after the prefs store opens and BEFORE
    // `create_router` (the fail-closed token gate) and the sidecar `start_all`
    // spawn — so the enabled signal is settled before anything security-relevant
    // or mesh-relevant reads it. Same pattern as entitlement/claude-config/etc.
    if let Ok(Some(value)) = preferences
        .get(crate::mesh_host::MESH_ENABLED_PREF_KEY)
        .await
    {
        ryu_mesh::set_pref_enabled(ryu_mesh::parse_enabled(Some(&value)));
    }
    // Mesh client PRE-install (separate decision from the enable above — see
    // `MESH_PREINSTALL_PREF_KEY`). Read into a plain bool HERE, beside the other
    // pref seeds, because `preferences` moves into `ServerState` long before the
    // mesh block near the end of boot that consumes it.
    let mesh_preinstall_client = crate::mesh_host::preinstall_client_wanted(
        preferences
            .get(crate::mesh_host::MESH_PREINSTALL_PREF_KEY)
            .await
            .ok()
            .flatten()
            .as_deref(),
    );
    // Managed-inference fleet coordinates. Same shape and the same reason as the
    // mesh seed above: `pi_config::apply` is synchronous and cannot await the
    // prefs store, so the pref half is read once here into a process-global that
    // the sync path consults (`RYU_MANAGED_GATEWAY_*` env still wins). This is
    // what lets a SELF-HOSTED node spend its plan's credits — the managed
    // provider routes at the hosted fleet while BYOK providers keep using the
    // local gateway.
    {
        let url = preferences
            .get(crate::sidecar::gateway::MANAGED_FLEET_URL_PREF_KEY)
            .await
            .ok()
            .flatten();
        let token = preferences
            .get(crate::sidecar::gateway::MANAGED_FLEET_TOKEN_PREF_KEY)
            .await
            .ok()
            .flatten();
        crate::sidecar::gateway::set_managed_fleet_pref(url, token);
    }
    // Managed per-request routing preferences. The request-forwarding path is
    // synchronous, so seed the encoded carrier beside the managed-fleet pair
    // before any agent can issue a request. The generic preference route keeps
    // it fresh after a desktop edit.
    if let Ok(Some(value)) = preferences
        .get(crate::sidecar::gateway::NODE_ROUTING_PREF_KEY)
        .await
    {
        crate::sidecar::gateway::set_node_routing_prefs_from_json(&value);
    }
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
    // with no subscription/license. Absent ⇒ enabled by default (headless / OSS Core /
    // still-entitled desktop run automations normally).
    if let Ok(Some(v)) = preferences
        .get(entitlement::ENTITLEMENT_ACTIVE_PREF_KEY)
        .await
    {
        entitlement::set_active(&v);
    }
    if let Ok(Some(v)) = preferences
        .get(entitlement::MANAGED_INFERENCE_ENTITLED_PREF_KEY)
        .await
    {
        entitlement::set_managed_inference_entitled(&v);
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
    // ACP spawn path keeps the governed default unless an explicit direct-egress
    // opt-out is persisted.
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
    // model are boundary-wrapped + chat-template-token-stripped. Pre-installed (safe:
    // only untrusted tool output, never user text); seed only to honour an
    // explicit opt-OUT persisted by the desktop.
    if let Ok(Some(value)) = preferences
        .get(sidecar::untrusted::UNTRUSTED_WRAPPING_PREF_KEY)
        .await
    {
        sidecar::untrusted::set_enabled(&value);
    }
    // Codex gateway-routing toggle (subscription passthrough). Same governed
    // default as Claude: seed the in-process flag so the (sync) ACP spawn path
    // points the Codex subprocess at an isolated CODEX_HOME → gateway passthrough
    // unless the user explicitly opts out.
    if let Ok(Some(value)) = preferences
        .get(codex_config::CODEX_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        codex_config::set_enabled(&value);
    }
    // Generic per-agent gateway-routing toggles (the "point any agent at the
    // gateway via the OpenAI base-URL swap" feature). One pref holds a JSON map of
    // agent id → enabled; seed the in-process map so the (sync) ACP spawn path
    // injects OPENAI_BASE_URL by default. Explicit false entries keep provider
    // egress direct.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        agent_routing::set_from_json(&value);
    }
    // Per-agent MCP tool-bridge opt-OUTs. Independent of the egress toggle above
    // (they used to share one preference, so declining credential routing also
    // silently stripped every Ryu tool). Seeded the same way, but note the
    // asymmetry: this map holds only opt-OUTs — an absent preference is the
    // enabled-by-default case and needs no seeding at all, which is exactly what a missing
    // key here leaves behind. See `agent_routing`'s module docs.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_TOOL_BRIDGE_PREF_KEY)
        .await
    {
        agent_routing::set_bridge_from_json(&value);
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
    // The node-wide default selection every unset agent/model setting falls back
    // to. Seeded into an in-process snapshot for the same reason as agent-auto:
    // the sync routing path has no preference-store handle.
    if let Ok(Some(value)) = preferences.get(agent_selection::LOCAL_SELECTION_PREF).await {
        agent_selection::set_local_selection_from_json(&value);
    } else if let Ok(Some(value)) = preferences
        .get(agent_selection::GLOBAL_SELECTION_PREF)
        .await
    {
        // Legacy installations seed the local-lane snapshot from the former
        // one-default key until the new key is written.
        agent_selection::set_default_selection_from_json(&value);
    }
    if let Ok(Some(value)) = preferences.get(agent_selection::CLOUD_SELECTION_PREF).await {
        agent_selection::set_cloud_selection_from_json(&value);
    }
    // Apply the user's saved default embedding model (if any) to the Spaces store,
    // re-indexing in the background when it differs from what the store opened with.
    server::spaces::apply_saved_embedding_pref_all(
        &spaces,
        &retrieval,
        &conversations,
        &preferences,
    )
    .await;
    // App manifests: wrapped in RwLock so self-build tools can hot-install new
    // apps without restarting Core (U57). The self-build tools write into this
    // store and `GET /api/apps` reads from it; no restart required.
    // `load_all` splits the pass in two: `compatible` is what the runtime gets (and
    // is byte-for-byte what `load()` used to return), while `incompatible` holds the
    // plugins this node's version cannot run. The second list exists ONLY so the
    // marketplace can show them greyed with what they need — it is never activated.
    let loaded_manifests = {
        let mut loaded = crate::plugin_manifest::PluginManifestLoader::load_all();
        let runtime = crate::plugin_manifest::PluginManifestLoader::load_runtime();
        loaded.compatible = runtime;
        loaded
    };
    // Loopback clients need their manifest-declared ports before the default
    // marketplace packages are materialized below. Keep this bootstrap snapshot
    // separate from the runtime set: absent packages must not be activated merely
    // to make startup port resolution work.
    let bootstrap_manifests = crate::plugin_manifest::PluginManifestLoader::load_bootstrap();
    if !loaded_manifests.incompatible.is_empty() {
        tracing::info!(
            count = loaded_manifests.incompatible.len(),
            "plugins held back as incompatible with this node's versions"
        );
    }
    let incompatible_manifests = Arc::new(tokio::sync::RwLock::new(loaded_manifests.incompatible));
    let app_manifests = Arc::new(tokio::sync::RwLock::new(loaded_manifests.compatible));
    // Loopback client for the out-of-process `ryu-teams` sidecar (single owner of
    // `teams.db`). Port resolved from the just-loaded manifests, profile-shifted.
    let teams = crate::teams_client::TeamsClient::new(crate::teams_client::sidecar_port(
        &bootstrap_manifests,
    ));
    // Loopback client for the out-of-process `ryu-finetune` sidecar (single owner of
    // `finetune.db` + the Python `unsloth` worker). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `teams`.
    let finetune = crate::finetune_client::FinetuneClient::new(
        crate::finetune_client::sidecar_port(&bootstrap_manifests),
    );
    // Loopback client for the out-of-process `ryu-quests` sidecar (single owner of
    // `quests.db` + the detection engine). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `finetune`/`teams`. Published as
    // a process-global so the scheduler (`JobTarget::Quest`) can reach it without
    // `ServerState`.
    let quests = crate::quests_client::QuestsClient::new(crate::quests_client::sidecar_port(
        &bootstrap_manifests,
    ));
    crate::quests_client::set_global_client(quests.clone());
    // Loopback client for the out-of-process `ryu-monitors` sidecar (single owner of
    // `monitors.db` + the monitor engine). Port resolved from the just-loaded
    // manifests, profile-shifted — same posture as `quests`. Published as a
    // process-global so the scheduler (`JobTarget::Monitor`) can reach it without
    // `ServerState`; the reconcile loop is spawned once `activity`/`ServerState` exist.
    let monitors = crate::monitors_client::MonitorsClient::new(
        crate::monitors_client::sidecar_port(&bootstrap_manifests),
    );
    crate::monitors_client::set_global_client(monitors.clone());
    // Loopback client for the out-of-process `ryu-dashboards` sidecar (single owner
    // of `dashboards.db` + the refresh loop + the `/api/dashboards/*` surface). Port
    // resolved from the just-loaded manifests, profile-shifted — same posture as
    // `monitors`. Published as a process-global so the state-free `dashboard_builder`
    // MCP runnable can reach it; also backs the kernel hardware device-dashboard
    // renderer + nudge loop through the `ryu_hardware::DashboardFeed` seam.
    let dashboards = crate::dashboards_client::DashboardsClient::new(
        crate::dashboards_client::sidecar_port(&bootstrap_manifests),
    );
    crate::dashboards_client::set_global_client(dashboards.clone());
    // Loopback client for the out-of-process `ryu-meetings` sidecar (single owner of
    // `meetings.db` + the engine/audio pipeline + the `/api/meetings/*` surface). Port
    // resolved from the just-loaded manifests, profile-shifted — same posture as
    // `dashboards`. Backs the kernel hardware ambient-audio path through the
    // `ryu_hardware::MeetingIngest` seam; the activity-feed fold is spawned once
    // `activity`/`ServerState` exist.
    let meetings = crate::meetings_client::MeetingsClient::new(
        crate::meetings_client::sidecar_port(&bootstrap_manifests),
    );
    // Resolve the `ryu-healing` sidecar port from the bootstrap snapshot; the
    // healing client is built later, once `server_state` exists.
    let healing_sidecar_port = crate::healing_client::sidecar_port(&bootstrap_manifests);
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
    // Seed system-wide dictation from the Dictation plugin's persisted enabled
    // state. Pre-installed (see CORE_PREINSTALLED): Island hosts the OS surface and
    // reads the synced `dictation` preference `enabled` field for live shortcut
    // rebinding when the plugin flips.
    if let Ok(Some(rec)) = app_store.get(crate::dictation::DICTATION_PLUGIN_ID).await {
        crate::dictation::set_enabled(rec.enabled);
    }
    // Pre-installed plugin seeding (#444) — the ONE definition lives in
    // `plugins::seed`. It seeds every `CORE_PREINSTALLED` plugin INSTALLED +
    // ENABLED on a fresh install (the three companions with their grants +
    // prebuilt `ui_code` bundle, everything else with empty grants), in
    // DEPENDENCY ORDER, and refuses to enable a plugin whose `requires` cannot be
    // satisfied from the pre-installed set.
    //
    // It writes the store directly rather than calling `lifecycle::enable_app`
    // because the Gateway is not spawned until further below and `enable_app`
    // fails closed on an unreachable Gateway — routing the seed through it would
    // disable every pre-installed plugin on every fresh install. The dependency
    // GRAPH is still honoured (see the module docs); only the Gateway grant call
    // is bypassed, for a fixed first-party grant set.
    //
    // One-time and user-respecting: a plugin with any existing record (enabled OR
    // disabled) is left alone, so a user's disable survives restarts.
    //
    // Skipped entirely under Safe Mode. Both calls WRITE lifecycle records, and
    // safe mode's whole non-destructive property is that it never writes the
    // `enabled` column — a seed or a migration running in a diagnostic boot would
    // persist state the user never asked for. Both are one-time and gated on
    // record presence / schema version, so the next normal boot performs them.
    if crate::safe_mode::is_active() {
        tracing::info!("safe mode: skipping pre-installed plugin seed and one-time migrations");
    } else {
        let manifests = app_manifests.read().await.clone();
        // Open plugin-owned KV before the seed migrations: v6 moves legacy
        // unscoped rows through this process-global handle. Safe mode leaves the
        // store unopened, preserving its non-destructive boot contract.
        match crate::plugin_storage::open_default() {
            Ok(store) => crate::plugin_storage::set_global(store),
            Err(e) => tracing::warn!("plugin storage unavailable: {e:#}"),
        }
        // Repair ALREADY-INSTALLED stores before seeding fresh defaults. The
        // migration must see the user's legacy disabled record first; seeding it
        // before migration would recreate a pre-installed row and erase that choice.
        crate::plugins::seed::run_one_time_migrations(&app_store, &manifests).await;
        crate::plugins::seed::seed_preinstalled(&app_store, &manifests).await;
    }
    // Re-read dictation after pre-installed seed: a fresh install may have just
    // created the enabled record, and the pre-seed AtomicBool read above would
    // have missed it.
    if let Ok(Some(rec)) = app_store.get(crate::dictation::DICTATION_PLUGIN_ID).await {
        crate::dictation::set_enabled(rec.enabled);
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
    // The flagship Ryu assistant owns the platform operating layer, while the
    // detailed reference stays a normal progressive skill that other assistants
    // can load when they need to help configure Ryu.
    skill_registry.register_builtin_skill(
        crate::ryu_platform::SKILL_ID.to_owned(),
        crate::ryu_platform::SKILL_NAME.to_owned(),
        Some(crate::ryu_platform::SKILL_DESCRIPTION.to_owned()),
        crate::ryu_platform::SKILL_INSTRUCTIONS.to_owned(),
    );

    // Per-run worktree diff cache, shared by the chat path and the off-chat agent
    // runner. Built once here so both `ServerState`, the runner, and the in-process
    // `ryu.worktree` app (via the MCP registry below) hold the same handle (a
    // per-run diff captured during a workflow agent turn is visible to chat too).
    let worktree_diffs: crate::server::WorktreeDiffStore =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    // Core is the sole authority for verified tool plans. The companion app only
    // reads and mutates this protected API; certificates and execution grants are
    // never issued by app code.
    let safe_actions_store = match crate::safe_actions::SafeActionsStore::open_default() {
        Ok(store) => store,
        Err(error) => boot_fail!("failed to open Safe Actions store: {error:#}"),
    };
    let safe_actions = crate::safe_actions::SafeActionsService::new(safe_actions_store);
    crate::safe_actions::install_global(safe_actions.clone());

    // Wire self-build context into the MCP registry (U57). The registry holds
    // Arc references to the manifest store and app store so scaffold_runnable /
    // install_app / write_ryu_json can hot-install without a process restart.
    let mcp_registry = Arc::new(
        sidecar::mcp::McpRegistry::load()
            .with_self_build(Arc::clone(&app_manifests), Arc::new(app_store.clone()))
            // Wire the agent store so the `agent_builder` tools can edit agent
            // records in chat (the desktop agent-edit page's builder pane).
            .with_agent_store(agent_store.clone())
            // Wire the teams sidecar client so `agent_builder.create_agent_team`
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
            // Wire the Spaces store so the built-in `artifact.create` tool can save
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

    // Recipes needs no host installation: `recipes_host::CoreRecipesHost` is a
    // plain Core type the `ghost.*` kernel capabilities call directly, and the
    // workflow executor's `Recipe` node drives the shared MCP registry itself.

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
    ryu_hardware::nudge::spawn(
        std::sync::Arc::new(dashboards.clone()),
        hardware_store.clone(),
    );

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
    // Per-plugin BYOK secrets (the `env:` secret-header fallback + the `secret`
    // settings field). Published as a process-global for the same reason as the KV
    // store above: `tool_exec::resolve_secret_token` is a free fn with no
    // ServerState handle. Best-effort — if the at-rest master key can't be resolved
    // the store simply stays unpublished and `env:` resolves from process env only,
    // exactly as it did before this store existed.
    match crate::plugin_secrets::open_default() {
        Ok(store) => {
            // Hydrate the Composio verifier from the encrypted Webhooks-app
            // slot before the public ingress starts. An operator-provided
            // `COMPOSIO_WEBHOOK_SECRET` still wins inside the verifier.
            match store
                .get(
                    ryu_composio::triggers::WEBHOOK_SECRET_STORE_OWNER,
                    ryu_composio::triggers::WEBHOOK_SECRET_STORE_KEY,
                )
                .await
            {
                Ok(secret) => ryu_composio::triggers::set_stored_webhook_secret(secret),
                Err(e) => tracing::warn!(
                    "stored Composio webhook secret unavailable; falling back to env: {e:#}"
                ),
            }
            crate::plugin_secrets::set_global(store)
        }
        Err(e) => tracing::warn!("plugin secret store unavailable: {e:#}"),
    }
    // Pi provider / ACP agent account vault: the sealed multi-account store for
    // provider logins, BYOK keys and ACP sign-ins. Best-effort — if the at-rest
    // master key can't be resolved the vault stays unpublished and credentials
    // fall back to the active slot in `auth.json` alone (single-account, exactly
    // as before this vault existed). Publish AFTER the master key resolves (the
    // plugin-secret store above is that same latch).
    match crate::pi_config::accounts::open_default() {
        Ok(vault) => {
            crate::pi_config::accounts::set_global(vault);
            // Import anything the user configured before this vault existed, then
            // make auth.json/models.json mirror the active accounts.
            crate::pi_config::sync_plaintext_into_vault();
            crate::pi_config::materialize_active_accounts();
        }
        Err(e) => tracing::warn!("pi accounts vault unavailable: {e:#}"),
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

    // Clone the local stores for the opt-in cross-device sync loop before they
    // move into ServerState.
    let sync_conversations = conversations.clone();
    let sync_spaces = spaces.clone();
    let sync_preferences = preferences.clone();
    // Clone the preferences handle for the opt-in anonymous community-savings
    // beacon (OFF by default) before `preferences` moves into ServerState below.
    let stats_preferences = preferences.clone();
    // Clone the preferences handle for the managed Ryu analytics heartbeat. It
    // starts after durable-token adoption below so the relay sees the live node
    // credential rather than a consumed bootstrap key.
    let ryu_analytics_preferences = preferences.clone();
    // Clone the preferences handle for the local-model auto-unload reactor (restarts
    // the resident engine when the idle timeout changes) before `preferences` moves
    // into ServerState below.
    let reactor_preferences = preferences.clone();

    // NOTE: chat auto-rename is NOT wired here. Core titles a conversation from
    // its first user message when it persists the turn, and the LLM rename on top
    // of that belongs to the `@ryu/chat-title` turn-hook plugin (pre-installed),
    // which owns the cadence, the toggle and the model. The background titler that
    // used to run from this file could only reach an active *local* engine, so it
    // no-opped on cloud-only nodes and left every chat on its placeholder.
    // Room-keyed realtime fan-out registry (Phase 1). Built ONCE here and shared
    // (Clone is Arc-backed) between the conversation store — which publishes a live
    // `Events` frame on every persisted turn — and `ServerState` below, which the
    // `/api/realtime/ws` handler subscribes against. Both MUST be the same instance
    // or publishes reach a registry no socket is listening to.
    let realtime = ryu_realtime::RoomRegistry::new();
    let conversations = conversations.with_realtime(realtime.clone());

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

    let agent_ui_templates = match server::agent_ui_templates::AgentUiTemplateStore::open_default()
    {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open Agent-UI template store: {e:#}"),
    };

    // Agent-root sync has its own SQLite ledger so import/export retries and ACP
    // session bindings do not mutate the conversation schema. It is installed
    // before the router and remains OFF until a profile explicitly enables a
    // direction.
    let agent_sync = match server::agent_sync::AgentSyncStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open agent sync store: {e:#}"),
    };
    server::agent_sync::install_global(agent_sync);

    // Handed to the scheduler further down, which is spawned after `ServerState`
    // has taken ownership of the store. `PluginStore` clones share one pool.
    let scheduler_apps = app_store.clone();
    let server_state = server::ServerState {
        setup: Arc::clone(&setup),
        manager: Arc::clone(&sidecars),
        install_status: Arc::clone(&install_status),
        catalog,
        client: reqwest::Client::new(),
        auth: Arc::clone(&auth_state),
        agents: Arc::clone(&agent_registry),
        agent_store,
        safe_actions,
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
        incompatible_manifests,
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
        agent_ui_templates,
        // Captured for the public `/api/realtime/ws` handler's in-handler node
        // token enforcement (the public router has no `auth_token` Extension).
        // Same env source the protected router resolves below.
        // The ACTIVE token (minted or operator-provisioned): the public realtime-WS
        // handler enforces it in-handler, and a self-minted one is exactly as valid
        // there as a provisioned one. NOT `shared_fleet_token` — that is the
        // narrower "same secret across the fleet" notion the mesh needs.
        node_token: crate::node_token::active_token(),
    };
    // Publish the state for the scheduler's continual-learning job (it has no
    // `State` extractor), mirroring the monitor/quest/identity-health engines.
    crate::learning::set_global_state(server_state.clone());
    // Install the process-global plugin-hook dispatcher so off-chat-path phases
    // (pre/post tool use, subagent stop, session end, notification) can fire hooks
    // from code that has no `ServerState` in scope. Mirrors plugin_storage::global.
    crate::server::install_global_hook_dispatcher(server_state.clone());
    // Self-healing: the diagnose→propose ENGINE runs out-of-process in the
    // `ryu-healing` sidecar (`@ryu/healing`); Core only drives it. Publish the
    // loopback client (so the scheduler + workflow executor can reach it without
    // `ServerState`) and spawn the run-status bus loop, which reads a failed run's
    // context from the kernel conversation store and posts it to the sidecar,
    // applying the returned verdict (Core owns the approvals write + the re-run).
    let healing = crate::healing_client::HealingClient::new(healing_sidecar_port);
    crate::healing_client::set_global_client(healing.clone());
    crate::healing_client::spawn(healing, server_state.clone());
    server::agent_sync::spawn_worker(server_state.clone());
    if !crate::safe_mode::is_active() {
        server::memory_dream::spawn_automatic_review(server_state.clone());
    } else {
        tracing::info!("safe mode: automatic Dream review not started");
    }
    let auth_token = crate::node_token::active_token();

    // Ordinary first-party plugins are official marketplace packages, not
    // compiled runtime entries. Install the default package set through the
    // same verified catalog path as the Store, then reload the runtime list
    // before activation and pre-installed seeding.
    if !crate::safe_mode::is_active() {
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
    {
        let startup_state = server_state.clone();
        tokio::spawn(async move {
            crate::server::fire_activation_event(&startup_state, "onStartup").await;
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

    // Reconcile the bundled system-skills catalog in the background: install
    // missing bundled skills, remove `System`-owned skills dropped from the
    // catalog (never `User`-owned ones), on first boot and whenever the catalog
    // version changes. Spawned (not awaited) so a slow network sync never delays
    // the listener bind; idempotent and gated on `skills.sync-system`.
    {
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

    // Resolve the bind address ONCE (the same chain the listener uses below) and
    // hand it to the fail-closed gate so a `--bind=0.0.0.0` flag cannot bypass the
    // RYU_BIND-only check (#478 V1).
    let bind_addr = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("--bind="))
        .and_then(|a| a.strip_prefix("--bind=").map(str::to_string))
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_else(|| format!("127.0.0.1:{}", crate::profile::port(7980)));

    let router_manifests = crate::plugin_manifest::PluginManifestLoader::for_router(
        &server_state.app_manifests.read().await,
        &bootstrap_manifests,
    );
    let router = server::create_router(
        server_state.clone(),
        auth_token,
        &bind_addr,
        &router_manifests,
    );

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
    // the `@ryu/mail` app is reconciled — no bespoke startup here.)

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
    // survive a Core restart). The App store rides along so a job an App created
    // stops firing while that App is disabled or uninstalled.
    //
    // Not spawned under Safe Mode. A scheduler is a background CPU source that
    // fires work the user did not ask for during the run they are measuring —
    // cron jobs, monitor checks, warmup pings. Jobs are reloaded from disk on
    // every boot, so nothing is lost: a normal restart resumes the schedule.
    if crate::safe_mode::is_active() {
        tracing::info!("safe mode: scheduled-job tick loop not started");
    } else {
        scheduler::Scheduler::new()
            .with_apps(scheduler_apps)
            .spawn();
    }

    // Start the opt-in cross-device conversation sync loop (M10). A no-op every
    // tick until the user opts in (env `RYU_SYNC_ENABLED` or the
    // `cloud-sync-enabled` pref). OFF by default per the local-first rule, so
    // this never alters default behaviour or blocks startup.
    server::sync::spawn_sync_loop(sync_conversations, sync_spaces, sync_preferences);

    // Start the opt-in anonymous community-savings beacon. A no-op every tick
    // until the user opts in (`community-stats-enabled` pref or
    // `RYU_COMMUNITY_STATS_ENABLED`). OFF by default and fail-open, so this never
    // alters default behaviour, sends identity data, or blocks startup.
    stats_beacon::spawn_stats_beacon(stats_preferences);

    // F7 boot precedence: BEFORE any control-plane spawn reads the gateway env,
    // re-adopt a durable token persisted by a prior bootstrap exchange. On a
    // RESTARTED managed node `core.env` still carries the now expired+revoked
    // bootstrap KEY; if the loader did not run first, both `resolve_scope` (just
    // below) and `register_managed_node` would grab that stale key and 401 for the
    // whole process lifetime. The loader overrides BOTH `RYU_GATEWAY_KEY` and
    // `RYU_GATEWAY_TOKEN` with the durable when the file is present; a fresh node
    // (no file) is untouched and exchanges its bootstrap normally.
    sidecar::control_plane::load_persisted_durable_token();

    // Managed Core analytics is a typed, content-free relay separate from the
    // customer's consented OTLP diagnostics stream. The producer no-ops on
    // unmanaged/local nodes and re-reads the product-analytics preference every
    // tick, so an opt-out stops future egress without a restart.
    ryu_analytics::spawn(ryu_analytics_preferences);

    // Enrolled nodes pull signed fleet desired state over an outbound-only
    // long poll. Unenrolled/local-only nodes sleep without touching the network.
    fleet::spawn_reconciler(server_state.clone());

    // Resolve the hierarchy-scoped tool set from the control plane (U30) when a
    // gateway key is configured. This narrows the local config-driven MCP
    // registry (U13) to what the org/team/project has granted. Best-effort: a
    // missing key means local-only mode, and a resolve failure must not block
    // Core from coming up — chat still works with the local registry.
    {
        let cp_client = reqwest::Client::new();
        let governance_state = server_state.clone();
        tokio::spawn(async move {
            match sidecar::control_plane::resolve_scope(&cp_client).await {
                Ok(None) => tracing::info!(
                    "control-plane: no gateway key (RYU_GATEWAY_KEY) set; using local MCP registry only"
                ),
                Ok(Some(scope)) => {
                    if let Err(error) = scope
                        .apply_governance(
                            &governance_state.preferences,
                            &governance_state.app_store,
                        )
                        .await
                    {
                        tracing::warn!(
                            "control-plane: managed governance apply failed ({error}); keeping last known good policy"
                        );
                    }
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
    {
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
                            "control-plane: managed node registered; usage attributes to this org"
                        );
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

    // Mesh daemon: make `start_all` actually start it when the mesh is enabled.
    // `seed_installed_from_disk` deliberately skips tailscale (a `versions.json`
    // row now exists once the managed client is installed, and seeding from it
    // would start the daemon for people who never enabled the mesh), so mark it
    // installed from the SAME signal the rest of the mesh reads. A mesh-off
    // install stays unmarked → `start_all` skips it
    // entirely (no daemon, no warning). The desktop's runtime toggle marks it
    // too via `POST /api/mesh/config`.
    let selected_network_backend = crate::sidecar::tailscale::mesh_backend().await.0;
    if ryu_mesh::is_enabled() {
        setup
            .mark_installed(selected_network_backend.sidecar_name())
            .await;
        tracing::info!(
            backend = selected_network_backend.as_str(),
            sidecar = selected_network_backend.sidecar_name(),
            "network: selected backend will start with the other sidecars"
        );
    }

    // Mesh CLIENT install — a separate decision from the enable above, and the
    // reason the two are no longer one block. Staging the binaries on a mesh-OFF
    // node is what makes first run behave like llama.cpp + the default GGUF, which
    // `install_local_stack` fetches unconditionally ~90 lines up: the client is
    // there before the user wants it. Without this the ONLY trigger was the
    // Tunnel toggle itself, so flipping it dropped the user into an up-to-10-minute
    // `watchMeshInstall` wait; with the binaries staged that toggle takes the
    // `ensure_mesh_binaries().is_ok()` branch and connects immediately.
    //
    // This does NOT turn the mesh on. `spawn_mesh_client_install` re-reads
    // `ryu_mesh::is_enabled()` only AFTER the download and, when false, logs
    // "installed, but the mesh was turned off meanwhile" without marking or
    // starting anything — so no daemon runs, Core stays loopback-only, and the
    // fail-closed token gate is untouched. `seed_installed_from_disk`'s tailscale
    // skip is what keeps that true across the NEXT boot (a `versions.json` row now
    // exists on mesh-off nodes), so it must stay.
    //
    // Both conditions after the want-check are the honest ones: nothing downloads
    // when a complete `tailscale`/`tailscaled` pair already resolves (PATH adoption
    // included), and `can_install()` is false on Windows (no userspace route) and
    // on a Mac without Homebrew, so those nodes stay silent instead of failing.
    // Re-entry is guarded by `MESH_INSTALL_IN_FLIGHT`, so this racing a user's
    // toggle cannot double-download.
    if (ryu_mesh::is_enabled()
        || (mesh_preinstall_client
            && selected_network_backend != crate::sidecar::tailscale::MeshBackend::Tailcat))
        && crate::sidecar::tailscale::ensure_mesh_binaries().is_err()
        && crate::sidecar::tailscale::downloader::can_install()
    {
        if ryu_mesh::is_enabled() {
            tracing::info!("mesh: enabled but no Tailscale client — installing one now");
        } else {
            tracing::info!(
                "mesh: pre-installing the Tailscale client (mesh stays off; set \
                 {}=0 or the `{}` pref to skip)",
                crate::mesh_host::MESH_PREINSTALL_ENV,
                crate::mesh_host::MESH_PREINSTALL_PREF_KEY,
            );
        }
        crate::server::spawn_mesh_client_install(
            download_center.clone(),
            Arc::clone(&sidecars),
            Arc::clone(&install_status),
        );
    }

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
        // Core-owned (reconciled by Core itself), not an App-created job.
        owner_app: None,
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
        // Core-owned (reconciled by Core itself), not an App-created job.
        owner_app: None,
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
