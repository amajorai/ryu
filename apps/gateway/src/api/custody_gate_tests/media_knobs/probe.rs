//! Coverage probes for the fleet media screen through the real router.
//!
//! These cover the routes, adapters and dispatch paths the main media knob
//! tests do not: speech, transcription multipart, the BFL adapter, a fallback
//! from one vendor to another, a query string and headers that are never
//! forwarded, and markers behind deep nesting or long padding. Markers are
//! `x.invalid` URLs and safety knob values only.
use super::*;

use axum::{http::HeaderMap, response::IntoResponse};

const SPEECH: &str = "/v1/audio/speech";
const TRANSCRIPTIONS: &str = "/v1/audio/transcriptions";

#[derive(Clone, Debug)]
struct Submission {
    path_and_query: String,
    headers: Vec<(String, String)>,
    body: Value,
}

/// A local vendor that answers like Replicate, Fal or BFL by path and records
/// every submission. With `fail` set every submission gets a 503.
struct ProbeVendor {
    base: String,
    submissions: Arc<Mutex<Vec<Submission>>>,
    task: tokio::task::JoinHandle<()>,
}

impl ProbeVendor {
    fn submissions(&self) -> Vec<Submission> {
        self.submissions.lock().expect("submissions lock").clone()
    }

    fn bodies(&self) -> Vec<Value> {
        self.submissions().into_iter().map(|s| s.body).collect()
    }
}

impl Drop for ProbeVendor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_probe_vendor(fail: bool) -> ProbeVendor {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("probe vendor binds");
    let base = format!("http://{}", listener.local_addr().expect("vendor address"));
    let submissions: Arc<Mutex<Vec<Submission>>> = Arc::default();
    let recorded = Arc::clone(&submissions);
    let vendor_base = base.clone();
    let handler = move |method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes| {
        let recorded = Arc::clone(&recorded);
        let base = vendor_base.clone();
        async move {
            let path = uri.path().to_owned();
            if method != Method::POST {
                return if path == "/asset.mp3" {
                    (
                        [("content-type", "audio/mpeg")],
                        vec![0xFF_u8, 0xFB, 0x90, 0x00],
                    )
                        .into_response()
                } else if path.starts_with("/predictions/") {
                    Json(json!({ "id": "pred-1", "status": "succeeded", "output": [format!("{base}/asset.mp3")] }))
                        .into_response()
                } else if path == "/v1/get_result" {
                    Json(json!({ "status": "Ready", "result": { "sample": format!("{base}/asset.png") } }))
                        .into_response()
                } else {
                    Json(json!({ "images": [{ "url": format!("{base}/asset.png") }], "audio": { "url": format!("{base}/asset.mp3") } }))
                        .into_response()
                };
            }
            recorded.lock().expect("submissions lock").push(Submission {
                path_and_query: uri
                    .path_and_query()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
                headers: headers
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str().to_owned(),
                            value.to_str().unwrap_or_default().to_owned(),
                        )
                    })
                    .collect(),
                body: serde_json::from_slice(&body).unwrap_or(Value::Null),
            });
            if fail {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "detail": "busy" })),
                )
                    .into_response();
            }
            if path.ends_with("/predictions") {
                Json(json!({
                    "id": "pred-1",
                    "status": "succeeded",
                    "output": [format!("{base}/asset.mp3")]
                }))
                .into_response()
            } else if path.starts_with("/v1/flux") {
                Json(json!({ "id": "t1", "polling_url": format!("{base}/v1/get_result?id=t1") }))
                    .into_response()
            } else {
                Json(json!({
                    "status": "COMPLETED",
                    "request_id": "req-1",
                    "response_url": format!("{base}/result")
                }))
                .into_response()
            }
        }
    };
    let router = Router::new().fallback(any(handler));
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("probe vendor serves");
    });
    ProbeVendor {
        base,
        submissions,
        task,
    }
}

#[derive(Clone, Copy, Debug)]
enum ProbeProvider {
    Replicate,
    Fal,
    Bfl,
}

