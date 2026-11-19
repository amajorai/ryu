use super::*;
use crate::server::vault_api::tests::{ctx, parts};

#[tokio::test]
async fn bulk_items_run_independently_with_one_audit_row_each() {
    let ctx = ctx(None, None, true, Vec::new());
    let body: BulkBody = serde_json::from_value(json!({ "items": [
        { "op": "set", "name": "A", "value": "1" },
        { "op": "set", "name": "B", "value": "2", "path": "/x" },
        { "op": "set", "name": "not a name", "value": "3" },
        { "op": "move", "name": "A", "toPath": "/y" },
        { "op": "delete", "name": "B", "path": "/x" },
        { "op": "rename", "name": "A" },
        { "value": "no op" },
    ]}))
    .unwrap();
    let (status, text) = parts(bulk_with(&ctx, body).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let report: Value = serde_json::from_str(&text).unwrap();
    let statuses: Vec<u64> = report["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| result["status"].as_u64().unwrap())
        .collect();
    assert_eq!(statuses, vec![200, 200, 400, 200, 200, 400, 400], "{text}");
    assert_eq!(report["ok"], false);
    assert_eq!(report["failed"], 3);
    assert_eq!(report["results"][3]["result"]["secret"]["path"], "/y");
    assert!(report["results"][2]["error"]
        .as_str()
        .unwrap()
        .contains("vault_invalid_request"));

    let conn = ctx.store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    let count = |action: &str| rows.iter().filter(|row| row.action == action).count();
    assert_eq!(count("secret.create"), 2);
    assert_eq!(count("secret.move"), 1);
    assert_eq!(count("secret.delete"), 1);
}

#[tokio::test]
async fn bulk_refuses_an_empty_or_oversized_request() {
    let ctx = ctx(None, None, true, Vec::new());
    let empty = BulkBody { items: Vec::new() };
    assert_eq!(
        parts(bulk_with(&ctx, empty).await).await.0,
        StatusCode::BAD_REQUEST
    );
    let many = BulkBody {
        items: vec![json!({ "op": "delete", "name": "A" }); MAX_BULK_ITEMS + 1],
    };
    assert_eq!(
        parts(bulk_with(&ctx, many).await).await.0,
        StatusCode::BAD_REQUEST
    );
}
