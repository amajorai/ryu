//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `approvals_routes` through `retrieval_routes`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The `/api/approvals/*` surface, gated on the **Approvals App** being enabled.
///
/// A governance-shell leaf. Approvals declares no `requires` (the workflow dependency
/// is soft); it is the dependency *target* of Healing (`requires.apps =
/// [@ryu/approvals]`). Pre-installed, so the gate is transparent on a fresh install.
/// Static `events`/`mode` are registered before `:id` so they match first.
///
/// Only the HTTP surface is gated — the in-process `state.approvals`
/// [`ApprovalEngine`] keeps serving the scheduler `require_approval` jobs, workflow
/// approval nodes, and the self-healing fix queue.
pub(in crate::server) fn approvals_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/approvals/events", get(approvals_api::approval_events))
        .route(
            "/api/approvals/mode",
            get(approvals_api::get_mode).put(approvals_api::set_mode),
        )
        .route("/api/approvals", get(approvals_api::list_approvals))
        .route("/api/approvals/:id", get(approvals_api::get_approval))
        .route(
            "/api/approvals/:id/approve",
            post(approvals_api::approve_approval),
        )
        .route(
            "/api/approvals/:id/reject",
            post(approvals_api::reject_approval),
        )
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::APPROVALS_PLUGIN_ID,
                "Approvals",
            ),
            require_app_enabled,
        ))
}

/// The human mention directory is an Inbox-owned read. Keeping it in a small
/// gated router means disabling Inbox removes both the picker data and its
/// notification bridge without changing the ordinary notification feed routes.
pub(in crate::server) fn mention_target_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route(
            "/api/notifications/mention-targets",
            get(notifications_api::mention_targets),
        )
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::APPROVALS_PLUGIN_ID,
                "Inbox",
            ),
            require_app_enabled,
        ))
}

/// The `/api/learn/*` + `/api/experience/list` surface, gated on the **Learning App**
/// being enabled.
///
/// A governance-shell leaf. Learning `requires` the `skills` app because it writes
/// synthesized skills, so the graph refuses to disable Skills out from under it.
/// Pre-installed ([`crate::plugins::builtins::CORE_PREINSTALLED`]), so on any install with
/// no prior record — fresh or upgraded — the seed enables it and the gate is
/// transparent. It is NOT transparent for a user who deliberately disabled the app;
/// that is the point of the gate.
///
/// Only the HTTP surface is gated — the scheduler keeps running its
/// `JobTarget::LearningCycle` job, whose `run_skills_pass` leg is gated purely on
/// `learning.skills-enabled` (default ON) and so synthesizes skills from real
/// conversations regardless of this record; the in-process `state.experience`
/// [`ExperienceStore`] likewise keeps capturing `(user, assistant)` turns, though
/// only on the feedback path and only under `learning.enabled` (default OFF).
/// That asymmetry is why the app is pre-installed: it owns the consent switches
/// (`contributes.settings_tabs`), so hiding the record would hide the control while
/// the capture it governs kept running.
pub(in crate::server) fn learning_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/learn/config", get(learning::config))
        .route("/api/learn/sweep", post(learning::sweep))
        .route("/api/learn/score", post(learning::score))
        .route("/api/learn/synthesize", post(learning::synthesize))
        .route("/api/learn/cycle", post(learning::cycle))
        .route("/api/learn/merge", post(learning::merge))
        .route("/api/learn/exclude", post(learning::exclude))
        .route(
            "/api/learn/exclude/{conversation_id}",
            get(learning::exclusion),
        )
        .route("/api/experience/list", get(learning::list))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::LEARNING_PLUGIN_ID,
                "Learning",
            ),
            require_app_enabled,
        ))
}

// The `/api/healing/*` surface moved OUT-OF-PROCESS to the `ryu-healing` sidecar
// (`@ryu/healing`), served via the manifest `public_mount` (generic ext-proxy
// loader) and gated on the Self-Healing App there. There is no in-process
// `healing_routes` fn: the diagnose→propose engine, the attempt cap, the `healing.*`
// prefs, and the config/status handlers all live in the sidecar. Core raises
// `core#run.failed` (`crate::run_failures`) and the sidecar applies its verdicts
// through the run-recovery kernel capabilities (`app_runs`). The former Core-side
// `simulate-failure` debug hook is dropped (the real bus path — flip a conversation
// to `failed` — still raises the event through `run_failures::spawn_bus_listener`).

// The `/api/clips/*` surface moved OUT-OF-PROCESS to the `ryu-clips` sidecar
// (`@ryu/clips`), served via the manifest `public_mount` (generic ext-proxy
// loader). There is no in-process `clips_routes` fn or `CoreClipsHost` shim — the
// sidecar reads `RYU_SHADOW_URL` itself and degrades the two `ClipsHost` kernel
// couplings (yt-dlp URL ingest + `Clips`-Space filing) cleanly.

