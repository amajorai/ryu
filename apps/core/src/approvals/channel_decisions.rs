//! Deciding a pending tool approval from a chat app button.
//!
//! When a channel turn ends with a gated tool call waiting in the inbox, Core
//! hands the channel one [`ChannelApprovalPrompt`] per approval. The prompt
//! carries an opaque token, never the approval id or the tool arguments. A
//! button press comes back as a [`ChannelPress`] and is decided by
//! [`ApprovalEngine::decide_from_channel`], which ends in the same
//! [`ApprovalEngine::decide`] the inbox uses, so the single-winner transition
//! and the action run are unchanged.
//!
//! The Gateway proves who pressed (the platform's own delivery proof and the
//! DM access gate). Core decides whether that chat account may decide:
//!
//! 1. The token is known and was issued for this connection and conversation.
//! 2. The connection's setting is on ([`super::channel_settings`]).
//! 3. The chat account is named on the connection, and the Ryu user it is
//!    linked to may decide approvals on this node right now.
//! 4. The approval is not one that stays in the app ([`app_only`]).
//!
//! Tokens are kept in memory. After a restart a press answers "expired" and
//! the approval stays in the inbox.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::channel_settings::valid_connection;
use super::push::{approval_push_audience, ApprovalPushAudience};
use super::{ApprovalEngine, ApprovalKind, ApprovalRequest, ApprovalStatus, PendingAction};

/// How long a prompt's buttons stay usable.
pub const PROMPT_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// Most prompts kept. Reaching it drops the oldest; its buttons then expire.
const MAX_PROMPTS: usize = 4096;

/// Most prompts one turn hands to the channel.
const MAX_PROMPTS_PER_TURN: usize = 5;

/// Longest summary a chat message shows.
const SUMMARY_CHARS: usize = 160;

/// Risk tags of approvals that are decided in the app only: the calls that
/// ask in every approval mode, changes to Ryu's own controls, and calls held
/// because a program read private data first. [`app_only`] adds device tools,
/// secret and money tool ids, and calls whose card is written from their
/// arguments (agent email).
const APP_ONLY_TAGS: &[&str] = &[
    "agent-configuration",
    "privileged-native-execution",
    "challenge-submission",
    "core-api-mutation",
    "workspace-shell-mutation",
    "governance-mutation",
    super::HELD_EGRESS_TAG,
    // Money verbs from the smart classifier.
    "pay",
    "purchase",
    "buy",
    "transfer",
    "wire",
    "charge",
    "refund",
];

/// Tool id segments that mark secrets or money, whatever the verb.
const APP_ONLY_SEGMENTS: &[&str] = &[
    "vault",
    "secrets",
    "credentials",
    "wallet",
    "billing",
    "payments",
];

#[derive(Debug, Clone)]
struct PromptRecord {
    approval_id: String,
    connection: String,
    conversation_id: String,
    minted_at: Instant,
}

static PROMPTS: LazyLock<Mutex<HashMap<String, PromptRecord>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// What a channel shows for one waiting approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelApprovalPrompt {
    /// Opaque, single-approval token for the button callback data.
    pub token: String,
    pub agent_name: Option<String>,
    pub tool_name: String,
    /// The approval's title, cut to a short line. Never the arguments.
    pub summary: String,
}

/// One button press, as the Gateway reports it after its own checks.
#[derive(Debug, Clone)]
pub struct ChannelPress {
    pub token: String,
    pub approve: bool,
    pub connection: String,
    pub conversation_id: String,
    pub platform: String,
    pub sender_id: String,
}

/// How a press ended. Only [`ChannelOutcome::Decided`] changed anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelOutcome {
    /// This press decided the approval.
    Decided,
    /// The approval had already been decided, expired or cancelled.
    AlreadyDecided,
    /// The presser may not decide this approval here.
    Refused,
    /// The token or the approval is gone.
    Expired,
    /// Core could not read or write the approval.
    Unavailable,
}

/// The answer to a press. `status` is set only for a presser who may decide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelDecision {
    pub outcome: ChannelOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ApprovalStatus>,
    /// Machine-readable cause, for the Gateway log. Not shown in chat.
    pub reason: &'static str,
}

impl ChannelDecision {
    fn new(outcome: ChannelOutcome, status: Option<ApprovalStatus>, reason: &'static str) -> Self {
        Self {
            outcome,
            status,
            reason,
        }
    }
}

