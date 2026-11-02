use super::*;

/// Polls the real MCP registry dispatch, whose debug-build futures exceed the
/// 2 MiB test thread. Run it on one owned worker with the 16 MiB stack Core's
/// runtime workers use, rather than changing global stack settings.
#[test]
fn configuration_approval_preserves_alias_scope_and_executes_only_after_decision() {
    let worker = std::thread::Builder::new()
        .name("approval-configuration-fixture".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("create owned approval fixture runtime")
                .block_on(Box::pin(run_configuration_approval_fixture()));
        })
        .expect("start approval fixture worker");
    if let Err(panic) = worker.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_configuration_approval_fixture() {
    let directory = tempfile::tempdir().unwrap();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    preferences
        .set(policy::APPROVAL_MODE_PREF, "off")
        .await
        .unwrap();
    let agents = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::AcpAgentRegistry::new(),
    )
    .unwrap();
    let target = agents
        .create(crate::agents::CreateAgent {
            name: "Original".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
    let registry = crate::sidecar::mcp::McpRegistry::empty().with_agent_store(agents.clone());
    let alias = "app.agent_builder.configure_agent";
    registry.register_app_tool(
        alias.to_owned(),
        "agent_builder.configure_agent".to_owned(),
        None,
    );
    let registry = std::sync::Arc::new(registry);
    let arguments = serde_json::json!({"agent_id": target.id, "name": "Changed"});
    let allowlist = vec![alias.to_owned()];
    // Inbox approval cannot manufacture a calling-agent identity or the
    // configuration grant obtained separately by the interactive bridge.
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
        let error = registry
            .call_tool_with_identity_after_approval_scoped(
                caller,
                alias,
                arguments.clone(),
                Some(&allowlist),
                None,
                &[],
                None,
                None,
                None,
                None,
                granted,
            )
            .await
            .expect_err("approval replay must retain configuration authorization");
        assert_eq!(error.to_string(), expected);
        assert_eq!(
            agents.get(&target.id).await.unwrap().unwrap().name,
            "Original"
        );
    }
    let approvals = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(approvals.clone(), reqwest::Client::new())
        .with_preferences(preferences)
        .with_registry(registry);
    assert!(gate_tool_call_with_engine(
        &engine,
        crate::runnable::agent_configuration_policy::TOOL_ID,
        alias,
        &arguments,
        Some("ryu"),
        &[],
        Some(&allowlist),
        None,
        &[],
        None,
        None,
        None,
        None,
        true,
        true
    )
    .await
    .is_some());
    assert_eq!(
        agents.get(&target.id).await.unwrap().unwrap().name,
        "Original"
    );
    let pending = approvals.list(Some(ApprovalStatus::Pending)).await.unwrap();
    assert_eq!(pending.len(), 1);
    let Some(PendingAction::ToolCall {
        tool_id,
        arguments: captured,
        allowlist: captured_allowlist,
        agent_id: captured_agent,
        configure_approved: captured_grant,
        ..
    }) = pending[0].action.as_ref()
    else {
        panic!("configuration must queue the actual tool action")
    };
    assert_eq!(tool_id, alias);
    assert_eq!(captured, &arguments);
    assert_eq!(captured_allowlist.as_ref(), Some(&allowlist));
    assert_eq!(captured_agent.as_deref(), Some("ryu"));
    assert!(*captured_grant);
    engine.decide(&pending[0].id, true, None).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if agents.get(&target.id).await.unwrap().unwrap().name == "Changed" {
                break;
            }
            if let Some(row) = approvals.get(&pending[0].id).await.unwrap() {
                assert!(
                    row.error.is_none(),
                    "approved alias failed: {:?}",
                    row.error
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approved configuration must execute");
    engine.decide(&pending[0].id, true, None).await.unwrap();
    assert_eq!(
        agents.get(&target.id).await.unwrap().unwrap().name,
        "Changed"
    );
}

#[tokio::test]
async fn gated_agent_inbox_send_card_names_recipients_and_subject() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let arguments = serde_json::json!({
        "to": ["buyer@example.com"],
        "subject": "Your quote",
        "text": "Attached.",
    });
    let refusal = gate_tool_call_with_engine(
        &engine,
        "agent_inbox.send",
        "agent_inbox.send",
        &arguments,
        None,
        &[],
        None,
        None,
        &[],
        None,
        None,
        None,
        None,
        false,
        true,
    )
    .await;
    assert!(
        refusal.is_some(),
        "agent_inbox.send must gate in smart mode"
    );
    let pending = engine
        .store
        .list(Some(ApprovalStatus::Pending))
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].question.as_deref(),
        Some("Send \"Your quote\" to buyer@example.com?")
    );
    assert!(pending[0].summary.contains("Email subject: Your quote"));
    assert_eq!(pending[0].source_ref.as_deref(), Some("agent_inbox.send"));
}

