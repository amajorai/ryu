//! Real Gateway execution with loopback OpenAI wire fixtures. No vendor calls.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, Response};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::{Barrier, Notify};

use super::{run, run_stream, RequestContext};
use crate::audit::{AuditEntry, AuditLogger, AuditQuery};
use crate::config::{AuditConfig, FirewallConfig, FirewallPolicy, GatewayConfig, ProviderId};
use crate::error::GatewayError;
use crate::state::AppState;

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Clone)]
struct WireReply {
    text: String,
    delay: Duration,
}

#[derive(Clone)]
struct WireCall {
    body: Value,
    authorization: String,
}

struct WireState {
    replies: HashMap<String, WireReply>,
    calls: Mutex<Vec<WireCall>>,
    panel_barrier: Option<Arc<Barrier>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    accepted: Notify,
    hold_a: AtomicBool,
    release_a: Notify,
}

struct ActiveHandler(Arc<WireState>);
impl Drop for ActiveHandler {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Fixture {
    state: Arc<AppState>,
    wire: Arc<WireState>,
    server: tokio::task::JoinHandle<()>,
    _audit_directory: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(
        strategy: &str,
        replies: &[(&str, &str, u64)],
        panel_barrier: bool,
        configure: impl FnOnce(&mut GatewayConfig),
    ) -> Self {
        let wire = Arc::new(WireState {
            replies: replies
                .iter()
                .map(|(model, text, delay)| {
                    (
                        (*model).to_owned(),
                        WireReply {
                            text: (*text).to_owned(),
                            delay: Duration::from_millis(*delay),
                        },
                    )
                })
                .collect(),
            calls: Mutex::new(Vec::new()),
            panel_barrier: panel_barrier.then(|| Arc::new(Barrier::new(3))),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            accepted: Notify::new(),
            hold_a: AtomicBool::new(false),
            release_a: Notify::new(),
        });
        let handler = Arc::clone(&wire);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let wire = Arc::clone(&handler);
                async move {
                    let _active = ActiveHandler(Arc::clone(&wire));
                    let active = wire.active.fetch_add(1, Ordering::SeqCst) + 1;
                    wire.peak.fetch_max(active, Ordering::SeqCst);
                    wire.calls.lock().unwrap().push(WireCall {
                        authorization: headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned(),
                        body: body.clone(),
                    });
                    let model = body["model"].as_str().unwrap_or_default();
                    wire.accepted.notify_one();
                    if model == "a" && wire.hold_a.load(Ordering::SeqCst) {
                        wire.release_a.notified().await;
                    }
                    if model != "judge" {
                        if let Some(barrier) = &wire.panel_barrier {
                            barrier.wait().await;
                        }
                    }
                    let reply = wire.replies.get(model).cloned().unwrap_or(WireReply {
                        text: format!("answer from {model}"),
                        delay: Duration::ZERO,
                    });
                    tokio::time::sleep(reply.delay).await;
                    if body["stream"].as_bool() == Some(true) {
                        let delta = json!({"choices":[{"index":0,"delta":{"content":reply.text}}]});
                        let usage = json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21,"cost":0.001}});
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from(format!(
                                "data: {delta}\n\ndata: {usage}\n\ndata: [DONE]\n\n"
                            )))
                            .unwrap()
                            .into_response()
                    } else {
                        Json(json!({
                            "id":format!("wire-{model}"),"object":"chat.completion","model":model,
                            "choices":[{"index":0,"message":{"role":"assistant","content":reply.text},"finish_reason":"stop"}],
                            "usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21,"cost":0.001}
                        }))
                        .into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = GatewayConfig::default();
        config.routing.default_provider = ProviderId::from("openai");
        config.routing.fallback_chain = vec![ProviderId::from("openai")];
        config.routing.model_map.insert(
            "ensemble".into(),
            serde_json::from_value(json!({"provider":"pool:flow"})).unwrap(),
        );
        let mut pool = json!({
            "strategy":strategy,
            "execution":{"quorum":3,"grace_ms":1,"leg_timeout_ms":1000,"total_timeout_ms":2000,"max_output_bytes":262144},
            "members":[
                {"provider":"openai","model":"a"},
                {"provider":"openai","model":"b"},
                {"provider":"openai","model":"c"}
            ]
        });
        if strategy == "fusion" {
            pool["judge"] = json!({"provider":"openai","model":"judge"});
        }
        config
            .routing
            .provider_pools
            .insert("flow".into(), serde_json::from_value(pool).unwrap());
        config.providers.openai = Some(
            serde_json::from_value(json!({"api_key":"fixture-upstream-key","base_url":base}))
                .unwrap(),
        );
        config.firewall = FirewallConfig {
            enabled: false,
            ..Default::default()
        };
        config.budgets.users.insert(
            "pool-user".into(),
            serde_json::from_value(json!({"limit":1_000_000})).unwrap(),
        );
        config.budgets.session.limit = 1_000_000;
        configure(&mut config);
        let audit_directory = tempfile::tempdir().unwrap();
        let audit_config = AuditConfig {
            enabled: true,
            db_path: audit_directory
                .path()
                .join("audit.db")
                .to_string_lossy()
                .into_owned(),
        };
        config.audit = audit_config.clone();
        let audit = AuditLogger::new(&audit_config).unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            crate::evals::EvalsRunner::new(Default::default()),
        ));
        Self {
            state,
            wire,
            server,
            _audit_directory: audit_directory,
        }
    }

    fn calls(&self) -> Vec<WireCall> {
        self.wire.calls.lock().unwrap().clone()
    }

    fn models(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call.body["model"].as_str().unwrap().to_owned())
            .collect()
    }

    fn paid_audit(&self) -> Vec<AuditEntry> {
        self.state
            .audit
            .query(&AuditQuery {
                session_id: Some("pool-session".into()),
                limit: Some(100),
                ..Default::default()
            })
            .unwrap()
            .into_iter()
            .filter(|entry| entry.input_tokens > 0 || entry.output_tokens > 0)
            .collect()
    }

    fn user_spend(&self) -> u64 {
        self.state.with_budget(|budget| {
            budget
                .spend_snapshot()
                .users
                .get("pool-user")
                .copied()
                .unwrap_or(0)
        })
    }

    async fn await_paid_audit(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if self.paid_audit().len() == count {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("accepted loopback work must retain accounting");
    }
}

