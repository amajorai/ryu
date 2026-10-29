//! Coverage probes for the custody source (P2-G0, spec 00.3).
//!
//! Fleet custody comes only from the provider vault: `CONTROL_PLANE_URL` with
//! `RYU_VAULT_INTERNAL_SECRET`, or `RYU_PROVIDER_VAULT_REQUIRED`. The fleet
//! flag (`RYU_GATEWAY_FLEET` / `fleet = true`) is exposure hardening only.
//!
//! Every probe here derives custody with [`GatewayCustody::from_lookup`] over
//! an environment instead of assigning it, and reads the self-host compose
//! environment from the real root `docker-compose.yml`, so drift in that file
//! fails these tests. Floor-bound routes are probed with a tenant key, never
//! the master key, because the floor admission exempts the master key. Each
//! Fleet refusal has a compose-env twin built from the same config that must
//! dispatch, so a refusal cannot just mean the route is broken. Request
//! content is the spec 00.9 sentinel only.
use super::*;
use crate::{
    config::{ApiKeyConfig, ApiKeyOperation},
    custody::exposure_hardened,
    identity::IdentityKeys,
    platform_floor::PlatformFloor,
};
use std::collections::{BTreeSet, HashMap};

/// The root self-host compose file, read at compile time.
const COMPOSE: &str = include_str!("../../../../../docker-compose.yml");
/// The root image the compose stack builds.
const ROOT_DOCKERFILE: &str = include_str!("../../../../../Dockerfile");
/// The Gateway-only image.
const GATEWAY_DOCKERFILE: &str = include_str!("../../../Dockerfile");

/// A tenant data-plane key. The floor admission exempts only the master key.
const TENANT: &str = "tenant-custody-probe";
/// A trusted forwarder, the credential `/v1/providers/call` requires.
const CORE: &str = "core-custody-probe";
const ORG: &str = "org-custody-probe";
/// A provider that refuses every request with an upstream 403.
const REJECTING: &str = "custody-rejecting";
/// Request content: the spec 00.9 sentinel, never real hazard text.
const SENTINEL: &str = "RYU_TEST_HAZARD_S4 custody probe";

const VAULT_SIGNALS: &[&str] = &[
    "CONTROL_PLANE_URL",
    "RYU_VAULT_INTERNAL_SECRET",
    "RYU_PROVIDER_VAULT_REQUIRED",
    "RYU_MANAGED_NODE",
];

// ── environments ─────────────────────────────────────────────────────────────

/// The compose `gateway` service environment, expanded the way compose does
/// for a stack started with only the required variables set: `${X:?..}` gets
/// a placeholder, `${X:-d}` gets `d`. Also returns the required names.
fn compose_gateway_env() -> (HashMap<String, String>, BTreeSet<String>) {
    let mut env = HashMap::new();
    let mut required = BTreeSet::new();
    let mut in_gateway = false;
    let mut in_environment = false;
    for line in COMPOSE.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 2 {
            in_gateway = trimmed == "gateway:";
            in_environment = false;
            continue;
        }
        if !in_gateway || indent < 4 {
            continue;
        }
        if indent == 4 {
            in_environment = trimmed == "environment:";
            continue;
        }
        if !in_environment || indent != 6 {
            continue;
        }
        let (name, raw) = trimmed
            .split_once(':')
            .unwrap_or_else(|| panic!("unparsed compose env line: {line}"));
        let raw = raw.trim().trim_matches('"').trim_matches('\'');
        let value = match raw
            .strip_prefix("${")
            .and_then(|inner| inner.strip_suffix('}'))
        {
            Some(inner) => {
                if let Some((var, _)) = inner.split_once(":?") {
                    required.insert(var.to_owned());
                    format!("placeholder-{}", var.to_ascii_lowercase())
                } else if let Some((_, default)) = inner.split_once(":-") {
                    default.to_owned()
                } else {
                    String::new()
                }
            }
            None => raw.to_owned(),
        };
        env.insert(name.trim().to_owned(), value);
    }
    (env, required)
}

fn compose_env() -> HashMap<String, String> {
    compose_gateway_env().0
}

fn with(mut env: HashMap<String, String>, extra: &[(&str, &str)]) -> HashMap<String, String> {
    for (name, value) in extra {
        env.insert((*name).to_owned(), (*value).to_owned());
    }
    env
}

/// The compose env plus the vault pair a hosted replica sets.
fn vault_pair_env() -> HashMap<String, String> {
    with(
        compose_env(),
        &[
            ("CONTROL_PLANE_URL", "https://control.invalid"),
            ("RYU_VAULT_INTERNAL_SECRET", "test-only-presence"),
        ],
    )
}

/// `RYU_PROVIDER_VAULT_REQUIRED` alone, with no fleet flag.
fn vault_required_env() -> HashMap<String, String> {
    with(HashMap::new(), &[("RYU_PROVIDER_VAULT_REQUIRED", "1")])
}

fn custody_of(env: &HashMap<String, String>) -> GatewayCustody {
    GatewayCustody::from_lookup(|name| env.get(name).cloned())
}

