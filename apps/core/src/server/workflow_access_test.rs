//! Regression tests for the workflow authority applied by `GET /workflows/:id`
//! (trigger signing secret) and the scheduled-routine routes (workflow targets).

use super::super::{get_workflow, run_job_now, validate_scheduled_target, ServerState};
use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::workflow::{Workflow, WorkflowTrigger};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;

const TRIGGER_SECRET: &str = "s3cret-trigger-signing-key";

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn caller(user_id: &str, role: OrgRole) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role,
        teams: Vec::new(),
    })
}

fn unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Persist a workflow with a signed webhook trigger, returning its id.
fn save_webhook_workflow() -> String {
    crate::crypto_host::install();
    let workflow: Workflow = serde_json::from_value(serde_json::json!({
        "id": unique_id("wf-access"),
        "name": "access test",
        "nodes": [],
    }))
    .expect("workflow fixture");
    let workflow = Workflow {
        triggers: vec![WorkflowTrigger::Webhook {
            secret: Some(TRIGGER_SECRET.to_owned()),
        }],
        ..workflow
    };
    crate::workflow::store::save_workflow(&workflow).expect("persist the workflow fixture");
    workflow.id
}

/// Deny `workflow.run` on `workflow_id` to the member `user_id`; dropped with the
/// test so the shared ACL store is left as it was.
struct DenyRun(ResourceKey);

impl DenyRun {
    fn install(workflow_id: &str, user_id: &str) -> Self {
        let key = ResourceKey::new(crate::acl::KIND_WORKFLOW, workflow_id);
        crate::acl::store::set_overwrites(
            &key,
            vec![StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: user_id.to_owned(),
                allow: Vec::new(),
                deny: vec![permissions::WORKFLOW_RUN.to_owned()],
            }],
        )
        .expect("persist the ACL fixture");
        Self(key)
    }
}

impl Drop for DenyRun {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.0, Vec::new());
    }
}

fn workflow_target(workflow_id: &str) -> JobTarget {
    JobTarget::Workflow {
        workflow_id: workflow_id.to_owned(),
        input: std::collections::HashMap::new(),
    }
}

async fn trigger_secret_seen_by(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    id: &str,
) -> (StatusCode, serde_json::Value) {
    let (status, axum::Json(body)) =
        get_workflow(State(state.clone()), Extension(caller), Path(id.to_owned())).await;
    (status, body["workflow"]["triggers"][0]["secret"].clone())
}

#[tokio::test]
async fn a_view_only_reader_gets_the_trigger_secret_masked() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let id = save_webhook_workflow();

    with_test_node_binding(true, Some(org_node()), async {
        let (status, secret) =
            trigger_secret_seen_by(&state, caller("vera", OrgRole::Viewer), &id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(secret, ryu_crypto::redact::REDACTED);

        let (status, secret) =
            trigger_secret_seen_by(&state, caller("ada", OrgRole::Admin), &id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            secret, TRIGGER_SECRET,
            "an editor still reveals and copies it"
        );
    })
    .await;

    // A personal, unbound node keeps the local editor's reveal/copy control.
    let (status, secret) = trigger_secret_seen_by(&state, None, &id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(secret, TRIGGER_SECRET);
    let _ = crate::workflow::store::delete_workflow(&id);
}

#[tokio::test]
async fn a_routine_cannot_target_a_workflow_the_caller_may_not_run() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let id = unique_id("wf-routine");
    let _deny = DenyRun::install(&id, "bob");
    let target = workflow_target(&id);

    with_test_node_binding(true, Some(org_node()), async {
        let bob = caller("bob", OrgRole::Admin);
        let refused = validate_scheduled_target(&state, &bob, &target, true, None).await;
        assert!(
            refused.as_ref().is_err_and(|e| e.contains("workflow.run")),
            "create: {refused:?}"
        );
        let agent_target = JobTarget::Agent {
            agent_id: "agent-x".to_owned(),
            prompt: "p".to_owned(),
            model: None,
            conversation_id: None,
        };
        let retarget =
            validate_scheduled_target(&state, &bob, &target, true, Some(&agent_target)).await;
        assert!(
            retarget.is_err(),
            "retargeting onto the workflow is refused"
        );
        // Switching an existing workflow routine off stays possible.
        let disable = validate_scheduled_target(&state, &bob, &target, false, Some(&target)).await;
        assert_eq!(disable, Ok(()));

        let carol = caller("carol", OrgRole::Admin);
        let allowed = validate_scheduled_target(&state, &carol, &target, true, None).await;
        assert_eq!(
            allowed,
            Ok(()),
            "a caller holding workflow.run may schedule it"
        );
    })
    .await;
}

#[tokio::test]
async fn run_now_rechecks_workflow_run_before_running_the_workflow() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let workflow_id = unique_id("wf-run-now");
    let _deny = DenyRun::install(&workflow_id, "bob");
    let job = ScheduledJob {
        id: unique_id("routine-run-now"),
        name: "Run now".to_owned(),
        schedule: Schedule::Every {
            interval: "1h".to_owned(),
        },
        target: workflow_target(&workflow_id),
        enabled: true,
        require_approval: false,
        owner_app: None,
        owner_user_id: Some("bob".to_owned()),
        org_id: Some("org1".to_owned()),
        created_at: "now".to_owned(),
        updated_at: "now".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };
    crate::scheduler::store::save_job(&job).expect("persist the routine fixture");

    let response = with_test_node_binding(
        true,
        Some(org_node()),
        run_job_now(
            State(state.clone()),
            Extension(caller("bob", OrgRole::Admin)),
            Path(job.id.clone()),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let stored = crate::scheduler::store::load_job(&job.id).expect("routine still stored");
    assert!(stored.history.is_empty(), "the workflow never ran");
    assert!(stored.last_run_at.is_none());
    let _ = crate::scheduler::store::delete_job(&job.id);
}
