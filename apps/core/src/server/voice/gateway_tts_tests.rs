use super::*;

use axum::{http::header::CONTENT_TYPE, routing::post, Router};
use tokio::net::TcpListener;

/// The prompt must ride under `input`. The Gateway's inbound firewall scans
/// `body["input"]` for Tts, so sending Core's own field name (`text`) would
/// route correctly and silently skip the scan.
#[test]
fn payload_uses_input_not_text() {
    let p = gateway_tts_payload("tts-1", Some("nova"), None, "hello there");
    assert_eq!(p["input"], "hello there");
    assert!(
        p.get("text").is_none(),
        "`text` bypasses the gateway firewall scan: {p}"
    );
    assert_eq!(p["voice"], "nova");
    assert_eq!(p["response_format"], "mp3");
    assert_eq!(p["model"], "tts-1");
    assert!(p.get("speed").is_none());
}

/// The realtime voice session only forwards WAV frames, so its Gateway
/// request must ask for WAV; read-aloud keeps the mp3 default.
#[test]
fn voice_session_requests_wav_and_read_aloud_keeps_mp3() {
    let session = gateway_tts_request_payload(
        "tts-1",
        Some("nova"),
        None,
        "hi",
        "openai",
        GATEWAY_TTS_FORMAT_VOICE_SESSION,
    );
    assert_eq!(session["response_format"], "wav");
    assert_eq!(session["input"], "hi");
    assert_eq!(session["voice"], "nova");
    let read_aloud = gateway_tts_request_payload(
        "tts-1",
        None,
        None,
        "hi",
        "edge-tts",
        GATEWAY_TTS_FORMAT_READ_ALOUD,
    );
    assert_eq!(read_aloud["response_format"], "mp3");
    assert_eq!(read_aloud["voice"], "en-US-EmmaMultilingualNeural");
}

#[tokio::test]
async fn gateway_binary_audio_preserves_bytes_and_actual_mime() {
    let audio = vec![0x49, 0x44, 0x33, 0, 0xff];
    let expected = audio.clone();
    let app = Router::new().route(
        "/speech",
        post(move || {
            let audio = audio.clone();
            async move { ([(CONTENT_TYPE, "audio/mpeg")], audio) }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("http://{address}/speech"))
        .send()
        .await
        .unwrap();
    let (actual, mime) = decode_gateway_audio_response(response).await.unwrap();
    server.abort();
    assert_eq!(actual, expected);
    assert_eq!(mime, "audio/mpeg");
}

#[tokio::test]
async fn core_speech_http_handoff_keeps_translate_cloud_and_default_routes_distinct() {
    for (provider, model, voice) in [
        ("openai", "tts-1", "alloy"),
        ("google-tts", "tts-1", "en-US-Neural2-F"),
        ("google-translate-tts", "google-translate-tts::vi", "vi"),
    ] {
        let audio = vec![0x49, 0x44, 0x33, 0, 0xff];
        let expected = audio.clone();
        let app = Router::new().route(
            "/v1/audio/speech",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let audio = audio.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer proof-gateway-relay");
                        assert_eq!(headers["x-ryu-slot-tts-provider"], provider);
                        assert_eq!(headers["x-ryu-slot-tts-model"], model);
                        assert_eq!(
                            body,
                            json!({
                                "model": model,
                                "input": "A real Core speech request",
                                "voice": voice,
                                "response_format": "mp3"
                            })
                        );
                        ([(CONTENT_TYPE, "audio/mpeg")], audio)
                    }
                },
            ),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let payload = gateway_tts_payload_for_provider(
            model,
            None,
            None,
            "A real Core speech request",
            provider,
        );
        let request = build_gateway_tts_request(
            &client,
            &format!("http://{address}/v1/audio/speech"),
            "proof-gateway-relay",
            &payload,
            Some(provider),
            Some(model),
        );
        let result = send_gateway_tts_request(request).await;
        server.abort();
        let (bytes, mime) = result.unwrap();
        assert_eq!(bytes, expected);
        assert_eq!(mime, "audio/mpeg");
    }
}

