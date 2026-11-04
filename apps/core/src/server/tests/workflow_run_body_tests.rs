use crate::server::RunWorkflowBody;

#[test]
fn accepts_camel_case_dry_run_and_legacy_snake_case_alias() {
    let camel: RunWorkflowBody = serde_json::from_value(serde_json::json!({
        "input": { "text": "hello" },
        "runId": "ignored",
        "dryRun": true
    }))
    .expect("camel-case request body should parse");
    assert!(camel.dry_run);
    assert_eq!(camel.run_id.as_deref(), Some("ignored"));

    let legacy: RunWorkflowBody = serde_json::from_value(serde_json::json!({
        "dry_run": true,
        "run_id": "legacy"
    }))
    .expect("legacy snake-case aliases should remain readable");
    assert!(legacy.dry_run);
    assert_eq!(legacy.run_id.as_deref(), Some("legacy"));
}
