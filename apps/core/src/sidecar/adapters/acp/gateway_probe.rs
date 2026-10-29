use super::*;

#[derive(Debug)]
pub(super) struct GatewayStartupPending;
impl std::fmt::Display for GatewayStartupPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("The local Gateway is still verifying readiness; retry the agent after startup completes")
    }
}
impl std::error::Error for GatewayStartupPending {}

pub(super) fn ensure_gateway_spawn_ready(stdio: &McpServerStdio) -> anyhow::Result<()> {
    if crate::sidecar::gateway::local_gateway_quarantined() && stdio_targets_local_gateway(stdio) {
        return Err(GatewayStartupPending.into());
    }
    Ok(())
}

pub(super) fn stdio_targets_local_gateway(stdio: &McpServerStdio) -> bool {
    let gateway = reqwest::Url::parse(&crate::sidecar::gateway::configured_gateway_url()).ok();
    super::super::acp_direct_spawn::declared_environment(stdio)
        .iter()
        .any(|(name, value)| match name.as_str() {
            "OPENAI_BASE_URL" if targets_inference_proxy(value) => true,
            "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL" => gateway.as_ref().is_some_and(|gateway| {
                reqwest::Url::parse(value).is_ok_and(|target| target.origin() == gateway.origin())
            }),
            "CODEX_HOME" => PathBuf::from(value) == crate::codex_config::codex_home(),
            "PI_CODING_AGENT_DIR" => crate::pi_config::is_managed_agent_dir(Path::new(value)),
            _ => false,
        })
}

/// Whether an agent's base URL is Core's ACP inference proxy, which forwards
/// only to the local Gateway.
pub(super) fn targets_inference_proxy(value: &str) -> bool {
    let proxy = crate::sidecar::gateway::acp_inference_proxy_v1();
    let (Ok(proxy), Ok(target)) = (reqwest::Url::parse(&proxy), reqwest::Url::parse(value)) else {
        return false;
    };
    target.origin() == proxy.origin() && target.path().starts_with(proxy.path())
}

pub(super) fn stdio_targets_inference_proxy(stdio: &McpServerStdio) -> bool {
    super::super::acp_direct_spawn::declared_environment(stdio)
        .iter()
        .any(|(name, value)| name == INFERENCE_BASE_URL_ENV && targets_inference_proxy(value))
}

async fn probe_acp_config_uncached(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
) -> anyhow::Result<serde_json::Value> {
    let (_, environment) = native_probe_context(&spawn_cmd)?;
    probe_acp_config_uncached_with_environment(spawn_cmd, cwd, selections, environment).await
}

