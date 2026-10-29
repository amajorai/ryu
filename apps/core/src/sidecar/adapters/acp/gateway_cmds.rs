use super::*;

/// The gateway URL Claude Code is pointed at via `ANTHROPIC_BASE_URL`. Claude Code
/// appends `/v1/messages` (etc.), which the gateway's transparent passthrough
/// proxy (`/passthrough/anthropic/*`) forwards upstream to Anthropic with the
/// caller's own subscription auth unchanged.
pub(crate) fn anthropic_passthrough_url() -> String {
    let base = crate::sidecar::gateway::configured_gateway_url();
    format!("{}/passthrough/anthropic", base.trim_end_matches('/'))
}

/// Wrap Claude Code's base spawn command with `ANTHROPIC_BASE_URL` injection so its
/// internal HTTP client routes through the Ryu gateway's transparent passthrough
/// proxy (subscription-preserving egress governance).
///
/// **Subscription-preservation rule:** inject ONLY `ANTHROPIC_BASE_URL`. We must
/// NOT set `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — either takes precedence
/// over the user's Pro/Max subscription OAuth and would flip Claude Code onto
/// API-key billing. The gateway forwards the caller's own bearer upstream.
///
/// Applied only when [`crate::claude_config::is_gateway_routing`] is on (the default
/// for new/routable ACP agents; explicit direct-egress opt-out);
/// see [`crate::claude_config`].
pub fn claude_gateway_cmd(spawn_cmd: &str) -> String {
    let base_url = anthropic_passthrough_url();
    #[cfg(target_os = "windows")]
    {
        // The base claude spawn command is `cmd /c npx -y …`; re-emit it with a
        // `set ANTHROPIC_BASE_URL=…&&` prefix inside the same `cmd /c` (mirrors
        // ryu_pi_acp_cmd's Windows form).
        format!(
            "cmd /c set ANTHROPIC_BASE_URL={base_url}&& {}",
            spawn_cmd.trim_start_matches("cmd /c ")
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("ANTHROPIC_BASE_URL={base_url} {spawn_cmd}")
    }
}

/// Wrap an arbitrary ACP spawn command with `OPENAI_BASE_URL` + `OPENAI_API_KEY`
/// injection pointing at the local gateway's `/v1`, so the agent's HTTP client
/// sends its model calls through the Ryu gateway (firewall/budget/audit) instead
/// of straight to a provider. This is the GENERIC "point any agent at the gateway
/// via the OpenAI base-URL swap" lever, gated per-agent by
/// [`crate::agent_routing::is_gateway_routing`].
///
/// Unlike Pi/Claude/Codex (which each have their own dedicated, format-specific
/// routing), this is applied to the verbatim ACP branches: a BYO `acp-exec:`
/// agent and the non-special-cased registry ACP agents. It only does anything for
/// agents whose client actually honours `OPENAI_BASE_URL` (an OpenAI-compatible
/// agent — e.g. a custom `acp-exec:` one); it is a harmless no-op for agents that
/// speak another wire format or use their own gateway. Unlike the subscription-
/// preserving Claude/Codex passthroughs, this DOES inject `OPENAI_API_KEY` (the
/// gateway token) because the target is an API-key OpenAI-compatible client, not a
/// subscription login.
///
/// Uses the native structured ACP environment so a pre-existing unscoped key
/// cannot override the issued identity and credentials never become shell code.
pub fn openai_gateway_cmd(spawn_cmd: &str) -> anyhow::Result<String> {
    openai_gateway_cmd_for_agent(spawn_cmd, None, None)
}

/// Wrap an OpenAI-compatible ACP command with an agent-scoped Gateway URL.
/// `provider_access` is the agent's model provider access, signed into the
/// bearer so Gateway applies it to every call the agent's client makes.
pub fn openai_gateway_cmd_for_agent(
    spawn_cmd: &str,
    agent_id: Option<&str>,
    provider_access: Option<&[String]>,
) -> anyhow::Result<String> {
    let gateway_v1 = openai_gateway_v1(agent_id)?;
    let token =
        crate::sidecar::gateway::gateway_bearer_for_agent(agent_id, None, None, provider_access)?;
    acp_spawn_with_env(
        spawn_cmd,
        vec![
            ("OPENAI_BASE_URL".to_owned(), gateway_v1),
            ("OPENAI_API_KEY".to_owned(), token),
        ],
    )
}

/// Return the OpenAI-compatible Gateway base URL, optionally scoped to an
/// agent. OpenAI clients append `/chat/completions` to this value. Remote
/// managed gateways also receive Core's bearer-bound proof so the fleet can
/// safely accept the agent identity for a dynamic `rgw_` credential.
pub fn openai_gateway_v1(agent_id: Option<&str>) -> anyhow::Result<String> {
    let gateway_base = crate::sidecar::gateway::configured_gateway_url();
    let agent_suffix = match agent_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) if crate::sidecar::gateway::remote_data_plane() => {
            let proof = crate::sidecar::gateway::gateway_agent_proof(id)?;
            format!("/agents/{}/{}", urlencoding::encode(id), proof)
        }
        Some(id) => format!("/agents/{}", urlencoding::encode(id)),
        None => String::new(),
    };
    Ok(format!(
        "{}/v1{agent_suffix}",
        gateway_base.trim_end_matches('/')
    ))
}

