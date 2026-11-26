//! Per-thread **task ownership** for a group chat.
//!
//! A group thread is one conversation whose turns are addressed to a team. By
//! default every member answers it as the team's [`Coordination`] strategy says.
//! A thread can also name one **owner**: exactly one member that holds the task.
//! While an owner is set, the owner answers each turn and the other members
//! answer only when the user addresses them (`@name` or `@id`) or the owner asks
//! them in its own reply.
//!
//! The owner is not the team's `lead_agent_id`. The lead is a group setting used
//! by a strategy (the synthesizer, the router's classifier). The owner is a
//! thread setting that decides **who takes part** in a turn; the strategy then
//! runs over those members, see [`plan_thread_turn`].
//!
//! The record lives in the teams provider (the `teams.thread` capability). The
//! planning helpers here are pure, so both sides of the wire can test them
//! without a provider.

use serde::{Deserialize, Serialize};

use crate::{Coordination, TeamRecord};

/// Whether a thread may start new runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadRunState {
    /// Turns run. The default, and what a thread with no record has.
    #[default]
    Active,
    /// Stopped by someone who manages the group. No run starts until Resume.
    Stopped,
}

impl ThreadRunState {
    /// Parse the stored string, treating anything unknown as [`Self::Active`] so
    /// a newer provider's state never blocks a thread by accident.
    pub fn from_str_lenient(value: &str) -> Self {
        match value {
            "stopped" => Self::Stopped,
            _ => Self::Active,
        }
    }

    /// The stored string form (kebab-case), also the wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Stopped => "stopped",
        }
    }
}

fn run_state_lenient<'de, D>(deserializer: D) -> Result<ThreadRunState, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw
        .as_deref()
        .map_or_else(ThreadRunState::default, ThreadRunState::from_str_lenient))
}

/// The ownership record of one group thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamThread {
    /// The team the thread belongs to.
    pub team_id: String,
    /// The conversation that is the thread.
    pub conversation_id: String,
    /// The member that owns the task, or `None` when the thread has no owner
    /// and the team's strategy applies unchanged.
    #[serde(default)]
    pub owner_agent_id: Option<String>,
    /// Read leniently, like the team's strategy.
    #[serde(default, deserialize_with = "run_state_lenient")]
    pub run_state: ThreadRunState,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Request body of the `teams.thread` capability: read the thread of a
/// conversation, creating its record on first use.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenThread {
    pub team_id: String,
    pub conversation_id: String,
}

/// How one user turn in a group thread is answered.
#[derive(Debug, Clone)]
pub enum ThreadTurn {
    /// No owner applies. The team's strategy runs over every member, as it did
    /// before threads had owners.
    Strategy,
    /// The thread is stopped. Nothing runs until it is resumed.
    Stopped,
    /// The owner holds the task.
    Owned(OwnedTurn),
}

/// A turn in a thread that has an owner.
#[derive(Debug, Clone)]
pub struct OwnedTurn {
    /// The owning member's agent id.
    pub owner: String,
    /// The team narrowed to this turn's responders: the owner first, then the
    /// members the user addressed, in member order. The strategy runs over it.
    pub team: TeamRecord,
}

