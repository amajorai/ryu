//! Platform floor (spec 02.3): wire parsing, the newest-floor store, the
//! fail-closed admission, the resolver layer and the request path end to end.
//!
//! Test content is the test-only lexicon `RYU_TEST_LEXICON`; no real harmful
//! text is used anywhere.
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::config::{
    CustomPattern, CustomPatternKind, FirewallConfig, FirewallPolicy, InspectorConfig, ProviderId,
};
use crate::evaluators::OfflineConfig;
use crate::firewall::resolve::{FirewallResolver, PolicyBundle};
use crate::policy::ResolveCache;
use crate::providers::Provider;
use crate::state::AppState;

const LEXICON: &str = "RYU_TEST_LEXICON";
const FIXTURE: &str = "floor-fixture";

fn lexicon_pattern() -> Value {
    json!({ "name": "ryu_test_lexicon", "regex": LEXICON, "kind": "secret" })
}

/// A floor as `packages/api/src/lib/platform-floor.ts` sends it.
fn floor_wire(version: u64) -> Value {
    json!({
        "version": version,
        "contentHash": format!("hash-{version}"),
        "issuedAt": "2026-10-23T09:00:00.000Z",
        "overlay": {
            "enabled": true,
            "scan_inbound": true,
            "scan_outbound": true,
            "redact_secrets": true,
            "policy": "block",
            "custom_patterns": [lexicon_pattern()],
            "locked_fields": ["enabled", "scan_inbound", "scan_outbound", "policy",
                "log_detections", "redact_pii", "redact_secrets",
                "wrap_untrusted_tool_results", "inspector"]
        },
        "allowedProviders": [],
        "allowedModels": []
    })
}

fn parsed(version: u64) -> Arc<PlatformFloor> {
    PlatformFloor::from_wire(Some(&floor_wire(version)), false).expect("valid floor")
}

async fn render(error: GatewayError) -> (StatusCode, Value, Option<String>) {
    let response = error.into_response();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), retry_after)
}

// ─── Wire parsing ──────────────────────────────────────────────────────────

#[test]
fn a_valid_floor_parses_and_drops_its_wire_locks() {
    let floor = parsed(3);
    assert_eq!(floor.version, 3);
    assert_eq!(floor.content_hash, "hash-3");
    assert_eq!(floor.overlay.policy, Some(FirewallPolicy::Block));
    assert_eq!(floor.overlay.custom_patterns.len(), 1);
    // The resolver locks every field itself; the wire list (which omits
    // `alert`) is never trusted.
    assert!(floor.overlay.locked_fields.is_empty());
}

#[test]
fn floor_evaluator_bindings_are_forced_enabled_and_locked() {
    let mut wire = floor_wire(1);
    wire["overlay"]["evaluators"] = json!([
        { "id": "prompt_injection", "enabled": false, "inlineAction": "block", "locked": false }
    ]);
    let floor = PlatformFloor::from_wire(Some(&wire), false).expect("valid floor");
    assert!(floor.overlay.evaluators.is_none());
    assert_eq!(floor.evaluators.len(), 1);
    assert!(floor.evaluators[0].enabled);
    assert!(floor.evaluators[0].locked);
}

#[test]
fn an_unavailable_absent_or_null_floor_is_no_floor() {
    assert!(PlatformFloor::from_wire(Some(&floor_wire(1)), true).is_none());
    assert!(PlatformFloor::from_wire(None, false).is_none());
    assert!(PlatformFloor::from_wire(Some(&Value::Null), false).is_none());
    assert!(PlatformFloor::from_wire(Some(&json!("floor")), false).is_none());
}

