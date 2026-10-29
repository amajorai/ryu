//! Upstream identity on the hosted Gateway (spec 03.1 to 03.3).
//!
//! Real provider adapters (`openai`, `openrouter`, `anthropic`) point at one
//! local mock that also answers the control plane's `/gateway/resolve`, so
//! every request authenticates with an `rgw_` key exactly as on the fleet.
//! Each test asserts on the bytes the mock upstream received: Ryu's hashed
//! subject in that provider's own field, and no tenant-supplied identifier
//! anywhere.
use super::*;
use crate::identity::{IdentityKeys, SubjectKind};

const ROOT: &[u8] = &[7; 32];
const PEPPER: &[u8] = &[9; 32];
/// An ordinary org key: the credential is the upstream subject.
const DEFAULT_KEY: &str = "rgw_identity_default_0001";
/// Keys whose org declared them as serving its own end users, in two orgs.
const SERVES_A: &str = "rgw_identity_serves_org_a1";
const SERVES_B: &str = "rgw_identity_serves_org_b1";
/// Tenant-supplied identifiers. None of them may reach an upstream.
const TENANT_USER: &str = "RYU_TEST_LEXICON-user";
const TENANT_SAFETY: &str = "RYU_TEST_LEXICON-safety";
const TENANT_META: &str = "RYU_TEST_LEXICON-meta";
const END_USER: &str = "tenant-user-SECRET-42";

fn keys() -> IdentityKeys {
    IdentityKeys::for_test(ROOT, Some((1, PEPPER)))
}

fn credential_subject(credential_id: &str) -> String {
    keys()
        .upstream_subject(SubjectKind::Credential, credential_id)
        .expect("test keys hold a pepper")
}

fn end_user_subject(org_id: &str, raw: &str) -> String {
    let keys = keys();
    keys.upstream_subject(SubjectKind::EndUser, &keys.end_user_hash(org_id, 1, raw))
        .expect("test keys hold a pepper")
}

/// One request the mock upstream received.
#[derive(Clone, Debug)]
struct Upstream {
    path: String,
    body: Value,
}

struct MockUpstream {
    base: String,
    requests: Arc<Mutex<Vec<Upstream>>>,
    task: tokio::task::JoinHandle<()>,
}

impl MockUpstream {
    fn requests(&self) -> Vec<Upstream> {
        self.requests.lock().expect("captured lock").clone()
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn resolve_payload(key: &str) -> Option<Value> {
    let (org, credential, serves) = match key {
        DEFAULT_KEY => ("org_a", "cred_default", false),
        SERVES_A => ("org_a", "cred_serves_a", true),
        SERVES_B => ("org_b", "cred_serves_b", true),
        _ => return None,
    };
    Some(json!({
        "organization": { "id": org },
        "credential": {
            "id": credential,
            "nodeId": "node_1",
            "teamId": null,
            "ownerUserId": "usr_owner",
            "createdBy": "usr_creator",
            "servesEndUsers": serves,
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"]
        },
        "identity": { "saltEpoch": 1 },
        "managedInference": false,
        "standing": { "state": "active", "refuses": "none" }
    }))
}

fn chat_completion() -> Value {
    json!({
        "id": "chatcmpl-identity",
        "object": "chat.completion",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "ok" },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
    })
}

fn chat_sse() -> String {
    let chunk = json!({
        "id": "chatcmpl-identity",
        "object": "chat.completion.chunk",
        "model": "fixture-model",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "ok" },
                      "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}

fn anthropic_message() -> Value {
    json!({
        "id": "msg_identity",
        "type": "message",
        "role": "assistant",
        "model": "claude-fixture",
        "content": [{ "type": "text", "text": "ok" }],
        "stop_reason": "end_turn",
        "usage": { "input_tokens": 3, "output_tokens": 1 }
    })
}

fn anthropic_sse() -> String {
    let events = [
        json!({ "type": "message_start", "message": {
            "id": "msg_identity", "type": "message", "role": "assistant",
            "model": "claude-fixture", "content": [],
            "usage": { "input_tokens": 3, "output_tokens": 0 } } }),
        json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "ok" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 1 } }),
        json!({ "type": "message_stop" }),
    ];
    events
        .iter()
        .map(|data| {
            format!(
                "event: {}\ndata: {data}\n\n",
                data["type"].as_str().unwrap()
            )
        })
        .collect()
}

fn reply_for(path: &str, body: &Value) -> axum::response::Response {
    use axum::response::IntoResponse;
    let stream = body["stream"].as_bool().unwrap_or(false);
    let sse = |text: String| {
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(text))
            .expect("sse response builds")
    };
    if path.ends_with("/v1/messages") {
        return if stream {
            sse(anthropic_sse())
        } else {
            Json(anthropic_message()).into_response()
        };
    }
    if path.ends_with("/embeddings") {
        return Json(json!({
            "object": "list",
            "data": [{ "object": "embedding", "index": 0, "embedding": [0.1, 0.2] }],
            "model": "fixture-embed",
            "usage": { "prompt_tokens": 2, "total_tokens": 2 }
        }))
        .into_response();
    }
    if stream {
        sse(chat_sse())
    } else {
        Json(chat_completion()).into_response()
    }
}

