//! The base `CREATE TABLE` / `CREATE INDEX` batch for the conversation database.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Run once per open before the additive migrations; every statement is
    /// `IF NOT EXISTS`, so it is a no-op on an up-to-date database.
    pub(super) const BASE_SCHEMA_SQL: &'static str = "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS conversations (
                 id          TEXT PRIMARY KEY,
                 title       TEXT,
                 agent_id    TEXT,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS conversation_collaborators (
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 user_id         TEXT NOT NULL,
                 role            TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL,
                 PRIMARY KEY (conversation_id, user_id)
             );
             CREATE INDEX IF NOT EXISTS idx_conversation_collaborators_user
                 ON conversation_collaborators(user_id, conversation_id);
             CREATE TABLE IF NOT EXISTS agent_controls (
                 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                 requested_by    TEXT NOT NULL,
                 agent_id        TEXT,
                 model           TEXT,
                 effort          TEXT,
                 requested_at    INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_conversation
                 ON messages(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS proactive_openings (
                 idempotency_key TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 status          TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 completed_at    INTEGER
             );
             CREATE TABLE IF NOT EXISTS channel_turn_idempotency (
                 idempotency_key      TEXT PRIMARY KEY,
                 conversation_id      TEXT NOT NULL,
                 request_hash         TEXT NOT NULL,
                 status               TEXT NOT NULL,
                 reply                TEXT,
                 assistant_message_id TEXT,
                 assistant_message_ids TEXT NOT NULL DEFAULT '[]',
                 agent_id             TEXT,
                 fallback_warning     TEXT,
                 interactive_markup   TEXT,
                 created_at           INTEGER NOT NULL,
                 updated_at           INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_channel_turn_idempotency_updated
                 ON channel_turn_idempotency(updated_at);
             CREATE TABLE IF NOT EXISTS sessions (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 runnable_id     TEXT NOT NULL,
                 runnable_kind   TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'idle',
                 execution_profile TEXT NOT NULL DEFAULT '{}',
                 parent_session_id TEXT,
                 native_session_id TEXT,
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_conversation
                 ON sessions(conversation_id);
             CREATE TABLE IF NOT EXISTS harness_runs (
                 id                TEXT PRIMARY KEY,
                 session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                 parent_run_id     TEXT,
                 status            TEXT NOT NULL DEFAULT 'pending',
                 attempt           INTEGER NOT NULL DEFAULT 1,
                 idempotency_key   TEXT,
                 execution_profile TEXT NOT NULL DEFAULT '{}',
                 input_json        TEXT NOT NULL,
                 output_json       TEXT,
                 error             TEXT,
                 event_seq         INTEGER NOT NULL DEFAULT 0,
                 created_at        INTEGER NOT NULL,
                 started_at        INTEGER,
                 finished_at       INTEGER,
                 UNIQUE(session_id, idempotency_key)
             );
             CREATE INDEX IF NOT EXISTS idx_harness_runs_session
                 ON harness_runs(session_id, created_at DESC);
             -- Boot auto-resume ledger: how many times Core has re-run one user
             -- turn after a crash. Keyed by the turn so a new message starts a
             -- fresh budget, and written before the re-run starts so a turn that
             -- crashes Core again cannot loop forever.
             CREATE TABLE IF NOT EXISTS run_auto_resume (
                 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                 user_message_id TEXT NOT NULL,
                 attempts        INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS harness_run_events (
                 id         TEXT PRIMARY KEY,
                 run_id     TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
                 seq        INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 event_json TEXT NOT NULL,
                 UNIQUE(run_id, seq)
             );
             CREATE INDEX IF NOT EXISTS idx_harness_run_events_run
                 ON harness_run_events(run_id, seq);
             CREATE TABLE IF NOT EXISTS btw_entries (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 kind            TEXT NOT NULL DEFAULT 'btw',
                 question        TEXT NOT NULL,
                 answer          TEXT NOT NULL,
                 model           TEXT,
                 agent_id        TEXT,
                 preset          TEXT,
                 child_conversation_id TEXT,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_btw_conversation
                 ON btw_entries(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS conversation_title_history (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 title           TEXT NOT NULL,
                 source          TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_title_history_conversation
                 ON conversation_title_history(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS message_reactions (
                 message_id      TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 user_id         TEXT NOT NULL,
                 emoji           TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 PRIMARY KEY (message_id, user_id, emoji)
             );
             CREATE INDEX IF NOT EXISTS idx_reactions_conversation
                 ON message_reactions(conversation_id);
             CREATE TABLE IF NOT EXISTS agent_ui_state (
                 conversation_id TEXT NOT NULL,
                 tool_call_id    TEXT NOT NULL,
                 state           TEXT NOT NULL,
                 updated_at      INTEGER NOT NULL,
                 PRIMARY KEY (conversation_id, tool_call_id)
             );
             CREATE TABLE IF NOT EXISTS message_read_receipts (
                 message_id      TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 user_id         TEXT NOT NULL,
                 read_at         INTEGER NOT NULL,
                 PRIMARY KEY (message_id, user_id)
             );
             CREATE INDEX IF NOT EXISTS idx_read_receipts_conversation
                 ON message_read_receipts(conversation_id, message_id);
             CREATE TABLE IF NOT EXISTS conversation_model_changes (
                 sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
                 id             TEXT NOT NULL UNIQUE,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 selection_kind TEXT NOT NULL CHECK (selection_kind IN ('initial', 'change')),
                 provider_id    TEXT,
                 provider_label TEXT,
                 model_id       TEXT,
                 model_label    TEXT,
                 changed_by     TEXT,
                 created_at     INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_model_changes_conversation
                 ON conversation_model_changes(conversation_id, sequence);
             CREATE TABLE IF NOT EXISTS conversation_context_handoffs (
                 id               TEXT PRIMARY KEY,
                 conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 model_change_id  TEXT NOT NULL,
                 covered_head_id  TEXT NOT NULL DEFAULT '',
                 outcome          TEXT NOT NULL CHECK (outcome IN ('applied', 'not_needed')),
                 reason           TEXT NOT NULL,
                 from_model       TEXT,
                 to_model         TEXT,
                 from_context     INTEGER,
                 to_context       INTEGER,
                 summarized_count INTEGER NOT NULL,
                 boundary_at      INTEGER NOT NULL,
                 summary          TEXT,
                 created_at       INTEGER NOT NULL,
                 UNIQUE (model_change_id, covered_head_id)
             );
             CREATE INDEX IF NOT EXISTS idx_context_handoffs_conversation
                 ON conversation_context_handoffs(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS chat_checkpoints (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 message_id      TEXT,
                 kind            TEXT NOT NULL CHECK (kind IN ('turn', 'pre_restore')),
                 workspace       TEXT,
                 commit_id       TEXT,
                 skip_reason     TEXT,
                 created_at      INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_checkpoints_turn
                 ON chat_checkpoints(conversation_id, message_id) WHERE kind = 'turn';
             CREATE INDEX IF NOT EXISTS idx_chat_checkpoints_conversation
                 ON chat_checkpoints(conversation_id, created_at);";
}
