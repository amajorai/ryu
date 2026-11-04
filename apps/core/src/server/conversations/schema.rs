//! Schema creation and additive migrations for the conversation database.
//!
//! The base tables live in `schema_ddl`; the additive column migrations run in
//! the original order from `schema_conversation_columns` and
//! `schema_message_columns`.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    pub(super) fn init_schema(conn: &Connection) -> Result<()> {
        // Pre-release handoff rows were keyed by model change alone. They only
        // cache summaries Core can regenerate, so drop that shape and let the
        // batch below recreate the table keyed by change and branch.
        let handoff_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversation_context_handoffs)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|row| row.ok()).collect()
        };
        if !handoff_columns.is_empty() && !handoff_columns.contains("covered_head_id") {
            conn.execute_batch("DROP TABLE conversation_context_handoffs")
                .context("dropping pre-release context handoff table")?;
        }
        conn.execute_batch(Self::BASE_SCHEMA_SQL)
            .context("initializing conversation schema")?;
        crate::server::conversation_lifecycle::initialize(conn)
            .context("initializing conversation lifecycle identities")?;

        let existing_channel_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(channel_turn_idempotency)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|row| row.ok()).collect()
        };
        if !existing_channel_columns.contains("interactive_markup") {
            conn.execute_batch(
                "ALTER TABLE channel_turn_idempotency ADD COLUMN interactive_markup TEXT",
            )
            .context("adding channel-turn interactive markup column")?;
        }
        // NULL on rows written before request hashing sorted object keys; the
        // channel-turn claim accepts their legacy digest for a bounded window.
        if !existing_channel_columns.contains("hash_scheme") {
            conn.execute_batch("ALTER TABLE channel_turn_idempotency ADD COLUMN hash_scheme TEXT")
                .context("adding channel-turn hash scheme column")?;
        }

        let existing_conv_columns = Self::migrate_conversation_columns(conn)?;
        Self::migrate_session_and_harness_columns(conn)?;
        Self::migrate_message_columns(conn, &existing_conv_columns)?;
        Ok(())
    }
}
