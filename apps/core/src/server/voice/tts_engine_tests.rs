use super::*;

use axum::{http::header::CONTENT_TYPE, routing::post, Router};
use tokio::net::TcpListener;

#[test]
fn reference_audio_rejects_urls_and_relative_paths() {
    assert!(validate_reference_audio(Some("https://example.com/ref.wav")).is_err());
    assert!(validate_reference_audio(Some("../ref.wav")).is_err());
}

#[test]
fn clone_sample_data_url_accepts_only_bounded_wav_bytes() {
    use base64::Engine as _;

    let mut wav = vec![0_u8; 44];
    wav[..4].copy_from_slice(b"RIFF");
    wav[8..12].copy_from_slice(b"WAVE");
    let data_url = format!(
        "data:audio/wav;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&wav)
    );
    assert_eq!(decode_reference_audio_data_url(&data_url).unwrap(), wav);
    assert!(decode_reference_audio_data_url("https://example.com/voice.wav").is_err());
    assert!(decode_reference_audio_data_url("data:audio/wav;base64,not_base64!").is_err());

    let oversized = vec![0_u8; MAX_REFERENCE_AUDIO_BYTES + 1];
    let oversized_url = format!(
        "data:audio/wav;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(oversized)
    );
    assert!(decode_reference_audio_data_url(&oversized_url).is_err());
}

#[test]
fn clone_sample_data_url_rejects_a_non_wav_header() {
    use base64::Engine as _;

    let bytes = b"not a wave";
    let data_url = format!(
        "data:audio/wav;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    assert!(decode_reference_audio_data_url(&data_url).is_err());
}

#[test]
fn staged_clone_sample_is_private_temporary_data() {
    use base64::Engine as _;

    let mut wav = vec![0_u8; 44];
    wav[..4].copy_from_slice(b"RIFF");
    wav[8..12].copy_from_slice(b"WAVE");
    let data_url = format!(
        "data:audio/wav;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&wav)
    );
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("voice").join("reference-audio");
    let staged = stage_reference_audio_data_url_in(&data_url, &root).unwrap();
    let path = staged.path().to_path_buf();
    assert!(path.starts_with(&root));
    assert_eq!(std::fs::read(&path).unwrap(), wav);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&root), 0o700, "the staging directory is owner-only");
        assert_eq!(mode(&path), 0o600, "the staged sample is owner-only");
    }
    drop(staged);
    assert!(!path.exists());
}

#[test]
fn inline_samples_are_staged_in_scratch_space_not_the_reference_directory() {
    let staging = reference_audio_staging_dir();
    assert!(staging.starts_with(crate::paths::tmp_dir_for("voice")));
    assert!(!staging.starts_with(crate::paths::files_path("voice")));
}

#[test]
fn the_startup_sweep_removes_orphaned_samples_and_keeps_user_files() {
    let directory = tempfile::tempdir().unwrap();
    let staging = directory.path().join("tmp").join("reference-audio");
    let legacy = directory.path().join("files").join("reference-audio");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::create_dir_all(&legacy).unwrap();
    let orphan = staging.join(".tmpAbC123.wav");
    let legacy_orphan = legacy.join(".tmpXyZ789.wav");
    let user_sample = legacy.join("my-voice.wav");
    for file in [&orphan, &legacy_orphan, &user_sample] {
        std::fs::write(file, b"RIFF....WAVE").unwrap();
    }
    // A fresh staged sample survives an age-gated sweep (it may be in use).
    assert_eq!(
        sweep_staged_reference_audio(&staging, &legacy, std::time::Duration::from_secs(900)),
        1
    );
    assert!(orphan.exists());
    assert!(!legacy_orphan.exists());
    // The first staging after a start removes every orphan.
    assert_eq!(
        sweep_staged_reference_audio(&staging, &legacy, std::time::Duration::ZERO),
        1
    );
    assert!(!orphan.exists());
    assert!(
        user_sample.exists(),
        "a user's own reference file is never swept"
    );
}

