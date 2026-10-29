//! Session Box tool routing tests (prefix `box_desktop_`).
//!
//! The registry tests run under the session Box [`Harness`], which points
//! Core's Box credential at a loopback fake Box service and serializes every
//! test that touches the process-wide session Box registry. That fake answers
//! the lifecycle routes; it records `/desktop/actions` and `/browser/:verb`
//! without serving them, so those tests assert on the recorded requests. The
//! request and result shapes of [`execute`] are covered against a fake of
//! their own.
use super::*;
use crate::server::conversations::Tenancy;
use crate::server::session_box::tests::{cloud_user, local_owner, Harness, Recorded};
use crate::sidecar::mcp::McpRegistry;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

async fn store_with(conversation_id: &str, tenancy: Tenancy) -> ConversationStore {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(conversation_id, None, None, tenancy)
        .await
        .unwrap();
    store
}

fn registry(store: ConversationStore) -> McpRegistry {
    McpRegistry::empty().with_conversations(store)
}

async fn call(
    registry: &McpRegistry,
    tool: &str,
    arguments: Value,
    conversation_id: Option<&str>,
) -> Result<Value> {
    Box::pin(registry.call_tool_with_identity_no_gate(
        None,
        tool,
        arguments,
        None,
        None,
        &[],
        None,
        conversation_id,
    ))
    .await
}

fn creates(harness: &Harness) -> Vec<Recorded> {
    harness.fake.matching("POST", "/v1/boxes")
}

fn box_id_of(created: usize) -> String {
    // The fake numbers Boxes `bx_<32 hex digits>` from 1.
    format!("bx_{created:032x}")
}

fn desktop_actions(harness: &Harness) -> Vec<Recorded> {
    harness
        .fake
        .requests()
        .into_iter()
        .filter(|request| request.method == "POST" && request.path.ends_with("/desktop/actions"))
        .collect()
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

#[test]
fn box_desktop_plan_maps_the_canonical_verbs() {
    let cases = [
        (
            "computer.capture",
            json!({}),
            json!({"action":"screenshot"}),
        ),
        (
            "computer.click",
            json!({"x": 10, "y": 20, "button": "right", "count": 2}),
            json!({"action":"click","x":10,"y":20,"button":"right","count":2}),
        ),
        (
            "computer.type",
            json!({"text": "hello"}),
            json!({"action":"type","text":"hello"}),
        ),
        (
            "computer.key",
            json!({"keys": ["ctrl", "l"]}),
            json!({"action":"key","keys":["ctrl","l"]}),
        ),
        (
            "computer.scroll",
            json!({"direction": "down", "amount": 3, "x": 1, "y": 2}),
            json!({"action":"scroll","direction":"down","amount":3,"x":1,"y":2}),
        ),
        (
            "computer.focus_app",
            json!({"app": "Firefox"}),
            json!({"action":"focus_app","app":"Firefox"}),
        ),
    ];
    for (verb, arguments, action) in cases {
        assert_eq!(
            plan(verb, &arguments).unwrap(),
            Planned::Desktop(action),
            "{verb}"
        );
    }
    assert_eq!(
        plan("computer.capture", &Value::Null).unwrap(),
        Planned::Desktop(json!({"action":"screenshot"}))
    );
    assert_eq!(
        plan("browser.navigate", &json!({"url": "https://example.com"})).unwrap(),
        Planned::Browser {
            verb: "navigate",
            body: json!({"url": "https://example.com"}),
        }
    );
    assert_eq!(
        plan(
            "browser.click_at",
            &json!({"x": 1.5, "y": 2, "tab_id": "t1"})
        )
        .unwrap(),
        Planned::Browser {
            verb: "click_at",
            body: json!({"x": 1.5, "y": 2, "tab_id": "t1"}),
        }
    );
    assert_eq!(
        plan("browser.tabs", &json!({})).unwrap(),
        Planned::Browser {
            verb: "tabs",
            body: json!({}),
        }
    );
}

#[test]
fn box_desktop_plan_rejects_arguments_naming_a_box_url_or_session() {
    for (verb, arguments) in [
        (
            "computer.click",
            json!({"x": 1, "y": 2, "box_id": "bx_other"}),
        ),
        (
            "computer.click",
            json!({"x": 1, "y": 2, "boxId": "bx_other"}),
        ),
        (
            "computer.capture",
            json!({"url": "wss://box.example/v1/boxes/bx/desktop/ws"}),
        ),
        (
            "computer.type",
            json!({"text": "a", "session_id": "other#sub:1"}),
        ),
        (
            "browser.navigate",
            json!({"url": "https://example.com", "session": "other"}),
        ),
        ("browser.tabs", json!({"endpoint": "http://10.0.0.1:6080"})),
        ("browser.snapshot", json!({"tab_id": "t", "display": ":99"})),
    ] {
        let error = plan(verb, &arguments).unwrap_err().to_string();
        assert!(error.contains("does not accept"), "{verb}: {error}");
    }
    for (verb, arguments, expected) in [
        ("computer.click", json!({"x": 1}), "requires 'y'"),
        ("computer.click", json!({"x": "1", "y": 2}), "wrong type"),
        ("computer.click", json!({"x": 1.5, "y": 2}), "wrong type"),
        (
            "computer.click",
            json!({"x": 1, "y": 2, "button": "back"}),
            "allowed values",
        ),
        ("computer.key", json!({"keys": ["ctrl", 1]}), "wrong type"),
        (
            "computer.scroll",
            json!({"direction": "sideways"}),
            "allowed values",
        ),
        ("browser.navigate", json!({}), "requires 'url'"),
        ("computer.type", json!("text"), "must be an object"),
        (
            "web.search",
            json!({"query": "q"}),
            "not a computer or browser verb",
        ),
    ] {
        let error = plan(verb, &arguments).unwrap_err().to_string();
        assert!(error.contains(expected), "{verb}: {error}");
    }
}

// ── Box requests and results ─────────────────────────────────────────────────

type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

async fn fake_desktop(
    State(seen): State<Seen>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = request.uri().path().to_owned();
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    seen.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push((path.clone(), bearer, body.clone()));
    if path.ends_with("/desktop/actions") {
        if body["action"] == "screenshot" {
            return Json(json!({
                "ok": true, "type": "desktop.action", "action": "screenshot",
                "encoding": "base64", "image": "iVBORw0KGgo=", "mime": "image/png",
                "width": 1600, "height": 1000, "screenWidth": 1600, "screenHeight": 1000,
            }))
            .into_response();
        }
        if body["action"] == "type" {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error": {"code": "invalid_request", "message": "text is too long"}})),
            )
                .into_response();
        }
        return Json(json!({"ok": true, "type": "desktop.action", "action": body["action"]}))
            .into_response();
    }
    Json(json!({
        "ok": true, "type": "browser.result", "verb": "navigate",
        "result": {"tab_id": "t1", "url": body["url"]},
    }))
    .into_response()
}

