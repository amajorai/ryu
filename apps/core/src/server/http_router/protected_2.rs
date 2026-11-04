//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_2` through `protected_routes_2`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 2 of 6 of the protected route table (from
/// `/api/plugins/:id/host/stream` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_2(state: &ServerState) -> Router<ServerState> {
    Router::new()
        // Streaming agent.run for full-page apps (governance-filtered SSE).
        .route(
            "/api/plugins/:id/host/stream",
            post(plugin_bridge_api::plugin_bridge_stream)
                .layer(DefaultBodyLimit::max(MAX_PLUGIN_HOST_STREAM_BODY_BYTES)),
        )
        // ── DEPRECATED `/api/apps*` aliases (one-release back-compat for #457) ──
        // These point at the same handlers as `/api/plugins*` and exist only so
        // clients that have not yet migrated keep working. Remove after one
        // release once all clients use `/api/plugins*`.
        .route("/api/apps", get(list_apps))
        .route("/api/apps/catalog", get(list_apps_catalog))
        .route("/api/apps/install", post(install_app_from_url))
        .route(
            "/api/apps/lifecycle-capabilities",
            get(app_lifecycle_capabilities),
        )
        .route("/api/apps/reload", post(reload_app_manifests))
        .route("/api/apps/:id/install", post(install_app_handler))
        .route("/api/apps/:id/enable", post(enable_app_handler))
        .route("/api/apps/:id/grants", post(set_app_grants_handler))
        .route("/api/apps/:id/disable", post(disable_app_handler))
        .route("/api/apps/:id/uninstall", post(uninstall_app_handler))
        .route("/api/apps/:id/update", post(update_app_handler))
        .route(
            "/api/apps/:id/rollback",
            post(plugin_rollback::rollback_app_handler),
        )
        // Generic per-app document surface: an app's docs live in its seeded system
        // Space, kind-isolated as `app:<id>`. Lets an app-owned sidebar section list +
        // create its docs declaratively (a `sidebar_sections` `source`/`create`)
        // instead of the shell hardcoding a Canvas/Whiteboard section + the plugin-host
        // bridge. GET → `{ documents: [{ id, title, space_id, updated_at }] }`; POST
        // (`{ title? }`) → `{ id, space_id }`.
        .route(
            "/api/apps/:id/docs",
            get(list_app_docs).post(create_app_doc),
        )
        // ── Agents (catalog + CRUD + ACP session management) ────────────────
        // The ONE mount of the `/api/agents/*` catalog/CRUD/session surface, in its
        // own gated sub-router (see `agents_routes`) so the Agents App's enabled bit
        // governs it. The app is LOAD-BEARING (the composer fetches this list on
        // boot), so it can never actually be disabled — the gate is transparent. The
        // ACP routing/execution substrate that serves a chat turn (`agent_routing/`,
        // `sidecar/adapters/acp.rs`, `/api/chat/stream`) is kernel and is NOT here.
        .merge(agents_routes(&state))
        // Prompt Studio's Promptfoo-compatible suites, immutable snapshots,
        // persisted evaluation runs, and human review are Core-owned resources.
        // The handlers resolve the suite's agent before applying the agent ACL,
        // so a suite id cannot be used to cross an agent boundary.
        .route(
            "/api/prompt-suites",
            get(list_prompt_suites).post(create_prompt_suite),
        )
        .route(
            "/api/prompt-suites/:id",
            get(get_prompt_suite)
                .put(update_prompt_suite)
                .delete(delete_prompt_suite),
        )
        .route(
            "/api/prompt-suites/:id/versions",
            get(list_prompt_suite_versions).post(create_prompt_suite_version),
        )
        .route(
            "/api/prompt-suites/:id/versions/:version_id",
            get(get_prompt_suite_version),
        )
        .route(
            "/api/prompt-suites/:id/versions/:version_id/restore",
            post(restore_prompt_suite_version),
        )
        .route("/api/prompt-suites/:id/traces", post(import_prompt_trace))
        .route(
            "/api/prompt-suites/:id/runs",
            get(list_prompt_runs).post(save_prompt_run),
        )
        .route(
            "/api/prompt-suites/:id/runs/:run_id",
            get(get_prompt_run)
                .put(rename_prompt_run)
                .delete(delete_prompt_run),
        )
        .route(
            "/api/prompt-suites/:id/runs/:run_id/duplicate",
            post(duplicate_prompt_run),
        )
        .route(
            "/api/prompt-suites/:id/runs/:run_id/reviews",
            get(list_prompt_reviews).post(save_prompt_review),
        )
        // Shared, idempotent agent-root import/export ledger. The sync surface is
        // separate from `/api/import/*` so automatic reconciliation and the
        // Gateway tabs share one operation lineage and one duplicate-root guard.
        .merge(agent_sync::routes())
        // Human annotation queues (agent-scoped review of runs/traces).
        .merge(annotation_queues_api::routes())
        // ── Ryu-managed Pi config (isolated model/provider config) ──
        .route("/api/pi-config", get(get_pi_config).put(put_pi_config))
        .route("/api/pi-config/catalog", get(get_pi_config_catalog))
        .route("/api/pi-config/providers", post(configure_pi_provider))
        .route("/api/pi-config/providers/check", post(check_pi_provider))
        .route(
            "/api/pi-config/providers/model-enabled",
            post(set_pi_model_enabled),
        )
        .route("/api/pi-config/providers/:id", delete(delete_pi_provider))
        .route(
            "/api/pi-config/providers/:id/login",
            post(start_pi_provider_login),
        )
        .route(
            "/api/pi-config/chatgpt/codex/responses",
            post(chatgpt_api::responses),
        )
        .route(
            "/api/pi-config/chatgpt/codex/models",
            get(chatgpt_api::models),
        )
        .route(
            "/api/pi-config/chatgpt-plan/responses",
            post(chatgpt_plan_api::responses),
        )
        .route(
            "/api/pi-config/chatgpt-plan/models",
            get(chatgpt_plan_api::models),
        )
        .route(
            "/api/pi-config/claude/v1/messages",
            post(claude_api::messages).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/pi-config/kiro/v1/chat/completions",
            post(kiro_api::completions).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/pi-config/kiro/v1/models", get(kiro_api::models))
        .route(
            "/api/pi-config/qoder/v1/chat/completions",
            post(qoder_api::global_completions).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/pi-config/qoder/v1/models",
            get(qoder_api::global_models),
        )
        .route(
            "/api/pi-config/qoder-cn/v1/chat/completions",
            post(qoder_api::cn_completions).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/pi-config/qoder-cn/v1/models",
            get(qoder_api::cn_models),
        )
        .route(
            "/api/pi-config/providers/:id/accounts",
            get(pi_provider_accounts),
        )
        .route(
            "/api/pi-config/providers/:id/accounts/:account_id/usage",
            get(usage_api::provider_account_usage),
        )
        .route(
            "/api/pi-config/providers/:id/account-pool",
            get(oauth_pool_policy::get_policy).put(oauth_pool_policy::put_policy),
        )
        .route(
            "/api/pi-config/providers/:id/accounts/switch",
            post(pi_provider_account_switch),
        )
        .route(
            "/api/pi-config/providers/:id/accounts/rename",
            post(pi_provider_account_rename),
        )
        .route(
            "/api/pi-config/providers/:id/accounts/remove",
            post(pi_provider_account_remove),
        )
        .route(
            "/api/pi-config/login/:session/events",
            get(pi_provider_login_events),
        )
        .route(
            "/api/pi-config/login/:session/answer",
            post(answer_pi_provider_login),
        )
        .route(
            "/api/pi-config/login/:session/cancel",
            post(cancel_pi_provider_login),
        )
        .route("/api/pi-config/discover-models", post(discover_pi_models))
        // ── Agent teams (collections of agents + a coordination strategy) ──
        // `/api/teams/*` is served OUT-OF-PROCESS by the providing app's sidecar via
        // its manifest `public_mount` (generic ext-proxy loader) — no in-process
        // route merge. The `@team` chat orchestration resolves a team through the
        // `teams.resolve` capability (`crate::agent_teams`).
        .route(
            "/api/mcp/servers",
            get(list_mcp_servers).post(create_mcp_server),
        )
        .route(
            "/api/mcp/servers/:name",
            put(update_mcp_server).delete(delete_mcp_server),
        )
        .route("/api/mcp/tools", get(list_mcp_tools))
        .route("/api/mcp/tools/call", post(call_mcp_tool))
        // Canonical Actions are an action-shaped projection of the same
        // approval-aware tool dispatcher. The wildcard accepts a namespaced
        // `<plugin-id>/<action-id>` while a plain action id remains ergonomic.
        .route("/api/actions/*action_id", post(call_action))
        // Command-approval scan for callers Core cannot gate at the ACP
        // `request_permission` seam — today the flagship Pi agent's built-in
        // `bash`, via `assets/pi-extensions/ryu-plan.ts`. A thin proxy to
        // `gateway::check_exec_scan`; see `exec_scan` for why every verdict,
        // deny included, is an HTTP 200.
        .route("/api/exec/scan", post(exec_scan))
        // ── Ryu Apps widgets (governed round-trips + resources) ──────────────
        .route("/api/widgets/tools/call", post(widgets::widget_call_tool))
        .route("/api/widgets/open", post(mcp_app_extensions::open_app))
        .route("/api/widgets/follow-up", post(widgets::widget_follow_up))
        .route("/api/widgets/state", post(widgets::widget_state))
        .route("/api/mcp/resources/read", post(widgets::mcp_resources_read))
        // ── Unified tool catalog: search + describe (#474) ───────────────────
        .route("/api/tools/search", get(tools_search))
        .route("/api/tools/describe", get(tools_describe))
        // ── Programmatic tool calling sandbox (#476, P4) ──────────────────────
        .route("/api/tools/exec", post(tools_exec))
        .route("/api/tools/exec/resume", post(tools_exec_resume))
        .merge(crate::safe_actions::routes())
        // ── Identity Vault: connection lifecycle (#520) ──────────────────────
        // Status-only responses; sealed credential state is never returned.
        .route("/api/identities", get(identity_api::list_identities))
        .route(
            "/api/identities/connections",
            post(identity_api::create_connection),
        )
        .route(
            "/api/identities/connections/:id/login",
            post(identity_api::begin_login),
        )
        .route(
            "/api/identities/connections/:id/import",
            post(identity_api::import_connection),
        )
        .route(
            "/api/identities/connections/:id",
            get(identity_api::poll_connection).delete(identity_api::delete_connection),
        )
        // Secret Vault: values, versions, environments, folders, policies,
        // change requests, audit, import/export, scan, seal, and engines.
        // Values leave Core only through the audited reveal/export routes.
        .merge(vault_routes())
        // ── Private network status (#478): opt-in Tailscale/Headscale/Tailcat ──
        .route("/api/mesh/status", get(mesh_status))
        .route("/api/mesh/peers", get(mesh_peers))
        .route("/api/mesh/config", post(mesh_config))
        // ── Route a cloud node's traffic through the user's desktop ──────────
        // `desktop` is this computer's own setting (owner only); `route` is the
        // node side, which the handlers restrict to the node owner.
        .route(
            "/api/local-egress/desktop",
            get(local_egress_api::desktop_status)
                .put(local_egress_api::desktop_configure)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/local-egress/route",
            get(local_egress_api::route_status).delete(local_egress_api::route_detach),
        )
        .route(
            "/api/local-egress/route/ws",
            get(local_egress_api::route_ws),
        )
        .route(
            "/api/local-egress/route/providers",
            get(local_egress_api::provider_routes)
                .put(local_egress_api::configure_provider_route)
                .layer(DefaultBodyLimit::max(4 * 1024)),
        )
        // ── Device-code pairing (protected half) + node-token management ─────
        // Approval is deliberately behind `require_auth`: only a caller that
        // already holds a valid credential may vouch for a new one.
        .route("/api/acl/vocabulary", get(acl_vocabulary))
        .route("/api/acl/principals", get(acl_principals))
        .route("/api/acl/resources", get(acl_list_resources))
}