/// `RYU_GATEWAY_FLEET` read the way `GatewayConfig::load` reads it.
fn fleet_flag_of(env: &HashMap<String, String>) -> bool {
    env.get("RYU_GATEWAY_FLEET").is_some_and(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

// ── harness ──────────────────────────────────────────────────────────────────

type Future<'a, T> = Pin<
    Box<dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>,
>;

/// Answers every modality with a fixed reply and counts each upstream call.
struct ProbeProvider {
    name: &'static str,
    calls: Arc<AtomicUsize>,
    reject: bool,
}

impl ProbeProvider {
    fn answer(&self, value: Value) -> Future<'_, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reject = self.reject;
        Box::pin(async move {
            if reject {
                return Err(ryu_gw_providers::ProviderError::Rejected {
                    status: 403,
                    message: "probe upstream refused".to_owned(),
                });
            }
            Ok(value)
        })
    }
}

impl Provider for ProbeProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Future<'a, Value> {
        self.answer(json!({
            "id": "chatcmpl-custody-probe",
            "object": "chat.completion",
            "model": "fixture-model",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "ok" },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
        }))
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Future<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reject = self.reject;
        Box::pin(async move {
            if reject {
                return Err(ryu_gw_providers::ProviderError::Rejected {
                    status: 403,
                    message: "probe upstream refused".to_owned(),
                });
            }
            Ok(Body::from(
                "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            ))
        })
    }

    fn embed<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Future<'a, Value> {
        self.answer(json!({
            "object": "list",
            "data": [{ "object": "embedding", "index": 0, "embedding": [0.1, 0.2] }],
            "model": "fixture-model",
            "usage": { "prompt_tokens": 2, "total_tokens": 2 }
        }))
    }

    fn rerank<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Future<'a, Value> {
        self.answer(json!({
            "results": [{ "index": 0, "relevance_score": 0.9 }],
            "model": "fixture-model"
        }))
    }

    fn generate_image<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Future<'a, Value> {
        self.answer(json!({
            "created": 0,
            "data": [{ "url": "https://images.invalid/probe.png" }]
        }))
    }
}

fn key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
    ApiKeyConfig {
        key: key.to_owned(),
        name: name.to_owned(),
        allowed_operations: vec![ApiKeyOperation::Inference],
        org_id: Some(ORG.to_owned()),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder,
    }
}

struct Probe {
    app: Router,
    state: Arc<AppState>,
    calls: Arc<AtomicUsize>,
    custody: GatewayCustody,
}

/// A Gateway whose custody and fleet flag both come from `env`, with a tenant
/// key, a trusted forwarder and the probe provider as the only route.
fn probe_gateway(
    env: &HashMap<String, String>,
    configure: impl FnOnce(&mut GatewayConfig),
) -> Probe {
    let custody = custody_of(env);
    let fleet_flag = fleet_flag_of(env);
    let (mut state, _audit) = state_with(custody, |config| {
        config.fleet = fleet_flag;
        config.rate_limit.enabled = false;
        config.auth.api_keys = vec![key(TENANT, "tenant", false), key(CORE, "core", true)];
        config.routing.default_provider = ProviderId::from(FIXTURE);
        config.routing.fallback_chain = vec![];
        configure(config);
    });
    // Test state ships the compiled baseline floor; these probes start from
    // a Gateway that never received one, as a fresh replica does.
    state.platform_floor.clear();
    let calls = Arc::new(AtomicUsize::new(0));
    for (name, reject) in [(FIXTURE, false), (REJECTING, true)] {
        state
            .provider_runtime
            .register_for_test(Arc::new(ProbeProvider {
                name,
                calls: Arc::clone(&calls),
                reject,
            }));
    }
    let state = Arc::new(state);
    Probe {
        app: crate::api::router(Arc::clone(&state)),
        state,
        calls,
        custody,
    }
}

/// One floor-bound route: its path and a body naming the probe model.
fn floor_bound_routes() -> Vec<(&'static str, &'static str, Value)> {
    let chat =
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": SENTINEL }] });
    let mut chat_stream = chat.clone();
    chat_stream["stream"] = json!(true);
    let gemini = json!({ "contents": [{ "role": "user", "parts": [{ "text": SENTINEL }] }] });
    vec![
        ("chat buffered", "/v1/chat/completions", chat.clone()),
        ("chat stream", "/v1/chat/completions", chat_stream),
        ("cursor alias", "/v1/cursor/chat/completions", chat),
        (
            "anthropic messages",
            "/v1/messages",
            json!({
                "model": "fixture-model",
                "max_tokens": 16,
                "messages": [{ "role": "user", "content": SENTINEL }]
            }),
        ),
        (
            "gemini generate",
            "/v1beta/models/fixture-model:generateContent",
            gemini.clone(),
        ),
        (
            "gemini stream",
            "/v1beta/models/fixture-model:streamGenerateContent?alt=sse",
            gemini,
        ),
        (
            "responses",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": SENTINEL }),
        ),
        (
            "embeddings",
            "/v1/embeddings",
            json!({ "model": "fixture-model", "input": SENTINEL }),
        ),
        (
            "rerank",
            "/v1/rerank",
            json!({ "model": "fixture-model", "query": SENTINEL, "documents": ["a", "b"] }),
        ),
        (
            "image generation",
            "/v1/images/generations",
            json!({ "model": "fixture-model", "prompt": SENTINEL }),
        ),
    ]
}

fn is_screening_unavailable(status: StatusCode, body: &Value) -> bool {
    status == StatusCode::SERVICE_UNAVAILABLE && body.to_string().contains("screening_unavailable")
}

async fn get_route(app: &Router, uri: &str, loopback: bool) -> (StatusCode, String) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .extension(peer(loopback))
        .body(Body::empty())
        .expect("request builds");
    let response = app.clone().oneshot(request).await.expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

// The compose file and images.
mod compose;
// Floor-bound routes, exposure hardening and the hazard screener.
mod routes;
