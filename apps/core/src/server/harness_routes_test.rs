//! Route-level harness session/run lifecycle: child listing, native binding,
//! durable event replay, and cancellation (idempotent, queue-aware, and
//! owner-scoped). Runs are started through the store, never dispatched, so no
//! model or network is involved; the handlers are the shipping `routes()`.
use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::conversations::Tenancy;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    state: ServerState,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        Self {
            _directory: directory,
            state,
        }
    }

    async fn raw(
        &self,
        caller: Option<VerifiedCaller>,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, String) {
        let router = routes()
            .layer(axum::Extension(caller))
            .with_state(self.state.clone());
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
        let bytes = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            axum::body::to_bytes(response.into_body(), 1024 * 1024),
        )
        .await
        .expect("the response body must end")
        .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (status, text) = self.raw(None, method, uri, body).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn create_session(&self, parent: Option<&str>) -> String {
        let (status, body) = self
            .send(
                "POST",
                "/api/harness/sessions",
                Some(json!({
                    "runnableId": "agent-harness",
                    "runnableKind": "agent",
                    "parentSessionId": parent,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["session"]["id"].as_str().unwrap().to_owned()
    }

    async fn start_run(&self, session_id: &str, strategy: Option<MultitaskStrategy>) -> HarnessRun {
        self.state
            .conversations
            .start_harness_run(
                session_id,
                &StartRunRequest {
                    input: json!({ "prompt": "hello" }),
                    idempotency_key: None,
                    execution_profile: None,
                    resume_run_id: None,
                    multitask_strategy: strategy,
                },
            )
            .await
            .unwrap()
            .run
    }

    async fn run_status(&self, run_id: &str) -> RunStatus {
        self.state
            .conversations
            .get_harness_run(run_id)
            .await
            .unwrap()
            .unwrap()
            .status
    }

    async fn canceled_events(&self, run_id: &str) -> usize {
        self.state
            .conversations
            .list_harness_events(run_id, 0, 500)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.event == RunEvent::RunCanceled)
            .count()
    }
}

/// Parse the `data:` payloads of the complete server-sent events in `wire`.
fn sse_events(wire: &str) -> Vec<Value> {
    wire.split("\n\n")
        .filter_map(|frame| frame.lines().find_map(|line| line.strip_prefix("data: ")))
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
}

#[tokio::test]
async fn children_are_listed_per_parent_and_native_ids_persist() {
    with_test_node_binding(false, None, async {
        let harness = Harness::new();
        let parent = harness.create_session(None).await;
        let child = harness.create_session(Some(&parent)).await;
        let unrelated = harness.create_session(None).await;

        let (status, body) = harness
            .send(
                "GET",
                &format!("/api/harness/sessions/{parent}/children"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec![child.as_str()]);
        assert_eq!(body["sessions"][0]["parentSessionId"], parent.as_str());
        let (_, body) = harness
            .send(
                "GET",
                &format!("/api/harness/sessions/{unrelated}/children"),
                None,
            )
            .await;
        assert_eq!(body["sessions"], json!([]));
        let (status, _) = harness
            .send("GET", "/api/harness/sessions/ses_missing/children", None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = harness
            .send(
                "POST",
                "/api/harness/sessions",
                Some(json!({
                    "runnableId": "agent-harness",
                    "runnableKind": "agent",
                    "parentSessionId": "ses_missing",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let native = format!("/api/harness/sessions/{child}/native");
        let (status, bound) = harness
            .send(
                "PUT",
                &native,
                Some(json!({ "nativeSessionId": " codex-42 " })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{bound}");
        assert_eq!(bound["session"]["nativeSessionId"], "codex-42");
        let (_, reread) = harness
            .send("GET", &format!("/api/harness/sessions/{child}"), None)
            .await;
        assert_eq!(reread["session"]["nativeSessionId"], "codex-42");
        let (status, _) = harness
            .send("PUT", &native, Some(json!({ "nativeSessionId": "  " })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, reread) = harness
            .send("GET", &format!("/api/harness/sessions/{child}"), None)
            .await;
        assert_eq!(reread["session"]["nativeSessionId"], "codex-42");
    })
    .await;
}

#[tokio::test]
async fn cancel_is_idempotent_and_events_replay_to_the_terminal_event() {
    with_test_node_binding(false, None, async {
        let harness = Harness::new();
        let session = harness.create_session(None).await;
        let active = harness.start_run(&session, None).await;
        assert_eq!(active.status, RunStatus::Running);
        let queued = harness
            .start_run(&session, Some(MultitaskStrategy::Enqueue))
            .await;
        assert_eq!(queued.status, RunStatus::Pending);

        // A queued run is dropped from the queue without touching the active run.
        let (status, body) = harness
            .send(
                "POST",
                &format!("/api/harness/runs/{}/cancel", queued.id),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "cancelled": true, "runId": queued.id }));
        assert_eq!(harness.run_status(&queued.id).await, RunStatus::Canceled);
        assert_eq!(harness.run_status(&active.id).await, RunStatus::Running);

        // The active run has no live dispatch in this process: Cancel closes it.
        let cancel = format!("/api/harness/runs/{}/cancel", active.id);
        let (status, body) = harness.send("POST", &cancel, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["cancelled"], true);
        assert_eq!(harness.run_status(&active.id).await, RunStatus::Canceled);
        assert_eq!(harness.canceled_events(&active.id).await, 1);

        // Cancelling again reports nothing to stop and records nothing new.
        let (status, body) = harness.send("POST", &cancel, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "cancelled": false, "runId": active.id }));
        assert_eq!(harness.run_status(&active.id).await, RunStatus::Canceled);
        assert_eq!(harness.canceled_events(&active.id).await, 1);

        // The event stream of a finished run replays from the cursor and ends
        // at the terminal event instead of hanging.
        let events = format!("/api/harness/runs/{}/events", active.id);
        let (status, wire) = harness.raw(None, "GET", &events, None).await;
        assert_eq!(status, StatusCode::OK);
        let replay = sse_events(&wire);
        assert!(!replay.is_empty(), "{wire}");
        assert_eq!(replay.last().unwrap()["type"], "run_canceled", "{wire}");
        let seqs: Vec<u64> = replay.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
        let last = *seqs.last().unwrap();
        let (status, wire) = harness
            .raw(None, "GET", &format!("{events}?after={last}"), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(sse_events(&wire).is_empty(), "{wire}");

        for uri in [
            "/api/harness/runs/run_missing/events",
            "/api/harness/runs/run_missing/cancel",
            "/api/harness/runs/run_missing",
        ] {
            let method = if uri.ends_with("cancel") {
                "POST"
            } else {
                "GET"
            };
            let (status, _) = harness.send(method, uri, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        }
    })
    .await;
}

#[tokio::test]
async fn another_member_cannot_cancel_or_read_a_private_run() {
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org-h".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-h".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    with_test_node_binding(false, Some(node), async {
        let harness = Harness::new();
        let session = harness
            .state
            .conversations
            .create_session(
                "agent-harness",
                RunnableKind::Agent,
                Some("agent-harness"),
                Some("Alice's work"),
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org-h".to_owned()),
                },
            )
            .await
            .unwrap();
        let run = harness.start_run(&session.id, None).await;
        let bob = Some(VerifiedCaller {
            user_id: "bob".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-h".to_owned()),
            role: OrgRole::Admin,
            teams: Vec::new(),
        });

        for (method, uri) in [
            ("POST", format!("/api/harness/runs/{}/cancel", run.id)),
            ("GET", format!("/api/harness/runs/{}/events", run.id)),
            (
                "GET",
                format!("/api/harness/sessions/{}/children", session.id),
            ),
        ] {
            let (status, _) = harness.raw(bob.clone(), method, &uri, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        }
        assert_eq!(harness.run_status(&run.id).await, RunStatus::Running);
        assert_eq!(harness.canceled_events(&run.id).await, 0);
    })
    .await;
}
