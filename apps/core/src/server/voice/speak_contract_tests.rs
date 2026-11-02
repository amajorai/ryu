use super::*;

use axum::{http::header::CONTENT_TYPE, routing::post, Router};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

fn parse(body: Value) -> Result<SpeakRequest, String> {
    parse_speak_request(body)
}

#[test]
fn studio_fields_parse_within_bounds() {
    let req = parse(json!({
        "text": "hi",
        "seed": 4_294_967_295_u64,
        "instruct": "warm, slow",
        "reference_text": "the sample says this",
        "effects": [
            { "type": "gain", "params": { "gain_db": -3 } },
            { "type": "pitch_shift", "params": { "semitones": 1.5 } },
            { "type": "reverb" }
        ],
        "normalize": "podcast",
        "format": "mp3"
    }))
    .expect("valid studio request should parse");
    assert_eq!(req.seed, Some(u32::MAX));
    assert_eq!(req.normalize, Some(SpeakNormalize::Podcast));
    assert_eq!(req.format, Some(SpeakFormat::Mp3));
    let effects = req.effects.expect("effects should parse");
    assert_eq!(effects[1].kind, SpeakEffectKind::PitchShift);
    assert!(effects[2].params.is_empty());
}

#[test]
fn studio_fields_reject_out_of_bounds_and_unknown_values() {
    let long = |n: usize| "a".repeat(n);
    let too_many: Vec<Value> = (0..13).map(|_| json!({ "type": "gain" })).collect();
    let rejected = [
        json!({ "text": "hi", "instruct": long(501) }),
        json!({ "text": "hi", "reference_text": long(1001) }),
        json!({ "text": "hi", "effects": too_many }),
        json!({ "text": "hi", "effects": [{ "type": "speed" }] }),
        json!({ "text": "hi", "effects": [{ "type": "gain", "params": { "gain_db": "loud" } }] }),
        json!({ "text": "hi", "effects": [{ "type": "gain", "params": { "Bad Key": 1 } }] }),
        json!({ "text": "hi", "effects": [{ "type": "gain", "extra": 1 }] }),
        json!({ "text": "hi", "normalize": "loud" }),
        json!({ "text": "hi", "format": "aac" }),
        json!({ "text": "hi", "seed": -1 }),
        json!({ "text": "hi", "seed": 4_294_967_296_u64 }),
        json!({ "text": "hi", "speed": -1.0 }),
    ];
    for body in rejected {
        assert!(parse(body.clone()).is_err(), "{body} should be rejected");
    }
    assert!(parse(json!({ "text": long(MAX_SPEAK_TEXT_CHARS + 1) })).is_err());
    assert!(parse(json!({ "text": "é".repeat(MAX_SPEAK_TEXT_CHARS) })).is_ok());
    // Exactly at the bounds is fine; instruct counts characters, not bytes.
    assert!(parse(json!({ "text": "hi", "instruct": "é".repeat(500) })).is_ok());
    assert!(parse(json!({ "text": "hi", "reference_text": long(1000) })).is_ok());
}

#[test]
fn non_finite_effect_params_are_rejected_after_parse() {
    let mut params = BTreeMap::new();
    params.insert("gain_db".to_owned(), f64::INFINITY);
    let req = SpeakRequest {
        text: "hi".to_owned(),
        effects: Some(vec![SpeakEffect {
            kind: SpeakEffectKind::Gain,
            params,
        }]),
        ..Default::default()
    };
    assert!(validate_speak_options(&req).is_err());
}

#[test]
fn sidecar_body_forwards_every_studio_field() {
    let req = parse(json!({
        "text": "ignored",
        "voice": "af_heart",
        "seed": 7,
        "instruct": "whisper",
        "reference_text": "sample words",
        "effects": [{ "type": "highpass", "params": { "hz": 80 } }],
        "normalize": "acx",
        "format": "flac"
    }))
    .unwrap();
    let body = sidecar_generate_body("kokoro", &req, "hello");
    assert_eq!(body["text"], "hello");
    assert_eq!(body["engine"], "kokoro");
    assert_eq!(body["voice"], "af_heart");
    assert_eq!(body["seed"], 7);
    assert_eq!(body["instruct"], "whisper");
    assert_eq!(body["reference_text"], "sample words");
    assert_eq!(
        body["effects"],
        json!([{ "type": "highpass", "params": { "hz": 80.0 } }])
    );
    assert_eq!(body["normalize"], "acx");
    assert_eq!(body["format"], "flac");

    let bare = sidecar_generate_body("kokoro", &parse(json!({ "text": "x" })).unwrap(), "x");
    for key in [
        "seed",
        "instruct",
        "reference_text",
        "effects",
        "normalize",
        "format",
    ] {
        assert!(bare.get(key).is_none(), "{key} must be omitted when unset");
    }
}

