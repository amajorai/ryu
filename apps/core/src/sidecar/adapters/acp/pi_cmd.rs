use super::*;

/// Build the ACP spawn command for the `ryu` flagship agent using Core's
/// managed Pi engine. Returns `None` when it has not been installed yet
/// (first run before setup completes), allowing `ryu_agent_route()` to fall
/// back gracefully.
///
/// Core installs Pi independently into [`managed_pi_dir`] so the Ryu agent is
/// completely separate from any Pi the user has on their PATH. `PI_ACP_PI_COMMAND`
/// tells pi-acp which binary to invoke; `PI_CODING_AGENT_DIR` points the managed
/// Pi at Ryu's OWN isolated config directory (never the user's `~/.pi/agent`), so
/// the model/provider config Core writes (see [`crate::pi_config`]) is the only
/// config this Pi reads.
///
/// Gateway env vars (`OPENAI_BASE_URL`/`OPENAI_API_KEY`) are injected ONLY when
/// the managed Pi is in Gateway-routed mode (the default), routing every model
/// call through the Ryu gateway firewall, budget, and audit pipeline. When the
/// user has selected a direct provider ([`crate::pi_config::is_gateway_routing`]
/// is false) the injection is skipped so Pi talks straight to that provider — a
/// deliberate, user-chosen egress bypass.
pub fn ryu_pi_acp_cmd(user_jwt: Option<&str>) -> Option<String> {
    ryu_pi_acp_cmd_for_agent(user_jwt, None, None, None, None, None)
}

/// Build the managed Pi command with an agent-scoped OpenAI base URL.
///
/// ACP agents own their HTTP client, so the agent id is carried in the
/// Gateway path and bound to `x-ryu-agent-id` at ingress. `None` preserves the
/// legacy unscoped endpoint for callers without an agent identity.
pub fn ryu_pi_acp_cmd_for_agent(
    user_jwt: Option<&str>,
    agent_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    host_conversation_id: Option<&str>,
    // The agent's model provider access, signed into its Gateway bearer.
    provider_access: Option<&[String]>,
) -> Option<String> {
    if host_conversation_id.is_some_and(|id| !is_safe_host_conversation_id(id)) {
        tracing::warn!("ryu Pi route refused an invalid host conversation id");
        return None;
    }
    let bin = managed_pi_binary();
    if !bin.exists() {
        return None;
    }
    let pi_path = bin.to_string_lossy().into_owned();
    let gateway = crate::pi_config::is_gateway_routing();
    if gateway && crate::sidecar::gateway::remote_data_plane() {
        tracing::error!(
            "refusing to spawn managed Pi on a remote data plane without a brokered, expiring ACP credential"
        );
        return None;
    }
    // Without Gateway routing Pi calls the user's providers itself, where an
    // agent's provider access cannot be enforced.
    if !gateway && provider_access.is_some() {
        tracing::warn!("refusing to spawn managed Pi without Gateway routing for an agent with limited model provider access");
        return None;
    }
    // Enforce the managed-Pi config invariants before spawn: Pi-side skill
    // auto-injection off (Core injects the governed skill block itself; QA B1),
    // a valid zero-key defaultModel in Gateway mode (Pi with no model parrots
    // its skill manifest instead of answering; QA B1), and the models.json pin
    // that routes Pi's `openai` provider through the Gateway (Pi ignores
    // `OPENAI_BASE_URL`, so the env injection below is not enough on its own).
    // Refuse stale configuration: its old literal bearer could override the
    // per-process identity and silently defeat the selected agent's budget.
    if let Err(e) = crate::pi_config::ensure_managed_defaults() {
        tracing::error!(error = %e, "ryu_pi_acp_cmd: refusing stale managed Pi configuration");
        return None;
    }
    // A limited agent reads a config dir with no user provider credential.
    let config_dir = match crate::pi_config::agent_config_dir_str(agent_id, provider_access) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::error!(error = %e, "ryu_pi_acp_cmd: refusing Pi without a credential-free config dir for an agent with limited model provider access");
            return None;
        }
    };
    let gateway_v1 = if gateway {
        match openai_gateway_v1(agent_id) {
            Ok(url) => url,
            Err(error) => {
                tracing::error!(%error, "ryu_pi_acp_cmd: refusing an unproved remote agent route");
                return None;
            }
        }
    } else {
        String::new()
    };
    // Fail closed on a remote data plane (WS1): a hosted multi-tenant gateway must
    // reject the shared "ryu-local" literal, so refuse to route Pi rather than
    // present it. Only needed when gateway routing is on — otherwise the token is
    // unused (Pi talks straight to its own provider) and no bearer is resolved.
    let token = if gateway {
        match crate::sidecar::gateway::gateway_bearer_for_agent(
            agent_id,
            None,
            host_conversation_id,
            provider_access,
        ) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(error = %e, "ryu_pi_acp_cmd: no gateway bearer, refusing to route Pi through the gateway");
                return None;
            }
        }
    } else {
        String::new()
    };

    let mut env = Vec::new();
    if gateway {
        env.push(("OPENAI_BASE_URL".to_owned(), gateway_v1));
        env.push(("OPENAI_API_KEY".to_owned(), token));
    }
    env.push(("PI_CODING_AGENT_DIR".to_owned(), config_dir));
    env.push(("PI_ACP_PI_COMMAND".to_owned(), pi_path));
    env.push(pi_session_env(host_conversation_id));
    env.extend(pi_mcp_extension_env(
        user_jwt,
        composio_connection_scope,
        conversation_scope,
        host_conversation_id,
    ));

    // The flagship bridge is pinned in the same generation as its engine.
    let bridge = crate::required_update_runtime::bridge_entry(&managed_pi_dir());
    if !bridge.is_file() {
        return None;
    }
    let command = resolve_in_path("node")?;
    let args = vec![super::super::acp_direct_spawn::process_path_argument(
        &bridge,
    )];
    acp_stdio_spawn_json("ryu-pi", command, args, env).ok()
}

