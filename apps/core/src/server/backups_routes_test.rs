//! Backup destination routes against a loopback S3 protocol fixture (the same
//! shape as `crates/core/backup/tests/s3_roundtrip.rs`): a destination is only
//! saved after a real signed write/read/list/delete probe, its credentials are
//! never echoed, a failing provider is reported as a 400 without persisting
//! anything, and every route is gated on `nodes.manage`.
//!
//! The backup service is the process-global one under this test binary's data
//! dir, so each test uses a bucket prefix unique to it and removes what it adds.
use super::*;
use crate::identity_verify::OrgRole;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request};
use axum::routing::any;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const SECRET: &str = "fixture-secret-access-key-value";

#[derive(Clone, Default)]
struct S3Fixture {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// While set, every request is refused like a bucket without permissions.
    refuse: Arc<AtomicBool>,
}

fn object_response(bytes: Vec<u8>) -> Response {
    (
        [
            ("etag", "\"test-etag\""),
            ("last-modified", "Mon, 07 Sep 2026 00:00:00 GMT"),
            ("content-type", "application/octet-stream"),
        ],
        bytes,
    )
        .into_response()
}

async fn s3_object(
    State(fixture): State<S3Fixture>,
    Path((_bucket, key)): Path<(String, String)>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if fixture.refuse.load(Ordering::SeqCst) || !headers.contains_key("authorization") {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut objects = fixture.objects.lock().unwrap();
    match method.as_str() {
        "PUT" => {
            objects.insert(key, body.to_vec());
            object_response(Vec::new())
        }
        "DELETE" => {
            objects.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => match objects.get(&key) {
            Some(bytes) => object_response(bytes.clone()),
            None => StatusCode::NOT_FOUND.into_response(),
        },
    }
}

async fn s3_list(
    State(fixture): State<S3Fixture>,
    Query(query): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if fixture.refuse.load(Ordering::SeqCst) || !headers.contains_key("authorization") {
        return StatusCode::FORBIDDEN.into_response();
    }
    let prefix = query.get("prefix").map(String::as_str).unwrap_or_default();
    let rows: String = fixture
        .objects
        .lock()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.starts_with(prefix))
        .map(|(key, value)| {
            format!(
                "<Contents><Key>{key}</Key><LastModified>2026-09-07T00:00:00.000Z</LastModified>\
                 <ETag>\"test-etag\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                value.len()
            )
        })
        .collect();
    format!(
        "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
         <IsTruncated>false</IsTruncated>{rows}</ListBucketResult>"
    )
    .into_response()
}

/// Serve the fixture on an ephemeral loopback port; returns its endpoint.
async fn serve(fixture: S3Fixture) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/:bucket", any(s3_list))
        .route("/:bucket/*key", any(s3_object))
        .with_state(fixture);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), server)
}

fn destination_body(endpoint: &str, prefix: &str) -> Value {
    json!({
        "name": "Fixture",
        "endpoint": endpoint,
        "bucket": "backup-bucket",
        "region": "auto",
        "prefix": prefix,
        "pathStyle": true,
        "allowHttp": true,
        "accessKeyId": "fixture-access-key-id",
        "secretAccessKey": SECRET,
        "recoveryKey": ryu_backup::encryption::new_key(),
    })
}