#[test]
fn a_floor_the_gateway_cannot_apply_in_full_is_rejected_whole() {
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        (
            "unknown top-level field",
            Box::new(|wire| wire["hazards"] = json!({})),
        ),
        (
            "unknown overlay field",
            Box::new(|wire| wire["overlay"]["future_dial"] = json!(true)),
        ),
        (
            "provider allowlist",
            Box::new(|wire| wire["allowedProviders"] = json!(["anthropic"])),
        ),
        (
            "model allowlist",
            Box::new(|wire| wire["allowedModels"] = json!(["anthropic/claude-*"])),
        ),
        (
            "invalid regex",
            Box::new(|wire| {
                wire["overlay"]["custom_patterns"] =
                    json!([{ "name": "bad", "regex": "(", "kind": "secret" }]);
            }),
        ),
        (
            "empty pattern name",
            Box::new(|wire| {
                wire["overlay"]["custom_patterns"] =
                    json!([{ "name": " ", "regex": LEXICON, "kind": "secret" }]);
            }),
        ),
        (
            "repeated evaluator id",
            Box::new(|wire| {
                wire["overlay"]["evaluators"] = json!([
                    { "id": "pii_leakage", "enabled": true, "locked": true },
                    { "id": "pii_leakage", "enabled": true, "locked": true }
                ]);
            }),
        ),
        (
            "evaluator id in no catalog",
            Box::new(|wire| {
                wire["overlay"]["evaluators"] = json!([
                    { "id": "ryu_test_unknown_evaluator", "enabled": true,
                      "inlineAction": "block", "locked": true }
                ]);
            }),
        ),
        (
            "evaluator unavailable inline",
            Box::new(|wire| {
                wire["overlay"]["evaluators"] = json!([
                    { "id": "code_evaluator", "enabled": true,
                      "inlineAction": "block", "locked": true }
                ]);
            }),
        ),
        (
            "missing version",
            Box::new(|wire| {
                wire.as_object_mut().unwrap().remove("version");
            }),
        ),
        (
            "missing overlay",
            Box::new(|wire| {
                wire.as_object_mut().unwrap().remove("overlay");
            }),
        ),
        (
            "malformed overlay value",
            Box::new(|wire| wire["overlay"]["policy"] = json!("off")),
        ),
    ];
    for (name, mutate) in cases {
        let mut wire = floor_wire(4);
        mutate(&mut wire);
        assert!(
            PlatformFloor::from_wire(Some(&wire), false).is_none(),
            "{name} must reject the floor"
        );
    }
}

/// The exact objects `platformFloorWire` emits in
/// `packages/api/src/lib/platform-floor.ts`: the version 0 baseline a fresh
/// control plane serves, and a full document with an inspector, every
/// pattern kind and an evaluator binding. Rejecting either would leave the
/// whole fleet refusing.
#[test]
fn the_control_plane_baseline_and_a_full_document_parse() {
    let locked = json!([
        "enabled",
        "scan_inbound",
        "scan_outbound",
        "policy",
        "log_detections",
        "redact_pii",
        "redact_secrets",
        "wrap_untrusted_tool_results",
        "inspector"
    ]);
    let baseline = json!({
        "allowedModels": [],
        "allowedProviders": [],
        "contentHash": "3f1e",
        "issuedAt": null,
        "overlay": {
            "enabled": true,
            "redact_secrets": true,
            "scan_inbound": true,
            "scan_outbound": true,
            "locked_fields": locked
        },
        "version": 0
    });
    let floor = PlatformFloor::from_wire(Some(&baseline), false).expect("baseline parses");
    assert_eq!(floor.version, 0);
    assert_eq!(floor.overlay.enabled, Some(true));

    let full = json!({
        "allowedModels": [],
        "allowedProviders": [],
        "contentHash": "9f2c",
        "issuedAt": "2026-10-23T09:00:00.000Z",
        "overlay": {
            "enabled": true,
            "log_detections": true,
            "policy": "sanitize",
            "redact_pii": true,
            "wrap_untrusted_tool_results": true,
            "inspector": { "enabled": true, "model": "", "mode": "both",
                "min_chars": 40, "timeout_ms": 1500, "action": "warn_and_continue" },
            "custom_patterns": [
                { "name": "a", "regex": LEXICON, "kind": "pii" },
                { "name": "b", "regex": LEXICON, "kind": "secret" },
                { "name": "c", "regex": LEXICON, "kind": "prompt_injection" }
            ],
            "locked_fields": locked,
            "evaluators": [{ "id": "prompt_injection", "enabled": true,
                "inlineAction": "block",
                "offline": { "threshold": 0.8, "judgeModel": "judge" },
                "locked": true }]
        },
        "version": 4
    });
    let floor = PlatformFloor::from_wire(Some(&full), false).expect("full document parses");
    assert_eq!(floor.overlay.policy, Some(FirewallPolicy::Sanitize));
    assert_eq!(floor.overlay.custom_patterns.len(), 3);
    assert_eq!(
        floor.evaluators[0]
            .offline
            .as_ref()
            .and_then(|offline| offline.judge_model.as_deref()),
        Some("judge")
    );
}

