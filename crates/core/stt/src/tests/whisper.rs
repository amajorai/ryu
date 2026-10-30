//! whisper.cpp engine dispatch and the parakeet dispatch arm.

use super::*;

// ── whisper.cpp engine ────────────────────────────────────────────────────

#[tokio::test]
async fn whisper_success_parses_text_and_segments() {
    let server = spawn_server(
        StatusCode::OK,
        r#"{"text":"  hello there  ","segments":[{"start":0.0,"end":1.0,"text":" hello"},{"start":1.0,"end":2.0,"text":" there"}]}"#,
    )
    .await;
    let host = FakeHost {
        whisper: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let out = transcribe_wav_detailed(
        &client,
        &host,
        b"fakeaudio".to_vec(),
        "clip.wav".to_string(),
        Some("whisper"),
    )
    .await
    .expect("whisper transcription should succeed");
    assert_eq!(out.text, "hello there");
    assert_eq!(out.segments.len(), 2);
    assert_eq!(out.segments[0].text, "hello");
    assert_eq!(out.segments[1].end_ms, 2000);
}

#[tokio::test]
async fn audiocpp_success_parses_sample_segments() {
    let server = spawn_server(
        StatusCode::OK,
        r#"{"text":"  hello from audio cpp  ","timing":{"sample_rate":16000},"segments":[{"start_sample":0,"end_sample":24000,"text":" hello "},{"start_sample":24000,"end_sample":40000,"text":" from audio cpp "}]}"#,
    )
    .await;
    let host = FakeHost {
        audio_cpp: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let out = transcribe_wav_detailed(
        &client,
        &host,
        b"fakeaudio".to_vec(),
        "clip.wav".to_string(),
        Some("audiocpp"),
    )
    .await
    .expect("audio.cpp transcription should succeed");
    assert_eq!(out.text, "hello from audio cpp");
    assert_eq!(out.segments.len(), 2);
    assert_eq!(out.segments[0].end_ms, 1500);
    assert_eq!(out.segments[1].start_ms, 1500);
    assert_eq!(out.segments[1].end_ms, 2500);
}

#[test]
fn audiocpp_segment_parser_prefers_seconds_when_both_exist() {
    let body = json!({
        "timing": { "sample_rate": 16000 },
        "segments": [{
            "start": 0.25,
            "end": 0.75,
            "start_sample": 0,
            "end_sample": 32000,
            "text": "hello"
        }]
    });
    let segments = parse_audio_cpp_segments(&body);
    assert_eq!(segments[0].start_ms, 250);
    assert_eq!(segments[0].end_ms, 750);
}

#[tokio::test]
async fn whisper_text_only_wrapper_returns_string() {
    let server = spawn_server(StatusCode::OK, r#"{"text":"just text"}"#).await;
    let host = FakeHost {
        whisper: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    // The text-only wrapper `transcribe_wav` drops segments.
    let text = transcribe_wav(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("whisper"),
    )
    .await
    .unwrap();
    assert_eq!(text, "just text");
}

#[tokio::test]
async fn whisper_non_success_status_is_error() {
    let server = spawn_server(StatusCode::INTERNAL_SERVER_ERROR, "model exploded").await;
    let host = FakeHost {
        whisper: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("whisper"),
    )
    .await
    .unwrap_err();
    assert!(err.contains("whisper returned 500"), "got: {err}");
    assert!(err.contains("model exploded"), "got: {err}");
}

#[tokio::test]
async fn whisper_unparseable_body_is_error() {
    let server = spawn_server(StatusCode::OK, "this is not json").await;
    let host = FakeHost {
        whisper: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("whisper"),
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("could not parse whisper response"),
        "got: {err}"
    );
}

#[tokio::test]
async fn whisper_unreachable_host_is_error() {
    let host = FakeHost {
        whisper: dead_url().await,
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("whisper"),
    )
    .await
    .unwrap_err();
    assert!(err.contains("not reachable"), "got: {err}");
    assert!(
        err.contains("whispercpp"),
        "actionable hint expected: {err}"
    );
}

#[cfg(not(all(
    feature = "voice-parakeet",
    not(all(target_os = "macos", target_arch = "x86_64"))
)))]
#[tokio::test]
async fn empty_engine_selector_falls_through_to_compiled_default() {
    // Without `voice-parakeet` (the cargo-test build), the compiled default is
    // whisper, so a blank selector must hit the whisper arm. Hold ENV_LOCK
    // because this path reads `RYU_STT_ENGINE`.
    let _g = env_guard();
    let prev = std::env::var("RYU_STT_ENGINE").ok();
    std::env::remove_var("RYU_STT_ENGINE");
    let server = spawn_server(StatusCode::OK, r#"{"text":"fallback"}"#).await;
    let host = FakeHost {
        whisper: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let out = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("   "),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "fallback");
    if let Some(v) = prev {
        std::env::set_var("RYU_STT_ENGINE", v);
    }
}

// ── parakeet dispatch (feature off in `cargo test`) ───────────────────────

#[cfg(not(all(
    feature = "voice-parakeet",
    not(all(target_os = "macos", target_arch = "x86_64"))
)))]
#[tokio::test]
async fn parakeet_engine_without_feature_reports_not_built() {
    let host = FakeHost::default();
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("parakeet"),
    )
    .await
    .unwrap_err();
    assert!(err.contains("parakeet transcription failed"), "got: {err}");
    assert!(err.contains("not built"), "got: {err}");
}
