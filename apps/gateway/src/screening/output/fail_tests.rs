//! Output fail rules: a stream window a healthy screener left undecided ends
//! the stream with the 503 error frame, exactly as the buffered response is
//! refused, and a node that fails closed refuses the same way.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use ryu_gw_screening::backends::test::TestBackend;
use ryu_gw_screening::{estimate_tokens, BackendError};
use serde_json::json;

use super::stream::guard_stream;
use super::{screen_buffered, unavailable_frame};
use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::screening::admit::fixture::{
    ctx, floor, probe, runtime, screener, screening_config, state,
};
use crate::state::AppState;

fn sse(texts: &[&str]) -> Body {
    let mut frames: Vec<Result<bytes::Bytes, std::io::Error>> = texts
        .iter()
        .map(|text| {
            let chunk = json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
            Ok(bytes::Bytes::from(format!("data: {chunk}\n\n")))
        })
        .collect();
    frames.push(Ok(bytes::Bytes::from("data: [DONE]\n\n")));
    Body::from_stream(futures_util::stream::iter(frames))
}

async fn streamed(state: &Arc<AppState>, request_id: &str, body: Body) -> String {
    let out = guard_stream(body, Arc::clone(state), ctx(request_id), None);
    let bytes = to_bytes(out, usize::MAX).await.expect("stream reads");
    String::from_utf8_lossy(&bytes).into_owned()
}

fn fleet(backend: &Arc<TestBackend>) -> Arc<AppState> {
    state(
        GatewayCustody::Fleet,
        runtime(&Default::default(), std::slice::from_ref(backend)),
        Some(floor(screener(json!({})))),
        Default::default(),
    )
}

/// `stream: true` is no way around the floor's output fail rule: the window
/// the screener could not classify ends the stream, with no `[DONE]`.
#[tokio::test]
async fn an_undecided_floor_stream_window_ends_the_stream() {
    let backend = Arc::new(
        TestBackend::new("decision_local").fail_on("DERAILMARKER", BackendError::Malformed),
    );
    let state = fleet(&backend);
    probe(&state).await;
    let filler = "lorem ipsum dolor sit amet ".repeat(80);
    let raw = streamed(
        &state,
        "stream-derail",
        sse(&["DERAILMARKER ", &filler, &filler]),
    )
    .await;
    assert!(raw.contains("output_screener_incomplete"), "{raw}");
    assert!(raw.contains("screening_unavailable"));
    assert!(!raw.contains("[DONE]"), "{raw}");

    let clean = streamed(&state, "stream-clean", sse(&[&filler, &filler])).await;
    assert!(clean.contains("[DONE]"), "{clean}");
    assert!(!clean.contains("screening_unavailable"));
}

/// A dense burst larger than the backend reads is classified in pieces it
/// fits: every character reaches the backend and the stream finishes.
#[tokio::test]
async fn a_dense_stream_burst_is_read_whole_in_pieces() {
    let backend = Arc::new(TestBackend::new("decision_local").max_item_tokens(1_024));
    let state = fleet(&backend);
    let burst = "\u{754c}".repeat(20_000);
    let raw = streamed(&state, "stream-cjk", sse(&[&burst])).await;
    assert!(
        raw.contains("[DONE]"),
        "{}",
        &raw[raw.len().saturating_sub(400)..]
    );
    assert!(!raw.contains("screening_unavailable"));
    let seen = backend.seen();
    assert!(seen.iter().all(|text| estimate_tokens(text) <= 1_024));
    let read: usize = seen.iter().map(|text| text.chars().count()).sum();
    assert!(
        read >= 20_000,
        "only {read} of 20000 characters were screened"
    );
}

fn node(fail_mode: &str) -> Arc<AppState> {
    let config = screening_config(&format!("node_classifiers = true\n{fail_mode}"));
    let backend = Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Malformed));
    state(
        GatewayCustody::SelfHosted,
        runtime(&config, std::slice::from_ref(&backend)),
        None,
        config,
    )
}

/// A node that fails closed (the default) withholds output its screener
/// could not classify; `degraded` forwards it marked.
#[tokio::test]
async fn a_node_withholds_unclassified_output_unless_it_opts_out() {
    let closed = node("");
    let result = screen_buffered(&closed, &ctx("node-out-closed"), "model reply", None).await;
    assert!(
        matches!(
            result,
            Err(GatewayError::ScreeningUnavailable {
                reason: "output_screener_incomplete",
                ..
            })
        ),
        "{result:?}"
    );
    let raw = streamed(&closed, "node-stream-closed", sse(&["model reply"])).await;
    assert!(raw.contains("output_screener_incomplete"), "{raw}");
    assert!(!raw.contains("[DONE]"));

    let degraded = node("node_fail_mode = \"degraded\"");
    let result = screen_buffered(&degraded, &ctx("node-out-degraded"), "model reply", None).await;
    assert!(result.is_ok(), "{result:?}");
    let raw = streamed(&degraded, "node-stream-degraded", sse(&["model reply"])).await;
    assert!(raw.contains("[DONE]"), "{raw}");
}

#[test]
fn the_unavailable_frame_carries_the_buffered_error_shape() {
    let frame = unavailable_frame(ryu_gw_screening::ScreenTier::Floor);
    let text = String::from_utf8_lossy(&frame);
    let payload: serde_json::Value =
        serde_json::from_str(text.trim().trim_start_matches("data:").trim()).expect("json");
    assert_eq!(payload["error"]["code"], "screening_unavailable");
    assert_eq!(payload["error"]["type"], "service_unavailable");
    assert_eq!(payload["error"]["layer"], "platform");
    assert_eq!(payload["error"]["retry_after"], 2);
}
