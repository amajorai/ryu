//! A staged bot export archive (see `crate::import::bot_archive`): the
//! folder an uploaded Grok Bot export is unpacked into. Each `bots/<key>/` is
//! a persona workspace (`SOUL.md`, `MEMORY.md`, `skills/`), so the persona,
//! memory and skill paths of the shared scan read it. This module names each
//! bot from the checked manifest, lists a bot's files and conversations as
//! one item, and reports what was not exported or is not imported.

use super::*;
use crate::import::bot_archive::{self, BotSummary};

/// True when `root` is a staging folder of a bot export archive.
pub(super) fn is_bot_archive(root: &Path) -> bool {
    bot_archive::is_staged_root(root)
}

/// `bots/<key>/` of every bot the manifest lists, in manifest order.
pub(super) fn archive_bot_dirs(root: &Path) -> Vec<PathBuf> {
    bot_archive::read_staged_summary(root)
        .map(|summary| {
            summary
                .bots
                .iter()
                .map(|bot| root.join("bots").join(&bot.key))
                .filter(|dir| dir.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// The bot that `path`, a path inside the staging folder `root`, belongs to.
fn bot_of_path(root: &Path, path: &Path) -> Option<BotSummary> {
    let mut parts = path.strip_prefix(root).ok()?.components();
    if parts.next()?.as_os_str() != "bots" {
        return None;
    }
    let key = parts.next()?.as_os_str().to_str()?;
    bot_archive::staged_bot(root, key)
}

/// Name and description of the archive bot whose folder is `dir`. An archive
/// names no model, so the agent takes the default one.
pub(super) fn archive_bot_profile(root: &Path, dir: &Path) -> Option<PersonaProfile> {
    let bot = bot_of_path(root, dir)?;
    let description = if bot.description.is_empty() {
        format!("Migrated from {}.", Framework::GrokBot.label())
    } else {
        bot.description
    };
    Some(PersonaProfile {
        name: bot.name,
        description: Some(description),
        model: None,
    })
}

/// The name a memory file of an archive bot is listed under: the bot's name,
/// because every bot's file is called `MEMORY.md`.
pub(super) fn archive_memory_name(root: &Path, path: &Path) -> Option<String> {
    bot_of_path(root, path).map(|bot| bot.name)
}

/// Per bot: its skills, one item for its files and conversations, and review
/// notes for its routines and for what the migrator could not read.
pub(super) fn collect_bot_archive(root: &Path, c: &mut Collector) {
    let Some(summary) = bot_archive::read_staged_summary(root) else {
        return;
    };
    let source = Framework::GrokBot.label();
    for bot in &summary.bots {
        // The shared walk stops at a folder named `memory`, which a bot key
        // may be, so each bot's skills are walked as their own sub-root.
        let skills = root.join("bots").join(&bot.key).join("skills");
        if skills.is_dir() {
            super::super::walk(root, &skills, 1, c);
        }
        if bot.files + bot.conversations > 0 {
            let title = match bot.conversations {
                0 => Message::new(messages::IMPORT_EXPORT_PROJECT_TITLE_MESSAGE),
                1 => Message::new(messages::IMPORT_EXPORT_PROJECT_ONE_CHAT_TITLE_MESSAGE),
                chats => counted(
                    Message::new(messages::IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE),
                    chats,
                ),
            }
            .text("source", source)
            .text("name", &bot.name);
            let mut sentences = vec![Message::new(messages::IMPORT_PROJECT_FOLDER_DETAIL_MESSAGE)];
            match bot.files {
                0 => {}
                1 => sentences.push(Message::new(
                    messages::IMPORT_PROJECT_ONE_FILE_DETAIL_MESSAGE,
                )),
                files => sentences.push(counted(
                    Message::new(messages::IMPORT_PROJECT_FILES_DETAIL_MESSAGE),
                    files,
                )),
            }
            c.conversations.push(
                ScanItem::titled(
                    kind::CONVERSATIONS,
                    bot_archive::bot_item_id(&bot.key),
                    title,
                    None,
                )
                .with_sentences(sentences),
            );
        }
        if !bot.routines.is_empty() {
            let routines: Vec<String> = bot
                .routines
                .iter()
                .map(|routine| {
                    if routine.schedule.is_empty() {
                        routine.name.clone()
                    } else {
                        format!("{} ({})", routine.name, routine.schedule)
                    }
                })
                .collect();
            c.warn_verbatim(format!(
                "Routines of {} are not imported. Create them again in Ryu if you still need them. {}",
                bot.name,
                routines.join(", ")
            ));
        }
        if !bot.not_exported.is_empty() {
            c.warn_verbatim(format!(
                "The migrator could not export these parts of {}. {}",
                bot.name,
                bot.not_exported.join(", ")
            ));
        }
    }
    if summary.left_out_entries > 0 {
        c.warn_verbatim(format!(
            "Left out of the import: {} of the zip. These are sign-in files, empty files, files past the limit of one import, or names that do not work on every system.",
            entries(summary.left_out_entries)
        ));
    }
    if summary.ignored_entries > 0 {
        c.warn_verbatim(format!(
            "Not part of a bot export and ignored: {} of the zip.",
            entries(summary.ignored_entries)
        ));
    }
}

fn entries(count: usize) -> String {
    if count == 1 {
        "1 entry".to_string()
    } else {
        format!("{count} entries")
    }
}

#[cfg(test)]
#[path = "grok_bot_tests.rs"]
mod tests;
