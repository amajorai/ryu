//! Core's boot sequence (`core_main`), split by phase. `main.rs` keeps the
//! crate module list, `boot_fail!` and the synchronous `main` entry point.

mod aux_stores;
mod background;
mod cli_modes;
mod core_stores;
mod engines;
mod first_run;
mod identity_vaults;
mod kernel_services;
mod network_backend;
mod plugin_boot;
mod preference_seeds;
mod process_env;
mod routing_prefs;
mod runtime_hosts;
mod scheduled_jobs;
mod serve;
mod shutdown;
mod sidecar_set;
mod startup_order;
mod state_wiring;

use aux_stores::*;
use background::*;
use cli_modes::*;
use core_stores::*;
use engines::*;
use first_run::*;
use identity_vaults::*;
use kernel_services::*;
use network_backend::*;
use plugin_boot::*;
use preference_seeds::*;
use process_env::*;
use routing_prefs::*;
use runtime_hosts::*;
use scheduled_jobs::*;
use serve::*;
use shutdown::*;
use sidecar_set::*;
use startup_order::*;
use state_wiring::*;

use crate::*;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::sidecar::{
    adapters::AcpAgentRegistry,
    agents::{HermesManager, OpenClawManager, ZeroClawManager},
    cloudflared::CloudflaredManager,
    install_state::InstallStatusStore,
    onboarding::SetupManager,
    opentunnel::OpenTunnelManager,
    plugin_tunnel::PluginTunnelManager,
    providers::{
        apfel::ApfelManager, audiocpp::AudioCppManager, llamacpp::LlamaCppClassifyManager,
        llamacpp::LlamaCppEmbedManager, llamacpp::LlamaCppGuardManager, llamacpp::LlamaCppManager,
        llamacpp::LlamaCppRerankManager, llamacpp::LlamaCppSpeechManager, mesh_llm::MeshLlmManager,
        mlx::MlxManager, mlx_serve::MlxServeManager, mlx_vlm::MlxVlmManager, ollama::OllamaManager,
        omlx::OmlxManager, outetts::OuteTtsManager, parakeet::ParakeetManager,
        ryutts::RyuTtsManager, sdcpp::StableDiffusionManager, sglang::SglangManager,
        vllm::VllmManager, whispercpp::WhisperCppManager, DockerModelRunnerManager,
    },
    tailcat::TailcatManager,
    tailscale::TailscaleManager,
    tools::{ghost::GhostManager, llmfit::LlmFit, shadow::ShadowManager},
    SidecarManager,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub(crate) async fn core_main() {
    let Some(offline_test_bootstrap) = run_cli_modes().await else {
        return;
    };

    // Keep a shared lease for the complete process lifetime, including a dev
    // facade. Recovery owns exclusive leases while copying/installing/restoring.
    let runtime_nonce = std::env::var("RYU_UPDATE_RUNTIME_NONCE").ok();
    let runtime_cache = match dirs::cache_dir() {
        Some(cache) => cache.join("ryu-update-recovery"),
        None => boot_fail!("could not resolve runtime recovery cache"),
    };
    let mut runtime_roots = vec![crate::paths::ryu_dir(), crate::paths::config_dir()];
    match crate::required_update_runtime::lifecycle_roots(
        &crate::paths::ryu_dir(),
        &crate::paths::config_dir(),
    ) {
        Ok(roots) => {
            // Freeze the discovered writable root before loading settings or
            // spawning children; config edits cannot move Pi outside its lease.
            if let Some(pi_root) = roots.first() {
                std::env::set_var("RYU_PI_AGENT_DIR", pi_root);
            }
            runtime_roots.extend(roots);
        }
        Err(error) => boot_fail!("could not discover managed Pi state: {error:#}"),
    }
    let _runtime_data_lease = match ryu_runtime_install::data_lease::admit_runtime(
        &runtime_cache,
        &runtime_roots,
        crate::profile::profile(),
        env!("CARGO_PKG_VERSION"),
        runtime_nonce.as_deref(),
    ) {
        Ok(lease) => lease,
        Err(error) => boot_fail!("update recovery blocked runtime startup: {error:#}"),
    };

    // Local development separates the replaceable API listener from the sole
    // owner of execution and stores. Do this before opening any durable state.
    match crate::dev_execution::run_if_enabled().await {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => boot_fail!("development execution host: {error:#}"),
    }
    // A facade may need to pass admission to its store-owning worker. The worker
    // consumes it here so ordinary tools never inherit recovery admission.
    std::env::remove_var("RYU_UPDATE_RUNTIME_NONCE");

    install_runtime_hosts(runtime_nonce).await;

    let _crash_guard = init_crash_reporting().await;

    prepare_process_environment().await;

    let SidecarBoot {
        setup,
        install_status,
        download_center,
        bind_addr,
        seed_names,
        sidecars,
    } = build_sidecars().await;

    let AgentRuntime {
        gateway,
        headroom,
        catalog,
        auth_state,
        agent_registry,
        agent_store,
    } = open_agent_runtime(offline_test_bootstrap).await;

    let CoreStores {
        conversations,
        memory,
        spaces,
        retrieval,
        media,
        traces,
        preferences,
    } = open_core_stores(&agent_store).await;

    let mesh_preinstall_client = resolve_safe_mode_and_network_prefs(&preferences).await;
    let support_audit = sweep_startup_state(&preferences, &conversations).await;
    seed_credential_prefs(&preferences).await;
    seed_agent_routing_prefs(&preferences, offline_test_bootstrap).await;

    // Apply the user's saved default embedding model (if any) to the Spaces store,
    // re-indexing in the background when it differs from what the store opened with.
    server::spaces::apply_saved_embedding_pref_all(
        &spaces,
        &retrieval,
        &conversations,
        &preferences,
    )
    .await;

    let PluginBoot {
        incompatible_manifests,
        app_manifests,
        app_store,
        skill_registry,
    } = load_plugins(&sidecars, offline_test_bootstrap).await;

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

    // Seal any MCP credential (header/env value) an older build or a hand edit
    // left in plaintext in mcp.json, before the registry reads the file.
    if let Err(error) =
        sidecar::mcp::McpConfigStore::seal_literals(sidecar::mcp::McpRegistry::config_path()).await
    {
        tracing::warn!("mcp.json: could not seal plaintext credentials: {error}");
    }

    // Wire self-build context into the MCP registry (U57). The registry holds
    // Arc references to the manifest store and app store so scaffold_runnable /
    // install_app / write_ryu_json can hot-install without a process restart.
    let mcp_registry = Arc::new(
        sidecar::mcp::McpRegistry::load()
            .with_self_build(Arc::clone(&app_manifests), Arc::new(app_store.clone()))
            // Wire the agent store so the `agent_builder` tools can edit agent
            // records in chat (the desktop agent-edit page's builder pane).
            .with_agent_store(agent_store.clone())
            // Wire the Core-as-consumer capability helper so
            // `agent_builder.create_agent_team` can mint a roster of agents and
            // persist them as a reusable team through the `teams.create` capability.
            .with_capabilities(
                crate::sidecar::capability_consumer::CapabilityConsumer::new(
                    Arc::clone(&sidecars),
                    Arc::clone(&app_manifests),
                    app_store.clone(),
                ),
            )
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
            .with_spaces(spaces.clone())
            // Wire the memory store so the built-in working-memory tool can
            // update an agent's scratchpad.
            .with_memory(memory.clone()),
    );

    let KernelServices {
        hardware_store,
        approval_engine,
        activity_store,
    } = start_kernel_services(
        &sidecars,
        &app_manifests,
        &app_store,
        &mcp_registry,
        &preferences,
        &skill_registry,
    )
    .await;

    open_identity_and_vaults(&mcp_registry).await;

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
    // Clone the preferences handle for the opt-out anonymous community-savings
    // beacon (ON by default) before `preferences` moves into ServerState below.
    let stats_preferences = preferences.clone();
    // And for the signed-in profile daily-activity ping (ON by default, opt-out).
    let profile_activity_preferences = preferences.clone();
    // Clone the preferences handle for the managed Ryu analytics heartbeat. It
    // starts after durable-token adoption below so the relay sees the live node
    // credential rather than a consumed bootstrap key.
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

    let AuxStores {
        collab,
        experience_store,
        improvement_store,
        agent_ui_templates,
        subscription_costs,
    } = open_aux_stores();

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
        plugin_runtime: crate::plugins::runtime::PluginRuntime::new(),
        traces,
        preferences,
        subscription_costs,
        support_audit,
        catalog_sources: Arc::new(crate::catalog_source::CatalogSourceRegistry::new()),
        downloads: download_center.clone(),
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
        experience: experience_store,
        improvements: improvement_store,
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
    wire_server_state(&server_state);
    let auth_token = crate::node_token::active_token();

    materialize_and_activate(&server_state, offline_test_bootstrap).await;

    let (router, listener) = build_router_and_listener(&server_state, auth_token, &bind_addr).await;

    spawn_edge_services(&server_state, &headroom, &bind_addr, offline_test_bootstrap);
    spawn_scheduler(scheduler_apps, offline_test_bootstrap).await;

    // Start the opt-in cross-device conversation sync loop (M10). A no-op every
    // tick until the user opts in (env `RYU_SYNC_ENABLED` or the
    // `cloud-sync-enabled` pref). OFF by default per the local-first rule, so
    // this never alters default behaviour or blocks startup.
    server::sync::spawn_sync_loop(sync_conversations, sync_spaces, sync_preferences);

    // Start the opt-out anonymous community-savings beacon. It remains inactive
    // whenever the user opts out (`community-stats-enabled=false` or
    // `RYU_COMMUNITY_STATS_ENABLED=false`) and is fail-open, so it never sends
    // identity data or blocks startup.
    stats_beacon::spawn_stats_beacon(stats_preferences);

    // Start the profile daily-activity poster. It posts at most once per UTC day
    // per signed-in account after a qualifying turn (Patrol excluded), stays
    // silent when signed out or `profile-activity-enabled=false`, and is
    // fail-open, so it never blocks startup or a turn.
    profile_activity::spawn_profile_activity(profile_activity_preferences);

    spawn_control_plane_loops(&server_state, offline_test_bootstrap).await;
    spawn_managed_node_registration(&gateway, offline_test_bootstrap);
    spawn_first_run_installs(
        &setup,
        &install_status,
        &download_center,
        &sidecars,
        offline_test_bootstrap,
    );
    prepare_network_backend(
        &setup,
        seed_names,
        &download_center,
        &sidecars,
        &install_status,
        mesh_preinstall_client,
        offline_test_bootstrap,
    )
    .await;
    start_engines(
        &sidecars,
        &gateway,
        &server_state,
        reactor_preferences,
        offline_test_bootstrap,
    );

    serve_until_shutdown(listener, router, &gateway, &headroom, &sidecars).await;
}
