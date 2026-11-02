//! Tool-specific wording for a gated tool call's approval card.
//!
//! The generic card ("An agent wants to run the tool \"x\"") is not decidable
//! for a call whose effect hides in its arguments. For the `agent_inbox`
//! mutations the card names what actually happens: the exact permanent
//! address a claim takes, and who a message goes to and what it says.
//!
//! [`describe`] is pure and builds the wording from the tool's arguments, the
//! calling agent's name, and (for a claim) the resolved address when one is
//! known. [`resolve`] gathers those inputs: the agent's name from the global
//! agent store, and the exact claim address from the same read-only
//! `check_email_alias` call the agent could make itself, bounded by
//! [`CHECK_TIMEOUT`]. When the address cannot be resolved the card falls back
//! to the folded local part on the organization's agent mail host, which is
//! still the name the claim will ask for.

use std::time::Duration;

use serde_json::Value;

use super::text::{ApprovalText, Phrase, Summary};
use crate::i18n::messages;
use crate::sidecar::mcp::agent_inbox_alias::normalize_alias_request;

/// How long the gate waits for the hosted alias check before it falls back to
/// the local part. The check is a convenience for the card, never a reason to
/// stall the gate.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// How many characters of a message body the card shows. The card is the
/// approver's only view of what will be sent, so the body is shown in full up
/// to this bound; anything past it is announced, not silently dropped.
const BODY_PREVIEW_CHARS: usize = 20_000;

/// How many recipients the card lists before it summarizes the rest.
const RECIPIENTS_SHOWN: usize = 10;

/// The permanence statement every alias claim card carries (English).
#[cfg(test)]
pub const ALIAS_PERMANENCE: &str = "Agent email addresses are permanent and never reissued.";

/// Card wording that replaces the generic tool-call title, question and
/// summary: the messages, plus their English rendering.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolIntent {
    pub title: String,
    pub question: String,
    pub summary: String,
    pub text: ApprovalText,
}

impl From<ApprovalText> for ToolIntent {
    fn from(text: ApprovalText) -> Self {
        let (title, question, summary) = text.render("en");
        Self {
            title,
            question: question.unwrap_or_default(),
            summary,
            text,
        }
    }
}

/// The `agent_inbox` action a canonical tool id names, if any.
fn agent_inbox_action(tool_id: &str) -> Option<String> {
    let canonical = crate::sidecar::mcp::canonical_tool_id(tool_id);
    let mut segments = canonical.rsplit('.');
    let action = segments.next()?;
    (segments.next()? == "agent_inbox").then(|| action.to_ascii_lowercase())
}

fn is_claim(action: &str) -> bool {
    matches!(action, "claim_email_alias" | "create")
}

fn string_arg<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A string or string-array argument as a list of non-blank addresses.
fn address_list(arguments: &Value, key: &str) -> Vec<String> {
    match arguments.get(key) {
        Some(Value::String(one)) => one
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// The recipient list: verbatim addresses, summarized past
/// [`RECIPIENTS_SHOWN`].
fn recipients_phrase(addresses: &[String]) -> Recipients {
    if addresses.len() <= RECIPIENTS_SHOWN {
        return Recipients::Listed(addresses.join(", "));
    }
    Recipients::Summarized(
        Phrase::new(messages::APPROVAL_MORE_RECIPIENTS_MESSAGE)
            .text("shown", addresses[..RECIPIENTS_SHOWN].join(", "))
            .count("rest", addresses.len() - RECIPIENTS_SHOWN),
    )
}

enum Recipients {
    Listed(String),
    Summarized(Phrase),
}

impl Recipients {
    /// Set as the `recipients` argument of `phrase`.
    fn fill(self, phrase: Phrase) -> Phrase {
        match self {
            Recipients::Listed(list) => phrase.text("recipients", list),
            Recipients::Summarized(nested) => phrase.phrase("recipients", nested),
        }
    }
}

/// The body as the card shows it: in full up to [`BODY_PREVIEW_CHARS`], then
/// a note of how much is hidden. Truncated on a char boundary: the body is
/// arbitrary model output.
fn body_preview(summary: Summary, text: &str) -> Summary {
    let total = text.chars().count();
    if total <= BODY_PREVIEW_CHARS {
        return summary.paragraph(text);
    }
    let head: String = text.chars().take(BODY_PREVIEW_CHARS).collect();
    summary.paragraph(format!("{head}…")).raw("\n\n").phrase(
        Phrase::new(messages::APPROVAL_BODY_HIDDEN_MESSAGE)
            .count("hidden", total - BODY_PREVIEW_CHARS),
    )
}

/// The base name a claim's default local part is derived from, as
/// `agent_inbox_tool` derives it: the explicit `display_name` of a
/// `claim_email_alias`, else the agent's name.
fn claim_base_name<'a>(
    action: &str,
    arguments: &'a Value,
    agent_name: Option<&'a str>,
) -> Option<&'a str> {
    let display_name = if action == "create" {
        None
    } else {
        string_arg(arguments, "display_name")
    };
    display_name.or(agent_name)
}