/// Whether `req` is decided in the app only.
pub fn app_only(req: &ApprovalRequest) -> bool {
    if req.kind != ApprovalKind::ToolCall {
        return true;
    }
    let Some(PendingAction::ToolCall { tool_id, .. }) = &req.action else {
        return true;
    };
    if req
        .risk_tags
        .iter()
        .any(|tag| APP_ONLY_TAGS.contains(&tag.as_str()))
    {
        return true;
    }
    if crate::device_tools::redaction::is_device_tool_id(req.source_ref.as_deref())
        || crate::device_tools::redaction::is_device_tool_id(Some(tool_id.as_str()))
    {
        return true;
    }
    // A chat message hides the arguments, and this call is judged by them.
    if super::tool_intent::has_argument_card(tool_id) {
        return true;
    }
    tool_id
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|segment| APP_ONLY_SEGMENTS.contains(&segment))
}

/// Whether `req` was raised by a tool call in `conversation_id`.
fn raised_in(req: &ApprovalRequest, conversation_id: &str) -> bool {
    if req.conversation_id.as_deref() == Some(conversation_id) {
        return true;
    }
    matches!(
        &req.action,
        Some(PendingAction::ToolCall { host_conversation_id: Some(host), .. }) if host == conversation_id
    )
}

/// The verdict for a linked user that needs no control-plane lookup, or
/// `None` on an organization or team node, where the control plane decides.
pub(super) fn audience_verdict(audience: &ApprovalPushAudience, user_id: &str) -> Option<bool> {
    match audience {
        ApprovalPushAudience::Unbound => Some(true),
        ApprovalPushAudience::Nobody => Some(false),
        ApprovalPushAudience::Owner(owner) => Some(owner.as_deref() == Some(user_id)),
        ApprovalPushAudience::Members => None,
    }
}

/// Whether the Ryu user a chat account is linked to may decide approvals on
/// this node now. A refusal or an outage of the control plane is `false`.
async fn linked_user_may_decide(http: &reqwest::Client, user_id: &str) -> bool {
    if let Some(verdict) = audience_verdict(&approval_push_audience(), user_id) {
        return verdict;
    }
    crate::sidecar::control_plane::try_resolve_permission_context(http, user_id)
        .await
        .is_ok_and(|resolved| {
            resolved
                .permissions
                .contains(crate::identity_verify::permissions::APPROVALS_DECIDE)
        })
}

fn mint(approval_id: &str, connection: &str, conversation_id: &str) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut prompts = PROMPTS.lock().unwrap_or_else(|poison| poison.into_inner());
    prompts.retain(|_, record| record.minted_at.elapsed() < PROMPT_TTL);
    if prompts.len() >= MAX_PROMPTS {
        if let Some(oldest) = prompts
            .iter()
            .min_by_key(|(_, record)| record.minted_at)
            .map(|(token, _)| token.clone())
        {
            prompts.remove(&oldest);
        }
    }
    prompts.insert(
        token.clone(),
        PromptRecord {
            approval_id: approval_id.to_owned(),
            connection: connection.to_owned(),
            conversation_id: conversation_id.to_owned(),
            minted_at: Instant::now(),
        },
    );
    token
}

fn has_prompt(approval_id: &str) -> bool {
    PROMPTS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .values()
        .any(|record| record.approval_id == approval_id && record.minted_at.elapsed() < PROMPT_TTL)
}

fn prompt_record(token: &str) -> Option<PromptRecord> {
    PROMPTS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(token)
        .cloned()
}

fn short_summary(title: &str) -> String {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() <= SUMMARY_CHARS {
        return title;
    }
    let mut cut: String = title.chars().take(SUMMARY_CHARS).collect();
    cut.push('…');
    cut
}

async fn agent_name(agent_id: Option<&str>) -> Option<String> {
    let store = crate::agents::global()?;
    let record = store.get(agent_id?).await.ok().flatten()?;
    let name = record.name.trim().to_owned();
    (!name.is_empty()).then_some(name)
}