pub(super) async fn probe_acp_config_uncached_with_environment(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
    native_environment: Option<std::collections::HashMap<String, String>>,
) -> anyhow::Result<serde_json::Value> {
    let mut agent = acp_spawn_from_spawn(&spawn_cmd)?;
    if let Some(environment) = native_environment {
        if let McpServer::Stdio(mut stdio) = agent.into_server() {
            for (name, value) in environment {
                set_stdio_env(&mut stdio.env, name, value);
            }
            ensure_gateway_spawn_ready(&stdio)?;
            agent = AcpSpawn::new(McpServer::Stdio(stdio));
        } else {
            anyhow::bail!("Native discovery requires stdio transport");
        }
    }
    // Which road Ryu's tools take to this agent, resolved from the spawn command
    // BEFORE the subprocess answers anything. Reported alongside the agent's own
    // capabilities because clients must NOT derive it from `mcpCapabilities`: the
    // managed Pi advertises `http:false` yet has full tool access through the
    // `ryu-mcp` extension, so a UI reading the raw capability would tell the
    // flagship's user their tools are unavailable when they are not. Core owns
    // this derivation for exactly that reason — see [`RyuToolAccess`].
    let tool_access = ryu_tool_access(&spawn_cmd);
    // Carried into the connect closure so the synthesized plan-mode option is
    // appended INSIDE it — i.e. before the result is written to `config_cache`.
    // Appending after the cache read instead would work on the first call and
    // silently stop on every later one, which is the worst shape this bug has.
    let plan_cmd = spawn_cmd.clone();
    let probe_is_claude_code = is_claude_code_spawn(&spawn_cmd);
    // Bound the whole probe. Some agents advertise their session config statically
    // (Claude Code, Pi, the Ryu flagship) and answer `session/new` instantly; others
    // do real backend work inside `session/new` — Codex, notably, reaches its model
    // provider there, so an unreachable/cold/unauthenticated backend makes it hang
    // indefinitely (`initialize` returns, `session/new` never does). Without a
    // ceiling the request — and the desktop's per-agent pickers that depend on it —
    // would hang forever; with it the caller gets a clear, retryable error and falls
    // back to no pickers instead of a wedged spinner. Nothing here is agent-specific.
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent.into_agent()?, move |cx: ConnectionTo<Agent>| {
                let cwd = cwd.clone();
                let plan_cmd = plan_cmd.clone();
                let selections = selections.clone();
                async move {
                    // Capture the agent's advertised auth methods (ACP
                    // Authentication) so the desktop can offer "Login with …" for
                    // agents that require it (e.g. a subscription/OAuth login).
                    // Advertise the same client capabilities as a live instance:
                    // 3.x agents send boolean config options only to a client
                    // advertising `session.configOptions.boolean`, and the
                    // desktop pickers are built from this probe.
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    // Consume the agent's advertised capabilities (loadSession,
                    // promptCapabilities, mcpCapabilities) so the desktop can react
                    // (e.g. offer resume only when supported); previously ignored.
                    let caps = read_agent_caps(&init);
                    let mut probe_session = NewSessionRequest::new(cwd);
                    if probe_is_claude_code {
                        probe_session.meta = Some(claude_code_session_meta());
                    }
                    let response: Result<(NewSessionResponse, _), _> =
                        send_with_models(&cx, probe_session).await;
                    let (resp, models) = match response {
                        Ok(response) => response,
                        Err(error) if i32::from(error.code) == ACP_AUTH_REQUIRED_CODE => {
                            return Ok(serde_json::json!({
                                "modes": null,
                                "models": null,
                                "configOptions": null,
                                "authMethods": init.auth_methods,
                                "agentCapabilities": agent_caps_json(&caps),
                                "ryuToolAccess": tool_access.as_str(),
                                "authenticationRequired": true,
                            }));
                        }
                        Err(error) => return Err(error),
                    };
                    // Apply the caller's picks and let the agent re-answer. ACP's
                    // `session/set_config_option` returns the FULL refreshed option
                    // list, which is the only channel by which an option that
                    // exists only for some other option's value can ever appear —
                    // `session/new` cannot have mentioned it. Best-effort per
                    // option: an agent that rejects an id (or implements no config
                    // options at all) leaves the `session/new` answer standing.
                    let mut config_options = resp.config_options;
                    for (config_id, value) in model_first(&selections) {
                        let applied: Result<SetSessionConfigOptionResponse, _> = cx
                            .send_request(SetSessionConfigOptionRequest::new(
                                resp.session_id.clone(),
                                config_id.clone(),
                                config_option_value(value),
                            ))
                            .block_task()
                            .await;
                        match applied {
                            Ok(refreshed) => config_options = Some(refreshed.config_options),
                            Err(e) => tracing::debug!(
                                "ACP probe could not apply '{config_id}'='{value}': {e}"
                            ),
                        }
                    }
                    Ok(serde_json::json!({
                        "modes": resp.modes,
                        "models": models,
                        "configOptions": with_plan_mode_option(&plan_cmd, config_options),
                        "authMethods": init.auth_methods,
                        "agentCapabilities": agent_caps_json(&caps),
                        "ryuToolAccess": tool_access.as_str(),
                        "authenticationRequired": false,
                    }))
                }
            }),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "ACP probe timed out after {}s — the agent's session/new never responded (is its model backend reachable/authenticated?)",
            ACP_PROBE_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| anyhow::anyhow!("ACP probe: {e}"))?;
    Ok(value)
}