/// The folded local part a claim asks for, or `None` when it cannot be known
/// here (no explicit name and no agent name, or a name with nothing usable).
fn claim_local_part(action: &str, arguments: &Value, agent_name: Option<&str>) -> Option<String> {
    let explicit = string_arg(arguments, "local_part");
    let base = claim_base_name(action, arguments, agent_name);
    if explicit.is_none() && base.is_none() {
        return None;
    }
    normalize_alias_request(explicit, base.unwrap_or_default()).ok()
}

/// The address a claim takes: resolved, or the folded local part on the
/// organization's (unknown here) mail host.
enum ClaimAddress {
    Resolved(String),
    LocalPart(String),
}

impl ClaimAddress {
    fn fill(self, phrase: Phrase) -> Phrase {
        match self {
            ClaimAddress::Resolved(address) => phrase.text("address", address),
            ClaimAddress::LocalPart(local) => phrase.phrase(
                "address",
                Phrase::new(messages::APPROVAL_UNRESOLVED_ADDRESS_MESSAGE).text("local", local),
            ),
        }
    }
}

fn describe_claim(
    action: &str,
    arguments: &Value,
    agent_name: Option<&str>,
    resolved_address: Option<&str>,
) -> ToolIntent {
    let permanence = Phrase::new(messages::APPROVAL_ALIAS_PERMANENCE_MESSAGE);
    let address = resolved_address
        .map(|address| ClaimAddress::Resolved(address.to_owned()))
        .or_else(|| claim_local_part(action, arguments, agent_name).map(ClaimAddress::LocalPart));
    let Some(address) = address else {
        let (question, summary) = match agent_name {
            Some(owner) => (
                Phrase::new(messages::APPROVAL_CLAIM_QUESTION_MESSAGE).text("owner", owner),
                Phrase::new(messages::APPROVAL_CLAIM_SUMMARY_MESSAGE).text("owner", owner),
            ),
            None => (
                Phrase::new(messages::APPROVAL_CLAIM_THIS_AGENT_QUESTION_MESSAGE),
                Phrase::new(messages::APPROVAL_CLAIM_THIS_AGENT_SUMMARY_MESSAGE),
            ),
        };
        return ApprovalText::new(
            Phrase::new(messages::APPROVAL_CLAIM_TITLE_MESSAGE),
            Summary::default()
                .phrase(summary)
                .raw(" ")
                .phrase(permanence)
                .build(),
        )
        .with_question(question)
        .into();
    };
    let question = match agent_name {
        Some(owner) => {
            Phrase::new(messages::APPROVAL_CLAIM_ADDRESS_QUESTION_MESSAGE).text("owner", owner)
        }
        None => Phrase::new(messages::APPROVAL_CLAIM_ADDRESS_THIS_AGENT_QUESTION_MESSAGE),
    };
    let title = Phrase::new(messages::APPROVAL_CLAIM_ADDRESS_TITLE_MESSAGE);
    let (title, question) = match address {
        ClaimAddress::Resolved(resolved) => (
            title.text("address", resolved.clone()),
            ClaimAddress::Resolved(resolved).fill(question),
        ),
        ClaimAddress::LocalPart(local) => (
            ClaimAddress::LocalPart(local.clone()).fill(title),
            ClaimAddress::LocalPart(local).fill(question),
        ),
    };
    ApprovalText::new(
        title,
        Summary::default()
            .phrase(question.clone())
            .raw(" ")
            .phrase(permanence)
            .build(),
    )
    .with_question(question)
    .into()
}

