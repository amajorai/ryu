//! Conversation store unit tests, split by area. Helpers a part defines are
//! `pub(super)` and re-imported here so every part can use them.

use super::*;

/// Every production source of the conversation store: the module root and each
/// part it declares outside `cfg(test)`, keyed by module name (`""` is the
/// root). Source-text guards scan all of them, so splitting the store across
/// files cannot hide a statement from them. CRLF is normalized because a
/// Windows checkout hands `include_str!` `\r\n` line endings.
fn production_sources() -> Vec<(&'static str, String)> {
    [
        ("", include_str!("../conversations.rs")),
        ("append", include_str!("append.rs")),
        ("append_at", include_str!("append_at.rs")),
        ("boot_recovery", include_str!("boot_recovery.rs")),
        ("branching", include_str!("branching.rs")),
        ("channel_turns", include_str!("channel_turns.rs")),
        ("checkpoints", include_str!("checkpoints.rs")),
        ("clearing", include_str!("clearing.rs")),
        ("conversation_rows", include_str!("conversation_rows.rs")),
        (
            "conversation_settings",
            include_str!("conversation_settings.rs"),
        ),
        ("deletion", include_str!("deletion.rs")),
        ("fork", include_str!("fork.rs")),
        ("harness_events", include_str!("harness_events.rs")),
        ("harness_queue", include_str!("harness_queue.rs")),
        ("harness_rows", include_str!("harness_rows.rs")),
        ("harness_start", include_str!("harness_start.rs")),
        ("index_maintenance", include_str!("index_maintenance.rs")),
        ("listing", include_str!("listing.rs")),
        ("message_pages", include_str!("message_pages.rs")),
        ("message_reads", include_str!("message_reads.rs")),
        ("message_types", include_str!("message_types.rs")),
        ("model_change_types", include_str!("model_change_types.rs")),
        ("participants", include_str!("participants.rs")),
        ("reactions", include_str!("reactions.rs")),
        ("read_receipts", include_str!("read_receipts.rs")),
        ("row_writes", include_str!("row_writes.rs")),
        ("run_status", include_str!("run_status.rs")),
        ("schema", include_str!("schema.rs")),
        (
            "schema_conversation_columns",
            include_str!("schema_conversation_columns.rs"),
        ),
        ("schema_ddl", include_str!("schema_ddl.rs")),
        (
            "schema_message_columns",
            include_str!("schema_message_columns.rs"),
        ),
        ("search", include_str!("search.rs")),
        ("sessions", include_str!("sessions.rs")),
        ("side_chats", include_str!("side_chats.rs")),
        ("store", include_str!("store.rs")),
        ("summary_types", include_str!("summary_types.rs")),
        ("sync_messages", include_str!("sync_messages.rs")),
        ("tenancy", include_str!("tenancy.rs")),
        ("text_helpers", include_str!("text_helpers.rs")),
        ("titles_models", include_str!("titles_models.rs")),
        ("version_tree", include_str!("version_tree.rs")),
        ("version_types", include_str!("version_types.rs")),
    ]
    .into_iter()
    .map(|(name, source)| (name, source.replace("\r\n", "\n")))
    .collect()
}

/// The production parts the module root declares: each `mod name;` that is
/// neither `cfg(test)` nor mounted from another path.
fn declared_production_parts(root: &str) -> Vec<&str> {
    let lines: Vec<&str> = root.lines().collect();
    let mut parts: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(index, line)| {
            line.starts_with("mod ")
                && line.ends_with(';')
                && !index
                    .checked_sub(1)
                    .is_some_and(|previous| lines[previous].starts_with("#["))
        })
        .map(|(_, line)| &line["mod ".len()..line.len() - 1])
        .collect();
    parts.sort_unstable();
    parts
}

#[test]
fn production_sources_cover_every_declared_part() {
    let sources = production_sources();
    let root = &sources[0].1;
    let mut listed: Vec<&str> = sources[1..].iter().map(|(name, _)| *name).collect();
    listed.sort_unstable();
    assert_eq!(
        declared_production_parts(root),
        listed,
        "a production part of the conversation store is missing from production_sources()"
    );
}

mod clearing_and_previews;
mod forks;
mod harness_runs;
mod imports_and_links;
mod openings_and_channel_turns;
mod pages_and_versions;
mod participants_and_auto_resume;
mod reactions_and_receipts;
mod resume_and_sync;
mod search_and_counts;
mod search_backfill;
mod sessions_and_queue;
mod tenancy_ownership;
mod titles_and_models;
mod visibility_and_choke_point;

use forks::*;
use resume_and_sync::*;
use sessions_and_queue::*;
