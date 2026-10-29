//! Mock engines for tests (screener addendum section 4.5): `MockServer::guard`
//! speaks the llama-server chat wire in either guard dialect, and
//! `MockServer::systemone` returns systemone probability maps. Both answer
//! from the spec 00.9 sentinels, so every adapter's parsing runs in CI without
//! a model. Compiled only for tests and the `test-backends` feature.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Value};

use crate::backend::{CodeSet, TaxonomyId};
use crate::backends::guard_model::GuardDialect;
use crate::backends::test::sentinel_codes;

/// How a mock answers. Defaults to a well-behaved engine.
#[derive(Debug, Clone, Default)]
pub struct MockBehaviour {
    pub delay: Option<Duration>,
    /// Answer every POST with this status (and `location` for a redirect).
    pub status: Option<u16>,
    pub location: Option<String>,
    /// Answer every POST with this exact body.
    pub raw_body: Option<String>,
    /// Send the body without a content length, in chunks.
    pub chunked: bool,
    /// Guard wire: replace the generated `message.content`.
    pub reply: Option<String>,
    /// Guard wire: attach first-token logprobs.
    pub logprobs: bool,
    /// Guard wire: model ids served by `GET /models`.
    pub models: Vec<String>,
}

/// One request a mock received.
#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl CapturedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, Copy)]
enum Wire {
    Guard(GuardDialect),
    Systemone,
}

struct MockState {
    wire: Wire,
    posts: AtomicUsize,
    requests: Mutex<Vec<CapturedRequest>>,
    behaviour: Mutex<MockBehaviour>,
}

/// A running mock engine on `127.0.0.1`.
pub struct MockServer {
    pub base_url: String,
    state: Arc<MockState>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    /// A llama-server style guard engine; `base_url` ends in `/v1`.
    pub async fn guard(dialect: GuardDialect) -> Self {
        Self::start(Wire::Guard(dialect), "/v1").await
    }

    /// A systemone decision server; `base_url` is the full `/v1/systemone` URL.
    pub async fn systemone() -> Self {
        Self::start(Wire::Systemone, "/v1/systemone").await
    }

    async fn start(wire: Wire, path: &str) -> Self {
        let state = Arc::new(MockState {
            wire,
            posts: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
            behaviour: Mutex::new(MockBehaviour {
                models: vec!["mock-guard".into()],
                logprobs: true,
                ..MockBehaviour::default()
            }),
        });
        let app = Router::new().fallback(handle).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock");
        let addr = listener.local_addr().expect("mock addr");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base_url: format!("http://{addr}{path}"),
            state,
            task,
        }
    }

    pub fn set(&self, change: impl FnOnce(&mut MockBehaviour)) {
        change(
            &mut self
                .state
                .behaviour
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
    }

    /// POST requests received (screens and canaries, not model listings).
    pub fn calls(&self) -> usize {
        self.state.posts.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.state
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

async fn handle(
    State(state): State<Arc<MockState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let behaviour = state
        .behaviour
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(CapturedRequest {
            method: method.to_string(),
            path: uri.path().to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect(),
            body: parsed.clone(),
        });

    if method == Method::GET {
        if uri.path().ends_with("/models") {
            let data: Vec<Value> = behaviour
                .models
                .iter()
                .map(|id| json!({"id": id}))
                .collect();
            return axum::Json(json!({"object": "list", "data": data})).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    }
    state.posts.fetch_add(1, Ordering::SeqCst);
    if let Some(delay) = behaviour.delay {
        tokio::time::sleep(delay).await;
    }
    if let Some(status) = behaviour.status {
        let mut response = StatusCode::from_u16(status)
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
            .into_response();
        if let Some(location) = &behaviour.location {
            if let Ok(value) = location.parse() {
                response.headers_mut().insert("location", value);
            }
        }
        return response;
    }
    let text = match &behaviour.raw_body {
        Some(raw) => raw.clone(),
        None => match state.wire {
            Wire::Guard(dialect) => guard_reply(dialect, &parsed, &behaviour).to_string(),
            Wire::Systemone => systemone_reply(&parsed).to_string(),
        },
    };
    let mut response = if behaviour.chunked {
        let chunks: Vec<Result<Bytes, std::io::Error>> = text
            .into_bytes()
            .chunks(4096)
            .map(|c| Ok(Bytes::copy_from_slice(c)))
            .collect();
        Response::new(Body::from_stream(futures_util::stream::iter(chunks)))
    } else {
        Response::new(Body::from(text))
    };
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().expect("header"));
    response
}

/// Every text in a chat body, user and assistant, including content parts.
fn chat_text(body: &Value) -> String {
    let mut out = String::new();
    for message in body["messages"].as_array().into_iter().flatten() {
        match &message["content"] {
            Value::String(s) => out.push_str(s),
            Value::Array(parts) => {
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        out.push_str(t);
                    }
                }
            }
            _ => {}
        }
        out.push('\n');
    }
    out
}

