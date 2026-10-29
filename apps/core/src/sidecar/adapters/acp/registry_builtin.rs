use super::*;

/// Seeded agents on Ryu's own Pi engine (Ryu, Jay Jr., Patrol), first in the list.
pub(super) fn seeded_engine_entries() -> Vec<AcpAgentEntry> {
    vec![
        // ── "Ryu" flagship: Pi engine + Gateway on top ──────────────────
        // The default car-around-the-engine demo agent. Pi is the engine
        // binding (swappable via the pi entry below); the gateway layer is
        // injected at routing time in `ryu_agent_route()` (adapters/mod.rs).
        // Seeded first so it appears at the top of the agent list.
        AcpAgentEntry {
            id: "ryu".into(),
            registry_id: None,
            name: "Ryu".into(),
            description: "The default Ryu agent — Core-managed Pi engine with the Gateway on top. Installed separately from your own Pi.".into(),
            detect_binary: None,
            install_hint: "Ryu installs its own Pi engine automatically on first run".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: pi_acp_cmd(),
            },
            recommended: true,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: registry_bridge_version("pi-acp"),
            icon_url: None,
            version_probe: None,
        },
        // ── "Jay Jr.": the founder bot, a persona on Ryu's own engine ──
        // Seeded installed next to Ryu, but removable from the catalog.
        // Routing never reaches this transport: `agent_route` sends the id
        // to the managed Pi + Gateway route Ryu uses (adapters/mod.rs).
        AcpAgentEntry {
            id: crate::agents::jay_jr::AGENT_ID.into(),
            registry_id: None,
            name: crate::agents::jay_jr::NAME.into(),
            description: crate::agents::jay_jr::DESCRIPTION.into(),
            detect_binary: None,
            install_hint: "Runs on Ryu's own engine; nothing else to install".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: pi_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: None,
            icon_url: None,
            version_probe: None,
        },
        // ── "Patrol": the health & security bot on Ryu's own engine ──
        // Seeded installed next to Ryu, but removable from the catalog.
        // Routing never reaches this transport: `agent_route` sends the id
        // to the managed Pi + Gateway route Ryu uses (adapters/mod.rs).
        AcpAgentEntry {
            id: crate::agents::patrol::AGENT_ID.into(),
            registry_id: None,
            name: crate::agents::patrol::NAME.into(),
            description: crate::agents::patrol::DESCRIPTION.into(),
            detect_binary: None,
            install_hint: "Runs on Ryu's own engine; nothing else to install".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: pi_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: None,
            icon_url: None,
            version_probe: None,
        },
    ]
}