#[test]
fn sidecar_mime_is_allowlisted() {
    assert_eq!(sidecar_audio_mime(None), Some("audio/wav"));
    assert_eq!(sidecar_audio_mime(Some("audio/x-wav")), Some("audio/wav"));
    assert_eq!(sidecar_audio_mime(Some("audio/mpeg")), Some("audio/mpeg"));
    assert_eq!(
        sidecar_audio_mime(Some("audio/ogg; codecs=vorbis")),
        Some("audio/ogg")
    );
    assert_eq!(sidecar_audio_mime(Some("audio/flac")), Some("audio/flac"));
    assert_eq!(sidecar_audio_mime(Some("text/html")), None);
    assert_eq!(sidecar_audio_mime(Some("application/json")), None);
}

#[test]
fn fallback_is_only_for_plain_read_aloud_on_the_default_engine() {
    // Desktop read-aloud always names its stored engine (the default on a
    // fresh install), so an explicit default must still degrade.
    assert!(fallback_allowed(None, "kokoro", false, false));
    assert!(fallback_allowed(Some("kokoro"), "kokoro", false, false));
    assert!(fallback_allowed(Some("gateway"), "kokoro", false, false));
    assert!(!fallback_allowed(None, "kokoro", true, false));
    assert!(!fallback_allowed(Some("kokoro"), "kokoro", false, true));
    assert!(!fallback_allowed(
        Some("chatterbox"),
        "kokoro",
        false,
        false
    ));
    assert!(!fallback_allowed(Some("chatterbox"), "kokoro", true, false));
}

#[test]
fn sidecar_validation_messages_reach_the_caller() {
    let body = r#"{"error":"invalid request","detail":[{"loc":["body","effects",0],"msg":"Value error, unknown gain param(s) db; use gain_db"}]}"#;
    assert_eq!(
        sidecar_error_detail(body),
        "Value error, unknown gain param(s) db; use gain_db"
    );
    assert_eq!(sidecar_error_detail(r#"{"error":"boom"}"#), "boom");
}

#[test]
fn studio_options_are_detected_for_the_fallback_rule() {
    let plain = SpeakRequest {
        text: "hi".to_owned(),
        normalize: Some(SpeakNormalize::Off),
        format: Some(SpeakFormat::Wav),
        instruct: Some("  ".to_owned()),
        ..SpeakRequest::default()
    };
    assert!(!requests_studio_options(&plain));
    let seeded = SpeakRequest {
        seed: Some(7),
        ..SpeakRequest::default()
    };
    assert!(requests_studio_options(&seeded));
    let mp3 = SpeakRequest {
        format: Some(SpeakFormat::Mp3),
        ..SpeakRequest::default()
    };
    assert!(requests_studio_options(&mp3));
}

#[test]
fn audio_response_carries_engine_and_fallback_headers() {
    let response = speak_audio_response(b"ID3".to_vec(), "audio/mpeg", "kokoro", None);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
    assert_eq!(response.headers()["x-ryu-tts-engine"], "kokoro");
    assert!(response.headers().get("x-ryu-tts-fallback").is_none());

    let fallback = speak_audio_response(b"RIFF".to_vec(), "audio/wav", "outetts", Some("kokoro"));
    assert_eq!(fallback.headers()["x-ryu-tts-engine"], "outetts");
    assert_eq!(fallback.headers()["x-ryu-tts-fallback"], "kokoro");
}

async fn serve(app: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

#[tokio::test]
async fn sidecar_adapter_forwards_body_and_returns_the_sidecar_mime() {
    let seen: Arc<Mutex<Option<Value>>> = Arc::default();
    let captured = Arc::clone(&seen);
    let base = serve(Router::new().route(
        "/generate",
        post(move |Json(body): Json<Value>| {
            let captured = Arc::clone(&captured);
            async move {
                *captured.lock().unwrap() = Some(body);
                ([(CONTENT_TYPE, "audio/mpeg")], b"ID3-mp3".to_vec())
            }
        }),
    ))
    .await;
    let req = parse(json!({ "text": "x", "format": "mp3", "seed": 3 })).unwrap();
    let (audio, mime) = synth_via_sidecar_at(
        &reqwest::Client::new(),
        &base,
        "token",
        "kokoro",
        &req,
        "hello",
    )
    .await
    .expect("sidecar mp3 should be accepted");
    assert_eq!(audio, b"ID3-mp3");
    assert_eq!(mime, "audio/mpeg");
    let body = seen.lock().unwrap().clone().expect("sidecar saw a body");
    assert_eq!(body["format"], "mp3");
    assert_eq!(body["seed"], 3);
    assert_eq!(body["text"], "hello");
}

#[tokio::test]
async fn sidecar_adapter_rejects_non_audio_and_keeps_client_error_status() {
    let base = serve(
        Router::new()
            .route(
                "/html/generate",
                post(|| async { ([(CONTENT_TYPE, "text/html")], b"<html>".to_vec()) }),
            )
            .route(
                "/415/generate",
                post(|| async {
                    (
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        Json(json!({ "detail": "mp3 needs ffmpeg" })),
                    )
                }),
            )
            .route(
                "/500/generate",
                post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
            ),
    )
    .await;
    let client = reqwest::Client::new();
    let req = SpeakRequest::default();
    let call = |path: &'static str| {
        let client = client.clone();
        let base = format!("{base}/{path}");
        let req = &req;
        async move { synth_via_sidecar_at(&client, &base, "t", "kokoro", req, "hi").await }
    };

    let html = call("html").await.unwrap_err();
    assert_eq!(html.response_status(), StatusCode::BAD_GATEWAY);
    assert!(html.message.contains("unsupported content type"));

    let unsupported = call("415").await.unwrap_err();
    assert_eq!(
        unsupported.response_status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert!(unsupported.message.contains("mp3 needs ffmpeg"));

    let crashed = call("500").await.unwrap_err();
    assert_eq!(crashed.response_status(), StatusCode::BAD_GATEWAY);

    let unreachable = synth_via_sidecar_at(&client, "http://127.0.0.1:9", "t", "k", &req, "hi")
        .await
        .unwrap_err();
    assert_eq!(unreachable.response_status(), StatusCode::BAD_GATEWAY);
}

/// A sidecar 404 on the node's default engine is a configuration error:
/// even though plain read-aloud on the default engine is fallback-eligible,
/// the adapter tags it `unknown` so `speak` answers 400 `tts_engine_unknown`
/// before it ever considers the OuteTTS fallback.
#[tokio::test]
async fn sidecar_unknown_engine_on_default_is_a_400_not_a_fallback() {
    let base = serve(Router::new().route(
        "/generate",
        post(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "detail": "unknown engine 'kokoro'; available: kitten" })),
            )
        }),
    ))
    .await;
    let req = parse(json!({ "text": "hi" })).unwrap();
    assert!(
        fallback_allowed(None, "kokoro", false, requests_studio_options(&req)),
        "plain default read-aloud is fallback-eligible for outages"
    );
    let error = synth_via_sidecar_at(&reqwest::Client::new(), &base, "t", "kokoro", &req, "hi")
        .await
        .unwrap_err();
    let unknown = error.unknown.as_ref().expect("404 must be tagged unknown");
    assert!(
        unknown.to_string().contains("available: kitten"),
        "{unknown}"
    );
    let response = unknown_tts_engine_response(unknown);
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["code"], "tts_engine_unknown");
}

