//! Media safety knobs and weights references on the hosted Gateway.
//!
//! The Replicate and Fal cases use the real providers pointed at a local
//! vendor mock that records every submission body, so a refusal proves
//! nothing was sent and a rewrite is checked on the wire. The BFL-shaped case
//! uses a recording fixture provider, because the rewrite happens before any
//! provider is chosen and the BFL adapter forwards those fields verbatim.
//! Every refused case asserts 403 `media_unscreenable`, zero submissions and
//! one audit row, and has a benign control that dispatches.
use super::*;

use axum::{http::Uri, routing::any};

const IMAGES: &str = "/v1/images/generations";
const VIDEOS: &str = "/v1/videos/generations";
/// Section 02.17 B34: a LoRA weights URL under an otherwise benign request.
const LORA_URL: &str = "https://x.invalid/style.safetensors";

/// A local vendor that records each submission body and answers like a
/// finished Replicate prediction or a completed Fal queue request.
struct MediaVendor {
    base: String,
    submissions: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl MediaVendor {
    fn submissions(&self) -> Vec<Value> {
        self.submissions.lock().expect("submissions lock").clone()
    }
}

impl Drop for MediaVendor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_media_vendor() -> MediaVendor {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("media vendor binds");
    let base = format!("http://{}", listener.local_addr().expect("vendor address"));
    let submissions: Arc<Mutex<Vec<Value>>> = Arc::default();
    let recorded = Arc::clone(&submissions);
    let result_url = format!("{base}/result");
    let submit = move |method: Method, uri: Uri, body: axum::body::Bytes| {
        let recorded = Arc::clone(&recorded);
        let result_url = result_url.clone();
        async move {
            if method == Method::POST {
                recorded
                    .lock()
                    .expect("submissions lock")
                    .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            }
            if uri.path().ends_with("/predictions") {
                Json(json!({
                    "id": "pred-1",
                    "status": "succeeded",
                    "output": ["https://x.invalid/o.png"]
                }))
            } else {
                Json(
                    json!({ "status": "COMPLETED", "request_id": "req-1", "response_url": result_url }),
                )
            }
        }
    };
    let router = Router::new()
        .route(
            "/result",
            axum::routing::get(|| async {
                Json(json!({ "images": [{ "url": "https://x.invalid/i.png" }] }))
            }),
        )
        .route("/predictions/pred-1", axum::routing::get(|| async {
            Json(json!({ "id": "pred-1", "status": "succeeded", "output": ["https://x.invalid/o.mp4"] }))
        }))
        .fallback(any(submit));
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("media vendor serves");
    });
    MediaVendor {
        base,
        submissions,
        task,
    }
}

fn vendor_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("vendor client")
}

#[derive(Clone, Copy, Debug)]
enum Vendor {
    Replicate,
    Fal,
}

fn vendor_harness(custody: GatewayCustody, vendor: Vendor, upstream: &MediaVendor) -> Harness {
    let name = match vendor {
        Vendor::Replicate => "replicate",
        Vendor::Fal => "fal",
    };
    let (mut state, audit) = state_with(custody, |config| {
        config.routing.default_provider = ProviderId::from(name);
        config.routing.fallback_chain = vec![];
    });
    let client = vendor_client();
    let base = upstream.base.clone();
    let provider: Arc<dyn Provider> = match vendor {
        Vendor::Replicate => Arc::new(ryu_gw_providers::ReplicateProvider::new(
            client,
            "vendor-secret".into(),
            base,
            1,
            2,
        )),
        Vendor::Fal => Arc::new(ryu_gw_providers::FalProvider::new(
            client,
            "vendor-secret".into(),
            base,
            1,
            2,
        )),
    };
    state.provider_runtime.register_for_test(provider);
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

/// Records every image body it is asked to generate.
struct RecordingImageProvider {
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Provider for RecordingImageProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "images only".into(),
            ))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "images only".into(),
            ))
        })
    }

    fn generate_image<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.bodies.lock().expect("bodies lock").push(body.clone());
        Box::pin(async {
            Ok(json!({ "created": 0, "data": [{ "url": "https://x.invalid/i.png" }] }))
        })
    }
}

fn recording_harness(custody: GatewayCustody) -> (Harness, Arc<Mutex<Vec<Value>>>) {
    let (mut state, audit) = state_with(custody, |config| {
        config.routing.default_provider = ProviderId::from(FIXTURE);
        config.routing.fallback_chain = vec![];
    });
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    state
        .provider_runtime
        .register_for_test(Arc::new(RecordingImageProvider {
            bodies: Arc::clone(&bodies),
        }));
    (
        Harness {
            app: crate::api::router(Arc::new(state)),
            audit,
        },
        bodies,
    )
}

async fn post_media(harness: &Harness, uri: &str, body: &Value) -> (StatusCode, Value) {
    send(&harness.app, uri, Some(MASTER), body, true).await
}

