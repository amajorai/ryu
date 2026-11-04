//! Additive migrations for `conversations` columns, the denormalized message
//! count and the sync revision.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Adds missing `conversations` columns and returns the column set read
    /// before this run, which the message migrations consult as well.
    pub(super) fn migrate_conversation_columns(
        conn: &Connection,
    ) -> Result<std::collections::HashSet<String>> {
        // Additive migration: add run-metadata columns to `conversations` that
        // may not exist on databases created before this unit (U013). Each ALTER
        // is guarded by a PRAGMA table_info check so the call is a no-op when
        // the column already exists — safe to run on every startup.
        let existing_conv_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversations)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "folder_path",
                "ALTER TABLE conversations ADD COLUMN folder_path   TEXT",
            ),
            (
                "branch",
                "ALTER TABLE conversations ADD COLUMN branch        TEXT",
            ),
            (
                "worktree_path",
                "ALTER TABLE conversations ADD COLUMN worktree_path TEXT",
            ),
            (
                "run_status",
                "ALTER TABLE conversations ADD COLUMN run_status    TEXT",
            ),
            // Multi-agent participants (#414): JSON array of agent_ids.
            // Existing single-agent conversations are back-filled by a trigger in
            // add_participant; new conversations start empty and the primary agent
            // is added on first message.
            (
                "participants",
                "ALTER TABLE conversations ADD COLUMN participants  TEXT NOT NULL DEFAULT '[]'",
            ),
            // Coordinator threads (Codex-style cross-thread orchestration): a
            // coordinator agent can pin a thread to keep it surfaced and archive
            // a finished one to hide it. Both default off so existing
            // conversations are neither pinned nor archived.
            (
                "pinned",
                "ALTER TABLE conversations ADD COLUMN pinned        INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "archived",
                "ALTER TABLE conversations ADD COLUMN archived      INTEGER NOT NULL DEFAULT 0",
            ),
            // Pull requests linked to a chat beyond the one its branch owns: a
            // JSON array of GitHub pull request URLs, written by
            // `set_pull_request_linked`.
            (
                "linked_pull_requests",
                "ALTER TABLE conversations ADD COLUMN linked_pull_requests TEXT NOT NULL DEFAULT '[]'",
            ),
            // Auto-rename (ChatGPT/Claude-style): a conversation's title is first
            // derived from the first user message, then a background task asks the
            // default local model for a concise title and overwrites it. A manual
            // rename (REST/coordinator) sets `title_custom = 1` so the auto-namer
            // never clobbers a user-chosen title. Defaults off → existing
            // conversations are eligible for a one-time auto-name on their next
            // first-user-message (none, since they already have messages).
            (
                "title_custom",
                "ALTER TABLE conversations ADD COLUMN title_custom  INTEGER NOT NULL DEFAULT 0",
            ),
            // Multi-user tenancy (collaboration epic, Phase 0): the verified
            // human owner of the conversation, the org it belongs to, its
            // sharing visibility, and an optional owning team. All nullable
            // except `visibility`, which defaults to 'private' so existing
            // single-tenant conversations stay private. ACL enforcement is wired
            // in a later stage; these are schema-only for now.
            (
                "owner_user_id",
                "ALTER TABLE conversations ADD COLUMN owner_user_id TEXT",
            ),
            (
                "org_id",
                "ALTER TABLE conversations ADD COLUMN org_id        TEXT",
            ),
            (
                "visibility",
                "ALTER TABLE conversations ADD COLUMN visibility    TEXT NOT NULL DEFAULT 'private'",
            ),
            (
                "team_id",
                "ALTER TABLE conversations ADD COLUMN team_id       TEXT",
            ),
            // Channel-backed sessions carry the control-plane config id so Core
            // can distinguish an org-shared bot room from a human conversation
            // when the machine ingress gate runs.
            (
                "channel_id",
                "ALTER TABLE conversations ADD COLUMN channel_id    TEXT",
            ),
            // Imported threads (agent-native history import, Zed/VS Code parity):
            // `origin` marks where a conversation came from (e.g. `import:claude`)
            // and `native_session_id` records the agent's own session/thread id so
            // a future ACP `session/load` can warm-resume the agent's context.
            // Both nullable → existing conversations are native Ryu threads.
            (
                "origin",
                "ALTER TABLE conversations ADD COLUMN origin        TEXT",
            ),
            (
                "native_session_id",
                "ALTER TABLE conversations ADD COLUMN native_session_id TEXT",
            ),
            ("icon", "ALTER TABLE conversations ADD COLUMN icon TEXT"),
            (
                "continued_on",
                "ALTER TABLE conversations ADD COLUMN continued_on TEXT",
            ),
        ] {
            if !existing_conv_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col}"))?;
            }
        }
        hierarchy::migrate(conn, &existing_conv_columns)?;
        scope_guidance::migrate(conn)?;

        // Denormalized message count. Every summary read used a correlated
        // `COUNT(*)` over `messages` per conversation, which walks every index
        // entry of every chat while the store lock is held. Triggers keep the
        // column exact for all writers (appends, imports, sync replay, deletes),
        // and the conversation-insert trigger recounts so messages written before
        // their conversation row still count. The column, backfill and triggers
        // land in one transaction so no database ends up with one but not the
        // others.
        if !existing_conv_columns.contains("message_count") {
            let tx = conn
                .unchecked_transaction()
                .context("starting message_count migration")?;
            tx.execute_batch(
                "ALTER TABLE conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
                 UPDATE conversations SET message_count =
                     (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id);
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_insert
                 AFTER INSERT ON messages BEGIN
                     UPDATE conversations SET message_count = message_count + 1
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_delete
                 AFTER DELETE ON messages BEGIN
                     UPDATE conversations SET message_count = message_count - 1
                      WHERE id = OLD.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_move
                 AFTER UPDATE OF conversation_id ON messages
                 WHEN OLD.conversation_id IS NOT NEW.conversation_id BEGIN
                     UPDATE conversations SET message_count = message_count - 1
                      WHERE id = OLD.conversation_id;
                     UPDATE conversations SET message_count = message_count + 1
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS conversations_count_after_insert
                 AFTER INSERT ON conversations BEGIN
                     UPDATE conversations SET message_count =
                         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = NEW.id)
                      WHERE id = NEW.id;
                 END;",
            )
            .context("adding message_count column and triggers")?;
            tx.commit().context("committing message_count migration")?;
        }

        // Sync revision: changes whenever anything the cloud sync payload carries
        // changes, so the sync loop can skip conversations it already pushed.
        // `updated_at` alone is not enough: streamed replies are rewritten in
        // place by `update_message_content` without touching it. Values come from
        // one global sequence rather than a per-row counter, so a conversation
        // deleted and recreated under the same id never repeats a revision the
        // loop has already recorded.
        if !existing_conv_columns.contains("sync_rev") {
            let tx = conn
                .unchecked_transaction()
                .context("starting sync_rev migration")?;
            tx.execute_batch(
                "ALTER TABLE conversations ADD COLUMN sync_rev INTEGER NOT NULL DEFAULT 0;
                 CREATE TABLE IF NOT EXISTS sync_rev_seq (
                     id INTEGER PRIMARY KEY CHECK (id = 1),
                     value INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO sync_rev_seq (id, value) VALUES (1, 0);
                 CREATE TRIGGER IF NOT EXISTS conversations_sync_rev_after_insert
                 AFTER INSERT ON conversations BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS conversations_sync_rev_after_update
                 AFTER UPDATE OF title, agent_id, folder_path, branch, worktree_path,
                                 run_status, owner_user_id, created_at, updated_at
                 ON conversations BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_insert
                 AFTER INSERT ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_delete
                 AFTER DELETE ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = OLD.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_update
                 AFTER UPDATE OF content, role, created_at, conversation_id ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id IN (OLD.conversation_id, NEW.conversation_id);
                 END;",
            )
            .context("adding sync_rev column and triggers")?;
            tx.commit().context("committing sync_rev migration")?;
        }
        Ok(existing_conv_columns)
    }
}
