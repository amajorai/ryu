//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_4` through `protected_routes_4`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 4 of 6 of the protected route table (from
/// `/api/conversations/:id/title-history` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_4(state: &ServerState) -> Router<ServerState> {
    Router::new()
        .route(
            "/api/conversations/:id/title-history",
            get(get_conversation_title_history_handler),
        )
        .route(
            "/api/conversations/:id/model-selection",
            get(get_conversation_model_selection_handler)
                .put(set_conversation_model_selection_handler),
        )
        .route(
            "/api/conversations/:id/icon",
            post(set_conversation_icon_handler),
        )
        .route(
            "/api/conversations/:id/visibility",
            post(set_conversation_visibility_handler),
        )
        .route(
            "/api/conversations/:id/access",
            get(get_conversation_access_handler).put(set_conversation_access_handler),
        )
        .route(
            "/api/conversations/:id/history-preview",
            get(conversation_history::preview).post(conversation_history::preview_custom),
        )
        .route(
            "/api/conversations/:id/git-history",
            post(conversation_history::save),
        )
        // Goal state is owned by the goal plugin's durable KV; these narrow
        // endpoints let clients inspect and control that state without sending
        // a chat turn.
        .route(
            "/api/conversations/:id/goal",
            get(get_goal_handler)
                .put(set_goal_handler)
                .delete(clear_goal_handler),
        )
        .route(
            "/api/conversations/:id/goal/pause",
            post(pause_goal_handler),
        )
        .route(
            "/api/conversations/:id/goal/resume",
            post(resume_goal_handler),
        )
        // ── Agent-UI saved templates (validated data, resource-scoped ACL) ──
        .route(
            "/api/agent-ui/templates",
            get(agent_ui_templates::list).post(agent_ui_templates::create),
        )
        .route(
            "/api/agent-ui/templates/:id",
            get(agent_ui_templates::get)
                .patch(agent_ui_templates::update)
                .delete(agent_ui_templates::delete),
        )
        // ── Prompt registry (local prompts + organization mirror) ─────────────
        .route(
            "/api/prompts",
            get(prompt_registry::list).post(prompt_registry::create),
        )
        .route("/api/prompts/sync", post(prompt_registry::sync))
        .route(
            "/api/prompts/:name",
            get(prompt_registry::get).delete(prompt_registry::delete),
        )
        .route(
            "/api/prompts/:name/versions",
            get(prompt_registry::list_versions).post(prompt_registry::commit),
        )
        .route(
            "/api/prompts/:name/versions/:version",
            get(prompt_registry::get_version),
        )
        .route("/api/prompts/:name/resolve", get(prompt_registry::resolve))
        .route(
            "/api/prompts/:name/labels/:label",
            put(prompt_registry::put_label).delete(prompt_registry::delete_label),
        )
        // ── Advisor consult bridge ────────────────────────────────────────────
        //    The loopback endpoint the declarative `advisor.consult` plugin tool
        //    (fixtures/advisor.manifest.json, an `http`-backend runnable) proxies to.
        //    Lives in Core because it resolves the `advisor-model` preference and
        //    routes a high-effort completion through the Gateway (`call_side_model`)
        //    — the model-resolution the former native `sidecar/mcp/advisor` provider
        //    did, now behind a stable HTTP seam a declarative tool can reach.
        .route("/api/advisor/consult", post(advisor_consult_handler))
        // ── Ryu Cloud hosted web search bridge ───────────────────────────────
        //    The loopback endpoint the built-in `@ryu/cloud-search` `web.search`
        //    provider (fixtures/cloud-search.manifest.json) proxies to. It attaches
        //    the node's Gateway relay credential, which never reaches a plugin.
        .route(
            "/api/cloud/web-search",
            post(cloud_web_search::cloud_web_search_handler),
        )
        // ── Predictive typing: system-wide inline autocomplete brain ──────────
        // Gated on the (opt-in) Predict app in its own sub-router. See
        // `predict_routes` — and the OPT-IN adjudication in `plugins::builtins`.
        .merge(predict_routes(&state))
        .route(
            "/api/conversations/:id/participants/:agent_id",
            axum::routing::delete(remove_participant_handler),
        )
        // ── Background-runs list + per-run trace (issues #128, #178) ────────
        .route("/api/runs", get(list_runs_handler))
        .route("/api/runs/stream", get(runs_stream))
        .route("/api/runs/:id/trace", get(trace_api::get_run_trace_handler))
        .route("/api/traces", get(trace_api::list_traces_handler))
        .route("/api/sessions", post(create_session_handler))
        .route("/api/sessions/:id", get(get_session_handler))
        .route(
            "/api/sessions/:id/status",
            post(update_session_status_handler),
        )
        .route(
            "/api/conversations/:id/sessions",
            get(list_sessions_for_conversation_handler),
        )
        // Versioned durable agent-harness projection. The legacy conversation,
        // session, approval, worktree, and chat routes remain available; this
        // mount composes them behind one session/run/event contract.
        .merge(harness::routes())
        // ── Document Spaces (the store Meetings/Whiteboard/Canvas depend on) ──
        // The ONE mount of `/api/spaces/*`. Same treatment as `/api/meetings/*`:
        // its own sub-router so a single `route_layer` can carry the App gate.
        // See `spaces_routes`.
        .merge(spaces_routes(&state.app_store))
        // Global document-link graph across every space (static prefix → own route
        // so it never collides with `/api/spaces/:id`).
        .route("/api/graph", get(get_global_graph))
        // Embedding-model config + re-index (global, not per-space → own prefix so
        // the literal segments never collide with `/api/spaces/:id`).
        .route(
            "/api/embeddings",
            post(embed_texts).layer(DefaultBodyLimit::max(MAX_EMBEDDING_REQUEST_BYTES)),
        )
        .route(
            "/api/embeddings/model",
            get(get_embedding_model).post(set_embedding_model),
        )
        .route("/api/embeddings/reindex", post(trigger_reindex))
        .route("/api/embeddings/reindex/status", get(reindex_status))
        .route("/v1/chat/completions", post(oai_chat_completions))
        .route("/api/setup/list", get(list_installed))
        .route("/api/setup/status", get(get_install_status))
        .route("/api/setup/status/:name", get(get_install_status_by_name))
        .route("/api/setup/:name/install", post(install_sidecar))
        .route("/api/setup/:name/uninstall", post(uninstall_sidecar))
        // ── Global download center (#456): unified progress + control across
        // every artifact. SSE `stream` registered before the `:id/*` routes so
        // the static segment is matched first. ─────────────────────────────────
        .route("/api/downloads", get(list_downloads))
        .route(
            "/api/downloads/history",
            get(downloads_history).delete(downloads_history_clear),
        )
        .route(
            "/api/downloads/settings",
            get(downloads_settings).put(set_downloads_settings),
        )
        .route("/api/downloads/browser-model", post(prepare_browser_model))
        .route("/api/downloads/stream", get(downloads_stream))
        .route("/api/downloads/:id/pause", post(download_pause))
        .route("/api/downloads/:id/resume", post(download_resume))
        .route("/api/downloads/:id/retry", post(download_retry))
        .route("/api/downloads/:id/cancel", post(download_cancel))
        .route("/api/downloads/:id", axum::routing::delete(download_clear))
        .route(
            "/api/setup/:name/uninstall-with-data",
            post(uninstall_sidecar_with_data),
        )
        .route("/api/setup/check/:name", get(check_installed))
        .route("/api/dependencies/check", get(check_dependencies))
        .route("/api/dependencies/install", post(install_dependencies))
        .route("/api/sidecar/status", get(sidecar_status))
        .route("/api/system/status", get(system_status))
        // Local support-access diagnostic channel (#546, P5). The diagnostics
        // endpoint is gated on the user grant + hard expiry IN the handler (so a
        // refusal is itself audited); the audit log is always readable.
        .route(
            "/api/support-access/diagnostics",
            get(support_access_diagnostics),
        )
        .route("/api/support-access/audit", get(support_access_audit))
        // Consented OTLP destination check: one `ryu.test` span, then a flush.
        .route(
            "/api/diagnostics/otlp/test-span",
            post(diagnostics_otlp_test_span),
        )
        .route("/api/sidecar/start-all", post(sidecar_start_all))
        .route("/api/sidecar/stop-all", post(sidecar_stop_all))
        .route("/api/sidecar/:name/start", post(sidecar_start))
        .route("/api/sidecar/:name/stop", post(sidecar_stop))
        .route("/api/sidecar/:name/restart", post(sidecar_restart))
        .route(
            "/api/engine/active",
            get(get_active_engine).post(set_active_engine),
        )
        // Which llama.cpp BUILD runs (CPU vs an accelerated one). Distinct from
        // the engine swap above: that picks the runtime, this picks the backend
        // the runtime was compiled against. Auto by default.
        .route(
            "/api/engine/llamacpp/acceleration",
            get(get_llamacpp_acceleration).post(set_llamacpp_acceleration),
        )
        // Sandbox (code-execution) backend default. Unlike the engine swap, this
        // is a *default* the agent's `sandbox_exec` tool uses when no per-call
        // backend is given — backends coexist, they are not mutually exclusive.
        .route(
            "/api/sandbox/backend",
            get(get_sandbox_backend).post(set_sandbox_backend),
        )
        // Active *served model* (which installed GGUF the local engine loads),
        // distinct from the active engine runtime above. Backs the deep-link
        // "switch" / "Use this model" flow.
        .route(
            "/api/models/active",
            get(get_active_model).post(set_active_model),
        )
        // ── Voice engine data path (STT/TTS) ─────────────────────────────────
        // Gated on the (pre-installed) Voice app in its own sub-router (see
        // `voice_routes`). The PUBLIC realtime voice WS (`/api/voice/ws`) stays on the
        // public router, ungated (browser WS, auth-in-handler).
        .merge(voice_routes(&state.app_store))
        // ── Fine-tuning `/api/finetune/*` is now served OUT-OF-PROCESS by the
        //    `ryu-finetune` sidecar via the manifest `public_mount` (generic ext-proxy
        //    loader) — no in-process route merge. The sidecar owns `finetune.db`, the
        //    adapter catalog, and the Python `unsloth` worker. See `@ryu/finetune`.
        // ── Continual-learning loop (experience buffer + PRM + skill synthesis) ──
        // The ONE mount of `/api/learn/*` + `/api/experience/list`, in its own gated
        // sub-router (see `learning_routes`) so the Learning App's enabled bit
        // governs it. Learning `requires` the Skills app (it writes skills).
        .merge(learning_routes(&state.app_store))
        // ── Recursive-improvement records ──────────────────────────────────
        // Core owns the durable run and lifecycle; Learning/Research only carry
        // the optional correlation reference and their own domain state.
        .merge(improvement_api::routes())
        // ── Agent optimizer: history-backed model/tool recommendations. Core
        //    reads the agent's sessions and applies changes; the Gateway eval
        //    runner measures candidates. See `optimizer_api`. ──
        .merge(optimizer_api::routes())
        // ── Self-healing is OUT-OF-PROCESS: the `/api/healing/*` surface is served by
        // the `ryu-healing` sidecar via `public_mount`; it receives `core#run.failed`
        // and acts through kernel capabilities (`app_runs`). No in-process mount.
        // ── Generative-media producers (image/video/gif) ─────────────────────
        // Gated on the (pre-installed) Media app in its own sub-router (see
        // `media_routes`). The shared no-cloud blob store below (`/api/media/upload` +
        // `/api/media/:file`) stays UNGATED kernel storage — it still serves TTS audio
        // and legacy media URLs. User chat/editor uploads go to `/api/uploads`.
        .merge(media_routes(&state.app_store))
}