fn context() -> RequestContext {
    let mut context = super::test_support::plain_request_context();
    context.user_id = Some("pool-user".into());
    context.session_id = Some("pool-session".into());
    context.request_id = "pool-parent".into();
    context
}

fn request() -> Value {
    json!({"model":"ensemble","max_tokens":128,"messages":[
        {"role":"system","content":"Preserve the original system authority"},
        {"role":"user","content":"Answer the original task"}
    ]})
}

#[tokio::test]
async fn fusion_real_wire_uses_three_panels_one_judge_and_separate_paid_receipts() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("fusion", &[], true, |_| {}).await;
    let output = run(Arc::clone(&fixture.state), context(), request())
        .await
        .unwrap();
    assert_eq!(output.model_used, "judge");
    assert!(output.response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .contains("judge"));
    let mut models = fixture.models();
    models.sort();
    assert_eq!(models, ["a", "b", "c", "judge"]);
    assert_eq!(fixture.wire.peak.load(Ordering::SeqCst), 3);
    assert!(fixture
        .calls()
        .iter()
        .all(|call| call.authorization == "Bearer fixture-upstream-key"));
    fixture.await_paid_audit(4).await;
    let rows = fixture.paid_audit();
    assert_eq!(rows.len(), 4);
    assert_eq!(
        rows.iter()
            .map(|row| &row.request_id)
            .collect::<HashSet<_>>()
            .len(),
        4
    );
    assert!(rows
        .iter()
        .all(|row| row.session_id.as_deref() == Some("pool-session")));
    assert_eq!(fixture.state.audit.token_usage("sk-test"), 84);
    assert_eq!(fixture.user_spend(), 4_000);
}