#[tokio::test]
async fn box_desktop_execute_calls_the_box_routes_and_shapes_results() {
    let seen: Seen = Arc::default();
    let router = Router::new()
        .route("/v1/boxes/:id/desktop/actions", post(fake_desktop))
        .route("/v1/boxes/:id/browser/:verb", post(fake_desktop))
        .with_state(Arc::clone(&seen));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let client = BoxSessionClient::with_endpoint(format!("http://{address}/v1"), "rbx1.bearer");
    let target = BoxTarget {
        box_id: ryu_sandbox::WorkspaceId("bx_0123456789abcdef0123456789abcdef".to_owned()),
        lease_id: "lease-1".to_owned(),
        run_id: "lease-1".to_owned(),
        size: ryu_sandbox::box_types::BoxSize::Small,
        desktop: true,
        source: session_box::TargetSource::Session,
    };

    let capture = execute(
        &client,
        &target,
        &plan("computer.capture", &json!({})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        capture,
        json!({
            "provider": PROVIDER_ID, "target": "remote-desktop", "action": "screenshot",
            "encoding": "base64", "image": "iVBORw0KGgo=", "mime": "image/png",
            "width": 1600, "height": 1000, "screenWidth": 1600, "screenHeight": 1000,
        })
    );
    let click = execute(
        &client,
        &target,
        &plan("computer.click", &json!({"x": 5, "y": 6})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        click,
        json!({"provider": PROVIDER_ID, "target": "remote-desktop", "action": "click"})
    );
    let navigate = execute(
        &client,
        &target,
        &plan("browser.navigate", &json!({"url": "https://example.com"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        navigate,
        json!({
            "provider": PROVIDER_ID, "target": "remote-desktop", "verb": "navigate",
            "result": {"tab_id": "t1", "url": "https://example.com"},
        })
    );
    let refused = execute(
        &client,
        &target,
        &plan("computer.type", &json!({"text": "x"})).unwrap(),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("invalid_request") && refused.contains("text is too long"),
        "{refused}"
    );

    let seen = seen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let box_path = format!("/v1/boxes/{}", target.box_id.0);
    assert_eq!(
        seen.iter()
            .map(|(path, _, body)| (path.clone(), body.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                format!("{box_path}/desktop/actions"),
                json!({"action": "screenshot"})
            ),
            (
                format!("{box_path}/desktop/actions"),
                json!({"action": "click", "x": 5, "y": 6}),
            ),
            (
                format!("{box_path}/browser/navigate"),
                json!({"url": "https://example.com"}),
            ),
            (
                format!("{box_path}/desktop/actions"),
                json!({"action": "type", "text": "x"}),
            ),
        ]
    );
    assert!(seen
        .iter()
        .all(|(_, bearer, _)| bearer == "Bearer rbx1.bearer"));
}

// ── Facade routing ───────────────────────────────────────────────────────────

#[tokio::test]
async fn box_desktop_computer_click_in_a_conversation_acquires_a_box_not_the_node() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);

    let probe = Arc::new(AtomicUsize::new(0));
    let outcome = GATE_PROBE
        .scope(
            Arc::clone(&probe),
            call(
                &registry,
                "computer.click",
                json!({"x": 40, "y": 50}),
                Some(&conversation),
            ),
        )
        .await;
    // The fake records `/desktop/actions` without serving it; the call reached
    // the Box, not a node provider (none is installed, which would have
    // answered a structured "no provider" instead).
    assert!(outcome.is_err(), "{outcome:?}");
    assert_eq!(creates(&harness).len(), 1, "one session Box was created");
    let actions = desktop_actions(&harness);
    assert_eq!(actions.len(), 1);
    assert_eq!(
        actions[0].path,
        format!("/v1/boxes/{}/desktop/actions", box_id_of(1))
    );
    assert_eq!(
        actions[0].body,
        json!({"action": "click", "x": 40, "y": 50})
    );
    // No re-entry: the conversation gate ran exactly once for the call.
    assert_eq!(probe.load(Ordering::SeqCst), 1);

    // The next verb reuses the live Box; the browser verb goes to `/browser`.
    let _ = call(
        &registry,
        "browser.navigate",
        json!({"url": "https://example.com"}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    assert_eq!(
        harness
            .fake
            .matching(
                "POST",
                &format!("/v1/boxes/{}/browser/navigate", box_id_of(1))
            )
            .last()
            .map(|request| request.body.clone()),
        Some(json!({"url": "https://example.com"}))
    );
    assert!(session_box::routes_to_box(&SessionBoxKey::session(NODE_OWNER, &conversation)).await);
}

#[tokio::test]
async fn box_desktop_node_preference_and_conversationless_calls_stay_on_the_node() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);

    // Without a conversation (an automation, a background run) the node's
    // provider path answers: no provider is installed here, so it says so.
    let node = call(&registry, "computer.capture", json!({}), None)
        .await
        .unwrap();
    assert_eq!(node["available"], json!(false));
    assert_eq!(node["capability"], json!(CAP_COMPUTER));

    let preferences = crate::server::preferences::PreferencesStore::open_default().unwrap();
    preferences
        .set(session_box::PREF_COMPUTER_TARGET, "node")
        .await
        .unwrap();
    let preferred = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await;
    preferences
        .delete(session_box::PREF_COMPUTER_TARGET)
        .await
        .unwrap();
    let preferred = preferred.unwrap();
    assert_eq!(preferred["available"], json!(false));
    assert_eq!(preferred["capability"], json!(CAP_COMPUTER));
    assert!(
        creates(&harness).is_empty(),
        "no Box for the node preference"
    );
    assert!(desktop_actions(&harness).is_empty());
}

#[tokio::test]
async fn box_desktop_arguments_naming_a_box_are_refused_before_any_box_is_acquired() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);
    let error = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2, "boxId": "bx_00000000000000000000000000000009"}),
        Some(&conversation),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("does not accept 'boxId'"), "{error}");
    assert!(creates(&harness).is_empty());
}

