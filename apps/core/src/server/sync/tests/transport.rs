//! The HTTP client against local test servers, and the SSE frame parser.

use super::*;
use crate::server::sync::client::{parse_change_frame, take_sse_frame};

#[derive(Debug, Deserialize)]
struct PullQuery {
    cursor: Option<String>,
}

#[derive(Clone, Copy)]
enum SnapshotFault {
    Missing,
    Changed,
}

async fn start_snapshot_fault_server(
    path: &'static str,
    resource: &'static str,
    fault: SnapshotFault,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        path,
        get(move |Query(query): Query<PullQuery>| async move {
            let continuation = query.cursor.is_some();
            let next_cursor = (!continuation).then_some("page-2");
            let snapshot_at = if !continuation {
                Some(1000)
            } else {
                match fault {
                    SnapshotFault::Missing => None,
                    SnapshotFault::Changed => Some(1001),
                }
            };
            let mut value = if resource == "documents" {
                serde_json::json!({
                    "documents": [],
                    "nextCursor": next_cursor,
                })
            } else {
                serde_json::json!({
                    "conversations": [],
                    "nextCursor": next_cursor,
                })
            };
            if let Some(snapshot_at) = snapshot_at {
                value["snapshotAt"] = serde_json::json!(snapshot_at);
            }
            axum::Json(value)
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), server)
}

/// The SSE change-feed parser concatenates multiple `data:` lines with `\n` (SSE
/// spec), strips a single leading space, tolerates CRLF, and ignores the leading
/// comment + `event:` line. A pretty-printed payload split one physical line per
/// `data:` is the realistic multi-line frame (each break is JSON whitespace).
#[test]
fn parse_change_frame_concatenates_multiline_data() {
    let payload = sample_payload("conv-sse");
    let pretty = serde_json::to_string_pretty(&payload).unwrap();
    assert!(
        pretty.lines().count() > 1,
        "pretty JSON must span many lines"
    );
    let mut frame = String::from(": keepalive comment\r\nevent: change\r\n");
    for line in pretty.lines() {
        frame.push_str("data: ");
        frame.push_str(line);
        frame.push_str("\r\n");
    }
    let parsed = parse_change_frame(&frame).expect("multi-line data frame must decode");
    assert_eq!(parsed.conversation_id, "conv-sse");
    assert_eq!(parsed.owner_user_id.as_deref(), Some("bob"));
    assert_eq!(parsed.messages.len(), 1);

    // The single-line form (whole JSON on one `data:`) is equally valid.
    let one = format!("data: {}\n", serde_json::to_string(&payload).unwrap());
    assert_eq!(
        parse_change_frame(&one).unwrap().conversation_id,
        "conv-sse"
    );
}

#[test]
fn parse_change_frame_ignores_keepalives_and_bad_json() {
    // A comment-only keepalive frame carries no `data:` → None (not an error).
    assert!(parse_change_frame(": ping\n").is_none());
    assert!(parse_change_frame("event: heartbeat\n").is_none());
    assert!(parse_change_frame("").is_none());
    // A `data:` line that is not a valid payload decodes to None, never panics.
    assert!(parse_change_frame("data: {\"not\":\"a payload\"}\n").is_none());
    assert!(parse_change_frame("data: not json at all\n").is_none());
}

#[test]
fn sse_frame_buffer_preserves_unicode_split_across_chunks() {
    let mut payload = sample_payload("conv-unicode");
    payload.messages[0].content = "hello 🌍".to_owned();
    let frame = format!(
        "event: conversation\ndata: {}\n\n",
        serde_json::to_string(&payload).unwrap()
    );
    let bytes = frame.as_bytes();

    // Exercise every possible two-chunk boundary, including boundaries in
    // the middle of the UTF-8 encoding for the globe emoji.
    for split in 0..=bytes.len() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&bytes[..split]);
        if split < bytes.len() {
            assert!(
                take_sse_frame(&mut buffer).is_none(),
                "a partial frame must remain buffered at split {split}"
            );
        }
        buffer.extend_from_slice(&bytes[split..]);
        let complete = take_sse_frame(&mut buffer).expect("complete frame");
        let parsed = parse_change_frame_bytes(&complete).expect("valid payload");
        assert_eq!(parsed.messages[0].content, "hello 🌍");
        assert!(buffer.is_empty());
    }

    let mut crlf = b"event: conversation\r\ndata: ".to_vec();
    crlf.extend_from_slice(serde_json::to_string(&payload).unwrap().as_bytes());
    crlf.extend_from_slice(b"\r\n\r\n");
    let complete = take_sse_frame(&mut crlf).expect("CRLF frame");
    assert_eq!(
        parse_change_frame_bytes(&complete).unwrap().conversation_id,
        "conv-unicode"
    );
}

