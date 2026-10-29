//! AX snapshots, procedures, semantic knowledge, and directives.

use super::*;

// MARK: - AX Snapshots (Agent System Phase 1)

/// Insert an AX tree snapshot record into the timeline index.
pub fn insert_ax_snapshot(
    timestamp_us: u64,
    app_bundle_id: String,
    app_name: String,
    window_title: Option<String>,
    display_id: Option<u32>,
    tree_hash: u64,
    node_count: u32,
    trigger: Option<String>,
) -> Result<i64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .insert_ax_snapshot(
            timestamp_us,
            &app_bundle_id,
            &app_name,
            window_title.as_deref(),
            display_id,
            tree_hash,
            node_count,
            trigger.as_deref(),
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to insert AX snapshot: {e}"),
        })
}

/// Find an AX snapshot by approximate timestamp.
pub fn find_ax_snapshot(
    timestamp_us: u64,
) -> Result<Option<timeline::AxSnapshotRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .find_ax_snapshot(timestamp_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to find AX snapshot: {e}"),
        })
}

/// Query AX snapshots for an app within a time range.
pub fn query_ax_snapshots(
    app_bundle_id: Option<String>,
    start_ts: u64,
    end_ts: u64,
    limit: u32,
) -> Result<Vec<timeline::AxSnapshotRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .query_ax_snapshots(app_bundle_id.as_deref(), start_ts, end_ts, limit)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to query AX snapshots: {e}"),
        })
}

// MARK: - Procedure CRUD (Phase 3)

/// Insert or replace a procedure record in the SQLite index.
pub fn insert_procedure(
    id: String,
    name: String,
    description: String,
    source_app: String,
    source_bundle_id: String,
    step_count: u32,
    parameter_count: u32,
    tags: String,
    created_at: u64,
    updated_at: u64,
) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .insert_procedure(
            &id,
            &name,
            &description,
            &source_app,
            &source_bundle_id,
            step_count,
            parameter_count,
            &tags,
            created_at,
            updated_at,
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to insert procedure: {e}"),
        })
}

/// Query procedures, optionally filtering by source app.
pub fn query_procedures(
    source_app: Option<String>,
    limit: u32,
) -> Result<Vec<timeline::ProcedureRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .query_procedures(source_app.as_deref(), limit)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to query procedures: {e}"),
        })
}

/// Delete a procedure by ID.
pub fn delete_procedure(id: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .delete_procedure(&id)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to delete procedure: {e}"),
        })
}

// --- Semantic Knowledge UniFFI Exports (Phase 5) ---

/// Insert or replace a semantic knowledge record.
pub fn upsert_semantic_knowledge(
    id: String,
    category: String,
    key: String,
    value: String,
    confidence: f64,
    source_episode_ids: String,
    created_at: u64,
    updated_at: u64,
) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .upsert_semantic_knowledge(
            &id,
            &category,
            &key,
            &value,
            confidence,
            &source_episode_ids,
            created_at,
            updated_at,
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to upsert semantic knowledge: {e}"),
        })
}

/// Query semantic knowledge, optionally filtered by category.
pub fn query_semantic_knowledge(
    category: Option<String>,
    limit: u32,
) -> Result<Vec<timeline::SemanticKnowledgeRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .query_semantic_knowledge(category.as_deref(), limit)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to query semantic knowledge: {e}"),
        })
}

/// Record an access to a semantic knowledge record (increments access_count).
pub fn touch_semantic_knowledge(id: String, now_us: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .touch_semantic_knowledge(&id, now_us)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to touch semantic knowledge: {e}"),
        })
}

/// Delete a semantic knowledge record by ID.
pub fn delete_semantic_knowledge(id: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .delete_semantic_knowledge(&id)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to delete semantic knowledge: {e}"),
        })
}

// --- Directive UniFFI Exports (Phase 5) ---

/// Insert or replace a directive.
pub fn upsert_directive(
    id: String,
    directive_type: String,
    trigger_pattern: String,
    action_description: String,
    priority: i32,
    created_at: u64,
    expires_at: Option<u64>,
    source_context: String,
) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .upsert_directive(
            &id,
            &directive_type,
            &trigger_pattern,
            &action_description,
            priority,
            created_at,
            expires_at,
            &source_context,
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to upsert directive: {e}"),
        })
}

/// Query active directives (non-expired, is_active=1).
pub fn query_active_directives(
    now_us: u64,
    limit: u32,
) -> Result<Vec<timeline::DirectiveRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .query_active_directives(now_us, limit)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to query active directives: {e}"),
        })
}

/// Record that a directive was triggered.
pub fn record_directive_trigger(id: String, now_us: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .record_directive_trigger(&id, now_us)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to record directive trigger: {e}"),
        })
}

/// Deactivate a directive (set is_active=0).
pub fn deactivate_directive(id: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .deactivate_directive(&id)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to deactivate directive: {e}"),
        })
}

/// Delete a directive by ID.
pub fn delete_directive(id: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .delete_directive(&id)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to delete directive: {e}"),
        })
}
