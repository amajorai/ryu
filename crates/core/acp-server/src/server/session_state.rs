use super::*;

impl State {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Fetch the node's agents. Reachability, credential and permission
    /// failures are fatal (the session could never run); anything else
    /// degrades to "no modes".
    async fn agents(&self) -> Result<Vec<AgentSummary>, agent_client_protocol::Error> {
        match self.core.list_agents().await {
            Ok(agents) => Ok(agents),
            Err(
                error @ (CoreError::Unreachable { .. }
                | CoreError::Unauthorized { .. }
                | CoreError::Forbidden { .. }),
            ) => Err(error.into()),
            Err(error) => {
                tracing::warn!("could not list Ryu agents, continuing without modes: {error}");
                Ok(Vec::new())
            }
        }
    }

    /// The agent a new session starts with: `--agent`, else the node default.
    fn pick_agent(
        &self,
        agents: &[AgentSummary],
        preferred: Option<&str>,
    ) -> Result<Option<String>, agent_client_protocol::Error> {
        if let Some(wanted) = preferred.or(self.default_agent.as_deref()) {
            if agents.is_empty() || agents.iter().any(|agent| agent.id == wanted) {
                return Ok(Some(wanted.to_owned()));
            }
            let available: Vec<&str> = agents.iter().map(|agent| agent.id.as_str()).collect();
            return Err(invalid_params(format!(
                "Ryu has no agent '{wanted}'. Available agents: {}",
                available.join(", ")
            )));
        }
        Ok(agents
            .iter()
            .find(|agent| agent.enabled == Some(true))
            .or_else(|| agents.iter().find(|agent| agent.id == "ryu"))
            .or_else(|| agents.first())
            .map(|agent| agent.id.clone()))
    }

    pub(super) async fn new_session(
        &self,
        request: NewSessionRequest,
    ) -> Result<NewSessionResponse, agent_client_protocol::Error> {
        if !request.mcp_servers.is_empty() {
            tracing::warn!(
                count = request.mcp_servers.len(),
                "ignoring client-provided MCP servers; Ryu agents use the MCP servers configured in Ryu"
            );
        }
        let agents = self.agents().await?;
        let agent_id = self.pick_agent(&agents, None)?;
        let conversation_id = uuid::Uuid::new_v4().to_string();
        let modes = mode_state(&agents, agent_id.as_deref());
        self.sessions().insert(
            conversation_id.clone(),
            Session {
                conversation_id: conversation_id.clone(),
                agent_id,
                agents,
                cwd: cwd_string(&request.cwd),
                transcript: Vec::new(),
                active: None,
            },
        );
        Ok(NewSessionResponse::new(conversation_id).modes(modes))
    }

    pub(super) async fn load_session(
        &self,
        request: LoadSessionRequest,
        cx: &ConnectionTo<Client>,
    ) -> Result<LoadSessionResponse, agent_client_protocol::Error> {
        let conversation_id = request.session_id.0.to_string();
        let detail = match self.core.conversation(&conversation_id).await {
            Ok(detail) => detail,
            Err(CoreError::Http { status: 404, .. }) => {
                return Err(invalid_params(format!(
                    "Ryu has no conversation '{conversation_id}'"
                )))
            }
            Err(error) => return Err(error.into()),
        };
        let agents = self.agents().await?;
        let agent_id = match detail.agent_id.clone() {
            Some(stored) => Some(stored),
            None => self.pick_agent(&agents, None)?,
        };

        // Replay the history before answering, as the protocol requires.
        let mut transcript = Vec::new();
        for message in &detail.messages {
            if message.content.is_empty() {
                continue;
            }
            let chunk = ContentChunk::new(ContentBlock::from(message.content.clone()));
            let (role, update) = match message.role.as_str() {
                "user" => ("user", SessionUpdate::UserMessageChunk(chunk)),
                "assistant" => ("assistant", SessionUpdate::AgentMessageChunk(chunk)),
                _ => continue,
            };
            cx.send_notification(SessionNotification::new(request.session_id.clone(), update))?;
            transcript.push(Turn {
                role,
                text: message.content.clone(),
            });
        }

        let modes = mode_state(&agents, agent_id.as_deref());
        self.sessions().insert(
            conversation_id.clone(),
            Session {
                conversation_id,
                agent_id,
                agents,
                cwd: cwd_string(&request.cwd),
                transcript,
                active: None,
            },
        );
        Ok(LoadSessionResponse::new().modes(modes))
    }