async fn spawn_upstream() -> MockUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock upstream binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let requests: Arc<Mutex<Vec<Upstream>>> = Arc::default();
    let captured = Arc::clone(&requests);
    let router = Router::new()
        .route(
            "/api/control-plane/gateway/resolve",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                use axum::response::IntoResponse;
                let key = headers
                    .get("x-gateway-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                match resolve_payload(key) {
                    Some(payload) => Json(payload).into_response(),
                    None => StatusCode::UNAUTHORIZED.into_response(),
                }
            }),
        )
        .fallback(move |uri: axum::http::Uri, Json(body): Json<Value>| {
            let captured = Arc::clone(&captured);
            async move {
                let path = uri.path().to_owned();
                let reply = reply_for(&path, &body);
                captured
                    .lock()
                    .expect("captured lock")
                    .push(Upstream { path, body });
                reply
            }
        });
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("mock upstream serves");
    });
    MockUpstream {
        base,
        requests,
        task,
    }
}

fn identity_harness(
    custody: GatewayCustody,
    provider: &str,
    upstream: &MockUpstream,
    keys: IdentityKeys,
) -> Harness {
    let base = upstream.base.clone();
    let provider = provider.to_owned();
    let (mut state, audit) = state_with(custody, |config| {
        config.providers.openai = Some(crate::config::OpenAiProviderConfig {
            api_key: "sk-openai-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/openai"),
        });
        config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
            api_key: "sk-ant-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/anthropic"),
        });
        config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
            api_key: "sk-or-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/openrouter"),
            site_url: "https://ryu.example".to_owned(),
            site_name: "Ryu".to_owned(),
            data_collection: String::new(),
            zdr: false,
            sort: String::new(),
            response_healing: false,
            usage_accounting: true,
            org_api_keys: Default::default(),
        });
        config.routing.default_provider = ProviderId::from(provider.as_str());
        config.routing.fallback_chain = vec![];
    });
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        upstream.base.clone(),
        reqwest::Client::new(),
    ));
    state.identity_keys = Arc::new(keys);
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

