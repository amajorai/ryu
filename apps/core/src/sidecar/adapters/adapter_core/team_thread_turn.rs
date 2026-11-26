use super::*;

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ryu_teams_contracts::{
    asked_brief, asked_by_owner, owner_brief, plan_thread_turn, TeamRecord, TeamThread,
    ThreadRunState, ThreadTurn,
};

use crate::sidecar::capability_consumer::CapabilityConsumer;

// ── Task ownership in a group thread ─────────────────────────────────────────
//
// A group thread can name one owner: the member that holds the task. The record
// lives in the teams provider and Core reads it through one capability, never
// through a named app. A thread with no record, or with a provider that does
// not serve the capability, runs exactly as it did before.
//
// The owner does not replace the team's strategy. It decides who takes part in a
// turn (the owner, plus members the user addressed), the strategy then runs over
// those members, and afterwards the members the owner asked answer once.

/// Read a group thread's owner and state, registering the thread on first use.
/// Request `{ "team_id", "conversation_id" }`; reply `200 { "thread": TeamThread }`.
pub const CAP_TEAMS_THREAD: &str = "teams.thread";

/// How often a running member is checked against a Stop.
const STOP_POLL: Duration = Duration::from_secs(2);

/// What a new turn on a stopped thread is told.
const STOPPED_REFUSAL: &str = "This group thread is stopped. Resume it in Groups to continue.";

/// One turn's view of the thread it runs in.
pub struct TeamThreadTurn {
    capabilities: CapabilityConsumer,
    team_id: String,
    team_name: String,
    conversation_id: String,
    /// The owner for this turn. `None` when the thread has no owner, in which
    /// case only Stop applies.
    owner: Option<String>,
    /// `(agent id, display name)` of every member of the team.
    roster: Vec<(String, String)>,
    /// The members the strategy runs over this turn.
    responders: Vec<String>,
    /// The owner's latest reply this turn, read for the members it asked.
    owner_reply: std::sync::Mutex<String>,
    stopped: AtomicBool,
}

/// The thread's record, or `None` when there is nothing to apply: no provider
/// serves the capability, the call failed, or the reply is not a thread.
async fn fetch_thread(
    capabilities: &CapabilityConsumer,
    team_id: &str,
    conversation_id: &str,
) -> Option<TeamThread> {
    let body = serde_json::json!({ "team_id": team_id, "conversation_id": conversation_id });
    let reply = capabilities
        .call_capability(CAP_TEAMS_THREAD, &body)
        .await
        .ok()?;
    if !reply.is_success() {
        return None;
    }
    serde_json::from_value(reply.body["thread"].clone()).ok()
}

/// Apply the thread's ownership record to a team turn.
///
/// Returns the team the strategy should run over (narrowed when the thread has
/// an owner) and the turn handle, or the refusal for a stopped thread. A
/// temporary chat has no thread, so it is returned unchanged.
pub async fn open_team_thread_turn(
    capabilities: &CapabilityConsumer,
    team: TeamRecord,
    req: &ChatStreamRequest,
    agent_store: &AgentStore,
) -> Result<(TeamRecord, Option<Arc<TeamThreadTurn>>), String> {
    let conversation_id = req.conversation_id.as_deref().filter(|_| req.persist);
    let user_text = last_user_message(&req.messages);
    open_thread_turn(capabilities, team, conversation_id, &user_text, agent_store).await
}

pub(crate) async fn open_thread_turn(
    capabilities: &CapabilityConsumer,
    team: TeamRecord,
    conversation_id: Option<&str>,
    user_text: &str,
    agent_store: &AgentStore,
) -> Result<(TeamRecord, Option<Arc<TeamThreadTurn>>), String> {
    let Some(conversation_id) = conversation_id else {
        return Ok((team, None));
    };
    let Some(thread) = fetch_thread(capabilities, &team.id, conversation_id).await else {
        return Ok((team, None));
    };
    let roster = member_names(&team.members, agent_store).await;
    let (team, owner) = match plan_thread_turn(&team, Some(&thread), user_text, &roster) {
        ThreadTurn::Stopped => return Err(STOPPED_REFUSAL.to_owned()),
        ThreadTurn::Strategy => (team, None),
        ThreadTurn::Owned(owned) => (owned.team, Some(owned.owner)),
    };
    let turn = TeamThreadTurn {
        capabilities: capabilities.clone(),
        team_id: team.id.clone(),
        team_name: team.name.clone(),
        conversation_id: conversation_id.to_owned(),
        owner,
        roster,
        responders: team.members.clone(),
        owner_reply: std::sync::Mutex::new(String::new()),
        stopped: AtomicBool::new(false),
    };
    Ok((team, Some(Arc::new(turn))))
}

