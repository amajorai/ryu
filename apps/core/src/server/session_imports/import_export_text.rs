//! The chat-export import's item title, result sentences and "Chats imported"
//! notification as Core messages (`crate::i18n::messages::import_outcomes`
//! and `::notifications`). The English text stays on the wire (`title`,
//! `detail`) for older clients; the messages ride next to it (`title_i18n`,
//! `detail_i18n`) so the desktop Import dialog renders the reader's language.
//! The notification body is the English of a whole-sentence template, which
//! `events::system_text` recognizes and renders in the node's language.

use crate::i18n::{messages, Message, Template};
use crate::import::{english, kind, ImportOutcome};

/// What happened to the conversations of one export group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ExportCounts {
    pub created: usize,
    pub updated: usize,
    pub unchanged: usize,
    /// Edited in the source since the last import; left as imported.
    pub diverged: usize,
    pub failed: usize,
    /// Kept to their first `MAX_MESSAGES_PER_CONVERSATION` messages.
    pub shortened: usize,
}

/// The group's title: "Chats from {label}", or "Project “{name}” from {label}".
pub(super) fn export_title(label: &str, project: Option<&str>) -> Message {
    match project {
        Some(name) => Message::new(messages::IMPORT_OUTCOME_CHAT_EXPORT_PROJECT_TITLE_MESSAGE)
            .text("label", label)
            .text("name", name),
        None => {
            Message::new(messages::IMPORT_OUTCOME_CHAT_EXPORT_TITLE_MESSAGE).text("label", label)
        }
    }
}

fn count(message: Message, name: &str, value: usize) -> Message {
    message.number(name, value as f64, 0, 0)
}

/// `one` when `value` is 1, else `other`, with `value` as the `name` count.
fn counted(one: Template, other: Template, name: &str, value: usize) -> Message {
    count(
        Message::new(if value == 1 { one } else { other }),
        name,
        value,
    )
}

/// The result sentences, in the order the English detail lists them.
pub(super) fn export_detail(
    label: &str,
    counts: &ExportCounts,
    folder: Option<&str>,
    kept: &[String],
) -> Vec<Message> {
    let mut sentences = vec![count(
        count(
            count(
                Message::new(messages::IMPORT_OUTCOME_CHAT_EXPORT_COUNTS_MESSAGE),
                "created",
                counts.created,
            ),
            "updated",
            counts.updated,
        ),
        "unchanged",
        counts.unchanged,
    )];
    if counts.diverged > 0 {
        sentences.push(
            counted(
                messages::IMPORT_OUTCOME_CHAT_EXPORT_DIVERGED_ONE_MESSAGE,
                messages::IMPORT_OUTCOME_CHAT_EXPORT_DIVERGED_MESSAGE,
                "diverged",
                counts.diverged,
            )
            .text("label", label),
        );
    }
    if counts.failed > 0 {
        sentences.push(counted(
            messages::IMPORT_OUTCOME_CHAT_EXPORT_FAILED_ONE_MESSAGE,
            messages::IMPORT_OUTCOME_CHAT_EXPORT_FAILED_MESSAGE,
            "failed",
            counts.failed,
        ));
    }
    if counts.shortened > 0 {
        sentences.push(count(
            counted(
                messages::IMPORT_OUTCOME_CHAT_EXPORT_SHORTENED_ONE_MESSAGE,
                messages::IMPORT_OUTCOME_CHAT_EXPORT_SHORTENED_MESSAGE,
                "shortened",
                counts.shortened,
            ),
            "max",
            crate::import::chat_exports::MAX_MESSAGES_PER_CONVERSATION,
        ));
    }
    if let Some(folder) = folder {
        sentences.push(
            Message::new(messages::IMPORT_OUTCOME_CHAT_EXPORT_FOLDER_MESSAGE)
                .text("folder", folder),
        );
    }
    if !kept.is_empty() {
        sentences.push(
            Message::new(messages::IMPORT_OUTCOME_CHAT_EXPORT_KEPT_EDITS_MESSAGE)
                .text("files", kept.join(", ")),
        );
    }
    sentences
}

/// The group's outcome: its status from `counts`, its title and its result
/// sentences as English text plus messages.
pub(super) fn export_outcome(
    id: &str,
    title: Message,
    counts: &ExportCounts,
    detail: Vec<Message>,
    folder_path: Option<String>,
) -> ImportOutcome {
    let english_title = english(&title);
    let settled = counts.created + counts.updated + counts.unchanged + counts.diverged;
    let changed = counts.created + counts.updated;
    let mut outcome = if counts.failed > 0 && settled == 0 {
        ImportOutcome::failed(kind::CONVERSATIONS, id, &english_title, "")
    } else if changed == 0 && counts.diverged > 0 {
        ImportOutcome::skipped(kind::CONVERSATIONS, id, &english_title, "")
    } else if changed == 0 && folder_path.is_none() {
        ImportOutcome::already(kind::CONVERSATIONS, id, &english_title)
    } else {
        ImportOutcome::ok(kind::CONVERSATIONS, id, &english_title)
    }
    .titled(title);
    let english_detail: Vec<String> = detail.iter().map(english).collect();
    outcome.detail = Some(english_detail.join(" "));
    outcome.detail_i18n = detail;
    outcome.folder_path = folder_path;
    outcome
}

/// The "Chats imported" notification body, as English that
/// `events::system_text` renders in the node's language.
pub(super) fn chats_imported_body(
    label: &str,
    project: Option<&str>,
    created: usize,
    updated: usize,
) -> String {
    let message = match project {
        Some(name) => Message::new(messages::NOTIFY_CHATS_IMPORTED_PROJECT_MESSAGE)
            .text("label", label)
            .text("name", name),
        None => Message::new(messages::NOTIFY_CHATS_IMPORTED_EXPORT_MESSAGE).text("label", label),
    };
    english(&count(
        count(message, "created", created),
        "updated",
        updated,
    ))
}

#[cfg(test)]
#[path = "import_export_text_tests.rs"]
mod tests;
