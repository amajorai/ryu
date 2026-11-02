//! The status messages Core saves into a conversation for a cloud task: a Ryu Box
//! run or finish, and a plan run's start reply and result.
//!
//! Each is saved as an assistant message whose body is the English rendering, so
//! older clients, bots and exports still read a sentence, plus a
//! `data-ryu-cloud-task` part that carries the facts and the Core message sources
//! with their values. A client that knows the part renders the sentences in the
//! reader's language instead of the stored English. Messages saved before this
//! part existed stay as they were.

use super::store::RunRecord;
use crate::i18n::{messages, Message};
use crate::server::conversations::{ConversationStore, Tenancy};
use serde_json::{json, Map, Value};

/// The part type a client looks for.
pub(crate) const CLOUD_TASK_PART: &str = "data-ryu-cloud-task";

/// Paragraphs are separated by a blank line, as the English body always was.
const PARAGRAPH: &str = "\n\n";

/// One status message: facts for clients, verbatim text, and localizable sentences.
#[derive(Debug, Clone)]
pub(crate) struct ChatEvent {
    kind: &'static str,
    facts: Map<String, Value>,
    /// Written before the first paragraph as `"{prefix}: "` (a plan run's account tag).
    prefix: Option<String>,
    /// A verbatim first paragraph: the agent's or provider's own summary.
    lead: Option<String>,
    /// One paragraph each, after the lead.
    messages: Vec<Message>,
}

impl ChatEvent {
    /// `run`, `finish`, `planStart` or `planResult`.
    pub(crate) fn new(kind: &'static str) -> Self {
        Self {
            kind,
            facts: Map::new(),
            prefix: None,
            lead: None,
            messages: Vec::new(),
        }
    }

    /// A fact a client may show or act on; `null` values are left out.
    pub(crate) fn fact(mut self, name: &str, value: impl Into<Value>) -> Self {
        let value = value.into();
        if !value.is_null() {
            self.facts.insert(name.to_owned(), value);
        }
        self
    }

    pub(crate) fn prefix(mut self, prefix: impl Into<String>) -> Self {
        let prefix = prefix.into();
        self.prefix = (!prefix.trim().is_empty()).then_some(prefix);
        self
    }

    pub(crate) fn lead(mut self, lead: Option<&str>) -> Self {
        self.lead = lead
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned);
        self
    }

    pub(crate) fn say(mut self, message: Message) -> Self {
        self.messages.push(message);
        self
    }

    /// Whether a lead was set (callers add a fallback sentence otherwise).
    pub(crate) fn has_lead(&self) -> bool {
        self.lead.is_some()
    }

    /// The body rendered for `locale`.
    pub(crate) fn render(&self, locale: &str) -> String {
        let paragraphs: Vec<String> = self
            .lead
            .iter()
            .cloned()
            .chain(self.messages.iter().map(|message| message.render(locale)))
            .collect();
        let body = paragraphs.join(PARAGRAPH);
        match &self.prefix {
            Some(prefix) => format!("{prefix}: {body}"),
            None => body,
        }
    }

    /// The stored English body.
    pub(crate) fn text(&self) -> String {
        self.render("en")
    }

    /// The message's `parts`: the English text, then the structured part.
    pub(crate) fn parts(&self) -> Value {
        let mut data = self.facts.clone();
        data.insert("kind".into(), Value::String(self.kind.to_owned()));
        if let Some(prefix) = &self.prefix {
            data.insert("prefix".into(), Value::String(prefix.clone()));
        }
        if let Some(lead) = &self.lead {
            data.insert("lead".into(), Value::String(lead.clone()));
        }
        data.insert(
            "messages".into(),
            Value::Array(self.messages.iter().map(Message::to_wire).collect()),
        );
        json!([
            { "type": "text", "text": self.text() },
            { "type": CLOUD_TASK_PART, "data": data },
        ])
    }

    /// Save it as an assistant message.
    pub(crate) async fn append(
        &self,
        conversations: &ConversationStore,
        conversation_id: &str,
        agent_id: Option<&str>,
        tenancy: Tenancy,
    ) -> anyhow::Result<String> {
        conversations
            .append_message_as_with_render_data(
                conversation_id,
                "assistant",
                &self.text(),
                agent_id,
                None,
                None,
                tenancy,
                None,
                None,
                Some(&self.parts()),
                None,
            )
            .await
    }
}

/// The reply to a prompt that started on the owner's plan.
pub(crate) fn plan_start_event(record: &RunRecord) -> ChatEvent {
    let cli_name = record.backend.cli_name();
    let plan_name = record.backend.plan_name();
    let message = match (&record.workspace, &record.branch, &record.url) {
        (Some(_), Some(branch), _) => {
            Message::new(messages::CLOUD_PLAN_RUNNING_MESSAGE).text("branch", branch.as_str())
        }
        (_, _, Some(url)) => {
            Message::new(messages::CLOUD_PLAN_SENT_MESSAGE).text("url", url.as_str())
        }
        _ => Message::new(messages::CLOUD_PLAN_SENT_NO_LINK_MESSAGE),
    }
    .text("cliName", cli_name)
    .text("planName", plan_name);
    ChatEvent::new("planStart")
        .fact(
            "backend",
            serde_json::to_value(record.backend).unwrap_or(Value::Null),
        )
        .fact("branch", record.branch.clone())
        .fact("url", record.url.clone())
        .say(message)
}

/// A finished plan run's result, prefixed with its account tag (`"Claude · work"`).
pub(crate) fn plan_result_event(record: &RunRecord, tag: &str) -> ChatEvent {
    let lead = record.summary.as_deref().or(record.last_error.as_deref());
    let event = ChatEvent::new("planResult")
        .fact(
            "backend",
            serde_json::to_value(record.backend).unwrap_or(Value::Null),
        )
        .fact("status", record.status.clone())
        .prefix(tag)
        .lead(lead);
    if event.has_lead() {
        return event;
    }
    event.say(Message::new(plan_status_template(&record.status)))
}

/// The sentence for a finished run's status word.
fn plan_status_template(status: &str) -> crate::i18n::Template {
    match status {
        "completed" | "done" | "succeeded" => messages::CLOUD_PLAN_COMPLETED_MESSAGE,
        "failed" | "error" => messages::CLOUD_PLAN_FAILED_MESSAGE,
        "stopped" => messages::CLOUD_PLAN_STOPPED_MESSAGE,
        "ready" => messages::CLOUD_PLAN_READY_MESSAGE,
        _ => messages::CLOUD_PLAN_FINISHED_MESSAGE,
    }
}

#[cfg(test)]
#[path = "chat_event_tests.rs"]
mod tests;
