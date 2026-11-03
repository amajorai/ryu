//! Stream line framing: the window screener reads the text the client gets,
//! whatever the chunk boundaries. A multi-byte character split across two
//! chunks is screened as itself, and a last line with no newline is screened
//! before the stream ends.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use ryu_gw_screening::backends::test::{TestBackend, SENTINEL_HAZARD_S9};
use serde_json::json;

use super::guard_stream;
use crate::custody::GatewayCustody;
use crate::screening::admit::fixture::{ctx, floor, runtime, screener, state};
use crate::state::AppState;

fn fleet(backend: &Arc<TestBackend>) -> Arc<AppState> {
    state(
        GatewayCustody::Fleet,
        runtime(&Default::default(), std::slice::from_ref(backend)),
        Some(floor(screener(json!({})))),
        Default::default(),
    )
}

fn frame(text: &str) -> Vec<u8> {
    let chunk = json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
    format!("data: {chunk}\n\n").into_bytes()
}

async fn streamed(state: &Arc<AppState>, request_id: &str, chunks: Vec<Vec<u8>>) -> String {
    let parts: Vec<Result<bytes::Bytes, std::io::Error>> = chunks
        .into_iter()
        .map(|chunk| Ok(bytes::Bytes::from(chunk)))
        .collect();
    let body = Body::from_stream(futures_util::stream::iter(parts));
    let out = guard_stream(body, Arc::clone(state), ctx(request_id), None);
    let bytes = to_bytes(out, usize::MAX).await.expect("stream reads");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn a_character_split_across_chunks_is_screened_whole() {
    let backend = Arc::new(TestBackend::new("decision_local"));
    let state = fleet(&backend);
    let mut bytes = frame("caf\u{e9} \u{1F600} ordered");
    bytes.extend_from_slice(b"data: [DONE]\n\n");
    // Cut inside the two bytes of `é`, then inside the emoji.
    let first = bytes.iter().position(|b| *b == 0xC3).expect("é") + 1;
    let second = bytes.iter().position(|b| *b == 0xF0).expect("emoji") + 2;
    let chunks = vec![
        bytes[..first].to_vec(),
        bytes[first..second].to_vec(),
        bytes[second..].to_vec(),
    ];
    let raw = streamed(&state, "stream-utf8", chunks).await;
    assert!(raw.contains("[DONE]"), "{raw}");
    let seen = backend.seen().join("\n");
    assert!(seen.contains("caf\u{e9} \u{1F600} ordered"), "{seen:?}");
    assert!(!seen.contains('\u{FFFD}'), "{seen:?}");
}

#[tokio::test]
async fn a_last_line_without_a_newline_is_screened() {
    let backend = Arc::new(TestBackend::new("decision_local"));
    let state = fleet(&backend);
    let mut tail = frame(&format!("{SENTINEL_HAZARD_S9} tail"));
    // The upstream ends mid-frame: no blank line, no newline, no `[DONE]`.
    tail.truncate(tail.len() - 2);
    let chunks = vec![frame("an ordinary start "), tail];
    streamed(&state, "stream-tail", chunks).await;
    let seen = backend.seen().join("\n");
    assert!(seen.contains(SENTINEL_HAZARD_S9), "{seen:?}");
}