// Recipes `/api/recipes/*` is served OUT-OF-PROCESS by the `ryu-recipes` sidecar
// (manifest `public_mount`, generic ext-proxy loader — the enabled-gate the old
// `recipes_routes` AppGate applied now runs in `public_mount_proxy`). There is no
// in-process route merge, no `recipes` cargo feature, and NO `ryu-recipes`
// dependency. Two lanes reach the one shared MCP registry: the workflow executor's
// `Recipe`/`GhostAction` nodes call Core's built-in `GHOST_RUN_TOOL` directly, and
// the sidecar proxies back through `/api/host/capability/ghost.*` (`recipes_host`
// → `recipes_host::CoreRecipesHost`, which also holds the recorder subprocess).
// NOTE: the executor lane is NOT enabled-gated — a `Recipe` node replays even with
// the app disabled. Pre-existing (the gate only ever covered the HTTP surface).

/// The `/api/predict/*` surface, gated on the **Predict App** being enabled.
///
/// A governance-shell leaf like Meetings/Spaces, but the Predict app is **opt-in**
/// (NOT in [`crate::plugins::builtins::CORE_PREINSTALLED`]): enabling it flips the
/// system-wide predictive-typing brain ON (`main.rs` seeds
/// `predict::set_enabled(rec.enabled)` at boot), which sends text from arbitrary apps
/// to a model. The codebase ships it OFF by design, so the gate is fail-closed here —
/// a disabled/never-installed Predict app returns 503 on the whole `/api/predict/*`
/// surface, matching the already-off brain. This is correct AND breaks no working
/// install: the brain is not pre-installed, so any install where predict actually works
/// already has the record enabled → the gate passes.
///
/// The `predict::PREDICT_PLUGIN_ID` const is `"predict"` (its fixture id + any existing
/// records), reused here so no record is orphaned.
///
/// The completion engine + handlers now live in the extracted `ryu_predict` crate.
/// Core builds the crate's `PredictCtx` from a `CorePredictHost` (the plugin-owned
/// enabled flag + preferences + agent-bound-model + default-model + Gateway
/// side-model call, over `ServerState`), applies the App gate as a `route_layer`,
/// and nests the resulting state-baked `Router<()>` at `/api/predict` (axum
/// registers the bare prefix, so `/api/predict` itself matches — byte-identical to
/// the old direct mounts of `/api/predict/{config,complete}`).
pub(in crate::server) fn predict_routes(state: &ServerState) -> Router<ServerState> {
    let host = std::sync::Arc::new(crate::predict_host::CorePredictHost::new(state.clone()));
    let inner = ryu_predict::routes(ryu_predict::PredictCtx::new(host)).route_layer(
        middleware::from_fn_with_state(
            AppGate::new(
                &state.app_store,
                crate::predict::PREDICT_PLUGIN_ID,
                "Predict",
            ),
            require_app_enabled,
        ),
    );
    Router::new().nest_service("/api/predict", inner)
}

/// The protected `/api/voice/*` data path, gated on the (pre-installed) **Voice App**.
///
/// Governance-shell leaf: the `voice` module stays in-crate (the chat/island paths
/// call it in-process). Only the protected STT/TTS routes are gated; the PUBLIC
/// realtime voice WS (`/api/voice/ws`) stays on the public router, ungated — a browser
/// WS upgrade authenticates in-handler, so live voice mode connects regardless of the
/// app's enabled bit. Pre-installed, so the gate is transparent on a fresh install.
pub(in crate::server) fn voice_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        // STT — proxies audio to whisper.cpp.
        .route("/api/voice/transcribe", post(voice::transcribe))
        // Speech Processing — optional post-ASR cleanup, served by the dedicated
        // lazy S1-mini llama.cpp sidecar.
        .route(
            "/api/voice/speech-processing-engines",
            get(voice::speech_processing_engines),
        )
        .route(
            "/api/voice/speech-processing-model/install",
            post(voice::speech_processing_model_install),
        )
        .route(
            "/api/voice/speech-processing",
            post(voice::speech_processing),
        )
        // TTS — OuteTTS (built-in) or `?engine=` via the universal Ryu TTS sidecar.
        .route("/api/voice/speak", post(voice::speak))
        .route("/api/voice/tts-engines", get(voice::tts_engines))
        .route(
            "/api/voice/tts-engines/install",
            post(voice::tts_engines_install),
        )
        // Curated, installable TTS model catalog + install via the Core-managed HF
        // cache. Distinct from the raw HF text-to-speech browse in the Models tab.
        .route("/api/voice/tts-models", get(voice::tts_models))
        .route(
            "/api/voice/tts-models/install",
            post(voice::tts_models_install),
        )
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::VOICE_PLUGIN_ID,
                "Voice",
            ),
            require_app_enabled,
        ))
}

