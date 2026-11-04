//! Model selection history and context-handoff records.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// A durable provider/model selection change made in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConversationModelChangeKind {
    Initial,
    Change,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelChange {
    /// Database ordering key. Monotonic within one conversation.
    pub sequence: i64,
    pub id: String,
    pub kind: ConversationModelChangeKind,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    /// Derived from Core's verified caller identity, never the request body.
    pub changed_by: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// Validated input to the append-only provider/model selection history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationModelSelectionInput {
    pub id: String,
    pub kind: ConversationModelChangeKind,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub changed_by: Option<String>,
}

impl ConversationModelChangeKind {
    pub(super) fn as_db_value(&self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Change => "change",
        }
    }
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelSelectionState {
    pub current: Option<ConversationModelChange>,
    pub changes: Vec<ConversationModelChange>,
    /// Context handoffs that carried a summary across a model change. Rendered
    /// as markers in the transcript beside the model-change notices.
    pub handoffs: Vec<ConversationContextHandoff>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelSelectionWriteResult {
    pub change: ConversationModelChange,
    pub changed: bool,
}

pub(super) fn read_conversation_model_change(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ConversationModelChange> {
    let raw_kind = row.get::<_, String>(2)?;
    let kind = match raw_kind.as_str() {
        "initial" => ConversationModelChangeKind::Initial,
        "change" => ConversationModelChangeKind::Change,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unknown conversation model-selection kind",
                )),
            ));
        }
    };
    Ok(ConversationModelChange {
        sequence: row.get(0)?,
        id: row.get(1)?,
        kind,
        provider_id: row.get(3)?,
        provider_label: row.get(4)?,
        model_id: row.get(5)?,
        model_label: row.get(6)?,
        changed_by: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// Whether a model-change handoff carried a summary or was evaluated and found
/// unnecessary (the earlier history already fits the new model).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ContextHandoffOutcome {
    Applied,
    NotNeeded,
}

impl ContextHandoffOutcome {
    pub(super) fn as_db_value(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NotNeeded => "not_needed",
        }
    }
}

/// The durable marker left in a conversation when switching models handed the
/// earlier history off as a summary. One row per model change and branch of the
/// history before it, so the summary is produced once per branch and replayed
/// byte-identically on every later turn on that branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextHandoff {
    pub id: String,
    /// The `conversation_model_changes.id` this handoff belongs to.
    pub model_change_id: String,
    /// Id of the last message the summary covers on its branch; empty when no
    /// history preceded the change. Editing or branching from a message before
    /// the switch gives the active thread a different head, so it gets its own
    /// handoff instead of a summary of a thread the user left.
    pub covered_head_id: String,
    pub outcome: ContextHandoffOutcome,
    /// Which policy rule fired: `smaller-context`, `different-provider`, `always`.
    pub reason: String,
    pub from_model: Option<String>,
    pub to_model: Option<String>,
    /// Context windows (tokens) of the previous and new model, when known.
    pub from_context: Option<i64>,
    pub to_context: Option<i64>,
    /// How many earlier messages the summary replaces.
    pub summarized_count: i64,
    /// Unix milliseconds: messages created before this are the summarized ones.
    pub boundary_at: i64,
    /// The carried summary. `None` when the outcome is `notNeeded`.
    pub summary: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

pub(super) const CONTEXT_HANDOFF_COLUMNS: &str =
    "id, model_change_id, outcome, reason, from_model, to_model,
     from_context, to_context, summarized_count, boundary_at, summary, created_at, covered_head_id";

/// Per-conversation tables whose `ON DELETE CASCADE` is inert (FK enforcement
/// is off; deletes are manual), so every conversation delete path clears them.
pub(super) const CONVERSATION_SCOPED_HISTORY_TABLES: [&str; 5] = [
    "conversation_context_handoffs",
    "conversation_model_changes",
    "conversation_title_history",
    "agent_controls",
    "run_auto_resume",
];

/// Read one handoff row. `summary` is still sealed here; the store opens it.
pub(super) fn read_context_handoff_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ConversationContextHandoff> {
    let raw_outcome = row.get::<_, String>(2)?;
    let outcome = match raw_outcome.as_str() {
        "applied" => ContextHandoffOutcome::Applied,
        "not_needed" => ContextHandoffOutcome::NotNeeded,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unknown context handoff outcome",
                )),
            ));
        }
    };
    Ok(ConversationContextHandoff {
        id: row.get(0)?,
        model_change_id: row.get(1)?,
        outcome,
        reason: row.get(3)?,
        from_model: row.get(4)?,
        to_model: row.get(5)?,
        from_context: row.get(6)?,
        to_context: row.get(7)?,
        summarized_count: row.get(8)?,
        boundary_at: row.get(9)?,
        summary: row.get(10)?,
        created_at: row.get(11)?,
        covered_head_id: row.get(12)?,
    })
}