#[tokio::test]
async fn tool_bearing_fusion_dispatches_only_judge_with_original_tool_decision() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("fusion", &[], false, |_| {}).await;
    let mut body = request();
    body["tools"] = json!([{"type":"function","function":{"name":"caller_owned_tool","parameters":{"type":"object"}}}]);
    body["tool_choice"] = json!("auto");
    let expected_tools = body["tools"].clone();
    let mut ctx = context();
    ctx.raw_tools = true;
    run(Arc::clone(&fixture.state), ctx, body).await.unwrap();
    assert_eq!(fixture.models(), ["judge"]);
    assert_eq!(fixture.calls()[0].body["tools"], expected_tools);
    assert_eq!(fixture.calls()[0].body["tool_choice"], "auto");
    fixture.await_paid_audit(1).await;
    assert_eq!(fixture.paid_audit().len(), 1);
    assert_eq!(fixture.user_spend(), 1_000);
}

#[tokio::test]
async fn pipeline_real_wire_threads_prior_outputs_without_promoting_system_authority() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("pipeline", &[], false, |_| {}).await;
    let original_system = request()["messages"][0].clone();
    run(Arc::clone(&fixture.state), context(), request())
        .await
        .unwrap();
    assert_eq!(fixture.models(), ["a", "b", "c"]);
    let calls = fixture.calls();
    assert!(calls
        .iter()
        .all(|call| call.body["messages"][0] == original_system));
    for (index, previous) in [(1, "a"), (2, "b")] {
        let messages = calls[index].body["messages"].as_array().unwrap();
        let handoff = messages.last().unwrap();
        assert_eq!(handoff["role"], "user");
        let content = handoff["content"].as_str().unwrap();
        assert!(
            content.contains("untrusted") && content.contains(&format!("answer from {previous}"))
        );
    }
    fixture.await_paid_audit(3).await;
    assert_eq!(fixture.paid_audit().len(), 3);
    assert_eq!(fixture.user_spend(), 3_000);
}

#[tokio::test]
async fn policy_denies_judge_and_intermediate_stage_before_their_dispatch() {
    let _serial = serial().lock().await;
    let fusion = Fixture::new("fusion", &[], false, |_| {}).await;
    let mut ctx = context();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["ensemble".into(), "a".into(), "b".into(), "c".into()],
        ..Default::default()
    });
    assert!(run(Arc::clone(&fusion.state), ctx, request())
        .await
        .is_err());
    assert!(
        fusion.models().is_empty(),
        "judge denial must precede any panel work"
    );
    let pipeline = Fixture::new("pipeline", &[], false, |_| {}).await;
    let mut ctx = context();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["ensemble".into(), "a".into(), "c".into()],
        ..Default::default()
    });
    assert!(run(Arc::clone(&pipeline.state), ctx, request())
        .await
        .is_err());
    assert!(
        pipeline.models().is_empty(),
        "all known stages are approved before paid work"
    );
    assert!(pipeline.paid_audit().is_empty());
}

#[tokio::test]
async fn accepted_stage_timeout_never_replays_or_dispatches_next_stage() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new(
        "pipeline",
        &[("a", "late accepted answer", 1500)],
        false,
        |config| {
            let limits = &mut config
                .routing
                .provider_pools
                .get_mut("flow")
                .unwrap()
                .execution;
            limits.leg_timeout_ms = 500;
            limits.total_timeout_ms = 2000;
        },
    )
    .await;
    let state = Arc::clone(&fixture.state);
    let mut execution = tokio::spawn(async move { run(state, context(), request()).await });
    tokio::select! {
        _ = fixture.wire.accepted.notified() => {}
        result = &mut execution => {
            match result.unwrap() {
                Err(error) => panic!("execution ended before HTTP acceptance: {error:?}"),
                Ok(_) => panic!("execution completed before HTTP acceptance"),
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("HTTP acceptance was not observed"),
    }
    let result = execution.await.unwrap();
    assert!(matches!(
        result,
        Err(GatewayError::ProviderDeliveryUncertain(_))
    ));
    assert_eq!(fixture.models(), ["a"]);
    // No subsequent stage may be initiated even if the accepted peer replies late.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(fixture.models(), ["a"]);
}

#[tokio::test]
async fn budget_denial_between_stages_preserves_first_charge_and_audit() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("pipeline", &[], false, |config| {
        config.budgets.users.insert(
            "pool-user".into(),
            serde_json::from_value(json!({"limit":1000})).unwrap(),
        );
    })
    .await;
    assert!(matches!(
        run(Arc::clone(&fixture.state), context(), request()).await,
        Err(GatewayError::BudgetExceeded(_))
    ));
    assert_eq!(fixture.models(), ["a"]);
    fixture.await_paid_audit(1).await;
    assert_eq!(fixture.paid_audit().len(), 1);
    assert_eq!(fixture.user_spend(), 1_000);
}

