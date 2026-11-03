//! Localized command-menu descriptions for Telegram and Discord.
//!
//! Both platforms show a command's description in their own UI, so the agent
//! never gets a chance to translate it. Core serves each description as the
//! contributing manifest's English text (whitespace collapsed to one line);
//! `commands.generated.rs`, built by
//! `tools/generate-gateway-channel-commands-i18n.mjs` from the store manifests
//! and `packages/i18n/locales`, maps that exact text to its translations. A
//! description the table does not know (a third-party plugin, a skill, a user's
//! imported command) stays English in every menu.

use serde_json::{Map, Value};

use super::{fill, resolve, ENGLISH};
use crate::commands::ChannelCommand;

#[path = "commands.generated.rs"]
#[rustfmt::skip]
#[allow(dead_code)]
mod table;

/// Telegram's `BotCommand.description` limit is 256 characters; the bridge
/// clips at the same length [`crate::commands::normalize`] uses.
pub const TELEGRAM_DESCRIPTION_CHARS: usize = 251;
/// Discord rejects a whole command list when one description passes 100.
pub const DISCORD_DESCRIPTION_CHARS: usize = 100;
/// Where [`crate::commands::normalize`] clips a long description (before its `…`).
const NORMALIZED_CLIP_CHARS: usize = 250;
const ELLIPSIS: char = '…';

/// Clip `text` to `max` characters, ending on an ellipsis when it was cut.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push(ELLIPSIS);
    clipped
}

/// The table's English source for a description as the Gateway received it:
/// the exact text, or, when the Gateway clipped a long one, the source it was
/// clipped from.
fn english_source(description: &str) -> Option<&'static str> {
    let clipped_prefix = description
        .strip_suffix(ELLIPSIS)
        .filter(|prefix| prefix.chars().count() >= NORMALIZED_CLIP_CHARS);
    table::sources().find(|source| {
        *source == description
            || clipped_prefix
                .is_some_and(|prefix| source.len() > prefix.len() && source.starts_with(prefix))
    })
}

/// The `locale` translation of a command description, or `None` when the
/// locale is English or the table has no translation.
pub fn translate(locale: &str, description: &str) -> Option<String> {
    let locale = resolve(locale);
    if locale == ENGLISH {
        return None;
    }
    let source = english_source(description)?;
    table::lookup(locale, source).map(|translation| fill(translation, &[]))
}

/// Telegram's `language_code` for a catalog locale: the two-letter language
/// (`pt-BR` is `pt`, `zh-CN` is `zh`).
pub fn telegram_language_code(locale: &str) -> String {
    locale
        .split('-')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// One command menu per catalog locale, keyed by Telegram `language_code`.
/// Every menu lists every command; a description without a translation stays
/// English so the localized menu never hides a command the default one shows.
pub fn telegram_menus(cmds: &[ChannelCommand]) -> Vec<(String, Vec<ChannelCommand>)> {
    let mut menus: Vec<(String, Vec<ChannelCommand>)> = Vec::new();
    for locale in table::LOCALES {
        let code = telegram_language_code(locale);
        if menus.iter().any(|(existing, _)| *existing == code) {
            continue;
        }
        let localized = cmds
            .iter()
            .map(|command| ChannelCommand {
                description: translate(locale, &command.description)
                    .map(|text| clip(&text, TELEGRAM_DESCRIPTION_CHARS))
                    .unwrap_or_else(|| command.description.clone()),
                ..command.clone()
            })
            .collect();
        menus.push((code, localized));
    }
    menus
}

/// Discord's locale keys for a catalog locale. Discord has no Arabic, and its
/// Spanish comes in two flavours that both get the catalog's Spanish.
fn discord_locales(locale: &str) -> &'static [&'static str] {
    match locale {
        "de" => &["de"],
        "es" => &["es-ES", "es-419"],
        "fr" => &["fr"],
        "hi" => &["hi"],
        "it" => &["it"],
        "ja" => &["ja"],
        "ko" => &["ko"],
        "pt-BR" => &["pt-BR"],
        "ru" => &["ru"],
        "zh-CN" => &["zh-CN"],
        _ => &[],
    }
}

