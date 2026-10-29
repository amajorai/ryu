use super::*;

/// Authenticate to an ACP agent with one of the methods it advertised in its
/// `initialize` response (`auth_methods`, surfaced by [`probe_acp_config`] as
/// `authMethods`). This drives the ACP Authentication flow — e.g. a subscription
/// / OAuth "login" — so agents that gate `session/new` behind auth become usable.
/// The agent subprocess owns the actual login UX (opening a browser, etc.).
///
/// **This waits for the `authenticate` RESPONSE, not for the login.** The
/// distinction is not academic: `connect_with` runs the connection only until
/// the closure below returns (agent-client-protocol 3.5.0, `src/jsonrpc.rs`),
/// and `AcpAgent` wraps the spawned agent in a `ChildGuard` whose `Drop` calls
/// `terminate`, a SIGKILL of the agent's whole process group on Unix (3.5.0,
/// `src/acp_agent.rs`; the agent is spawned as its own group leader). So
/// returning here SIGKILLs the agent, and on Linux also a browser it launched
/// into that group (`xdg-open`), which 0.11's kill of the direct child spared.
/// For an agent that answers `authenticate` once its browser flow is *finished*
/// that is correct; for the common CLI shape that answers once the browser is
/// *opened*, it kills the callback server mid-flow and the credential is never
/// written. `acp_authenticate` (`server/mod.rs`) exists to keep that honest —
/// it checks Pi's stored credential rather than trusting this returning `Ok`,
/// and reports `verified: false` when there is nothing to check against.
///
/// Invalidates the probe cache for this spawn command on success so the next
/// `acp-config` read reflects the now-authenticated state.
pub async fn authenticate_acp(spawn_cmd: String, method_id: String) -> anyhow::Result<()> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    // The same bearer-free form `probe_acp_config_with` keys entries on.
    let cache_key = without_scoped_bearers(&spawn_cmd).into_owned();
    tokio::time::timeout(
        std::time::Duration::from_secs(300),
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let method_id = method_id.clone();
                async move {
                    cx.send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    cx.send_request(AuthenticateRequest::new(AuthMethodId::new(
                        method_id.as_str(),
                    )))
                    .block_task()
                    .await?;
                    Ok(())
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP authenticate timed out after 300s"))?
    .map_err(|e| anyhow::anyhow!("ACP authenticate: {e}"))?;
    // The agent's config may now differ (auth unlocked session/new); drop the
    // cache. This is also what un-sticks a CACHED FAILURE: the probe of a
    // signed-out agent fails, and logging in is the fix — so it must not wait out
    // the failure TTL.
    probe_cache::invalidate(&cache_key);
    record_explicit_codex_auth_change(&cache_key);
    Ok(())
}

/// Whether `spawn_cmd` runs Codex in the isolated gateway `CODEX_HOME`, whose
/// `auth.json` custody [`crate::codex_config`] tracks.
pub(super) fn spawn_uses_codex_gateway_home(spawn_cmd: &str) -> bool {
    let Ok(agent) = AcpSpawn::from_str(spawn_cmd) else {
        return false;
    };
    let McpServer::Stdio(stdio) = agent.into_server() else {
        return false;
    };
    let home = crate::codex_config::codex_home();
    super::super::acp_direct_spawn::declared_environment(&stdio)
        .iter()
        .any(|(name, value)| name == "CODEX_HOME" && PathBuf::from(value) == home)
}

/// After an explicit Ryu-side sign-in, account switch or sign-out of the
/// gateway-routed Codex, keep that choice from being overwritten by a later
/// token refresh of the user's own Codex CLI login. Best-effort: the auth
/// change already happened, so a marker write failure is only logged.
fn record_explicit_codex_auth_change(spawn_cmd: &str) {
    if !spawn_uses_codex_gateway_home(spawn_cmd) {
        return;
    }
    if let Err(error) = crate::codex_config::record_explicit_auth_change() {
        tracing::warn!(error = %error, "could not record the explicit Codex sign-in change");
    }
}

/// End an ACP agent's authenticated session (ACP `logout`). The inverse of
/// [`authenticate_acp`]: agents that support the `logout` capability
/// (`agentCapabilities.auth.logout`) drop their stored credentials, so the next
/// `session/new` requires re-authentication. Best-effort with a short ceiling;
/// invalidates the probe cache so the desktop re-reads the now-unauthenticated
/// auth state. A no-op error surfaces to the caller for agents that don't
/// implement it.
pub async fn logout_acp(spawn_cmd: String) -> anyhow::Result<()> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    // The same bearer-free form `probe_acp_config_with` keys entries on.
    let cache_key = without_scoped_bearers(&spawn_cmd).into_owned();
    tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                cx.send_request(ryu_initialize_request())
                    .block_task()
                    .await?;
                cx.send_request(LogoutRequest::new()).block_task().await?;
                Ok(())
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP logout timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP logout: {e}"))?;
    // Auth state changed; drop the cached probe so the next read reflects it.
    probe_cache::invalidate(&cache_key);
    record_explicit_codex_auth_change(&cache_key);
    Ok(())
}

