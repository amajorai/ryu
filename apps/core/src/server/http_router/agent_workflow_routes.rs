//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `agents_routes` through `hardware_ctx`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) fn agents_routes(state: &ServerState) -> Router<ServerState> {
    let app_store = &state.app_store;
    Router::new()
        .route("/api/agents", get(list_agents).post(create_agent))
        .route("/api/agents/catalog", get(list_agent_catalog))
        .route("/api/agents/catalog/install", post(install_agent_handler))
        .route(
            "/api/agents/catalog/uninstall",
            post(uninstall_agent_handler),
        )
        .route(
            "/api/agents/import",
            post(import_agent).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        // Install a PUBLISHED agent definition (CatalogKind::Agent). Sibling of
        // `/api/agents/catalog/install` above, which installs an ACP runtime.
        .route(
            "/api/agents/published/install",
            post(published_agent_install).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/agents/:id",
            get(get_agent).put(update_agent).delete(delete_agent),
        )
        .route(
            "/api/agents/:id/prompt-versions",
            get(list_agent_prompt_versions).post(create_agent_prompt_version),
        )
        .route(
            "/api/agents/:id/prompt-versions/:version_id",
            get(get_agent_prompt_version),
        )
        .route(
            "/api/agents/:id/prompt-versions/:version_id/restore",
            post(restore_agent_prompt_version),
        )
        .route(
            "/api/agents/:id/versions",
            get(list_agent_versions).post(create_agent_version),
        )
        .route(
            "/api/agents/:id/versions/:version_id",
            get(get_agent_version),
        )
        .route(
            "/api/agents/:id/versions/:version_id/restore",
            post(restore_agent_version),
        )
        .route("/api/agents/:id/export", get(export_agent))
        .route("/api/agents/:id/tools", get(list_tools))
        .route("/api/agents/:id/migrate-to-ryu", post(migrate_to_ryu))
        // ── Import a past thread from an agent's own on-disk history store
        //    (Claude Code / Codex), Zed/VS Code parity. List, then import one
        //    into a Ryu conversation. ──
        .route("/api/agents/:id/threads", get(list_agent_threads_handler))
        .route(
            "/api/agents/:id/threads/import",
            post(import_agent_thread_handler),
        )
        // ── Import agent *setup* from a scanned local folder (instructions,
        //    skills, MCP servers, plugins, Claude memories) — ChatGPT/Codex
        //    `/import` parity. Scan lists; run imports the selection. ──
        .route("/api/import/scan", post(scan_import_handler))
        .route("/api/import/run", post(run_import_handler))
        // ── ACP session config (agent-reported permission modes / models /
        //    config options like reasoning effort), Zed-style ──
        .route("/api/agents/:id/acp-config", get(acp_config))
        // ── Per-agent ACP launch + session settings (Zed `agent_servers`
        //    parity). Dedicated routes, gated on `agent.edit`, because a value
        //    becomes an executable spawn and its environment holds credentials. ──
        .route(
            "/api/agents/:id/acp-settings",
            get(get_acp_agent_settings).put(put_acp_agent_settings),
        )
        .merge(native_accounts::routes())
        .route("/api/agents/:id/authenticate", post(acp_authenticate))
        .route("/api/agents/:id/logout", post(acp_logout))
        .route("/api/agents/:id/accounts", get(acp_accounts))
        // An agent's own Composio accounts (its own identity), operator-only.
        .merge(agent_composio_api::routes())
        // Whether an agent's engine would start under its account access.
        .merge(agent_launch_check_api::routes())
        .route("/api/agents/:id/accounts/switch", post(acp_account_switch))
        .route("/api/agents/:id/accounts/remove", post(acp_account_remove))
        .route("/api/agents/:id/sessions", get(list_acp_sessions_handler))
        .route(
            "/api/agents/:id/sessions/:sid",
            delete(delete_acp_session_handler),
        )
        .route(
            "/api/agents/:id/sessions/:sid/load",
            post(load_acp_session_handler),
        )
        .route("/api/agents/:id/update-check", get(agent_update_check))
        .route("/api/agents/:id/update", post(agent_update))
        // ── Per-agent subscription usage (5h + weekly rate-limit windows read
        //    from the CLI's own local OAuth token, à la CodexBar/openusage).
        //    Backs the chat "usage bar"; Claude + Codex in v1. ──
        .route("/api/agents/:id/usage", get(usage_api::agent_usage))
        .merge(crate::usage_history::http::routes())
        .route(
            "/api/usage/subscription-costs",
            get(usage_api::subscription_cost_usage),
        )
        .route(
            "/api/usage/subscription-costs/settings",
            put(usage_api::set_subscription_cost_tracking),
        )
        // ── Subscription providers → saved accounts → usage (owner-only:
        //    account names are often email addresses). ──
        .route("/api/usage/subscriptions", get(usage_api::subscriptions))
        .route(
            "/api/usage/subscriptions/:provider_id/reading",
            get(usage_api::subscription_reading),
        )
        // Ids only (no account names), behind the conversation's read ACL.
        .route(
            "/api/conversations/:id/provider-account",
            get(usage_api::conversation_provider_account),
        )
        .route(
            "/api/providers/:id/credits",
            get(usage_api::provider_credits),
        )
        // ── Threshold-driven model fallback: the node's rule list, and the
        //    per-turn verdict the composer's info bar renders. ──
        .route("/api/routing/advice", get(routing_api::advice))
        .route(
            "/api/routing/policy",
            get(routing_api::get_policy).put(routing_api::put_policy),
        )
        // ── Reactive failover: what to do when the plan a turn is running on
        //    turns out to be out of room. Sibling of the rules above, separate
        //    config because it answers a different question (see
        //    `routing_policy::reactive`). ──
        .route(
            "/api/routing/retry-policy",
            get(routing_api::get_retry_policy).put(routing_api::put_retry_policy),
        )
        // ── Per-agent capabilities (tools / reasoning / vision), Jan-style.
        //    GET resolves auto-detection + overrides; PUT persists overrides. ──
        .route(
            "/api/agents/:id/capabilities",
            get(agent_capabilities).put(set_agent_capabilities),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            audit_agent_control,
        ))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::AGENTS_PLUGIN_ID,
                "Agents",
            ),
            require_app_enabled,
        ))
}

