//! Regression tests: a workflow routine's owner needs `workflow.run` on the
//! routine's workflow at every firing, not only when the routine was saved.

use super::require_owner_may_run_workflow;
use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::scheduler::agent_run_access::with_test_owner;
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::workflow::Workflow;

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

fn member(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

fn unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Persist a non-agent workflow (input -> uppercase -> output), returning its id.
fn save_plain_workflow() -> String {
    let workflow: Workflow = serde_json::from_value(serde_json::json!({
        "id": unique_id("wf-routine"),
        "name": "routine access test",
        "nodes": [
            { "id": "in", "type": "input", "key": "input" },
            { "id": "up", "type": "transform", "op": "uppercase" },
            { "id": "out", "type": "output", "key": "result" }
        ],
        "edges": [
            { "from": "in", "to": "up" },
            { "from": "up", "to": "out" }
        ]
    }))
    .expect("workflow fixture");
    crate::workflow::store::save_workflow(&workflow).expect("persist the workflow fixture");
    workflow.id
}

/// Deny `workflow.run` on `workflow_id` to `user_id`; cleared when dropped.
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

fn routine(workflow_id: &str, owner: Option<&str>) -> ScheduledJob {
    ScheduledJob {
        id: unique_id("routine-wf"),
        name: "Workflow routine".to_owned(),
        schedule: Schedule::Every {
            interval: "15m".to_owned(),
        },
        target: JobTarget::Workflow {
            workflow_id: workflow_id.to_owned(),
            input: std::collections::HashMap::from([("input".to_owned(), "hi".to_owned())]),
        },
        enabled: true,
        require_approval: false,
        owner_app: None,
        owner_user_id: owner.map(str::to_owned),
        org_id: Some("org1".to_owned()),
        created_at: "now".to_owned(),
        updated_at: "now".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    }
}

fn runs_of(workflow_id: &str) -> usize {
    crate::workflow::store::list_runs()
        .into_iter()
        .filter(|run| run.workflow_id == workflow_id)
        .count()
}

async fn fire_on_org_node(job: &ScheduledJob, owner: &str) -> Result<Option<String>, String> {
    with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(member(owner), crate::scheduler::run_target_for_job(job)),
    )
    .await
}

#[tokio::test]
async fn a_firing_refuses_an_owner_who_lost_workflow_run() {
    let workflow_id = save_plain_workflow();
    let deny = DenyRun::install(&workflow_id, "u1");

    let refused = fire_on_org_node(&routine(&workflow_id, Some("u1")), "u1").await;
    assert!(
        refused.as_ref().is_err_and(|e| e.contains("workflow.run")),
        "{refused:?}"
    );
    assert_eq!(
        runs_of(&workflow_id),
        0,
        "no run was started for the workflow"
    );

    // A node-authority routine (no owner) keeps running despite the member ACL.
    let unowned = fire_on_org_node(&routine(&workflow_id, None), "u1").await;
    assert!(unowned.as_ref().is_ok_and(Option::is_some), "{unowned:?}");

    // Once the owner may run the workflow again, their routine fires.
    drop(deny);
    let allowed = fire_on_org_node(&routine(&workflow_id, Some("u1")), "u1").await;
    let run_id = allowed
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .unwrap_or_else(|| panic!("{allowed:?}"));
    assert!(crate::workflow::store::load_run(run_id).is_ok());
    assert_eq!(runs_of(&workflow_id), 2);
}

#[tokio::test]
async fn an_owner_mismatch_or_unbound_node_is_decided_without_running() {
    let workflow_id = unique_id("wf-missing");
    let mismatch = with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(
            member("someone-else"),
            require_owner_may_run_workflow(Some("u1"), &workflow_id),
        ),
    )
    .await;
    assert!(mismatch.is_err_and(|e| e.contains("workflow.run")));

    let _deny = DenyRun::install(&workflow_id, "u1");
    // No test owner is installed: an unbound personal node must not consult
    // the control plane or the organization ACL.
    let personal = with_test_node_binding(
        false,
        None,
        require_owner_may_run_workflow(Some("u1"), &workflow_id),
    )
    .await;
    assert_eq!(personal, Ok(()));
}
