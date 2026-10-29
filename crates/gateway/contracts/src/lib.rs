//! Platform-neutral contracts for messages with buttons and channel actions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod capability_taxonomy;
pub mod composio_billing;
pub mod credential_scope;
pub mod credit_debit;
pub mod end_user;
pub mod gen_ai_content;
pub mod spend_tags;
pub mod tool_catalog;
pub mod tool_catalog_merge;
pub mod tool_credential_ladder;
pub mod tool_price;

/// Alert delivery tier shared by Gateway budget and firewall stages.
/// Variant order is used when merging policies; email selects the email sink
/// rather than adding it to the webhook, Telegram, and push fan-out sinks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AlertTier {
    #[default]
    Silent,
    Warn,
    Fanout,
    Email,
}

/// The button layout a channel should render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveLayout {
    /// Buttons appear beside the composer and send their label as a normal
    /// message when selected.
    ReplyKeyboard,
    /// Buttons remain attached to the message and dispatch a callback or URL.
    Inline,
}

/// A platform-neutral button row attached to a channel reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveMarkup {
    pub layout: InteractiveLayout,
    pub rows: Vec<Vec<InteractiveButton>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveButton {
    pub label: String,
    pub action: InteractiveAction,
}

/// What selecting a button does on a channel that supports interactive markup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum InteractiveAction {
    /// Send the visible button label as a normal user message.
    Reply,
    /// Deliver a typed action to the next `pre_user_turn` plugin/app hook.
    Callback {
        action_id: String,
        #[serde(default = "null_value")]
        payload: Value,
    },
    /// Open an HTTPS page or a Telegram deep link.
    OpenUrl { url: String },
}

/// A callback action selected by the user, passed to Core turn hooks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelActionEvent {
    pub action_id: String,
    pub label: String,
    #[serde(default = "null_value")]
    pub payload: Value,
}

fn null_value() -> Value {
    Value::Null
}