fn assert_refused(
    status: StatusCode,
    body: &Value,
    harness: &Harness,
    submissions: &[Value],
    case: &str,
) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{case}: {body}");
    assert_eq!(body["error"]["type"], "policy_violation", "{case}");
    assert_eq!(body["error"]["code"], "media_unscreenable", "{case}");
    assert_eq!(body["error"]["layer"], "platform", "{case}");
    assert_eq!(body["error"]["remedy"], "none", "{case}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(!message.contains("x.invalid"), "{case}: {message}");
    assert!(!message.contains("safetensors"), "{case}: {message}");
    assert!(
        submissions.is_empty(),
        "{case}: the vendor received {submissions:?}"
    );
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{case}: {rows:?}");
    assert!(
        rows[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("media_unscreenable")),
        "{case}: {rows:?}"
    );
}

fn assert_dispatched(status: StatusCode, body: &Value, case: &str) {
    assert!(status.is_success(), "{case}: {status} {body}");
}

// ── Safety knobs (B31) ───────────────────────────────────────────────────────

#[tokio::test]
async fn fleet_forces_disable_safety_checker_off_on_replicate() {
    for (uri, body) in [
        (
            IMAGES,
            json!({ "model": "owner/image-model", "prompt": "a cat", "disable_safety_checker": true }),
        ),
        (
            IMAGES,
            json!({ "model": "owner/image-model", "input": { "prompt": "a cat", "disable_safety_checker": true } }),
        ),
        (
            VIDEOS,
            json!({ "model": "owner/video-model", "prompt": "waves", "disable_safety_checker": true }),
        ),
        (
            VIDEOS,
            json!({ "model": "owner/video-model", "input": { "prompt": "waves", "disable_safety_checker": true } }),
        ),
    ] {
        let upstream = spawn_media_vendor().await;
        let harness = vendor_harness(GatewayCustody::Fleet, Vendor::Replicate, &upstream);
        let (status, response) = post_media(&harness, uri, &body).await;
        assert_dispatched(status, &response, &format!("{uri} {body}"));
        let submissions = upstream.submissions();
        assert_eq!(submissions.len(), 1, "{uri} {body}: {submissions:?}");
        assert_eq!(
            submissions[0]["input"]["disable_safety_checker"],
            json!(false),
            "{uri} {body}: {submissions:?}"
        );
    }
}

#[tokio::test]
async fn fleet_forces_the_fal_safety_checker_on_without_inserting_it() {
    let upstream = spawn_media_vendor().await;
    let harness = vendor_harness(GatewayCustody::Fleet, Vendor::Fal, &upstream);
    let body = json!({
        "model": "fal-ai/flux",
        "prompt": "a cat",
        "enable_safety_checker": false,
        "safety_tolerance": "6"
    });
    let (status, response) = post_media(&harness, IMAGES, &body).await;
    assert_dispatched(status, &response, "fal knobs");
    let plain = json!({ "model": "fal-ai/flux", "prompt": "a cat" });
    let (status, response) = post_media(&harness, IMAGES, &plain).await;
    assert_dispatched(status, &response, "fal plain");

    let submissions = upstream.submissions();
    assert_eq!(submissions.len(), 2, "{submissions:?}");
    assert_eq!(submissions[0]["enable_safety_checker"], json!(true));
    assert_eq!(submissions[0]["safety_tolerance"], json!("2"));
    assert!(
        submissions[1].get("enable_safety_checker").is_none(),
        "a knob the caller did not send must not be inserted: {submissions:?}"
    );
    assert!(submissions[1].get("safety_tolerance").is_none());
}

#[tokio::test]
async fn fleet_clamps_a_bfl_style_safety_tolerance() {
    let (harness, bodies) = recording_harness(GatewayCustody::Fleet);
    let body = json!({ "model": "fixture-image", "prompt": "a cat", "safety_tolerance": 6 });
    let (status, response) = post_media(&harness, IMAGES, &body).await;
    assert_dispatched(status, &response, "bfl tolerance");
    let bodies = bodies.lock().expect("bodies lock").clone();
    assert_eq!(bodies.len(), 1, "{bodies:?}");
    assert_eq!(bodies[0]["safety_tolerance"], json!(2));
}

#[tokio::test]
async fn control_other_custodies_forward_safety_knobs_unchanged() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_media_vendor().await;
        let harness = vendor_harness(custody, Vendor::Replicate, &upstream);
        let body = json!({
            "model": "owner/image-model",
            "input": { "prompt": "a cat", "disable_safety_checker": true, "safety_tolerance": 6 }
        });
        let (status, response) = post_media(&harness, IMAGES, &body).await;
        assert_dispatched(status, &response, &format!("{custody:?}"));
        let submissions = upstream.submissions();
        assert_eq!(submissions.len(), 1, "{custody:?}: {submissions:?}");
        assert_eq!(
            submissions[0]["input"]["disable_safety_checker"],
            json!(true),
            "{custody:?}"
        );
        assert_eq!(submissions[0]["input"]["safety_tolerance"], json!(6));
    }
}