impl ProbeProvider {
    fn name(self) -> &'static str {
        match self {
            Self::Replicate => "replicate",
            Self::Fal => "fal",
            Self::Bfl => "bfl",
        }
    }

    fn build(self, base: &str) -> Arc<dyn Provider> {
        let client = vendor_client();
        match self {
            Self::Replicate => Arc::new(ryu_gw_providers::ReplicateProvider::new(
                client,
                "vendor-secret".into(),
                base.to_owned(),
                1,
                2,
            )),
            Self::Fal => Arc::new(ryu_gw_providers::FalProvider::new(
                client,
                "vendor-secret".into(),
                base.to_owned(),
                1,
                2,
            )),
            Self::Bfl => Arc::new(ryu_gw_providers::BflProvider::new(
                client,
                None,
                vec!["vendor-secret".into()],
                format!("{base}/v1"),
                Arc::new(ryu_gw_providers::ProviderQuotas::new()),
                1,
                2,
            )),
        }
    }
}

/// A Gateway whose primary is the first vendor and whose fallback chain is the
/// rest, in order.
fn probe_harness(custody: GatewayCustody, vendors: &[(ProbeProvider, &ProbeVendor)]) -> Harness {
    let primary = vendors[0].0.name();
    let fallback: Vec<ProviderId> = vendors[1..]
        .iter()
        .map(|(provider, _)| ProviderId::from(provider.name()))
        .collect();
    let (mut state, audit) = state_with(custody, |config| {
        config.routing.default_provider = ProviderId::from(primary);
        config.routing.fallback_chain = fallback;
    });
    for (provider, vendor) in vendors {
        state
            .provider_runtime
            .register_for_test(provider.build(&vendor.base));
    }
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

async fn send_raw(
    app: &Router,
    uri: &str,
    headers: &[(&str, &str)],
    content_type: &str,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", content_type)
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(true));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).expect("request builds"))
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

async fn send_json(
    app: &Router,
    uri: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> (StatusCode, Value) {
    send_raw(
        app,
        uri,
        headers,
        "application/json",
        body.to_string().into_bytes(),
    )
    .await
}

// ── Speech ───────────────────────────────────────────────────────────────────

const TTS_SLOT: [(&str, &str); 1] = [("x-ryu-slot-tts-provider", "replicate")];

#[tokio::test]
async fn probe_speech_on_replicate_rewrites_knobs_on_the_wire() {
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(
        GatewayCustody::Fleet,
        &[(ProbeProvider::Replicate, &vendor)],
    );
    let body = json!({
        "model": "owner/tts-model",
        "input": "hello there",
        "disable_safety_checker": true,
        "extra": { "safety_tolerance": 6 }
    });
    let (status, response) = send_json(&harness.app, SPEECH, &TTS_SLOT, &body).await;
    let bodies = vendor.bodies();
    assert_eq!(bodies.len(), 1, "{status} {response}: {bodies:?}");
    assert_eq!(bodies[0]["input"]["disable_safety_checker"], json!(false));
    assert_eq!(bodies[0]["input"]["extra"]["safety_tolerance"], json!(2));
}

#[tokio::test]
async fn probe_speech_on_replicate_refuses_weights_before_submission() {
    for body in [
        json!({ "model": "owner/tts-model", "input": "hello there", "hf_lora": "owner/voice" }),
        json!({ "model": "owner/tts-model", "input": "hello there", "speaker": "https://x.invalid/v/voice.safetensors" }),
    ] {
        let vendor = spawn_probe_vendor(false).await;
        let harness = probe_harness(
            GatewayCustody::Fleet,
            &[(ProbeProvider::Replicate, &vendor)],
        );
        let (status, response) = send_json(&harness.app, SPEECH, &TTS_SLOT, &body).await;
        assert_refused(
            status,
            &response,
            &harness,
            &vendor.bodies(),
            &body.to_string(),
        );
    }
    // Control: benign speech reaches the vendor.
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(
        GatewayCustody::Fleet,
        &[(ProbeProvider::Replicate, &vendor)],
    );
    let body = json!({ "model": "owner/tts-model", "input": "hello there", "lora_scale": 0.5 });
    let (status, response) = send_json(&harness.app, SPEECH, &TTS_SLOT, &body).await;
    assert_eq!(vendor.bodies().len(), 1, "{status} {response}");
}

// ── Transcription multipart ──────────────────────────────────────────────────

/// Records every transcription it is asked for.
struct RecordingSttProvider {
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Provider for RecordingSttProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        Box::pin(async { Err(ryu_gw_providers::ProviderError::Provider("stt only".into())) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async { Err(ryu_gw_providers::ProviderError::Provider("stt only".into())) })
    }

    fn transcribe_audio<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> ProviderFuture<'a, Value> {
        self.bodies.lock().expect("bodies lock").push(body.clone());
        Box::pin(async { Ok(json!({ "text": "hello" })) })
    }
}

