//! Harness run rows, events and the conversions between stored and wire
//! shapes.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// The result of starting a run, including whether dispatch is new or an
/// idempotent replay.
#[derive(Debug, Clone)]
pub struct HarnessRunStart {
    pub run: HarnessRun,
    pub created: bool,
    /// The active run an `interrupt`/`rollback` request displaces. The caller
    /// stops it; the new run is promoted once it has ended.
    pub displaced_run_id: Option<String>,
}

/// A queued run that was just moved to `running` and must be dispatched.
#[derive(Debug, Clone)]
pub struct PromotedHarnessRun {
    pub run: HarnessRun,
    /// The run's decrypted input, as accepted when it was queued.
    pub input: serde_json::Value,
    pub conversation_id: String,
    /// Messages a rollback removed from the transcript before the run started.
    pub removed_messages: usize,
}

/// A session whose queue a restart left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedHarnessSession {
    pub session_id: String,
    /// The conversation belongs to a person or org, so a queued run cannot be
    /// dispatched without its author's verified credentials.
    pub attributed: bool,
}

/// Append `run_started` + `input_accepted` after `current_seq` and advance the
/// run's cursor. Shared by immediate starts and queue promotion so both emit
/// the same start boundary.
#[allow(clippy::too_many_arguments)]
pub(super) fn append_run_start_events(
    tx: &rusqlite::Transaction<'_>,
    cipher: &ryu_crypto::FieldCipher,
    run_id: &str,
    session_id: &str,
    current_seq: u64,
    now: i64,
    execution_profile: ExecutionProfile,
    input_hash: String,
    message_count: u32,
) -> Result<Vec<RunEventEnvelope>> {
    let started = build_harness_event(
        run_id,
        session_id,
        current_seq + 1,
        now,
        RunEvent::RunStarted { execution_profile },
    );
    let accepted = build_harness_event(
        run_id,
        session_id,
        current_seq + 2,
        now,
        RunEvent::InputAccepted {
            input_hash,
            message_count,
        },
    );
    insert_harness_event(tx, cipher, &started)?;
    insert_harness_event(tx, cipher, &accepted)?;
    tx.execute(
        "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
        params![i64::try_from(current_seq + 2).unwrap_or(i64::MAX), run_id],
    )?;
    Ok(vec![started, accepted])
}

