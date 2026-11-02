use super::{running_conversation_count, running_workflow_count};

#[test]
fn quit_guard_counts_only_active_conversations() {
    let payload = serde_json::json!({
        "runs": [
            { "run_status": "running" },
            { "run_status": "completed" },
            { "run_status": "awaiting_input" },
            { "run_status": null }
        ]
    });

    assert_eq!(running_conversation_count(&payload), 1);
}

#[test]
fn quit_guard_reads_workflow_running_count() {
    assert_eq!(
        running_workflow_count(&serde_json::json!({
            "running": 3,
            "awaiting_input": 2
        })),
        3
    );
    assert_eq!(running_workflow_count(&serde_json::json!({})), 0);
}
