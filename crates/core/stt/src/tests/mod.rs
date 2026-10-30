//! Unit tests for the crate root (split by engine to stay within the file-size
//! limits): parsing + selection here, then [`whisper`] and [`gateway`].

use serde_json::json;

use super::*;
use crate::http_engines::{gateway_multipart_fields, parse_audio_cpp_segments};

mod gateway;
mod whisper;

#[test]
fn transcription_config_emits_typed_and_safe_raw_multipart_fields() {
    let config = TranscriptionConfig {
        language: Some("fr".to_owned()),
        translate: Some(true),
        temperature: Some(0.25),
        extra: BTreeMap::from([
            ("vad".to_owned(), "true".to_owned()),
            ("file".to_owned(), "override.wav".to_owned()),
            ("model".to_owned(), "other-model".to_owned()),
        ]),
        ..Default::default()
    };
    let fields = config.multipart_fields();
    assert!(fields.contains(&("language".to_owned(), "fr".to_owned())));
    assert!(fields.contains(&("translate".to_owned(), "true".to_owned())));
    assert!(fields.contains(&("temperature".to_owned(), "0.25".to_owned())));
    assert!(fields.contains(&("vad".to_owned(), "true".to_owned())));
    assert!(!fields
        .iter()
        .any(|(key, _)| key == "file" || key == "model"));
}

#[test]
fn measured_words_are_normalized_without_guessing_timing() {
    let body = serde_json::json!({"segments":[{"words":[{"word":" Hello ","start":0.1,"end":0.42},{"word":"invalid","start":1.0,"end":0.5},{"word":"untimed"}]}]});
    let words = parse_verbose_words(&body);
    assert_eq!(words.len(), 1);
    assert_eq!(words[0].text, "Hello");
    assert_eq!((words[0].start_ms, words[0].end_ms), (100, 420));
    assert!(parse_verbose_words(&serde_json::json!({"text":"Hello"})).is_empty());
    let top =
        parse_verbose_words(&serde_json::json!({"words":[{"word":"world","start":0.5,"end":0.8}]}));
    assert_eq!(top[0].text, "world");
}

#[test]
fn parses_verbose_segments_seconds_to_ms() {
    let body = json!({
        "text": "hello world",
        "segments": [
            { "start": 0.0, "end": 1.5, "text": " hello" },
            { "start": 1.5, "end": 2.25, "text": " world " },
        ]
    });
    let segs = parse_verbose_segments(&body);
    assert_eq!(segs.len(), 2);
    assert_eq!(segs[0].start_ms, 0);
    assert_eq!(segs[0].end_ms, 1500);
    assert_eq!(segs[0].text, "hello");
    assert_eq!(segs[1].start_ms, 1500);
    assert_eq!(segs[1].end_ms, 2250);
    assert_eq!(segs[1].text, "world");
}

#[test]
fn missing_or_malformed_segments_yield_empty() {
    assert!(parse_verbose_segments(&json!({ "text": "x" })).is_empty());
    assert!(parse_verbose_segments(&json!({ "segments": "not-an-array" })).is_empty());
    // An entry missing start/end is skipped, not an error.
    let partial = json!({ "segments": [ { "text": "no timings" } ] });
    assert!(parse_verbose_segments(&partial).is_empty());
}

#[test]
fn default_engine_env_override_wins() {
    // Save/restore to avoid leaking into other tests in the same process.
    let prev = std::env::var("RYU_STT_ENGINE").ok();
    std::env::set_var("RYU_STT_ENGINE", "gateway");
    assert_eq!(default_stt_engine(), "gateway");
    std::env::set_var("RYU_STT_ENGINE", "   ");
    // Blank falls through to the compiled default (parakeet or whisper).
    let compiled = default_stt_engine();
    assert!(compiled == "parakeet" || compiled == "whisper");
    match prev {
        Some(v) => std::env::set_var("RYU_STT_ENGINE", v),
        None => std::env::remove_var("RYU_STT_ENGINE"),
    }
}

#[test]
fn resolve_stt_engine_accepts_known_ids_and_refuses_typos() {
    for engine in STT_ENGINES {
        assert_eq!(resolve_stt_engine(Some(engine)).unwrap(), *engine);
    }
    assert_eq!(resolve_stt_engine(Some("  whisper ")).unwrap(), "whisper");
    let error = resolve_stt_engine(Some("whsiper")).unwrap_err();
    assert!(error.contains("unknown STT engine 'whsiper'"), "{error}");
    assert!(
        error.contains("parakeet, whisper, audiocpp, gateway"),
        "{error}"
    );
}