#[tokio::test]
async fn policy_revoked_after_accepted_stage_retains_paid_work_and_stops_next_stage() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("pipeline", &[], false, |_| {}).await;
    fixture.wire.hold_a.store(true, Ordering::SeqCst);
    let state = Arc::clone(&fixture.state);
    let mut execution = tokio::spawn(async move { run(state, context(), request()).await });
    tokio::select! {
        _ = fixture.wire.accepted.notified() => {}
        result = &mut execution => {
            match result.unwrap() {
                Err(error) => panic!("execution ended before HTTP acceptance: {error:?}"),
                Ok(_) => panic!("execution completed before HTTP acceptance"),
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("HTTP acceptance was not observed"),
    }
    fixture.state.set_policy(crate::policy::EffectivePolicy {
        approved_models: vec!["ensemble".into(), "a".into(), "c".into()],
        ..Default::default()
    });
    fixture.wire.release_a.notify_one();
    assert!(matches!(
        execution.await.unwrap(),
        Err(GatewayError::PolicyViolation(_))
    ));
    assert_eq!(fixture.models(), ["a"]);
    fixture.await_paid_audit(1).await;
    assert_eq!(fixture.user_spend(), 1000);
    assert_eq!(fixture.paid_audit().len(), 1);
}

#[tokio::test]
async fn quorum_delivery_cancellation_retains_late_accepted_panel_accounting() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new(
        "fusion",
        &[("c", "late panel answer", 120)],
        true,
        |config| {
            let limits = &mut config
                .routing
                .provider_pools
                .get_mut("flow")
                .unwrap()
                .execution;
            limits.quorum = 2;
            limits.grace_ms = 1;
        },
    )
    .await;
    run(Arc::clone(&fixture.state), context(), request())
        .await
        .unwrap();
    assert_eq!(fixture.models().len(), 4);
    fixture.await_paid_audit(4).await;
    assert_eq!(fixture.user_spend(), 4_000);
    assert_eq!(
        fixture
            .models()
            .iter()
            .filter(|model| model.as_str() == "c")
            .count(),
        1
    );
    assert_eq!(
        fixture
            .models()
            .iter()
            .filter(|model| model.as_str() == "judge")
            .count(),
        1
    );
}

#[tokio::test]
async fn global_pool_capacity_rejects_before_any_upstream_dispatch() {
    let _serial = serial().lock().await;
    let slots = super::auxiliary::pool_leg_slots_for_test();
    let capacity = tokio::time::timeout(Duration::from_secs(2), slots.acquire_many_owned(128))
        .await
        .unwrap()
        .unwrap();
    let fixture = Fixture::new("fusion", &[], false, |_| {}).await;
    assert!(run(Arc::clone(&fixture.state), context(), request())
        .await
        .is_err());
    assert!(fixture.models().is_empty());
    assert!(fixture.paid_audit().is_empty());
    drop(capacity);
}