fn describe_send(arguments: &Value, agent_name: Option<&str>) -> ToolIntent {
    let to = address_list(arguments, "to");
    let cc = address_list(arguments, "cc");
    let subject = string_arg(arguments, "subject");
    let sender = match agent_name {
        Some(sender) => Phrase::new(messages::APPROVAL_SEND_SUMMARY_MESSAGE).text("sender", sender),
        None => Phrase::new(messages::APPROVAL_SEND_ANONYMOUS_SUMMARY_MESSAGE),
    };
    let mut summary = Summary::default().phrase(sender);
    summary = summary.line(if to.is_empty() {
        Phrase::new(messages::APPROVAL_SEND_NO_RECIPIENTS_MESSAGE)
    } else {
        recipients_phrase(&to).fill(Phrase::new(messages::APPROVAL_SEND_TO_MESSAGE))
    });
    if !cc.is_empty() {
        summary = summary
            .line(recipients_phrase(&cc).fill(Phrase::new(messages::APPROVAL_SEND_CC_MESSAGE)));
    }
    // Replies go to Reply-To, so the approver must see where they will land.
    let reply_to = address_list(arguments, "reply_to");
    if !reply_to.is_empty() {
        summary = summary.line(
            recipients_phrase(&reply_to)
                .fill(Phrase::new(messages::APPROVAL_SEND_REPLY_TO_MESSAGE)),
        );
    }
    summary = summary.line(match subject {
        Some(subject) => {
            Phrase::new(messages::APPROVAL_SEND_SUBJECT_MESSAGE).text("subject", subject)
        }
        None => Phrase::new(messages::APPROVAL_SEND_NO_SUBJECT_MESSAGE),
    });
    if let Some(text) = string_arg(arguments, "text") {
        summary = body_preview(summary, text);
    }
    let title = match subject {
        Some(subject) => {
            Phrase::new(messages::APPROVAL_SEND_TITLE_MESSAGE).text("subject", subject)
        }
        None => Phrase::new(messages::APPROVAL_SEND_NO_SUBJECT_TITLE_MESSAGE),
    };
    let question = match (subject, to.is_empty()) {
        (Some(subject), false) => recipients_phrase(&to)
            .fill(Phrase::new(messages::APPROVAL_SEND_QUESTION_MESSAGE).text("subject", subject)),
        (None, false) => recipients_phrase(&to).fill(Phrase::new(
            messages::APPROVAL_SEND_NO_SUBJECT_QUESTION_MESSAGE,
        )),
        (Some(subject), true) => {
            Phrase::new(messages::APPROVAL_SEND_NO_RECIPIENTS_QUESTION_MESSAGE)
                .text("subject", subject)
        }
        (None, true) => Phrase::new(messages::APPROVAL_SEND_EMPTY_QUESTION_MESSAGE),
    };
    ApprovalText::new(title, summary.build())
        .with_question(question)
        .into()
}