/// Build the spawn command for an OpenAI-compatible ACP subprocess (Codex) with
/// gateway egress injection. The subprocess reads `OPENAI_BASE_URL` as its
/// provider base URL; pointing it at the local gateway ensures every outbound
/// model call is governed by the firewall, budget, and audit pipeline (U28).
///
/// The gateway URL includes the `/v1` path suffix that OpenAI client libraries
/// expect (they append `/chat/completions` etc. to it). The gateway bearer token
/// (when set) is passed as `OPENAI_API_KEY` so the subprocess presents a valid
/// credential to the gateway's auth layer.
///
/// Resolution is deferred to call time (not a `const`) so it respects the
/// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` env vars as overridden at runtime.
///
/// DEFERRED: Claude Code (Anthropic `/v1/messages`) and Gemini CLI (Google
/// format) are NOT covered here. Claude Code is now governable via the gateway's
/// Anthropic passthrough (`claude_gateway_cmd`), but Gemini CLI reads
/// `GOOGLE_GEMINI_BASE_URL` / `CODE_ASSIST_ENDPOINT` (Google wire format) — never
/// `OPENAI_BASE_URL` — and the gateway registers no Google-format ingress (only
/// Anthropic + OpenAI-Responses passthroughs, `apps/gateway/src/passthrough`), so
/// pointing those at the gateway would 404 and break Gemini rather than govern it.
/// Governing Gemini needs a new gateway Google passthrough — a follow-on unit,
/// out of scope here. See `docs/routing-planes.md` (chat-egress coverage matrix).
#[cfg(target_os = "windows")]
pub(super) fn codex_acp_cmd() -> String {
    codex_acp_cmd_for_agent(None)
}

fn codex_acp_cmd_for_agent(agent_id: Option<&str>) -> String {
    if crate::sidecar::gateway::remote_data_plane() {
        tracing::error!(
            "refusing to spawn Codex ACP on a remote data plane without a brokered, expiring credential"
        );
        return String::new();
    }
    let token = match crate::sidecar::gateway::gateway_bearer_for_agent(agent_id, None, None, None)
    {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(%error, "cannot provision Codex inference credential");
            return String::new();
        }
    };
    let env = vec![
        (
            "CODEX_HOME".to_owned(),
            crate::codex_config::safety_home()
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "OPENAI_BASE_URL".to_owned(),
            match openai_gateway_v1(agent_id) {
                Ok(url) => url,
                Err(error) => {
                    tracing::error!(%error, "cannot provision a proved Codex inference route");
                    return String::new();
                }
            },
        ),
        ("OPENAI_API_KEY".to_owned(), token),
    ];
    let (command, args) = if cfg!(target_os = "windows") {
        (
            PathBuf::from("cmd"),
            vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                "npx -y @agentclientprotocol/codex-acp@latest".to_owned(),
            ],
        )
    } else {
        (
            PathBuf::from("npx"),
            vec![
                "-y".to_owned(),
                "@agentclientprotocol/codex-acp@latest".to_owned(),
            ],
        )
    };
    acp_stdio_spawn_json("codex", command, args, env).unwrap_or_else(|error| {
        tracing::error!(%error, "cannot construct Codex spawn configuration");
        String::new()
    })
}

#[cfg(not(target_os = "windows"))]
pub(super) fn codex_acp_cmd() -> String {
    codex_acp_cmd_for_agent(None)
}