#[tokio::test]
async fn unknown_engine_errors_instead_of_routing_to_whisper() {
    struct NoHost;
    impl SttHost for NoHost {
        fn whisper_base_url(&self) -> String {
            panic!("an unknown engine must not reach whisper.cpp")
        }
        fn audio_cpp_base_url(&self) -> String {
            panic!("an unknown engine must not reach audio.cpp")
        }
        fn gateway_url(&self) -> String {
            panic!("an unknown engine must not reach the Gateway")
        }
        fn gateway_bearer(&self) -> Result<String, String> {
            Err("unused".into())
        }
        fn parakeet_model_dir(&self) -> PathBuf {
            PathBuf::new()
        }
    }
    let error = transcribe_wav_detailed(
        &reqwest::Client::new(),
        &NoHost,
        vec![0; 8],
        "a.wav".into(),
        Some("parakeat"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("unknown STT engine 'parakeat'"), "{error}");
}

#[test]
fn transcript_segment_serializes_camel_case() {
    let seg = TranscriptSegment {
        start_ms: 10,
        end_ms: 20,
        text: "hi".into(),
    };
    let v = serde_json::to_value(&seg).unwrap();
    assert_eq!(v["startMs"], 10);
    assert_eq!(v["endMs"], 20);
    assert_eq!(v["text"], "hi");
}

// ── negative / clamp edge cases for the parser ────────────────────────────

#[test]
fn verbose_segments_clamp_negative_timestamps_to_zero() {
    // A defensive engine could emit a negative offset; the parser clamps to 0
    // rather than underflowing the u64 cast.
    let body = json!({
        "segments": [ { "start": -1.0, "end": -0.5, "text": "  neg  " } ]
    });
    let segs = parse_verbose_segments(&body);
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].start_ms, 0);
    assert_eq!(segs[0].end_ms, 0);
    assert_eq!(segs[0].text, "neg");
}

#[test]
fn verbose_segment_missing_text_defaults_empty_but_keeps_timing() {
    // start/end present but no `text` → kept with an empty string, not dropped.
    let body = json!({ "segments": [ { "start": 1.0, "end": 2.0 } ] });
    let segs = parse_verbose_segments(&body);
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].start_ms, 1000);
    assert_eq!(segs[0].end_ms, 2000);
    assert_eq!(segs[0].text, "");
}

#[test]
fn transcription_and_segment_defaults_are_empty() {
    let t = Transcription::default();
    assert!(t.text.is_empty());
    assert!(t.segments.is_empty());
    let s = TranscriptSegment::default();
    assert_eq!(s.start_ms, 0);
    assert_eq!(s.end_ms, 0);
    assert!(s.text.is_empty());
    // Clone/Debug are derived — exercise them so they count.
    let _ = format!("{:?}", t.clone());
    let _ = format!("{:?}", s.clone());
}

// ── HTTP-proxy engine dispatch (whisper.cpp + Gateway) ────────────────────
//
// These stand up a loopback axum server so the success / non-2xx / bad-body
// branches run deterministically without any real voice server or network.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{http::HeaderMap, http::StatusCode, Router};
use tokio::net::TcpListener;

/// Serializes the few tests that read/write process-global env vars
/// (`RYU_STT_ENGINE`, `RYU_STT_GATEWAY_PROVIDER`, `RYU_STT_GATEWAY_MODEL`).
static ENV_LOCK: Mutex<()> = Mutex::new(());
fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

struct FakeHost {
    whisper: String,
    audio_cpp: String,
    gateway: String,
    bearer: Result<String, String>,
}

impl Default for FakeHost {
    fn default() -> Self {
        Self {
            whisper: "http://127.0.0.1:0".to_string(),
            audio_cpp: "http://127.0.0.1:0".to_string(),
            gateway: "http://127.0.0.1:0".to_string(),
            bearer: Ok("testtoken".to_string()),
        }
    }
}

impl SttHost for FakeHost {
    fn whisper_base_url(&self) -> String {
        self.whisper.clone()
    }
    fn audio_cpp_base_url(&self) -> String {
        self.audio_cpp.clone()
    }
    fn gateway_url(&self) -> String {
        self.gateway.clone()
    }
    fn gateway_bearer(&self) -> Result<String, String> {
        self.bearer.clone()
    }
    fn parakeet_model_dir(&self) -> PathBuf {
        PathBuf::from("/nonexistent/parakeet-model")
    }
}

#[derive(Clone, Default)]
struct Captured {
    provider: Option<String>,
    model: Option<String>,
    authorization: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct TestServer {
    addr: std::net::SocketAddr,
    captured: Arc<Mutex<Vec<Captured>>>,
    _handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    fn last(&self) -> Captured {
        self.captured
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

/// A loopback HTTP server that records the request headers of each call and
/// replies with a fixed status + body on every path (fallback route).
async fn spawn_server(status: StatusCode, resp_body: &'static str) -> TestServer {
    let captured: Arc<Mutex<Vec<Captured>>> = Arc::new(Mutex::new(Vec::new()));
    let cap = captured.clone();
    let app = Router::new().fallback(move |headers: HeaderMap, body: axum::body::Bytes| {
        let cap = cap.clone();
        async move {
            let get = |k: &str| {
                headers
                    .get(k)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            cap.lock().unwrap().push(Captured {
                provider: get("x-ryu-slot-stt-provider"),
                model: get("x-ryu-slot-stt-model"),
                authorization: get("authorization"),
                content_type: get("content-type"),
                body: body.to_vec(),
            });
            (status, resp_body)
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    TestServer {
        addr,
        captured,
        _handle: handle,
    }
}

/// A bound-then-dropped loopback address: connecting to it refuses instantly.
async fn dead_url() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    format!("http://{addr}")
}