fn guard_reply(dialect: GuardDialect, body: &Value, behaviour: &MockBehaviour) -> Value {
    let hits = sentinel_codes(&chat_text(body));
    let content = behaviour.reply.clone().unwrap_or_else(|| match dialect {
        GuardDialect::LlamaGuard => {
            let shorts: Vec<&str> = hits.iter().filter_map(TaxonomyId::short).collect();
            if shorts.is_empty() {
                "safe".to_string()
            } else {
                format!("unsafe\n{}", shorts.join(","))
            }
        }
        GuardDialect::Qwen3Guard => {
            let mut labels = Vec::new();
            if hits.contains(TaxonomyId::S1) {
                labels.push("Violent");
            }
            if hits.contains(TaxonomyId::PROMPT_INJECTION) {
                labels.push("Jailbreak");
            }
            if labels.is_empty() {
                "Safety: Safe\nCategories: None".to_string()
            } else {
                format!("Safety: Unsafe\nCategories: {}", labels.join(", "))
            }
        }
    });
    let mut choice = json!({
        "index": 0,
        "message": {"role": "assistant", "content": content},
        "finish_reason": "stop",
    });
    let wants_logprobs = body["logprobs"].as_bool().unwrap_or(false);
    if behaviour.logprobs && wants_logprobs && matches!(dialect, GuardDialect::LlamaGuard) {
        let unsafe_reply = content.trim_start().starts_with("unsafe");
        let (first, p_first, other) = if unsafe_reply {
            ("unsafe", 0.9f64, "safe")
        } else {
            ("safe", 0.97f64, "unsafe")
        };
        choice["logprobs"] = json!({"content": [{
            "token": first,
            "logprob": p_first.ln(),
            "top_logprobs": [
                {"token": first, "logprob": p_first.ln()},
                {"token": other, "logprob": (1.0 - p_first).ln()},
            ],
        }]});
    }
    json!({"object": "chat.completion", "choices": [choice]})
}

fn yes_no(yes: bool) -> Value {
    if yes {
        json!({"choice": "yes", "probabilities": {"no": 0.1, "yes": 0.9}})
    } else {
        json!({"choice": "no", "probabilities": {"no": 0.97, "yes": 0.03}})
    }
}