#[test]
fn every_resolve_advertises_both_capabilities() {
    let tokens: Vec<&str> = crate::standing::RESOLVE_CAPABILITIES
        .split(',')
        .map(str::trim)
        .collect();
    assert!(tokens.contains(&"standing"));
    assert!(tokens.contains(&"platform_floor"));
}

// ─── Store and admission ───────────────────────────────────────────────────

#[test]
fn the_store_keeps_the_newest_floor_and_never_rolls_back_or_clears() {
    let store = FloorStore::default();
    assert!(store.current().is_none());
    assert!(store.observe(Some(&parsed(2))));
    // An older cached resolve and a resolve with no usable floor both leave it.
    assert!(!store.observe(Some(&parsed(1))));
    assert!(!store.observe(Some(&parsed(2))));
    assert!(!store.observe(None));
    assert_eq!(store.current().unwrap().version, 2);
    assert!(store.observe(Some(&parsed(5))));
    assert_eq!(store.current().unwrap().version, 5);
}

#[tokio::test]
async fn a_fleet_with_no_floor_refuses_with_a_retryable_503() {
    let store = FloorStore::default();
    let error = admit(GatewayCustody::Fleet, &store, false).expect_err("no floor refuses");
    assert!(error.is_safety_outcome());
    let (status, body, retry_after) = render(error).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["type"], "service_unavailable");
    assert_eq!(body["error"]["code"], "screening_unavailable");
    assert_eq!(body["error"]["layer"], "platform");
    assert_eq!(retry_after.as_deref(), Some("10"));
}

#[test]
fn admission_binds_only_the_fleet_and_spares_the_master_key() {
    let empty = FloorStore::default();
    assert!(admit(GatewayCustody::ManagedNode, &empty, false).is_ok());
    assert!(admit(GatewayCustody::SelfHosted, &empty, false).is_ok());
    assert!(admit(GatewayCustody::Fleet, &empty, true).is_ok());
    let held = FloorStore::with(parsed(1));
    assert!(admit(GatewayCustody::Fleet, &held, false).is_ok());
}

#[test]
fn only_the_fleet_gets_a_binding_floor_and_it_is_never_none_there() {
    let empty = FloorStore::default();
    assert!(binding_floor(GatewayCustody::SelfHosted, &FloorStore::with(parsed(1))).is_none());
    assert!(binding_floor(GatewayCustody::ManagedNode, &FloorStore::with(parsed(1))).is_none());
    assert_eq!(
        binding_floor(GatewayCustody::Fleet, &empty)
            .unwrap()
            .version,
        0,
        "the compiled baseline stands in for a fleet request that got past admission"
    );
    assert_eq!(
        binding_floor(GatewayCustody::Fleet, &FloorStore::with(parsed(7)))
            .unwrap()
            .version,
        7
    );
}

// ─── Resolver layer ────────────────────────────────────────────────────────

/// A node base a tenant could loosen if no floor applied.
fn loose_node_base() -> FirewallConfig {
    FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: true,
        policy: FirewallPolicy::WarnAndContinue,
        redact_pii: false,
        redact_secrets: false,
        locked_fields: Vec::new(),
        ..FirewallConfig::default()
    }
}

