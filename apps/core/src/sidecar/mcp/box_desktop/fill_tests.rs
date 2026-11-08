//! Box credential fill tests: the identity rules, every refusal before a
//! value is read, pinning, the commit bodies, and that no value leaks. The
//! Box service is a loopback fake serving `/health` and the browser-fills
//! routes; the vault is an in-memory store.

use super::*;
use crate::server::conversations::Tenancy;
use crate::vault::agent_accounts::fill_sets::{CreateInput as SetInput, ItemInput};
use crate::vault::agent_accounts::{create, CreateInput};
use crate::vault::audit::AuditActor;
use crate::vault::items::{ItemPut, PutAccess};
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use std::sync::Mutex as StdMutex;

pub(in crate::sidecar::mcp::box_desktop) const SECRET: &str = "hunter2-correct-horse";
const PAGE: &str = "https://github.com/login";

/// One recorded request: method, path, JSON body.
pub(in crate::sidecar::mcp::box_desktop) type Seen = (String, String, Value);

#[derive(Default)]
pub(in crate::sidecar::mcp::box_desktop) struct FakeState {
    pub features: Vec<&'static str>,
    pub prepare: Option<(u16, Value)>,
    pub commit: Option<(u16, Value)>,
    pub page_url: Option<String>,
    pub status: Option<Value>,
    pub seen: Vec<Seen>,
}

pub(in crate::sidecar::mcp::box_desktop) struct FakeFillBox {
    pub client: BoxSessionClient,
    pub state: Arc<StdMutex<FakeState>>,
}

async fn fake(State(state): State<Arc<StdMutex<FakeState>>>, request: Request) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut fake = state.lock().unwrap();
    fake.seen.push((method.clone(), path.clone(), body));
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (status, answer) = match (method.as_str(), segments.as_slice()) {
        ("GET", ["health"]) => (200, json!({ "ok": true, "features": fake.features })),
        ("POST", ["v1", "boxes", _, "browser-fills"]) => fake.prepare.clone().unwrap_or_else(|| {
            let page = fake.page_url.clone().unwrap_or_else(|| PAGE.to_owned());
            (201, json!({ "ok": true, "fillId": "fill_1", "pageUrl": page, "tab": { "id": "t1" } }))
        }),
        ("POST", ["v1", "boxes", _, "browser-fills", _]) => fake.commit.clone().unwrap_or((
            200,
            json!({ "ok": true, "filled": true, "protected": true, "tab": { "id": "t1" } }),
        )),
        ("GET", ["v1", "boxes", _, "browser-fills", _]) => {
            (200, fake.status.clone().unwrap_or(json!({ "state": "live" })))
        }
        ("DELETE", ["v1", "boxes", _, "browser-fills", _]) => (204, Value::Null),
        _ => (404, json!({ "error": { "code": "not_found" } })),
    };
    let mut response = if answer.is_null() {
        ().into_response()
    } else {
        axum::Json(answer).into_response()
    };
    *response.status_mut() = axum::http::StatusCode::from_u16(status).unwrap();
    response
}

impl FakeFillBox {
    pub(in crate::sidecar::mcp::box_desktop) async fn start() -> Self {
        let state = Arc::new(StdMutex::new(FakeState {
            features: vec!["boxes", "desktop", "browser-fill-v2"],
            ..FakeState::default()
        }));
        let router = axum::Router::new()
            .fallback(axum::routing::any(fake))
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let client = BoxSessionClient::with_endpoint(format!("http://{address}/v1"), "rbx1.t");
        Self { client, state }
    }

    pub(in crate::sidecar::mcp::box_desktop) fn seen(&self, method: &str) -> Vec<Seen> {
        let state = self.state.lock().unwrap();
        state
            .seen
            .iter()
            .filter(|s| s.0 == method)
            .cloned()
            .collect()
    }

    pub(in crate::sidecar::mcp::box_desktop) fn fill_calls(&self) -> Vec<Seen> {
        let state = self.state.lock().unwrap();
        state
            .seen
            .iter()
            .filter(|s| s.1.contains("/browser-fills"))
            .cloned()
            .collect()
    }
}

/// A Box id no other test uses (the fill ledger is process-wide).
pub(in crate::sidecar::mcp::box_desktop) fn box_id() -> WorkspaceId {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    WorkspaceId(format!("bx_{hex}"))
}

pub(in crate::sidecar::mcp::box_desktop) fn vault() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

/// How many item reveals the vault audited.
pub(in crate::sidecar::mcp::box_desktop) async fn reveals(vault: &PluginSecretStore) -> usize {
    audit_actions(vault)
        .await
        .iter()
        .filter(|action| *action == "item.reveal")
        .count()
}

