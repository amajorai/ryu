use super::*;

/// Kernel services that end up in `ServerState`.
pub(super) struct KernelServices {
    pub(super) hardware_store: ryu_hardware::DeviceStore,
    pub(super) approval_engine: crate::approvals::ApprovalEngine,
    pub(super) activity_store: ryu_activity::ActivityStore,
}

/// Open notify/hardware/approval/activity services and their background loops.
pub(super) async fn start_kernel_services(
    sidecars: &Arc<SidecarManager>,
    app_manifests: &Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::PluginManifest>>>,
    app_store: &crate::plugins::PluginStore,
    mcp_registry: &Arc<sidecar::mcp::McpRegistry>,
    preferences: &server::preferences::PreferencesStore,
    skill_registry: &ryu_skills::SkillRegistry,
) -> KernelServices {
    // Kernel notification-delivery store (adjudicated NOT-a-capability): the
    // app-inbox feed, push tokens, policy-alert dedupe, and node-level alert
    // delivery targets. Stays compiled into Core and keeps serving
    // notifications_api / policy_alerts / workflow / approvals even once the
    // monitor engine moves out-of-process. Published as a process-global so the
    // state-free scheduler + workflow executor + policy-alert deliverer reach it.
    let notify_store = match crate::notify::NotifyStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open notify store: {e:#}"),
    };
    crate::notify::set_global_store(notify_store.clone());

    // Seal, once, workflow credentials (webhook signing secrets, ChannelSend bot
    // tokens / webhook URLs) still stored as legacy plaintext. Idempotent and off
    // the boot path; readers accept both forms meanwhile.
    tokio::task::spawn_blocking(crate::workflow::store::reseal_stored_workflows);
    // Import the legacy plaintext source history (once, off the boot path); a
    // store that has to stay on Git is reported by `/api/encryption/status`.
    tokio::task::spawn_blocking(crate::server::encryption::report_source_history_on_start);

    // Website monitors run OUT-OF-PROCESS: the `ryu-monitors` sidecar owns
    // `monitors.db` + the engine + the `/api/monitors/*` surface (served via the
    // manifest `public_mount`). Core reaches it only through the capabilities it
    // provides (see the consumer installed above); its Spider fetch and alert fan-out
    // reach back into Core through the `mcp.callTool` / `notify.fanout` kernel
    // capabilities (`server::app_mcp_call`, `server::app_notify`). Core links NO
    // monitor code.

    // (Mail's store lives in the out-of-process `ryu-mail` sidecar now — Track C.)

    // Meeting notes run OUT-OF-PROCESS: the `ryu-meetings` sidecar owns `meetings.db`,
    // the engine + audio/diarize pipeline, and the `/api/meetings/*` surface (served to
    // the desktop through the ext-proxy `public_mount`). Core links NO meeting code and
    // reaches it only through its capabilities. Notes reach the "Meetings" Space
    // through the `spaces.fileNotes` kernel capability (`server::app_file_notes`),
    // under the background owner.

    // Hardware device registry (RHP v1, PROTOCOL.md §6): paired watch/necklace/
    // desk devices + their revocable per-device tokens + presence. Opens its own
    // SQLite store (`~/.ryu/hardware.db`). Read by the `/api/hardware/*` REST
    // surface and the `/api/hardware/ws` realtime handler.
    // The registry moved to the extracted `ryu_hardware` crate; the host computes
    // the db path (`<data dir>/db/hardware.db`) and injects it at open (the crate never
    // reaches Core's `paths` module).
    let hardware_store = match ryu_hardware::DeviceStore::open(crate::paths::db_path("hardware.db"))
    {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open hardware device registry: {e:#}"),
    };
    // RHP v1.1: the node's static identity is sealed at rest with Core's field
    // cipher. Warm it up off the boot path; a failure is only logged (the key is
    // never regenerated silently, and pairing/handshakes report it as unavailable).
    hardware_store.set_key_sealer(std::sync::Arc::new(
        crate::hardware::node_key::CoreNodeKeySealer::global(),
    ));
    {
        let store = hardware_store.clone();
        tokio::spawn(async move {
            if let Err(e) = store.node_identity().await {
                tracing::warn!(target: "hardware", "hardware node identity unavailable: {e}");
            }
        });
    }
    // The reserved `device` MCP server (device capabilities as agent tools) checks
    // the Hardware app's enabled bit on every listing and call.
    crate::sidecar::mcp::device_tool::install(
        crate::sidecar::mcp::device_tool::DeviceToolCtx::new(
            hardware_store.clone(),
            app_store.clone(),
        ),
    );

    // Quests (auto-detecting todo list) runs OUT-OF-PROCESS: the `ryu-quests` sidecar
    // owns `quests.db` + the detection engine. Core reaches it only through the
    // `quests.*` capabilities (`scheduler::legacy_quest_jobs`); the activity feed arrives as
    // `activity` rows on the sidecar's own app events.

    // Recipes needs no host installation: `recipes_host::CoreRecipesHost` is a
    // plain Core type the `ghost.*` kernel capabilities call directly, and the
    // workflow executor's `Recipe` node drives the shared MCP registry itself.

    // Install the webhook-ingress host BEFORE any ingress code runs (the ingress
    // start task below, and the public webhook routes in `server/mod.rs`, both
    // reach the extracted `ryu-webhook-ingress` engine through this seam). The
    // shim carries the kernel couplings the crate can't own (composio verify/run,
    // workflow-secret lookup, mesh Funnel, auth token, data dir).
    ryu_webhook_ingress::set_global_host(std::sync::Arc::new(
        crate::webhook_ingress_host::CoreWebhookIngressHost,
    ));

    // Home dashboards run OUT-OF-PROCESS: the `ryu-dashboards` sidecar owns
    // `dashboards.db`, the refresh loop, and the `/api/dashboards/*` surface (served
    // to the desktop through the ext-proxy `public_mount`). Core links NO dashboard
    // code; it reaches whichever enabled app provides the `dashboards.*` capabilities
    // through the generic capability consumer. The `CoreDashboardsHost`
    // (Composio/agent/HTTP widget couplings) moved to the sidecar's own host impl —
    // Agent/HTTP widgets degrade out-of-process until a broker-back hop lands
    // (documented in the sidecar).
    //
    // Live display nudge for hardware: when a device-bound dashboard's data changes,
    // push the RHP `display` re-poll signal to that device's live WS so the desk
    // e-ink reflects edits promptly (TRMNL push-to-refresh; review gap #4). Cost-
    // guarded — only connected devices are nudged, per-device debounced. The nudge
    // loop consumes the `dashboards.changes` stream through the `DashboardFeed` seam;
    // the feed resubscribes after a provider restart and keeps retrying (without
    // closing the loop) while no app provides dashboards.
    ryu_hardware::nudge::spawn(
        std::sync::Arc::new(crate::dashboard_capabilities::CapabilityDashboardFeed::new(
            crate::sidecar::capability_consumer::CapabilityConsumer::new(
                Arc::clone(&sidecars),
                Arc::clone(&app_manifests),
                app_store.clone(),
            ),
        )),
        hardware_store.clone(),
    );

    // Approval inbox (human-in-the-loop). Opens its own SQLite store and reuses a
    // shared HTTP client (mobile Expo push) + the kernel notify store's registered
    // push tokens, so a phone learns about a pending decision while away. Published
    // as a process-global so the state-free scheduler and the workflow executor can
    // raise requests when a `require_approval` job fires or an `Awakeable` gate
    // suspends. A background sweep expires stale pending requests and prunes
    // decided ones past their retention.
    let approval_store = match crate::approvals::store::ApprovalStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open approvals store: {e:#}"),
    };
    let approval_engine =
        crate::approvals::ApprovalEngine::new(approval_store, reqwest::Client::new())
            .with_push_store(notify_store.clone())
            .with_registry(Arc::clone(&mcp_registry))
            .with_preferences(preferences.clone())
            .with_skills(skill_registry.clone());
    crate::approvals::set_global_engine(approval_engine.clone());
    {
        let sweep_engine = approval_engine.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                if let Err(e) = sweep_engine.sweep_expired().await {
                    tracing::warn!("approvals: expiry sweep failed: {e:#}");
                }
                if let Err(e) = sweep_engine.prune_history().await {
                    tracing::warn!("approvals: history prune failed: {e:#}");
                }
            }
        });
    }

    // Unified activity feed. Opens its own SQLite store (`~/.ryu/activity.db`) and
    // aggregates every producing engine's events into one cross-module timeline via
    // background subscribe-loops (`crate::activity::ingest`). Records *what happened*
    // ⇒ Core; nothing about it is policy. Wired sources: monitors + quests +
    // approvals + meetings (all four expose a broadcast bus); the manual POST
    // endpoint keeps the slice testable regardless.
    // `open` takes an explicit path — the default-path choice (`~/.ryu/activity.db`)
    // stays Core-side wiring so the `ryu-activity` crate has zero apps/core dep.
    let activity_store =
        match ryu_activity::ActivityStore::open(crate::paths::db_path("activity.db")) {
            Ok(store) => store,
            Err(e) => boot_fail!("failed to open activity store: {e:#}"),
        };
    crate::activity::ingest::spawn(activity_store.clone(), &approval_engine);
    // Meetings / Quests → activity is no longer a Core loop: each sidecar attaches an
    // `activity` row to the app events it already emits (`events.emit`), and Core
    // records it attributed to the authenticated caller.
    // App-owned scheduled jobs: Core reconciles `JobTarget::AppJob` jobs from every
    // enabled Core-tier provider of `jobs.list` / `jobs.run`, and the legacy
    // `JobTarget::Quest` jobs from `quests.list`, on one background loop (a
    // provider is skipped while its app is disabled). Monitor alerts + activity
    // arrive over the `notify.fanout` kernel capability, not a spawned loop.
    //
    // First rewrite job files persisted with a retired per-app target into the
    // generic form, in place (ids, history and side files kept), before either
    // the reconcile loop or the scheduler tick reads them. A failure only logs:
    // the deserialization shim still loads every legacy file.
    match crate::scheduler::store::normalize_persisted_targets() {
        Ok(0) => {}
        Ok(changed) => {
            tracing::info!("scheduler: normalized {changed} persisted job file(s) to app jobs");
        }
        Err(e) => tracing::warn!("scheduler: could not normalize persisted job targets: {e}"),
    }
    crate::scheduler::app_jobs::spawn();
    KernelServices {
        hardware_store,
        approval_engine,
        activity_store,
    }
}