    pub(super) fn set_mode(
        &self,
        request: &SetSessionModeRequest,
    ) -> Result<SetSessionModeResponse, agent_client_protocol::Error> {
        let mut sessions = self.sessions();
        let session = sessions
            .get_mut(request.session_id.0.as_ref())
            .ok_or_else(|| invalid_params(format!("unknown session '{}'", request.session_id)))?;
        let mode = request.mode_id.0.as_ref();
        if !session.agents.iter().any(|agent| agent.id == mode) {
            return Err(invalid_params(format!("Ryu has no agent '{mode}'")));
        }
        session.agent_id = Some(mode.to_owned());
        Ok(SetSessionModeResponse::new())
    }

    pub(super) fn begin_prompt(
        &self,
        session_id: &SessionId,
    ) -> Result<PromptJob, agent_client_protocol::Error> {
        let mut sessions = self.sessions();
        let session = sessions
            .get_mut(session_id.0.as_ref())
            .ok_or_else(|| invalid_params(format!("unknown session '{session_id}'")))?;
        if session.active.is_some() {
            return Err(agent_client_protocol::Error::new(
                agent_client_protocol::ErrorCode::InvalidRequest.into(),
                "a prompt is already running in this session",
            ));
        }
        let cancel = CancellationToken::new();
        session.active = Some(cancel.clone());
        Ok(PromptJob {
            session_id: session_id.clone(),
            conversation_id: session.conversation_id.clone(),
            agent_id: session.agent_id.clone(),
            cwd: session.cwd.clone(),
            history: session.transcript.clone(),
            cancel,
        })
    }

    pub(super) fn end_prompt(&self, session_key: &str, turns: Vec<Turn>) {
        if let Some(session) = self.sessions().get_mut(session_key) {
            session.active = None;
            session.transcript.extend(turns);
        }
    }

    pub(super) fn cancel(&self, session_id: &SessionId) {
        if let Some(token) = self
            .sessions()
            .get(session_id.0.as_ref())
            .and_then(|session| session.active.clone())
        {
            token.cancel();
        }
    }

    /// The client went away: stop every streaming turn in Core.
    pub(super) async fn stop_active_runs(&self) {
        let active: Vec<String> = self
            .sessions()
            .values()
            .filter(|session| session.active.is_some())
            .map(|session| session.conversation_id.clone())
            .collect();
        for conversation_id in active {
            if let Err(error) = self.core.cancel(&conversation_id).await {
                tracing::warn!("could not stop the Ryu run for {conversation_id}: {error}");
            }
        }
    }
}

fn cwd_string(cwd: &std::path::Path) -> Option<String> {
    let value = cwd.to_string_lossy().into_owned();
    (!value.trim().is_empty()).then_some(value)
}

/// Ryu agents as ACP session modes. `None` when there is nothing to choose.
fn mode_state(agents: &[AgentSummary], current: Option<&str>) -> Option<SessionModeState> {
    let current = current?;
    if agents.is_empty() {
        return None;
    }
    let modes = agents
        .iter()
        .map(|agent| {
            let name = if agent.name.trim().is_empty() {
                agent.id.clone()
            } else {
                agent.name.clone()
            };
            SessionMode::new(agent.id.clone(), name).description(agent.description.clone())
        })
        .collect();
    Some(SessionModeState::new(current.to_owned(), modes))
}