pub(super) fn pending_req() -> ApprovalRequest {
    ApprovalRequest::new(
        ApprovalKind::TriggerRun,
        "test".to_owned(),
        "a test request".to_owned(),
        None,
    )
}

/// A push reveals an approval's title only to a device whose registering
/// member may read the inbox on this node.
#[test]
fn approval_push_content_follows_the_inbox_permission() {
    use ApprovalPushAudience::{Members, Nobody, Owner, Unbound};

    // Anonymous registrations never see content.
    for audience in [Unbound, Nobody, Members, Owner(Some("alice".to_owned()))] {
        assert!(
            !push_shows_approval_content(&audience, None),
            "{audience:?}"
        );
    }
    assert!(push_shows_approval_content(&Unbound, Some("alice")));
    assert!(!push_shows_approval_content(&Nobody, Some("alice")));
    let personal = Owner(Some("alice".to_owned()));
    assert!(push_shows_approval_content(&personal, Some("alice")));
    assert!(!push_shows_approval_content(&personal, Some("bob")));
    assert!(!push_shows_approval_content(&Owner(None), Some("alice")));
    // Organization nodes need the control-plane lookup, never a default yes.
    assert!(!push_shows_approval_content(&Members, Some("alice")));
}

/// On an unbound node the push rule for a device registered without a user
/// identity matches what the inbox answers that same caller. The inbox
/// refuses it, so the push carries no title; if the inbox ever admits such
/// callers, this fails and the push rule must follow.
#[tokio::test]
async fn unbound_anonymous_push_matches_the_inbox_answer() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(dir.path());
    let inbox_admits = crate::server::approvals_api::caller_may_view_approvals(&state, &None).await;
    assert!(
        !inbox_admits,
        "the approval inbox refuses anonymous callers"
    );
    assert_eq!(
        push_shows_approval_content(&ApprovalPushAudience::Unbound, None),
        inbox_admits
    );
    // A verified user on the same unbound node keeps the title.
    assert!(push_shows_approval_content(
        &ApprovalPushAudience::Unbound,
        Some("alice")
    ));
}

/// The content-free message is what an unbound node sends an anonymous
/// registration, and what an org-bound node sends a member without
/// `approvals.view`.
#[test]
fn approval_push_message_follows_the_audience_decision() {
    let mut req = pending_req();
    req.title = "Delete production database".to_owned();
    for (audience, owner) in [
        (ApprovalPushAudience::Unbound, None),
        (ApprovalPushAudience::Members, Some("bob")),
        (ApprovalPushAudience::Nobody, Some("bob")),
    ] {
        let show = push_shows_approval_content(&audience, owner);
        let message = approval_push_message("tok", &req, show, "en");
        assert!(
            !message.to_string().contains("production"),
            "{audience:?} {owner:?}"
        );
    }
    let show = push_shows_approval_content(&ApprovalPushAudience::Unbound, Some("alice"));
    assert_eq!(
        approval_push_message("tok", &req, show, "en")["body"],
        req.title
    );
}

#[test]
fn content_free_approval_push_omits_title_and_kind() {
    let mut req = pending_req();
    req.title = "Wire $40,000 to acct 1234".to_owned();
    let full = approval_push_message("tok", &req, true, "en");
    assert_eq!(full["body"], req.title);
    assert!(full["data"].get("kind").is_some());

    let bare = approval_push_message("tok", &req, false, "en");
    let text = bare.to_string();
    assert!(!text.contains("40,000"), "{text}");
    assert!(bare["data"].get("kind").is_none());
    assert_eq!(bare["data"]["approval_id"], req.id);
    assert_eq!(bare["to"], "tok");
    assert_eq!(bare["title"], "Approval needed");
    assert_eq!(
        bare["body"],
        "A request is waiting for a decision. Open Ryu to review it."
    );
}