impl TeamThreadTurn {
    /// Whether a Stop was seen during this turn.
    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Read the thread's state again and remember a Stop.
    async fn refresh_stopped(&self) -> bool {
        if self.is_stopped() {
            return true;
        }
        let stopped = fetch_thread(&self.capabilities, &self.team_id, &self.conversation_id)
            .await
            .is_some_and(|thread| thread.run_state == ThreadRunState::Stopped);
        if stopped {
            self.stopped.store(true, Ordering::SeqCst);
        }
        stopped
    }

    fn display_name(&self, agent_id: &str) -> String {
        self.roster
            .iter()
            .find(|(id, _)| id == agent_id)
            .map_or_else(|| agent_id.to_owned(), |(_, name)| name.clone())
    }

    /// The messages one member runs with: the owner is told it holds the task
    /// and how to ask a teammate. Everyone else gets them unchanged.
    pub(crate) fn brief(&self, member_id: &str, messages: Vec<UiMessage>) -> Vec<UiMessage> {
        match self.owner.as_deref() {
            Some(owner) if owner == member_id => messages_with_preamble(
                &messages,
                &owner_brief(&self.team_name, owner, &self.roster),
            ),
            _ => messages,
        }
    }

    /// Drive one member's run, ending it when the thread is stopped.
    ///
    /// The state is read before the run starts and every [`STOP_POLL`] while it
    /// is in flight. On a Stop the run's agent is told to cancel (ACP and A2A
    /// turns are keyed by the conversation) and the run is dropped. The team
    /// turn's own driver is left alone so it can still save what was said.
    pub(crate) async fn run<F>(
        &self,
        member_id: &str,
        in_thread: bool,
        run: F,
    ) -> anyhow::Result<String>
    where
        F: Future<Output = anyhow::Result<String>>,
    {
        if self.refresh_stopped().await {
            anyhow::bail!("the group thread was stopped");
        }
        tokio::pin!(run);
        let reply = loop {
            tokio::select! {
                reply = &mut run => break reply,
                () = tokio::time::sleep(STOP_POLL) => {
                    if self.refresh_stopped().await {
                        crate::sidecar::adapters::acp::request_cancel(&self.conversation_id);
                        crate::a2a::request_cancel(&self.conversation_id);
                        anyhow::bail!("the group thread was stopped");
                    }
                }
            }
        };
        if in_thread && self.owner.as_deref() == Some(member_id) {
            if let Ok(text) = &reply {
                let mut owner_reply = self
                    .owner_reply
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *owner_reply = text.clone();
            }
        }
        reply
    }

    /// The members the owner asked in its reply and that have not answered this
    /// turn, each with its id, display name and the messages to run with. Their
    /// replies are not read for further asks, so a turn ends after one round.
    pub(crate) fn asked(&self, original: &[UiMessage]) -> Vec<(String, String, Vec<UiMessage>)> {
        let Some(owner) = self.owner.as_deref() else {
            return Vec::new();
        };
        let reply = self
            .owner_reply
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if reply.trim().is_empty() {
            return Vec::new();
        }
        let brief = asked_brief(&self.display_name(owner), &reply);
        asked_by_owner(&reply, owner, &self.responders, &self.roster)
            .into_iter()
            .map(|id| {
                let name = self.display_name(&id);
                (id, name, messages_with_preamble(original, &brief))
            })
            .collect()
    }
}

impl TeamRunDeps {
    /// Whether this turn's thread was stopped while it ran.
    pub(crate) fn stopped(&self) -> bool {
        self.thread
            .as_deref()
            .is_some_and(TeamThreadTurn::is_stopped)
    }
}

#[cfg(test)]
#[path = "team_thread_turn_tests.rs"]
mod tests;