/// Remove the transcript turns a displaced run wrote: every message of the
/// session's conversation created at or after the run started and before the
/// next run of the session started. Harness runs of one session are serialized,
/// so that window belongs to the displaced run; turns of a run that ran in
/// between (a queued interrupt that completed before this rollback was
/// promoted) are outside it and stay.
/// When the conversation is branched and its active leaf was removed, the leaf
/// moves to the parent of the earliest removed message. Returns removed ids.
pub(super) fn rollback_harness_run_turns_locked(
    tx: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    rolled_back_run_id: &str,
) -> Result<Vec<String>> {
    let started_at: Option<Option<i64>> = tx
        .query_row(
            "SELECT started_at FROM harness_runs WHERE id = ?1",
            params![rolled_back_run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(Some(started_at)) = started_at else {
        return Ok(Vec::new());
    };
    // The window closes when the next run of the same session started (the
    // run being promoted has no `started_at` yet, so it never closes it).
    let window_end: i64 = tx.query_row(
        "SELECT COALESCE(MIN(next.started_at), ?3) FROM harness_runs AS next
         WHERE next.session_id = (SELECT session_id FROM harness_runs WHERE id = ?1)
           AND next.id != ?1 AND next.started_at IS NOT NULL AND next.started_at > ?2",
        params![rolled_back_run_id, started_at, i64::MAX],
        |row| row.get(0),
    )?;
    let removed: Vec<(String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT id, parent_message_id FROM messages
             WHERE conversation_id = ?1 AND created_at >= ?2 AND created_at < ?3
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, started_at, window_end], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if removed.is_empty() {
        return Ok(Vec::new());
    }
    let active_leaf: Option<String> = tx
        .query_row(
            "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let ids: Vec<String> = removed.iter().map(|(id, _)| id.clone()).collect();
    if active_leaf
        .as_deref()
        .is_some_and(|leaf| ids.iter().any(|id| id == leaf))
    {
        let new_leaf = removed.first().and_then(|(_, parent)| parent.clone());
        tx.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
            params![new_leaf, conversation_id],
        )?;
    }
    for id in &ids {
        tx.execute(
            "DELETE FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
        tx.execute(
            "DELETE FROM message_reactions WHERE message_id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
        tx.execute(
            "DELETE FROM message_read_receipts WHERE message_id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
    }
    Ok(ids)
}

#[derive(Debug)]
pub(super) struct HarnessRunDbRow {
    pub(super) id: String,
    pub(super) session_id: String,
    pub(super) parent_run_id: Option<String>,
    pub(super) status: String,
    pub(super) attempt: i64,
    pub(super) idempotency_key: Option<String>,
    pub(super) execution_profile: String,
    #[allow(dead_code)]
    pub(super) input_json: String,
    pub(super) output_json: Option<String>,
    pub(super) error: Option<String>,
    pub(super) event_seq: i64,
    pub(super) created_at: i64,
    pub(super) started_at: Option<i64>,
    pub(super) finished_at: Option<i64>,
    pub(super) multitask_strategy: Option<String>,
}

pub(super) fn read_harness_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HarnessRunDbRow> {
    Ok(HarnessRunDbRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        parent_run_id: row.get(2)?,
        status: row.get(3)?,
        attempt: row.get(4)?,
        idempotency_key: row.get(5)?,
        execution_profile: row.get(6)?,
        input_json: row.get(7)?,
        output_json: row.get(8)?,
        error: row.get(9)?,
        event_seq: row.get(10)?,
        created_at: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        multitask_strategy: row.get(14)?,
    })
}

pub(super) fn decode_harness_run(
    cipher: &ryu_crypto::FieldCipher,
    row: HarnessRunDbRow,
) -> Result<HarnessRun> {
    let output = row
        .output_json
        .map(|value| cipher.open(&value))
        .transpose()?
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(HarnessRun {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        id: row.id,
        session_id: row.session_id,
        status: HarnessRunStatus::from_str(&row.status),
        attempt: u32::try_from(row.attempt.max(0)).unwrap_or(u32::MAX),
        idempotency_key: row.idempotency_key,
        parent_run_id: row.parent_run_id,
        execution_profile: parse_execution_profile(&row.execution_profile),
        event_cursor: u64::try_from(row.event_seq.max(0)).unwrap_or(u64::MAX),
        created_at: millis_to_rfc3339(row.created_at),
        started_at: row.started_at.map(millis_to_rfc3339),
        finished_at: row.finished_at.map(millis_to_rfc3339),
        // Sealed since phase 2; legacy plaintext passes through.
        error: row.error.map(|value| cipher.open(&value)).transpose()?,
        output,
        multitask_strategy: row
            .multitask_strategy
            .as_deref()
            .map(MultitaskStrategy::from_str),
    })
}

pub(super) fn insert_harness_event(
    tx: &rusqlite::Transaction<'_>,
    cipher: &ryu_crypto::FieldCipher,
    envelope: &RunEventEnvelope,
) -> Result<()> {
    tx.execute(
        "INSERT INTO harness_run_events (id, run_id, seq, created_at, event_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            envelope.id,
            envelope.run_id,
            i64::try_from(envelope.seq).unwrap_or(i64::MAX),
            rfc3339_to_millis(&envelope.created_at),
            cipher.seal(&serde_json::to_string(envelope)?)?,
        ],
    )?;
    Ok(())
}

pub(super) fn build_harness_event(
    run_id: &str,
    session_id: &str,
    seq: u64,
    now: i64,
    event: RunEvent,
) -> RunEventEnvelope {
    RunEventEnvelope {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        id: format!("evt_{}", uuid::Uuid::new_v4().simple()),
        run_id: run_id.to_owned(),
        session_id: session_id.to_owned(),
        seq,
        created_at: millis_to_rfc3339(now),
        event,
    }
}

pub(super) fn harness_message_count(input: &serde_json::Value) -> u32 {
    let count = if let Some(messages) = input.get("messages").and_then(serde_json::Value::as_array)
    {
        messages.len()
    } else if let Some(messages) = input.as_array() {
        messages.len()
    } else if input.get("prompt").is_some() {
        1
    } else {
        0
    };
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Whether a stored harness input is the request `input` again. Compared as
/// parsed JSON rather than as serialized text: Core serializes objects in their
/// insertion order, so a retry whose object keys arrive in another order, or a
/// row stored in the first caller's key order, must not read as a different
/// request and fail the idempotent retry.
pub(super) fn same_harness_input(stored: &str, input: &serde_json::Value) -> bool {
    serde_json::from_str::<serde_json::Value>(stored).is_ok_and(|stored| stored == *input)
}

/// Whether a stored execution profile is `profile`, compared as the parsed
/// profile. An unreadable stored profile never matches.
pub(super) fn same_execution_profile(stored: &str, profile: &ExecutionProfile) -> bool {
    serde_json::from_str::<ExecutionProfile>(stored).is_ok_and(|stored| stored == *profile)
}

pub(super) fn parse_execution_profile(raw: &str) -> ExecutionProfile {
    serde_json::from_str(raw).unwrap_or_else(|error| {
        tracing::warn!(error = %error, "invalid stored harness execution profile; using safe defaults");
        ExecutionProfile::default()
    })
}

pub(super) fn harness_status_from_legacy(status: &SessionStatus) -> HarnessRunStatus {
    match status {
        SessionStatus::Idle => HarnessRunStatus::Pending,
        SessionStatus::Running => HarnessRunStatus::Running,
        SessionStatus::Completed => HarnessRunStatus::Completed,
        SessionStatus::Failed => HarnessRunStatus::Failed,
    }
}

pub(super) fn millis_to_rfc3339(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub(super) fn rfc3339_to_millis(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .unwrap_or_else(|_| now_millis())
}

/// Parse a stored `runnable_kind` string back to a [`RunnableKind`].
/// Unknown strings default to `Agent` (the most common kind in practice).
pub(super) fn parse_runnable_kind(s: &str) -> RunnableKind {
    match s {
        "workflow" => RunnableKind::Workflow,
        "tool" => RunnableKind::Tool,
        "skill" => RunnableKind::Skill,
        _ => RunnableKind::Agent,
    }
}