/// A tenant overlay that tries to switch off or loosen every dial.
fn loosening_overlay() -> FirewallOverlay {
    FirewallOverlay {
        enabled: Some(false),
        scan_inbound: Some(false),
        scan_outbound: Some(false),
        policy: Some(FirewallPolicy::WarnAndContinue),
        redact_pii: Some(false),
        redact_secrets: Some(false),
        ..FirewallOverlay::default()
    }
}

fn tightening_floor() -> Arc<PlatformFloor> {
    Arc::new(PlatformFloor {
        version: 9,
        content_hash: String::new(),
        overlay: FirewallOverlay {
            enabled: Some(true),
            scan_inbound: Some(true),
            scan_outbound: Some(true),
            policy: Some(FirewallPolicy::Block),
            redact_pii: Some(true),
            redact_secrets: Some(true),
            custom_patterns: vec![CustomPattern {
                name: "ryu_test_lexicon".to_owned(),
                regex: LEXICON.to_owned(),
                kind: CustomPatternKind::Secret,
            }],
            ..FirewallOverlay::default()
        },
        evaluators: Vec::new(),
        screener: None,
        restricted_models: Vec::new(),
    })
}

fn bundle(floor: Option<Arc<PlatformFloor>>) -> PolicyBundle {
    PolicyBundle {
        platform_floor: floor,
        firewall: Some(loosening_overlay()),
        team_firewall: None,
        agent_overlays: HashMap::from([("agent".to_owned(), loosening_overlay())]),
    }
}

#[test]
fn a_tenant_overlay_cannot_loosen_any_floor_field() {
    let resolver = FirewallResolver::new(loose_node_base());
    // Control: with no floor the tenant overlays do loosen the node base.
    let loose = resolver.resolve(Some("org"), Some("agent"), Some(&bundle(None)));
    assert!(!loose.enabled);
    assert_eq!(loose.policy, FirewallPolicy::WarnAndContinue);

    let resolved = resolver.resolve(
        Some("org"),
        Some("agent"),
        Some(&bundle(Some(tightening_floor()))),
    );
    assert!(
        resolved.enabled,
        "the org cannot disable the floor firewall"
    );
    assert!(resolved.scan_inbound);
    assert!(resolved.scan_outbound);
    assert_eq!(resolved.policy, FirewallPolicy::Block);
    assert!(resolved.redact_pii);
    assert!(resolved.redact_secrets);
    assert!(resolved
        .custom_patterns
        .iter()
        .any(|pattern| pattern.regex == LEXICON));
    // Every lockable field is locked for the narrower scopes, `alert` too.
    for field in ["enabled", "policy", "alert", "inspector", "redact_pii"] {
        assert!(
            resolved.locked_fields.iter().any(|locked| locked == field),
            "{field} must be locked under the floor"
        );
    }
}

#[test]
fn the_floor_locks_node_values_it_does_not_set() {
    // The floor leaves `redact_pii` unset; the node turned it on. A tenant
    // that turns it off is ignored under the floor.
    let mut node = loose_node_base();
    node.redact_pii = true;
    let resolver = FirewallResolver::new(node);
    let floor = Arc::new(PlatformFloor {
        overlay: FirewallOverlay {
            scan_inbound: Some(true),
            ..FirewallOverlay::default()
        },
        ..(*tightening_floor()).clone()
    });
    let resolved = resolver.resolve(Some("org"), None, Some(&bundle(Some(floor))));
    assert!(resolved.redact_pii);
    assert_eq!(resolved.policy, FirewallPolicy::WarnAndContinue);
}