/// A sidecar 4xx/5xx relays the sidecar's own sentence alone (no Core
/// wrapper), so the Companion's localizer matches its catalog entry; a body
/// with no sentence becomes one whole Core sentence instead of raw text.
#[tokio::test]
async fn sidecar_failure_relays_the_bare_sidecar_sentence() {
    let base = serve(
        Router::new()
            .route(
                "/502/generate",
                post(|| async {
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": "synthesis failed in 'kokoro': boom" })),
                    )
                }),
            )
            .route(
                "/400/generate",
                post(|| async {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": "no encoder available for 'opus'" })),
                    )
                }),
            )
            .route(
                "/422/generate",
                post(|| async {
                    (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({
                            "error": "invalid request",
                            "detail": [{ "msg": "a script may contain at most 20 pause tags" }]
                        })),
                    )
                }),
            )
            .route(
                "/500/generate",
                post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "Traceback ...") }),
            ),
    )
    .await;
    let client = reqwest::Client::new();
    let req = SpeakRequest::default();
    let call = |path: &'static str| {
        let client = client.clone();
        let base = format!("{base}/{path}");
        let req = &req;
        async move { synth_via_sidecar_at(&client, &base, "t", "kokoro", req, "hi").await }
    };

    let crashed = call("502").await.unwrap_err();
    assert_eq!(crashed.message, "synthesis failed in 'kokoro': boom");
    let refused = call("400").await.unwrap_err();
    assert_eq!(refused.response_status(), StatusCode::BAD_REQUEST);
    assert_eq!(refused.message, "no encoder available for 'opus'");
    let invalid = call("422").await.unwrap_err();
    assert_eq!(
        invalid.message,
        "a script may contain at most 20 pause tags"
    );
    let raw = call("500").await.unwrap_err();
    assert_eq!(raw.message, "Audio engine kokoro failed with status 500.");

    let response = speak_error(crashed.response_status(), crashed.message);
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        body,
        json!({ "error": "synthesis failed in 'kokoro': boom" })
    );
}

/// The Core-owned speak refusals are whole catalog sentences in English.
#[test]
fn speak_refusals_are_whole_sentences() {
    assert_eq!(
        speak_text_limit(8_000),
        "Text must be at most 8000 characters."
    );
    assert_eq!(
        voice_text(
            crate::i18n::Message::new(crate::i18n::messages::VOICE_SPEAK_FALLBACK_FAILED_MESSAGE)
                .text("engine", "kokoro")
        ),
        "Audio engine kokoro failed, and the OuteTTS fallback also failed."
    );
}
