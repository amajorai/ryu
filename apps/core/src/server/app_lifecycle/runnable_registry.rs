//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `build_runnable_registry_from_parts` through `build_runnable_registry_from_parts`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) fn build_runnable_registry_from_parts(
    agent_store: &AgentStore,
    mcp: &Arc<McpRegistry>,
    skills: &SkillRegistry,
    app_contrib: &crate::plugins::app_contrib::AppContribRegistry,
) -> crate::runnable::RunnableRegistry {
    use crate::plugin_manifest::schema::{
        ChannelConfig, CompanionConfig, EngineConfig, PolicyConfig, SkillConfig, ToolConfig,
        WorkflowConfig,
    };
    use crate::plugins::app_contrib::{AppChannel, AppCompanion, AppEngine};
    use crate::runnable::{RunnableHandler, RunnableRegistry};

    let mut registry = RunnableRegistry::new();

    // ── Agent handler ────────────────────────────────────────────────────────
    {
        let agent_store = agent_store.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Agent,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let id = format!("{}{}", crate::agents::APP_AGENT_ID_PREFIX, entry.id);
                    let create = manifest_agent_create(entry)?;

                    // Use block_in_place so the synchronous handler can await the
                    // async store call. Idempotent: an agent that already exists
                    // keeps everything the user set, and only has its identity
                    // mode reconciled with the manifest's — narrowed when the
                    // user never changed it, otherwise left for the user to accept.
                    let result = tokio::task::block_in_place(|| {
                        tokio::runtime::Handle::current()
                            .block_on(agent_store.materialize_app_agent(id.clone(), create))
                    });
                    match result {
                        Ok(outcome) => {
                            log_app_identity_outcome(&id, outcome);
                            Ok(())
                        }
                        Err(e) => Err(format!("agent '{}': {e}", entry.id)),
                    }
                },
            ) as RunnableHandler,
        );
    }

    // ── Workflow handler ─────────────────────────────────────────────────────
    registry.register_handler(
        crate::runnable::RunnableKind::Workflow,
        Box::new(|entry: &crate::plugin_manifest::schema::RunnableEntry| {
            use crate::workflow::{store::save_workflow, Workflow};

            let cfg: WorkflowConfig = entry
                .config
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| format!("workflow '{}': missing or invalid config", entry.id))?;

            let id = format!("app__{}", entry.id);
            let now = chrono::Utc::now().to_rfc3339();
            let wf = Workflow {
                id: id.clone(),
                name: entry.name.clone(),
                description: None,
                nodes: vec![],
                edges: vec![],
                triggers: Vec::new(),
                max_concurrency: None,
                created_at: Some(now.clone()),
                updated_at: Some(now),
            };
            // Entry field is recorded in the description so it's not lost.
            let mut wf = wf;
            wf.description = Some(format!("entry: {}", cfg.entry));

            save_workflow(&wf).map_err(|e| format!("workflow '{}': {e}", entry.id))
        }) as RunnableHandler,
    );

    // ── Tool handler ─────────────────────────────────────────────────────────
    {
        let mcp = Arc::clone(mcp);
        registry.register_handler(
            crate::runnable::RunnableKind::Tool,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: ToolConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| format!("tool '{}': missing or invalid config", entry.id))?;

                    // A namespaced non-Alias tool keeps its NATIVE id (`exa.search`);
                    // everything else stays `app.<slug>` (see `app_tool_registered_id`).
                    // The registered `server` stays `"app"` and `name` stays the slug,
                    // so catalog classification + `allow:["app"]` grouping are unchanged.
                    let id = crate::sidecar::mcp::app_tool_registered_id(&cfg);
                    // Tag the resolved backend so the catalog can surface a
                    // `command` tool as its own ToolKind. A malformed backend was
                    // rejected at manifest validation; if it somehow fails here we
                    // register untagged (falls back to App classification).
                    let tag = cfg.resolve_backend().ok().map(|b| {
                        use crate::plugin_manifest::schema::ToolBackend;
                        use crate::sidecar::mcp::AppToolBackendTag;
                        match b {
                            ToolBackend::Alias { .. } => AppToolBackendTag::Alias,
                            ToolBackend::InlineJs { .. } => AppToolBackendTag::InlineJs,
                            ToolBackend::Http { .. } => AppToolBackendTag::Http,
                            ToolBackend::Command { .. } => AppToolBackendTag::Command,
                        }
                    });
                    mcp.register_app_tool_tagged(
                        id,
                        cfg.slug.clone(),
                        Some(format!(
                            "App-registered tool '{}' (slug: {})",
                            entry.name, cfg.slug
                        )),
                        tag,
                    );
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Skill handler ────────────────────────────────────────────────────────
    // Registers the plugin's declared skill into the SkillRegistry's `app_skills`
    // bag under an `app__<skill_id>` id, so it is listable + injectable like a
    // first-party skill (the SkillConfig is `skill_id`-only, mirroring how the
    // Tool handler registers a slug with no executable body).
    {
        let skills = skills.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Skill,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: SkillConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| {
                            format!("skill '{}': missing or invalid config", entry.id)
                        })?;
                    let id = format!("app__{}", cfg.skill_id);
                    skills.register_app_skill(
                        id,
                        entry.name.clone(),
                        Some(format!("App-registered skill (skill_id: {})", cfg.skill_id)),
                    );
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Engine handler ───────────────────────────────────────────────────────
    // Registers the plugin's declared engine binding into the app-contrib
    // registry so it becomes selectable via `GET /api/engines`. Every model call
    // an engine ultimately makes still routes through the Gateway — this only
    // exposes the engine as a choice (what Core runs), not a policy decision.
    {
        let app_contrib = app_contrib.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Engine,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: EngineConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| {
                            format!("engine '{}': missing or invalid config", entry.id)
                        })?;
                    app_contrib.register_engine(AppEngine {
                        id: format!("app__{}", entry.id),
                        name: entry.name.clone(),
                        engine_type: cfg.engine_type,
                        base_url: cfg.base_url,
                    });
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Channel handler ──────────────────────────────────────────────────────
    // Registers the plugin's declared channel adapter into the app-contrib
    // registry so an enabled plugin's channel becomes a usable adapter, surfaced
    // via `GET /api/plugins/contributions`.
    {
        let app_contrib = app_contrib.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Channel,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: ChannelConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| {
                            format!("channel '{}': missing or invalid config", entry.id)
                        })?;
                    app_contrib.register_channel(AppChannel {
                        id: format!("app__{}", entry.id),
                        name: entry.name.clone(),
                        platform: cfg.platform,
                    });
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Companion handler ────────────────────────────────────────────────────
    // Registers the plugin's declared companion surface descriptor into the
    // app-contrib registry so the desktop can render it (also visible in the full
    // manifest served by `GET /api/apps`); surfaced via
    // `GET /api/plugins/contributions`.
    {
        let app_contrib = app_contrib.clone();
        registry.register_handler(
            crate::runnable::RunnableKind::Companion,
            Box::new(
                move |entry: &crate::plugin_manifest::schema::RunnableEntry| {
                    let cfg: CompanionConfig = entry
                        .config
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .ok_or_else(|| {
                            format!("companion '{}': missing or invalid config", entry.id)
                        })?;
                    app_contrib.register_companion(AppCompanion {
                        id: format!("app__{}", entry.id),
                        name: entry.name.clone(),
                        label: cfg.label,
                        icon: cfg.icon,
                        shortcut: cfg.shortcut,
                    });
                    Ok(())
                },
            ) as RunnableHandler,
        );
    }

    // ── Policy handler ───────────────────────────────────────────────────────
    // Policy enforcement is a Gateway concern (Core-vs-Gateway rule), so this
    // handler does NO inline enforcement and NO I/O: it only validates the
    // declared policy so `register_all` does not fail on a Policy runnable. The
    // actual activation (e.g. toggling the gateway's egress compression for a
    // `compression` policy) is performed by the async enable/disable handlers,
    // which can do the gateway refresh without the sync-handler→async hazard.
    registry.register_handler(
        crate::runnable::RunnableKind::Policy,
        Box::new(|entry: &crate::plugin_manifest::schema::RunnableEntry| {
            let _cfg: PolicyConfig = entry
                .config
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or_else(|| format!("policy '{}': missing or invalid config", entry.id))?;
            Ok(())
        }) as RunnableHandler,
    );

    registry
}