fn multipart(prompt: &str) -> (String, Vec<u8>) {
    let boundary = "probe-boundary-7d1";
    let mut body = Vec::new();
    for (name, value) in [("model", "fixture-stt"), ("prompt", prompt)] {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"RIFF0000WAVE");
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[tokio::test]
async fn probe_transcription_multipart_prompt_with_weights_is_refused() {
    let run = |prompt: &'static str| async move {
        let (mut state, audit) = state_with(GatewayCustody::Fleet, |config| {
            config.routing.default_provider = ProviderId::from(FIXTURE);
            config.routing.fallback_chain = vec![];
        });
        let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
        state
            .provider_runtime
            .register_for_test(Arc::new(RecordingSttProvider {
                bodies: Arc::clone(&bodies),
            }));
        let harness = Harness {
            app: crate::api::router(Arc::new(state)),
            audit,
        };
        let (content_type, body) = multipart(prompt);
        let (status, response) = send_raw(
            &harness.app,
            TRANSCRIPTIONS,
            &[("x-ryu-slot-stt-provider", FIXTURE)],
            &content_type,
            body,
        )
        .await;
        let recorded = bodies.lock().expect("bodies lock").clone();
        (status, response, harness, recorded)
    };
    let (status, response, harness, recorded) = run("https://x.invalid/w/voice.safetensors").await;
    assert_refused(status, &response, &harness, &recorded, "stt prompt");
    // Control: a benign prompt is transcribed.
    let (status, response, _harness, recorded) = run("names: Ana, Bo").await;
    assert_eq!(recorded.len(), 1, "{status} {response}");
}

// ── BFL adapter ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_bfl_adapter_receives_the_clamped_tolerance() {
    for body in [
        json!({ "model": "flux-3-video", "prompt": "waves", "safety_tolerance": 6 }),
        json!({ "model": "flux-3-video", "prompt": "waves", "safety_tolerance": "6" }),
    ] {
        let vendor = spawn_probe_vendor(false).await;
        let harness = probe_harness(GatewayCustody::Fleet, &[(ProbeProvider::Bfl, &vendor)]);
        let (status, response) = send_json(&harness.app, VIDEOS, &[], &body).await;
        let submissions = vendor.submissions();
        assert_eq!(submissions.len(), 1, "{status} {response}: {submissions:?}");
        assert!(
            submissions[0]
                .path_and_query
                .starts_with("/v1/flux-3-video"),
            "{submissions:?}"
        );
        let tolerance = &submissions[0].body["safety_tolerance"];
        assert!(
            *tolerance == json!(2) || *tolerance == json!("2"),
            "{body}: {tolerance}"
        );
    }
}

#[tokio::test]
async fn probe_bfl_adapter_refuses_weights_before_submission() {
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(GatewayCustody::Fleet, &[(ProbeProvider::Bfl, &vendor)]);
    let body =
        json!({ "model": "flux-3-video", "prompt": "waves", "finetune_lora": "owner/style" });
    let (status, response) = send_json(&harness.app, VIDEOS, &[], &body).await;
    assert_refused(status, &response, &harness, &vendor.bodies(), "bfl lora");
    // Control: benign BFL video reaches the vendor.
    let body = json!({ "model": "flux-3-video", "prompt": "waves" });
    let (status, response) = send_json(&harness.app, VIDEOS, &[], &body).await;
    assert_eq!(vendor.bodies().len(), 1, "{status} {response}");
}