impl ApprovalEngine {
    /// The prompts a channel should post after a turn in `conversation_id` -
    /// one per pending tool approval raised there that has no prompt yet.
    /// Empty when the connection's setting is off.
    pub async fn channel_approval_prompts(
        &self,
        connection: &str,
        conversation_id: &str,
        locale: &str,
    ) -> Vec<ChannelApprovalPrompt> {
        if !valid_connection(connection) {
            return Vec::new();
        }
        if !self
            .channel_approval_settings(connection)
            .await
            .offers_buttons()
        {
            return Vec::new();
        }
        let pending = match self.store.list(Some(ApprovalStatus::Pending)).await {
            Ok(pending) => pending,
            Err(error) => {
                tracing::warn!(%error, "could not list approvals for a channel turn");
                return Vec::new();
            }
        };
        let mut prompts = Vec::new();
        for req in pending {
            if prompts.len() >= MAX_PROMPTS_PER_TURN {
                break;
            }
            if !raised_in(&req, conversation_id) || app_only(&req) || has_prompt(&req.id) {
                continue;
            }
            let Some(PendingAction::ToolCall {
                tool_id, agent_id, ..
            }) = &req.action
            else {
                continue;
            };
            let agent = req.agent_id.as_deref().or(agent_id.as_deref());
            prompts.push(ChannelApprovalPrompt {
                token: mint(&req.id, connection, conversation_id),
                agent_name: agent_name(agent).await,
                tool_name: tool_id.clone(),
                summary: short_summary(&req.localized_title(locale)),
            });
        }
        prompts
    }

    /// Decide the approval behind a chat button press. Every refusal leaves
    /// the approval untouched.
    pub async fn decide_from_channel(&self, press: &ChannelPress) -> ChannelDecision {
        use ChannelOutcome::{AlreadyDecided, Decided, Expired, Refused, Unavailable};
        let Some(record) = prompt_record(&press.token) else {
            return ChannelDecision::new(Expired, None, "unknown_token");
        };
        // The token alone decides nothing: it must come back from the
        // connection and the conversation it was posted in.
        if record.connection != press.connection || record.conversation_id != press.conversation_id
        {
            return ChannelDecision::new(Refused, None, "wrong_place");
        }
        if record.minted_at.elapsed() >= PROMPT_TTL {
            return ChannelDecision::new(Expired, None, "token_expired");
        }
        let settings = self.channel_approval_settings(&press.connection).await;
        if !settings.enabled {
            return ChannelDecision::new(Refused, None, "setting_off");
        }
        let Some(decider) = settings.decider(&press.connection, &press.platform, &press.sender_id)
        else {
            return ChannelDecision::new(Refused, None, "not_linked");
        };
        if !linked_user_may_decide(&self.http, &decider.user_id).await {
            return ChannelDecision::new(Refused, None, "not_permitted");
        }
        let req = match self.store.get(&record.approval_id).await {
            Ok(Some(req)) => req,
            Ok(None) => return ChannelDecision::new(Expired, None, "approval_gone"),
            Err(error) => {
                tracing::warn!(%error, "could not read an approval for a channel decision");
                return ChannelDecision::new(Unavailable, None, "store_error");
            }
        };
        if app_only(&req) {
            return ChannelDecision::new(Refused, None, "app_only");
        }
        if req.status != ApprovalStatus::Pending {
            return ChannelDecision::new(AlreadyDecided, Some(req.status), "already_decided");
        }
        let now = chrono::Utc::now().to_rfc3339();
        if req
            .expires_at
            .as_deref()
            .is_some_and(|expires| expires <= now.as_str())
        {
            return ChannelDecision::new(
                AlreadyDecided,
                Some(ApprovalStatus::Expired),
                "approval_expired",
            );
        }
        let wanted = if press.approve {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        let note = format!("chat:{}", press.platform);
        // No approver is named: a chat press is checked against the linked
        // user above, but it carries no verified caller of this node. The
        // approved action therefore runs with no sender bound, and a tool
        // that acts as the node's own user is refused on a shared node
        // (`ApprovalEngine::execute_approved`).
        match self.decide(&req.id, press.approve, Some(note), None).await {
            Ok(Some(decided)) if decided.status == wanted => {
                tracing::info!(
                    approval = %decided.id,
                    platform = %press.platform,
                    user = %decider.user_id,
                    approved = press.approve,
                    "approval decided from a chat button"
                );
                ChannelDecision::new(Decided, Some(decided.status), "decided")
            }
            Ok(Some(decided)) => {
                ChannelDecision::new(AlreadyDecided, Some(decided.status), "already_decided")
            }
            Ok(None) => ChannelDecision::new(Expired, None, "approval_gone"),
            Err(error) => {
                tracing::warn!(%error, "channel approval decision failed");
                ChannelDecision::new(Unavailable, None, "store_error")
            }
        }
    }
}

#[cfg(test)]
#[path = "channel_decisions_tests.rs"]
mod tests;
