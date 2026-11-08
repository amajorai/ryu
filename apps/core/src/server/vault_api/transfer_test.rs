//! `POST /api/vault/export` with an organization project (P1-15): a project
//! is all-or-nothing, so an export that names one fails closed when its
//! values cannot be fetched instead of silently leaving them out.

use super::tests::{ctx, parts};
use super::transfer::{export_with, shared_export_request, ExportBody};
use super::*;

fn body(value: Value) -> ExportBody {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn an_export_naming_a_project_fails_closed_without_the_control_plane() {
    // No registered node and no signed-in caller: shared values are off.
    let local = ctx(None, None, true, Vec::new());
    let (status, text) = parts(
        export_with(
            &local,
            body(json!({ "format": "json", "projectId": "proj-1" })),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{text}");
    assert!(text.contains("vault_project_unavailable"), "{text}");

    let (status, text) = parts(
        export_with(
            &local,
            body(json!({ "format": "json", "projectId": "has space" })),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");

    // Without a project the same node still exports its own values.
    let (status, text) = parts(export_with(&local, body(json!({ "format": "json" }))).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
}

#[test]
fn the_control_plane_request_names_only_a_valid_project() {
    let plain = shared_export_request("dev", "/", None).unwrap();
    assert_eq!(plain, json!({ "environment": "dev", "path": "/" }));
    assert_eq!(
        shared_export_request("dev", "/", Some("  ")).unwrap(),
        plain
    );
    assert_eq!(
        shared_export_request("dev", "/api", Some(" proj-1 ")).unwrap()["projectId"],
        "proj-1"
    );
    assert!(shared_export_request("dev", "/", Some("has space")).is_err());
}