/// Decide who answers a turn.
///
/// `roster` is `(agent id, display name)` for each member, used to find the
/// members the user addressed in `user_text`.
///
/// An owner that is no longer a member does not count: the thread falls back to
/// [`ThreadTurn::Strategy`], so removing an agent from a group never leaves a
/// thread that nobody answers.
pub fn plan_thread_turn(
    team: &TeamRecord,
    thread: Option<&TeamThread>,
    user_text: &str,
    roster: &[(String, String)],
) -> ThreadTurn {
    let Some(thread) = thread else {
        return ThreadTurn::Strategy;
    };
    if thread.run_state == ThreadRunState::Stopped {
        return ThreadTurn::Stopped;
    }
    let Some(owner) = thread
        .owner_agent_id
        .as_ref()
        .filter(|owner| team.members.contains(*owner))
    else {
        return ThreadTurn::Strategy;
    };
    let addressed = mentioned_members(user_text, roster);
    let mut responders = vec![owner.clone()];
    for member in &team.members {
        if member != owner && addressed.contains(member) {
            responders.push(member.clone());
        }
    }
    let mut narrowed = team.clone();
    if responders.len() == 1 {
        // One responder needs no fan-out, synthesis or routing.
        narrowed.coordination = Coordination::Broadcast;
        narrowed.lead_agent_id = None;
    } else if !narrowed
        .lead_agent_id
        .as_ref()
        .is_some_and(|lead| responders.contains(lead))
    {
        // The lead is not taking part, so the owner stands in for it.
        narrowed.lead_agent_id = Some(owner.clone());
    }
    narrowed.members = responders;
    ThreadTurn::Owned(OwnedTurn {
        owner: owner.clone(),
        team: narrowed,
    })
}

/// The members `text` addresses with `@id` or `@name`, in roster order.
///
/// Matching ignores case and needs a word boundary after the mention, so
/// `@ada` does not address a member named `adam`. When two candidates match at
/// the same `@`, the longer one wins (`@Ada Lovelace` is not also `@Ada`).
pub fn mentioned_members(text: &str, roster: &[(String, String)]) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut hit = vec![false; roster.len()];
    for (at, _) in lowered.match_indices('@') {
        let rest = &lowered[at + 1..];
        let mut best: Option<(usize, usize)> = None;
        for (index, (id, name)) in roster.iter().enumerate() {
            for candidate in [id.to_lowercase(), name.to_lowercase()] {
                if candidate.is_empty() || !rest.starts_with(&candidate) {
                    continue;
                }
                let boundary = rest[candidate.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| !(next.is_alphanumeric() || next == '_' || next == '-'));
                if boundary && best.is_none_or(|(_, len)| candidate.len() > len) {
                    best = Some((index, candidate.len()));
                }
            }
        }
        if let Some((index, _)) = best {
            hit[index] = true;
        }
    }
    roster
        .iter()
        .zip(hit)
        .filter(|(_, hit)| *hit)
        .map(|((id, _), _)| id.clone())
        .collect()
}

/// The note prepended to the owner's prompt: it holds the task, and how it asks
/// a teammate. `roster` is `(agent id, display name)` for every member.
pub fn owner_brief(team_name: &str, owner: &str, roster: &[(String, String)]) -> String {
    let teammates = roster
        .iter()
        .filter(|(id, _)| id != owner)
        .map(|(id, name)| format!("- {name} (id: {id})"))
        .collect::<Vec<_>>()
        .join("\n");
    if teammates.is_empty() {
        return format!(
            "You own this task in the group \"{team_name}\". Answer the user yourself."
        );
    }
    format!(
        "You own this task in the group \"{team_name}\". Answer the user yourself. Your \
         teammates answer only when you ask them. To ask one, write @ followed by their id \
         with your request, and they reply after you.\n\nTeammates:\n{teammates}"
    )
}

/// The note prepended to a member's prompt when the owner asked it for help.
pub fn asked_brief(owner_name: &str, owner_reply: &str) -> String {
    format!(
        "{owner_name} owns this task and asked you for help. Their message:\n\n\
         {owner_reply}\n\nReply to what they asked you."
    )
}

/// The members the owner asked in `owner_reply` that have not answered this
/// turn: every mentioned member except the owner and the `responders`.
pub fn asked_by_owner(
    owner_reply: &str,
    owner: &str,
    responders: &[String],
    roster: &[(String, String)],
) -> Vec<String> {
    mentioned_members(owner_reply, roster)
        .into_iter()
        .filter(|id| id != owner && !responders.contains(id))
        .collect()
}

#[cfg(test)]
#[path = "thread_tests.rs"]
mod tests;
