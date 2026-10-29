//! Real handlers, SQLite CAS and the production configuration action.
//! Verified identity is supplied at the handler boundary; JWT verification and
//! managed-node RBAC are separate contracts. No global policy is mutated here.
use super::*;
use crate::approvals::{
    ApprovalEngine, ApprovalEvent, ApprovalRequest, ApprovalStatus, PendingAction,
};
use axum::extract::{Extension, Path, Query, State};
use serde_json::{json, Value};

struct Harness {
    directory: tempfile::TempDir,
    state: ServerState,
    request: ApprovalRequest,
    unrelated: ApprovalRequest,
    agent_id: String,
}

impl Harness {
    async fn new() -> Self {
        assert!(
            !crate::sidecar::control_plane::is_managed_node(),
            "requires isolated unmanaged test node"
        );
        assert!(crate::sidecar::control_plane::registered_node().is_none());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let mut state = isolated_plugin_hook_test_state(directory.path());
        let agents =
            crate::agents::AgentStore::open_approval_test_file(&directory.path().join("action.db"))
                .unwrap();
        let target = agents
            .create(crate::agents::CreateAgent {
                name: "Before decision".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let registry = crate::sidecar::mcp::McpRegistry::empty().with_agent_store(agents.clone());
        let alias = "app.agent_builder.configure_agent";
        registry.register_app_tool(alias.into(), "agent_builder.configure_agent".into(), None);
        state.agent_store = agents;
        state.approvals = ApprovalEngine::new(
            crate::approvals::store::ApprovalStore::open(directory.path().join("approvals.db"))
                .unwrap(),
            reqwest::Client::new(),
        )
        .with_registry(Arc::new(registry));
        let action = PendingAction::ToolCall {
            tool_id: alias.into(),
            arguments: json!({"agent_id": target.id, "name": "After decision"}),
            // Match the actual approved registry entry: retain a verified
            // calling agent and the separately obtained configuration grant.
            agent_id: Some("ryu".into()),
            allowlist: Some(vec![alias.into()]),
            user_id: None,
            profile_ids: vec![],
            session_id: None,
            host_conversation_id: None,
            composio_connection_scope: None,
            conversation_scope: None,
            configure_approved: true,
        };
        let request =
            ApprovalRequest::for_tool_call(alias, vec!["configure".into()], action.clone());
        let unrelated = ApprovalRequest::for_tool_call("unrelated", vec![], action);
        state.approvals.store.insert(&request).await.unwrap();
        state.approvals.store.insert(&unrelated).await.unwrap();
        let sql = rusqlite::Connection::open(directory.path().join("action.db")).unwrap();
        sql.execute_batch("CREATE TABLE decision_action_audit (agent_id TEXT NOT NULL); CREATE TRIGGER decision_action_audit_update AFTER UPDATE OF name ON agents BEGIN INSERT INTO decision_action_audit VALUES (NEW.id); END;").unwrap();
        Self {
            directory,
            state,
            request,
            unrelated,
            agent_id: target.id,
        }
    }

    fn caller(&self) -> Extension<Option<crate::identity_verify::VerifiedCaller>> {
        Extension(Some(crate::identity_verify::VerifiedCaller {
            user_id: "local-reviewer".into(),
            email: None,
            email_verified: false,
            org_id: None,
            role: crate::identity_verify::OrgRole::Viewer,
            teams: vec![],
        }))
    }

    fn note(note: &str) -> Option<Json<approvals_api::DecideBody>> {
        Some(Json(serde_json::from_value(json!({"note":note})).unwrap()))
    }

    async fn snapshot(&self, id: &str) -> Value {
        serde_json::to_value(self.state.approvals.store.get(id).await.unwrap().unwrap()).unwrap()
    }

    fn action_count(&self) -> i64 {
        rusqlite::Connection::open(self.directory.path().join("action.db"))
            .unwrap()
            .query_row("SELECT count(*) FROM decision_action_audit", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    async fn completed(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let row = self
                    .state
                    .approvals
                    .store
                    .get(&self.request.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(row.error.is_none(), "action failed: {:?}", row.error);
                if row.result.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("production action completion");
        assert_eq!(
            self.state
                .agent_store
                .get(&self.agent_id)
                .await
                .unwrap()
                .unwrap()
                .name,
            "After decision"
        );
    }

    async fn assert_unrelated_and_reopened(&self) {
        assert_eq!(
            self.snapshot(&self.unrelated.id).await,
            serde_json::to_value(&self.unrelated).unwrap()
        );
        let reopened_agents = crate::agents::AgentStore::open_approval_test_file(
            &self.directory.path().join("action.db"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(reopened_agents.get(&self.agent_id).await.unwrap().unwrap())
                .unwrap(),
            serde_json::to_value(
                self.state
                    .agent_store
                    .get(&self.agent_id)
                    .await
                    .unwrap()
                    .unwrap()
            )
            .unwrap()
        );
        let reopened = crate::approvals::store::ApprovalStore::open(
            self.directory.path().join("approvals.db"),
        )
        .unwrap();
        for id in [&self.request.id, &self.unrelated.id] {
            assert_eq!(
                serde_json::to_value(reopened.get(id).await.unwrap().unwrap()).unwrap(),
                self.snapshot(id).await
            );
            let (status, Json(body)) = approvals_api::get_approval(
                State(self.state.clone()),
                Path(id.clone()),
                self.caller(),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["approval"], self.snapshot(id).await);
        }
    }
}

#[tokio::test]
async fn approvals_handlers_missing_principal_refuse_every_operation_without_transition() {
    let h = Harness::new().await;
    let mut events = h.state.approvals.store.subscribe();
    let response = approvals_api::list_approvals(
        State(h.state.clone()),
        Query(serde_json::from_value(json!({})).unwrap()),
        Extension(None),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap()
        .is_empty());
    let expected = json!({"success":false,"error":"forbidden"});
    let (status, Json(body)) = approvals_api::get_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        Extension(None),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, expected);
    let (status, Json(body)) = approvals_api::approve_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        Extension(None),
        Harness::note("unauthenticated approve"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, expected);
    let (status, Json(body)) = approvals_api::reject_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        Extension(None),
        Harness::note("unauthenticated reject"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, expected);
    assert_eq!(
        h.snapshot(&h.request.id).await,
        serde_json::to_value(&h.request).unwrap()
    );
    assert_eq!(h.action_count(), 0);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    h.assert_unrelated_and_reopened().await;
}

#[tokio::test]
async fn approvals_list_storage_failure_is_not_an_empty_inbox() {
    let h = Harness::new().await;
    let list = || {
        approvals_api::list_approvals(
            State(h.state.clone()),
            Query(serde_json::from_value(json!({})).unwrap()),
            h.caller(),
        )
    };
    let response = list().await;
    assert_eq!(response.status(), StatusCode::OK);
    let sql = rusqlite::Connection::open(h.directory.path().join("approvals.db")).unwrap();
    sql.execute_batch("DROP TABLE approvals").unwrap();
    let response = list().await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["success"], false);
    assert!(body.get("approvals").is_none(), "{body}");
}

#[tokio::test]
async fn approvals_handlers_concurrent_approvals_have_one_transition_event_and_action() {
    let h = Harness::new().await;
    let mut events = h.state.approvals.store.subscribe();
    let decide = |note| {
        approvals_api::approve_approval(
            State(h.state.clone()),
            Path(h.request.id.clone()),
            h.caller(),
            Harness::note(note),
        )
    };
    let (first, second) = tokio::join!(decide("desktop"), decide("phone"));
    for (status, Json(body)) in [first, second] {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["approval"]["status"], "approved");
    }
    h.completed().await;
    let mut transitions = 0;
    let mut completions = 0;
    while let Ok(event) = events.try_recv() {
        let ApprovalEvent::Decided { request } = event else {
            panic!("unexpected creation event");
        };
        assert_eq!(request.id, h.request.id);
        assert_eq!(request.status, ApprovalStatus::Approved);
        if request.result.is_none() {
            transitions += 1;
        } else {
            completions += 1;
        }
    }
    assert_eq!(transitions, 1);
    assert_eq!(completions, 1);
    assert_eq!(h.action_count(), 1);
    let before = h.snapshot(&h.request.id).await;
    let (status, Json(body)) = approvals_api::reject_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        h.caller(),
        Harness::note("late rejection"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["approval"], before);
    assert_eq!(h.action_count(), 1);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    h.assert_unrelated_and_reopened().await;
}

#[tokio::test]
async fn approvals_handlers_sql_refusal_keeps_pending_and_same_id_retry_persists_note() {
    let h = Harness::new().await;
    let mut events = h.state.approvals.store.subscribe();
    let sql = rusqlite::Connection::open(h.directory.path().join("approvals.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_decision BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'decision storage refused'); END;").unwrap();
    let (status, Json(body)) = approvals_api::approve_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        h.caller(),
        Harness::note("retry note"),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        body,
        json!({"success":false,"error":"transitioning approval"})
    );
    assert_eq!(
        h.snapshot(&h.request.id).await,
        serde_json::to_value(&h.request).unwrap()
    );
    assert_eq!(h.action_count(), 0);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    h.assert_unrelated_and_reopened().await;
    sql.execute_batch("DROP TRIGGER refuse_decision").unwrap();
    let (status, Json(body)) = approvals_api::approve_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        h.caller(),
        Harness::note("retry note"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["approval"]["id"], h.request.id);
    assert_eq!(body["approval"]["note"], "retry note");
    h.completed().await;
    assert_eq!(h.action_count(), 1);
    h.assert_unrelated_and_reopened().await;
}

#[tokio::test]
async fn approvals_handlers_rejection_persists_note_and_never_executes_action() {
    let h = Harness::new().await;
    let mut events = h.state.approvals.store.subscribe();
    let (status, Json(body)) = approvals_api::reject_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        h.caller(),
        Harness::note("do not configure"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["approval"]["status"], "rejected");
    assert_eq!(body["approval"]["note"], "do not configure");
    let before = h.snapshot(&h.request.id).await;
    let (status, Json(body)) = approvals_api::approve_approval(
        State(h.state.clone()),
        Path(h.request.id.clone()),
        h.caller(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["approval"], before);
    assert_eq!(h.action_count(), 0);
    assert_eq!(
        h.state
            .agent_store
            .get(&h.agent_id)
            .await
            .unwrap()
            .unwrap()
            .name,
        "Before decision"
    );
    let ApprovalEvent::Decided { request } = events.try_recv().unwrap() else {
        panic!("expected decision");
    };
    assert_eq!(request.status, ApprovalStatus::Rejected);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    h.assert_unrelated_and_reopened().await;
}

#[tokio::test]
async fn approvals_handlers_approved_alias_cannot_manufacture_configuration_permission() {
    for (caller, granted, expected) in [
        (
            None,
            true,
            "tool 'agent_builder.configure_agent' requires a verified calling agent",
        ),
        (
            Some("ryu"),
            false,
            "agent_builder.configure_agent requires interactive permission",
        ),
    ] {
        let h = Harness::new().await;
        let mut request = h.request.clone();
        let Some(PendingAction::ToolCall {
            agent_id,
            configure_approved,
            ..
        }) = request.action.as_mut()
        else {
            panic!("expected captured configuration action");
        };
        *agent_id = caller.map(str::to_owned);
        *configure_approved = granted;
        h.state.approvals.store.update(&request).await.unwrap();
        let (status, Json(body)) = approvals_api::approve_approval(
            State(h.state.clone()),
            Path(h.request.id.clone()),
            h.caller(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["approval"]["status"], "approved");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let row = h
                    .state
                    .approvals
                    .store
                    .get(&h.request.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(row.result.is_none(), "denied action cannot report success");
                if let Some(error) = row.error {
                    assert_eq!(error, expected);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("denied replay must record the actual refusal");
        assert_eq!(h.action_count(), 0);
        assert_eq!(
            h.state
                .agent_store
                .get(&h.agent_id)
                .await
                .unwrap()
                .unwrap()
                .name,
            "Before decision"
        );
        h.assert_unrelated_and_reopened().await;
    }
}