#[tokio::test]
async fn box_desktop_a_bound_cloud_conversation_runs_machine_verbs_only_on_its_box() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);
    // The conversation gets its Box, then is bound to a cloud task.
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    bound_for_test().insert(conversation.clone());

    let probe = Arc::new(AtomicUsize::new(0));
    let routed = GATE_PROBE
        .scope(
            Arc::clone(&probe),
            call(
                &registry,
                "computer.capture",
                json!({}),
                Some(&conversation),
            ),
        )
        .await;
    assert!(
        !routed
            .as_ref()
            .is_err_and(|error| error.to_string().contains(CLOUD_TOOLS_ONLY_REFUSAL)),
        "{routed:?}"
    );
    assert_eq!(
        desktop_actions(&harness).len(),
        2,
        "both captures hit the Box"
    );
    assert_eq!(probe.load(Ordering::SeqCst), 1);
    // Every other non-cloud tool is still refused.
    let refused = call(
        &registry,
        "web.search",
        json!({"query": "q"}),
        Some(&conversation),
    )
    .await
    .unwrap_err();
    assert!(refused.to_string().contains(CLOUD_TOOLS_ONLY_REFUSAL));

    // A bound conversation without a Box refuses machine verbs too.
    let other = unique("conv");
    let other_registry = self::registry(store_with(&other, Tenancy::Unattributed).await);
    bound_for_test().insert(other.clone());
    let refused = call(&other_registry, "computer.capture", json!({}), Some(&other))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains(CLOUD_TOOLS_ONLY_REFUSAL));
    assert_eq!(creates(&harness).len(), 1);

    let mut bound = bound_for_test();
    bound.remove(&conversation);
    bound.remove(&other);
}

#[tokio::test]
async fn box_desktop_node_computer_use_is_refused_in_a_conversation_on_a_box() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);
    // Before the conversation has a Box, Shadow computer use is not refused by
    // the gate (it then fails only because no Shadow tool is registered here).
    let before = call(
        &registry,
        "shadow.computer_use",
        json!({"goal": "open settings"}),
        Some(&conversation),
    )
    .await
    .unwrap_err();
    assert!(!before.to_string().contains(NODE_COMPUTER_USE_REFUSAL));
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    let after = call(
        &registry,
        "shadow.computer_use",
        json!({"goal": "open settings"}),
        Some(&conversation),
    )
    .await
    .unwrap_err();
    assert!(
        after.to_string().contains(NODE_COMPUTER_USE_REFUSAL),
        "{after}"
    );
    assert!(owner_routes_to_box(NODE_OWNER, &conversation).await);
    assert!(!owner_routes_to_box("user:someone-else", &conversation).await);
}

#[tokio::test]
async fn box_desktop_a_remembered_turn_authority_decides_the_owner_and_the_flag() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    // A conversation stored for user `alice`, whose turn was started by her
    // verified cloud identity without the Box rollout flag.
    let store = store_with(
        &conversation,
        Tenancy::Owned {
            user_id: "alice".to_owned(),
            org_id: None,
        },
    )
    .await;
    let registry = registry(store);
    remember_turn_authority(
        &conversation,
        Arc::new(cloud_user("alice", false, None).await),
    );
    let node = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await
    .unwrap();
    assert_eq!(
        node["capability"],
        json!(CAP_COMPUTER),
        "flag off: the node"
    );
    assert!(creates(&harness).is_empty());

    // With the flag her next turn acquires a Box owned by `user:alice`.
    remember_turn_authority(
        &conversation,
        Arc::new(cloud_user("alice", true, None).await),
    );
    let _ = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    assert!(session_box::routes_to_box(&SessionBoxKey::session("user:alice", &conversation)).await);
    assert!(!session_box::routes_to_box(&SessionBoxKey::session(NODE_OWNER, &conversation)).await);

    // An authority remembered for someone else never speaks for `alice`, and
    // never replaces hers.
    let key = SessionBoxKey::session("user:alice", &conversation);
    remember_turn_authority(
        &conversation,
        Arc::new(cloud_user("mallory", true, None).await),
    );
    let alice = authority_for(&key).expect("alice's own turn authority is kept");
    assert_eq!(
        session_box::owner_of(&alice).unwrap(),
        "user:alice".to_owned()
    );
    assert!(authority_for(&SessionBoxKey::session("user:nobody", &conversation)).is_none());
    assert!(authority_for(&SessionBoxKey::session(NODE_OWNER, &conversation)).is_some());
    remember_turn_authority(&conversation, Arc::new(local_owner()));
    assert!(remember_is_bounded_and_unsafe_ids_are_ignored());
}