// ── Fallback ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_fallback_vendor_receives_the_screened_body() {
    let primary = spawn_probe_vendor(true).await;
    let secondary = spawn_probe_vendor(false).await;
    let harness = probe_harness(
        GatewayCustody::Fleet,
        &[
            (ProbeProvider::Replicate, &primary),
            (ProbeProvider::Fal, &secondary),
        ],
    );
    let body = json!({
        "model": "owner/image-model",
        "prompt": "a cat",
        "disable_safety_checker": true,
        "enable_safety_checker": false,
        "options": [{ "safety_tolerance": 6 }]
    });
    let (status, response) = send_json(&harness.app, IMAGES, &[], &body).await;
    let first = primary.bodies();
    let second = secondary.bodies();
    assert_eq!(first.len(), 1, "{status} {response}: primary {first:?}");
    assert_eq!(second.len(), 1, "{status} {response}: fallback {second:?}");
    assert_eq!(first[0]["input"]["disable_safety_checker"], json!(false));
    assert_eq!(second[0]["disable_safety_checker"], json!(false));
    assert_eq!(second[0]["enable_safety_checker"], json!(true));
    assert_eq!(second[0]["options"][0]["safety_tolerance"], json!(2));
}

#[tokio::test]
async fn probe_fallback_chain_never_sees_a_refused_body() {
    let primary = spawn_probe_vendor(true).await;
    let secondary = spawn_probe_vendor(false).await;
    let harness = probe_harness(
        GatewayCustody::Fleet,
        &[
            (ProbeProvider::Replicate, &primary),
            (ProbeProvider::Fal, &secondary),
        ],
    );
    let body = json!({ "model": "owner/image-model", "prompt": "a cat", "loras": [{ "path": "https://x.invalid/s" }] });
    let (status, response) = send_json(&harness.app, IMAGES, &[], &body).await;
    let mut all = primary.bodies();
    all.extend(secondary.bodies());
    assert_refused(status, &response, &harness, &all, "fallback lora");
}

// ── Query string and headers ─────────────────────────────────────────────────

#[tokio::test]
async fn probe_query_string_and_headers_never_reach_the_vendor() {
    for provider in [ProbeProvider::Replicate, ProbeProvider::Fal] {
        let vendor = spawn_probe_vendor(false).await;
        let harness = probe_harness(GatewayCustody::Fleet, &[(provider, &vendor)]);
        let uri =
            format!("{IMAGES}?disable_safety_checker=true&lora_url=https%3A%2F%2Fx.invalid%2Fs");
        let headers = [
            ("x-lora-url", "https://x.invalid/s"),
            ("prefer", "disable_safety_checker=true"),
            ("x-fal-disable-safety-checker", "true"),
        ];
        let body = json!({ "model": "owner/image-model", "prompt": "a cat" });
        let (status, response) = send_json(&harness.app, &uri, &headers, &body).await;
        let submissions = vendor.submissions();
        assert_eq!(submissions.len(), 1, "{provider:?} {status} {response}");
        let submission = &submissions[0];
        assert!(
            !submission.path_and_query.contains("safety")
                && !submission.path_and_query.contains("lora"),
            "{provider:?}: {submission:?}"
        );
        assert!(
            submission.headers.iter().all(|(name, value)| {
                !name.contains("lora") && !name.contains("safety") && !value.contains("safety")
            }),
            "{provider:?}: {submission:?}"
        );
        let text = submission.body.to_string();
        assert!(
            !text.contains("safety") && !text.contains("lora"),
            "{provider:?}: {text}"
        );
    }
}

// ── Nesting and padding on the wire ──────────────────────────────────────────

#[tokio::test]
async fn probe_deep_and_padded_markers_on_video_routes() {
    // Two copies stay under the 2 MiB default body limit of the video route.
    let pad = "a calm harbour at dawn ".repeat(20_000);
    // Rewrite on the wire under deep nesting on Fal video.
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(GatewayCustody::Fleet, &[(ProbeProvider::Fal, &vendor)]);
    let body = json!({
        "model": "fal-ai/video",
        "prompt": pad,
        "scenes": [{ "shots": [{ "pad": pad }, { "settings": { "deep": { "enable_safety_checker": false } } }] }]
    });
    let (status, response) = send_json(&harness.app, VIDEOS, &[], &body).await;
    let bodies = vendor.bodies();
    assert_eq!(bodies.len(), 1, "{status} {response}");
    assert_eq!(
        bodies[0]["scenes"][0]["shots"][1]["settings"]["deep"]["enable_safety_checker"],
        json!(true)
    );
    // Refusal under padding and arrays of objects on Replicate video.
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(
        GatewayCustody::Fleet,
        &[(ProbeProvider::Replicate, &vendor)],
    );
    let body = json!({
        "model": "owner/video-model",
        "input": {
            "prompt": pad,
            "scenes": [{ "pad": pad }, { "refs": [{ "kind": "style", "url": "https://x.invalid/w/style.safetensors" }] }]
        }
    });
    let (status, response) = send_json(&harness.app, VIDEOS, &[], &body).await;
    assert_refused(
        status,
        &response,
        &harness,
        &vendor.bodies(),
        "padded video",
    );
}