/// The PROTECTED workflow surface, gated on the **Workflows App** being enabled.
///
/// A governance-shell leaf: no `requires`. Pre-installed, so the gate is transparent on
/// a fresh install. This router holds ONLY the protected routes — the template
/// catalog (`/api/workflows/catalog/*`) plus the DAG CRUD (`/workflows/*`, no `/api`
/// prefix). The static `catalog` segments are registered before the `:id` DAG routes
/// so they match first (the original inline order is preserved).
///
/// The PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`) is registered on
/// the PUBLIC router (it authenticates an HMAC against the trigger's own secret
/// in-handler, which the global `require_auth` layer cannot gate). It is
/// intentionally NOT in this sub-router: gating it would break inbound triggers from
/// external systems, so it stays reachable regardless of the app's enabled bit.
///
/// Only the HTTP surface is gated — the in-process workflow executor keeps serving
/// the scheduler `JobTarget::Workflow` jobs, durable execution, healing, and
/// approvals, so it is never behind a cargo feature (the impl must always compile).
pub(in crate::server) fn workflow_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        // ── Workflow template catalog (curated, installable blueprints) ─────
        // Static `catalog` segments registered before the `:id` workflow routes.
        .route("/api/workflows/catalog", get(list_workflow_templates))
        .route(
            "/api/workflows/catalog/install",
            post(install_workflow_template),
        )
        .route("/api/workflows/catalog/:id", get(get_workflow_template))
        // ── Workflows (DAG engine) ──────────────────────────────────────────
        .route("/workflows", get(list_workflows).post(create_workflow))
        .route("/workflows/:id", get(get_workflow).delete(delete_workflow))
        // Workflow version history (Prompt-Studio-style, server-backed).
        .route(
            "/workflows/:id/versions",
            get(list_workflow_versions).post(create_workflow_version),
        )
        .route(
            "/workflows/:id/versions/:version_id",
            get(get_workflow_version),
        )
        .route(
            "/workflows/:id/versions/:version_id/restore",
            post(restore_workflow_version),
        )
        .route("/workflows/:id/run", post(run_workflow))
        .route("/workflows/runs/live", get(live_workflow_runs))
        .route("/workflows/runs/:run_id", get(get_workflow_run))
        .route("/workflows/runs/:run_id/resume", post(resume_workflow_run))
        .route(
            "/workflows/runs/:run_id/continue",
            post(continue_workflow_run),
        )
        .route("/workflows/runs/:run_id/history", get(workflow_run_history))
        .route("/workflows/runs/:run_id/fork", post(fork_workflow_run))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::WORKFLOWS_PLUGIN_ID,
                "Workflows",
            ),
            require_app_enabled,
        ))
}

