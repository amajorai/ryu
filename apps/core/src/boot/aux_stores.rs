use super::*;

/// Collaboration, learning and template stores held by `ServerState`.
pub(super) struct AuxStores {
    pub(super) collab: ryu_collab::DocRegistry,
    pub(super) experience_store: ryu_learning::ExperienceStore,
    pub(super) improvement_store: ryu_improvement::ImprovementStore,
    pub(super) agent_ui_templates: server::agent_ui_templates::AgentUiTemplateStore,
    pub(super) subscription_costs: Option<server::subscription_costs::SubscriptionCostStore>,
}

/// Open the collab, experience, improvement, Agent-UI, agent-sync and usage stores.
pub(super) fn open_aux_stores() -> AuxStores {
    // Authoritative CRDT document engine (Phase 3). Backed by `~/.ryu/collab.db`
    // (an append-only update log + compacted snapshots), keyed by document id.
    // Driven by the `kind:"document"` path of `/api/realtime/ws`. Built ONCE here
    // and shared (Clone is Arc-backed) into `ServerState` below so every socket
    // resolves the same in-memory replica per live document.
    let collab = ryu_collab::DocRegistry::new(Arc::new(
        ryu_collab::CollabStore::open_default()
            .unwrap_or_else(|e| boot_fail!("failed to open collab store: {e:#}")),
    ));

    // Fine-tuning is OUT-OF-PROCESS: the `ryu-finetune` sidecar owns `finetune.db`
    // + the adapter catalog + the Python `unsloth` worker, and serves `/api/finetune/*`
    // via the manifest `public_mount`. Core holds no fine-tune client: the learning
    // loop reaches it through the `finetune.start` / `finetune.merge` capabilities.

    // Experience buffer (continual-learning loop). Durable record of captured
    // (user, assistant) turns + PRM scores; populated by sweeping conversations
    // at cycle time, consumed by the reward-filtered retrain.
    // The experience buffer now lives in the extracted `ryu-learning` crate; point
    // it at the SAME `~/.ryu` data dir Core resolves before opening `experience.db`.
    ryu_learning::init_data_dir(crate::paths::ryu_dir());
    let experience_store = match ryu_learning::ExperienceStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open experience store: {e:#}"),
    };

    let improvement_store =
        match ryu_improvement::ImprovementStore::open(crate::paths::db_path("improvements.db")) {
            Ok(store) => store,
            Err(e) => boot_fail!("failed to open improvement store: {e}"),
        };

    let agent_ui_templates = match server::agent_ui_templates::AgentUiTemplateStore::open_default()
    {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open Agent-UI template store: {e:#}"),
    };

    // Agent-root sync has its own SQLite ledger so import/export retries and ACP
    // session bindings do not mutate the conversation schema. It is installed
    // before the router and remains OFF until a profile explicitly enables a
    // direction.
    let agent_sync = match server::agent_sync::AgentSyncStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open agent sync store: {e:#}"),
    };
    server::agent_sync::install_global(agent_sync);

    match usage_history::UsageHistoryStore::open_default() {
        Ok(store) => usage_history::http::install(store),
        Err(error) => tracing::warn!(error = %error, "usage history store unavailable"),
    }

    let subscription_costs = match server::subscription_costs::SubscriptionCostStore::open_default()
    {
        Ok(store) => Some(store),
        Err(error) => {
            tracing::warn!(error = %error, "subscription cost tracking unavailable");
            None
        }
    };
    AuxStores {
        collab,
        experience_store,
        improvement_store,
        agent_ui_templates,
        subscription_costs,
    }
}
