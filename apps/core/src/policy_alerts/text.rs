//! A policy alert's title and body as localizable messages: one whole sentence
//! per source, scope and enforcement, never words spliced into a sentence.

use crate::i18n::{messages as m, AlertText, Join, Message, Template};

use super::PolicyAlert;

impl PolicyAlert {
    /// The alert's title and body, rendered per recipient by the notify kernel.
    pub(super) fn text(&self) -> AlertText {
        let mut body = vec![self.usage_message()];
        if let Some(action) = self.action_message() {
            body.push(action);
        }
        AlertText::new(self.title_message(), body, Join::Sentences)
    }

    fn title_message(&self) -> Message {
        let template = match self.source.as_str() {
            "budget" => m::POLICY_BUDGET_TITLE_MESSAGE,
            "session_budget" => m::POLICY_SESSION_BUDGET_TITLE_MESSAGE,
            "wallet_empty" => m::POLICY_WALLET_TITLE_MESSAGE,
            "firewall" => m::POLICY_FIREWALL_TITLE_MESSAGE,
            "" => m::POLICY_GENERIC_TITLE_MESSAGE,
            other => return Message::new(m::POLICY_SOURCE_TITLE_MESSAGE).text("source", other),
        };
        Message::new(template)
    }

    /// "Used X of Y for user u_9." when a limit applies, else "Triggered for …".
    fn usage_message(&self) -> Message {
        let limited = self.limit > 0;
        let subject = self.subject_key.trim();
        let scope = self.scope.trim();
        // (with a subject, without one) per known scope, used vs triggered.
        let known: Option<(Template, Template)> = match (scope, limited) {
            ("user", true) => Some((
                m::POLICY_USED_USER_MESSAGE,
                m::POLICY_USED_THIS_USER_MESSAGE,
            )),
            ("agent", true) => Some((
                m::POLICY_USED_AGENT_MESSAGE,
                m::POLICY_USED_THIS_AGENT_MESSAGE,
            )),
            ("session", true) => Some((
                m::POLICY_USED_SESSION_MESSAGE,
                m::POLICY_USED_THIS_SESSION_MESSAGE,
            )),
            ("request", true) => Some((
                m::POLICY_USED_REQUEST_MESSAGE,
                m::POLICY_USED_THIS_REQUEST_MESSAGE,
            )),
            ("user", false) => Some((
                m::POLICY_TRIGGERED_USER_MESSAGE,
                m::POLICY_TRIGGERED_THIS_USER_MESSAGE,
            )),
            ("agent", false) => Some((
                m::POLICY_TRIGGERED_AGENT_MESSAGE,
                m::POLICY_TRIGGERED_THIS_AGENT_MESSAGE,
            )),
            ("session", false) => Some((
                m::POLICY_TRIGGERED_SESSION_MESSAGE,
                m::POLICY_TRIGGERED_THIS_SESSION_MESSAGE,
            )),
            ("request", false) => Some((
                m::POLICY_TRIGGERED_REQUEST_MESSAGE,
                m::POLICY_TRIGGERED_THIS_REQUEST_MESSAGE,
            )),
            _ => None,
        };
        let message = match known {
            Some((with_subject, _)) if !subject.is_empty() => {
                Message::new(with_subject).text("subject", subject)
            }
            Some((_, without_subject)) => Message::new(without_subject),
            // An unknown scope is shown as the Gateway named it.
            None if !scope.is_empty() || !subject.is_empty() => {
                let raw = format!("{scope} {subject}").trim().to_owned();
                let template = if limited {
                    m::POLICY_USED_SCOPE_MESSAGE
                } else {
                    m::POLICY_TRIGGERED_SCOPE_MESSAGE
                };
                Message::new(template).text("scope", raw)
            }
            None if limited => Message::new(m::POLICY_USED_MESSAGE),
            None => Message::new(m::POLICY_TRIGGERED_MESSAGE),
        };
        if limited {
            message
                .number("used", self.used as f64, 0, 0)
                .number("limit", self.limit as f64, 0, 0)
        } else {
            message
        }
    }

    /// What the Gateway did about it, when it says.
    fn action_message(&self) -> Option<Message> {
        let template = match self.enforcement.trim() {
            "" => return None,
            "notify" => m::POLICY_ACTION_NOTIFY_MESSAGE,
            "downgrade" => m::POLICY_ACTION_DOWNGRADE_MESSAGE,
            "restrict" => m::POLICY_ACTION_RESTRICT_MESSAGE,
            "stop" => m::POLICY_ACTION_STOP_MESSAGE,
            "block" => m::POLICY_ACTION_BLOCK_MESSAGE,
            other => {
                return Some(
                    Message::new(m::POLICY_ACTION_OTHER_MESSAGE).text("enforcement", other),
                )
            }
        };
        Some(Message::new(template))
    }
}