#[test]
fn engine_install_accepts_only_simple_registry_ids() {
    assert!(valid_tts_engine_id("pocket"));
    assert!(valid_tts_engine_id("audio_cpp"));
    assert!(!valid_tts_engine_id("../pocket"));
    assert!(!valid_tts_engine_id("Pocket"));
    assert!(!valid_tts_engine_id(&"a".repeat(81)));
}

#[test]
fn audio_cpp_payload_defaults_to_alba() {
    let request = SpeakRequest {
        text: "hello".to_string(),
        engine: Some("audiocpp".to_string()),
        voice: Some("   ".to_string()),
        speed: None,
        language: None,
        reference_audio: None,
        reference_audio_data_url: None,
        ..Default::default()
    };
    let payload = audio_cpp_tts_payload(&request, "hello");
    assert_eq!(
        payload["voice"],
        crate::sidecar::providers::audiocpp::DEFAULT_TTS_VOICE
    );
    assert!(payload.get("options").is_none());
}

async fn ryutts_stub(status: StatusCode) -> String {
    let app = Router::new().route(
        "/generate",
        post(move || async move { (status, "unknown engine 'kokoroo'; available: kokoro") }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// Read-aloud must not degrade a RyuTTS `unknown engine` (404) to OuteTTS:
/// it is classified as [`UnknownTtsEngine`] and answered with a 400, while
/// a sidecar 5xx stays an ordinary (fallback-eligible) error.
#[tokio::test]
async fn read_aloud_surfaces_unknown_ryutts_engine_and_degrades_outages() {
    let client = reqwest::Client::new();
    let body = json!({ "text": "hi", "engine": "kokoroo" });

    let base = ryutts_stub(StatusCode::NOT_FOUND).await;
    let error = ryutts_generate_at(&client, &base, "kokoroo", &body)
        .await
        .expect_err("404 is an unknown engine");
    let unknown = error
        .downcast_ref::<UnknownTtsEngine>()
        .expect("404 must classify as UnknownTtsEngine");
    assert!(
        unknown.to_string().contains("available: kokoro"),
        "{unknown}"
    );
    let response = unknown_tts_engine_response(unknown);
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let base = ryutts_stub(StatusCode::SERVICE_UNAVAILABLE).await;
    let error = ryutts_generate_at(&client, &base, "kokoro", &body)
        .await
        .expect_err("503 is an outage");
    assert!(
        !error.is::<UnknownTtsEngine>(),
        "outages must stay fallback-eligible"
    );

    let error = ryutts_generate_at(&client, "http://127.0.0.1:9", "kokoro", &body)
        .await
        .expect_err("unreachable sidecar");
    assert!(!error.is::<UnknownTtsEngine>());
}

/// Malformed engine ids are refused before any synthesis with a 4xx.
#[test]
fn read_aloud_refuses_malformed_engine_ids() {
    for engine in ["outetts", "audiocpp", "gateway", "kokoro", "audio_cpp"] {
        assert!(check_tts_engine_id(engine).is_ok(), "{engine}");
    }
    for engine in ["Kokoro", "kokoro ", "../pocket", ""] {
        let unknown = check_tts_engine_id(engine).expect_err(engine);
        assert_eq!(
            unknown_tts_engine_response(&unknown).status(),
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn audio_cpp_http_adapter_accepts_wav_output() {
    let app = Router::new().route(
        "/v1/audio/speech",
        post(|| async { ([(CONTENT_TYPE, "audio/wav")], b"RIFF-test-wav".to_vec()) }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let request = SpeakRequest {
        text: "hello".to_string(),
        engine: Some("audiocpp".to_string()),
        voice: None,
        speed: None,
        language: None,
        reference_audio: None,
        reference_audio_data_url: None,
        ..Default::default()
    };
    let audio = synth_via_audio_cpp_at(
        &reqwest::Client::new(),
        &format!("http://{address}"),
        &request,
        "hello",
    )
    .await
    .expect("audio.cpp adapter should accept WAV output");
    assert_eq!(audio, b"RIFF-test-wav");
}

#[test]
fn tts_engine_installer_uses_the_core_bearer_and_registry_id() {
    let request = build_tts_engine_install_request(
        &reqwest::Client::new(),
        "http://127.0.0.1:8085/",
        "node-token",
        "pocket",
    )
    .build()
    .expect("Core should build the sidecar install request");
    assert_eq!(request.method(), axum::http::Method::POST);
    assert_eq!(request.url().path(), "/engines/install");
    assert_eq!(
        request.headers()[header::AUTHORIZATION],
        "Bearer node-token"
    );
    assert_eq!(request.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        tts_engine_install_body("pocket"),
        json!({ "engine": "pocket" })
    );
}

/// The default install must NOT pin a provider: the Gateway resolves slot
/// override → modality_map → model routing, so an unconditional slot header
/// would silently override the TTS provider the user picked in Settings.
#[test]
fn slot_headers_are_sent_only_when_explicitly_pinned() {
    let client = reqwest::Client::new();
    let payload = gateway_tts_payload("tts-1", Some("alloy"), None, "hi");

    let unpinned = build_gateway_tts_request(
        &client,
        "http://127.0.0.1:1/v1/audio/speech",
        "ryu-local",
        &payload,
        None,
        None,
    )
    .build()
    .expect("request builds");
    assert!(
        unpinned.headers().get("x-ryu-slot-tts-provider").is_none(),
        "an unpinned node must let modality_map decide the TTS provider"
    );
    assert!(unpinned.headers().get("x-ryu-slot-tts-model").is_none());
    assert!(unpinned.headers().get("authorization").is_some());

    let pinned = build_gateway_tts_request(
        &client,
        "http://127.0.0.1:1/v1/audio/speech",
        "ryu-local",
        &payload,
        Some("groq"),
        Some("playai-tts"),
    )
    .build()
    .expect("request builds");
    assert_eq!(
        pinned.headers()["x-ryu-slot-tts-provider"],
        "groq",
        "an explicit RYU_TTS_GATEWAY_PROVIDER must still win"
    );
    assert_eq!(pinned.headers()["x-ryu-slot-tts-model"], "playai-tts");
}

/// Env-driven pins, asserted in one test because the vars are process-global
/// and parallel tests would race each other over them.
#[test]
fn slot_overrides_read_env_and_ignore_blanks() {
    std::env::remove_var("RYU_TTS_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_TTS_GATEWAY_MODEL");
    assert_eq!(gateway_tts_slot_overrides(), (None, None));

    std::env::set_var("RYU_TTS_GATEWAY_PROVIDER", "   ");
    assert_eq!(
        gateway_tts_slot_overrides().0,
        None,
        "a blank pin must not count as pinned"
    );

    std::env::set_var("RYU_TTS_GATEWAY_PROVIDER", "groq");
    std::env::set_var("RYU_TTS_GATEWAY_MODEL", "playai-tts");
    assert_eq!(
        gateway_tts_slot_overrides(),
        (Some("groq".into()), Some("playai-tts".into()))
    );

    std::env::remove_var("RYU_TTS_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_TTS_GATEWAY_MODEL");
}

/// The row is what makes `engine=gateway` selectable at all, and its
/// `default_voice` is what the desktop stores when the engine is picked
/// (`handleTtsEngine` writes `next?.default_voice ?? ""`). An empty one ships
/// a request OpenAI rejects.
#[test]
fn engine_row_offers_a_real_default_voice() {
    let row = gateway_tts_engine_row();
    assert_eq!(row["id"], "gateway");
    assert_eq!(row["installed"], true);
    let default_voice = row["default_voice"].as_str().unwrap();
    assert!(!default_voice.is_empty(), "default_voice must not be empty");
    let voices = row["voices"].as_array().unwrap();
    assert!(!voices.is_empty(), "an empty list renders an empty picker");
    assert!(
        voices.iter().any(|v| v == default_voice),
        "the default voice must be one of the offered voices"
    );
}
