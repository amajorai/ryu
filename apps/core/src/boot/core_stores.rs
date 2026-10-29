use super::*;

/// Gateway/headroom managers plus the agent registry and store.
pub(super) struct AgentRuntime {
    pub(super) gateway: Arc<sidecar::gateway::GatewayManager>,
    pub(super) headroom: Arc<sidecar::headroom::HeadroomManager>,
    pub(super) catalog: Arc<crate::catalog::CatalogManager>,
    pub(super) auth_state: Arc<Mutex<auth::AuthState>>,
    pub(super) agent_registry: Arc<AcpAgentRegistry>,
    pub(super) agent_store: crate::agents::AgentStore,
}

/// Create the gateway/headroom managers and open the agent registry and store.
pub(super) async fn open_agent_runtime(offline_test_bootstrap: bool) -> AgentRuntime {
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
    if !offline_test_bootstrap {
        crate::sidecar::agents::acp_registry::ensure_registry_cached().await;
    }
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
    AgentRuntime {
        gateway,
        headroom,
        catalog,
        auth_state,
        agent_registry,
        agent_store,
    }
}

/// The durable stores every Core surface shares.
pub(super) struct CoreStores {
    pub(super) conversations: server::conversations::ConversationStore,
    pub(super) memory: server::memory::MemoryStore,
    pub(super) spaces: server::spaces::SpaceStore,
    pub(super) retrieval: server::retrieval::RetrievalStore,
    pub(super) media: server::media::MediaStore,
    pub(super) traces: ryu_tracing::TraceStore,
    pub(super) preferences: server::preferences::PreferencesStore,
}

/// Open the conversation, memory, Spaces, retrieval, media, trace and preference stores.
pub(super) async fn open_core_stores(agent_store: &crate::agents::AgentStore) -> CoreStores {
    // Persisted agent teams (collections of agents + a coordination strategy) live
    // in whichever enabled app provides the `teams.resolve` / `teams.create`
    // capabilities; Core reaches them through the generic capability consumer
    // (`sidecar::capability_consumer`), which resolves the bound provider per call.
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
    if let Err(error) = server::mcp_events::start(conversations.clone()) {
        tracing::warn!(%error, "MCP Events delivery loop is unavailable");
    }
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
    // Seed the Jay Jr. founder bot's knowledge Space from the snapshot bundled in
    // the binary. Unlike Artifacts/Uploads it is an ordinary user-owned Space,
    // seeded once: deleting it is final (see `agents::jay_jr`). The documents are
    // imported unembedded and indexed in the background once an embedder answers.
    match crate::agents::jay_jr::seed_knowledge(&spaces, &agent_store).await {
        Ok(Some(space_id)) => {
            crate::agents::jay_jr::spawn_knowledge_indexing(spaces.clone(), space_id);
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("failed to seed Jay Jr. knowledge space: {e:#}"),
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
    // Older builds kept each imported board as plaintext `*.json.migrated`
    // beside its sealed Space copy; delete those leftovers.
    server::canvas_migrate::remove_migrated_canvas_residue();
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
    let traces = match ryu_tracing::TraceStore::open(crate::paths::db_path("traces.db")) {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open trace store: {e:#}"),
    };
    // Span payloads follow the user's content-mode choice (read live), and every
    // ended span is offered to the consent-gated OTLP drain so exporter presets
    // receive the same agent-run tree the desktop shows.
    traces.set_content_policy_source(crate::telemetry::trace_content_policy);
    // Captured payloads are sealed at rest. With no content key the store
    // persists none (it never falls back to plaintext).
    match crate::activity::sealed_store::core_cipher(crate::telemetry::TRACE_STORE) {
        Ok(cipher) => {
            traces.set_content_sealer(std::sync::Arc::new(
                crate::telemetry::TraceContentSealer::new(cipher),
            ));
            match traces.seal_stored_payloads().await {
                Ok(0) => {}
                Ok(sealed) => tracing::info!(sealed, "sealed span payloads stored as plaintext"),
                Err(error) => tracing::warn!("sealing stored span payloads deferred: {error:#}"),
            }
        }
        Err(error) => tracing::warn!("span payloads will not be stored: {error:#}"),
    }
    traces.set_sink(Some(std::sync::Arc::new(crate::telemetry::TraceSpanBridge)));
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
    CoreStores {
        conversations,
        memory,
        spaces,
        retrieval,
        media,
        traces,
        preferences,
    }
}
