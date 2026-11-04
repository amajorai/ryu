//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_6` through `protected_routes_6`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 6 of 6 of the protected route table (from
/// `/api/notifications/stream` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_6(state: &ServerState) -> Router<ServerState> {
    Router::new()
        // ── App-inbox notifications (user-scoped ping feed) ─────────────────
        // Static `stream` + `push-tokens` registered before `:id/*` so they
        // match first.
        .route(
            "/api/notifications/stream",
            get(notifications_api::notifications_stream),
        )
        .route(
            "/api/notifications/push-tokens",
            post(notifications_api::register_push_token),
        )
        .route(
            "/api/notifications/push-tokens/:token",
            delete(notifications_api::remove_push_token),
        )
        .route(
            "/api/notifications",
            get(notifications_api::list_notifications),
        )
        .merge(mention_target_routes(&state.app_store))
        .route(
            "/api/notifications/:id/read",
            post(notifications_api::read_notification),
        )
        .route(
            "/api/notifications/:id/ack",
            post(notifications_api::ack_notification),
        )
        .route(
            "/api/notifications/:id/archive",
            post(notifications_api::archive_notification),
        )
        .route(
            "/api/notifications/:id/unarchive",
            post(notifications_api::unarchive_notification),
        )
        // ── Approval inbox (human-in-the-loop) ──────────────────────────────
        // The ONE mount of `/api/approvals/*`, in its own gated sub-router (see
        // `approvals_routes`) so the Approvals App's enabled bit governs it.
        .merge(approvals_routes(&state.app_store))
        // ── Quests `/api/quests/*` is now served OUT-OF-PROCESS by the
        //    `ryu-quests` sidecar via the manifest `public_mount` (generic ext-proxy
        //    loader) — no in-process route merge. The sidecar owns `quests.db` and
        //    the detection engine; Core reaches its scheduler couplings only through
        //    the `quests.*` capabilities (`scheduler::legacy_quest_jobs`, frozen
        //    until Quests moves onto the generic `jobs.*` contract). See `@ryu/quests`.
        // ── Home dashboards (customizable live widget grid) ─────────────────
        // OUT-OF-PROCESS: `/api/dashboards/*` is served by the `ryu-dashboards`
        // sidecar via the manifest `public_mount` (generic ext-proxy loader) — no
        // in-process route merge. The sidecar owns `dashboards.db` + the refresh
        // loop; Core reaches its hardware-render + builder couplings only through
        // the `dashboards.*` capabilities (`dashboard_capabilities`).
        // ── Meeting notes (record → live transcript → AI notes) ─────────────
        // OUT-OF-PROCESS: `/api/meetings/*` is served by the `ryu-meetings` sidecar
        // via the manifest `public_mount` (generic ext-proxy loader) — no in-process
        // route merge. The sidecar owns `meetings.db` + the engine/audio pipeline;
        // Core reaches its hardware-ambient and data-admin couplings only through
        // the `meetings.*` / `data.*` capabilities. See `@ryu/meetings`.
        // ── Hardware device registry (management; protected) ────────────────
        // The realtime `/api/hardware/ws` + TRMNL `/api/hardware/display/*` routes
        // are PUBLIC (registered on the public router above). Pairing is protected
        // because it mints a durable device credential. Only these PROTECTED
        // device-registry CRUD routes
        // are gated on the Hardware App, in their own sub-router (see `hardware_routes`).
        .merge(hardware_routes(&state))
        // ── Sub-agent delegation (clean context, presets, caps) ─────────────
        .route("/api/delegate/stream", post(delegate_stream))
        // ── Self-update apply (headless binaries; protected) ────────────────
        .route("/api/update/apply", post(update_apply))
        .route(
            "/api/update/schedule",
            get(get_update_schedule)
                .post(schedule_update)
                .delete(cancel_update_schedule),
        )
        // ── Cross-surface preferences (theme sync: desktop ↔ island) ────────
        // SSE stream is registered before the `:key` route so the static
        // `stream` segment is matched first.
        .route("/api/preferences/stream", get(preferences_stream))
        .route(
            "/api/preferences/:key",
            get(get_preference).put(set_preference),
        )
        // Atomic add/remove for the `trusted-workspaces` preference, so two
        // windows editing the list cannot overwrite each other's change.
        // Atomic set/remove of one plugin shortcut in the `keybindings` document,
        // so two windows editing different shortcuts cannot overwrite each other.
        .route("/api/keybindings/entry", post(edit_keybinding_entry))
        .route("/api/workspace-trust/trust", post(trust_workspaces))
        .route("/api/workspace-trust/untrust", post(untrust_workspace))
        // ── Safe Mode (the OS-style "boot with extensions off" switch) ──────
        // Its own routes rather than a bare preference read, because the GET has
        // to report which of the three tiers turned it on (an env-forced node
        // cannot be switched off from the UI) plus the suppressed counts that make
        // it a diagnostic, and the PUT has to write the sentinel file alongside
        // the preference so the next boot is safe even if this process never
        // comes back up.
        .route("/api/safe-mode", get(get_safe_mode).put(set_safe_mode))
        // Capability binding overrides (which provider serves a capability when 2+ apps provide it).
        .route(
            "/api/capabilities/bindings",
            get(get_capability_bindings).put(set_capability_bindings),
        )
        // The layer picker's read model: every capability, its candidate providers,
        // and which one is currently selected.
        .route("/api/capabilities", get(list_capabilities))
        // What the BOUND `document.parse` backend can read right now — its formats,
        // its missing native tools, and the byte ceiling it enforces.
        //
        // Registered HERE and not in `spaces_routes` on purpose: the same bound
        // provider serves chat attachments, so a node with the Spaces app disabled
        // must still be able to answer "can this machine read a PDF?". It is the
        // sole data source for the desktop's Document parsing panel and for the
        // composer's file-picker `accept` list; while it was unregistered the panel
        // read `null` and silently rendered neither.
        //
        .route(
            "/api/documents/parse/capability",
            get(crate::document_parse::parse_capability),
        )
        // Submit → poll extraction for clients (the SDK's document loaders send
        // local PDF/Office files here). The POST carries raw bytes, so it needs its
        // own body limit: axum's implicit 2 MiB default would refuse a document in
        // the layer before the handler could name the real ceiling.
        .route(
            "/api/documents/parse",
            uploads::DOCUMENT_PARSE_BODY_LIMIT.apply(post(crate::document_parse::parse_document)),
        )
        .route(
            "/api/documents/parse/jobs/:job_id",
            get(crate::document_parse::parse_job),
        )
        // ── Email transport (BYO SMTP sink config + test send) ──────────────
        .route(
            "/api/email/transport",
            get(get_email_transport).put(put_email_transport),
        )
        .route("/api/email/test", post(post_email_test))
        .route(
            "/api/alerts/delivery",
            get(get_alert_delivery).put(put_alert_delivery),
        )
        // ── Self-host Agent Inboxes (receive/store/send agent mail) ──────────
        // Merged below (before the `.layer(...)` stack) so the `mail` feature can
        // gate it while still inheriting require_auth/attach_verified_caller.
        // ── Ghost recipes (`/api/recipes/*`) are served OUT-OF-PROCESS by the
        // `ryu-recipes` sidecar via the manifest `public_mount` (no in-process
        // merge); Core links none of it. See `@ryu/recipes`.
        // ── Scheduled jobs / heartbeat ──────────────────────────────────────
        .route("/heartbeat/jobs", get(list_jobs).post(create_job))
        .route(
            "/heartbeat/jobs/:id",
            get(get_job).put(update_job).delete(delete_job),
        )
        .route("/heartbeat/jobs/:id/run", post(run_job_now))
        // Connected-client presence (the "who's on this node" surface). Read by
        // the desktop NodeSelector; populated by `track_connection` below.
        .route("/api/connections", get(list_connections))
        // Live remote (billable) sandbox runs on this node, for the NodeSelector.
        // GET is read-only visibility (populated by the sandbox metering
        // heartbeat); POST/DELETE launch/stop persistent Daytona workspaces and
        // are RYU_TOKEN-only (desktop-auth; the GET-scoped JWT carve-out does not
        // reach them).
        .merge(cloud_environments::routes())
        .merge(cloud_tasks::routes())
        .merge(session_box::routes())
        .merge(security_key_relay::routes())
        .merge(subscription_cloud::routes())
        .route("/api/sandboxes", get(list_sandboxes).post(create_sandbox))
        .route("/api/sandboxes/:run_id/exec", post(exec_sandbox))
        .route("/api/sandboxes/:run_id", delete(destroy_sandbox))
        // Data folder ("Storage" setting): read location, validate/switch (point-only),
        // reset to default, export a backup zip. Copy-migrate + import run offline as
        // the `ryu-core data-path` subcommand.
        .route("/api/data-path", get(data_path_api::get_data_path))
        .route(
            "/api/data-path/validate",
            post(data_path_api::validate_data_path),
        )
        .route(
            "/api/data-path/switch",
            post(data_path_api::switch_data_path),
        )
        .route("/api/data-path/reset", post(data_path_api::reset_data_path))
        .route(
            "/api/data-path/export",
            post(data_path_api::export_data_path).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        // ── Shadow proxy (`/api/shadow/*`) ──────────────────────────────────
        // The desktop webview's companion/review/search surfaces reach the
        // device-local Shadow through Core: Shadow's own HTTP surface is
        // bearer-gated and 403s every browser (Origin-bearing) request, so this
        // authenticated allowlisted proxy is the ONLY webview lane to Shadow
        // data. See `server::shadow_proxy`.
        .merge(shadow_proxy::routes())
        // ── Telegram managed-bot pairing (`/api/channels/managed-bot/*`) ─────
        // Creates a per-user Telegram bot through Ryu's manager bot so the user
        // never visits @BotFather. The claimed token is written to the SAME
        // channel config a pasted token goes to, so the child bot runs on the
        // untouched adapter. See `server::managed_bot_api`.
        .merge(managed_bot_api::routes())
}
