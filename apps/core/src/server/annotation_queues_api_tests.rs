//! Annotation queue routes on an org-bound node: the per-agent ACL decides who
//! may read or review a queue, and the per-conversation ACL hides every item
//! copied from a run the caller may not read, on list, get, submit, next and
//! export alike.
//!
//! The router is the shipping `routes()`; the queue and prompt-suite stores
//! are the process globals the handlers resolve (in-memory, first install
//! wins), and every agent, run and queue id is unique to its test.
use super::*;
use crate::agents::CreateAgent;
use crate::identity_verify::OrgRole;
use crate::server::conversations::Tenancy;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::{body::Body, http::Request};
use tower::ServiceExt;

const ORG: &str = "org-aq";

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-aq".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn user(user_id: &str, role: OrgRole) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(ORG.to_owned()),
        role,
        teams: Vec::new(),
    })
}

fn install_stores() {
    let _ = AnnotationQueueStore::install_global(AnnotationQueueStore::open_in_memory().unwrap());
    let _ = crate::prompt_evals::PromptEvalStore::install_global(
        crate::prompt_evals::PromptEvalStore::open_in_memory().unwrap(),
    );
}

async fn send(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let router = routes()
        .layer(axum::Extension(caller.clone()))
        .with_state(state.clone());
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = router.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A run owned (privately) by `owner`, answered by `agent_id`.
async fn private_run(state: &ServerState, agent_id: &str, owner: &str) -> String {
    let run_id = format!("run-aq-{}", uuid::Uuid::new_v4().simple());
    let tenancy = || Tenancy::Owned {
        user_id: owner.to_owned(),
        org_id: Some(ORG.to_owned()),
    };
    state
        .conversations
        .ensure_conversation(&run_id, Some(agent_id), None, tenancy())
        .await
        .unwrap();
    for (role, content) in [
        ("user", "what is the acquisition codename?"),
        ("assistant", "the codename is Falcon"),
    ] {
        state
            .conversations
            .append_message_as(
                &run_id,
                role,
                content,
                Some(agent_id),
                Some(owner),
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
    }
    run_id
}

fn item_ids(body: &Value) -> Vec<String> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

struct Fixture {
    _directory: tempfile::TempDir,
    state: ServerState,
    agent_id: String,
    queue_id: String,
    private_item: String,
    trace_item: String,
}

/// Alice (admin) builds a queue holding one item from her private run and
/// one external-trace item.
async fn fixture() -> Fixture {
    install_stores();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let agent_id = state
        .agent_store
        .create(CreateAgent {
            name: "Annotated agent".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;
    let alice = user("alice", OrgRole::Admin);
    let run_id = private_run(&state, &agent_id, "alice").await;

    let (status, created) = send(
        &state,
        &alice,
        "POST",
        "/api/annotation-queues",
        Some(json!({ "agent_id": agent_id, "name": "Review answers" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let queue_id = created["queue"]["id"].as_str().unwrap().to_owned();
    let (status, added) = send(
        &state,
        &alice,
        "POST",
        &format!("/api/annotation-queues/{queue_id}/items"),
        Some(json!({ "items": [
            { "run_id": run_id },
            { "trace_id": "trace-1", "input": "public question", "output": "public answer" },
        ] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(added["added"].as_array().map(Vec::len), Some(2), "{added}");

    let (status, listed) = send(
        &state,
        &alice,
        "GET",
        &format!("/api/annotation-queues/{queue_id}/items"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "the owner sees both items: {listed}");
    let find = |kind: &str| {
        items
            .iter()
            .find(|item| item["source_kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind} item in {listed}"))["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let private_item = find("run");
    let trace_item = find("trace");
    Fixture {
        _directory: directory,
        state,
        agent_id,
        queue_id,
        private_item,
        trace_item,
    }
}

#[tokio::test]
async fn items_copied_from_a_run_the_caller_cannot_read_are_hidden_everywhere() {
    with_test_node_binding(false, Some(org_node()), async {
        let f = fixture().await;
        let bob = user("bob", OrgRole::Admin);
        let base = format!("/api/annotation-queues/{}", f.queue_id);

        // Bob administers the agent but cannot read Alice's private run.
        let (status, listed) = send(&f.state, &bob, "GET", &format!("{base}/items"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(item_ids(&listed), vec![f.trace_item.clone()]);
        assert!(!listed.to_string().contains("Falcon"), "{listed}");

        let private = format!("{base}/items/{}", f.private_item);
        let (status, body) = send(&f.state, &bob, "GET", &private, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert!(!body.to_string().contains("Falcon"));
        let (status, _) = send(
            &f.state,
            &bob,
            "POST",
            &format!("{private}/submit"),
            Some(json!({ "score": 0.1 })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(
            &f.state,
            &bob,
            "PATCH",
            &private,
            Some(json!({ "assignee": "bob" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // `next` hands Bob only the readable item, then nothing.
        let (status, next) = send(&f.state, &bob, "POST", &format!("{base}/next"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(next["item"]["id"], f.trace_item.as_str());
        let (status, submitted) = send(
            &f.state,
            &bob,
            "POST",
            &format!("{base}/items/{}/submit", f.trace_item),
            Some(json!({ "score": 0.8, "labels": [], "comment": "fine" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{submitted}");
        assert_eq!(submitted["item"]["status"], "completed");
        assert_eq!(submitted["item"]["reviewed_by"], "bob");
        let (_, next) = send(&f.state, &bob, "POST", &format!("{base}/next"), None).await;
        assert_eq!(next["item"], Value::Null, "{next}");

        // The private item stayed untouched; its owner can still review it.
        let alice = user("alice", OrgRole::Admin);
        let (status, own) = send(&f.state, &alice, "GET", &private, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(own["item"]["status"], "pending");
        assert_eq!(own["item"]["output"], "the codename is Falcon");
        let (status, _) = send(
            &f.state,
            &alice,
            "POST",
            &format!("{private}/submit"),
            Some(json!({ "score": 0.9 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // Export by Bob copies only the item he could read into the suite.
        let suites = crate::prompt_evals::PromptEvalStore::global().unwrap();
        let suite = suites
            .create_suite(&f.agent_id, "Regression", &json!({}))
            .await
            .unwrap();
        let (status, exported) = send(
            &f.state,
            &bob,
            "POST",
            &format!("{base}/export"),
            Some(json!({ "suite_id": suite.id })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{exported}");
        assert_eq!(exported["added"], 1);
        let stored = suites.get_suite(&suite.id).await.unwrap().unwrap();
        let tests = stored.config["tests"].as_array().unwrap();
        assert_eq!(tests.len(), 1);
        assert!(!stored.config.to_string().contains("Falcon"));

        // Alice's export adds her item; re-exporting adds nothing new.
        let (_, exported) = send(
            &f.state,
            &alice,
            "POST",
            &format!("{base}/export"),
            Some(json!({ "suite_id": suite.id })),
        )
        .await;
        assert_eq!(exported["added"], 1, "{exported}");
        assert_eq!(exported["skipped"], 1, "{exported}");
    })
    .await;
}

#[tokio::test]
async fn queue_access_requires_the_agent_permission() {
    with_test_node_binding(false, Some(org_node()), async {
        let f = fixture().await;
        let base = format!("/api/annotation-queues/{}", f.queue_id);
        // A member holds `agent.view` but not `agent.edit`.
        let carol = user("carol", OrgRole::Member);

        let (status, listed) = send(&f.state, &carol, "GET", &format!("{base}/items"), None).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(item_ids(&listed), vec![f.trace_item.clone()]);

        for (method, uri, body) in [
            (
                "POST",
                "/api/annotation-queues".to_owned(),
                Some(json!({ "agent_id": f.agent_id, "name": "Mine" })),
            ),
            ("PUT", base.clone(), Some(json!({ "name": "renamed" }))),
            ("DELETE", base.clone(), None),
            ("POST", format!("{base}/next"), None),
            (
                "POST",
                format!("{base}/items/{}/submit", f.trace_item),
                Some(json!({ "score": 0.0 })),
            ),
            ("DELETE", format!("{base}/items/{}", f.trace_item), None),
            (
                "POST",
                format!("{base}/items"),
                Some(json!({ "items": [{ "trace_id": "t", "input": "i", "output": "o" }] })),
            ),
        ] {
            let (status, body) = send(&f.state, &carol, method, &uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }

        // Nothing the refusals touched changed.
        let alice = user("alice", OrgRole::Admin);
        let (_, queue) = send(&f.state, &alice, "GET", &base, None).await;
        assert_eq!(queue["queue"]["name"], "Review answers", "{queue}");
        let (_, trace) = send(
            &f.state,
            &alice,
            "GET",
            &format!("{base}/items/{}", f.trace_item),
            None,
        )
        .await;
        assert_eq!(trace["item"]["status"], "pending", "{trace}");
        let (_, all) = send(&f.state, &alice, "GET", &format!("{base}/items"), None).await;
        assert_eq!(all["items"].as_array().unwrap().len(), 2);

        // A caller outside the node's org is refused even read access.
        let mut outsider = user("mallory", OrgRole::Admin);
        outsider.as_mut().unwrap().org_id = Some("org-other".to_owned());
        let (status, _) = send(&f.state, &outsider, "GET", &format!("{base}/items"), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            &f.state,
            &alice,
            "GET",
            "/api/annotation-queues/aq_missing",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}