fn systemone_reply(body: &Value) -> Value {
    let message = body["state"]["message"].as_str().unwrap_or("");
    let hits: CodeSet = sentinel_codes(message);
    let soft = hits
        .iter()
        .filter(|c| *c != TaxonomyId::S4 && *c != TaxonomyId::S9)
        .find_map(TaxonomyId::short);
    let options = [
        "S1", "S2", "S3", "S5", "S6", "S7", "S8", "S10", "S11", "S12", "S13", "S14", "none",
    ];
    let top = soft.unwrap_or("none");
    let rest = 0.1 / (options.len() as f64 - 1.0);
    let probabilities: serde_json::Map<String, Value> = options
        .iter()
        .map(|o| ((*o).to_string(), json!(if *o == top { 0.9 } else { rest })))
        .collect();
    let any = !hits.is_empty();
    json!({"answers": {
        "s4": yes_no(hits.contains(TaxonomyId::S4)),
        "s9": yes_no(hits.contains(TaxonomyId::S9)),
        "category": {"choice": top, "probabilities": probabilities},
        "verdict": if any {
            json!({"choice": "block", "probabilities": {"allow": 0.05, "flag": 0.05, "block": 0.9}})
        } else {
            json!({"choice": "allow", "probabilities": {"allow": 0.9, "flag": 0.05, "block": 0.05}})
        },
        "prompt_attack": yes_no(hits.contains(TaxonomyId::PROMPT_INJECTION)),
    }, "usage": {"input_tokens": 10}})
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::backend::{
        BackendError, BackendHealth, ConfidenceSource, Direction, LeafClass, Locality, ScreenItem,
        ScreenRequest, ScreenTier, ScreenerBackend,
    };
    use crate::backends::decision::{DecisionBackend, DecisionConfig, RemotePermit};
    use crate::backends::guard_model::{GuardModelBackend, GuardModelConfig};
    use crate::backends::inspector::{InspectorBackend, InspectorConfig, InspectorFocus};
    use crate::backends::test::{SENTINEL_HAZARD_S1, SENTINEL_HAZARD_S9, SENTINEL_PROMPT_ATTACK};
    use crate::cache::SegmentKey;
    use crate::chain::{ChainPolicy, QualificationRecord, Role, ScreenerChain};

    fn item(text: &str) -> ScreenItem {
        ScreenItem::text(
            SegmentKey::for_text(b"org", LeafClass::User, text),
            LeafClass::User,
            text.to_string(),
        )
    }

    fn req<'a>(
        items: &'a [ScreenItem],
        wanted: &'a CodeSet,
        tier: ScreenTier,
        ms: u64,
    ) -> ScreenRequest<'a> {
        ScreenRequest {
            correlation_id: "corr-42",
            direction: Direction::Inbound,
            tier,
            items,
            wanted,
            deadline: Instant::now() + Duration::from_millis(ms),
        }
    }

    fn guard(mock: &MockServer, dialect: GuardDialect, timeout_ms: u32) -> GuardModelBackend {
        GuardModelBackend::new(GuardModelConfig {
            id: "guard_text".into(),
            base_url: mock.base_url.clone(),
            locality: Locality::Loopback,
            model: "mock-guard".into(),
            weights_sha256: Some("abcdef0123456789".into()),
            template_version: 1,
            dialect,
            images: false,
            bearer: None,
            hard_timeout_ms: timeout_ms,
            max_concurrency: 2,
        })
        .unwrap()
    }

    fn decision_config(url: &str, id: &str) -> DecisionConfig {
        DecisionConfig {
            id: id.into(),
            url: url.into(),
            model: "laya".into(),
            weights_sha256: Some("0123456789abcdef0123".into()),
            hard_timeout_ms: 800,
            max_concurrency: 4,
        }
    }

    fn jev(mock: &MockServer, permit: RemotePermit) -> DecisionBackend {
        DecisionBackend::remote_plaintext_for_test(
            decision_config(&mock.base_url, "jev"),
            "typesafe",
            Some("screener-key".into()),
            permit,
        )
        .unwrap()
    }

    fn score_of(v: &crate::backend::BackendVerdict, code: TaxonomyId) -> f32 {
        v.items[0].score(code).unwrap()
    }

    #[tokio::test]
    async fn llama_guard_over_the_wire() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        let backend = guard(&mock, GuardDialect::LlamaGuard, 800);
        let wanted = CodeSet::hazards();
        let items = [item(&format!("context {SENTINEL_HAZARD_S9}"))];
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert!((score_of(&v, TaxonomyId::S9) - 0.9).abs() < 1e-4);
        assert_eq!(v.items[0].confidence, ConfidenceSource::Logprob);
        assert_eq!(score_of(&v, TaxonomyId::S1), 0.0);

        let items = [item("plain question")];
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert!(score_of(&v, TaxonomyId::S9) < 0.05);

        let captured = mock.requests();
        assert_eq!(captured[0].path, "/v1/chat/completions");
        assert_eq!(captured[0].header("x-correlation-id"), Some("corr-42"));
        assert!(captured[0]
            .headers
            .iter()
            .all(|(k, _)| !k.starts_with("x-ryu")));
        assert_eq!(captured[0].header("authorization"), None);
    }

    #[tokio::test]
    async fn guard_without_logprobs_uses_fixed_confidence() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        mock.set(|b| b.logprobs = false);
        let backend = guard(&mock, GuardDialect::LlamaGuard, 800);
        let wanted = CodeSet::hazards();
        let items = [item(SENTINEL_HAZARD_S1)];
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert_eq!(v.items[0].confidence, ConfidenceSource::Fixed);
        assert_eq!(score_of(&v, TaxonomyId::S1), 0.95);
    }

    #[tokio::test]
    async fn guard_out_of_grammar_reply_is_malformed() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        mock.set(|b| b.reply = Some("I think this is fine.".into()));
        let backend = guard(&mock, GuardDialect::LlamaGuard, 800);
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Malformed);
    }

    #[tokio::test]
    async fn qwen3guard_over_the_wire() {
        let mock = MockServer::guard(GuardDialect::Qwen3Guard).await;
        let backend = guard(&mock, GuardDialect::Qwen3Guard, 800);
        let wanted = CodeSet::hazards();
        let items = [item(&format!(
            "{SENTINEL_HAZARD_S1} {SENTINEL_PROMPT_ATTACK}"
        ))];
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert_eq!(score_of(&v, TaxonomyId::S1), 0.95);
        assert_eq!(score_of(&v, TaxonomyId::PROMPT_INJECTION), 0.95);
        assert!(!v.items[0].covered.contains(TaxonomyId::S4));
    }

    #[tokio::test]
    async fn guard_probe_checks_the_served_model() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        let backend = guard(&mock, GuardDialect::LlamaGuard, 800);
        assert_eq!(backend.probe().await, BackendHealth::Ready);
        mock.set(|b| b.models = vec!["something-else".into()]);
        assert_eq!(
            backend.probe().await,
            BackendHealth::Down("model_not_served")
        );
    }

    #[tokio::test]
    async fn slow_engine_times_out_at_the_hard_timeout() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        mock.set(|b| b.delay = Some(Duration::from_millis(1_500)));
        let backend = Arc::new(guard(&mock, GuardDialect::LlamaGuard, 100));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![backend]);
        let wanted = CodeSet::hazards();
        let items = [item(SENTINEL_HAZARD_S9)];
        let started = Instant::now();
        let v = chain
            .screen(
                Role::TextHazard,
                &req(&items, &wanted, ScreenTier::Floor, 600),
            )
            .await;
        assert!(started.elapsed() < Duration::from_millis(1_000));
        assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
        assert!(v.undecided_hard(chain.policy()).contains(TaxonomyId::S9));
    }

    #[tokio::test]
    async fn local_decision_model_over_the_wire() {
        let mock = MockServer::systemone().await;
        let backend = DecisionBackend::local(
            decision_config(&mock.base_url, "decision_local"),
            Locality::Loopback,
        )
        .unwrap();
        let wanted = CodeSet::hazards();
        let items = [item(SENTINEL_HAZARD_S9).with_context("earlier turn")];
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert!((score_of(&v, TaxonomyId::S9) - 0.9).abs() < 1e-6);
        assert!((score_of(&v, TaxonomyId::S4) - 0.03).abs() < 1e-6);
        assert_eq!(v.items[0].confidence, ConfidenceSource::ProbabilityMap);
        let body = &mock.requests()[0].body;
        assert_eq!(body["model"], "laya");
        assert_eq!(body["state"]["context"], "earlier turn");
        assert_eq!(body["state"]["message"], SENTINEL_HAZARD_S9);
        assert_eq!(backend.probe().await, BackendHealth::Ready);
    }

    #[tokio::test]
    async fn remote_without_permit_never_connects() {
        let mock = MockServer::systemone().await;
        let backend = jev(&mock, RemotePermit::new());
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        for tier in [ScreenTier::Floor, ScreenTier::Node] {
            let err = backend
                .screen(&req(&items, &wanted, tier, 2_000))
                .await
                .unwrap_err();
            assert_eq!(err, BackendError::NotPermitted);
        }
        assert_eq!(backend.probe().await, BackendHealth::NotPermitted);
        assert_eq!(mock.calls(), 0);
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn node_opt_in_never_opens_floor_traffic() {
        let mock = MockServer::systemone().await;
        let permit = RemotePermit::new();
        permit.set_node_opt_in(true);
        let backend = jev(&mock, permit);
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::NotPermitted);
        assert!(backend
            .screen(&req(&items, &wanted, ScreenTier::Node, 2_000))
            .await
            .is_ok());
        assert_eq!(mock.calls(), 1);
    }

    #[tokio::test]
    async fn remote_sees_only_the_body_and_its_bearer() {
        let mock = MockServer::systemone().await;
        let permit = RemotePermit::new();
        permit.set_floor_record(true);
        let backend = jev(&mock, permit);
        let wanted = CodeSet::hazards();
        let items = [item(SENTINEL_HAZARD_S9)];
        backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        let captured = &mock.requests()[0];
        let mut keys: Vec<&str> = captured
            .body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["model", "questions", "state"]);
        assert_eq!(
            captured.header("authorization"),
            Some("Bearer screener-key")
        );
        assert_eq!(captured.header("x-correlation-id"), None);
        assert!(
            captured.headers.iter().all(|(k, _)| !k.starts_with("x-")),
            "{:?}",
            captured.headers
        );
    }

    // SB-9: a redirect is never followed.
    #[tokio::test]
    async fn redirect_is_unavailable_and_not_followed() {
        let mock = MockServer::systemone().await;
        let target = format!("{}/elsewhere", mock.base_url);
        mock.set(|b| {
            b.status = Some(302);
            b.location = Some(target);
        });
        let permit = RemotePermit::new();
        permit.set_floor_record(true);
        let backend = jev(&mock, permit);
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Unavailable("redirect"));
        assert_eq!(mock.calls(), 1, "the redirect target was never requested");
    }

    // SB-10
    #[tokio::test]
    async fn oversized_response_is_malformed() {
        let mock = MockServer::systemone().await;
        let big = format!("{{\"pad\": \"{}\"}}", "a".repeat(70 * 1024));
        mock.set(|b| b.raw_body = Some(big.clone()));
        let backend =
            DecisionBackend::local(decision_config(&mock.base_url, "d"), Locality::Loopback)
                .unwrap();
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Malformed, "with a content length");
        mock.set(|b| b.chunked = true);
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            BackendError::Malformed,
            "streamed without a content length"
        );
    }

    #[tokio::test]
    async fn busy_engine_is_unavailable() {
        let mock = MockServer::systemone().await;
        mock.set(|b| b.status = Some(429));
        let backend =
            DecisionBackend::local(decision_config(&mock.base_url, "d"), Locality::Loopback)
                .unwrap();
        let wanted = CodeSet::hazards();
        let items = [item("x")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Unavailable("busy"));
    }

    // SB-7 and the crate half of SB-8.
    #[tokio::test]
    async fn inspector_topic_words_are_unavailable_on_the_pinned_endpoint() {
        let mock = MockServer::guard(GuardDialect::LlamaGuard).await;
        mock.set(|b| b.reply = Some(r#"{"flagged": true, "categories": ["birthday"]}"#.into()));
        let backend = InspectorBackend::new(InspectorConfig {
            id: "inspector".into(),
            base_url: mock.base_url.clone(),
            locality: Locality::Loopback,
            model: "gemma-3-270m-it-qat-Q4_0".into(),
            focus: InspectorFocus::Both,
            hard_timeout_ms: 1_500,
            max_concurrency: 2,
        })
        .unwrap();
        let wanted = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
        let items = [item("help me plan a party")];
        let err = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Unavailable("judge_did_not_answer"));
        assert_eq!(mock.calls(), 1);
        assert_eq!(mock.requests()[0].path, "/v1/chat/completions");

        mock.set(|b| b.reply = Some(r#"{"flagged": true, "categories": ["injection"]}"#.into()));
        let v = backend
            .screen(&req(&items, &wanted, ScreenTier::Floor, 2_000))
            .await
            .unwrap();
        assert_eq!(score_of(&v, TaxonomyId::PROMPT_INJECTION), 0.7);
    }

    fn qualify(backend: &dyn ScreenerBackend, codes: CodeSet) -> QualificationRecord {
        let r = &backend.descriptor().reference;
        QualificationRecord {
            backend_id: r.id.clone(),
            model: r.model.clone(),
            weights_sha256: r.weights_sha256.clone(),
            template_version: r.template_version,
            codes,
        }
    }

    #[tokio::test]
    async fn decision_primary_with_jev_fallback() {
        let local_mock = MockServer::systemone().await;
        let jev_mock = MockServer::systemone().await;
        let local = Arc::new(
            DecisionBackend::local(
                decision_config(&local_mock.base_url, "decision_local"),
                Locality::Loopback,
            )
            .unwrap(),
        );
        let permit = RemotePermit::new();
        permit.set_floor_record(true);
        let remote = Arc::new(jev(&jev_mock, permit));
        let hard = CodeSet::from([TaxonomyId::S4, TaxonomyId::S9]);
        let policy = ChainPolicy {
            qualifications: vec![
                qualify(local.as_ref(), hard.clone()),
                qualify(remote.as_ref(), hard),
            ],
            ..ChainPolicy::default()
        };
        let chain = ScreenerChain::new(policy).with_role(Role::TextHazard, vec![local, remote]);
        let wanted = CodeSet::hazards();
        let items = [item(SENTINEL_HAZARD_S9)];

        let v = chain
            .screen(
                Role::TextHazard,
                &req(&items, &wanted, ScreenTier::Floor, 2_000),
            )
            .await;
        assert!((v.max_score(TaxonomyId::S9).unwrap() - 0.9).abs() < 1e-6);
        assert_eq!(
            jev_mock.calls(),
            0,
            "local decided, so the third party saw nothing"
        );
        assert!(v.processors.is_empty());

        local_mock.set(|b| b.status = Some(503));
        let v = chain
            .screen(
                Role::TextHazard,
                &req(&items, &wanted, ScreenTier::Floor, 2_000),
            )
            .await;
        assert_eq!(jev_mock.calls(), 1);
        assert_eq!(v.processors, vec!["typesafe".to_string()]);
        assert_eq!(v.items[0].sources[&TaxonomyId::S9], "jev");
        assert!(v.undecided().is_empty());
    }
}
