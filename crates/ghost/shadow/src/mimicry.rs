//! Behavioral search and workflow extraction.

use super::*;

/// MARK: - Behavioral Search (Mimicry Phase A)

/// Search for past interaction sequences matching an app and query.
/// Returns sequences of user actions (clicks, keystrokes) with AX context,
/// grouped by temporal proximity. Used to inject behavioral memory into the agent prompt.
pub fn search_behavioral_context(
    query: String,
    target_app: String,
    max_results: u32,
) -> Result<Vec<behavioral::BehavioralSequence>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    behavioral::search_behavioral_context(&index.conn, &query, &target_app, max_results).map_err(
        |e| ShadowError::QueryError {
            msg: format!("Behavioral search failed: {e}"),
        },
    )
}

/// Count AX-enriched mouse_down events in a time range.
/// Used by diagnostics to track how much enriched data has been collected.
pub fn count_enriched_clicks(start_us: u64, end_us: u64) -> Result<u64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    behavioral::count_enriched_clicks(&index.conn, start_us, end_us).map_err(|e| {
        ShadowError::QueryError {
            msg: format!("Count query failed: {e}"),
        }
    })
}

/// Find the most frequently interacted AX elements for an app.
/// Returns (role, title, count) tuples. Used for building app interaction profiles.
pub fn top_app_interactions(
    app_name: String,
    limit: u32,
) -> Result<Vec<behavioral::InteractionSummary>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    behavioral::top_interactions(&index.conn, &app_name, limit)
        .map(|tuples| {
            tuples
                .into_iter()
                .map(|(role, title, count)| behavioral::InteractionSummary {
                    ax_role: role,
                    ax_title: title,
                    count,
                })
                .collect()
        })
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Top interactions query failed: {e}"),
        })
}

/// MARK: - Workflow Extraction (Mimicry Phase A4)

/// Extract recurring workflow patterns from passively recorded user behavior.
/// Scans enriched events within the lookback window and finds action sequences
/// that repeat across sessions. Returns AX-anchored workflows sorted by confidence.
pub fn extract_workflows(
    lookback_hours: u32,
    max_results: u32,
) -> Result<Vec<workflow_extractor::ExtractedWorkflow>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    workflow_extractor::extract_workflows(&index.conn, lookback_hours, max_results).map_err(|e| {
        ShadowError::QueryError {
            msg: format!("Workflow extraction failed: {e}"),
        }
    })
}

/// Extract recurring workflow patterns for a specific app.
pub fn extract_workflows_for_app(
    app_name: String,
    lookback_hours: u32,
    max_results: u32,
) -> Result<Vec<workflow_extractor::ExtractedWorkflow>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    workflow_extractor::extract_workflows_for_app(
        &index.conn,
        &app_name,
        lookback_hours,
        max_results,
    )
    .map_err(|e| ShadowError::QueryError {
        msg: format!("App workflow extraction failed: {e}"),
    })
}
