//! The onboarding snapshot a job is pinned to and the job's wire view.

use super::*;

#[test]
fn profile_scope_snapshot_rejects_a_node_mode_change() {
    let personal = NodeOnboardingState {
        completed: false,
        completed_at_ms: None,
        personalization: Default::default(),
        setup_kind: Some(NodeSetupKind::Personal),
        version: 1,
    };
    let team = NodeOnboardingState {
        completed: false,
        completed_at_ms: None,
        personalization: crate::server::onboarding_state::NodeOnboardingPersonalization {
            company_context: "Acme".to_owned(),
            company_knowledge_enabled: true,
        },
        setup_kind: Some(NodeSetupKind::Team),
        version: 1,
    };
    let snapshot = profile_onboarding_snapshot(&personal);
    assert!(profile_onboarding_snapshot_matches(&personal, &snapshot));
    assert!(!profile_onboarding_snapshot_matches(&team, &snapshot));
}

#[test]
fn profile_scope_snapshot_includes_team_context_and_consent() {
    let state = NodeOnboardingState {
        completed: false,
        completed_at_ms: None,
        personalization: crate::server::onboarding_state::NodeOnboardingPersonalization {
            company_context: "  Acme  ".to_owned(),
            company_knowledge_enabled: true,
        },
        setup_kind: Some(NodeSetupKind::Team),
        version: 1,
    };
    let snapshot = profile_onboarding_snapshot(&state);
    assert_eq!(snapshot.setup_kind, NodeSetupKind::Team);
    assert_eq!(snapshot.company_context, "  Acme  ");
    assert!(snapshot.company_knowledge_enabled);
}

pub(super) fn test_job() -> ProfileJob {
    ProfileJob {
        inputs: ProfileJobInputs {
            onboarding: ProfileOnboardingSnapshot {
                company_context: String::new(),
                company_knowledge_enabled: false,
                setup_kind: NodeSetupKind::Personal,
            },
            composio_connection_scope: None,
            owner_user_id: "owner-1".to_owned(),
            org_id: "org-1".to_owned(),
            input: StartBody {
                cloud_selection: None,
                source_ids: Vec::new(),
                imported_conversation_ids: Vec::new(),
                recent_days: 90,
                share_user_org: false,
            },
        },
        state: JobState::Building,
        started_at_ms: now_ms(),
        materialized: false,
        background: false,
        cancel_requested: false,
        cancel: CancellationToken::new(),
        driver_active: true,
        conversation_id: None,
        error: None,
        agent_suggestions: Vec::new(),
    }
}

#[test]
fn the_wire_materialized_flag_keeps_its_legacy_background_meaning() {
    let mut job = test_job();
    assert!(!view("job", &job).materialized);
    // An older desktop shows "Continue setup" only once this is true.
    job.background = true;
    let backgrounded = view("job", &job);
    assert!(backgrounded.background);
    assert!(backgrounded.materialized);
    // The internal flag is untouched, so the draft stays cancellable.
    assert!(!job.materialized);
    assert!(request_cancel(&mut job));
}