#[tokio::test]
async fn pull_drains_all_bounded_pages_with_equal_server_timestamps() {
    let payloads: Arc<Vec<SyncPayload>> = Arc::new(
        (0..=1000)
            .map(|index| SyncPayload {
                conversation_id: format!("paged-{index:04}"),
                title: Some(format!("row-{index}")),
                agent_id: None,
                folder_path: None,
                branch: None,
                worktree_path: None,
                run_status: None,
                owner_user_id: None,
                created_at: 1,
                updated_at: 1,
                messages: Vec::new(),
            })
            .collect(),
    );
    let app = Router::new().route(
        "/api/conversations-sync/pull",
        get({
            let payloads = Arc::clone(&payloads);
            move |Query(query): Query<PullQuery>| {
                let payloads = Arc::clone(&payloads);
                async move {
                    let (conversations, next_cursor) = if query.cursor.as_deref() == Some("page-2")
                    {
                        (payloads[1000..].to_vec(), None)
                    } else {
                        (payloads[..1000].to_vec(), Some("page-2"))
                    };
                    axum::Json(serde_json::json!({
                        "conversations": conversations,
                        "nextCursor": next_cursor,
                        "snapshotAt": 1000,
                    }))
                }
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let store = ConversationStore::open_in_memory().unwrap();
    let client = SyncClient::new(format!("http://{address}"), "test-token");
    let applied = client
        .pull_since(&store, 0, Tenancy::Unattributed)
        .await
        .unwrap();

    server.abort();
    let _ = server.await;
    assert_eq!(applied, 1001);
    assert_eq!(store.list_conversations().await.unwrap().len(), 1001);
}

#[tokio::test]
async fn pull_rejects_a_non_advancing_server_cursor() {
    let app = Router::new().route(
        "/api/conversations-sync/pull",
        get(|| async {
            axum::Json(serde_json::json!({
                "conversations": [],
                "nextCursor": "same-page",
                "snapshotAt": 1000,
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let store = ConversationStore::open_in_memory().unwrap();
    let client = SyncClient::new(format!("http://{address}"), "test-token");
    let result = client.pull_since(&store, 0, Tenancy::Unattributed).await;

    server.abort();
    let _ = server.await;
    assert!(matches!(
        result,
        Err(SyncError::ServerError(502, ref message))
            if message.contains("non-advancing cursor")
    ));
}

#[tokio::test]
async fn pull_reports_storage_apply_failures_instead_of_advancing() {
    let payload = DocumentSyncPayload {
        document_id: "bad-file".to_owned(),
        title: "Bad file".to_owned(),
        source: "bytes".to_owned(),
        kind: "file".to_owned(),
        parent_id: None,
        icon: None,
        created_at: 1,
        updated_at: 1,
        revision: 0,
        owner_user_id: None,
        space: ryu_spaces::SpaceSyncRecord {
            id: "space".to_owned(),
            name: "Space".to_owned(),
            description: None,
            created_at: 1,
            updated_at: 1,
            retrieval_mode: "hybrid".to_owned(),
            visibility: "private".to_owned(),
            team_id: None,
        },
    };
    let app = Router::new().route(
        "/api/documents-sync/pull",
        get(move || {
            let payload = payload.clone();
            async move {
                axum::Json(serde_json::json!({
                    "documents": [payload],
                    "nextCursor": null,
                    "snapshotAt": 1000,
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let store = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let client = SyncClient::new(format!("http://{address}"), "test-token");
    let result = client
        .pull_documents_since(&store, 0, Tenancy::Unattributed)
        .await;

    server.abort();
    let _ = server.await;
    assert!(matches!(result, Err(SyncError::Store(_))));
}

#[tokio::test]
async fn conversation_pull_rejects_missing_or_changed_continuation_snapshot() {
    for fault in [SnapshotFault::Missing, SnapshotFault::Changed] {
        let (url, server) =
            start_snapshot_fault_server("/api/conversations-sync/pull", "conversations", fault)
                .await;
        let store = ConversationStore::open_in_memory().unwrap();
        let result = SyncClient::new(url, "test-token")
            .pull_since(&store, 0, Tenancy::Unattributed)
            .await;
        server.abort();
        let _ = server.await;
        let expected = match fault {
            SnapshotFault::Missing => "omitted snapshotAt",
            SnapshotFault::Changed => "changed snapshot",
        };
        assert!(matches!(
            result,
            Err(SyncError::ServerError(502, ref message))
                if message.contains(expected)
        ));
    }
}

#[tokio::test]
async fn document_pull_rejects_missing_or_changed_continuation_snapshot() {
    for fault in [SnapshotFault::Missing, SnapshotFault::Changed] {
        let (url, server) =
            start_snapshot_fault_server("/api/documents-sync/pull", "documents", fault).await;
        let store = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
        let result = SyncClient::new(url, "test-token")
            .pull_documents_since(&store, 0, Tenancy::Unattributed)
            .await;
        server.abort();
        let _ = server.await;
        let expected = match fault {
            SnapshotFault::Missing => "omitted snapshotAt",
            SnapshotFault::Changed => "changed snapshot",
        };
        assert!(matches!(
            result,
            Err(SyncError::ServerError(502, ref message))
                if message.contains(expected)
        ));
    }
}

#[tokio::test]
async fn stream_rejects_an_incomplete_final_frame_for_pull_reconciliation() {
    let payload = sample_payload("stream-partial");
    let complete = format!(
        "event: conversation\ndata: {}\n\n",
        serde_json::to_string(&payload).unwrap()
    );
    let body = format!("{complete}data: {{\"conversation_id\":\"partial");
    let app = Router::new().route(
        "/api/conversations-sync/stream",
        get(move || {
            let body = body.clone();
            async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .header("x-ryu-sync-snapshot-at", "1000")
                    .body(Body::from(body))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let store = ConversationStore::open_in_memory().unwrap();
    let client = SyncClient::new(format!("http://{address}"), "test-token");
    let result = client
        .stream_changes(&store, 0, Tenancy::Unattributed)
        .await;

    server.abort();
    let _ = server.await;
    assert!(matches!(
        result,
        Err(SyncError::ServerError(502, ref message))
            if message.contains("incomplete or invalid SSE frame")
    ));
    assert_eq!(
        store
            .get_conversation_detail("stream-partial")
            .await
            .unwrap()
            .map(|detail| detail.id),
        Some("stream-partial".to_owned())
    );
}
