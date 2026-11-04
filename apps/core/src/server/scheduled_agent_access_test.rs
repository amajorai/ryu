//! Regression tests for the exact-agent `agent.run` check the scheduled-routine
//! routes apply to agent targets.

use super::super::{run_job_now, validate_scheduled_target};
use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;

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

/// Deny `agent.run` on `agent_id` to `user_id`; cleared when dropped.
struct DenyRun(ResourceKey);

impl DenyRun {
    fn install(agent_id: &str, user_id: &str) -> Self {
        let key = ResourceKey::new(crate::acl::KIND_AGENT, agent_id);
        crate::acl::store::set_overwrites(
            &key,
            vec![StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: user_id.to_owned(),
                allow: Vec::new(),
                deny: vec![permissions::AGENT_RUN.to_owned()],
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

fn agent_target(agent_id: &str) -> JobTarget {
    JobTarget::Agent {
        agent_id: agent_id.to_owned(),
        prompt: "p".to_owned(),
        model: None,
        conversation_id: None,
    }
}

#[tokio::test]
async fn a_routine_cannot_target_an_agent_the_caller_may_not_run() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let agent = state
        .agent_store
        .create(crate::agents::CreateAgent {
            name: "Restricted".into(),
            ..Default::default()
        })
        .await
        .expect("agent fixture");
    let _deny = DenyRun::install(&agent.id, "bob");
    let target = agent_target(&agent.id);

    with_test_node_binding(true, Some(org_node()), async {
        let bob = caller("bob", OrgRole::Admin);
        let refused = validate_scheduled_target(&state, &bob, &target, false, None).await;
        assert!(
            refused.as_ref().is_err_and(|e| e.contains("agent.run")),
            "create: {refused:?}"
        );
        // Switching an existing routine off stays possible.
        let disable = validate_scheduled_target(&state, &bob, &target, false, Some(&target)).await;
        assert_eq!(disable, Ok(()));

        let carol = caller("carol", OrgRole::Admin);
        let allowed = validate_scheduled_target(&state, &carol, &target, false, None).await;
        assert_eq!(
            allowed,
            Ok(()),
            "a caller holding agent.run may schedule it"
        );
    })
    .await;
}

#[tokio::test]
async fn run_now_rechecks_agent_run_before_running_the_agent() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let agent_id = format!("agent-run-now-{}", uuid::Uuid::new_v4().simple());
    let _deny = DenyRun::install(&agent_id, "bob");
    let job = ScheduledJob {
        id: format!("routine-agent-{}", uuid::Uuid::new_v4().simple()),
        name: "Run now".to_owned(),
        schedule: Schedule::Every {
            interval: "1h".to_owned(),
        },
        target: agent_target(&agent_id),
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
    assert!(stored.history.is_empty(), "the agent never ran");
    let _ = crate::scheduler::store::delete_job(&job.id);
}
