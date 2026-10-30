//! Gateway-routed STT engine dispatch.

use super::*;

// ── Gateway engine ────────────────────────────────────────────────────────

#[tokio::test]
async fn gateway_success_uses_multipart_without_overriding_node_routing() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let server = spawn_server(
        StatusCode::OK,
        r#"{"text":" gw text ","segments":[{"start":0.0,"end":0.5,"text":"gw"}]}"#,
    )
    .await;
    let host = FakeHost {
        gateway: server.url(),
        bearer: Ok("secret-slot-token".to_string()),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let out = transcribe_wav_detailed(
        &client,
        &host,
        vec![0, 255, 1],
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "gw text");
    assert_eq!(out.segments.len(), 1);
    let cap = server.last();
    assert_eq!(cap.provider, None);
    assert_eq!(cap.model, None);
    assert!(cap
        .content_type
        .as_deref()
        .unwrap()
        .starts_with("multipart/form-data; boundary="));
    assert!(cap.body.windows(3).any(|bytes| bytes == [0, 255, 1]));
    let filename = b"filename=\"c.wav\"";
    assert!(cap
        .body
        .windows(filename.len())
        .any(|bytes| bytes == filename));
    assert_eq!(
        cap.authorization.as_deref(),
        Some("Bearer secret-slot-token")
    );
}

#[test]
fn gateway_fields_forward_only_values_the_gateway_accepts() {
    let config = TranscriptionConfig {
        language: Some(" fr ".to_owned()),
        prompt: Some("Ryu, Parakeet".to_owned()),
        temperature: Some(0.2),
        translate: Some(true),
        extra: BTreeMap::from([("vad".to_owned(), "true".to_owned())]),
        ..Default::default()
    };
    assert_eq!(
        gateway_multipart_fields(&config),
        vec![
            ("language", "fr".to_owned()),
            ("prompt", "Ryu, Parakeet".to_owned()),
            ("temperature", "0.2".to_owned()),
        ]
    );
    let rejected = TranscriptionConfig {
        language: Some("en_US".to_owned()),
        prompt: Some("  ".to_owned()),
        temperature: Some(1.5),
        ..Default::default()
    };
    assert!(gateway_multipart_fields(&rejected).is_empty());
}

#[tokio::test]
async fn gateway_forwards_configured_language() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let server = spawn_server(StatusCode::OK, r#"{"text":"bonjour"}"#).await;
    let host = FakeHost {
        gateway: server.url(),
        ..FakeHost::default()
    };
    let config = TranscriptionConfig {
        language: Some("fr".to_owned()),
        ..Default::default()
    };
    let out = transcribe_wav_detailed_with_config(
        &reqwest::Client::new(),
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
        config,
    )
    .await
    .unwrap();
    assert_eq!(out.text, "bonjour");
    let body = String::from_utf8_lossy(&server.last().body).into_owned();
    assert!(body.contains("name=\"language\"\r\n\r\nfr\r\n"), "{body}");
}

#[tokio::test]
async fn gateway_env_overrides_provider_and_model() {
    let _g = env_guard();
    std::env::set_var("RYU_STT_GATEWAY_PROVIDER", "groq");
    std::env::set_var("RYU_STT_GATEWAY_MODEL", "whisper-turbo");
    let server = spawn_server(StatusCode::OK, r#"{"text":"x"}"#).await;
    // Trailing slash on the gateway base must be trimmed before the path join.
    let host = FakeHost {
        gateway: format!("{}/", server.url()),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let out = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "x");
    let cap = server.last();
    assert_eq!(cap.provider.as_deref(), Some("groq"));
    assert_eq!(cap.model.as_deref(), Some("whisper-turbo"));
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
}

#[tokio::test]
async fn gateway_bearer_error_short_circuits() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    // No server is contacted — the bearer failure must propagate before the POST.
    let host = FakeHost {
        gateway: "http://127.0.0.1:0".to_string(),
        bearer: Err("no gateway token configured".to_string()),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap_err();
    assert_eq!(err, "no gateway token configured");
}

#[tokio::test]
async fn gateway_non_success_status_is_error() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let server = spawn_server(StatusCode::UNAUTHORIZED, "bad key").await;
    let host = FakeHost {
        gateway: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap_err();
    assert!(err.contains("gateway STT returned 401"), "got: {err}");
    assert!(
        !err.contains("bad key"),
        "upstream details must stay private: {err}"
    );
}

#[tokio::test]
async fn gateway_unparseable_body_is_error() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let server = spawn_server(StatusCode::OK, "<html>not json</html>").await;
    let host = FakeHost {
        gateway: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("could not parse gateway STT response"),
        "got: {err}"
    );
}

#[tokio::test]
async fn gateway_unreachable_host_is_error() {
    let _g = env_guard();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let host = FakeHost {
        gateway: dead_url().await,
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    let err = transcribe_wav_detailed(
        &client,
        &host,
        b"a".to_vec(),
        "c.wav".to_string(),
        Some("gateway"),
    )
    .await
    .unwrap_err();
    assert_eq!(err, "gateway STT transport unavailable");
}

#[tokio::test]
async fn gateway_qwen_pin_uses_json_and_its_native_model() {
    let _g = env_guard();
    std::env::set_var("RYU_STT_GATEWAY_PROVIDER", "qwen");
    std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    let server = spawn_server(StatusCode::OK, r#"{"text":"native"}"#).await;
    let host = FakeHost {
        gateway: server.url(),
        ..FakeHost::default()
    };
    let out = transcribe_wav_detailed(
        &reqwest::Client::new(),
        &host,
        b"a".to_vec(),
        "clip.wav".to_owned(),
        Some("gateway"),
    )
    .await
    .unwrap();
    std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
    assert_eq!(out.text, "native");
    assert!(out.segments.is_empty() && out.words.is_empty());
    let captured = server.last();
    assert_eq!(captured.provider.as_deref(), Some("qwen"));
    assert_eq!(captured.model, None);
    let body = String::from_utf8(captured.body).unwrap();
    assert!(body.contains("qwen3-asr-flash"));
    assert!(body.contains("name=\"response_format\"\r\n\r\njson"));
    assert!(!body.contains("verbose_json"));
}

#[tokio::test]
async fn gateway_rejects_empty_audio_and_path_filenames_before_http() {
    let server = spawn_server(StatusCode::OK, r#"{"text":"unused"}"#).await;
    let host = FakeHost {
        gateway: server.url(),
        ..FakeHost::default()
    };
    let client = reqwest::Client::new();
    for (audio, filename) in [
        (Vec::new(), "clip.wav"),
        (vec![1], "../private.wav"),
        (vec![1], "private\\clip.wav"),
    ] {
        assert!(transcribe_via_gateway(
            &client,
            &host,
            audio,
            filename.to_owned(),
            &TranscriptionConfig::default()
        )
        .await
        .is_err());
    }
    assert!(server.captured.lock().unwrap().is_empty());
}
