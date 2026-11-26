//! Who may see an operation, what the stream sends, and how the service fails.

use serde::Serialize;

use super::record::OperationRecord;

/// The caller as the service sees it. An operation is visible to the user who
/// started it and to a caller with node management rights; cancel and retry
/// follow the same rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewer {
    pub user_id: Option<String>,
    /// Whether the caller holds `nodes.manage` (always true on a personal node
    /// that is not bound to an organization).
    pub manager: bool,
}

impl Viewer {
    /// A caller with node management rights.
    pub fn manager(user_id: Option<String>) -> Self {
        Self {
            user_id,
            manager: true,
        }
    }

    /// A signed-in member without node management rights.
    pub fn member(user_id: impl Into<String>) -> Self {
        Self {
            user_id: Some(user_id.into()),
            manager: false,
        }
    }

    /// Whether this caller may see, cancel and retry an operation owned by
    /// `owner`. An operation with no owner (an anonymous local start) is for
    /// managers only.
    pub fn can_see(&self, owner: Option<&str>) -> bool {
        if self.manager {
            return true;
        }
        matches!((owner, self.user_id.as_deref()), (Some(owner), Some(user)) if owner == user)
    }
}

/// One frame of `GET /api/operations/stream`: a snapshot on connect, then
/// changes. The same shape as the downloads stream.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OperationEvent {
    Snapshot {
        operations: Vec<OperationRecord>,
    },
    Update {
        operation: OperationRecord,
    },
    Removed {
        id: String,
        /// Not sent; decides who hears about the removal.
        #[serde(skip)]
        owner_user_id: Option<String>,
    },
}

impl OperationEvent {
    /// The event as `viewer` may receive it, or `None` when it is about an
    /// operation the viewer may not see.
    pub fn visible_to(self, viewer: &Viewer) -> Option<Self> {
        match self {
            Self::Snapshot { operations } => Some(Self::Snapshot {
                operations: operations
                    .into_iter()
                    .filter(|operation| viewer.can_see(operation.owner_user_id.as_deref()))
                    .collect(),
            }),
            Self::Update { operation } => viewer
                .can_see(operation.owner_user_id.as_deref())
                .then_some(Self::Update { operation }),
            Self::Removed { id, owner_user_id } => viewer
                .can_see(owner_user_id.as_deref())
                .then_some(Self::Removed { id, owner_user_id }),
        }
    }
}

/// Why the service refused a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationError {
    /// No such operation, or the caller may not see it.
    NotFound,
    /// No runner is registered for the kind.
    UnknownKind(String),
    /// The idempotency key is empty, too long, or has characters outside
    /// `A-Z a-z 0-9 _ - . :`.
    InvalidIdempotencyKey,
    /// The idempotency key was already used with a different input.
    IdempotencyConflict,
    /// Retry applies to failed, cancelled and interrupted operations only.
    NotRetryable,
    /// The record could not be read or written.
    Store(String),
}

impl OperationError {
    /// A stable machine code for API responses.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "operation_not_found",
            Self::UnknownKind(_) => "operation_kind_unknown",
            Self::InvalidIdempotencyKey => "operation_idempotency_key_invalid",
            Self::IdempotencyConflict => "operation_idempotency_conflict",
            Self::NotRetryable => "operation_not_retryable",
            Self::Store(_) => "operation_store_failed",
        }
    }
}

impl std::fmt::Display for OperationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "Operation not found"),
            Self::UnknownKind(kind) => {
                write!(f, "No runner is registered for operation kind {kind:?}")
            }
            Self::InvalidIdempotencyKey => write!(
                f,
                "idempotencyKey must be 1 to 128 characters from A-Z, a-z, 0-9, _, -, . and :"
            ),
            Self::IdempotencyConflict => {
                write!(
                    f,
                    "The idempotency key was already used for a different request"
                )
            }
            Self::NotRetryable => write!(
                f,
                "Only a failed, cancelled or interrupted operation can be retried"
            ),
            Self::Store(message) => write!(f, "The operation could not be saved: {message}"),
        }
    }
}

impl std::error::Error for OperationError {}

/// Whether `key` is an acceptable idempotency key.
pub fn valid_idempotency_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

