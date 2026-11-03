//! One Discord application command as the bulk-overwrite PUT sends it.

use serde_json::{json, Value};

use crate::commands::ChannelCommand;
use crate::i18n::commands::{clip, discord_localizations, DISCORD_DESCRIPTION_CHARS};

/// A `CHAT_INPUT` command. Discord rejects the whole list when one description
/// passes 100 characters, so the English one is clipped like its translations;
/// `description_localizations` carries every translated Discord locale and is
/// left out when the description has none (a third-party plugin stays English).
pub(super) fn command_payload(command: &ChannelCommand) -> Value {
    let mut payload = json!({
        "name": command.name,
        "description": clip(&command.description, DISCORD_DESCRIPTION_CHARS),
        "type": 1,
    });
    let localizations = discord_localizations(&command.description);
    if !localizations.is_empty() {
        payload["description_localizations"] = Value::Object(localizations);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(description: &str) -> ChannelCommand {
        ChannelCommand {
            name: "goal".to_owned(),
            description: description.to_owned(),
            source: "plugin".to_owned(),
        }
    }

    #[test]
    fn a_catalogued_command_carries_its_localizations() {
        let payload = command_payload(&command(
            "Pursue a goal until a judge model says it is met. Use '/goal clear' to stop.",
        ));
        assert_eq!(payload["name"], "goal");
        assert_eq!(payload["type"], 1);
        let localized = payload["description_localizations"].as_object().unwrap();
        assert!(localized["ja"]
            .as_str()
            .is_some_and(|text| !text.is_empty()));
        assert!(localized.contains_key("es-ES"));
        assert!(!localized.contains_key("ar"));
    }

    #[test]
    fn an_unknown_command_stays_english_within_the_limit() {
        let long = "a".repeat(180);
        let payload = command_payload(&command(&long));
        assert!(payload.get("description_localizations").is_none());
        let description = payload["description"].as_str().unwrap();
        assert_eq!(description.chars().count(), DISCORD_DESCRIPTION_CHARS);
        assert!(description.ends_with('…'));
    }
}