/// Built-ins backed by an ACP CDN registry entry (Claude, Codex, Gemini, pi).
pub(super) fn cdn_registry_entries() -> Vec<AcpAgentEntry> {
    vec![
        AcpAgentEntry {
            id: "acp:claude".into(),
            registry_id: Some("claude-acp".into()),
            name: registry_name("claude-acp", "Claude Agent"),
            description: registry_description("claude-acp", "ACP wrapper for Anthropic's Claude"),
            detect_binary: Some("claude"),
            install_hint: "npm install -g @anthropic-ai/claude-code".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: registry_meta("claude-acp")
                    .and_then(|a| {
                        crate::sidecar::agents::acp_registry::spawn_plan_for(&a)
                            .map(|p| p.spawn_cmd)
                    })
                    .unwrap_or_else(|| {
                        npx_cmd("npx -y @agentclientprotocol/claude-agent-acp@latest")
                    }),
            },
            recommended: false,
            gateway_bypass: true,
            archive_spec: None,
            direct_archive: None,
            bridge_version: registry_bridge_version("claude-acp"),
            icon_url: registry_icon_url("claude-acp"),
            version_probe: version_probe_for_registry("claude-acp"),
        },
        AcpAgentEntry {
            id: "acp:codex".into(),
            registry_id: Some("codex-acp".into()),
            name: registry_name("codex-acp", "Codex"),
            description: registry_description("codex-acp", "OpenAI Codex agent (ACP)"),
            detect_binary: Some("codex"),
            install_hint:
                "Set OPENAI_API_KEY (or sign in to Codex); the codex-acp adapter is fetched via npx"
                    .into(),
            transport: AgentTransport::Acp {
                spawn_cmd: codex_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: registry_bridge_version("codex-acp"),
            icon_url: registry_icon_url("codex-acp"),
            version_probe: version_probe_for_registry("codex-acp"),
        },
        AcpAgentEntry {
            id: "acp:gemini".into(),
            registry_id: Some("gemini".into()),
            name: registry_name("gemini", "Gemini CLI"),
            description: registry_description("gemini", "Google Gemini CLI (ACP)"),
            detect_binary: Some("gemini"),
            install_hint: "npm install -g @google/gemini-cli".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: registry_meta("gemini")
                    .and_then(|a| {
                        crate::sidecar::agents::acp_registry::spawn_plan_for(&a)
                            .map(|p| p.spawn_cmd)
                    })
                    .unwrap_or_else(|| {
                        npx_cmd("npx -y -- @google/gemini-cli@latest --experimental-acp")
                    }),
            },
            recommended: false,
            gateway_bypass: true,
            archive_spec: None,
            direct_archive: None,
            bridge_version: registry_bridge_version("gemini"),
            icon_url: registry_icon_url("gemini"),
            version_probe: version_probe_for_registry("gemini"),
        },
        AcpAgentEntry {
            id: "acp:pi".into(),
            registry_id: Some("pi-acp".into()),
            name: registry_name("pi-acp", "pi ACP"),
            description: registry_description(
                "pi-acp",
                "Pi — your own installed Pi agent, runs with your config and API key",
            ),
            detect_binary: Some("pi"),
            install_hint: "npm install -g pi-acp".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: pi_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: registry_bridge_version("pi-acp"),
            icon_url: registry_icon_url("pi-acp"),
            version_probe: version_probe_for_registry("pi-acp"),
        },
    ]
}

/// Built-ins with their own native bridge or endpoint (OpenClaw, ZeroClaw, Hermes).
pub(super) fn native_bridge_entries() -> Vec<AcpAgentEntry> {
    vec![
        AcpAgentEntry {
            id: "openclaw".into(),
            registry_id: None,
            name: "OpenClaw".into(),
            description: "OpenClaw — self-hosted AI assistant, run over its native ACP bridge".into(),
            detect_binary: Some("openclaw"),
            install_hint: "Requires a reachable OpenClaw Gateway (run `openclaw gateway` locally, or point your OpenClaw config at a remote one); `openclaw acp` then bridges to it".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: openclaw_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: true,
            archive_spec: None,
            direct_archive: None,
            bridge_version: None,
            icon_url: None,
            version_probe: None,
        },
        AcpAgentEntry {
            id: "zeroclaw".into(),
            registry_id: None,
            name: "ZeroClaw".into(),
            description: "Fast native autonomous agent by Ryu".into(),
            detect_binary: None,
            install_hint: String::new(),
            transport: AgentTransport::OpenAiCompat {
                base_url: "http://127.0.0.1:42617",
                model: None,
            },
            recommended: false,
            gateway_bypass: false,
            archive_spec: None,
            direct_archive: None,
            bridge_version: None,
            icon_url: None,
            version_probe: None,
        },
        AcpAgentEntry {
            id: "hermes".into(),
            registry_id: None,
            name: "Hermes Agent".into(),
            description: "NousResearch Hermes — open-source agent with native tool use (ACP)".into(),
            detect_binary: Some("hermes"),
            install_hint: "Install Hermes Agent (`pip install 'hermes-agent[acp]'` or the install script) and set a provider with `hermes model`; ACP runs via `hermes acp`".into(),
            transport: AgentTransport::Acp {
                spawn_cmd: hermes_acp_cmd(),
            },
            recommended: false,
            gateway_bypass: true,
            archive_spec: None,
            direct_archive: None,
            bridge_version: None,
            icon_url: None,
            version_probe: None,
        },
    ]
}