impl InteractiveMarkup {
    /// Validate limits and action/layout combinations before sending to a provider.
    pub fn validate(&self) -> Result<(), String> {
        if self.rows.is_empty() || self.rows.len() > 8 {
            return Err("interactive markup must contain 1..=8 rows".to_owned());
        }
        for row in &self.rows {
            if row.is_empty() || row.len() > 8 {
                return Err("interactive rows must contain 1..=8 buttons".to_owned());
            }
            for button in row {
                let label = button.label.trim();
                if label.is_empty() || label.chars().count() > 64 {
                    return Err("button labels must contain 1..=64 characters".to_owned());
                }
                match (&self.layout, &button.action) {
                    (InteractiveLayout::ReplyKeyboard, InteractiveAction::Reply) => {}
                    (
                        InteractiveLayout::Inline,
                        InteractiveAction::Callback { action_id, payload },
                    ) => {
                        let event = ChannelActionEvent {
                            action_id: action_id.clone(),
                            label: button.label.clone(),
                            payload: payload.clone(),
                        };
                        validate_action_event(&event)?;
                        encode_callback_data(&event)?;
                    }
                    (InteractiveLayout::Inline, InteractiveAction::OpenUrl { url }) => {
                        validate_button_url(url)?;
                    }
                    _ => {
                        return Err(format!(
                            "button action is incompatible with {:?} layout",
                            self.layout
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

impl ChannelActionEvent {
    /// Reject malformed or oversized callback data at the Core boundary.
    pub fn validate(&self) -> Result<(), String> {
        validate_action_event(self)
    }
}

fn validate_action_event(event: &ChannelActionEvent) -> Result<(), String> {
    if event.action_id.trim().is_empty() || event.action_id.chars().count() > 128 {
        return Err("action_id must contain 1..=128 characters".to_owned());
    }
    if event.label.trim().is_empty() || event.label.chars().count() > 64 {
        return Err("action label must contain 1..=64 characters".to_owned());
    }
    let payload = serde_json::to_vec(&event.payload).map_err(|error| error.to_string())?;
    if payload.len() > 1024 {
        return Err("channel action payload exceeds 1024 bytes".to_owned());
    }
    Ok(())
}

fn validate_button_url(value: &str) -> Result<(), String> {
    let parsed = url::Url::parse(value).map_err(|_| "button URL must be absolute".to_owned())?;
    match parsed.scheme() {
        "https" if parsed.host_str().is_some() => Ok(()),
        "tg" => Ok(()),
        _ => Err("button URL must use https or tg".to_owned()),
    }
}

/// Telegram callback data is a compact JSON envelope and is limited to 64 bytes.
pub fn encode_callback_data(event: &ChannelActionEvent) -> Result<String, String> {
    validate_action_event(event)?;
    let encode = |label| {
        serde_json::to_string(&CallbackEnvelope {
            version: 1,
            action_id: &event.action_id,
            label,
            payload: &event.payload,
        })
    };
    let with_label = encode(Some(event.label.as_str())).map_err(|error| error.to_string())?;
    let encoded = if with_label.len() <= 64 {
        with_label
    } else {
        encode(None).map_err(|error| error.to_string())?
    };
    if encoded.len() > 64 {
        return Err("encoded callback data exceeds Telegram's 64-byte limit".to_owned());
    }
    Ok(encoded)
}

/// Decode only callback values issued by this contract version.
pub fn decode_callback_data(value: &str) -> Result<ChannelActionEvent, String> {
    if value.len() > 64 {
        return Err("callback data exceeds Telegram's 64-byte limit".to_owned());
    }
    let envelope: CallbackEnvelopeOwned =
        serde_json::from_str(value).map_err(|_| "unsupported callback data".to_owned())?;
    if envelope.version != 1 {
        return Err("unsupported callback data version".to_owned());
    }
    let action_id = envelope.action_id;
    let event = ChannelActionEvent {
        label: envelope.label.unwrap_or_else(|| action_id.clone()),
        action_id,
        payload: envelope.payload,
    };
    validate_action_event(&event)?;
    Ok(event)
}

#[derive(Serialize)]
struct CallbackEnvelope<'a> {
    #[serde(rename = "v")]
    version: u8,
    #[serde(rename = "a")]
    action_id: &'a str,
    #[serde(rename = "l", skip_serializing_if = "Option::is_none")]
    label: Option<&'a str>,
    #[serde(rename = "p")]
    payload: &'a Value,
}

#[derive(Deserialize)]
struct CallbackEnvelopeOwned {
    #[serde(rename = "v")]
    version: u8,
    #[serde(rename = "a")]
    action_id: String,
    #[serde(rename = "l", default)]
    label: Option<String>,
    #[serde(rename = "p", default = "null_value")]
    payload: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_reply_keyboard_actions() {
        let markup = InteractiveMarkup {
            layout: InteractiveLayout::ReplyKeyboard,
            rows: vec![vec![InteractiveButton {
                label: "Option 1".to_owned(),
                action: InteractiveAction::Reply,
            }]],
        };
        assert!(markup.validate().is_ok());
    }

    #[test]
    fn validates_and_round_trips_typed_callback_actions() {
        let markup = InteractiveMarkup {
            layout: InteractiveLayout::Inline,
            rows: vec![vec![InteractiveButton {
                label: "Approve".to_owned(),
                action: InteractiveAction::Callback {
                    action_id: "review.approve".to_owned(),
                    payload: json!({ "requestId": "7" }),
                },
            }]],
        };
        assert!(markup.validate().is_ok());
        let event = ChannelActionEvent {
            action_id: "review.approve".to_owned(),
            label: "Approve".to_owned(),
            payload: json!({ "requestId": "7" }),
        };
        assert_eq!(
            decode_callback_data(&encode_callback_data(&event).unwrap()),
            Ok(event)
        );
    }

    #[test]
    fn callback_encoding_keeps_typed_data_when_the_label_would_exceed_limit() {
        let event = ChannelActionEvent {
            action_id: "workflow.continue".to_owned(),
            label: "Continue".to_owned(),
            payload: json!({ "ticketId": "42" }),
        };
        let encoded = encode_callback_data(&event).unwrap();
        assert!(encoded.len() <= 64);
        let decoded = decode_callback_data(&encoded).unwrap();
        assert_eq!(decoded.action_id, event.action_id);
        assert_eq!(decoded.payload, event.payload);
        assert_eq!(decoded.label, event.action_id);
    }

    #[test]
    fn rejects_mixed_reply_keyboard_and_inline_actions() {
        let markup = InteractiveMarkup {
            layout: InteractiveLayout::ReplyKeyboard,
            rows: vec![vec![InteractiveButton {
                label: "Open".to_owned(),
                action: InteractiveAction::OpenUrl {
                    url: "https://example.com".to_owned(),
                },
            }]],
        };
        assert!(markup.validate().is_err());
    }

    #[test]
    fn rejects_unsafe_button_urls() {
        assert!(validate_button_url("javascript:alert(1)").is_err());
    }
}
