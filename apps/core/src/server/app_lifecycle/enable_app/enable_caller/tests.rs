//! Security finding CE-20: the lifecycle of an app's approved permissions for
//! the two callers of the enable route. A real plugin store (in memory) and a
//! local stand-in for the Gateway's grant check; nothing leaves this process.

use super::*;
use crate::plugin_manifest::{AppDependency, Requires};
use crate::plugins::lifecycle::{disable_app, install_app, set_app_grants};
use crate::plugins::PluginRecord;

const NOTES: &str = "com.ce20test.notes";
const SEARCH: &str = "com.ce20test.search";
const READ: &str = "mcp:web_search";
const RUN: &str = "tool:execute";

fn app(id: &str, grants: &[&str], requires: &[&str]) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: "1.0.0".to_owned(),
        permission_grants: grants.iter().map(|grant| (*grant).to_owned()).collect(),
        requires: (!requires.is_empty()).then(|| Requires {
            apps: requires
                .iter()
                .map(|dependency| AppDependency {
                    id: (*dependency).to_owned(),
                    min_version: None,
                })
                .collect(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn grants(list: &[&str]) -> Vec<String> {
    list.iter().map(|grant| (*grant).to_owned()).collect()
}

/// A Gateway that approves every grant it is asked about.
async fn approving_gateway() -> String {
    use axum::routing::post;
    let app = axum::Router::new().route(
        "/v1/grants/validate",
        post(|Json(body): Json<serde_json::Value>| async move {
            let asked = body["grants"].clone();
            Json(json!({ "approved": asked, "denied": [], "all_approved": true }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    url
}

/// One store with the given apps installed (all off), and what a call needs.
struct Node {
    store: PluginStore,
    manifests: Vec<PluginManifest>,
    gateway: String,
    client: reqwest::Client,
}

impl Node {
    async fn with(manifests: Vec<PluginManifest>) -> Self {
        let store = PluginStore::open_in_memory().unwrap();
        for manifest in &manifests {
            install_app(&store, manifest).await.unwrap();
        }
        Self {
            store,
            manifests,
            gateway: approving_gateway().await,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }

    fn manifest(&self, id: &str) -> &PluginManifest {
        self.manifests
            .iter()
            .find(|manifest| manifest.id == id)
            .unwrap()
    }

    /// The enable route's call for `caller`.
    async fn enable(&self, caller: EnableCaller, id: &str, dry_run: bool) -> CallerEnable {
        enable_for_caller(
            caller,
            dry_run,
            &self.store,
            self.manifest(id),
            &self.manifests,
            GrantGate {
                url: &self.gateway,
                token: None,
                client: &self.client,
            },
        )
        .await
        .unwrap()
    }

    /// What the person does in the app's permission switches.
    async fn narrow(&self, id: &str, keep: &[&str]) {
        set_app_grants(
            &self.store,
            self.manifest(id),
            &grants(keep),
            &self.gateway,
            None,
            &self.client,
        )
        .await
        .unwrap();
    }

    async fn record(&self, id: &str) -> PluginRecord {
        self.store.get_record(id).await.unwrap().unwrap()
    }
}

fn enabled_record(answer: CallerEnable) -> (PluginRecord, Option<&'static str>) {
    match answer {
        CallerEnable::Enabled { outcome, notice } => (outcome.target, notice),
        CallerEnable::NeedsThePerson(unapproved) => {
            panic!("the call was left to the person: {unapproved:?}")
        }
    }
}

fn left_to_the_person(answer: CallerEnable) -> Vec<UnapprovedPermissions> {
    match answer {
        CallerEnable::NeedsThePerson(unapproved) => unapproved,
        CallerEnable::Enabled { outcome, .. } => panic!(
            "the agent's call switched the app on with {:?}",
            outcome.target.approved_grants
        ),
    }
}

/// The finding: enable, narrow with `set_app_grants`, enable again. The set
/// the person narrowed stays when the second enable is an agent's.
#[tokio::test]
async fn an_agent_enable_keeps_the_set_the_person_narrowed() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;
    let (first, _) = enabled_record(node.enable(EnableCaller::Person, NOTES, false).await);
    assert_eq!(first.approved_grants, grants(&[READ, RUN]));
    node.narrow(NOTES, &[READ]).await;

    let (again, notice) = enabled_record(node.enable(EnableCaller::Agent, NOTES, false).await);

    assert_eq!(
        node.record(NOTES).await.approved_grants,
        grants(&[READ]),
        "an agent's enable call restored a permission the person switched off"
    );
    assert!(node.record(NOTES).await.enabled);
    // The route activates the record it is handed: the stored one.
    assert_eq!(again.approved_grants, grants(&[READ]));
    assert_eq!(notice, Some(PERMISSIONS_KEPT_NOTICE));
}

/// An app whose every permission was switched off stays at none.
#[tokio::test]
async fn an_agent_enable_does_not_restore_a_fully_revoked_app() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;
    enabled_record(node.enable(EnableCaller::Person, NOTES, false).await);
    node.narrow(NOTES, &[]).await;

    enabled_record(node.enable(EnableCaller::Agent, NOTES, false).await);

    let record = node.record(NOTES).await;
    assert!(record.enabled);
    assert!(
        record.approved_grants.is_empty(),
        "an agent's enable call approved {:?}",
        record.approved_grants
    );
}

/// A first enable through the tool approves nothing the person has not seen:
/// the app stays off and the answer names what was asked for.
#[tokio::test]
async fn a_first_enable_by_an_agent_approves_nothing() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;

    let unapproved = left_to_the_person(node.enable(EnableCaller::Agent, NOTES, false).await);

    assert_eq!(
        unapproved,
        vec![UnapprovedPermissions {
            app: NOTES.to_owned(),
            permissions: grants(&[READ, RUN]),
        }]
    );
    let record = node.record(NOTES).await;
    assert!(!record.enabled);
    assert!(record.approved_grants.is_empty());
}

/// Disabling clears the stored set, so "disable, then enable" would otherwise
/// be a second way to restore the full list.
#[tokio::test]
async fn disable_then_enable_by_an_agent_does_not_restore_the_permissions() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;
    enabled_record(node.enable(EnableCaller::Person, NOTES, false).await);
    node.narrow(NOTES, &[READ]).await;
    disable_app(&node.store, NOTES, &node.manifests, false, false)
        .await
        .unwrap();

    left_to_the_person(node.enable(EnableCaller::Agent, NOTES, false).await);

    let record = node.record(NOTES).await;
    assert!(!record.enabled);
    assert!(record.approved_grants.is_empty());
}

/// The call also switches on every dependency that is off. A dependency that
/// asks for permissions stops an agent's call too, and nothing is switched on.
#[tokio::test]
async fn an_agent_enable_that_would_approve_a_dependency_is_left_to_the_person() {
    let node = Node::with(vec![app(SEARCH, &[READ], &[]), app(NOTES, &[], &[SEARCH])]).await;

    let unapproved = left_to_the_person(node.enable(EnableCaller::Agent, NOTES, false).await);

    assert_eq!(
        unapproved,
        vec![UnapprovedPermissions {
            app: SEARCH.to_owned(),
            permissions: grants(&[READ]),
        }]
    );
    assert!(!node.record(SEARCH).await.enabled);
    assert!(!node.record(NOTES).await.enabled);
}

/// An app that asks for nothing is still the agent's to switch on.
#[tokio::test]
async fn an_agent_switches_on_an_app_that_asks_for_no_permissions() {
    let node = Node::with(vec![app(NOTES, &[], &[])]).await;

    let (record, notice) = enabled_record(node.enable(EnableCaller::Agent, NOTES, false).await);

    assert!(record.enabled);
    assert!(node.record(NOTES).await.enabled);
    assert_eq!(notice, None);
}

/// The person's own client is not changed: a first enable approves the list,
/// and a re-enable approves the full list again, as before this change.
#[tokio::test]
async fn the_persons_own_enable_approves_the_full_list_as_before() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;
    let (first, notice) = enabled_record(node.enable(EnableCaller::Person, NOTES, false).await);
    assert_eq!(first.approved_grants, grants(&[READ, RUN]));
    assert_eq!(notice, None);
    node.narrow(NOTES, &[READ]).await;

    let (again, notice) = enabled_record(node.enable(EnableCaller::Person, NOTES, false).await);

    assert_eq!(again.approved_grants, grants(&[READ, RUN]));
    assert_eq!(
        node.record(NOTES).await.approved_grants,
        grants(&[READ, RUN])
    );
    assert_eq!(notice, None);
}

/// A dry run writes nothing for either caller, so an agent may still preview.
#[tokio::test]
async fn a_dry_run_is_the_same_plan_for_both_callers() {
    let node = Node::with(vec![app(NOTES, &[READ, RUN], &[])]).await;
    for caller in [EnableCaller::Person, EnableCaller::Agent] {
        let (planned, notice) = enabled_record(node.enable(caller, NOTES, true).await);
        assert_eq!(planned.approved_grants, grants(&[READ, RUN]), "{caller:?}");
        assert_eq!(notice, None, "{caller:?}");
        let record = node.record(NOTES).await;
        assert!(!record.enabled, "{caller:?}");
        assert!(record.approved_grants.is_empty(), "{caller:?}");
    }
}

#[test]
fn the_caller_is_read_from_the_self_api_mark() {
    use axum::http::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert("authorization", HeaderValue::from_static("Bearer node"));
    assert_eq!(EnableCaller::of(&headers), EnableCaller::Person);
    headers.insert(
        crate::self_api::SELF_API_CALL_HEADER,
        HeaderValue::from_static("1"),
    );
    assert_eq!(EnableCaller::of(&headers), EnableCaller::Agent);
}

#[tokio::test]
async fn the_refusal_names_the_app_and_every_permission() {
    let response = needs_the_person_response(
        NOTES,
        &[UnapprovedPermissions {
            app: SEARCH.to_owned(),
            permissions: grants(&[READ, RUN]),
        }],
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["success"], json!(false));
    assert_eq!(body["needs_person"], json!(true));
    assert_eq!(
        body["unapproved_permissions"],
        json!([{ "app": SEARCH, "permissions": [READ, RUN] }])
    );
    assert!(body["error"].as_str().unwrap().contains(NOTES));
}

/// The route must go through [`enable_for_caller`] with the caller it read
/// from the request. Reads the handler's source, so a later edit that calls
/// the lifecycle directly again (and so drops the rule) fails here.
#[test]
fn the_enable_route_asks_who_is_calling() {
    let handler = include_str!("../../enable_app.rs").replace("\r\n", "\n");
    assert!(
        handler.contains("enable_caller::enable_for_caller(\n        EnableCaller::of(&headers),")
    );
    assert!(handler.contains("return enable_caller::needs_the_person_response(&id, &unapproved);"));
    for direct in [
        "lifecycle::enable_app(",
        "lifecycle::{enable_app",
        " enable_app(\n",
    ] {
        assert!(
            !handler.contains(direct),
            "the enable route calls the lifecycle directly: {direct}"
        );
    }
}