pub(in crate::sidecar::mcp::box_desktop) async fn audit_actions(
    vault: &PluginSecretStore,
) -> Vec<String> {
    let conn = vault.conn.lock().await;
    let filter = crate::vault::audit::AuditFilter {
        limit: 500,
        ..Default::default()
    };
    crate::vault::audit::list(&conn, &filter)
        .unwrap()
        .into_iter()
        .map(|row| row.action)
        .collect()
}

/// An own account of `agent-1` on github.com, with or without a login URL.
pub(in crate::sidecar::mcp::box_desktop) async fn own_account(
    vault: &PluginSecretStore,
    login: bool,
) -> String {
    let input = CreateInput {
        site: "https://github.com".into(),
        username: Some("ryu-bot".into()),
        submit_urls: if login {
            vec!["https://github.com/session".into()]
        } else {
            Vec::new()
        },
        ..CreateInput::default()
    };
    create(
        vault,
        Some("agent-1"),
        input,
        &AuditActor::new("agent", Some("agent-1")),
    )
    .await
    .unwrap()
    .id
}

/// An attached login item for `agent-1`, as `attached:1`.
pub(in crate::sidecar::mcp::box_desktop) async fn attached(
    vault: &PluginSecretStore,
    registry: &Registry,
    submit_urls: &[&str],
    box_unbound: bool,
) -> String {
    let put: ItemPut = serde_json::from_value(json!({
        "environment": "default", "path": "web", "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": "username", "type": "text" },
            { "name": "password", "type": "password" },
        ],
        "values": { "url": PAGE, "username": "jay", "password": SECRET },
    }))
    .unwrap();
    let user = AuditActor::new("user", Some("u1"));
    vault
        .item_put("gh", put, &user, PutAccess::FULL)
        .await
        .unwrap();
    let input = SetInput {
        agent_id: "agent-1".into(),
        items: vec![ItemInput {
            environment: None,
            path: Some("web".into()),
            key: "gh".into(),
            site: None,
            submit_urls: submit_urls.iter().map(|u| (*u).to_owned()).collect(),
            box_unbound,
        }],
        ttl_secs: None,
    };
    let now = crate::vault::now_millis();
    let set = fill_sets::build(vault, &input, now).await.unwrap();
    registry.insert(set, now).unwrap().id
}

pub(in crate::sidecar::mcp::box_desktop) fn env<'a>(
    vault: &'static PluginSecretStore,
    registry: &'a Registry,
    fake: &'a FakeFillBox,
) -> FillEnv<'a> {
    FillEnv {
        vault,
        registry,
        policy: None,
        client: &fake.client,
        audit_later: false,
    }
}

pub(in crate::sidecar::mcp::box_desktop) fn args(account: &str, field: FillField) -> FillArgs {
    FillArgs {
        account: account.to_owned(),
        field,
        element_ref: "@e3".into(),
        tab_id: None,
        submit: false,
    }
}

fn agent() -> Caller {
    Caller::Agent("agent-1".into())
}