/// A command's `description_localizations` for Discord: every translated
/// locale Discord supports, clipped to Discord's 100 characters. Empty when the
/// description has no translation.
pub fn discord_localizations(description: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for locale in table::LOCALES {
        let keys = discord_locales(locale);
        if keys.is_empty() {
            continue;
        }
        let Some(translation) = translate(locale, description) else {
            continue;
        };
        let clipped = clip(&translation, DISCORD_DESCRIPTION_CHARS);
        for key in keys {
            out.insert((*key).to_owned(), Value::String(clipped.clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOAL: &str =
        "Pursue a goal until a judge model says it is met. Use '/goal clear' to stop.";

    fn command(name: &str, description: &str) -> ChannelCommand {
        ChannelCommand {
            name: name.to_owned(),
            description: description.to_owned(),
            source: "plugin".to_owned(),
        }
    }

    #[test]
    fn catalogued_descriptions_translate_and_others_stay_english() {
        assert!(table::sources().any(|source| source == GOAL));
        let japanese = translate("ja", GOAL).expect("the /goal description is translated");
        assert_ne!(japanese, GOAL);
        assert!(
            translate("pt-PT", GOAL).is_some(),
            "pt-PT resolves to pt-BR"
        );
        assert_eq!(translate("en", GOAL), None);
        assert_eq!(translate("ja", "A third-party command"), None);
    }

    #[test]
    fn a_description_the_gateway_clipped_still_matches() {
        let long = format!("{} {}", "word".repeat(70), "tail");
        assert_eq!(english_source(&long), None);
        let clipped = format!("{}…", GOAL.chars().take(20).collect::<String>());
        // Too short to be a Gateway clip: never a prefix match.
        assert_eq!(english_source(&clipped), None);
        assert_eq!(english_source(GOAL), Some(GOAL));
    }

    #[test]
    fn telegram_language_codes_are_two_letters() {
        assert_eq!(telegram_language_code("pt-BR"), "pt");
        assert_eq!(telegram_language_code("zh-CN"), "zh");
        assert_eq!(telegram_language_code("ja"), "ja");
    }

    #[test]
    fn telegram_menus_cover_every_locale_and_keep_unknown_commands_english() {
        let cmds = [command("goal", GOAL), command("mine", "My own command")];
        let menus = telegram_menus(&cmds);
        let codes: Vec<&str> = menus.iter().map(|(code, _)| code.as_str()).collect();
        assert_eq!(
            codes,
            ["ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "ru", "zh"]
        );
        let (_, japanese) = menus.iter().find(|(code, _)| code == "ja").unwrap();
        assert_eq!(japanese.len(), 2);
        assert_eq!(japanese[0].name, "goal");
        assert_ne!(japanese[0].description, GOAL);
        assert_eq!(japanese[1].description, "My own command");
        let (_, arabic) = menus.iter().find(|(code, _)| code == "ar").unwrap();
        assert!(arabic[0]
            .description
            .chars()
            .any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)));
        let (_, german) = menus.iter().find(|(code, _)| code == "de").unwrap();
        assert_eq!(german[0].description, translate("de", GOAL).unwrap());
        assert_ne!(german[0].description, GOAL);
        for (_, menu) in &menus {
            for entry in menu {
                assert!(entry.description.chars().count() <= 256);
            }
        }
    }

    #[test]
    fn discord_localizations_use_discord_keys_within_its_limit() {
        let localized = discord_localizations(GOAL);
        assert!(localized.contains_key("ja"));
        assert!(localized.contains_key("pt-BR"));
        assert!(localized.contains_key("zh-CN"));
        assert!(localized.contains_key("es-ES") && localized.contains_key("es-419"));
        assert_eq!(
            localized["de"].as_str(),
            Some(clip(&translate("de", GOAL).unwrap(), DISCORD_DESCRIPTION_CHARS).as_str())
        );
        assert_ne!(localized["de"].as_str(), Some(GOAL));
        // Discord has no Arabic locale; an unknown key fails the whole PUT.
        assert!(!localized.contains_key("ar"));
        for value in localized.values() {
            assert!(value.as_str().unwrap().chars().count() <= DISCORD_DESCRIPTION_CHARS);
        }
        assert!(discord_localizations("A third-party command").is_empty());
    }

    #[test]
    fn clip_ends_on_an_ellipsis_only_when_cut() {
        assert_eq!(clip("short", 10), "short");
        let clipped = clip(&"x".repeat(150), DISCORD_DESCRIPTION_CHARS);
        assert_eq!(clipped.chars().count(), DISCORD_DESCRIPTION_CHARS);
        assert!(clipped.ends_with('…'));
    }
}
