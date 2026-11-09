//! Additive migrations for `sessions`, `harness_runs`, `messages` and
//! `btw_entries` columns, and the message search queue.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    pub(super) fn migrate_session_and_harness_columns(conn: &Connection) -> Result<()> {
        // Additive migration for the versioned harness session projection. The
        // legacy `/api/sessions` shape remains compatible, while new harness
        // callers gain a durable execution profile and parent/native bindings.
        let existing_session_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "execution_profile",
                "ALTER TABLE sessions ADD COLUMN execution_profile TEXT NOT NULL DEFAULT '{}'",
            ),
            (
                "parent_session_id",
                "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT",
            ),
            (
                "native_session_id",
                "ALTER TABLE sessions ADD COLUMN native_session_id TEXT",
            ),
        ] {
            if !existing_session_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding session column {col}"))?;
            }
        }

        // Additive migration: harness double-texting. A run submitted behind an
        // active run is persisted as `pending` with its strategy; the queue is
        // ordered by priority (interrupt/rollback first) and then arrival, and
        // a rollback remembers which run's turns it removes when it starts.
        let existing_harness_run_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(harness_runs)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "multitask_strategy",
                "ALTER TABLE harness_runs ADD COLUMN multitask_strategy TEXT",
            ),
            (
                "queue_priority",
                "ALTER TABLE harness_runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "rollback_run_id",
                "ALTER TABLE harness_runs ADD COLUMN rollback_run_id TEXT",
            ),
        ] {
            if !existing_harness_run_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding harness run column {col}"))?;
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_harness_runs_queue
                 ON harness_runs(session_id, status, queue_priority DESC, created_at)",
        )
        .context("creating harness run queue index")?;
        Ok(())
    }

    pub(super) fn migrate_message_columns(
        conn: &Connection,
        existing_conv_columns: &std::collections::HashSet<String>,
    ) -> Result<()> {
        // Additive migration: add agent_id column to messages (#414).
        let existing_msg_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        if !existing_msg_columns.contains("agent_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN agent_id TEXT")
                .context("adding agent_id column to messages")?;
        }

        // Additive migration: generalize side-chat rows so `/btw` asides and
        // subagent child runs share the same parent-conversation list.
        let existing_btw_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(btw_entries)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "kind",
                "ALTER TABLE btw_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'btw'",
            ),
            (
                "agent_id",
                "ALTER TABLE btw_entries ADD COLUMN agent_id TEXT",
            ),
            ("preset", "ALTER TABLE btw_entries ADD COLUMN preset TEXT"),
            (
                "child_conversation_id",
                "ALTER TABLE btw_entries ADD COLUMN child_conversation_id TEXT",
            ),
        ] {
            if !existing_btw_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding btw_entries column {col}"))?;
            }
        }

        // Additive migration: the verified human author of a message (multi-user
        // collaboration epic, Phase 0). Distinct from `agent_id` (the AI agent).
        // Nullable — existing rows and agent messages carry NULL.
        if !existing_msg_columns.contains("author_user_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_user_id TEXT")
                .context("adding author_user_id column to messages")?;
        }

        // Additive migration: connector-supplied display name of the sender for
        // group/channel chats (Telegram first name, Discord username, etc.).
        // Nullable; unverified (NOT for auth) — distinct from author_user_id.
        if !existing_msg_columns.contains("author_name") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_name TEXT")
                .context("adding author_name column to messages")?;
        }

        // Additive migration: server-verified widget attribution. Nullable so
        // ordinary and legacy messages remain unchanged; the conversation_id
        // column is the binding that keeps this metadata scoped to its thread.
        for (col, ddl) in [
            ("source", "ALTER TABLE messages ADD COLUMN source TEXT"),
            (
                "widget_instance_id",
                "ALTER TABLE messages ADD COLUMN widget_instance_id TEXT",
            ),
            (
                "origin_server",
                "ALTER TABLE messages ADD COLUMN origin_server TEXT",
            ),
        ] {
            if !existing_msg_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col} to messages"))?;
            }
        }

        // Additive migration: structured render parts (AI SDK reduced UIMessage
        // `parts` array) captured server-side as an assistant turn streams, so a
        // reloaded conversation re-renders its tool rows + cowork context instead
        // of flattening to text-only. Nullable, sealed at rest like `content`;
        // existing rows carry NULL and fall back to a text part on the client.
        if !existing_msg_columns.contains("parts") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN parts TEXT")
                .context("adding parts column to messages")?;
        }

        if !existing_msg_columns.contains("metadata") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN metadata TEXT")
                .context("adding metadata column to messages")?;
        }

        // Additive migration: per-message thumbs feedback ('up' | 'down' | NULL).
        // A deliberate 👍/👎 on an assistant reply. Durable so the button stays lit
        // across reloads; it also seeds the continual-learning reward and the RAG
        // memory sinks (see `crate::learning::apply_message_feedback`). Nullable —
        // existing rows and un-rated messages carry NULL. Not encrypted (a coarse
        // ordinal, no message text).
        if !existing_msg_columns.contains("feedback") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN feedback TEXT")
                .context("adding feedback column to messages")?;
        }

        // Additive migration: message version tree (ChatGPT/Claude-style edit +
        // regenerate branching). `parent_message_id` links a message to the turn
        // it replied to; siblings sharing a parent are alternate versions. NULL
        // for every message in a conversation that has never been branched (flat
        // history stays byte-identical). Populated lazily on first edit/regenerate
        // by `linearize`, then maintained by `append_message`.
        if !existing_msg_columns.contains("parent_message_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN parent_message_id TEXT")
                .context("adding parent_message_id column to messages")?;
        }

        // Additive migration: "this turn was cut off mid-stream". A killed node
        // (crash / force-quit / OOM) leaves the assistant row holding whatever the
        // streaming loop had flushed and no terminal write ever lands, so the row
        // is indistinguishable from a finished answer that simply stops mid
        // sentence. Stamped at boot by `reconcile_interrupted_runs` for the rows
        // whose conversation is still parked at `run_status = 'running'`. 0 for
        // every existing row and every normally-completed turn.
        if !existing_msg_columns.contains("interrupted") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0",
            )
            .context("adding interrupted column to messages")?;
        }

        // Additive migration: the conversation's currently-selected leaf in the
        // version tree. NULL means the conversation is flat (never branched) and
        // reads fall back to chronological order. Once set, the active thread is
        // the parent chain walked up from this leaf, and new turns attach beneath
        // it.
        if !existing_conv_columns.contains("active_leaf_message_id") {
            conn.execute_batch("ALTER TABLE conversations ADD COLUMN active_leaf_message_id TEXT")
                .context("adding active_leaf_message_id column to conversations")?;
        }

        // Track IDs, never plaintext. Triggers cover imports, forks, and sync as
        // well as ordinary appends; revisions prevent acknowledging a newer edit
        // while an older revision is being embedded outside the database lock.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_parent
                 ON messages(conversation_id, parent_message_id, created_at);
             CREATE TABLE IF NOT EXISTS message_search_pending (
                 revision INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind INTEGER NOT NULL,
                 message_id TEXT NOT NULL,
                 dirty INTEGER NOT NULL DEFAULT 1,
                 UNIQUE(kind, message_id)
             );
             CREATE INDEX IF NOT EXISTS idx_message_search_pending_kind
                 ON message_search_pending(kind, revision);
             CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id) VALUES (0, NEW.id);
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id) VALUES (1, NEW.id);
             END;
             CREATE TRIGGER IF NOT EXISTS message_search_update
             AFTER UPDATE OF content, role, conversation_id, created_at ON messages BEGIN
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty) VALUES (0, NEW.id, 2);
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty) VALUES (1, NEW.id, 2);
             END;
             CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
                 DELETE FROM message_search_pending WHERE kind = 0 AND message_id = OLD.id;
                 DELETE FROM message_search_pending WHERE kind = 1 AND message_id = OLD.id;
             END;",
        )?;
        Self::init_tool_part_search(conn)?;
        Ok(())
    }
}