#[cfg(test)]
mod tests {
    use super::super::record::OperationStatus;
    use super::super::test_support::sample;
    use super::*;

    #[test]
    fn an_operation_is_visible_to_its_owner_and_to_managers_only() {
        let owner = Viewer::member("user-1");
        let other = Viewer::member("user-2");
        let manager = Viewer::manager(Some("admin".to_owned()));
        let anonymous = Viewer {
            user_id: None,
            manager: false,
        };

        assert!(owner.can_see(Some("user-1")));
        assert!(!other.can_see(Some("user-1")));
        assert!(manager.can_see(Some("user-1")));
        assert!(!anonymous.can_see(Some("user-1")));

        // An operation nobody owns is for managers only, also for an
        // anonymous caller without rights.
        assert!(!owner.can_see(None));
        assert!(!anonymous.can_see(None));
        assert!(manager.can_see(None));
        assert!(Viewer::manager(None).can_see(None));
    }

    #[test]
    fn events_about_another_users_operation_are_dropped() {
        let mine = sample("op_mine", OperationStatus::Running);
        let mut theirs = sample("op_theirs", OperationStatus::Running);
        theirs.owner_user_id = Some("user-2".to_owned());
        let viewer = Viewer::member("user-1");

        let snapshot = OperationEvent::Snapshot {
            operations: vec![mine.clone(), theirs.clone()],
        }
        .visible_to(&viewer)
        .expect("a snapshot is always sent");
        let OperationEvent::Snapshot { operations } = snapshot else {
            panic!("expected a snapshot");
        };
        assert_eq!(operations, vec![mine.clone()]);

        assert!(OperationEvent::Update { operation: mine }
            .visible_to(&viewer)
            .is_some());
        assert!(OperationEvent::Update { operation: theirs }
            .visible_to(&viewer)
            .is_none());
        let removed = OperationEvent::Removed {
            id: "op_theirs".to_owned(),
            owner_user_id: Some("user-2".to_owned()),
        };
        assert!(removed.clone().visible_to(&viewer).is_none());
        assert!(removed.visible_to(&Viewer::manager(None)).is_some());
    }

    #[test]
    fn frames_are_tagged_and_a_removal_does_not_name_the_owner() {
        let update = serde_json::to_value(OperationEvent::Update {
            operation: sample("op_1", OperationStatus::Queued).summary(),
        })
        .unwrap();
        assert_eq!(update["type"], "update");
        assert_eq!(update["operation"]["id"], "op_1");

        let removed = serde_json::to_value(OperationEvent::Removed {
            id: "op_1".to_owned(),
            owner_user_id: Some("user-1".to_owned()),
        })
        .unwrap();
        assert_eq!(
            removed,
            serde_json::json!({ "type": "removed", "id": "op_1" })
        );

        let snapshot =
            serde_json::to_value(OperationEvent::Snapshot { operations: vec![] }).unwrap();
        assert_eq!(
            snapshot,
            serde_json::json!({ "type": "snapshot", "operations": [] })
        );
    }

    #[test]
    fn idempotency_keys_are_short_and_plain() {
        assert!(valid_idempotency_key("import-2026-11-18T10:00:00.000Z_a1"));
        assert!(!valid_idempotency_key(""));
        assert!(!valid_idempotency_key(&"k".repeat(129)));
        assert!(valid_idempotency_key(&"k".repeat(128)));
        assert!(!valid_idempotency_key("has space"));
        assert!(!valid_idempotency_key("slash/key"));
    }

    #[test]
    fn every_error_has_its_own_code() {
        let errors = [
            OperationError::NotFound,
            OperationError::UnknownKind("x".to_owned()),
            OperationError::InvalidIdempotencyKey,
            OperationError::IdempotencyConflict,
            OperationError::NotRetryable,
            OperationError::Store("disk".to_owned()),
        ];
        let codes: std::collections::BTreeSet<&str> =
            errors.iter().map(OperationError::code).collect();
        assert_eq!(codes.len(), errors.len());
        assert!(OperationError::Store("disk".to_owned())
            .to_string()
            .contains("disk"));
    }
}