#[test]
fn the_floor_itself_only_tightens_the_node_base() {
    let mut node = loose_node_base();
    node.policy = FirewallPolicy::Block;
    node.redact_pii = true;
    let resolver = FirewallResolver::new(node);
    let floor = Arc::new(PlatformFloor {
        overlay: FirewallOverlay {
            policy: Some(FirewallPolicy::Sanitize),
            redact_pii: Some(false),
            ..FirewallOverlay::default()
        },
        ..(*tightening_floor()).clone()
    });
    let resolved = resolver.resolve(
        None,
        None,
        Some(&PolicyBundle {
            platform_floor: Some(floor),
            ..PolicyBundle::default()
        }),
    );
    assert_eq!(resolved.policy, FirewallPolicy::Block);
    assert!(resolved.redact_pii);
}

#[test]
fn floor_evaluators_merge_tighten_only_and_survive_a_tenant_disable() {
    let mut node = loose_node_base();
    node.evaluators = vec![crate::evaluators::EvaluatorBinding {
        id: "prompt_injection".to_owned(),
        enabled: true,
        inline_action: Some(FirewallPolicy::Block),
        offline: Some(OfflineConfig {
            threshold: 0.9,
            judge_model: Some("node-judge".to_owned()),
        }),
        locked: false,
    }];
    let resolver = FirewallResolver::new(node);
    let floor = Arc::new(PlatformFloor {
        evaluators: vec![
            crate::evaluators::EvaluatorBinding {
                id: "prompt_injection".to_owned(),
                enabled: true,
                inline_action: Some(FirewallPolicy::WarnAndContinue),
                offline: Some(OfflineConfig {
                    threshold: 0.5,
                    judge_model: None,
                }),
                locked: true,
            },
            crate::evaluators::EvaluatorBinding {
                id: "pii".to_owned(),
                enabled: true,
                inline_action: Some(FirewallPolicy::Sanitize),
                offline: None,
                locked: true,
            },
        ],
        ..(*tightening_floor()).clone()
    });
    let tenant = FirewallOverlay {
        evaluators: Some(vec![
            crate::evaluators::EvaluatorBinding {
                id: "prompt_injection".to_owned(),
                enabled: false,
                inline_action: Some(FirewallPolicy::WarnAndContinue),
                offline: None,
                locked: false,
            },
            crate::evaluators::EvaluatorBinding {
                id: "pii".to_owned(),
                enabled: false,
                inline_action: None,
                offline: None,
                locked: false,
            },
        ]),
        ..FirewallOverlay::default()
    };
    let resolved = resolver.resolve(
        Some("org"),
        None,
        Some(&PolicyBundle {
            platform_floor: Some(floor),
            firewall: Some(tenant),
            ..PolicyBundle::default()
        }),
    );
    let injection = resolved
        .evaluators
        .iter()
        .find(|binding| binding.id == "prompt_injection")
        .unwrap();
    assert!(injection.enabled);
    assert!(injection.locked);
    assert_eq!(injection.inline_action, Some(FirewallPolicy::Block));
    let offline = injection.offline.as_ref().unwrap();
    assert!((offline.threshold - 0.9).abs() < f32::EPSILON);
    assert_eq!(offline.judge_model.as_deref(), Some("node-judge"));
    let pii = resolved
        .evaluators
        .iter()
        .find(|binding| binding.id == "pii")
        .unwrap();
    assert!(
        pii.enabled,
        "a floor-only binding survives a tenant disable"
    );
    assert_eq!(pii.inline_action, Some(FirewallPolicy::Sanitize));
}

#[test]
fn a_tenant_cannot_swap_the_floor_inspector_model() {
    let resolver = FirewallResolver::new(loose_node_base());
    let floor_inspector = InspectorConfig {
        enabled: true,
        model: "floor-inspector".to_owned(),
        ..InspectorConfig::default()
    };
    let floor = Arc::new(PlatformFloor {
        overlay: FirewallOverlay {
            inspector: Some(floor_inspector),
            ..FirewallOverlay::default()
        },
        ..(*tightening_floor()).clone()
    });
    let tenant = FirewallOverlay {
        inspector: Some(InspectorConfig {
            enabled: false,
            model: "tenant-inspector".to_owned(),
            ..InspectorConfig::default()
        }),
        ..FirewallOverlay::default()
    };
    let resolved = resolver.resolve(
        Some("org"),
        None,
        Some(&PolicyBundle {
            platform_floor: Some(floor),
            firewall: Some(tenant),
            ..PolicyBundle::default()
        }),
    );
    assert!(resolved.inspector.enabled);
    assert_eq!(resolved.inspector.model, "floor-inspector");
}