fn describe_reply(arguments: &Value, agent_name: Option<&str>) -> ToolIntent {
    let reply_all = arguments
        .get("reply_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recipients = || {
        Phrase::new(if reply_all {
            messages::APPROVAL_REPLY_EVERYONE_MESSAGE
        } else {
            messages::APPROVAL_REPLY_SENDER_MESSAGE
        })
    };
    let message_id = string_arg(arguments, "message_id");
    let opening = match (agent_name, message_id) {
        (Some(sender), Some(id)) => {
            Phrase::new(messages::APPROVAL_REPLY_TO_MESSAGE_SUMMARY_MESSAGE)
                .text("sender", sender)
                .text("message", id)
        }
        (None, Some(id)) => {
            Phrase::new(messages::APPROVAL_REPLY_TO_MESSAGE_ANONYMOUS_SUMMARY_MESSAGE)
                .text("message", id)
        }
        (Some(sender), None) => {
            Phrase::new(messages::APPROVAL_REPLY_SUMMARY_MESSAGE).text("sender", sender)
        }
        (None, None) => Phrase::new(messages::APPROVAL_REPLY_ANONYMOUS_SUMMARY_MESSAGE),
    };
    let mut summary = Summary::default().phrase(opening.phrase("recipients", recipients()));
    if let Some(text) = string_arg(arguments, "text") {
        summary = body_preview(summary, text);
    }
    let title = Phrase::new(if reply_all {
        messages::APPROVAL_REPLY_ALL_TITLE_MESSAGE
    } else {
        messages::APPROVAL_REPLY_TITLE_MESSAGE
    });
    ApprovalText::new(title, summary.build())
        .with_question(
            Phrase::new(messages::APPROVAL_REPLY_QUESTION_MESSAGE)
                .phrase("recipients", recipients()),
        )
        .into()
}

/// Card wording for a gated tool call, or `None` to keep the generic card.
pub fn describe(
    tool_id: &str,
    arguments: &Value,
    agent_name: Option<&str>,
    resolved_address: Option<&str>,
) -> Option<ToolIntent> {
    let action = agent_inbox_action(tool_id)?;
    let agent_name = agent_name.map(str::trim).filter(|name| !name.is_empty());
    match action.as_str() {
        "claim_email_alias" | "create" => Some(describe_claim(
            &action,
            arguments,
            agent_name,
            resolved_address,
        )),
        "send" => Some(describe_send(arguments, agent_name)),
        "reply" => Some(describe_reply(arguments, agent_name)),
        _ => None,
    }
}

/// The exact address a claim takes, from a hosted `check_email_alias` answer.
fn checked_address(answer: &Value) -> Option<String> {
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    answer
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|address| address.contains('@'))
        .map(str::to_owned)
}

/// Ask the hosted service which address this claim resolves to. The check
/// sends the same local part the claim would, so its answer is the address
/// the claim takes. Any failure (no cloud node, timeout, refusal) is `None`.
async fn resolve_claim_address(
    action: &str,
    arguments: &Value,
    agent_id: &str,
    agent_name: Option<&str>,
) -> Option<String> {
    let mut check = serde_json::Map::new();
    if let Some(local) = claim_local_part(action, arguments, agent_name) {
        check.insert("local_part".to_owned(), Value::String(local));
    }
    let http = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .ok()?;
    let answer = tokio::time::timeout(
        CHECK_TIMEOUT,
        crate::sidecar::mcp::agent_inbox_tool::dispatch(
            &http,
            "check_email_alias",
            Value::Object(check),
            Some(agent_id),
            crate::agents::global(),
        ),
    )
    .await
    .ok()?
    .ok()?;
    checked_address(&answer)
}

/// Resolve the card wording for a gated tool call: look up the calling
/// agent's name and, for an alias claim, the exact address.
pub async fn resolve(
    tool_id: &str,
    arguments: &Value,
    agent_id: Option<&str>,
) -> Option<ToolIntent> {
    let action = agent_inbox_action(tool_id)?;
    let agent_name = match (agent_id, crate::agents::global()) {
        (Some(id), Some(store)) => store.get(id).await.ok().flatten().map(|record| record.name),
        _ => None,
    };
    let resolved_address = match agent_id {
        Some(id) if is_claim(&action) => {
            resolve_claim_address(&action, arguments, id, agent_name.as_deref()).await
        }
        _ => None,
    };
    describe(
        tool_id,
        arguments,
        agent_name.as_deref(),
        resolved_address.as_deref(),
    )
}

#[cfg(test)]
#[path = "tool_intent_tests.rs"]
mod tests;
