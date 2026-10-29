use super::*;

pub(super) fn is_claude_code_spawn(spawn_cmd: &str) -> bool {
    spawn_cmd.contains("claude-code-acp") || spawn_cmd.contains("claude-agent-acp")
}

/// Claude Agent SDK options for every Claude Code session Ryu opens.
///
/// - `settingSources: ["user"]`: skip the session folder's project `.mcp.json` and
///   local settings, which spawned that folder's MCP servers before the first
///   token (measured 62 s -> 8 s).
/// - `strictMcpConfig: true`: use only the MCP servers passed in `session/new`
///   (Ryu's shared bridge). Without it every chat started its own copy of each
///   `~/.claude.json` server: measured on one idle chat with 11 user servers,
///   1,631 MB -> 503 MB resident and session start 32.7 s -> 20.8 s. Those servers
///   belong in Ryu's MCP registry, which runs each once per node for all chats.
pub(super) fn claude_code_session_meta() -> serde_json::Map<String, serde_json::Value> {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "claudeCode".to_owned(),
        serde_json::json!({
            "options": { "settingSources": ["user"], "strictMcpConfig": true }
        }),
    );
    meta
}

/// `claude_code_session_meta` plus `options.resume`, which claude-agent-acp
/// passes to the Claude Agent SDK to reopen that session under the same id.
pub(super) fn claude_code_session_meta_resuming(
    resume: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut meta = claude_code_session_meta();
    if let Some(session_id) = resume {
        if let Some(options) = meta
            .get_mut("claudeCode")
            .and_then(|value| value.get_mut("options"))
            .and_then(serde_json::Value::as_object_mut)
        {
            options.insert("resume".to_owned(), serde_json::json!(session_id));
        }
    }
    meta
}

/// Replayed history arrives before `session/load` returns; once the session
/// handler attaches, the crate delivers it. It is drained until the stream has
/// been quiet this long, so it never reaches the chat as a new reply.
pub(super) const LOAD_REPLAY_QUIET: Duration = Duration::from_millis(500);

/// How long a cancelled turn waits for the agent to answer `session/cancel`
/// with `stopReason: cancelled` (reading the updates it flushes first), and
/// then caps the discard of whatever it is still sending.
pub(super) const ACP_CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Answer a message a cancelled turn reads after it stopped following the
/// agent's tail. Notifications are discarded, but a request is always
/// answered, since an agent may block until it is: a permission request gets
/// the `cancelled` outcome ACP prescribes for a cancelled turn, a question is
/// cancelled, and anything else (file system, terminal, extensions) is refused
/// as a cancelled request.
pub(super) async fn answer_cancelled_turn_request(
    message: agent_client_protocol::Dispatch,
) -> Result<(), agent_client_protocol::Error> {
    MatchDispatch::new(message)
        .if_request(async |_req: RequestPermissionRequest, responder| {
            responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ))
        })
        .await
        .if_request(async |_req: ElicitationCreateRequest, responder| {
            responder.respond(ElicitationCreateResponse::cancelled())
        })
        .await
        .otherwise(async |message| match message {
            // ACP's request-cancelled code (`$/cancel_request`); the SDK only
            // names it behind an unstable feature.
            agent_client_protocol::Dispatch::Request(_, responder) => responder.respond_with_error(
                agent_client_protocol::Error::new(-32800, "Request cancelled"),
            ),
            _ => Ok(()),
        })
        .await
}

/// Send a session setup request and keep the response's `models` member.
///
/// ACP 3.x removed the unstable `SessionModelState` (0.11's
/// `unstable_session_model`) from the typed setup responses, but agents still
/// send it and the desktop model picker reads it. It is normalized with 0.11's
/// lenient serde (see [`super::acp_session_models`]): a malformed state reads as
/// absent and malformed model entries are skipped, as before.
pub(super) async fn send_with_models<Req>(
    cx: &ConnectionTo<Agent>,
    request: Req,
) -> Result<(Req::Response, serde_json::Value), agent_client_protocol::Error>
where
    Req: agent_client_protocol::JsonRpcRequest,
{
    use agent_client_protocol::JsonRpcResponse as _;
    let method = request.method().to_owned();
    let raw: serde_json::Value = cx
        .send_request(request.to_untyped_message()?)
        .block_task()
        .await?;
    let models = super::super::acp_session_models::normalize_models(raw.get("models"));
    let response = Req::Response::from_value(&method, raw)?;
    Ok((response, models))
}

/// Reopen an agent's stored session with ACP `session/load` and attach to it.
/// `None` on any failure, and the caller starts a fresh session instead.
pub(super) async fn load_stored_session(
    cx: &ConnectionTo<Agent>,
    session_id: &str,
    cwd: &std::path::Path,
    additional_directories: &[PathBuf],
) -> Option<agent_client_protocol::ActiveSession<'static, Agent>> {
    let mut request = LoadSessionRequest::new(SessionId::new(session_id), cwd.to_path_buf());
    request.additional_directories = additional_directories.to_vec();
    // The SDK installs session routing before publishing `session/load`, so
    // replayed history is buffered on the returned session.
    let mut session = match cx
        .load_session_from(request)
        .block_task()
        .start_session()
        .await
    {
        Ok(restored) => restored.into_session(),
        Err(error) => {
            tracing::warn!(%error, "loading this chat's agent session failed; starting a fresh one");
            return None;
        }
    };
    let mut replayed = 0usize;
    while let Ok(Ok(message)) = tokio::time::timeout(LOAD_REPLAY_QUIET, session.read_update()).await
    {
        replayed += 1;
        // No turn is running yet, so a request the agent sends while replaying
        // is answered the way a cancelled turn answers it, never left pending.
        if let SessionMessage::SessionMessage(message) = message {
            if let Err(error) = answer_cancelled_turn_request(message).await {
                tracing::debug!(%error, "answering an agent request during session/load failed");
            }
        }
    }
    tracing::debug!(
        replayed,
        "drained replayed session history after session/load"
    );
    Some(session)
}