/// The PROTECTED `/api/hardware/devices*` device-registry CRUD, gated on the
/// **Hardware App** being enabled.
///
/// A governance-shell leaf: no `requires`. Pre-installed, so the gate is transparent on
/// a fresh install. This router holds ONLY the protected device-management routes.
///
/// The PUBLIC device channel — the realtime `/api/hardware/ws` and the TRMNL
/// `/api/hardware/display/*` polling routes — is registered on the PUBLIC router
/// (they authenticate a per-device Bearer in-handler, which the global
/// `require_auth` layer cannot gate). Pairing (`/api/hardware/pair` and
/// `/api/hardware/pair/{begin,reveal,confirm,cancel}`) and
/// `/api/hardware/identity/reset` are PROTECTED (node `RYU_TOKEN`) but ungated by
/// the app bit. None of those routes are in this sub-router: gating them would
/// break device pairing and the live device link, so they stay reachable
/// regardless of the app's enabled bit.
///
/// The device-registry CRUD + the per-device dashboard binding handlers live in the
/// extracted `ryu_hardware::api` crate. Core builds the crate's `HardwareCtx` from
/// the in-process registry (`state.hardware`) + the `DashboardFeed` seam backed by
/// the `dashboards.*` capabilities (`CapabilityDashboardFeed`),
/// applies the App gate as a `route_layer`, and nests the resulting state-baked
/// `Router<()>` at `/api/hardware/devices` (byte-identical to the old direct mount:
/// the crate's relative `/`, `/:id`, `/:id/dashboard` map onto the same paths).
pub(in crate::server) fn hardware_routes(state: &ServerState) -> Router<ServerState> {
    let inner = ryu_hardware::api::devices_routes(hardware_ctx(state)).route_layer(
        middleware::from_fn_with_state(
            AppGate::new(
                &state.app_store,
                crate::plugins::builtins::HARDWARE_PLUGIN_ID,
                "Hardware Devices",
            ),
            require_app_enabled,
        ),
    );
    Router::new().nest_service("/api/hardware/devices", inner)
}

/// Build the extracted hardware surface's router state from the in-process registry
/// + a `DashboardFeed` over the `dashboards.*` capabilities (resolved per call, so a
/// disabled or swapped provider is picked up without a restart).
/// Shared by the protected device CRUD (`hardware_routes`) and the public TRMNL
/// display mount.
pub(in crate::server) fn hardware_ctx(state: &ServerState) -> ryu_hardware::api::HardwareCtx {
    ryu_hardware::api::HardwareCtx {
        hardware: state.hardware.clone(),
        dashboards: std::sync::Arc::new(
            crate::dashboard_capabilities::CapabilityDashboardFeed::new(
                crate::sidecar::capability_consumer::CapabilityConsumer::from_state(state),
            ),
        ),
        node_token: std::sync::Arc::new(crate::node_token::active_token),
    }
}
