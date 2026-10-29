//! A local S3 protocol fixture exercises the real signed/multipart client. No
//! production credentials, network services or optional skipped tests required.
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use ryu_backup::{encryption, s3::S3BackupStore, BackupDestination, BackupRecord, BackupScope};

#[derive(Clone, Default)]
struct S3Fixture {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    parts: Arc<Mutex<BTreeMap<u32, Vec<u8>>>>,
    signed: Arc<Mutex<usize>>,
}

fn response(bytes: Vec<u8>) -> Response {
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

async fn object(
    State(state): State<S3Fixture>,
    Path((_bucket, key)): Path<(String, String)>,
    Query(query): Query<BTreeMap<String, String>>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !authorization.starts_with("AWS4-HMAC-SHA256 ") {
        return StatusCode::FORBIDDEN.into_response();
    }
    *state.signed.lock().unwrap() += 1;
    if method == "POST" && query.contains_key("uploads") {
        state.parts.lock().unwrap().clear();
        return format!("<InitiateMultipartUploadResult><Bucket>backup-bucket</Bucket><Key>{key}</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>").into_response();
    }
    if method == "PUT" {
        if let Some(number) = query.get("partNumber") {
            state
                .parts
                .lock()
                .unwrap()
                .insert(number.parse().unwrap(), body.to_vec());
        } else {
            state.objects.lock().unwrap().insert(key, body.to_vec());
        }
        return response(vec![]);
    }
    if method == "POST" && query.contains_key("uploadId") {
        let joined = state
            .parts
            .lock()
            .unwrap()
            .values()
            .flatten()
            .copied()
            .collect();
        state.objects.lock().unwrap().insert(key.clone(), joined);
        return format!("<CompleteMultipartUploadResult><Location>local</Location><Bucket>backup-bucket</Bucket><Key>{key}</Key><ETag>\"test-etag\"</ETag></CompleteMultipartUploadResult>").into_response();
    }
    if method == "DELETE" {
        state.objects.lock().unwrap().remove(&key);
        return StatusCode::NO_CONTENT.into_response();
    }
    match state.objects.lock().unwrap().get(&key) {
        Some(bytes) => response(bytes.clone()),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn list(
    State(state): State<S3Fixture>,
    Query(query): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !headers.contains_key("authorization") {
        return StatusCode::FORBIDDEN.into_response();
    }
    let prefix = query.get("prefix").map(String::as_str).unwrap_or_default();
    let rows = state.objects.lock().unwrap().iter().filter(|(key, _)| key.starts_with(prefix)).map(|(key, value)| format!("<Contents><Key>{key}</Key><LastModified>2026-09-07T00:00:00.000Z</LastModified><ETag>\"test-etag\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>", value.len())).collect::<String>();
    format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><IsTruncated>false</IsTruncated>{rows}</ListBucketResult>").into_response()
}

#[tokio::test]
async fn signed_multipart_upload_catalog_discovery_download_and_delete() {
    let fixture = S3Fixture::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/:bucket", any(list))
        .route("/:bucket/*key", any(object))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(fixture.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let destination = BackupDestination {
        id: "destination".into(),
        name: "Test".into(),
        endpoint: format!("http://{address}"),
        bucket: "backup-bucket".into(),
        region: "auto".into(),
        prefix: "team/backups".into(),
        path_style: true,
        allow_http: true,
        allowed_apps: vec![],
        created_at: "2026-09-07T00:00:00Z".into(),
    };
    let s3 = S3BackupStore::new(&destination, "test-access", "test-secret", None, [7; 32]).unwrap();
    // Regression: listing a full probe key adds '/' and never finds the object.
    s3.test().await.unwrap();
    assert!(fixture.objects.lock().unwrap().is_empty());
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("large.bin");
    let content = vec![19u8; 10 * 1024 * 1024];
    std::fs::write(&input, &content).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut record = BackupRecord {
        version: 1,
        id: id.clone(),
        source_node_id: "source-node".into(),
        scope: BackupScope::Node,
        created_at: "2026-09-07T00:00:00Z".into(),
        bytes: content.len() as u64,
        sha256: encryption::sha256(content.as_slice()).unwrap(),
        object_key: s3.object_key(&id).unwrap(),
    };
    // New uploads must use the scope-isolated namespace. Legacy flat paths
    // remain readable, but cannot publish new backups into the flat catalog.
    let flat_upload = s3.upload(&input, &record).await.unwrap_err();
    assert!(flat_upload
        .to_string()
        .contains("Invalid backup object key"));
    assert!(fixture.objects.lock().unwrap().is_empty());
    assert!(fixture.parts.lock().unwrap().is_empty());
    record.object_key = s3.scoped_object_key(&id, &record.scope).unwrap();
    s3.upload(&input, &record).await.unwrap();
    assert!(fixture.parts.lock().unwrap().len() >= 2);
    let catalog = s3.list(Some(&BackupScope::Node)).await.unwrap();
    assert_eq!(catalog.len(), 1);
    let fresh =
        S3BackupStore::new(&destination, "test-access", "test-secret", None, [7; 32]).unwrap();
    let recovered = fresh.record(&id).await.unwrap();
    let output = directory.path().join("download");
    fresh.download(&recovered, &output).await.unwrap();
    assert_eq!(std::fs::read(output).unwrap(), content);
    assert!(
        S3BackupStore::new(&destination, "test-access", "test-secret", None, [8; 32])
            .unwrap()
            .list(None)
            .await
            .is_err()
    );
    s3.delete(&record).await.unwrap();
    assert!(s3.list(None).await.unwrap().is_empty());
    assert!(*fixture.signed.lock().unwrap() >= 8);
    server.abort();
}