// ─── Request path end to end ───────────────────────────────────────────────

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Counts every completion and answers a fixed reply.
struct FixtureProvider {
    calls: Arc<AtomicUsize>,
}

impl Provider for FixtureProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(json!({
                "id": "chatcmpl-floor",
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

/// A control plane serving every `rgw_` token the same org, with
/// `managedInference: false`, a tenant overlay that switches the firewall
/// off, and whatever floor the test last set.
#[derive(Clone)]
struct ControlPlane {
    floor: Arc<Mutex<Value>>,
    unavailable: Arc<Mutex<bool>>,
    capabilities: Arc<Mutex<Vec<String>>>,
}

impl ControlPlane {
    fn new(floor: Value) -> Self {
        Self {
            floor: Arc::new(Mutex::new(floor)),
            unavailable: Arc::new(Mutex::new(false)),
            capabilities: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn set_unavailable(&self) {
        *self.floor.lock().unwrap() = Value::Null;
        *self.unavailable.lock().unwrap() = true;
    }

    async fn serve(&self) -> (String, tokio::task::JoinHandle<()>) {
        let plane = self.clone();
        let app = axum::Router::new().route(
            "/api/control-plane/gateway/resolve",
            axum::routing::get(move |headers: axum::http::HeaderMap| {
                let plane = plane.clone();
                async move {
                    if let Some(value) = headers
                        .get(crate::standing::RESOLVE_CAPABILITIES_HEADER)
                        .and_then(|value| value.to_str().ok())
                    {
                        plane.capabilities.lock().unwrap().push(value.to_owned());
                    }
                    let token = headers
                        .get("x-gateway-key")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    if !token.starts_with("rgw_") {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    let mut body = json!({
                        "organization": { "id": "org_floor" },
                        "credential": {
                            "id": format!("cred_{token}"),
                            "purpose": "gateway_relay",
                            "allowedOperations": ["gateway.inference"]
                        },
                        "managedInference": false,
                        "standing": { "state": "active", "refuses": "none" },
                        "firewall": {
                            "enabled": false,
                            "scan_inbound": false,
                            "scan_outbound": false,
                            "policy": "warn_and_continue",
                            "redact_secrets": false
                        },
                        "platformFloorUnavailable": *plane.unavailable.lock().unwrap()
                    });
                    let floor = plane.floor.lock().unwrap().clone();
                    if !floor.is_null() || *plane.unavailable.lock().unwrap() {
                        body["platformFloor"] = floor;
                    }
                    axum::Json(body).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }
}

struct Harness {
    app: axum::Router,
    calls: Arc<AtomicUsize>,
}

/// A gateway on `custody` that has never received a floor, resolving `rgw_`
/// tokens against `url`.
fn gateway(url: String, custody: GatewayCustody) -> Harness {
    let mut config = crate::config::GatewayConfig::default();
    config.auth.require_auth = true;
    config.cache.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
    // Nothing locked on the node, so the tenant overlay alone could switch
    // the firewall off.
    config.firewall.locked_fields = Vec::new();
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state.custody = custody;
    state.resolve_cache = Some(ResolveCache::for_test(url, reqwest::Client::new()));
    state.platform_floor.clear();
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(FixtureProvider {
            calls: Arc::clone(&calls),
        }));
    Harness {
        app: crate::api::router(Arc::new(state)),
        calls,
    }
}

fn chat(token: &str, content: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            9,
        ))))
        .body(Body::from(
            json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": content }] })
                .to_string(),
        ))
        .unwrap()
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value, Option<String>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
        retry_after,
    )
}

fn flagged_prompt() -> String {
    format!("please echo {LEXICON} back")
}

#[tokio::test]
async fn the_floor_binds_a_byok_tenant_on_the_fleet_over_its_own_overlay() {
    let plane = ControlPlane::new(floor_wire(2));
    let (url, server) = plane.serve().await;
    let harness = gateway(url, GatewayCustody::Fleet);

    // Clean control: the tenant is served with `managedInference: false`.
    let (status, body, _) = send(&harness.app, chat("rgw_floor_one", "hello")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(harness.calls.load(Ordering::SeqCst), 1);

    // The tenant overlay switches the firewall off; the floor still blocks.
    let (status, body, _) = send(&harness.app, chat("rgw_floor_one", &flagged_prompt())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["type"], "policy_violation");
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        1,
        "a floor block never reaches the upstream"
    );

    let advertised = plane.capabilities.lock().unwrap().clone();
    assert!(!advertised.is_empty());
    assert!(advertised.iter().all(|value| value
        .split(',')
        .any(|token| token.trim() == "platform_floor")));
    server.abort();
}

#[tokio::test]
async fn managed_and_self_hosted_nodes_never_apply_the_floor() {
    let plane = ControlPlane::new(floor_wire(2));
    let (url, server) = plane.serve().await;
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let harness = gateway(url.clone(), custody);
        let (status, body, _) = send(&harness.app, chat("rgw_floor_one", &flagged_prompt())).await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {body}");
        assert_eq!(harness.calls.load(Ordering::SeqCst), 1, "{custody:?}");
    }
    server.abort();
}

#[tokio::test]
async fn a_fleet_that_never_received_a_floor_refuses_before_dispatch() {
    for unavailable in [true, false] {
        let plane = ControlPlane::new(Value::Null);
        if unavailable {
            plane.set_unavailable();
        }
        let (url, server) = plane.serve().await;
        let harness = gateway(url.clone(), GatewayCustody::Fleet);
        let (status, body, retry_after) = send(&harness.app, chat("rgw_floor_one", "hello")).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable={unavailable}: {body}"
        );
        assert_eq!(body["error"]["code"], "screening_unavailable");
        assert_eq!(body["error"]["layer"], "platform");
        assert_eq!(retry_after.as_deref(), Some("10"));
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);

        // The same answer serves a self-hosted node, which is never floor-bound.
        let self_hosted = gateway(url, GatewayCustody::SelfHosted);
        let (status, body, _) = send(&self_hosted.app, chat("rgw_floor_one", "hello")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        server.abort();
    }
}

#[tokio::test]
async fn a_floor_the_fleet_cannot_apply_refuses_like_a_missing_one() {
    let mut wire = floor_wire(2);
    wire["overlay"]["custom_patterns"] = json!([{ "name": "bad", "regex": "(", "kind": "secret" }]);
    let plane = ControlPlane::new(wire);
    let (url, server) = plane.serve().await;
    let harness = gateway(url, GatewayCustody::Fleet);
    let (status, body, _) = send(&harness.app, chat("rgw_floor_one", "hello")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "screening_unavailable");
    assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn the_last_known_floor_survives_an_unavailable_resolve() {
    let plane = ControlPlane::new(floor_wire(3));
    let (url, server) = plane.serve().await;
    let harness = gateway(url, GatewayCustody::Fleet);
    let (status, body, _) = send(&harness.app, chat("rgw_floor_one", "hello")).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The control plane loses its floor. A new token resolves fresh and gets
    // `platformFloorUnavailable`, but the fleet keeps the floor it holds.
    plane.set_unavailable();
    let (status, body, _) = send(&harness.app, chat("rgw_floor_two", "hello")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body, _) = send(&harness.app, chat("rgw_floor_two", &flagged_prompt())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(harness.calls.load(Ordering::SeqCst), 2);
    server.abort();
}