/// The lock screen shows the push as sent, so Core renders it in the device's
/// language; the request's own title is never translated.
#[test]
fn approval_push_is_rendered_in_the_device_locale() {
    let mut req = pending_req();
    req.title = "Deploy the release".to_owned();
    let full = approval_push_message("tok", &req, true, "ja");
    assert_ne!(full["title"], "Approval needed");
    assert_eq!(full["body"], req.title);
    let unknown = approval_push_message("tok", &req, false, "tlh");
    assert_eq!(unknown["title"], "Approval needed");
}

#[tokio::test]
async fn approval_mode_defaults_smart_without_preferences() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    // Fail-safe: no preferences store ⇒ Smart, never Off.
    assert_eq!(engine.approval_mode().await, policy::ApprovalMode::Smart);
}

#[test]
fn for_tool_call_carries_kind_source_and_action() {
    let action = PendingAction::ToolCall {
        tool_id: "gmail.send_email".to_owned(),
        arguments: serde_json::json!({ "to": "x" }),
        agent_id: None,
        allowlist: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
        composio_connection_scope: None,
        conversation_scope: None,
        configure_approved: false,
    };
    let req = ApprovalRequest::for_tool_call("gmail.send_email", vec!["send".to_owned()], action);
    assert_eq!(req.kind, ApprovalKind::ToolCall);
    assert_eq!(
        req.question.as_deref(),
        Some("Can I run \"gmail.send_email\" now?")
    );
    assert_eq!(req.source_ref.as_deref(), Some("gmail.send_email"));
    assert!(matches!(req.action, Some(PendingAction::ToolCall { .. })));
    assert!(req.risk_tags.iter().any(|t| t == "send"));
}

#[test]
fn queued_configuration_permission_survives_serialization_and_legacy_defaults_to_denied() {
    let mut saved = serde_json::json!({
        "type": "tool_call",
        "tool_id": "agent_builder.configure_agent",
        "arguments": {"agent_id": "custom", "name": "Approved"},
        "configure_approved": true
    });
    let approved: PendingAction = serde_json::from_value(saved.clone()).unwrap();
    assert!(matches!(
        approved,
        PendingAction::ToolCall {
            configure_approved: true,
            ..
        }
    ));
    assert_eq!(
        serde_json::to_value(&approved).unwrap()["configure_approved"],
        true
    );

    saved.as_object_mut().unwrap().remove("configure_approved");
    let legacy: PendingAction = serde_json::from_value(saved).unwrap();
    assert!(matches!(
        legacy,
        PendingAction::ToolCall {
            configure_approved: false,
            ..
        }
    ));
}

#[test]
fn for_scheduled_job_uses_inbox_language_and_dedup_key() {
    let job = crate::scheduler::store::ScheduledJob {
        id: "job-morning-digest".to_owned(),
        name: "Morning digest".to_owned(),
        schedule: crate::scheduler::store::Schedule::Every {
            interval: "1h".to_owned(),
        },
        target: crate::scheduler::store::JobTarget::Agent {
            agent_id: "ryu".to_owned(),
            prompt: "Summarize the inbox".to_owned(),
            model: None,
            conversation_id: None,
        },
        enabled: true,
        require_approval: true,
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: "2026-08-20T00:00:00Z".to_owned(),
        updated_at: "2026-08-20T00:00:00Z".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };

    let req = ApprovalRequest::for_scheduled_job(&job);
    assert_eq!(req.kind, ApprovalKind::ScheduledRun);
    assert_eq!(req.question.as_deref(), Some("Run \"Morning digest\" now?"));
    assert!(req.summary.contains("Inbox"));
    assert_eq!(req.source_ref.as_deref(), Some("job-morning-digest"));
    assert_eq!(req.agent_id.as_deref(), Some("ryu"));
    assert!(req.risk_tags.iter().any(|tag| tag == "scheduled"));
    assert!(matches!(
        req.action,
        Some(PendingAction::ScheduledJob { .. })
    ));

    let mut app_job = job;
    app_job.name = "monitor: Site".to_owned();
    app_job.target = crate::scheduler::store::JobTarget::AppJob {
        plugin_id: "@ryu/monitors".to_owned(),
        job_id: "m1".to_owned(),
        payload: None,
    };
    let req = ApprovalRequest::for_scheduled_job(&app_job);
    assert_eq!(
        req.question.as_deref(),
        Some("Run \"monitor: Site\" (@ryu/monitors) now?")
    );
    assert_eq!(req.agent_id, None);
}