async fn send(
    caller: Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, String) {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = router()
        .layer(axum::Extension(caller))
        .with_state(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

async fn destinations_with_prefix(prefix: &str) -> Vec<BackupDestination> {
    global()
        .await
        .unwrap()
        .destinations()
        .await
        .into_iter()
        .filter(|destination| destination.prefix == prefix)
        .collect()
}

#[tokio::test]
async fn a_destination_persists_after_a_passing_probe_and_never_echoes_credentials() {
    with_test_node_binding(false, None, async {
        let fixture = S3Fixture::default();
        let (endpoint, server) = serve(fixture.clone()).await;
        let prefix = format!("ryu/{}", uuid::Uuid::new_v4().simple());

        let (status, created) = send(
            None,
            "POST",
            "/api/backups/destinations",
            Some(destination_body(&endpoint, &prefix)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert!(!created.contains(SECRET), "{created}");
        assert!(!created.contains("fixture-access-key-id"), "{created}");
        let id = json_of(&created)["id"].as_str().unwrap().to_owned();
        // The connection probe cleaned up after itself.
        assert!(fixture.objects.lock().unwrap().is_empty());

        // Listed by the overview (without credentials) and durable on disk.
        let (status, overview) = send(None, "GET", "/api/backups", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(overview.contains(&id), "{overview}");
        assert!(!overview.contains(SECRET));
        let reopened = crate::backups::BackupService::open(crate::paths::ryu_dir()).unwrap();
        let persisted: Vec<_> = reopened
            .destinations()
            .await
            .into_iter()
            .filter(|destination| destination.id == id)
            .collect();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].prefix, prefix);
        assert_eq!(persisted[0].endpoint, endpoint);

        // The saved (sealed) credentials drive the test and catalog routes.
        let (status, tested) = send(
            None,
            "POST",
            &format!("/api/backups/destinations/{id}/test"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{tested}");
        assert_eq!(json_of(&tested), json!({ "ok": true }));
        let (status, listed) = send(
            None,
            "GET",
            &format!("/api/backups/destinations/{id}/backups?scope=node"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(json_of(&listed), json!([]));

        // A provider that starts refusing is reported, not thrown.
        fixture.refuse.store(true, Ordering::SeqCst);
        let (status, failed) = send(
            None,
            "POST",
            &format!("/api/backups/destinations/{id}/test"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{failed}");
        let failed = json_of(&failed);
        assert_eq!(failed["code"], "backup_request_failed");
        assert!(failed["error"]
            .as_str()
            .unwrap()
            .starts_with("S3 connection test failed"));
        fixture.refuse.store(false, Ordering::SeqCst);

        // Moving the catalog is refused; the saved destination is unchanged.
        let (status, moved) = send(
            None,
            "PUT",
            &format!("/api/backups/destinations/{id}"),
            Some(destination_body(&endpoint, "elsewhere/prefix")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{moved}");
        assert_eq!(destinations_with_prefix(&prefix).await.len(), 1);

        let (status, _) = send(
            None,
            "DELETE",
            &format!("/api/backups/destinations/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(destinations_with_prefix(&prefix).await.is_empty());
        server.abort();
    })
    .await;
}

#[tokio::test]
async fn a_failing_probe_or_unknown_destination_is_a_clean_400() {
    with_test_node_binding(false, None, async {
        let fixture = S3Fixture::default();
        fixture.refuse.store(true, Ordering::SeqCst);
        let (endpoint, server) = serve(fixture).await;
        let prefix = format!("ryu/{}", uuid::Uuid::new_v4().simple());

        let (status, refused) = send(
            None,
            "POST",
            "/api/backups/destinations",
            Some(destination_body(&endpoint, &prefix)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert!(!refused.contains(SECRET), "{refused}");
        let refused = json_of(&refused);
        assert_eq!(refused["code"], "backup_request_failed");
        assert!(refused["error"]
            .as_str()
            .unwrap()
            .starts_with("S3 connection validation failed"));
        assert!(destinations_with_prefix(&prefix).await.is_empty());

        let unknown = uuid::Uuid::new_v4();
        for (method, uri) in [
            ("POST", format!("/api/backups/destinations/{unknown}/test")),
            (
                "GET",
                format!("/api/backups/destinations/{unknown}/backups"),
            ),
            ("DELETE", format!("/api/backups/destinations/{unknown}")),
        ] {
            let (status, body) = send(None, method, &uri, None).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}: {body}");
            assert!(
                json_of(&body)["error"]
                    .as_str()
                    .unwrap()
                    .contains("not found"),
                "{body}"
            );
        }
        server.abort();
    })
    .await;
}

#[tokio::test]
async fn every_destination_route_requires_node_management() {
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org-b".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-b".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    with_test_node_binding(false, Some(node), async {
        let fixture = S3Fixture::default();
        let (endpoint, server) = serve(fixture.clone()).await;
        let prefix = format!("ryu/{}", uuid::Uuid::new_v4().simple());
        let member = Some(VerifiedCaller {
            user_id: "member".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-b".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        });
        let id = uuid::Uuid::new_v4();
        for (method, uri, body) in [
            ("GET", "/api/backups".to_owned(), None),
            (
                "POST",
                "/api/backups/destinations".to_owned(),
                Some(destination_body(&endpoint, &prefix)),
            ),
            (
                "PUT",
                format!("/api/backups/destinations/{id}"),
                Some(destination_body(&endpoint, &prefix)),
            ),
            ("DELETE", format!("/api/backups/destinations/{id}"), None),
            ("POST", format!("/api/backups/destinations/{id}/test"), None),
            (
                "GET",
                format!("/api/backups/destinations/{id}/backups"),
                None,
            ),
            ("POST", "/api/backups/recovery-key".to_owned(), None),
        ] {
            let (status, text) = send(member.clone(), method, &uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
            assert_eq!(json_of(&text)["code"], "backup_permission_denied");
        }
        // The refused create never reached the provider or the store.
        assert!(fixture.objects.lock().unwrap().is_empty());
        assert!(destinations_with_prefix(&prefix).await.is_empty());
        server.abort();
    })
    .await;
}