fn remember_is_bounded_and_unsafe_ids_are_ignored() -> bool {
    remember_turn_authority("../escape", Arc::new(local_owner()));
    remembered_authority("../escape", NODE_OWNER).is_none()
        && authorities().entries.len() <= MAX_REMEMBERED
}

/// A turn with no remembered chat-route authority: a scheduled, automation,
/// agent-to-agent, voice, plugin-bridge or bot run on a conversation stored
/// for a cloud user. It may not start a Box and, on a node that puts computer
/// use on Boxes, never falls back to the node's display.
#[tokio::test]
async fn box_desktop_a_run_on_a_stored_conversation_without_a_chat_caller_fails_closed() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(
        store_with(
            &conversation,
            Tenancy::Owned {
                user_id: "bob".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    for (verb, arguments) in [
        ("computer.capture", json!({})),
        ("computer.click", json!({"x": 1, "y": 2})),
        ("browser.navigate", json!({"url": "https://example.com"})),
    ] {
        let error = call(&registry, verb, arguments, Some(&conversation))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(NO_TURN_AUTHORITY_REFUSAL), "{verb}: {error}");
    }
    assert!(
        creates(&harness).is_empty(),
        "no Box without a verified caller"
    );
    assert!(desktop_actions(&harness).is_empty());

    // Once a chat turn of bob's is remembered (the verified caller), the same
    // conversation gets its Box.
    remember_turn_authority(&conversation, Arc::new(cloud_user("bob", true, None).await));
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
}

/// A run with no conversation, or one whose owner Core cannot derive, on an
/// org-bound node: a workflow/monitor/quest system call (an unresolved
/// principal) or a verified non-chat dispatch (a plugin or app bridge call).
#[tokio::test]
async fn box_desktop_an_unattributed_run_on_an_org_bound_node_fails_closed() {
    let harness = Harness::new().await;
    let registry = McpRegistry::empty();
    let system = crate::sidecar::mcp::authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Unresolved,
        call(&registry, "computer.click", json!({"x": 1, "y": 2}), None),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(system.contains(NO_TURN_AUTHORITY_REFUSAL), "{system}");

    let plugin = crate::sidecar::mcp::authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Owned {
            user_id: "carol".to_owned(),
            org_id: Some("org-1".to_owned()),
        },
        call(
            &registry,
            "browser.navigate",
            json!({"url": "https://example.com"}),
            None,
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(plugin.contains(NO_TURN_AUTHORITY_REFUSAL), "{plugin}");

    // An untenanted conversation on an org-bound node has no owner either.
    let conversation = unique("conv");
    let stored = self::registry(store_with(&conversation, Tenancy::Unattributed).await);
    let untenanted = crate::sidecar::mcp::authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Unresolved,
        call(&stored, "computer.capture", json!({}), Some(&conversation)),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        untenanted.contains(NO_TURN_AUTHORITY_REFUSAL),
        "{untenanted}"
    );
    assert!(creates(&harness).is_empty());
    assert!(desktop_actions(&harness).is_empty());
}

/// Where the node keeps computer use by design, a run without a chat caller
/// still uses it: the owner's `node` preference, a Box service without a
/// desktop, and the self-hosted local owner's conversationless call.
#[tokio::test]
async fn box_desktop_runs_without_a_chat_caller_keep_the_node_where_the_node_serves_them() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(
        store_with(
            &conversation,
            Tenancy::Owned {
                user_id: "dana".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    let preferences = crate::server::preferences::PreferencesStore::open_default().unwrap();
    preferences
        .set(session_box::PREF_COMPUTER_TARGET, "node")
        .await
        .unwrap();
    let preferred = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    let conversationless = call(&registry, "computer.capture", json!({}), None).await;
    preferences
        .delete(session_box::PREF_COMPUTER_TARGET)
        .await
        .unwrap();
    assert_eq!(preferred.unwrap()["capability"], json!(CAP_COMPUTER));
    assert_eq!(conversationless.unwrap()["capability"], json!(CAP_COMPUTER));

    // The local owner of an unbound node, without a conversation: the node.
    let local = call(&registry, "computer.capture", json!({}), None)
        .await
        .unwrap();
    assert_eq!(local["available"], json!(false));

    harness.fake.without_desktop();
    let other = unique("conv");
    let no_desktop = self::registry(
        store_with(
            &other,
            Tenancy::Owned {
                user_id: "dana".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    let node = call(&no_desktop, "computer.capture", json!({}), Some(&other))
        .await
        .unwrap();
    assert_eq!(node["capability"], json!(CAP_COMPUTER));
    assert!(creates(&harness).is_empty());
}

// ── Node display tools ───────────────────────────────────────────────────────

/// The compiled first-party manifests with these ids (Ghost, Bytebot, …).
fn shipped_manifests(ids: &[&str]) -> Vec<crate::plugin_manifest::PluginManifest> {
    let mut manifests: Vec<crate::plugin_manifest::PluginManifest> = Vec::new();
    for manifest in crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .chain(crate::plugin_manifest::PluginManifestLoader::load_builtins())
    {
        if ids.contains(&manifest.id.as_str()) && !manifests.iter().any(|m| m.id == manifest.id) {
            manifests.push(manifest);
        }
    }
    assert_eq!(
        manifests.len(),
        ids.len(),
        "every listed manifest is compiled in"
    );
    manifests
}

#[test]
fn box_desktop_node_display_servers_are_the_local_machine_providers() {
    let manifests = shipped_manifests(&[
        "@ryu/ghost",
        "@ryu/bytebot",
        "@ryu/codex-computer-use",
        "@ryu/agentbrowser",
    ]);
    let servers = node_display_servers(&manifests);
    for local in ["ghost", "codex_cu", "agentbrowser"] {
        assert!(
            servers.contains(local),
            "{local} drives the node display: {servers:?}"
        );
    }
    // Bytebot acts on another machine.
    assert!(!servers.contains("bytebot"), "{servers:?}");

    // A binding into the shared app namespace names only its own tool.
    let mut app_bound = shipped_manifests(&["@ryu/ghost"]).remove(0);
    for entry in &mut app_bound.provides {
        for binding in entry.tools.values_mut() {
            binding.tool = binding.tool.replacen("ghost.", "app.", 1);
        }
    }
    let servers = node_display_servers(&[app_bound]);
    assert!(!servers.contains("app"));
    assert!(servers.contains("app.ghost_click"), "{servers:?}");
}

/// A registry with Ghost and Bytebot enabled and `conversation` stored.
async fn registry_with_display_providers(conversation: &str) -> McpRegistry {
    let manifests = shipped_manifests(&["@ryu/ghost", "@ryu/bytebot"]);
    let plugins = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    for manifest in &manifests {
        plugins
            .insert(&manifest.id, &manifest.version)
            .await
            .unwrap();
        plugins
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap();
    }
    McpRegistry::empty()
        .with_conversations(store_with(conversation, Tenancy::Unattributed).await)
        .with_self_build(Arc::new(tokio::sync::RwLock::new(manifests)), plugins)
}

fn listed(ids: &[&str]) -> Vec<crate::sidecar::mcp::RegistryTool> {
    ids.iter()
        .map(|id| {
            let (server, tool) = id.split_once('.').unwrap();
            crate::sidecar::mcp::RegistryTool::candidate(id, server, tool)
        })
        .collect()
}

#[tokio::test]
async fn box_desktop_node_display_tools_are_hidden_and_refused_in_a_conversation_on_a_box() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry_with_display_providers(&conversation).await;
    let offered = [
        "ghost.ghost_click",
        "ghost.ghost_read",
        "shadow.computer_use",
        "bytebot.computer_click_mouse",
        "computer.click",
        "browser.navigate",
        "web.search",
    ];
    let ids = |tools: Vec<crate::sidecar::mcp::RegistryTool>| {
        tools.into_iter().map(|tool| tool.id).collect::<Vec<_>>()
    };

    // Before the conversation has a Box, everything is offered.
    let before = registry
        .without_node_display_tools(listed(&offered), Some(&conversation))
        .await;
    assert_eq!(ids(before).len(), offered.len());
    let early = call(
        &registry,
        "ghost.ghost_click",
        json!({"x": 1, "y": 1}),
        Some(&conversation),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(!early.contains(NODE_COMPUTER_USE_REFUSAL), "{early}");

    // Its first machine verb puts it on a Box.
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);

    // Listing: the node display tools are withheld, the rest are kept.
    let after = ids(registry
        .without_node_display_tools(listed(&offered), Some(&conversation))
        .await);
    assert_eq!(
        after,
        vec![
            "bytebot.computer_click_mouse",
            "computer.click",
            "browser.navigate",
            "web.search"
        ]
    );
    // Another conversation, and a listing without one, are untouched.
    let elsewhere = unique("conv");
    assert_eq!(
        registry
            .without_node_display_tools(listed(&offered), Some(&elsewhere))
            .await
            .len(),
        offered.len()
    );
    assert_eq!(
        registry
            .without_node_display_tools(listed(&offered), None)
            .await
            .len(),
        offered.len()
    );

    // Calling: every node display tool is refused before it reaches a server.
    for tool in [
        "ghost.ghost_click",
        "ghost.ghost_read",
        "shadow.computer_use",
    ] {
        let error = call(&registry, tool, json!({}), Some(&conversation))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(NODE_COMPUTER_USE_REFUSAL), "{tool}: {error}");
    }
    let remote = call(
        &registry,
        "bytebot.computer_click_mouse",
        json!({}),
        Some(&conversation),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(!remote.contains(NODE_COMPUTER_USE_REFUSAL), "{remote}");
    // A facade dispatch the Box router left on the node is not a direct call.
    let facade = crate::sidecar::mcp::CAPABILITY_PROVIDER_DISPATCH
        .scope(
            true,
            call(
                &registry,
                "ghost.ghost_click",
                json!({}),
                Some(&conversation),
            ),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(!facade.contains(NODE_COMPUTER_USE_REFUSAL), "{facade}");
    assert_eq!(
        desktop_actions(&harness).len(),
        1,
        "only the capture reached the Box"
    );
}

// ── Sub-agents ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn box_desktop_fanout_children_get_their_own_boxes_until_the_cap_shares_the_parent() {
    let harness = Harness::new().await;
    let parent = unique("conv");
    let registry = registry(
        store_with(
            &parent,
            Tenancy::Owned {
                user_id: "carol".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    // A plan cap of 3 running Boxes: the conversation's own Box plus two
    // children. The third child shares the parent's Box.
    remember_turn_authority(&parent, Arc::new(cloud_user("carol", true, Some(3)).await));
    let _ = call(&registry, "computer.capture", json!({}), Some(&parent)).await;
    assert_eq!(creates(&harness).len(), 1);

    // The registry sets the scope around `threads.*`, and the workflow fan-out
    // sets it for registered-agent delegates; the engine binds each delegate's
    // conversation under it (see the WP7 handoff). `delegate.fanout` does not.
    let scope = subagent_scope_for(registry.conversations.as_ref(), Some(&parent))
        .await
        .unwrap();
    assert_eq!(
        scope,
        SubagentScope {
            owner: "user:carol".to_owned(),
            parent_conversation_id: parent.clone(),
        }
    );
    let delegates: Vec<String> = (0..3).map(|_| unique("delegate")).collect();
    let keys = with_subagent_scope(Some(scope.clone()), async {
        delegates
            .iter()
            .map(|delegate| bind_child_conversation(delegate).unwrap())
            .collect::<Vec<_>>()
    })
    .await;
    assert_eq!(
        keys.iter()
            .map(SessionBoxKey::session_id)
            .collect::<Vec<_>>(),
        (1..=3)
            .map(|index| format!("{parent}#sub:{index}"))
            .collect::<Vec<_>>()
    );
    // Binding again is idempotent; outside a scope nothing binds.
    assert_eq!(
        register_child_conversation(&scope, &delegates[0]),
        Some(keys[0].clone())
    );
    assert!(bind_child_conversation(&unique("delegate")).is_none());
    assert_eq!(
        child_session_id(&delegates[2]),
        Some(format!("{parent}#sub:3"))
    );

    for delegate in &delegates {
        let _ = call(
            &registry,
            "computer.click",
            json!({"x": 3, "y": 4}),
            Some(delegate),
        )
        .await;
    }
    assert_eq!(
        creates(&harness).len(),
        3,
        "two child Boxes beside the parent's"
    );
    let names: Vec<String> = creates(&harness)
        .iter()
        .map(|request| request.body["name"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(names.len(), 3);
    let clicked: Vec<String> = desktop_actions(&harness)
        .iter()
        .filter(|request| request.body["action"] == "click")
        .map(|request| request.path.clone())
        .collect();
    assert_eq!(
        clicked,
        vec![
            format!("/v1/boxes/{}/desktop/actions", box_id_of(2)),
            format!("/v1/boxes/{}/desktop/actions", box_id_of(3)),
            // The third child shares the parent's Box under cap pressure.
            format!("/v1/boxes/{}/desktop/actions", box_id_of(1)),
        ]
    );
    let status = session_box::status("user:carol", &parent).await.unwrap();
    assert_eq!(status.children.len(), 2);

    // A nested fan-out from a child shares the root conversation's counter.
    let nested = subagent_scope_for(registry.conversations.as_ref(), Some(&delegates[0]))
        .await
        .unwrap();
    assert_eq!(nested, scope);

    // Deleting the parent conversation releases every child Box.
    session_box::release_deleted_conversation(&parent).await;
    for created in 1..=3 {
        assert!(!harness.fake.has_box(&box_id_of(created)), "Box {created}");
    }
}

#[tokio::test]
async fn box_desktop_threads_workers_are_registered_as_children_of_their_coordinator() {
    let _harness = Harness::new().await;
    let coordinator = unique("conv");
    let store = store_with(&coordinator, Tenancy::Unattributed).await;
    let scope = subagent_scope_for(Some(&store), Some(&coordinator))
        .await
        .unwrap();
    assert_eq!(scope.owner, NODE_OWNER);
    let created = with_subagent_scope(
        Some(scope),
        super::super::threads::dispatch_with_default_isolation(
            "create_thread",
            json!({"title": "worker"}),
            &store,
            &ToolPrincipal::Unrestricted,
            false,
            Some(&coordinator),
        ),
    )
    .await
    .unwrap();
    let worker = created["thread_id"].as_str().unwrap().to_owned();
    assert_eq!(
        child_session_id(&worker),
        Some(format!("{coordinator}#sub:1"))
    );
    // Without a scope a created thread is not a sub-agent.
    let unscoped = super::super::threads::dispatch_with_default_isolation(
        "create_thread",
        json!({"title": "solo"}),
        &store,
        &ToolPrincipal::Unrestricted,
        false,
        None,
    )
    .await
    .unwrap();
    assert!(child_session_id(unscoped["thread_id"].as_str().unwrap()).is_none());
}

#[tokio::test]
async fn box_desktop_a_registered_child_with_another_stored_owner_is_ignored() {
    let _harness = Harness::new().await;
    let parent = unique("conv");
    let foreign = unique("conv");
    let store = store_with(
        &foreign,
        Tenancy::Owned {
            user_id: "dave".to_owned(),
            org_id: None,
        },
    )
    .await;
    let scope = SubagentScope {
        owner: NODE_OWNER.to_owned(),
        parent_conversation_id: parent,
    };
    assert!(register_child_conversation(&scope, &foreign).is_some());
    assert!(resolve(Some(&store), &foreign).await.is_none());
    assert!(!machine_verbs_route_to_box(Some(&store), &foreign).await);
}

// ── Review fixes ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn box_desktop_a_collaborators_turn_never_moves_the_owners_calls_to_their_box() {
    let harness = Harness::new().await;
    let conversation = unique("shared");
    let registry = registry(
        store_with(
            &conversation,
            Tenancy::Owned {
                user_id: "ann".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    // Ann's long turn is running and has her Box.
    remember_turn_authority(&conversation, Arc::new(cloud_user("ann", true, None).await));
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    // Ben, a collaborator with write access, posts in the same conversation.
    remember_turn_authority(&conversation, Arc::new(cloud_user("ben", true, None).await));
    // Ann's agent's next verb still runs on Ann's Box: no Box for Ben.
    let _ = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 1}),
        Some(&conversation),
    )
    .await;
    assert_eq!(
        creates(&harness).len(),
        1,
        "no Box is created for the collaborator"
    );
    let clicks: Vec<String> = desktop_actions(&harness)
        .iter()
        .filter(|request| request.body["action"] == "click")
        .map(|request| request.path.clone())
        .collect();
    assert_eq!(
        clicks,
        vec![format!("/v1/boxes/{}/desktop/actions", box_id_of(1))]
    );
    assert!(session_box::status("user:ben", &conversation)
        .await
        .is_none());
    assert!(session_box::status("user:ann", &conversation)
        .await
        .is_some());
    // Her sub-agents keep her owner and her authority.
    let scope = subagent_scope_for(registry.conversations.as_ref(), Some(&conversation))
        .await
        .unwrap();
    assert_eq!(scope.owner, "user:ann");
    session_box::release_deleted_conversation(&conversation).await;
}

#[tokio::test]
async fn box_desktop_a_child_with_its_own_box_never_drives_the_node_display() {
    let harness = Harness::new().await;
    let parent = unique("conv");
    let registry = registry(store_with(&parent, Tenancy::Unattributed).await);
    let scope = SubagentScope {
        owner: NODE_OWNER.to_owned(),
        parent_conversation_id: parent.clone(),
    };
    let delegate = unique("delegate");
    let key = register_child_conversation(&scope, &delegate).unwrap();
    // The child acquires its own Box; the parent never gets one.
    let _ = call(&registry, "computer.capture", json!({}), Some(&delegate)).await;
    assert_eq!(creates(&harness).len(), 1);
    assert!(!session_box::routes_to_box(&key.parent()).await);
    assert!(session_box::routes_to_box(&key).await);
    assert!(owner_routes_to_box(NODE_OWNER, &delegate).await);
    let refused = call(
        &registry,
        "shadow.computer_use",
        json!({"goal": "open settings"}),
        Some(&delegate),
    )
    .await
    .unwrap_err();
    assert!(
        refused.to_string().contains(NODE_COMPUTER_USE_REFUSAL),
        "{refused}"
    );
    session_box::release_deleted_conversation(&parent).await;
}

#[tokio::test]
async fn box_desktop_a_parked_box_with_a_lapsed_authority_errors_instead_of_using_the_node() {
    let harness = Harness::new().await;
    let conversation = unique("conv");
    let registry = registry(
        store_with(
            &conversation,
            Tenancy::Owned {
                user_id: "erin".to_owned(),
                org_id: None,
            },
        )
        .await,
    );
    remember_turn_authority(
        &conversation,
        Arc::new(cloud_user("erin", true, None).await),
    );
    let _ = call(
        &registry,
        "computer.capture",
        json!({}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    let key = SessionBoxKey::session("user:erin", &conversation);
    session_box::park(&key, ryu_sandbox::box_types::ParkReason::Idle)
        .await
        .unwrap();
    // The turn's token lapses (here: a turn authority without the flag).
    remember_turn_authority(
        &conversation,
        Arc::new(cloud_user("erin", false, None).await),
    );
    let error = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 1}),
        Some(&conversation),
    )
    .await
    .expect_err("never the node's display");
    assert!(
        error.to_string().contains("session_box_authority_expired"),
        "{error}"
    );
    // A sub-agent child with no Box of its own, whose parent has one, is
    // refused the same way.
    let scope = SubagentScope {
        owner: "user:erin".to_owned(),
        parent_conversation_id: conversation.clone(),
    };
    let delegate = unique("delegate");
    register_child_conversation(&scope, &delegate).unwrap();
    let error = call(&registry, "computer.capture", json!({}), Some(&delegate))
        .await
        .expect_err("never the node's display");
    assert!(
        error.to_string().contains("send the message again"),
        "{error}"
    );
    assert_eq!(creates(&harness).len(), 1);
    assert!(desktop_actions(&harness)
        .iter()
        .all(|request| request.body["action"] != "click"));
    session_box::release_deleted_conversation(&conversation).await;
}

#[tokio::test]
async fn box_desktop_children_reuse_released_numbers_and_share_the_parent_when_all_are_held() {
    let _harness = Harness::new().await;
    let parent = unique("conv");
    let scope = SubagentScope {
        owner: NODE_OWNER.to_owned(),
        parent_conversation_id: parent.clone(),
    };
    let delegates: Vec<String> = (0..session_box_max_children())
        .map(|_| unique("delegate"))
        .collect();
    for delegate in &delegates {
        assert!(register_child_conversation(&scope, delegate)
            .unwrap()
            .child
            .is_some());
    }
    // All numbers held: the next sub-agent shares the parent's Box.
    let overflow = unique("delegate");
    assert_eq!(
        register_child_conversation(&scope, &overflow),
        Some(SessionBoxKey::session(NODE_OWNER, &parent))
    );
    // A finished delegate returns its number.
    let finished = child_key(&delegates[4]).unwrap();
    release_child_conversation(&delegates[4]).await;
    assert!(child_key(&delegates[4]).is_none());
    let next = unique("delegate");
    assert_eq!(register_child_conversation(&scope, &next), Some(finished));
    session_box::release_deleted_conversation(&parent).await;
}

#[tokio::test]
async fn box_desktop_a_deleted_coordinators_workers_are_forgotten_and_a_worker_uses_its_own_turn() {
    let _harness = Harness::new().await;
    let parent = unique("conv");
    let scope = SubagentScope {
        owner: "user:frank".to_owned(),
        parent_conversation_id: parent.clone(),
    };
    let worker = unique("worker");
    register_child_conversation(&scope, &worker).unwrap();
    assert!(child_key(&worker).is_some());
    forget_children_of(&parent);
    assert!(
        child_key(&worker).is_none(),
        "a worker of a deleted coordinator no longer resolves to its Box"
    );

    // With the coordinator's own turn gone, the worker's turn for the same
    // owner acquires its Box; another conversation's turn never does.
    let key = SessionBoxKey::child("user:frank", &parent, 1);
    assert!(authority_for_conversation(&key, &worker).is_none());
    remember_turn_authority(&worker, Arc::new(cloud_user("frank", true, None).await));
    assert!(authority_for_conversation(&key, &worker).is_some());
    assert!(authority_for_conversation(&key, &unique("other")).is_none());
    assert!(authority_for(&key).is_none());
}

fn session_box_max_children() -> u32 {
    64
}

#[tokio::test]
async fn box_desktop_a_box_service_without_a_desktop_keeps_the_node() {
    let harness = Harness::new().await;
    harness.fake.without_desktop();
    let conversation = unique("conv");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);
    let node = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await
    .unwrap();
    assert_eq!(node["available"], json!(false));
    assert!(creates(&harness).is_empty());
}

#[test]
fn box_desktop_cloud_task_turns_name_machine_verbs_without_dots() {
    assert_eq!(
        cloud_machine_tool_name("computer.click"),
        "box_computer_click"
    );
    assert_eq!(
        cloud_machine_verb("box_computer_click"),
        Some("computer.click")
    );
    assert_eq!(
        cloud_machine_verb("box_computer_focus_app"),
        Some("computer.focus_app")
    );
    assert_eq!(
        cloud_machine_verb("box_browser_click_at"),
        Some("browser.click_at")
    );
    assert_eq!(cloud_machine_verb("box_web_search"), None);
    assert_eq!(cloud_machine_verb("cloud_exec"), None);
    assert_eq!(cloud_machine_verb("computer_click"), None);
    for tool in capability_tools::session_box_tools(&[]) {
        assert_eq!(
            cloud_machine_verb(&cloud_machine_tool_name(&tool.id)),
            Some(capability_tools::verb_by_id(&tool.id).unwrap().id)
        );
    }

    let registry = McpRegistry::empty();
    let all = registry.cloud_box_machine_tools_for_agent(None);
    assert!(all.iter().any(|tool| tool.id == "computer.click"));
    assert!(all.iter().any(|tool| tool.id == "browser.navigate"));
    assert!(all
        .iter()
        .all(|tool| capability_tools::is_machine_verb(&tool.id)));
    let allowed =
        registry.cloud_box_machine_tools_for_agent(Some(&["computer.capture".to_owned()]));
    assert_eq!(
        allowed
            .iter()
            .map(|tool| tool.id.as_str())
            .collect::<Vec<_>>(),
        vec!["computer.capture"]
    );
    assert!(registry
        .cloud_box_machine_tools_for_agent(Some(&[]))
        .is_empty());
}

#[test]
fn box_desktop_session_box_verbs_are_listed_when_no_provider_serves_them() {
    let all = capability_tools::session_box_tools(&[]);
    assert!(all.iter().any(|tool| tool.id == "computer.click"));
    assert!(all.iter().any(|tool| tool.id == "browser.navigate"));
    assert!(all
        .iter()
        .all(|tool| capability_tools::is_machine_verb(&tool.id)));
    // A verb an enabled provider already serves is not listed twice.
    let rest = capability_tools::session_box_tools(&["computer.click"]);
    assert!(!rest.iter().any(|tool| tool.id == "computer.click"));
    assert_eq!(rest.len(), all.len() - 1);
}

// ── The one-time cost notice ─────────────────────────────────────────────────

#[tokio::test]
async fn box_desktop_the_first_computer_use_box_waits_for_the_cost_notice() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let conversation = unique("notice");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);

    // The model is told why and what to do; nothing starts, and the call never
    // falls back to the node's display.
    let error = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        error.contains(session_box::notice::NOTICE_REQUIRED_CODE),
        "{error}"
    );
    assert!(error.contains("$0.025 an hour"), "{error}");
    assert!(creates(&harness).is_empty());
    assert!(desktop_actions(&harness).is_empty());

    // Once the owner acknowledges the rate it was shown, the same call starts
    // the Box.
    session_box::notice::acknowledge(NODE_OWNER, 25_000)
        .await
        .unwrap();
    let _ = call(
        &registry,
        "computer.click",
        json!({"x": 1, "y": 2}),
        Some(&conversation),
    )
    .await;
    assert_eq!(creates(&harness).len(), 1);
    assert_eq!(desktop_actions(&harness).len(), 1);
}

#[tokio::test]
async fn box_desktop_a_held_computer_use_call_goes_on_once_the_cost_is_allowed() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    harness.hold_for_notice(std::time::Duration::from_secs(20));
    let conversation = unique("notice-held");
    let registry = registry(store_with(&conversation, Tenancy::Unattributed).await);

    // The model's call waits for the answer instead of failing; allowing it
    // finishes the same tool call on the new Box.
    let answer = async {
        let mut waiting = false;
        for _ in 0..200 {
            waiting = session_box::status(NODE_OWNER, &conversation)
                .await
                .and_then(|found| found.cost_notice)
                .is_some_and(|notice| notice.waiting);
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(waiting, "the notice shows a held call");
        assert!(creates(&harness).is_empty());
        session_box::notice::acknowledge(NODE_OWNER, 25_000)
            .await
            .unwrap();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        tokio::join!(
            call(
                &registry,
                "computer.click",
                json!({"x": 1, "y": 2}),
                Some(&conversation),
            ),
            answer
        )
    })
    .await
    .expect("the call goes on");
    // The session Box fake serves no desktop routes, so the click itself
    // answers 404; what matters is that the held call was not refused for the
    // notice and went on to create the Box and send the action.
    if let Err(error) = &result {
        assert!(
            !error
                .to_string()
                .contains(session_box::notice::NOTICE_REQUIRED_CODE),
            "{error}"
        );
    }
    assert_eq!(creates(&harness).len(), 1);
    assert_eq!(desktop_actions(&harness).len(), 1);
}