async fn conversation(store: &ConversationStore, id: &str) {
    store
        .ensure_conversation(id, None, None, Tenancy::Unattributed)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_caller_is_one_settled_agent_or_nobody() {
    let store = ConversationStore::open_in_memory().unwrap();
    conversation(&store, "c-empty").await;
    assert_eq!(
        caller_agent(Some(&store), "c-empty").await.unwrap(),
        Caller::Unassigned
    );

    conversation(&store, "c-one").await;
    store.set_active_agent("c-one", "agent-1").await.unwrap();
    store
        .add_participant("c-one", "agent-1", Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(caller_agent(Some(&store), "c-one").await.unwrap(), agent());

    conversation(&store, "c-two").await;
    store.set_active_agent("c-two", "agent-1").await.unwrap();
    for participant in ["agent-1", "agent-2"] {
        store
            .add_participant("c-two", participant, Tenancy::Unattributed)
            .await
            .unwrap();
    }
    let error = caller_agent(Some(&store), "c-two").await.unwrap_err();
    assert!(error.to_string().contains("more than one agent"), "{error}");

    conversation(&store, "c-stale").await;
    store.set_active_agent("c-stale", "agent-1").await.unwrap();
    store
        .add_participant("c-stale", "agent-2", Tenancy::Unattributed)
        .await
        .unwrap();
    let error = caller_agent(Some(&store), "c-stale").await.unwrap_err();
    assert!(error.to_string().contains("not settled"), "{error}");

    conversation(&store, "c-orphan").await;
    store
        .add_participant("c-orphan", "agent-2", Tenancy::Unattributed)
        .await
        .unwrap();
    assert!(caller_agent(Some(&store), "c-orphan").await.is_err());

    assert!(caller_agent(None, "c-one").await.is_err());
    let scope = SubagentScope {
        owner: "user-1".into(),
        parent_conversation_id: "parent-conversation".into(),
    };
    let refused = with_subagent_scope(Some(scope), caller_agent(Some(&store), "c-one")).await;
    assert!(refused.unwrap_err().to_string().contains("sub-agent"));
}

#[tokio::test]
async fn without_global_state_a_fill_is_refused_not_unrestricted() {
    let store = ConversationStore::open_in_memory().unwrap();
    conversation(&store, "c-1").await;
    let target = BoxTarget {
        box_id: box_id(),
        lease_id: "lease-1".to_owned(),
        run_id: "lease-1".to_owned(),
        size: ryu_sandbox::box_types::BoxSize::Small,
        desktop: true,
        source: session_box::TargetSource::Session,
    };
    let error = run_in(
        None,
        Some(&store),
        "c-1",
        &target,
        args("acct", FillField::Password),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), NO_STATE_REFUSAL);
}

#[tokio::test]
async fn every_refusal_before_release_reveals_nothing() {
    let vault = vault();
    let registry = Registry::default();
    let own_unbound = own_account(vault, false).await;
    let handle_unbound = "attached:1";
    attached(vault, &registry, &[], false).await;
    let fake = FakeFillBox::start().await;
    let env = env(vault, &registry, &fake);
    let id = box_id();
    let refused = [
        (
            Caller::Unassigned,
            args(handle_unbound, FillField::Password),
            "agent",
        ),
        (
            agent(),
            args(&own_unbound, FillField::Password),
            "login URL",
        ),
        (
            agent(),
            args(handle_unbound, FillField::Password),
            "login URL",
        ),
        (
            agent(),
            args("no-such-account", FillField::Password),
            "no account",
        ),
    ];
    for (caller, fill, expected) in refused {
        let error = execute(&env, &id, &caller, &fill).await.unwrap_err();
        assert!(format!("{error:#}").contains(expected), "{error:#}");
    }
    assert!(fake.fill_calls().is_empty(), "nothing was prepared");
    assert_eq!(reveals(vault).await, 0);
    assert!(!registry.list(Some("agent-1"), crate::vault::now_millis())[0].claimed);
}

#[tokio::test]
async fn a_box_without_the_feature_or_a_refused_prepare_reveals_nothing() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    attached(vault, &registry, &["https://github.com/session"], false).await;
    let old = FakeFillBox::start().await;
    old.state.lock().unwrap().features = vec!["boxes", "desktop"];
    let error = execute(
        &env(vault, &registry, &old),
        &box_id(),
        &agent(),
        &args(&account, FillField::Password),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), UNSAFE_BOX_REFUSAL);
    assert!(old.fill_calls().is_empty());

    let unsafe_box = FakeFillBox::start().await;
    unsafe_box.state.lock().unwrap().prepare = Some((
        409,
        json!({ "error": { "code": "browser_fill_unsupported", "message": "no CA" } }),
    ));
    let env = env(vault, &registry, &unsafe_box);
    for account in [account.as_str(), "attached:1"] {
        let error = execute(
            &env,
            &box_id(),
            &agent(),
            &args(account, FillField::Password),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), UNSAFE_BOX_REFUSAL);
    }
    // A failed prepare leaves the attached set unpinned.
    assert!(!registry.list(Some("agent-1"), crate::vault::now_millis())[0].claimed);
    assert_eq!(reveals(vault).await, 0);
}

#[tokio::test]
async fn a_page_off_the_host_cancels_and_reveals_nothing() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    for page in [
        "https://evil.example/login",
        "http://github.com/login",
        "https://gist.github.com/login",
    ] {
        let fake = FakeFillBox::start().await;
        fake.state.lock().unwrap().page_url = Some(page.to_owned());
        let error = execute(
            &env(vault, &registry, &fake),
            &box_id(),
            &agent(),
            &args(&account, FillField::Password),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{page}: {error}");
        assert_eq!(fake.seen("DELETE").len(), 1, "{page}");
        assert!(
            fake.seen("POST").iter().all(|s| !s.1.ends_with("/fill_1")),
            "{page}"
        );
    }
    assert_eq!(reveals(vault).await, 0);
}

#[tokio::test]
async fn rate_limits_and_echo_blocks_refuse_before_the_box_is_asked() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    let fake = FakeFillBox::start().await;
    let env = env(vault, &registry, &fake);
    let id = box_id();
    for _ in 0..3 {
        execute(&env, &id, &agent(), &args(&account, FillField::Password))
            .await
            .unwrap();
    }
    let before = reveals(vault).await;
    let error = execute(&env, &id, &agent(), &args(&account, FillField::Password))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("limit"), "{error}");
    // Text fills count toward the Box limit only.
    execute(&env, &id, &agent(), &args(&account, FillField::Username))
        .await
        .unwrap();
    let echoed = box_id();
    fill_ledger::block(&echoed.0, &account);
    let error = execute(
        &env,
        &echoed,
        &agent(),
        &args(&account, FillField::Password),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("echoed"), "{error}");
    // The refused password fill revealed nothing (an own account's username
    // is plain metadata, not a reveal).
    assert_eq!(reveals(vault).await, before);
}

#[path = "fill_commit_tests.rs"]
mod commit;
