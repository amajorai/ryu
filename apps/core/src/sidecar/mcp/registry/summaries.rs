//! Server summaries for the settings surface.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Summaries of every registered server (for `GET /api/mcp/servers`).
    /// Includes the built-in Shadow and Exa providers alongside config
    /// servers.
    pub fn server_summaries(&self) -> Vec<ServerSummary> {
        let sandbox_enabled = sandbox::is_enabled();
        let sandbox_available = cfg!(feature = "sandbox-wasmtime");
        let mut summaries = vec![
            // NOTE: `research` used to head this list as a built-in HTTP provider.
            // It is now the `@ryu/research` app's own stdio MCP server
            // (`ryu-research mcp`, declared in that app's `manifest.json`), so it
            // appears here only through the generic plugin-server path — listed when
            // registered, absent when the app is disabled or its binary has not
            // landed. That is the honest answer, and the reason the hardcoded row is
            // gone rather than rewritten.
            ServerSummary {
                name: web_fetch::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in authenticated web fetch. Fetches a page over HTTPS, injecting the \
                     user's Identity Vault session for the URL's domain server-side (acts AS the \
                     user; the credential never reaches the model)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: marketplace_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Marketplace discovery: search public Ryu Marketplace listings across \
                     kinds (including templates) and read one listing. Read-only; installs nothing."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: usage_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in provider usage: list supported readers and inspect provider/model usage, reset times, and prepaid balances without exposing credentials.".to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: challenges_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Ryu Challenges: list open challenges, read one challenge's brief \
                     and the user's entry status, and submit the user's project with their \
                     signed-in Ryu session (submission always needs the user's approval)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            // Built-in wasmtime sandbox provider (M6 / issue #190).
            // Availability reflects whether the feature was compiled in.
            // Enabled reflects the runtime toggle (RYU_SANDBOX_DISABLED env var).
            ServerSummary {
                name: cloud::SERVER_NAME.to_owned(),
                command: "(built-in cloud workspace)".to_owned(),
                args: vec![],
                description: Some("Coding tools for a verified conversation bound to an isolated cloud environment. Local paths and model-selected workspace handles are refused.".to_owned()),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: sandbox::SERVER_NAME.to_owned(),
                command: "(built-in wasmtime)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in wasmtime sandbox: run WASM/WASI modules with default-deny capabilities. \
                     Toggle with the enable/disable endpoint or from the Services page."
                        .to_owned(),
                ),
                enabled: sandbox_enabled,
                available: Some(sandbox_available),
                ..Default::default()
            },
            ServerSummary {
                name: notify_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in action: show a native desktop notification to the user.".to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: device_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in: tools advertised by your paired Ryu hardware".to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: channel_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTP)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in action: post a message to a Slack/Discord incoming-webhook URL."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: spaces_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Spaces tools: list and search readable Spaces, create pages and \
                     files, create or rename owned Spaces, and attach or detach a Space from the \
                     calling agent with server-derived ownership checks."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: working_memory_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in working memory: lets an agent with working memory enabled \
                     update its per-thread or per-resource scratchpad."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: search_conversations::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in: semantic search over the user's past conversation messages."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: crate::agent_control::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in agent control: request the next turn's agent, model, or reasoning effort."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: threads::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in session coordination: inspect active conversations and shared \
                     workspaces, create/list/read worker threads, send messages, wait for runs, \
                     and pin/archive/title/fork threads."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: delegate::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in delegation: fan out independent subtasks to sub-agents that run \
                     in parallel in a clean context, returning all results in one call \
                     (ephemeral; for durable workers use the threads tools)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: orchestrator::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in orchestration discovery: list the other agents available to \
                     delegate to, with each one's id/name/description, so an orchestrator can \
                     find the right specialist (orchestrator.discover_agents) before handing \
                     it a subtask via delegate.fanout."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: skills_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                // Not an inline literal like its neighbours: the text depends on the
                // `skills.author` opt-in, so it is computed where that gate lives
                // (see `skills_tool::server_description`).
                description: Some(skills_tool::server_description()),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: consent_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in consent requests: ask the user, with an inline chat card, to \
                     connect an app account (consent.connect_app) or install a plugin \
                     (consent.install_plugin). Nothing is granted until the user confirms."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: tasks_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in suggested next task: offer the user one separate follow-up \
                     task as a card above the composer (tasks.suggest). Optional, rarely \
                     used, and nothing starts until the user clicks Start."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: ui_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in generative UI: render a rich interactive UI inline in the chat \
                     (ui.render) from a native json-render spec or an A2UI v0.9 message \
                     sequence, using the app's own shadcn components, including charts, KPI \
                     tiles and live calculators, and read back what the user did with those \
                     widgets (ui.get_state)."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: workspace_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in workspace actions: open safe Ryu pages in normal tabs or the \
                     chat workspace panel, and open the embedded Browser panel."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: routines_tool::SERVER_NAME.to_owned(),
                command: "(built-in)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in routines: list, create, edit, delete, and run persistent \
                     agent schedules with optional chat destinations."
                        .to_owned(),
                ),
                enabled: true,
                available: Some(true),
                ..Default::default()
            },
            ServerSummary {
                name: treg_tool::SERVER_NAME.to_owned(),
                command: "(built-in HTTPS)".to_owned(),
                args: vec![],
                description: Some(
                    "Built-in Treg tools: read an endpoint from Treg's public catalog and call it \
                     through the Gateway's managed connection layer, billed at the provider's \
                     cost. Off unless RYU_TREG_AGENT_TOOLS is set."
                        .to_owned(),
                ),
                enabled: treg_tool::enabled(),
                available: Some(treg_tool::enabled()),
                ..Default::default()
            },
        ];
        // Capability facade servers (the swappable layers). Listed unconditionally,
        // because the names are reserved whether or not a provider is currently
        // selected. `available` is deliberately `None` rather than a guess: knowing
        // whether a layer can actually serve a call means resolving the bound
        // provider over the enabled plugin set, which is an async read, and this
        // accessor is sync. `GET /api/capabilities` is the endpoint that answers it.
        summaries.extend(capability_tools::SERVERS.iter().map(|name| ServerSummary {
            name: (*name).to_owned(),
            command: "(built-in capability facade)".to_owned(),
            args: vec![],
            description: capability_tools::server_description(name).map(str::to_owned),
            enabled: true,
            available: None,
            ..Default::default()
        }));
        let servers = self.servers.read().expect("mcp servers RwLock poisoned");
        summaries.extend(servers.iter().map(|(name, cfg)| {
            let (auth_required, auth_configured, auth_type) = auth_metadata(cfg);
            ServerSummary {
                name: name.clone(),
                // A remote entry has no command; show the endpoint in the column the
                // UI already renders rather than an empty cell.
                command: cfg
                    .command
                    .clone()
                    .or_else(|| cfg.url.clone())
                    .unwrap_or_default(),
                args: cfg.args.clone(),
                description: cfg.description.clone(),
                enabled: cfg.enabled,
                available: config_availability(cfg),
                transport: Some(cfg.transport_label().to_owned()),
                url: cfg.url.clone(),
                auth_required,
                auth_configured,
                auth_type,
                owner_plugin_id: cfg.owner_plugin_id.clone(),
                owner_server_name: cfg.owner_server_name.clone(),
                env_keys: cfg.env.keys().cloned().collect(),
                header_names: cfg.headers.keys().cloned().collect(),
                saved_key_account: config_references_user_secret(cfg)
                    .then(|| saved_key_account_id(name, cfg).to_owned()),
            }
        }));
        summaries.retain(|summary| !crate::fleet::is_artifact_blocked(&summary.name));
        summaries
    }
}
