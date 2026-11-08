//! Reviewable memory-revision proposal types (dream review).

use serde::{Deserialize, Serialize};

use crate::types::default_importance;
use crate::{MemoryCategory, MemoryMetadata, MemoryScope, NewMemory};

/// The only mutations a dream may propose. `Revise` is applied as a new row that
/// supersedes the target, never as an in-place edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalOperation {
    Create,
    Revise,
}

impl MemoryProposalOperation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Revise => "revise",
        }
    }

    pub(crate) fn from_str(value: &str) -> Self {
        match value {
            "revise" => Self::Revise,
            _ => Self::Create,
        }
    }
}

/// Review state for an encrypted revision proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalStatus {
    #[default]
    Pending,
    Applied,
    Rejected,
    RolledBack,
}

impl MemoryProposalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::RolledBack => "rolled_back",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "applied" => Self::Applied,
            "rejected" => Self::Rejected,
            "rolled_back" => Self::RolledBack,
            _ => Self::Pending,
        }
    }
}

/// The proposed memory body held inside an encrypted proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryProposalDraft {
    pub content: String,
    #[serde(default)]
    pub scope: MemoryScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default)]
    pub category: MemoryCategory,
    #[serde(default = "default_importance")]
    pub importance: i32,
    #[serde(default)]
    pub when_to_use: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub author_agent_id: Option<String>,
    #[serde(default)]
    pub metadata: MemoryMetadata,
    /// The cited source messages, each with a short excerpt, so a reviewer can
    /// see the evidence. Held only in the encrypted proposal payload: accepting
    /// the proposal does not copy the excerpts into the memory it writes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<MemoryProposalSource>,
}

/// One chat message a proposal cites, with a bounded excerpt of its text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProposalSource {
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub excerpt: String,
}

impl MemoryProposalDraft {
    pub fn into_new_memory(self) -> NewMemory {
        NewMemory {
            content: self.content,
            scope: self.scope,
            scope_id: self.scope_id,
            category: self.category,
            importance: self.importance,
            when_to_use: self.when_to_use,
            tags: self.tags,
            author_agent_id: self.author_agent_id,
        }
    }
}

/// Input for creating a reviewable proposal.
#[derive(Debug, Clone)]
pub struct NewMemoryProposal {
    pub owner_user_id: String,
    pub agent_id: String,
    pub target_memory_id: Option<String>,
    pub operation: MemoryProposalOperation,
    pub draft: MemoryProposalDraft,
    pub rationale: String,
}

/// A decrypted, reviewable proposal returned by the Core API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRevisionProposal {
    pub id: String,
    pub owner_user_id: String,
    pub agent_id: String,
    pub target_memory_id: Option<String>,
    pub operation: MemoryProposalOperation,
    pub status: MemoryProposalStatus,
    pub draft: MemoryProposalDraft,
    pub rationale: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_memory_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MemoryProposalFilter {
    pub status: Option<MemoryProposalStatus>,
    pub limit: Option<usize>,
}