#[tokio::test]
async fn final_judge_stream_observes_usage_and_dlp_without_a_second_judge_call() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new(
        "fusion",
        &[("judge", "Contact person@example.com", 0)],
        true,
        |config| {
            config.firewall = FirewallConfig {
                enabled: true,
                scan_inbound: false,
                scan_outbound: true,
                policy: FirewallPolicy::Sanitize,
                ..Default::default()
            };
        },
    )
    .await;
    let mut body = request();
    body["stream"] = json!(true);
    let output = run_stream(Arc::clone(&fixture.state), context(), body)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(output.body, 256 * 1024).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!text.contains("person@example.com"));
    assert!(text.contains("[DONE]"));
    fixture.await_paid_audit(4).await;
    assert_eq!(
        fixture
            .models()
            .iter()
            .filter(|model| model.as_str() == "judge")
            .count(),
        1
    );
    let calls = fixture.calls();
    assert!(calls
        .iter()
        .filter(|call| call.body["model"] != "judge")
        .all(|call| call.body["stream"] == false));
    assert_eq!(
        calls
            .iter()
            .find(|call| call.body["model"] == "judge")
            .unwrap()
            .body["stream"],
        true
    );
    assert_eq!(fixture.state.audit.token_usage("sk-test"), 84);
    assert_eq!(fixture.user_spend(), 4_000);
}

#[tokio::test]
async fn reusable_prefix_affinity_is_isolated_between_authenticated_principals() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("cache_optimized", &[], false, |config| {
        config.auth.require_auth = true;
        config.auth.api_keys = vec![
            serde_json::from_value(json!({
                "key":"sk-principal-a","name":"principal-a","org_id":"org-a"
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "key":"sk-principal-b","name":"principal-b","org_id":"org-b"
            }))
            .unwrap(),
        ];
    })
    .await;
    let a = super::authenticate(
        &fixture.state,
        super::AuthInputs::with_key(Some("sk-principal-a")),
    )
    .await
    .unwrap();
    let b = super::authenticate(
        &fixture.state,
        super::AuthInputs::with_key(Some("sk-principal-b")),
    )
    .await
    .unwrap();
    assert_eq!(a.org_id.as_deref(), Some("org-a"));
    assert_eq!(b.org_id.as_deref(), Some("org-b"));
    assert_ne!(a.owner_binding, b.owner_binding);
    let reusable = request();
    let snapshot = fixture.state.provider_runtime.snapshot();

    // Establish conflicting cache-affinity feedback from real successful
    // Gateway calls. Selection is constrained only for this seeding step, and
    // no session binding exists yet to mask an unscoped prefix collision.
    for (principal, model) in [(&a, "a"), (&b, "b")] {
        let facts = super::pool_signals::scoped_request_facts(&fixture.state, principal, &reusable);
        let selected = snapshot
            .provider_pools
            .select_with_facts(
                "pool:flow",
                None,
                &facts,
                |_, candidate| candidate == model,
                |_| ryu_gw_router::pool::MemberSignals::default(),
            )
            .unwrap()
            .unwrap();
        let mut seed = reusable.clone();
        seed["model"] = json!(model);
        let output = run(Arc::clone(&fixture.state), principal.clone(), seed)
            .await
            .unwrap();
        assert_eq!(output.model_used, model);
        snapshot
            .provider_pools
            .record_success_facts(&selected, None, &facts, 1);
    }

    for (principal, expected) in [(&a, "a"), (&b, "b"), (&a, "a"), (&b, "b")] {
        let mut ctx = principal.clone();
        ctx.session_id = Some("identical-session-label".into());
        let mut body = reusable.clone();
        body["prompt_cache_key"] = json!("identical-caller-cache-key");
        let output = run(Arc::clone(&fixture.state), ctx, body).await.unwrap();
        assert_eq!(
            output.model_used, expected,
            "a reusable prefix must retain only this principal's successful member"
        );
        assert!(
            !output.cache_hit,
            "real pool dispatch must not be hidden by a response cache"
        );
    }
    assert_eq!(fixture.models(), ["a", "b", "a", "b", "a", "b"]);
    assert!(fixture
        .calls()
        .iter()
        .all(|call| { call.body["messages"][0] == reusable["messages"][0] }));
}

