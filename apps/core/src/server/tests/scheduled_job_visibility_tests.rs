use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
use crate::server::scheduled_job_visible_at;

fn job(user_id: Option<&str>, org_id: Option<&str>) -> ScheduledJob {
    ScheduledJob {
        id: "routine-test".to_owned(),
        name: "Routine test".to_owned(),
        schedule: Schedule::Every {
            interval: "1h".to_owned(),
        },
        target: JobTarget::Agent {
            agent_id: "agent-test".to_owned(),
            prompt: "test".to_owned(),
            model: None,
            conversation_id: None,
        },
        enabled: true,
        require_approval: false,
        owner_app: None,
        owner_user_id: user_id.map(str::to_owned),
        org_id: org_id.map(str::to_owned),
        created_at: "now".to_owned(),
        updated_at: "now".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    }
}

fn caller(user_id: &str, org_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(org_id.to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

#[test]
fn shared_routines_are_visible_only_to_their_owner() {
    let routine = job(Some("alice"), Some("org-1"));
    assert!(scheduled_job_visible_at(
        &routine,
        &caller("alice", "org-1"),
        Some("org-1")
    ));
    assert!(!scheduled_job_visible_at(
        &routine,
        &caller("bob", "org-1"),
        Some("org-1")
    ));
    assert!(!scheduled_job_visible_at(&routine, &None, Some("org-1")));
}

#[test]
fn personal_nodes_keep_single_user_routine_behavior() {
    let routine = job(None, None);
    assert!(scheduled_job_visible_at(&routine, &None, None));
}
