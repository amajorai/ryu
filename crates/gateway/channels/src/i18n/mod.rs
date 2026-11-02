//! Localized copy for the replies the channel bridge writes itself.
//!
//! The agent answers in the user's language, but a few replies never reach the
//! agent: the pairing prompt, the failure replies, the local command help and
//! some platform chrome (Slack's thinking status and feedback buttons, a
//! Discord thread name). Telegram, Slack, Discord, WhatsApp and iMessage show
//! that text as-is, so the bridge renders it per reader from the small catalog
//! `catalog.generated.rs`, which `tools/generate-gateway-channels-i18n.mjs`
//! builds from `packages/i18n/locales`.
//!
//! The locale is the sender's when the platform reports one
//! ([`crate::InboundMessage::locale`]: Telegram `from.language_code`, a Discord
//! interaction's `locale`), else the Gateway owner's UI language (Core's
//! `ui-language` preference), else the process locale, else English.

#[path = "catalog.generated.rs"]
#[rustfmt::skip]
mod catalog;
mod locale;
pub mod messages;
mod owner;
#[cfg(test)]
pub(crate) mod tests;

pub use locale::{resolve, stored};
pub use owner::OwnerLocale;

use crate::commands::ChannelCommand;

/// An English message template. Called with a placeholder echo it returns its
/// ICU source (`"Your pairing code is {code}."`); written as `format!` with
/// named arguments so the i18n extractor catalogs exactly that source.
pub type Template = fn(&dyn Fn(&'static str) -> String) -> String;

const ENGLISH: &str = "en";

/// The ICU source of a template: its English text with `{name}` placeholders.
pub fn source(template: Template) -> String {
    template(&|name| format!("{{{name}}}"))
}

/// Render `template` in `locale`, filling each `{name}` from `args`. A locale
/// the catalog has no translation for gets the English source.
pub fn render(locale: &str, template: Template, args: &[(&str, &str)]) -> String {
    let source = source(template);
    let locale = resolve(locale);
    let translated = (locale != ENGLISH)
        .then(|| lookup(locale, &source))
        .flatten();
    fill(translated.as_deref().unwrap_or(&source), args)
}

/// Translation of `source` in a resolved locale.
fn lookup(locale: &str, source: &str) -> Option<String> {
    #[cfg(test)]
    if let Some(found) = tests::override_lookup(locale, source) {
        return Some(found);
    }
    catalog::lookup(locale, source).map(str::to_owned)
}

/// Replace each `{name}` with its argument in one pass, so an argument that
/// itself contains braces is inserted verbatim. Unknown names stay as written.
/// ICU apostrophe quoting is honoured the way Core's renderer does: `''` is one
/// apostrophe and `'{…}'` is literal text, so a catalog translation written in
/// ICU form never shows its escapes in chat.
fn fill(text: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        match c {
            '\'' => match chars.peek().map(|(_, next)| *next) {
                Some('\'') => {
                    chars.next();
                    out.push('\'');
                }
                Some('{' | '}') => {
                    for (_, quoted) in chars.by_ref() {
                        if quoted == '\'' {
                            break;
                        }
                        out.push(quoted);
                    }
                }
                _ => out.push('\''),
            },
            '{' => {
                let after = &text[index + 1..];
                let value = after.find('}').and_then(|close| {
                    let name = &after[..close];
                    args.iter()
                        .find(|(key, _)| *key == name)
                        .map(|(_, value)| (close, *value))
                });
                match value {
                    Some((close, value)) => {
                        out.push_str(value);
                        // Skip the name and its closing brace.
                        for _ in 0..after[..=close].chars().count() {
                            chars.next();
                        }
                    }
                    None => out.push('{'),
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// The message sent back to a sender who needs to pair. Kept here (rather than
/// in each adapter) so every channel says the same thing.
pub fn pairing_prompt(locale: &str, code: &str) -> String {
    let code = format!("*{code}*");
    format!(
        "🔒 {}\n\n{}\n\n{}",
        render(locale, messages::PAIRING_PRIVATE_MESSAGE, &[]),
        render(locale, messages::PAIRING_CODE_MESSAGE, &[("code", &code)]),
        render(locale, messages::PAIRING_APPROVE_MESSAGE, &[]),
    )
}

/// The local `/help` answer on iMessage, which has no command menu to register.
pub fn command_help(locale: &str, commands: &[ChannelCommand]) -> String {
    if commands.is_empty() {
        return render(locale, messages::NO_COMMANDS_MESSAGE, &[]);
    }
    let mut out = format!(
        "{}:",
        render(locale, messages::COMMANDS_HEADING_MESSAGE, &[])
    );
    for cmd in commands {
        out.push_str(&format!("\n/{} — {}", cmd.name, cmd.description));
    }
    out
}

/// The local `/help` answer on WhatsApp and OpenWA: plain text with the
/// platform's `*bold*` shorthand, which is all the rich text WhatsApp has.
pub fn whatsapp_command_help(locale: &str, commands: &[ChannelCommand]) -> String {
    if commands.is_empty() {
        return render(locale, messages::NO_COMMANDS_MESSAGE, &[]);
    }
    let mut out = format!(
        "*{}*\n",
        render(locale, messages::COMMANDS_HEADING_MESSAGE, &[])
    );
    for command in commands {
        out.push_str("\n/");
        out.push_str(&command.name);
        if !command.description.is_empty() {
            out.push_str(" — ");
            out.push_str(&command.description);
        }
    }
    out.push_str("\n\n");
    out.push_str(&render(
        locale,
        messages::COMMANDS_SEND_AS_SHOWN_MESSAGE,
        &[],
    ));
    out
}