/// A test-only inbound pattern. Outbound DLP already redacts built-in secrets
/// in a leg's answer, so the panel and stage cases trip on this
/// prompt-injection pattern, which only the inbound screens read.
const LEXICON: &str = "RYU_TEST_LEXICON";

fn inbound_block(config: &mut GatewayConfig) {
    config.firewall = FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: false,
        policy: FirewallPolicy::Block,
        custom_patterns: vec![crate::config::CustomPattern {
            name: "ryu_test_lexicon".into(),
            regex: LEXICON.into(),
            kind: crate::config::CustomPatternKind::PromptInjection,
        }],
        ..Default::default()
    };
}

/// The parent request's refusal row, polled because the logger writes
/// off-thread.
async fn refusal_rows(fixture: &Fixture) -> Vec<AuditEntry> {
    let mut rows = Vec::new();
    for _ in 0..200 {
        rows = fixture
            .state
            .audit
            .query(&AuditQuery {
                limit: Some(100),
                ..Default::default()
            })
            .unwrap()
            .into_iter()
            .filter(|row| row.request_id == "pool-parent" && row.error.is_some())
            .collect();
        if !rows.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    rows
}

fn assert_firewall_refusal(error: GatewayError) {
    assert!(
        matches!(error, GatewayError::FirewallBlocked(..)),
        "the appended answer must be refused by the firewall: {error:?}"
    );
    let response = error.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
}

/// A panel answer carrying a blocked pattern is screened before it joins the judge
/// body, so the judge is never called (P0-4). The benign control is
/// `fusion_real_wire_uses_three_panels_one_judge_and_separate_paid_receipts`.
#[tokio::test]
async fn fusion_panel_answer_matching_the_firewall_never_reaches_the_judge() {
    let _serial = serial().lock().await;
    let answer = format!("marker {LEXICON} here");
    let fixture = Fixture::new("fusion", &[("b", answer.as_str(), 0)], false, inbound_block).await;
    let error = run(Arc::clone(&fixture.state), context(), request())
        .await
        .err()
        .expect("the judge body matches the firewall");
    assert_firewall_refusal(error);
    let mut models = fixture.models();
    models.sort();
    assert_eq!(models, ["a", "b", "c"], "zero calls to the judge");
    let rows = refusal_rows(&fixture).await;
    assert_eq!(rows.len(), 1, "one refusal row: {rows:?}");
    assert!(rows[0]
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("blocked"));
}

#[tokio::test]
async fn control_fusion_with_benign_answers_dispatches_the_judge_under_block() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("fusion", &[], false, inbound_block).await;
    let output = run(Arc::clone(&fixture.state), context(), request())
        .await
        .unwrap();
    assert_eq!(output.model_used, "judge");
    assert!(fixture.models().contains(&"judge".to_owned()));
}

/// The last pipeline stage is dispatched by the main pipeline, not as a
/// governed leg, so the previous stage's answer is screened when it is
/// appended (P0-4).
#[tokio::test]
async fn pipeline_stage_answer_matching_the_firewall_never_reaches_the_final_stage() {
    let _serial = serial().lock().await;
    let answer = format!("marker {LEXICON} here");
    let fixture = Fixture::new(
        "pipeline",
        &[("b", answer.as_str(), 0)],
        false,
        inbound_block,
    )
    .await;
    let error = run(Arc::clone(&fixture.state), context(), request())
        .await
        .err()
        .expect("the final stage body matches the firewall");
    assert_firewall_refusal(error);
    assert_eq!(
        fixture.models(),
        ["a", "b"],
        "zero calls to the final stage"
    );
    let rows = refusal_rows(&fixture).await;
    assert_eq!(rows.len(), 1, "one refusal row: {rows:?}");
}

#[tokio::test]
async fn control_pipeline_with_benign_answers_reaches_the_final_stage_under_block() {
    let _serial = serial().lock().await;
    let fixture = Fixture::new("pipeline", &[], false, inbound_block).await;
    run(Arc::clone(&fixture.state), context(), request())
        .await
        .unwrap();
    assert_eq!(fixture.models(), ["a", "b", "c"]);
}