/// The native session this chat last used with this agent in this folder, if
/// the node recorded one.
pub(super) async fn acp_resume_candidate(
    conversation_id: Option<&str>,
    agent_id: &str,
    cwd: &std::path::Path,
    provider_account_identity: Option<&str>,
    generation: Option<&str>,
) -> Option<String> {
    let conversation_id = conversation_id.filter(|id| !id.is_empty())?;
    let store = crate::server::agent_sync::global_store()?;
    let binding = store
        .binding_for_agent(conversation_id, agent_id)
        .await
        .ok()??;
    if Some(binding.conversation_generation.as_str()) != generation {
        return None;
    }
    let same_folder = binding
        .working_directory
        .as_deref()
        .is_some_and(|dir| std::path::Path::new(dir) == cwd);
    (same_folder
        && resume_account_matches(&binding.capabilities, provider_account_identity)
        && !binding.native_session_id.is_empty())
    .then_some(binding.native_session_id)
}

pub(super) const ACP_ACCOUNT_BINDING_KEY: &str = "ryuProviderAccountIdentity";

pub(super) fn resume_account_matches(
    capabilities: &serde_json::Value,
    expected: Option<&str>,
) -> bool {
    match (capabilities.get(ACP_ACCOUNT_BINDING_KEY), expected) {
        (None, None) => true,
        (Some(serde_json::Value::String(recorded)), Some(expected)) => {
            if recorded.starts_with("kiro:")
                && expected.starts_with("kiro:")
                && recorded.split(':').count() == 5
                && expected.split(':').count() == 5
            {
                recorded.rsplit_once(':').map(|(identity, _)| identity)
                    == expected.rsplit_once(':').map(|(identity, _)| identity)
            } else {
                recorded == expected
            }
        }
        _ => false,
    }
}

/// The probe itself: spawn the agent, `initialize` + `session/new`, read what it
/// advertises, drop the session. Always hits the subprocess — every caller goes
/// through [`probe_acp_config`], which is what owns the caching.
pub(super) fn acp_agent_from_spawn(
    spawn_cmd: &str,
) -> anyhow::Result<agent_client_protocol::AcpAgent> {
    Ok(acp_spawn_from_spawn(spawn_cmd)?.into_agent()?)
}

/// [`acp_agent_from_spawn`] before conversion to the SDK component.
pub(super) fn acp_spawn_from_spawn(spawn_cmd: &str) -> anyhow::Result<AcpSpawn> {
    let agent =
        AcpSpawn::from_str(spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let server = match agent.into_server() {
        agent_client_protocol::schema::v1::McpServer::Stdio(mut stdio) => {
            // Keep empty credential masks: ACP inherits Core's environment.
            isolate_acp_child_env(&mut stdio.env);
            sanitize_acp_child_env(&mut stdio.env);
            if let Some(native) = crate::pi_config::native_accounts::for_spawn(spawn_cmd)? {
                if let Some(index) = stdio
                    .args
                    .iter()
                    .position(|argument| argument == "--agent-engine")
                {
                    if stdio.args.get(index + 1).map(String::as_str) != Some("v2") {
                        anyhow::bail!("Native Kiro account custody currently requires the verified v2 ACP engine");
                    }
                } else {
                    stdio.args.extend(["--agent-engine".into(), "v2".into()]);
                }
                stdio.env.retain(|variable| {
                    !crate::pi_config::native_accounts::is_vendor_auth_env(&variable.name)
                });
                for (name, value) in
                    crate::pi_config::native_accounts::isolated_env(native.discovery_env()?)
                {
                    set_stdio_env(&mut stdio.env, name, value);
                }
            }
            let codex = crate::agent_sandbox::is_codex_stdio(&stdio);
            // Preserve the original authority while wrapping the resolved command.
            let mut stdio = super::super::acp_direct_spawn::resolve_direct_stdio(stdio);
            // Every managed-Pi spawn (turns, config probe, authenticate, logout,
            // session load/list/close) reads the same `${RYU_PI_…}` references.
            apply_managed_pi_secret_env(&mut stdio.env);
            ensure_gateway_spawn_ready(&stdio)?;
            agent_client_protocol::schema::v1::McpServer::Stdio(
                crate::agent_sandbox::confine_classified_codex_stdio(stdio, codex).map_err(
                    |error| {
                        anyhow::anyhow!("preparing the managed Codex OS deletion boundary: {error}")
                    },
                )?,
            )
        }
        other => other,
    };
    Ok(AcpSpawn::new(server))
}
