//! Tool-specific wording for a gated tool call's approval card.
//!
//! The generic card ("An agent wants to run the tool `x`") is not decidable
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

/// The permanence statement every alias claim card carries.
pub const ALIAS_PERMANENCE: &str = "Agent email addresses are permanent and never reissued.";

/// Card wording that replaces the generic tool-call title, question and summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolIntent {
    pub title: String,
    pub question: String,
    pub summary: String,
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

fn join_recipients(addresses: &[String]) -> String {
    if addresses.len() <= RECIPIENTS_SHOWN {
        return addresses.join(", ");
    }
    let rest = addresses.len() - RECIPIENTS_SHOWN;
    format!(
        "{} and {rest} more",
        addresses[..RECIPIENTS_SHOWN].join(", ")
    )
}

/// Truncate on a char boundary: the body is arbitrary model output.
fn preview(text: &str) -> String {
    let total = text.chars().count();
    if total > BODY_PREVIEW_CHARS {
        let head: String = text.chars().take(BODY_PREVIEW_CHARS).collect();
        let hidden = total - BODY_PREVIEW_CHARS;
        format!("{head}…\n\n[{hidden} more characters of the message are not shown here]")
    } else {
        text.to_owned()
    }
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

fn describe_claim(
    action: &str,
    arguments: &Value,
    agent_name: Option<&str>,
    resolved_address: Option<&str>,
) -> ToolIntent {
    let owner = agent_name.map_or_else(|| "this agent".to_owned(), str::to_owned);
    let address = resolved_address.map(str::to_owned).or_else(|| {
        claim_local_part(action, arguments, agent_name)
            .map(|local| format!("{local}@<your organization's agent mail host>"))
    });
    let Some(address) = address else {
        return ToolIntent {
            title: "Claim an email address".to_owned(),
            question: format!("Claim an email address for {owner}?"),
            summary: format!("{owner} wants to claim a hosted email address. {ALIAS_PERMANENCE}"),
        };
    };
    let question = format!("Claim {address} for {owner}?");
    ToolIntent {
        title: format!("Claim email address: {address}"),
        summary: format!("{question} {ALIAS_PERMANENCE}"),
        question,
    }
}

fn describe_send(arguments: &Value, agent_name: Option<&str>) -> ToolIntent {
    let sender = agent_name.unwrap_or("An agent");
    let to = address_list(arguments, "to");
    let cc = address_list(arguments, "cc");
    let subject = string_arg(arguments, "subject").unwrap_or("(no subject)");
    let recipients = if to.is_empty() {
        "(no recipients)".to_owned()
    } else {
        join_recipients(&to)
    };
    let mut summary = format!("{sender} wants to send an email.\nTo: {recipients}");
    if !cc.is_empty() {
        summary.push_str(&format!("\nCc: {}", join_recipients(&cc)));
    }
    // Replies go to Reply-To, so the approver must see where they will land.
    let reply_to = address_list(arguments, "reply_to");
    if !reply_to.is_empty() {
        summary.push_str(&format!("\nReply-To: {}", join_recipients(&reply_to)));
    }
    summary.push_str(&format!("\nSubject: {subject}"));
    if let Some(text) = string_arg(arguments, "text") {
        summary.push_str(&format!("\n\n{}", preview(text)));
    }
    ToolIntent {
        title: format!("Send email: {subject}"),
        question: format!("Send \"{subject}\" to {recipients}?"),
        summary,
    }
}

fn describe_reply(arguments: &Value, agent_name: Option<&str>) -> ToolIntent {
    let sender = agent_name.unwrap_or("An agent");
    let reply_all = arguments
        .get("reply_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recipients = if reply_all {
        "the sender and everyone else on the message"
    } else {
        "the sender of the message"
    };
    let mut summary = format!("{sender} wants to reply to {recipients}");
    if let Some(message_id) = string_arg(arguments, "message_id") {
        summary.push_str(&format!(" {message_id}"));
    }
    summary.push('.');
    if let Some(text) = string_arg(arguments, "text") {
        summary.push_str(&format!("\n\n{}", preview(text)));
    }
    ToolIntent {
        title: if reply_all {
            "Reply all to an email".to_owned()
        } else {
            "Reply to an email".to_owned()
        },
        question: format!("Send this reply to {recipients}?"),
        summary,
    }
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
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn claim_names_the_exact_resolved_address_and_permanence() {
        let intent = describe(
            "agent_inbox.claim_email_alias",
            &json!({ "local_part": "Sales" }),
            Some("Nova"),
            Some("sales@acme.mail.example"),
        )
        .unwrap();
        assert_eq!(intent.question, "Claim sales@acme.mail.example for Nova?");
        assert_eq!(
            intent.summary,
            "Claim sales@acme.mail.example for Nova? Agent email addresses are permanent and never reissued."
        );
        assert_eq!(intent.title, "Claim email address: sales@acme.mail.example");
    }

    #[test]
    fn claim_without_resolution_uses_the_folded_local_part() {
        let intent = describe(
            "agent_inbox.claim_email_alias",
            &json!({ "local_part": "  Sales Team " }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert_eq!(
            intent.question,
            "Claim sales-team@<your organization's agent mail host> for Nova?"
        );
        assert!(intent.summary.ends_with(ALIAS_PERMANENCE));
    }

    #[test]
    fn claim_defaults_to_display_name_then_agent_name() {
        let by_display = describe(
            "agent_inbox.claim_email_alias",
            &json!({ "display_name": "Front Desk" }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(by_display.question.starts_with("Claim front-desk@"));
        let by_agent = describe(
            "agent_inbox.claim_email_alias",
            &json!({}),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(by_agent.question.starts_with("Claim nova@"));
    }

    #[test]
    fn deprecated_create_ignores_display_name_and_still_states_permanence() {
        let intent = describe(
            "agent_inbox.create",
            &json!({ "display_name": "Front Desk" }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(
            intent.question.starts_with("Claim nova@"),
            "{}",
            intent.question
        );
        assert!(intent.summary.contains(ALIAS_PERMANENCE));
    }

    #[test]
    fn claim_with_nothing_to_name_still_states_permanence() {
        let intent = describe("agent_inbox.claim_email_alias", &json!({}), None, None).unwrap();
        assert_eq!(intent.question, "Claim an email address for this agent?");
        assert!(intent.summary.contains(ALIAS_PERMANENCE));
        let unusable = describe(
            "agent_inbox.claim_email_alias",
            &json!({ "local_part": "!!!" }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert_eq!(unusable.question, "Claim an email address for Nova?");
    }

    #[test]
    fn send_lists_recipients_subject_and_a_bounded_body() {
        // A short harmless opening cannot hide what follows it.
        let ordinary = format!("Hi there.\n{}", "y".repeat(500));
        let shown = describe(
            "agent_inbox.send",
            &json!({ "to": ["a@example.com"], "subject": "Hi", "text": ordinary }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(shown.summary.ends_with(&ordinary));

        let body = "x".repeat(BODY_PREVIEW_CHARS + 50);
        let intent = describe(
            "agent_inbox.send",
            &json!({
                "to": ["a@example.com", "b@example.com"],
                "cc": ["c@example.com"],
                "subject": "Quarterly numbers",
                "text": body,
            }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert_eq!(
            intent.question,
            "Send \"Quarterly numbers\" to a@example.com, b@example.com?"
        );
        assert!(intent.summary.contains("To: a@example.com, b@example.com"));
        assert!(intent.summary.contains("Cc: c@example.com"));
        assert!(intent.summary.contains("Subject: Quarterly numbers"));
        assert!(intent
            .summary
            .ends_with("[50 more characters of the message are not shown here]"));
        assert!(!intent.summary.contains(&body));
        assert_eq!(intent.title, "Send email: Quarterly numbers");
    }

    #[test]
    fn send_shows_reply_to_so_replies_cannot_be_redirected_unseen() {
        let intent = describe(
            "agent_inbox.send",
            &json!({
                "to": ["buyer@example.com"],
                "subject": "Your quote",
                "text": "Attached.",
                "reply_to": "attacker@evil.example",
            }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(intent.summary.contains("Reply-To: attacker@evil.example"));
        let without = describe(
            "agent_inbox.send",
            &json!({"to": ["buyer@example.com"], "subject": "Your quote"}),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert!(!without.summary.contains("Reply-To"));
    }

    #[test]
    fn send_summarizes_long_recipient_lists() {
        let to: Vec<String> = (0..RECIPIENTS_SHOWN + 3)
            .map(|index| format!("r{index}@example.com"))
            .collect();
        let intent = describe(
            "agent_inbox.send",
            &json!({ "to": to, "subject": "Hi" }),
            None,
            None,
        )
        .unwrap();
        assert!(
            intent.question.contains("and 3 more"),
            "{}",
            intent.question
        );
        assert!(intent
            .summary
            .starts_with("An agent wants to send an email."));
    }

    #[test]
    fn reply_names_who_receives_it() {
        let intent = describe(
            "agent_inbox.reply",
            &json!({ "message_id": "msg_1", "text": "Thanks!", "reply_all": true }),
            Some("Nova"),
            None,
        )
        .unwrap();
        assert_eq!(
            intent.question,
            "Send this reply to the sender and everyone else on the message?"
        );
        assert!(intent.summary.contains("msg_1"));
        assert!(intent.summary.ends_with("Thanks!"));
    }

    #[test]
    fn other_tools_keep_the_generic_card() {
        assert_eq!(describe("agent_inbox.get", &json!({}), None, None), None);
        assert_eq!(describe("gmail.send_email", &json!({}), None, None), None);
        assert_eq!(describe("send", &json!({}), None, None), None);
    }

    #[test]
    fn checked_address_accepts_only_a_successful_full_address() {
        assert_eq!(
            checked_address(&json!({ "ok": true, "address": "sales@acme.mail.example" })),
            Some("sales@acme.mail.example".to_owned())
        );
        assert_eq!(
            checked_address(&json!({ "ok": false, "address": "sales@acme.mail.example" })),
            None
        );
        assert_eq!(
            checked_address(&json!({ "ok": true, "address": "sales" })),
            None
        );
    }

    #[tokio::test]
    async fn resolve_without_a_cloud_node_falls_back_to_the_local_part() {
        let intent = resolve(
            "agent_inbox.claim_email_alias",
            &json!({ "local_part": "sales" }),
            Some("agent_without_node"),
        )
        .await
        .unwrap();
        assert!(
            intent
                .question
                .starts_with("Claim sales@<your organization's agent mail host>"),
            "{}",
            intent.question
        );
    }
}