#[tokio::test]
async fn gateway_audio_rejects_legacy_json_empty_audio_and_private_error_details() {
    for (status, mime, body) in [
        (
            StatusCode::OK,
            "application/json",
            "private-response-material",
        ),
        (StatusCode::OK, "audio/wav", ""),
        (
            StatusCode::BAD_GATEWAY,
            "application/json",
            "private-response-material",
        ),
    ] {
        let app = Router::new().route(
            "/speech",
            post(move || async move { (status, [(CONTENT_TYPE, mime)], body) }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("http://{address}/speech"))
            .send()
            .await
            .unwrap();
        let error = decode_gateway_audio_response(response).await.unwrap_err();
        server.abort();
        assert!(!error.contains("private-response-material"));
    }
}

#[test]
fn gateway_audio_mime_rejects_unknown_values_and_normalizes_audio_aliases() {
    assert_eq!(
        gateway_audio_mime("audio/x-wav; codec=pcm"),
        Some("audio/wav")
    );
    assert_eq!(gateway_audio_mime("Audio/MPEG"), Some("audio/mpeg"));
    assert_eq!(gateway_audio_mime("audio/ogg"), Some("audio/ogg"));
    assert_eq!(gateway_audio_mime("application/json"), None);
    assert_eq!(gateway_audio_mime("text/html"), None);
}

/// OpenAI's `/v1/audio/speech` 400s without a `voice`, and the stored
/// preference is `""` for anyone who picked the engine before a voice list
/// existed. Both "absent" and "empty" must therefore resolve to a real voice.
#[test]
fn payload_always_carries_a_voice() {
    for voice in [None, Some(""), Some("   ")] {
        let p = gateway_tts_payload("tts-1", voice, None, "hi");
        assert_eq!(
            p["voice"], DEFAULT_GATEWAY_TTS_VOICE,
            "empty voice must fall back, got {p}"
        );
    }
    let p = gateway_tts_payload("tts-1", Some("shimmer"), Some(1.25), "hi");
    assert_eq!(p["voice"], "shimmer");
    assert_eq!(p["speed"], 1.25);
}

#[test]
fn cloud_speech_defaults_follow_the_resolved_provider() {
    let config: toml::Value = toml::from_str(
        "[routing]\ndefault_provider='openai'\n[routing.model_map.'tts-1']\nprovider='polly'\n[routing.modality_map.tts]\nprovider='edge-tts'\n",
    )
    .unwrap();
    assert_eq!(
        gateway_tts_provider_from_config(&config, "tts-1"),
        Some("edge-tts")
    );
    for (provider, native) in [
        ("edge-tts", "en-US-EmmaMultilingualNeural"),
        ("google-tts", "en-US-Neural2-F"),
        ("polly", "Joanna"),
    ] {
        assert_eq!(
            gateway_tts_payload_for_provider("tts-1", None, None, "hello", provider)["voice"],
            native
        );
        assert_eq!(
            gateway_tts_payload_for_provider("tts-1", Some("alloy"), None, "hello", provider)
                ["voice"],
            native,
            "older saved OpenAI defaults must migrate when the speech provider changes"
        );
        assert_eq!(
            gateway_tts_payload_for_provider("tts-1", Some(native), None, "hello", provider)
                ["voice"],
            native
        );
    }
    assert_eq!(
        gateway_tts_payload_for_provider("tts-1", None, None, "hello", "openai")["voice"],
        "alloy"
    );
}

#[test]
fn audio_cpp_payload_uses_native_model_and_request_options() {
    let request = SpeakRequest {
        text: "hello".to_string(),
        engine: Some("audiocpp".to_string()),
        voice: Some("alba".to_string()),
        speed: Some(1.15),
        language: Some("en".to_string()),
        reference_audio: Some("/tmp/reference.wav".to_string()),
        reference_audio_data_url: None,
        ..Default::default()
    };
    let payload = audio_cpp_tts_payload(&request, "hello");
    assert_eq!(
        payload["model"],
        crate::sidecar::providers::audiocpp::DEFAULT_TTS_MODEL_ID
    );
    assert_eq!(payload["input"], "hello");
    assert_eq!(payload["voice"], "alba");
    let speaking_rate = payload["options"]["speaking_rate"]
        .as_f64()
        .expect("speaking_rate should be numeric");
    assert!((speaking_rate - 1.15).abs() < 0.000_001);
    assert_eq!(payload["language"], "en");
    assert_eq!(payload["voice_ref"], "/tmp/reference.wav");
    assert!(payload.get("text").is_none());
}