// ── Weights references (B34) ─────────────────────────────────────────────────

#[tokio::test]
async fn fleet_refuses_weights_references_before_any_submission() {
    for (vendor, uri, body) in [
        (
            Vendor::Replicate,
            IMAGES,
            json!({ "model": "owner/image-model", "input": { "prompt": "a cat", "loras": [{ "path": LORA_URL }] } }),
        ),
        (
            Vendor::Fal,
            IMAGES,
            json!({ "model": "fal-ai/flux-lora", "prompt": "a cat", "loras": [{ "path": LORA_URL, "scale": 1 }] }),
        ),
        (
            Vendor::Replicate,
            IMAGES,
            json!({ "model": "owner/image-model", "prompt": "a cat", "lora_weights": "owner/style" }),
        ),
        (
            Vendor::Replicate,
            IMAGES,
            json!({ "model": "owner/image-model", "prompt": "a cat", "extra": "https://x.invalid/Y.SAFETENSORS?download=true" }),
        ),
        (
            Vendor::Replicate,
            VIDEOS,
            json!({ "model": "owner/video-model", "prompt": "waves", "hf_lora": "owner/style" }),
        ),
        (
            Vendor::Fal,
            VIDEOS,
            json!({ "model": "fal-ai/video", "prompt": "waves", "weights": "https://x.invalid/w.ckpt" }),
        ),
    ] {
        let upstream = spawn_media_vendor().await;
        let harness = vendor_harness(GatewayCustody::Fleet, vendor, &upstream);
        let (status, response) = post_media(&harness, uri, &body).await;
        assert_refused(
            status,
            &response,
            &harness,
            &upstream.submissions(),
            &format!("{vendor:?} {uri} {body}"),
        );
    }
}

#[tokio::test]
async fn control_benign_fleet_media_still_dispatches() {
    for (vendor, uri, body) in [
        (
            Vendor::Replicate,
            IMAGES,
            json!({ "model": "owner/image-model", "input": { "prompt": "a cat", "lora_scale": 0.8, "image": "https://x.invalid/cat.png" } }),
        ),
        (
            Vendor::Fal,
            IMAGES,
            json!({ "model": "fal-ai/flux", "prompt": "a recycling bin by loja.pt", "loras": [] }),
        ),
        (
            Vendor::Replicate,
            VIDEOS,
            json!({ "model": "owner/video-model", "prompt": "waves" }),
        ),
    ] {
        let upstream = spawn_media_vendor().await;
        let harness = vendor_harness(GatewayCustody::Fleet, vendor, &upstream);
        let (status, response) = post_media(&harness, uri, &body).await;
        assert_dispatched(status, &response, &format!("{vendor:?} {uri} {body}"));
        assert_eq!(upstream.submissions().len(), 1, "{vendor:?} {uri} {body}");
    }
}

#[tokio::test]
async fn control_other_custodies_forward_weights_references() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_media_vendor().await;
        let harness = vendor_harness(custody, Vendor::Replicate, &upstream);
        let body = json!({
            "model": "owner/image-model",
            "input": { "prompt": "a cat", "loras": [{ "path": LORA_URL }] }
        });
        let (status, response) = post_media(&harness, IMAGES, &body).await;
        assert_dispatched(status, &response, &format!("{custody:?}"));
        let submissions = upstream.submissions();
        assert_eq!(submissions.len(), 1, "{custody:?}: {submissions:?}");
        assert_eq!(
            submissions[0]["input"]["loras"][0]["path"],
            json!(LORA_URL),
            "{custody:?}"
        );
    }
}

/// Spec 03.3: a tenant identifier in a media body never reaches the vendor on
/// the fleet, on the image path or the job-based video path.
#[tokio::test]
async fn fleet_strips_tenant_identifiers_from_media_submissions() {
    for vendor in [Vendor::Replicate, Vendor::Fal] {
        for uri in [IMAGES, VIDEOS] {
            let upstream = spawn_media_vendor().await;
            let harness = vendor_harness(GatewayCustody::Fleet, vendor, &upstream);
            let body = json!({
                "model": "owner/media-model",
                "prompt": "waves",
                "user": "RYU_TEST_LEXICON-user",
                "safety_identifier": "RYU_TEST_LEXICON-safety",
                "metadata": { "user_id": "RYU_TEST_LEXICON-meta" }
            });
            let (status, response) = post_media(&harness, uri, &body).await;
            assert_dispatched(status, &response, &format!("{vendor:?} {uri}"));
            let submissions = upstream.submissions();
            assert_eq!(submissions.len(), 1, "{vendor:?} {uri}: {submissions:?}");
            let wire = submissions[0].to_string();
            assert!(
                !wire.contains("RYU_TEST_LEXICON"),
                "{vendor:?} {uri}: {wire}"
            );
            assert!(wire.contains("waves"), "{vendor:?} {uri}: {wire}");
        }
    }
}

#[cfg(test)]
mod probe;
