use super::*;

/// Load node config and install the process-wide hosts and tracing subscriber.
pub(super) async fn install_runtime_hosts(runtime_nonce: Option<String>) {
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
    // Human annotation queues are Core-owned durable review state, opened
    // beside the prompt-eval store for the same data-directory reason.
    let annotation_queue_store = crate::annotation_queues::AnnotationQueueStore::open()
        .expect("open annotation queue store");
    crate::annotation_queues::AnnotationQueueStore::install_global(annotation_queue_store)
        .expect("install annotation queue store");

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
        // A credential initialization failure must never weaken API admission,
        // including on loopback. No listener or child service is started.
        None => boot_fail!(
            "node credentials could not be initialized; refusing unauthenticated startup"
        ),
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
    if let Err(error) = crate::required_update_runtime::initialize(runtime_nonce).await {
        boot_fail!("required update runtime is not ready: {error:#}");
    }
    // No ACP agent has spawned yet, so no Pi process can hold a retired generation.
    crate::required_update_runtime::prune_generations();

    // Install the crypto host BEFORE any store opens (the first `global_cipher()`
    // caller is `ConversationStore::open_default` further down). This inverts the
    // extracted `ryu-crypto` primitive's two kernel couplings — profile-scoped
    // keychain suffix + `~/.ryu` dir — back into Core. Unconditional: crypto is a
    // non-optional dep (memory/chat encrypt every row in every build).
    crate::crypto_host::install();
    // Core edits `gateway.toml`; for an externally managed Gateway it must not
    // seal a secret the Gateway may have no key to open.
    ryu_gw_credentials::sealed_config::install_write_gate(
        crate::sidecar::gateway::external_config_write_gate,
    );

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

    // OpenTelemetry export seam (#539, P1): build an optional OTLP layer when an
    // endpoint is configured. A dynamic consent filter gates spans and follows
    // live `diagnostics-export-enabled` writes. Local sinks (console `fmt`, an
    // optional rotating file, and the `server/trace.rs` SQLite store) remain
    // unchanged. The provider is held in `telemetry` for the process lifetime and
    // flushed by `telemetry::shutdown()` on graceful exit.
    let otel = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => crate::telemetry::build_otlp_layer(&prefs).await,
        Err(e) => {
            crate::log_rotation::write_diagnostic(format!(
                "telemetry: could not open preferences store; OTLP export off: {e}"
            ));
            None
        }
    };
    // The provider handle is retained inside `telemetry` (for flush/shutdown);
    // only the layer is needed here.
    let otel_layer = otel.map(|(layer, _provider)| layer);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .with(crate::log_rotation::from_env())
        .with(otel_layer)
        .init();

    // Hand the extracted `ryu-tool-exec` sandbox crate Core's single-source
    // security scrubbers (untrusted-marker strip + child-env scrub) so the PTC
    // sandbox never runs with drift-prone duplicates. Idempotent; safe before any
    // request-path sandbox use.
    tool_exec::install_tool_exec_host_hooks();
    tool_exec::warm_up_sandbox();

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
}

/// Initialise panic-only crash reporting; the guard must live for all of `core_main`.
pub(super) async fn init_crash_reporting() -> Option<sentry::ClientInitGuard> {
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
    _crash_guard
}

/// Scrub inherited secrets, clean update residue and log the resolved registry.
pub(super) async fn prepare_process_environment() {
    // Mesh authkey scrub (#478, security HIGH V2): read `RYU_MESH_AUTHKEY` once
    // HERE — before ANY child process is spawned (gateway, headroom, onboarding,
    // sidecars all spawn later) — keep it in memory, and remove it from this
    // process's env. Otherwise the long-lived `tailscaled` daemon and every ACP
    // `npx`/gateway child would inherit the secret via `/proc/self/environ`. The
    // `tailscale up` enrollment reads it from a one-shot owner-only file.
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
}