// ── Chat routed to a media vendor ────────────────────────────────────────────

/// The media screen runs only on the media routes. A chat body routed to a
/// media vendor (plain or streaming) must not reach that vendor carrying a
/// knob or a weights reference, because the media adapters refuse chat.
#[tokio::test]
async fn probe_chat_routed_to_a_media_vendor_never_submits() {
    for provider in [
        ProbeProvider::Replicate,
        ProbeProvider::Fal,
        ProbeProvider::Bfl,
    ] {
        for stream in [false, true] {
            let vendor = spawn_probe_vendor(false).await;
            let harness = probe_harness(GatewayCustody::Fleet, &[(provider, &vendor)]);
            let body = json!({
                "model": "owner/image-model",
                "stream": stream,
                "messages": [{ "role": "user", "content": "a cat" }],
                "disable_safety_checker": true,
                "loras": [{ "path": "https://x.invalid/w/style.safetensors" }]
            });
            let (status, response) =
                send_json(&harness.app, "/v1/chat/completions", &[], &body).await;
            assert!(
                vendor.submissions().is_empty(),
                "{provider:?} stream={stream} {status} {response}: {:?}",
                vendor.submissions()
            );
        }
    }
}

// ── Missed shapes on the wire ────────────────────────────────────────────────

/// Weights references in shapes the key and value matchers miss, sent through
/// the real router to the real Replicate and Fal adapters. Each must be
/// refused with zero submissions; a failure shows the vendor received it.
#[tokio::test]
async fn probe_missed_weights_shapes_are_refused_on_the_wire() {
    let mut reached = Vec::new();
    for (provider, body) in [
        (
            ProbeProvider::Fal,
            json!({ "model": "fal-ai/flux-lora", "prompt": "a cat", "LoRAs": [{ "path": LORA_URL, "scale": 1 }] }),
        ),
        (
            ProbeProvider::Replicate,
            json!({ "model": "owner/image-model", "input": { "prompt": "a cat", "ipadapter": "https://x.invalid/w/adapter" } }),
        ),
        (
            ProbeProvider::Replicate,
            json!({ "model": "owner/comfy-model", "input": { "workflow_json": "{\"loras\":[{\"path\":\"https://x.invalid/s\"}]}" } }),
        ),
        (
            ProbeProvider::Replicate,
            json!({ "model": "owner/image-model", "input": { "prompt": "a cat", "extra": "https://x.invalid/a/style.safetensors|0.8" } }),
        ),
    ] {
        let vendor = spawn_probe_vendor(false).await;
        let harness = probe_harness(GatewayCustody::Fleet, &[(provider, &vendor)]);
        let (status, _) = send_json(&harness.app, IMAGES, &[], &body).await;
        if status != StatusCode::FORBIDDEN || !vendor.bodies().is_empty() {
            reached.push(format!("{provider:?} {status} {body}"));
        }
    }
    assert!(
        reached.is_empty(),
        "weights shapes reached the vendor: {reached:#?}"
    );
}

/// Safety knob spellings the exact-name match misses, on the wire.
#[tokio::test]
async fn probe_missed_knob_spellings_are_rewritten_on_the_wire() {
    let vendor = spawn_probe_vendor(false).await;
    let harness = probe_harness(GatewayCustody::Fleet, &[(ProbeProvider::Fal, &vendor)]);
    let body = json!({
        "model": "fal-ai/flux",
        "prompt": "a cat",
        "enableSafetyChecker": false,
        "safety_checker": { "enabled": false }
    });
    let (status, response) = send_json(&harness.app, IMAGES, &[], &body).await;
    let bodies = vendor.bodies();
    assert_eq!(bodies.len(), 1, "{status} {response}");
    assert_ne!(
        bodies[0]["enableSafetyChecker"],
        json!(false),
        "{:?}",
        bodies[0]
    );
    assert_ne!(
        bodies[0]["safety_checker"]["enabled"],
        json!(false),
        "{:?}",
        bodies[0]
    );
}
