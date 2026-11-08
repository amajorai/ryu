//! Import-run outcomes as Core messages: a failure reason or a title built
//! from a template in `crate::i18n::messages::import_outcomes` keeps its
//! English text on the wire (`title`, `detail`) for older clients, and the
//! message rides next to it (`title_i18n`, `detail_i18n`) so the desktop
//! Import dialog renders it in the reader's language. A relayed error
//! (`e.to_string()`) has no message and stays English.

use super::scan_text::english;
use super::*;
use crate::i18n::Template;

impl ImportOutcome {
    /// A failed outcome whose reason is `reason`.
    pub fn failed_msg(kind: &str, id: &str, title: &str, reason: Message) -> Self {
        let mut outcome = Self::failed(kind, id, title, &english(&reason));
        outcome.detail_i18n = vec![reason];
        outcome
    }

    /// A failed outcome whose reason is the argument-free `reason` template.
    pub fn failed_because(kind: &str, id: &str, title: &str, reason: Template) -> Self {
        Self::failed_msg(kind, id, title, Message::new(reason))
    }

    /// Replace the title with `title`, keeping its English text.
    pub fn titled(mut self, title: Message) -> Self {
        self.title = english(&title);
        self.title_i18n = Some(title);
        self
    }
}

/// A `'{name}'` title message, as the import handlers build them.
pub fn named_title(template: Template, name: &str) -> Message {
    Message::new(template).text("name", name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_outcome_carries_its_reason_and_title_messages() {
        let outcome = ImportOutcome::failed_because(
            kind::AGENT,
            "agents/x.md",
            "agents/x.md",
            messages::IMPORT_OUTCOME_UNREADABLE_AGENT_MESSAGE,
        )
        .titled(named_title(
            messages::IMPORT_OUTCOME_AGENT_TITLE_MESSAGE,
            "reviewer",
        ));
        let wire = serde_json::to_value(&outcome).unwrap();
        assert_eq!(wire["status"], json!("failed"));
        assert_eq!(wire["title"], json!("Agent definition 'reviewer'"));
        assert_eq!(
            wire["title_i18n"],
            json!({ "message": "Agent definition '{name}'", "args": { "name": "reviewer" } })
        );
        assert_eq!(
            wire["detail"],
            json!("The file is not a readable agent definition.")
        );
        assert_eq!(
            wire["detail_i18n"][0]["message"],
            json!("The file is not a readable agent definition.")
        );
    }

    #[test]
    fn reason_arguments_ride_on_the_wire() {
        let reason = Message::new(messages::IMPORT_OUTCOME_UNSAFE_URL_MESSAGE)
            .text("url", "http://10.0.0.1")
            .text("error", "private address");
        let outcome = ImportOutcome::failed_msg(kind::MCP_SERVER, "mcp/a", "MCP", reason);
        let wire = serde_json::to_value(&outcome).unwrap();
        assert_eq!(
            wire["detail"],
            json!("The URL “http://10.0.0.1” is not safe to connect to: private address")
        );
        assert_eq!(
            wire["detail_i18n"][0]["args"],
            json!({ "url": "http://10.0.0.1", "error": "private address" })
        );
    }

    #[test]
    fn relayed_errors_send_no_message() {
        let wire = serde_json::to_value(ImportOutcome::failed(kind::PLUGIN, "p", "p", "disk full"))
            .unwrap();
        assert_eq!(wire["detail"], json!("disk full"));
        assert!(wire.get("detail_i18n").is_none());
        assert!(wire.get("title_i18n").is_none());
    }
}
