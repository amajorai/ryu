//! Parked device calls (design §1.6, P4) — the Retry-card fallback.
//!
//! The P4 spike (see `pending_tests::spike_*`) found durable server-side
//! resume infeasible without the hidden, Core-authored history the review
//! forbade: the OpenAI plane takes its history from the client's `messages`
//! (a resume turn has no client, and the persisted transcript holds only the
//! redacted display result), and the ACP agent owns its history. So a call
//! whose wait window ends unclaimed is PARKED instead: the model gets
//! `pending_on_device`, the card shows Retry for up to an hour, and this row
//! keeps the approval binding. The phone's Retry sends a new user turn
//! ("Retry phone action"); when the model calls the same canonical tool with
//! the same canonical input in that conversation, dispatch consumes the row,
//! reuses its recorded approval and pinned target, and the phone claims and
//! runs it on the live path. The result is the reply to that new turn.
//!
//! The row stores no device data and no input: only a salted binding of the
//! frozen `input_sha256`. Rows live in `db/device_tools.db`, survive a
//! restart, are never extended past `resumable_until_ms`, and are cleared by a
//! chat cancel or by forgetting the device.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

/// The approval a parked call carries into its retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParkedApproval {
    /// None recorded: the retry goes through the gate (and asks) again.
    None,
    AllowOnce,
    AllowAlways,
}

impl ParkedApproval {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "allow_once" => Self::AllowOnce,
            "allow_always" => Self::AllowAlways,
            _ => Self::None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParkedCall {
    pub(crate) conversation_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) owner_principal_id: String,
    /// The pinned target; `None` when no phone was ever reachable.
    pub(crate) target_device_id: Option<String>,
    pub(crate) tool: String,
    pub(crate) approval: ParkedApproval,
    pub(crate) created_ms: i64,
    pub(crate) resumable_until_ms: i64,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_tool_pending (
  conversation_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  target_device_id TEXT,
  tool TEXT NOT NULL,
  salt TEXT NOT NULL,
  binding TEXT NOT NULL,
  approval TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  resumable_until_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS device_tool_pending_match ON device_tool_pending (conversation_id, owner, tool);
";

/// Parked rows kept per conversation; the oldest are dropped past it.
const MAX_PER_CONVERSATION: i64 = 20;

fn binding(salt: &str, input_sha256: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-device-park-v1\n");
    hasher.update(salt.as_bytes());
    hasher.update(b"\n");
    hasher.update(input_sha256.as_bytes());
    hex::encode(hasher.finalize())
}

pub(crate) struct PendingStore {
    conn: Mutex<Connection>,
}

impl PendingStore {
    pub(crate) fn open(path: &Path) -> anyhow::Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> anyhow::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> anyhow::Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, run: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> anyhow::Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("device pending store poisoned"))?;
        Ok(run(&conn)?)
    }

    /// Park a call (or re-park a retried one, keeping its original deadline).
    pub(crate) fn park(
        &self,
        call: &ParkedCall,
        input_sha256: &str,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let salt = hex::encode(uuid::Uuid::new_v4().as_bytes());
        let bound = binding(&salt, input_sha256);
        self.with(|conn| {
            conn.execute(
                "DELETE FROM device_tool_pending WHERE resumable_until_ms <= ?1",
                params![now_ms],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO device_tool_pending
                 (conversation_id, tool_call_id, owner, target_device_id, tool, salt, binding, approval, created_ms, resumable_until_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    call.conversation_id,
                    call.tool_call_id,
                    call.owner_principal_id,
                    call.target_device_id,
                    call.tool,
                    salt,
                    bound,
                    call.approval.as_str(),
                    call.created_ms,
                    call.resumable_until_ms
                ],
            )?;
            conn.execute(
                "DELETE FROM device_tool_pending WHERE conversation_id = ?1 AND rowid NOT IN (
                   SELECT rowid FROM device_tool_pending WHERE conversation_id = ?1
                   ORDER BY created_ms DESC LIMIT ?2)",
                params![call.conversation_id, MAX_PER_CONVERSATION],
            )?;
            Ok(())
        })
    }

    /// Consume the unexpired parked call of this owner, conversation and
    /// canonical tool whose frozen input hashes to `input_sha256`.
    pub(crate) fn take_match(
        &self,
        conversation_id: &str,
        owner_principal_id: &str,
        tool: &str,
        input_sha256: &str,
        now_ms: i64,
    ) -> Option<ParkedCall> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "SELECT tool_call_id, target_device_id, salt, binding, approval, created_ms, resumable_until_ms
                 FROM device_tool_pending
                 WHERE conversation_id = ?1 AND owner = ?2 AND tool = ?3 AND resumable_until_ms > ?4
                 ORDER BY created_ms ASC",
            )?;
            let rows = statement.query_map(params![conversation_id, owner_principal_id, tool, now_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;
            let mut found = None;
            for row in rows {
                let (tool_call_id, target, salt, bound, approval, created_ms, until) = row?;
                if binding(&salt, input_sha256) == bound {
                    found = Some(ParkedCall {
                        conversation_id: conversation_id.to_owned(),
                        tool_call_id,
                        owner_principal_id: owner_principal_id.to_owned(),
                        target_device_id: target,
                        tool: tool.to_owned(),
                        approval: ParkedApproval::parse(&approval),
                        created_ms,
                        resumable_until_ms: until,
                    });
                    break;
                }
            }
            drop(statement);
            if let Some(call) = &found {
                let removed = conn.execute(
                    "DELETE FROM device_tool_pending WHERE conversation_id = ?1 AND tool_call_id = ?2",
                    params![call.conversation_id, call.tool_call_id],
                )?;
                if removed != 1 {
                    return Ok(None);
                }
            }
            Ok(found)
        })
        .ok()
        .flatten()
    }

    /// Clear a conversation's parked calls (chat cancel or delete).
    pub(crate) fn cancel_conversation(&self, conversation_id: &str) -> usize {
        self.with(|conn| {
            conn.execute(
                "DELETE FROM device_tool_pending WHERE conversation_id = ?1",
                params![conversation_id],
            )
        })
        .unwrap_or(0)
    }

    /// Clear parked calls pinned to a forgotten device.
    pub(crate) fn forget_device(&self, owner_principal_id: &str, device_id: &str) -> usize {
        self.with(|conn| {
            conn.execute(
                "DELETE FROM device_tool_pending WHERE owner = ?1 AND target_device_id = ?2",
                params![owner_principal_id, device_id],
            )
        })
        .unwrap_or(0)
    }
}

/// The process-wide store in `db/device_tools.db`; `None` when it cannot be
/// opened, in which case nothing parks and an expired wait fails as before.
pub(crate) fn store() -> Option<Arc<PendingStore>> {
    static STORE: OnceLock<Option<Arc<PendingStore>>> = OnceLock::new();
    STORE
        .get_or_init(
            || match PendingStore::open(&crate::paths::db_path("device_tools.db")) {
                Ok(store) => Some(Arc::new(store)),
                Err(error) => {
                    tracing::warn!(%error, "device pending store unavailable; calls will not park");
                    None
                }
            },
        )
        .clone()
}

/// Clear a conversation's parked calls in the process store.
pub(crate) fn cancel_conversation(conversation_id: &str) -> usize {
    store().map_or(0, |store| store.cancel_conversation(conversation_id))
}
