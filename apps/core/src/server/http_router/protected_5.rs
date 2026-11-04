//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_5` through `protected_routes_5`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 5 of 6 of the protected route table (from
/// `/api/media/upload` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_5(state: &ServerState) -> Router<ServerState> {
    Router::new()
        .route(
            "/api/media/upload",
            post(media::upload_media)
                .layer(axum::extract::DefaultBodyLimit::max(media::MAX_MEDIA_BYTES)),
        )
        .route("/api/media/:file", get(media::serve_media))
        .route(
            "/api/local-content/seal",
            post(local_content_seal).layer(axum::extract::DefaultBodyLimit::max(
                LOCAL_CONTENT_BODY_LIMIT,
            )),
        )
        .route(
            "/api/local-content/open",
            post(local_content_open).layer(axum::extract::DefaultBodyLimit::max(
                LOCAL_CONTENT_BODY_LIMIT,
            )),
        )
        // User uploads → Uploads system space (ungated kernel storage, twin of
        // `/api/media/*`). Chat / editor / `ui.uploadFile` all land here.
        // Same declaration mechanism as `/api/spaces/:id/files` below: the limit and
        // the sentence a rejection prints come from one `BodyLimit`. Was a bare
        // `DefaultBodyLimit::max(uploads::MAX_UPLOAD_BYTES)`, which enforced the right
        // number but answered an over-limit body with an unexplained 413.
        .route(
            "/api/uploads",
            uploads::UPLOADS_BODY_LIMIT.apply(post(uploads::upload_file)),
        )
        // The ceilings above, as data — so a settings panel prints a number it fetched
        // instead of one it mirrored by hand.
        .route("/api/uploads/limits", get(uploads::upload_limits))
        .route("/api/uploads/:id", get(uploads::serve_upload))
        // At-rest encryption posture: master-key custody + per-store coverage.
        // Read-only and secret-free — see `server::encryption`.
        .route("/api/encryption/status", get(encryption::encryption_status))
        // ── Autoresearch data path (`/api/research/*`) is served out-of-process by
        // the `ryu-research` sidecar via the manifest `public_mount` — no in-process
        // route (see `@ryu/research`).
        // ── Git workspace status (read-only, Unit U009) ─────────────────────
        .route("/api/git/status", get(git::git_status))
        .route("/api/git/history", get(conversation_history::list))
        .route(
            "/api/git/history/import",
            post(conversation_history::import),
        )
        .route("/api/git/history/sync", post(conversation_history::sync))
        .route(
            "/api/git/history/:checkpoint_id",
            get(conversation_history::get),
        )
        .route("/api/git/file-diff", post(git::git_file_diff_authorized))
        .route(
            "/api/git/reverse-edits",
            post(git::git_reverse_edits_authorized),
        )
        // ── Git local repository initialization (Ryu Work entry point) ─────
        .route("/api/git/init", post(git::git_init_authorized))
        // ── Git branch list + switch (composer branch selector) ─────────────
        .route("/api/git/branches", get(git::git_branches))
        .route("/api/git/checkout", post(git::git_checkout_authorized))
        .route(
            "/api/git/create-branch",
            post(git::git_create_branch_authorized),
        )
        // ── Git commit + push (pinned-summary "commit & push" button) ───────
        .route(
            "/api/git/commit-push",
            post(git::git_commit_push_authorized),
        )
        // ── Git remote actions (pinned-summary pull/sync buttons) ───────────
        .route("/api/git/pull", post(git::git_pull_authorized))
        .route("/api/git/sync", post(git::git_sync_authorized))
        // ── Git pull-request creation (pinned-summary PR dialog) ────────────
        .route(
            "/api/git/pull-request",
            post(git::git_pull_request_authorized),
        )
        // ── Create a new project folder ("Start from scratch") ──────────────
        .route(
            "/api/workspace/new-folder",
            post(git::create_project_folder),
        )
        .route(
            "/api/workspace/clone",
            post(git::clone_project_folder_authorized),
        )
        .route("/api/workspace/list", get(git::list_directory))
        // ── Worktree diff (read-only, Unit U011) ────────────────────────────
        .route("/api/worktree/:run_id/diff", get(worktree_diff_handler))
        // ── Worktree status (persistent-session: is a worktree live?) ───────
        .route("/api/worktree/:run_id/status", get(worktree_status_handler))
        // ── Worktree apply (commit+merge or PR, Unit U012) ──────────────────
        .route("/api/worktree/:run_id/apply", post(worktree_apply_handler))
        // ── Gateway config read/write + status proxy (M2 / U017 / U018) ──────
        .route(
            "/api/gateway/config",
            get(gateway_get_config).put(gateway_put_config),
        )
        .route(
            "/api/gateway/phone-calls",
            get(gateway_phone_calls::list)
                .post(gateway_phone_calls::start)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/gateway/phone-calls/numbers/available",
            get(gateway_phone_calls::available_numbers),
        )
        .route(
            "/api/gateway/phone-calls/numbers",
            post(gateway_phone_calls::purchase_number).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/gateway/phone-calls/caller-id-verifications",
            post(gateway_phone_calls::verify_caller_id).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/gateway/phone-calls/:call_sid/control",
            post(gateway_phone_calls::control).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/gateway/phone-calls/:call_sid/handoff",
            post(gateway_phone_calls::handoff).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/gateway/phone-calls/:call_sid/hangup",
            post(gateway_phone_calls::hangup),
        )
        .route(
            "/api/gateway/phone-calls/:call_sid/transcript",
            get(gateway_phone_calls::transcript),
        )
        .route(
            "/api/gateway/governance",
            get(governance::get_gateway_governance),
        )
        .route(
            "/api/gateway/governance/:kind",
            put(governance::put_gateway_governance),
        )
        .route(
            "/api/gateway/org-features",
            get(governance::get_org_features),
        )
        .route("/api/hooks/management", get(hooks::get_hook_management))
        .route("/api/hooks/overrides", put(hooks::put_hook_override))
        .route("/api/gateway/status", get(gateway_status))
        // Structured Gateway doctor plus Core approval/agent-routing coverage.
        .route("/api/gateway/doctor", get(gateway_doctor))
        .route("/api/gateway/doctor/fix", post(gateway_doctor_fix))
        // ── Gateway evaluator catalog proxy (unified-evaluator system) ───────
        .route("/api/gateway/evaluators", get(gateway_get_evaluators))
        // ── Manual gateway restart (preflight/health page recovery action) ───
        .route("/api/gateway/restart", post(gateway_restart))
        // ── Local-engine admission-queue depth (batching/queue observability) ──
        .route("/api/engine/concurrency", get(engine_concurrency))
        // ── BYOK provider-key vault (Unit U026) ──────────────────────────────
        .route("/api/gateway/providers", put(gateway_set_provider))
        .route(
            "/api/gateway/web-accounts",
            get(gateway_web_accounts::gateway_web_accounts_get)
                .put(gateway_web_accounts::gateway_web_accounts_put),
        )
        .route(
            "/api/gateway/cloud-speech-accounts",
            get(gateway_cloud_speech_accounts::get)
                .put(gateway_cloud_speech_accounts::put)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/gateway/speech-settings",
            get(gateway_speech_settings::gateway_speech_settings_get)
                .put(gateway_speech_settings::gateway_speech_settings_put)
                .layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/api/gateway/providers/apply",
            post(gateway_apply_providers).layer(DefaultBodyLimit::max(2048)),
        )
        // ── Gateway eval dataset runner proxy (M4 / #180) ───────────────────
        .route("/api/gateway/evals/run", post(gateway_run_evals))
        .route("/api/gateway/evals/score", post(gateway_score_online))
        // ── Gateway OpenRouter batch resource (async inference) ──────────────
        .route(
            "/api/gateway/batches",
            get(gateway_batches_list)
                .post(gateway_batch_create)
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/gateway/batches/:id",
            get(gateway_batch_get).delete(gateway_batch_delete),
        )
        // ── Bounded local red-team campaign proxy ─────────────────────────
        .route("/api/gateway/redteam/run", post(gateway_redteam_run))
        // ── Gateway audit proxy (M4 / #177) ─────────────────────────────────
        .route("/api/gateway/audit", get(gateway_audit))
        .route("/api/usage/me", get(my_gateway_usage))
        .route("/api/gateway/audit/usage", get(gateway_audit_usage))
        .route("/api/gateway/audit/prune", post(gateway_audit_prune))
        // ── Gateway live-traffic proxy (SSE): streams the gateway's /v1/traffic
        // feed through Core so the desktop dashboard never holds the master key.
        .route("/api/gateway/traffic", get(gateway_traffic))
        // ── Gateway budget-spend proxy (M2 control-layer UX) ─────────────────
        .route("/api/gateway/budget/spend", get(gateway_budget_spend))
        // ── Canvas: ported to the `@ryu/canvas` Ryu App (Path-B companion).
        // The board is now a Space document owned by the app; there is no bespoke
        // `/api/canvases` file store any more (legacy files are imported at startup
        // by `server::canvas_migrate`). ────────────────────────────────────────
        // ── Workflows (DAG engine) + template catalog ───────────────────────
        // The ONE mount of the PROTECTED workflow surface — the DAG CRUD
        // (`/workflows/*`, no `/api` prefix) plus the template catalog
        // (`/api/workflows/catalog/*`) — in its own gated sub-router (see
        // `workflow_routes`) so the Workflows App's enabled bit governs it. The
        // PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`) is registered on
        // the PUBLIC router above and stays ungated so external systems can POST
        // triggers regardless of the app's enabled bit.
        // ── Clips (agent-native Loom/Jam → Shadow proxy) is served OUT-OF-PROCESS
        // by the `ryu-clips` sidecar via the manifest `public_mount` — no in-process
        // route merge. See `@ryu/clips` in `plugin_manifest`.
        .merge(workflow_routes(&state.app_store))
        // ── Activity feed (unified cross-module timeline) ───────────────────
        // The feed is node-wide and its storage has no user/resource owner. It
        // therefore stays available only on personal nodes until a caller-bound
        // activity store exists; the route layer is the security boundary.
        .merge(activity_routes())
        // On-demand Claude-Reflect-style usage review. It reads the existing
        // conversation/activity stores and persists only explicit privacy settings.
        .route(
            "/api/usage-review/settings",
            get(usage_review::get_settings).put(usage_review::put_settings),
        )
        .route("/api/usage-review", get(usage_review::get_review))
        // Website monitors (`/api/monitors/*`) are OUT-OF-PROCESS: the `ryu-monitors`
        // sidecar owns the surface, served + App-gated via the generic ext-proxy
        // `public_mount` (no in-process mount here). The interleaved `/api/events/*`
        // multiplex streams are a SEPARATE concern and stay on the protected chain.
        .route(
            "/api/events/notifications/stream",
            get(notifications_stream),
        )
        // App navigation requests emitted via the `host.navigate` bridge primitive.
        .route("/api/events/navigation/stream", get(navigation_stream))
        // Unified multiplex of every feature event bus over ONE connection so the
        // desktop stays within the browser's 6-per-host HTTP/1.1 budget.
        .route("/api/events/all", get(all_events_stream))
}
