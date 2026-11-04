//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_1` through `protected_routes_1`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 1 of 6 of the protected route table (from
/// `/api/node/init` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_1(state: &ServerState) -> Router<ServerState> {
    Router::new()
        .route("/api/node/init", post(node_init))
        // Cloud-account auth surface. Behind `require_auth` like every other
        // protected route: loopback dev (no RYU_TOKEN configured) passes through
        // exactly as the desktop expects, while an exposed node (mesh/non-loopback
        // bind, where RYU_TOKEN is mandatory at boot) requires the node bearer.
        // Previously on the public router, which served the active account's cloud
        // bearer token, PII, and an SSRF-able login flow to any network peer.
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/user-jwt", get(auth_user_jwt))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/accounts", get(auth_accounts_list))
        .route("/api/auth/accounts/switch", post(auth_accounts_switch))
        .route("/api/auth/accounts/remove", post(auth_accounts_remove))
        .route("/api/catalog", get(get_catalog))
        // ── Model catalog (HF browse + device-fit + install; logic in Core) ──
        .route("/api/models/catalog", get(models_catalog_list))
        // Personalized Store recommendations adapt the existing safe catalog
        // projections and never expose raw context or connection payloads.
        .merge(recommendations::routes())
        .route("/api/models/catalog/detail", get(models_catalog_detail))
        .route("/api/models/catalog/install", post(models_catalog_install))
        .route(
            "/api/models/catalog/uninstall",
            post(models_catalog_uninstall),
        )
        .route("/api/models/device", get(models_device))
        .route("/api/models/llmfit-estimate", get(models_llmfit_estimate))
        .route("/api/models/context-window", get(models_context_window))
        .route("/api/models/insight", get(models_insight))
        .route("/api/models/engines", get(models_engines))
        .route("/api/models/installed", get(models_installed))
        .route("/api/models/updates", get(models_updates))
        // Live hardware snapshot for this node (CPU/RAM/disk/GPU) — backs the
        // desktop node selector's per-node "what's this machine" view.
        .route("/api/system/info", get(system_info_handler))
        .merge(crate::fleet::routes())
        // Project-scoped agent rule discovery (Cursor, Claude, AGENTS.md).
        // This is read-only and lives behind the protected router because the
        // caller may choose any local project directory through `cwd`.
        .route("/api/rules/discover", get(rules::discover))
        // Per-model advanced launch config (#mtp-advanced-inference). The `{id}` is
        // a catalog model id and may contain a slash, so clients must
        // percent-encode it (`encodeURIComponent`); axum decodes `%2F` into the
        // single `:id` segment.
        .route(
            "/api/models/:id/launch-config",
            get(get_model_launch_config).put(set_model_launch_config),
        )
        // Per-model sampling overrides (local and cloud) plus node-level presets.
        // Same percent-encoding rule for `{id}` as launch-config above.
        .route(
            "/api/models/:id/sampling-config",
            get(get_model_sampling_config).put(set_model_sampling_config),
        )
        .route(
            "/api/inference/sampling-fields",
            get(inference_sampling_fields),
        )
        .route(
            "/api/inference/presets",
            get(list_inference_presets).post(create_inference_preset),
        )
        .route(
            "/api/inference/presets/:id",
            axum::routing::put(update_inference_preset).delete(delete_inference_preset),
        )
        // ── CatalogSource seam (#459): per-kind source listing + custom add +
        // active selection. The catalogs themselves route through these sources.
        .route(
            "/api/catalog/sources",
            get(catalog_sources_list)
                .post(catalog_sources_add)
                .delete(catalog_sources_remove),
        )
        .route(
            "/api/catalog/sources/reorder",
            post(catalog_sources_reorder),
        )
        .route("/api/catalog/sources/select", post(catalog_sources_select))
        // ── Skills (`/api/skills/*` + `/api/skills/catalog/*`) are merged as their
        // own gated sub-router (see `skills_routes`) so the Skills App's enabled bit
        // governs the whole SKILL.md discovery/authoring/catalog surface. Both route
        // blocks (catalog + CRUD/versions) live in the one fn. ──
        .merge(skills_routes(&state))
        // ── Output styles (`/api/output-styles/*`) — the style registry + authoring
        // + legacy node-default selection. UNGATED on purpose (see `output_styles_routes`):
        // a style is a Core axis like the selected model, and three of its four
        // sources are not plugins at all. ──
        .merge(output_styles_routes())
        // ── Composio catalog (browse the user's toolkits/actions/triggers using
        // their configured key; gateway still executes — see composio_catalog) ──
        .route("/api/composio/status", get(composio_status))
        .route("/api/composio/toolkits", get(composio_toolkits))
        // Merged Integrations directory (integrations.sh + Composio toolkits +
        // Treg platforms), deduped by brand slug.
        .route("/api/integrations", get(integrations_list))
        .route("/api/integrations/:id", get(integrations_get))
        .route("/api/composio/actions", get(composio_actions))
        .route("/api/composio/triggers", get(composio_triggers))
        // Composio connections — proactively connect the user's accounts to a
        // toolkit (Marketplace → Connections), ahead of any agent run.
        .route("/api/composio/connections", get(composio_connections))
        .route(
            "/api/composio/connections/initiate",
            post(composio_connection_initiate),
        )
        .route(
            "/api/composio/connections/complete",
            post(composio_connection_complete),
        )
        .route(
            "/api/composio/connections/:id",
            get(composio_connection_status),
        )
        // Composio event-trigger subscriptions (fire an agent on a Composio event).
        .route(
            "/api/composio/events/consume",
            post(connect_events::consume),
        )
        .route("/api/composio/targets", post(connect_events::bind_target))
        .route(
            "/api/composio/triggers/subscribe",
            post(composio_trigger_subscribe),
        )
        .route(
            "/api/composio/trigger-subscriptions",
            get(composio_trigger_list),
        )
        .route(
            "/api/composio/trigger-subscriptions/:id",
            delete(composio_trigger_delete),
        )
        .route("/api/engines", get(list_engines))
        .route("/api/engines/models", get(engine_models))
        .route(
            "/api/engines/:engine/launch-options",
            get(engine_launch_options),
        )
        // ── Plugin catalog browse + install-from-URL + hot-reload (#427, #428) ──
        // Static 3-segment routes registered before the parameterized
        // `/api/plugins/:id/*` routes so matchit never confuses them.
        .route("/api/plugins", get(list_apps))
        .route("/api/plugins/doctor", get(plugin_doctor))
        .route("/api/plugins/evals", get(plugin_evals))
        .route("/api/plugins/evals/run", post(plugin_evals_run))
        .route("/api/plugins/contributions", get(plugin_contributions))
        .route("/api/plugins/catalog", get(list_apps_catalog))
        .route("/api/plugins/catalog/browse", get(plugin_catalog_browse))
        .route("/api/plugins/catalog/detail", get(plugin_catalog_detail))
        .route(
            "/api/catalog/scan",
            post(catalog_scan::scan).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/plugins/catalog/version-detail",
            get(plugin_catalog_version_detail),
        )
        .route(
            "/api/plugins/catalog/channels",
            get(plugin_catalog_channels),
        )
        .route("/api/plugins/install", post(install_app_from_url))
        .route("/api/plugins/reload", post(reload_app_manifests))
        .route("/api/plugins/:plugin_id/auth", get(mcp_oauth_api::list))
        .route(
            "/api/plugins/:plugin_id/auth/:server_name/connect",
            post(mcp_oauth_api::connect),
        )
        .route(
            "/api/plugins/:plugin_id/auth/flows/:flow_id",
            get(mcp_oauth_api::flow),
        )
        .route(
            "/api/plugins/:plugin_id/auth/flows/:flow_id/confirm",
            post(crate::server::mcp_oauth_confirm_api::confirm_flow),
        )
        .route(
            "/api/plugins/:plugin_id/auth/:server_name",
            delete(mcp_oauth_api::disconnect),
        )
        .route(
            "/api/plugins/activation-event",
            post(fire_activation_event_handler),
        )
        .route(
            "/api/plugins/install-bundle",
            post(install_app_bundle).layer(DefaultBodyLimit::max(MAX_PLUGIN_BUNDLE_BYTES)),
        )
        .route(
            "/api/plugins/catalog/install",
            post(install_plugin_from_catalog),
        )
        .route(
            "/api/plugins/lifecycle-capabilities",
            get(app_lifecycle_capabilities),
        )
        // GitHub-backed portable packages. The control plane resolves the
        // signed descriptor and Marketplace proxy URL; Core verifies the
        // archive and owns the on-node package lifecycle. These routes cover
        // package kinds that are newer than the legacy CatalogKind adapters.
        .route(
            "/api/marketplace/packages/installed",
            get(marketplace_packages_installed),
        )
        .route("/api/marketplace/usage", post(record_marketplace_usage))
        .route(
            "/api/marketplace/public-catalog",
            post(refresh_public_marketplace_catalog),
        )
        .route(
            "/api/language-packs/installed",
            get(language_packs::installed),
        )
        .route(
            "/api/language-packs/import",
            post(language_packs::import).layer(DefaultBodyLimit::max(
                language_packs::MAX_LANGUAGE_PACK_IMPORT_BODY_BYTES,
            )),
        )
        .route(
            "/api/marketplace/packages/install",
            post(marketplace_package_install).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/marketplace/packages/update",
            post(marketplace_package_update).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/marketplace/packages/:kind/:id/enable",
            post(marketplace_package_enable),
        )
        .route(
            "/api/marketplace/packages/:kind/:id/disable",
            post(marketplace_package_disable),
        )
        .route(
            "/api/marketplace/packages/:kind/:id/uninstall",
            post(marketplace_package_uninstall),
        )
        // Isolation + trust report. Listed before `/:id/*` routes purely for
        // readability — axum matches the static segment regardless.
        .route("/api/plugins/isolation", get(plugins_isolation_handler))
        // The node's local plugin revocation list (local only; never synced).
        .route(
            "/api/plugins/revocations",
            get(list_plugin_revocations_handler)
                .post(revoke_plugin_handler)
                .delete(unrevoke_plugin_handler),
        )
        .route("/api/plugins/:id/install", post(install_app_handler))
        .route("/api/plugins/:id/enable", post(enable_app_handler))
        .route("/api/plugins/:id/grants", post(set_app_grants_handler))
        .route("/api/plugins/:id/disable", post(disable_app_handler))
        .route(
            "/api/plugins/:id/uninstall-data",
            get(plugin_uninstall::inventory_handler),
        )
        .route("/api/plugins/:id/uninstall", post(uninstall_app_handler))
        .route("/api/plugins/:id/update", post(update_app_handler))
        .route(
            "/api/plugins/:id/rollback",
            post(plugin_rollback::rollback_app_handler),
        )
        .route("/api/plugins/:id/ui-bundle", get(plugin_ui_bundle))
        // Per-plugin BYOK secrets (the `secret` settings-field type). GET is
        // metadata-only — it can never return a value. Protected router →
        // inherits `require_auth`.
        .route("/api/plugins/:id/secrets", get(list_plugin_secrets_handler))
        .route(
            "/api/plugins/:id/secrets/:key",
            put(put_plugin_secret_handler).delete(delete_plugin_secret_handler),
        )
        // App host-capability bridge (model.complete / agent.run / storage.*).
        // Protected router → inherits `require_auth`; grant-gated per enabled app.
        // The larger scoped limit is required for app-owned binary files carried
        // through the storage bridge as base64 (thumbnail editors are the first
        // consumer); it does not widen any other Core JSON endpoint.
        .route(
            "/api/plugins/:id/host",
            post(plugin_bridge_api::plugin_bridge_dispatch)
                .layer(DefaultBodyLimit::max(MAX_PLUGIN_HOST_BODY_BYTES)),
        )
}