/// Build Codex's ACP spawn command for **subscription-preserving** gateway
/// routing. Unlike `codex_acp_cmd()` (which injects `OPENAI_BASE_URL` +
/// `OPENAI_API_KEY` to govern the *API-key* path), this points Codex at an
/// isolated `CODEX_HOME` whose `config.toml` routes the **subscription**
/// (ChatGPT-login) Responses traffic through the gateway passthrough proxy while
/// the user's own OAuth bearer + `ChatGPT-Account-ID` reach upstream unchanged.
///
/// **Subscription-preservation rule:** inject ONLY `CODEX_HOME`. We must NOT set
/// `OPENAI_API_KEY` / `OPENAI_BASE_URL` here — either would flip Codex onto
/// API-key billing. The isolated home reuses the user's real `auth.json` (the
/// OAuth subscription credential), copied in by
/// [`crate::codex_config::ensure_gateway_home`].
///
/// Applied only when [`crate::codex_config::is_gateway_routing`] is on (the default
/// for new/routable ACP agents; explicit direct-egress opt-out).
pub fn codex_acp_gateway_cmd() -> anyhow::Result<String> {
    // (Re)write the isolated CODEX_HOME (provider config + refreshed auth) and
    // resolve its path. Failure is returned so the route refuses to start Codex
    // instead of falling back to the user's ungoverned CODEX_HOME.
    let home = crate::codex_config::ensure_gateway_home()?;
    #[cfg(target_os = "windows")]
    {
        Ok(format!(
            "cmd /c set \"CODEX_HOME={home}\"&& npx -y @zed-industries/codex-acp"
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(format!(
            "CODEX_HOME='{}' npx -y @zed-industries/codex-acp",
            home.replace('\'', "'\\''")
        ))
    }
}

/// Build the ACP spawn command for OpenClaw.
///
/// OpenClaw's ACP mode (`openclaw acp`) is a **Gateway-backed stdio bridge**: it
/// speaks ACP on stdin/stdout to us and forwards every prompt to the user's
/// OpenClaw Gateway over WebSocket (`wss://…:18789`), reading the gateway URL and
/// token from OpenClaw's own config (`gateway.remote.*`) when no `--url`/`--token`
/// flags are given. It is therefore **not** a self-contained subprocess the way
/// Claude Code / Codex / Pi are — it needs a reachable OpenClaw Gateway (local via
/// `openclaw gateway`, or remote). That is OpenClaw's own architecture, not Ryu's,
/// so we spawn the canonical bridge command and leave the gateway endpoint to the
/// user's OpenClaw config (see the entry's `install_hint`).
///
/// Core installs OpenClaw under `~/.ryu/bin` via npm (see
/// [`crate::sidecar::agents::openclaw::installer`]); we prefer that managed binary
/// and fall back to `openclaw` on the user's PATH. Because `openclaw` talks to its
/// own gateway (and never honours `OPENAI_BASE_URL`), the entry carries
/// `gateway_bypass: true` — Ryu's gateway does not see its egress.
pub(super) fn openclaw_acp_cmd() -> String {
    let managed = crate::sidecar::agents::openclaw::installer::binary_path();
    let base = if managed.exists() {
        managed.to_string_lossy().into_owned()
    } else {
        "openclaw".to_owned()
    };
    npx_cmd(&format!("{base} acp"))
}

/// Build the ACP spawn command for the NousResearch Hermes agent.
///
/// Hermes runs ACP **natively** via `hermes acp` (NousResearch docs): the adapter
/// reads provider credentials and config from the standard Hermes paths
/// (`~/.hermes/.env`, `~/.hermes/config.yaml`) and runs the agent loop in-process,
/// so it is fully self-contained once Hermes is installed (unlike OpenClaw). When
/// the `hermes` CLI is not on PATH we fall back to the registry-published `uvx`
/// invocation, which self-fetches the package (requires `uv`/`uvx` on PATH).
///
/// Hermes uses its own provider credentials and does not honour `OPENAI_BASE_URL`,
/// so the entry carries `gateway_bypass: true`.
pub(super) fn hermes_acp_cmd() -> String {
    if binary_in_path("hermes") {
        // `npx_cmd` is just the Windows `cmd /c` shell wrapper here (Hermes may be
        // a `.cmd`/`.bat` shim on Windows); it is a no-op on POSIX.
        npx_cmd("hermes acp")
    } else {
        // shell_words (used by AcpSpawn::from_str) keeps the quoted extra spec as a
        // single arg, so the `[acp]` extra survives intact.
        npx_cmd("uvx --from \"hermes-agent[acp]\" hermes-acp")
    }
}

/// Build an `Acp` registry entry for a self-fetching ACP agent from the official
/// ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest`).
///
/// `dist` is the launch command *minus* the leading runner-fetch boilerplate:
///   - `Npx(rest)`  → `npx -y <rest>` (e.g. `cline --acp`, `@kilocode/cli acp`),
///     wrapped in `cmd /c` on Windows since `npx` is a `.cmd` shim there.
///   - `Uvx(rest)`  → `uvx <rest>` (e.g. `fast-agent-acp -x`); `uvx` is a real
///     executable so it needs no shell wrapper.
///
/// Both runners self-fetch on first use, so these agents work cross-platform with
/// no Ryu-side download infrastructure. Every such agent makes its own provider
/// calls internally (Ryu cannot inject `OPENAI_BASE_URL`), so all carry
/// `gateway_bypass: true` — honest about the egress not traversing Ryu's gateway.
pub(super) fn registry_meta(
    registry_id: &str,
) -> Option<crate::sidecar::agents::acp_registry::RegistryAgent> {
    crate::sidecar::agents::acp_registry::find_registry_agent(registry_id)
}

pub(super) fn registry_name(registry_id: &str, fallback: &str) -> String {
    registry_meta(registry_id)
        .map(|a| a.name)
        .unwrap_or_else(|| fallback.to_owned())
}

pub(super) fn registry_description(registry_id: &str, fallback: &str) -> String {
    registry_meta(registry_id)
        .map(|a| a.description)
        .unwrap_or_else(|| fallback.to_owned())
}

pub(super) fn registry_bridge_version(registry_id: &str) -> Option<String> {
    registry_meta(registry_id).map(|a| a.version)
}

pub(super) fn registry_icon_url(registry_id: &str) -> Option<String> {
    registry_meta(registry_id).map(|a| crate::sidecar::agents::acp_registry::icon_url_for_agent(&a))
}

pub(super) fn version_probe_for_registry(registry_id: &str) -> Option<AgentVersionProbe> {
    let bridge = registry_meta(registry_id).and_then(|a| {
        crate::sidecar::agents::acp_registry::spawn_plan_for(&a).and_then(|p| p.bridge_npm_package)
    });
    let (binary, npm) = crate::sidecar::agents::acp_registry::underlying_cli_probe(registry_id)
        .map(|(b, n)| (Some(b), Some(n.to_owned())))
        .unwrap_or((None, None));
    if binary.is_none() && npm.is_none() && bridge.is_none() {
        return None;
    }
    Some(AgentVersionProbe {
        binary,
        npm_package: npm,
        bridge_npm_package: bridge,
    })
}

/// Convert a registry row into a catalog entry. Every registry agent is listed
/// so the catalog mirrors the upstream ACP registry — including agents Core
/// cannot auto-run on this platform (e.g. a binary-only distribution with no
/// build for the host OS/arch). Those get an empty ACP spawn command plus a hint
/// telling the user to add a custom `acp-exec:` command; the catalog derives an
/// `available` flag from the empty spawn command so the UI disables one-click
/// install without hiding the agent.
pub(super) fn entry_from_registry(
    agent: &crate::sidecar::agents::acp_registry::RegistryAgent,
) -> AcpAgentEntry {
    use crate::sidecar::agents::acp_registry::{self, registry_gateway_bypass};
    let plan = acp_registry::spawn_plan_for(agent);
    let id = acp_registry::canonical_agent_id(&agent.id);
    let install_hint = match &plan {
        Some(p) if p.direct_archive.is_some() => {
            "Downloads the agent from the official ACP registry on install".to_owned()
        }
        Some(_) if agent.distribution.uvx.is_some() => {
            "Self-fetches via uvx on first run (install `uv` from https://docs.astral.sh/uv/)"
                .to_owned()
        }
        Some(_) => "Self-fetches via npx on first run".to_owned(),
        None => format!(
            "No prebuilt package for this platform. Add a custom ACP command \
             (acp-exec:) in the agent's settings to run {}.",
            agent.name
        ),
    };
    let (spawn_cmd, direct_archive) = match plan {
        Some(p) => (p.spawn_cmd, p.direct_archive),
        None => (String::new(), None),
    };
    AcpAgentEntry {
        id,
        registry_id: Some(agent.id.clone()),
        name: agent.name.clone(),
        description: agent.description.clone(),
        detect_binary: acp_registry::underlying_cli_probe(&agent.id).map(|(b, _)| b),
        install_hint,
        transport: AgentTransport::Acp { spawn_cmd },
        recommended: false,
        gateway_bypass: registry_gateway_bypass(&agent.id),
        archive_spec: None,
        direct_archive,
        bridge_version: Some(agent.version.clone()),
        icon_url: Some(crate::sidecar::agents::acp_registry::icon_url_for_agent(
            agent,
        )),
        version_probe: version_probe_for_registry(&agent.id),
    }
}

/// All installable agents from the official ACP registry CDN, minus the
/// curated entries with bespoke spawn or routing behavior.
pub(super) fn registry_driven_entries() -> Vec<AcpAgentEntry> {
    use crate::sidecar::agents::acp_registry::{load_registry_agents, CURATED_OVERRIDE_IDS};
    let skip: std::collections::HashSet<&str> = CURATED_OVERRIDE_IDS.iter().copied().collect();
    load_registry_agents()
        .iter()
        .filter(|a| !skip.contains(a.id.as_str()))
        .map(entry_from_registry)
        .collect()
}
