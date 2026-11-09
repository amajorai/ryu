//! Calendar routine history, recreation and ownership across workflow runs.

use super::*;

#[tokio::test]
async fn calendar_overlapping_completion_merges_history_and_stale_config_refuses() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, body) = h.create("Original (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let snapshot = store::quick_routine_snapshot(&original).await.unwrap();
        // Hold the real authorized snapshot, then complete a run before commit.
        store::append_execution(
            &original.id,
            store::ExecRecord {
                started_at: "started".into(),
                finished_at: "finished".into(),
                outcome: store::ExecOutcome::Success,
                run_id: Some("completed-run".into()),
                error: None,
            },
        )
        .unwrap();
        let mut renamed = original.clone();
        renamed.name = "Renamed (scheduled)".into();
        let renamed = store::upsert_quick_routine(renamed, false, snapshot)
            .await
            .unwrap();
        assert_eq!(renamed.history.len(), 1);
        assert_eq!(renamed.history[0].run_id.as_deref(), Some("completed-run"));
        h.readback(&renamed).await;
        let mut proposed = renamed.clone();
        proposed.name = "Fresh user edit".into();
        store::append_execution(
            &renamed.id,
            store::ExecRecord {
                started_at: "second-start".into(),
                finished_at: "second-finish".into(),
                outcome: store::ExecOutcome::Success,
                run_id: Some("second-run".into()),
                error: None,
            },
        )
        .unwrap();
        let permitted = store::update_job_if_current(renamed.clone(), proposed)
            .await
            .unwrap();
        assert_eq!(
            permitted.history.len(),
            2,
            "history-only changes must merge without invalidating config"
        );
        let stale = permitted.clone();
        let response = update_job(
            State(h.state.clone()),
            Extension(None),
            Path(renamed.id.clone()),
            Json(
                serde_json::from_value(json!({"schedule":{"kind":"every","interval":"6h"}}))
                    .unwrap(),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["success"], true);
        let mut stale_write = stale.clone();
        stale_write.name = "Stale overwrite".into();
        let refusal = store::update_job_if_current(stale, stale_write)
            .await
            .unwrap_err();
        assert_eq!(refusal.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            refusal.to_string(),
            "routine changed during validation; retry"
        );
        let current = store::load_job(&renamed.id).unwrap();
        assert_eq!(
            serde_json::to_value(&current.schedule).unwrap(),
            json!({"kind":"every","interval":"6h"})
        );
        assert_eq!(current.name, "Fresh user edit");
        assert_eq!(current.history.len(), 2);
        h.readback(&current).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_delete_invalidates_inflight_snapshot_fresh_create_uses_new_identity() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, body) = h.create("Original (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let snapshot = store::quick_routine_snapshot(&original).await.unwrap();
        let response = delete_job(
            State(h.state.clone()),
            Extension(None),
            Path(original.id.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let refusal = store::upsert_quick_routine(original.clone(), false, snapshot)
            .await
            .unwrap_err();
        assert_eq!(refusal.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            refusal.to_string(),
            "quick routine was deleted; retry creation"
        );
        store::append_execution(
            &original.id,
            store::ExecRecord {
                started_at: "started".into(),
                finished_at: "finished".into(),
                outcome: store::ExecOutcome::Success,
                run_id: None,
                error: None,
            },
        )
        .unwrap();
        assert!(store::list_jobs().is_empty());
        assert!(!h.jobs.join(format!("{}.json", original.id)).exists());
        assert_eq!(
            std::fs::read(
                h.jobs
                    .join(".job-locks")
                    .join(format!("{}.deleted", original.id))
            )
            .unwrap(),
            b"deleted"
        );
        let (status, recreated) = h.create("Fresh (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let recreated: ScheduledJob = serde_json::from_value(recreated["job"].clone()).unwrap();
        assert_ne!(recreated.id, original.id);
        assert!(recreated.history.is_empty());
        assert_eq!(store::list_jobs().len(), 1);
        h.readback(&recreated).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_retained_missing_destination_and_generic_pointer_refuse_without_overwrite() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, body) = h.create("Legacy (scheduled)", false, None).await;
        assert_eq!(status, StatusCode::OK);
        let mut legacy: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let JobTarget::Agent {
            conversation_id, ..
        } = &mut legacy.target
        else {
            panic!("agent target");
        };
        *conversation_id = Some("missing-retained-chat".into());
        store::save_job(&legacy).unwrap();
        let before = serde_json::to_value(&legacy).unwrap();
        let (status, body) = h.create("Refused (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            json!({"success":false,"error":"conversation 'missing-retained-chat' not found"})
        );
        assert_eq!(
            serde_json::to_value(store::load_job(&legacy.id).unwrap()).unwrap(),
            before
        );
        assert!(!h.jobs.join(".quick-routines").exists());
        let (status, body) = h
            .create("Accepted (scheduled)", true, Some(Value::Null))
            .await;
        assert_eq!(status, StatusCode::OK);
        let accepted: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let (status, body) = h.create("Independent generic", false, None).await;
        assert_eq!(status, StatusCode::OK);
        let generic: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let pointer = std::fs::read_dir(h.jobs.join(".quick-routines"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .unwrap();
        let mut slot: Value = store::read_quick_routine_pointer_for_test(&pointer);
        slot["id"] = json!(generic.id);
        store::write_quick_routine_pointer_for_test(&pointer, &slot);
        let (status, body) = h.create("Refused generic overwrite", true, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            json!({"success":false,"error":"quick routine marker missing"})
        );
        h.readback(&generic).await;
        h.readback(&accepted).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_authoritative_workflow_recreation_fences_old_execution_and_preserves_normal_history(
) {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let triggers = vec![crate::workflow::WorkflowTrigger::Schedule {
            cron: None,
            every: Some("1h".into()),
            require_approval: true,
        }];
        crate::workflow::triggers::apply_schedule_reconcile("fenced", "Before", &triggers);
        let original = store::load_job("wf-sched-fenced-0").unwrap();
        let old_claim = store::capture_execution(&original).await.unwrap();
        let normal_claim = store::capture_execution(&original).await.unwrap();
        assert!(
            store::append_execution_claim(normal_claim, completion_record("before-delete"))
                .await
                .unwrap()
        );
        crate::workflow::triggers::apply_schedule_reconcile("fenced", "Renamed", &triggers);
        let updated = store::load_job(&original.id).unwrap();
        assert_ne!(updated.name, original.name);
        assert_eq!(updated.created_at, original.created_at);
        assert_eq!(updated.history.len(), 1);
        assert_eq!(updated.history[0].run_id.as_deref(), Some("before-delete"));
        assert_eq!(
            store::capture_execution(&original)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        crate::workflow::triggers::apply_schedule_reconcile("fenced", "Removed", &[]);
        assert!(store::load_job(&original.id).is_err());
        assert!(store::save_job(&original).is_err());
        crate::workflow::triggers::apply_schedule_reconcile("fenced", "Recreated", &triggers);
        let recreated = store::load_job(&original.id).unwrap();
        assert_eq!(recreated.id, original.id);
        assert_ne!(recreated.created_at, original.created_at);
        assert!(recreated.history.is_empty());
        assert!(recreated.last_run_at.is_none());
        assert!(recreated.last_outcome.is_none());
        assert!(!store::append_execution_claim(
            old_claim,
            completion_record("late-old-generation")
        )
        .await
        .unwrap());
        assert_eq!(
            store::save_job(&original).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        let current_claim = store::capture_execution(&recreated).await.unwrap();
        assert!(store::append_execution_claim(
            current_claim,
            completion_record("current-generation")
        )
        .await
        .unwrap());
        let saved = store::load_job(&original.id).unwrap();
        assert_eq!(saved.history.len(), 1);
        assert_eq!(
            saved.history[0].run_id.as_deref(),
            Some("current-generation")
        );
        h.readback(&saved).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_locked_disable_preserves_fresh_configuration_history_and_retargeted_jobs() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (_, body) = h.create("Original", false, None).await;
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let claim = store::capture_execution(&original).await.unwrap();
        let mut changed = original.clone();
        changed.name = "Current name".into();
        changed.schedule = store::Schedule::Every {
            interval: "6h".into(),
        };
        let changed = store::update_job_if_current(original.clone(), changed)
            .await
            .unwrap();
        assert!(
            store::append_execution_claim(claim, completion_record("concurrent-completion"))
                .await
                .unwrap()
        );
        disable_agent_schedules("ryu").unwrap();
        let disabled = store::load_job(&original.id).unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.name, changed.name);
        assert_eq!(disabled.schedule, changed.schedule);
        assert_eq!(disabled.target, changed.target);
        assert_eq!(disabled.history.len(), 1);
        let mut retargeted = disabled.clone();
        retargeted.enabled = true;
        retargeted.target = store::JobTarget::IdentityHealth;
        let retargeted = store::update_job_if_current(disabled, retargeted)
            .await
            .unwrap();
        store::disable_job_if_target(&original.id, &original.target).unwrap();
        let saved = store::load_job(&original.id).unwrap();
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(&retargeted).unwrap()
        );
        h.readback(&saved).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_actual_mcp_update_preserves_authoritative_history_and_refuses_other_owner() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (_, body) = h.create("Before MCP", false, None).await;
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let claim = store::capture_execution(&original).await.unwrap();
        assert!(store::append_execution_claim(claim, completion_record("before-mcp")).await.unwrap());
        let updated = crate::sidecar::mcp::routines_tool::dispatch(
            "update", json!({"job_id": original.id, "name": "MCP acknowledged", "schedule": {"kind":"every", "interval":"3h"}}),
            &crate::sidecar::mcp::ToolPrincipal::Unrestricted,
            Some(&h.state.agent_store), Some(&h.state.conversations), Some("ryu"), None, None,
        ).await.unwrap();
        assert_eq!(updated["ok"], true);
        let acknowledged: ScheduledJob = serde_json::from_value(updated["routine"].clone()).unwrap();
        assert_eq!(acknowledged.name, "MCP acknowledged");
        assert_eq!(acknowledged.created_at, original.created_at);
        assert_eq!(acknowledged.history.len(), 1);
        assert_eq!(acknowledged.history[0].run_id.as_deref(), Some("before-mcp"));
        h.readback(&acknowledged).await;
        let denied = crate::sidecar::mcp::routines_tool::dispatch(
            "update", json!({"job_id":original.id, "name":"Unauthorized"}),
            &crate::sidecar::mcp::ToolPrincipal::Owned { user_id: "other-user".into(), org_id: None },
            Some(&h.state.agent_store), Some(&h.state.conversations), Some("ryu"), None, None,
        ).await.unwrap_err();
        assert_eq!(denied.to_string(), format!("routine '{}' is not owned by this agent's user", original.id));
        h.readback(&acknowledged).await;
    }).await;
}