/// Resume an ACP agent's own prior session — prefer `session/resume` when the
/// agent advertises that capability, otherwise use `session/load`. `resume`
/// reconnects without replaying the native history; `load` asks the agent to
/// replay its retained history. If neither capability is advertised this
/// returns `{ supported: false }` rather than pretending native persistence is
/// available. On success the response includes the mode plus the resumed
/// session's advertised state (`{ modes, models, configOptions }`).
///
/// `session_id` is the agent-native session id (e.g. a Claude Code / Codex
/// session id, as persisted on import); `cwd` is the workspace the session ran in.
pub async fn load_acp_session(
    spawn_cmd: String,
    session_id: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    // The resumed session's advertised config feeds the same composer pickers the
    // cold probe does, so it gets the same synthesized plan-mode option. Omitting
    // it here would make the pill disappear on exactly the sessions a user resumed.
    let plan_cmd = spawn_cmd.clone();
    let session_meta = is_claude_code_spawn(&spawn_cmd).then(claude_code_session_meta);
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_meta = session_meta.clone();
                let session_id = session_id.clone();
                let cwd = cwd.clone();
                let plan_cmd = plan_cmd.clone();
                async move {
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    let caps = read_agent_caps(&init);
                    if caps.session_resume {
                        let mut resume = ResumeSessionRequest::new(
                            SessionId::new(session_id.as_str()),
                            cwd.clone(),
                        );
                        resume.meta = session_meta.clone();
                        let (resp, models): (ResumeSessionResponse, _) =
                            send_with_models(&cx, resume).await?;
                        return Ok(serde_json::json!({
                            "supported": true,
                            "mode": "resume",
                            "sessionId": session_id,
                            "modes": resp.modes,
                            "models": models,
                            "configOptions": with_plan_mode_option(&plan_cmd, resp.config_options),
                        }));
                    }
                    // Only attempt load when the agent advertises the capability;
                    // calling it on an agent that lacks it would just error.
                    if !caps.load_session {
                        return Ok(serde_json::json!({ "supported": false }));
                    }
                    let mut load =
                        LoadSessionRequest::new(SessionId::new(session_id.as_str()), cwd);
                    load.meta = session_meta;
                    let (resp, models): (
                        agent_client_protocol::schema::v1::LoadSessionResponse,
                        _,
                    ) = send_with_models(&cx, load).await?;
                    Ok(serde_json::json!({
                        "supported": true,
                        "mode": "load",
                        "sessionId": session_id,
                        "modes": resp.modes,
                        "models": models,
                        "configOptions": with_plan_mode_option(&plan_cmd, resp.config_options),
                    }))
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session resume/load timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session resume/load: {e}"))?;
    Ok(value)
}

/// List the sessions an ACP agent is tracking (ACP `session/list`). Best-effort:
/// an agent that doesn't implement it (the flagship pi spawns fresh per
/// `session/new`) returns `{ sessions: [], unsupported: true }` rather than an
/// error. Returns `{ sessions: [...], nextCursor? }` on success.
pub async fn list_acp_sessions(spawn_cmd: String) -> anyhow::Result<serde_json::Value> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                cx.send_request(ryu_initialize_request())
                    .block_task()
                    .await?;
                match cx
                    .send_request(ListSessionsRequest::new())
                    .block_task()
                    .await
                {
                    Ok(resp) => {
                        let resp: ListSessionsResponse = resp;
                        Ok(serde_json::json!({
                            "sessions": resp.sessions,
                            "nextCursor": resp.next_cursor,
                        }))
                    }
                    // Method-not-found / unsupported → empty, not an error.
                    Err(_) => Ok(serde_json::json!({ "sessions": [], "unsupported": true })),
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/list timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/list: {e}"))?;
    Ok(value)
}

/// Delete/close an ACP agent session (ACP `session/close`). Best-effort — an
/// agent that doesn't implement it returns an error the caller can surface.
pub async fn close_acp_session(spawn_cmd: String, session_id: String) -> anyhow::Result<bool> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    let closed = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_id = session_id.clone();
                async move {
                    // The `initialize` answer was previously thrown away, which is
                    // why this fired `session/close` at agents that never
                    // advertised it (captured responses show pi-acp, qwen-code and
                    // factory-droid without it) and surfaced the rejection as a
                    // 502. Read the capability instead and report "unsupported"
                    // honestly — a delete that cannot work should not look like a
                    // node that is broken.
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    if !read_agent_caps(&init).session_close {
                        return Ok(false);
                    }
                    cx.send_request(CloseSessionRequest::new(SessionId::new(
                        session_id.as_str(),
                    )))
                    .block_task()
                    .await?;
                    Ok(true)
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/close timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/close: {e}"))?;
    Ok(closed)
}