/// The generative-media PRODUCERS, gated on the (pre-installed) **Media App**.
///
/// Governance-shell leaf: the `media`/`gifs` modules stay in-crate. Only the producers
/// (image/video/gif) are gated; the shared no-cloud blob store (`/api/media/upload` +
/// `/api/media/:file`) stays UNGATED kernel storage in the main protected chain — it
/// still serves TTS audio and legacy media URLs. New user uploads (chat / editor /
/// `ui.uploadFile`) go to `/api/uploads` → the Uploads system space instead.
pub(in crate::server) fn media_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/gifs/search", get(gifs::search))
        .route("/api/assets/images/search", get(images::search))
        .route(
            "/api/images/generate",
            post(media::generate_image).layer(DefaultBodyLimit::max(
                media::MAX_IMAGE_GENERATION_BODY_BYTES,
            )),
        )
        .route(
            "/api/video/generate",
            post(media::generate_video)
                .layer(DefaultBodyLimit::max(media::MAX_MEDIA_JOB_BODY_BYTES)),
        )
        // Poll a cloud video-generation job (job-based; see media::generate_video).
        .route("/api/video/jobs/:id", get(media::poll_video_job))
        // Music and sound-effect generation (cloud job; see media::generate_audio).
        .route(
            "/api/audio/generate",
            post(media::generate_audio)
                .layer(DefaultBodyLimit::max(media::MAX_MEDIA_JOB_BODY_BYTES)),
        )
        .route("/api/audio/jobs/:id", get(media::poll_audio_job))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::MEDIA_PLUGIN_ID,
                "Media Generation",
            ),
            require_app_enabled,
        ))
}

/// The `/api/memory/*` long-term memory CRUD surface, gated on the (pre-installed)
/// **Memory App**.
///
/// Governance-shell leaf: the `MemoryStore` stays a `ServerState` field. Only the HTTP
/// CRUD surface is gated; the in-process chat auto-recall path is kernel and never
/// HTTP-loops back through `/api/memory`. Pre-installed, so the gate is transparent on a
/// fresh install.
pub(in crate::server) fn memory_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/memory", get(list_memory).post(create_memory))
        .route(
            "/api/memory/settings",
            get(get_memory_settings).put(update_memory_settings),
        )
        .route("/api/memory/graph", get(get_memory_graph))
        .route(
            "/api/memory/:id",
            get(get_memory).put(update_memory).delete(delete_memory),
        )
        .route("/api/memory/git/trace", get(memory_git::trace))
        .merge(memory_dream::routes())
        .merge(memory_reflect::routes())
        .merge(memory_working::routes())
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::MEMORY_PLUGIN_ID,
                "Memory",
            ),
            require_app_enabled,
        ))
}

/// The message-reactions persistence surface, gated on the **Message Reactions
/// plugin**. The renderer remains native to the desktop, while the lifecycle bit
/// controls whether its Core-backed data path is reachable.
pub(in crate::server) fn message_reaction_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route(
            "/api/conversations/:id/reactions",
            get(get_conversation_reactions_handler),
        )
        .route(
            "/api/conversations/:id/messages/:message_id/reactions",
            post(add_message_reaction_handler).delete(remove_message_reaction_handler),
        )
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::REACTIONS_PLUGIN_ID,
                "Message Reactions",
            ),
            require_app_enabled,
        ))
}

/// Saved state for generative-UI widgets. Not app-gated: `ui.render` is a
/// built-in Core tool, so its persistence follows the conversation's own access.
pub(in crate::server) fn agent_ui_state_routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/conversations/:id/ui-state",
            get(get_agent_ui_state_handler),
        )
        .route(
            "/api/conversations/:id/ui-state/:tool_call_id",
            put(put_agent_ui_state_handler),
        )
}

/// The `/api/btw` side-question and persisted side-chat surface, gated on the
/// **Side Chats plugin**. The answer implementation intentionally stays in Core:
/// it uses the shared side-model bridge and conversation store, while the plugin
/// owns discoverability, route availability, and the desktop affordances.
pub(in crate::server) fn side_chat_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/btw", post(btw_handler))
        .route("/api/btw/:id", axum::routing::delete(delete_btw_handler))
        .route("/api/conversations/:id/btw", get(list_btw_handler))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::SIDE_CHATS_PLUGIN_ID,
                "Side Chats",
            ),
            require_app_enabled,
        ))
}

/// The `/api/retrieval/*` index+search surface, gated on the (pre-installed) **RAG App**.
///
/// Retrieval is the RAG capability's HTTP surface (it operates on `state.retrieval`),
/// so it reuses the existing `RAG_PLUGIN_ID` rather than minting a new app. The
/// per-handler tenancy/permission gates (`retrieval/search` refuses a tokenless caller
/// on a bound node) are unchanged — this adds only the plugin-enabled precondition.
/// Pre-installed, so the gate is transparent on a fresh install.
pub(in crate::server) fn retrieval_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .route("/api/retrieval/index", post(index_retrieval_chunk))
        .route("/api/retrieval/search", post(search_retrieval))
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(app_store, crate::plugins::builtins::RAG_PLUGIN_ID, "RAG"),
            require_app_enabled,
        ))
}