/// A pending approval persisted with the retired per-app target still matches
/// the migrated job, so approving it is not refused as "target changed".
#[test]
fn a_legacy_scheduled_job_action_deserializes_to_the_migrated_target() {
    let action: PendingAction = serde_json::from_value(serde_json::json!({
        "type": "scheduled_job",
        "target": { "type": "monitor", "monitor_id": "m1" },
        "job_id": "monitor-m1",
    }))
    .unwrap();
    let PendingAction::ScheduledJob { target, job_id } = action else {
        panic!("a scheduled-job action");
    };
    assert_eq!(job_id.as_deref(), Some("monitor-m1"));
    assert_eq!(
        target,
        crate::scheduler::store::JobTarget::AppJob {
            plugin_id: crate::plugins::builtins::MONITORS_PLUGIN_ID.to_owned(),
            job_id: "m1".to_owned(),
            payload: None,
        }
    );
}

#[test]
fn for_skill_synthesis_defers_write_and_dedups_on_slug() {
    let req = ApprovalRequest::for_skill_synthesis(
        "summarize-arxiv",
        "Summarize arXiv papers",
        "Fetch and condense a paper by id.",
        "conv_123",
        "---\nname: Summarize arXiv papers\n---\nsteps".to_owned(),
    );
    assert_eq!(req.kind, ApprovalKind::SkillSynthesis);
    // Dedup key is the slug so re-synthesis can't pile up duplicates.
    assert_eq!(req.source_ref.as_deref(), Some("skill:summarize-arxiv"));
    assert_eq!(req.conversation_id.as_deref(), Some("conv_123"));
    // The `auto` tag mirrors Hermes' `[auto]` origin marker.
    assert!(req.risk_tags.iter().any(|t| t == "auto"));
    // The full SKILL.md rides in the action so nothing is written until approve.
    match req.action {
        Some(PendingAction::ActivateSkill {
            ref slug,
            ref skill_md,
        }) => {
            assert_eq!(slug, "summarize-arxiv");
            assert!(skill_md.contains("Summarize arXiv papers"));
        }
        _ => panic!("expected an ActivateSkill action carrying the deferred skill"),
    }
}

#[test]
fn for_heal_fix_defers_rerun_and_dedups_on_conversation() {
    let req = ApprovalRequest::for_heal_fix(
        "conv_42",
        Some("ryu".to_owned()),
        "the tool call used a bad path",
        "Retry, but read ./data/report.md with an absolute path.".to_owned(),
    );
    assert_eq!(req.kind, ApprovalKind::HealFix);
    // Dedup + correlation both key on the source conversation.
    assert_eq!(req.source_ref.as_deref(), Some("conv_42"));
    assert_eq!(req.conversation_id.as_deref(), Some("conv_42"));
    match req.action {
        Some(PendingAction::HealRerun {
            ref agent_id,
            ref prompt,
        }) => {
            assert_eq!(agent_id.as_deref(), Some("ryu"));
            assert!(prompt.contains("absolute path"));
        }
        _ => panic!("expected a HealRerun action carrying the corrected prompt"),
    }
}

#[test]
fn for_heal_workflow_carries_run_id_and_rerun_action() {
    let req = ApprovalRequest::for_heal_workflow("wfrun_9", "a step timed out");
    assert_eq!(req.kind, ApprovalKind::HealFix);
    assert_eq!(req.source_ref.as_deref(), Some("wfrun_9"));
    match req.action {
        Some(PendingAction::HealWorkflowRerun { ref run_id }) => {
            assert_eq!(run_id, "wfrun_9");
        }
        _ => panic!("expected a HealWorkflowRerun action"),
    }
    assert!(req.risk_tags.iter().any(|t| t == "workflow"));
}

#[test]
fn for_heal_exhausted_has_no_action() {
    let req = ApprovalRequest::for_heal_exhausted("conv_42", "gave up after 2 tries");
    assert_eq!(req.kind, ApprovalKind::HealFix);
    // Terminal review item — never auto-runs anything.
    assert!(req.action.is_none());
    assert!(req.risk_tags.iter().any(|t| t == "exhausted"));
}
