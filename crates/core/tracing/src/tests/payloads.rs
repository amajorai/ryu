use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use rusqlite::{params, Connection};

use super::*;

/// Reversible stand-in for a host cipher: hex under a `sealed:` prefix, bound
/// to the purpose and row id like the real one.
struct TestSealer;

impl ContentSealer for TestSealer {
    fn seal(&self, plaintext: &str, purpose: &str, id: &str) -> Result<String> {
        let hex: String = plaintext
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(format!("sealed:{purpose}:{id}:{hex}"))
    }

    fn open(&self, stored: &str, purpose: &str, id: &str) -> Result<String> {
        let Some(hex) = stored.strip_prefix(&format!("sealed:{purpose}:{id}:")) else {
            if self.is_sealed(stored) {
                anyhow::bail!("sealed value bound to another row or column");
            }
            return Ok(stored.to_owned());
        };
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(String::from_utf8(bytes)?)
    }

    fn is_sealed(&self, stored: &str) -> bool {
        stored.starts_with("sealed:")
    }
}

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-tracing-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("traces.db")
}

fn raw_payloads(path: &std::path::Path, id: &str) -> (Option<String>, Option<String>) {
    let conn = Connection::open(path).unwrap();
    conn.query_row(
        "SELECT input, output FROM spans WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[tokio::test]
async fn captured_payloads_are_sealed_on_disk_and_read_back() {
    let path = temp_db("sealed");
    let store = TraceStore::open(path.clone()).unwrap();
    store.set_content_policy(ContentPolicy::capture(4096));
    store.set_content_sealer(Arc::new(TestSealer));
    let span = store
        .start_span(
            SpanStart::new("conv-s", SpanKind::ModelCall, "m")
                .input(serde_json::json!("prompt-marker")),
        )
        .await
        .unwrap();
    store
        .end_span(
            &span.id,
            SpanEnd::ok().output(serde_json::json!({"text": "completion-marker"})),
        )
        .await
        .unwrap();
    let (input, output) = raw_payloads(&path, &span.id);
    for stored in [input.unwrap(), output.unwrap()] {
        assert!(stored.starts_with("sealed:"));
        assert!(!stored.contains("marker"));
    }
    let stored = store.get_span(&span.id).await.unwrap().unwrap();
    assert_eq!(stored.input, Some(serde_json::json!("prompt-marker")));
    assert_eq!(
        stored.output,
        Some(serde_json::json!({"text": "completion-marker"}))
    );
    let spans = store.get_spans("conv-s").await.unwrap();
    assert_eq!(spans[0].input, Some(serde_json::json!("prompt-marker")));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn without_a_sealer_no_payload_is_persisted() {
    let path = temp_db("no-sealer");
    let store = TraceStore::open(path.clone()).unwrap();
    store.set_content_policy(ContentPolicy::capture(4096));
    let span = store
        .start_span(
            SpanStart::new("conv-n", SpanKind::ModelCall, "m")
                .input(serde_json::json!("prompt-marker")),
        )
        .await
        .unwrap();
    store
        .end_span(&span.id, SpanEnd::ok().output(serde_json::json!("reply")))
        .await
        .unwrap();
    assert_eq!(raw_payloads(&path, &span.id), (None, None));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn turning_capture_off_clears_stored_payloads() {
    let path = temp_db("capture-off");
    let store = TraceStore::open(path.clone()).unwrap();
    store.set_content_policy(ContentPolicy::capture(4096));
    store.set_content_sealer(Arc::new(TestSealer));
    let span = store
        .start_span(
            SpanStart::new("conv-o", SpanKind::ModelCall, "m")
                .input(serde_json::json!("prompt-marker")),
        )
        .await
        .unwrap();
    store.end_span(&span.id, SpanEnd::ok()).await.unwrap();
    assert!(raw_payloads(&path, &span.id).0.is_some());

    store.set_content_policy(ContentPolicy::metadata_only());
    store
        .start_span(SpanStart::new("conv-o", SpanKind::ToolCall, "t"))
        .await
        .unwrap();
    assert_eq!(raw_payloads(&path, &span.id), (None, None));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn legacy_plaintext_payloads_are_sealed_by_the_boot_pass() {
    let path = temp_db("legacy");
    let store = TraceStore::open(path.clone()).unwrap();
    let span = store
        .start_span(SpanStart::new("conv-l", SpanKind::ModelCall, "m"))
        .await
        .unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE spans SET input = '\"legacy-marker\"' WHERE id = ?1",
            params![span.id],
        )
        .unwrap();
    }
    store.set_content_policy(ContentPolicy::capture(4096));
    store.set_content_sealer(Arc::new(TestSealer));
    assert_eq!(store.seal_stored_payloads().await.unwrap(), 1);
    let (input, _) = raw_payloads(&path, &span.id);
    assert!(input.unwrap().starts_with("sealed:"));
    assert_eq!(
        store.get_span(&span.id).await.unwrap().unwrap().input,
        Some(serde_json::json!("legacy-marker"))
    );
    assert_eq!(store.seal_stored_payloads().await.unwrap(), 0);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn content_is_dropped_unless_policy_captures() {
    let store = TraceStore::open_in_memory().unwrap();
    let span = store
        .start_span(
            SpanStart::new("conv-c", SpanKind::ModelCall, "m").input(serde_json::json!("prompt")),
        )
        .await
        .unwrap();
    store
        .end_span(&span.id, SpanEnd::ok().output(serde_json::json!("reply")))
        .await
        .unwrap();
    let stored = store.get_span(&span.id).await.unwrap().unwrap();
    assert!(stored.input.is_none() && stored.output.is_none());

    store.set_content_policy(ContentPolicy::capture(1024));
    store.set_content_sealer(Arc::new(TestSealer));
    assert!(store.captures_content());
    let span = store
        .start_span(
            SpanStart::new("conv-c", SpanKind::ModelCall, "m").input(serde_json::json!("prompt")),
        )
        .await
        .unwrap();
    store
        .end_span(
            &span.id,
            SpanEnd::ok().output(serde_json::json!({"text": "reply"})),
        )
        .await
        .unwrap();
    let stored = store.get_span(&span.id).await.unwrap().unwrap();
    assert_eq!(stored.input, Some(serde_json::json!("prompt")));
    assert_eq!(stored.output, Some(serde_json::json!({"text": "reply"})));

    fn live() -> ContentPolicy {
        ContentPolicy::metadata_only()
    }
    store.set_content_policy_source(live);
    assert!(!store.captures_content());
}
