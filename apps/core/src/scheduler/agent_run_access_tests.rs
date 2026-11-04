//! Regression tests: a routine owner needs exact-agent `agent.run` on the
//! routine's agent, both when the routine is managed and at every firing.

use super::{require_owner_may_run_agent, require_owner_may_run_agents, with_test_owner};
use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

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

#[tokio::test]
async fn an_owner_denied_agent_run_cannot_manage_a_routine_for_that_agent() {
    let denied_agent = unique_id("agent-denied");
    let allowed_agent = unique_id("agent-allowed");
    let _deny = DenyRun::install(&denied_agent, "u1");

    let (refused, allowed, unowned) = with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(member("u1"), async {
            (
                require_owner_may_run_agents(
                    Some("u1"),
                    &[allowed_agent.clone(), denied_agent.clone()],
                )
                .await,
                require_owner_may_run_agent(Some("u1"), &allowed_agent).await,
                require_owner_may_run_agent(None, &denied_agent).await,
            )
        }),
    )
    .await;
    assert!(
        refused.as_ref().is_err_and(|e| e.contains("agent.run")),
        "{refused:?}"
    );
    assert_eq!(allowed, Ok(()));
    assert_eq!(unowned, Ok(()), "a node-authority routine keeps running");
}

#[tokio::test]
async fn an_unbound_personal_node_needs_no_owner_lookup() {
    let agent = unique_id("agent-local");
    let _deny = DenyRun::install(&agent, "u1");
    // No test owner is installed: the check must not consult the control plane.
    let result =
        with_test_node_binding(false, None, require_owner_may_run_agent(Some("u1"), &agent)).await;
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn a_firing_rechecks_the_owners_agent_run_before_running() {
    let agent = unique_id("agent-fire");
    let _deny = DenyRun::install(&agent, "u1");
    let job = ScheduledJob {
        id: unique_id("routine-fire"),
        name: "Fire".to_owned(),
        schedule: Schedule::Every {
            interval: "15m".to_owned(),
        },
        target: JobTarget::Agent {
            agent_id: agent.clone(),
            prompt: "p".to_owned(),
            model: None,
            conversation_id: None,
        },
        enabled: true,
        require_approval: false,
        owner_app: None,
        owner_user_id: Some("u1".to_owned()),
        org_id: Some("org1".to_owned()),
        created_at: "now".to_owned(),
        updated_at: "now".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };
    let outcome = with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(member("u1"), crate::scheduler::run_target_for_job(&job)),
    )
    .await;
    assert!(
        outcome.as_ref().is_err_and(|e| e.contains("agent.run")),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn an_owner_mismatch_from_the_control_plane_refuses() {
    let agent = unique_id("agent-mismatch");
    let result = with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(
            member("someone-else"),
            require_owner_may_run_agent(Some("u1"), &agent),
        ),
    )
    .await;
    assert!(result.is_err_and(|e| e.contains("agent.run")));
}
