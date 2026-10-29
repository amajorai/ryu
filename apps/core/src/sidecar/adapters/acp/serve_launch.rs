use super::*;

/// The agent server [`launch_agent_server`] built, with its one-time sandbox notice.
pub(super) struct LaunchedServer {
    pub(super) server: agent_client_protocol::schema::v1::McpServer,
    pub(super) sandbox_notice: Option<String>,
}

/// Builds the confined stdio server; `None` when the queued turns were refused instead.
#[allow(clippy::too_many_arguments, clippy::ptr_arg)]
pub(super) async fn launch_agent_server(
    spawn_cmd: &String,
    environment: Vec<(String, String)>,
    process_tree: &crate::acp_runtime::AcpProcessTree,
    is_managed_pi: bool,
    captured_pi_account: &Option<crate::pi_config::session_accounts::SessionAccount>,
    session_grant: &Option<crate::server::acp_tool_broker::AcpToolSessionGrant>,
    inference_grant: &Option<crate::server::acp_inference_proxy::AcpInferenceGrant>,
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    account_confinement: crate::agent_access::AccountConfinement,
    is_claude_code: bool,
    workspace_autonomy: &WorkspaceAutonomy,
    cwd: &PathBuf,
    additional_directories: &Vec<PathBuf>,
) -> anyhow::Result<Option<LaunchedServer>> {
    // Told to the user once, on the first turn, when the agent runs under the
    // untrusted-workspace profile (or could not be confined).
    let mut sandbox_notice: Option<String> = None;
    let parsed_agent = acp_spawn_from_spawn(&spawn_cmd)?;
    let server = match parsed_agent.into_server() {
        agent_client_protocol::schema::v1::McpServer::Stdio(mut stdio) => {
            for (name, value) in environment {
                if name == "RYU_NATIVE_ACCOUNT_ID"
                    || name == "RYU_NATIVE_ACCOUNT_IDENTITY"
                    || name == "RYU_PI_ACCOUNT_CAPTURE"
                {
                    continue;
                }
                set_stdio_env(&mut stdio.env, name, value);
            }
            for (name, value) in process_tree.environment() {
                set_stdio_env(&mut stdio.env, name, value);
            }
            if is_managed_pi {
                // `acp_agent_from_spawn` gave the declared managed config dir its
                // secrets. Re-check after the per-instance environment, before
                // the session projection replaces the dir: a Pi re-pointed at any
                // other config dir must not keep them.
                if !apply_managed_pi_secret_env(&mut stdio.env) {
                    stdio.env.retain(|variable| {
                        !crate::pi_config::secret_env::is_secret_env_name(&variable.name)
                    });
                }
                if let Some(captured) = captured_pi_account.as_ref() {
                    set_stdio_env(
                        &mut stdio.env,
                        "PI_CODING_AGENT_DIR".to_owned(),
                        captured.directory().to_string_lossy().into_owned(),
                    );
                    for (name, value) in captured.secret_env()? {
                        set_stdio_env(&mut stdio.env, name, value);
                    }
                }
                if let Some(grant) = session_grant.as_ref() {
                    set_stdio_env(
                        &mut stdio.env,
                        "RYU_MCP_SESSION_CAPABILITY".to_owned(),
                        grant.capability().to_owned(),
                    );
                    set_stdio_env(
                        &mut stdio.env,
                        "RYU_MCP_ACP_SESSION_ID".to_owned(),
                        grant.session_id().to_string(),
                    );
                }
            }
            // Set last, by name, so neither the project environment nor the
            // command can point the credential anywhere but Core's proxy.
            if let Some(grant) = inference_grant.as_ref() {
                set_stdio_env(
                    &mut stdio.env,
                    INFERENCE_API_KEY_ENV.to_owned(),
                    grant.credential().to_owned(),
                );
                set_stdio_env(
                    &mut stdio.env,
                    INFERENCE_BASE_URL_ENV.to_owned(),
                    crate::sidecar::gateway::acp_inference_proxy_v1(),
                );
            }
            ensure_gateway_spawn_ready(&stdio)?;
            if let Err(error) = refresh_limited_pi_config(&stdio) {
                tracing::warn!(%error, "limited agent: refusing a Pi whose config could not be rebuilt");
                refuse_turns(
                    turns_rx,
                    None,
                    account_sandbox_failure(&format!("{error:#}"), account_confinement),
                )
                .await;
                return Ok(None);
            }
            let stdio = match confine_for_agent(
                stdio,
                is_managed_pi,
                is_claude_code,
                workspace_autonomy.trusted,
                account_confinement,
                &cwd,
                &additional_directories,
            )
            .await
            {
                Ok((stdio, notice)) => {
                    sandbox_notice = notice;
                    stdio
                }
                // Nothing was spawned. Answer the queued turn(s) with the
                // reason; the closed instance makes the next turn respawn,
                // which picks up a background install, a trust change or an
                // account access change.
                Err(LaunchRefusal::Untrusted(refusal)) => {
                    refuse_untrusted_turns(turns_rx, refusal).await;
                    return Ok(None);
                }
                Err(LaunchRefusal::AccountAccess(reason)) => {
                    refuse_turns(
                        turns_rx,
                        None,
                        account_sandbox_failure(&reason, account_confinement),
                    )
                    .await;
                    return Ok(None);
                }
            };
            agent_client_protocol::schema::v1::McpServer::Stdio(stdio)
        }
        other => other,
    };
    Ok(Some(LaunchedServer {
        server,
        sandbox_notice,
    }))
}