async fn post(
    app: &Router,
    uri: &str,
    key: &str,
    end_user: Option<&[u8]>,
    body: &Value,
) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {key}"))
        .extension(peer(false));
    if let Some(value) = end_user {
        request = request.header(
            "x-ryu-end-user",
            axum::http::HeaderValue::from_bytes(value).expect("header bytes"),
        );
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// A chat body that carries every tenant-supplied identifier at once.
fn tenant_chat(model: &str, stream: bool) -> Value {
    json!({
        "model": model,
        "stream": stream,
        "messages": [{ "role": "user", "content": "Hi" }],
        "user": TENANT_USER,
        "safety_identifier": TENANT_SAFETY,
        "metadata": { "user_id": TENANT_META },
        "ryu_upstream_subject": "ryu.1.ffffffffffffffffffffffffffffffff"
    })
}

fn assert_no_tenant_identifier(body: &Value) {
    let wire = body.to_string();
    for sentinel in [
        TENANT_USER,
        TENANT_SAFETY,
        TENANT_META,
        END_USER,
        "ryu.1.ffffffffffffffffffffffffffffffff",
        "ryu-agent:",
        "ryu-user:",
    ] {
        assert!(
            !wire.contains(sentinel),
            "{sentinel} reached upstream: {wire}"
        );
    }
    assert!(body.get("ryu_upstream_subject").is_none(), "{wire}");
}

/// The single identity field this provider's request carried.
fn stamped_field(provider: &str, body: &Value) -> Value {
    match provider {
        "anthropic" => {
            assert!(body.get("user").is_none() && body.get("safety_identifier").is_none());
            body["metadata"]["user_id"].clone()
        }
        "openai" => {
            assert!(body.get("user").is_none(), "{body}");
            assert!(body.get("metadata").is_none(), "{body}");
            body["safety_identifier"].clone()
        }
        "openrouter" => {
            assert!(body.get("safety_identifier").is_none(), "{body}");
            assert!(body.get("metadata").is_none(), "{body}");
            body["user"].clone()
        }
        other => panic!("no field for {other}"),
    }
}

#[tokio::test]
async fn each_provider_receives_the_hashed_subject_and_no_tenant_identifier() {
    let expected = credential_subject("cred_default");
    for provider in ["openai", "openrouter", "anthropic"] {
        for stream in [false, true] {
            let upstream = spawn_upstream().await;
            let harness = identity_harness(GatewayCustody::Fleet, provider, &upstream, keys());
            let (status, reply) = post(
                &harness.app,
                "/v1/chat/completions",
                DEFAULT_KEY,
                None,
                &tenant_chat("fixture-model", stream),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::OK,
                "{provider} stream={stream}: {reply}"
            );
            let requests = upstream.requests();
            assert_eq!(requests.len(), 1, "{provider} stream={stream}");
            let body = &requests[0].body;
            assert_eq!(
                stamped_field(provider, body),
                json!(expected),
                "{provider} stream={stream}: {body}"
            );
            assert_no_tenant_identifier(body);
        }
    }
}

#[tokio::test]
async fn openai_embeddings_carry_the_subject_as_user() {
    let upstream = spawn_upstream().await;
    let harness = identity_harness(GatewayCustody::Fleet, "openai", &upstream, keys());
    let (status, reply) = post(
        &harness.app,
        "/v1/embeddings",
        DEFAULT_KEY,
        None,
        &json!({
            "model": "fixture-embed",
            "input": "hello",
            "user": TENANT_USER,
            "safety_identifier": TENANT_SAFETY,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let requests = upstream.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].path.ends_with("/embeddings"));
    assert_eq!(
        requests[0].body["user"],
        json!(credential_subject("cred_default"))
    );
    assert!(requests[0].body.get("safety_identifier").is_none());
    assert_no_tenant_identifier(&requests[0].body);
}

#[tokio::test]
async fn the_same_end_user_in_two_orgs_gets_different_upstream_ids() {
    let upstream = spawn_upstream().await;
    let harness = identity_harness(GatewayCustody::Fleet, "openai", &upstream, keys());
    for key in [SERVES_A, SERVES_B] {
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            key,
            Some(END_USER.as_bytes()),
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{key}: {reply}");
    }
    let requests = upstream.requests();
    assert_eq!(requests.len(), 2);
    let in_a = requests[0].body["safety_identifier"].clone();
    let in_b = requests[1].body["safety_identifier"].clone();
    assert_eq!(in_a, json!(end_user_subject("org_a", END_USER)));
    assert_eq!(in_b, json!(end_user_subject("org_b", END_USER)));
    assert_ne!(in_a, in_b);
    for request in &requests {
        assert_no_tenant_identifier(&request.body);
    }
}

#[tokio::test]
async fn an_ordinary_key_cannot_rotate_its_upstream_identity_with_end_user_headers() {
    let upstream = spawn_upstream().await;
    let harness = identity_harness(GatewayCustody::Fleet, "openai", &upstream, keys());
    for end_user in ["rotating-1", "rotating-2", "rotating-3"] {
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            Some(end_user.as_bytes()),
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reply}");
    }
    let identifiers: std::collections::HashSet<String> = upstream
        .requests()
        .iter()
        .map(|request| {
            request.body["safety_identifier"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        identifiers,
        std::collections::HashSet::from([credential_subject("cred_default")])
    );
}

#[tokio::test]
async fn a_malformed_end_user_header_is_refused_before_any_upstream_call() {
    let upstream = spawn_upstream().await;
    let harness = identity_harness(GatewayCustody::Fleet, "openai", &upstream, keys());
    let too_long = "x".repeat(129);
    for value in [
        b"".as_slice(),
        too_long.as_bytes(),
        b"two words",
        // A control byte cannot travel in an HTTP header at all; a tab can.
        b"tab\tinside",
        "caf\u{e9}".as_bytes(),
    ] {
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            Some(value),
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value:?}: {reply}");
        let error: Value = serde_json::from_str(&reply).expect("json error");
        assert_eq!(error["error"]["type"], "invalid_request_error");
        assert_eq!(error["error"]["code"], "invalid_end_user");
    }
    assert!(upstream.requests().is_empty());
}

#[tokio::test]
async fn audit_rows_name_the_resolved_credential_and_never_the_raw_end_user() {
    let upstream = spawn_upstream().await;
    let harness = identity_harness(GatewayCustody::Fleet, "openai", &upstream, keys());
    let (status, reply) = post(
        &harness.app,
        "/v1/chat/completions",
        SERVES_A,
        Some(END_USER.as_bytes()),
        &tenant_chat("fixture-model", false),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let rows = harness.audit.rows();
    assert!(!rows.is_empty());
    for row in &rows {
        assert_eq!(row.key_id.as_deref(), Some("cred_serves_a"));
        assert!(!format!("{row:?}").contains(END_USER), "{row:?}");
    }
}

#[tokio::test]
async fn self_hosted_gateways_forward_the_callers_identifiers_unchanged() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_upstream().await;
        let harness = identity_harness(custody, "openai", &upstream, IdentityKeys::local());
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            Some(END_USER.as_bytes()),
            &json!({
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "Hi" }],
                "safety_identifier": "operator-own-id",
                "ryu_upstream_subject": "ryu.1.ffffffffffffffffffffffffffffffff"
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {reply}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1);
        let body = &requests[0].body;
        assert_eq!(body["safety_identifier"], json!("operator-own-id"));
        assert!(body.get("ryu_upstream_subject").is_none());
        assert!(!body.to_string().contains(END_USER));
    }
}

#[cfg(test)]
mod identity_probe;

#[cfg(test)]
mod vercel_lane;
