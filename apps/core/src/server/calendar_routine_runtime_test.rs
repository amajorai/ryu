//! Actual routine handlers and file persistence. No scheduler tick/provider runs.
//! Managed-node/JWT policy is separate; these tests never mutate node globals.
use super::*;
use crate::scheduler::store::{self, JobTarget, ScheduledJob};
use axum::extract::{Extension, Path, State};
use serde_json::{json, Value};

struct Harness {
    directory: tempfile::TempDir,
    jobs: std::path::PathBuf,
    state: ServerState,
}

impl Harness {
    fn new() -> Self {
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_node().is_none());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let jobs = directory.path().join("jobs");
        let mut state = isolated_plugin_hook_test_state(directory.path());
        state.agent_store =
            crate::agents::AgentStore::open_approval_test_file(&directory.path().join("agents.db"))
                .unwrap();
        Self {
            directory,
            jobs,
            state,
        }
    }

    async fn create(
        &self,
        name: &str,
        quick: bool,
        conversation: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut target = json!({"type":"agent","agent_id":"ryu","prompt":"Run"});
        if let Some(conversation) = conversation {
            target["conversation_id"] = conversation;
        }
        self.create_input(json!({"name":name,"schedule":{"kind":"every","interval":"1h"},"target":target,"enabled":true,"require_approval":true,"quick_routine":quick})).await
    }

    async fn create_input(&self, input: Value) -> (StatusCode, Value) {
        let (status, Json(body)) = create_job(
            State(self.state.clone()),
            Extension(None),
            Json(serde_json::from_value(input).unwrap()),
        )
        .await;
        (status, body)
    }

    async fn readback(&self, expected: &ScheduledJob) {
        let (status, Json(body)) = get_job(
            State(self.state.clone()),
            Extension(None),
            Path(expected.id.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["job"], serde_json::to_value(expected).unwrap());
        let fresh: ScheduledJob = store::read_job_for_test(&self.jobs, &expected.id);
        assert_eq!(serde_json::to_value(fresh).unwrap(), body["job"]);
    }
}

#[tokio::test]
async fn calendar_quick_routine_concurrent_create_rename_and_generic_jobs_keep_one_slot() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (first, second) = tokio::join!(
            h.create("Before (scheduled)", true, None),
            h.create("Before (scheduled)", true, None)
        );
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(second.0, StatusCode::OK);
        assert_eq!(first.1["job"]["id"], second.1["job"]["id"]);
        assert_eq!(store::list_jobs().len(), 1);
        let original: ScheduledJob = serde_json::from_value(first.1["job"].clone()).unwrap();
        let mut with_history = original.clone();
        with_history.history.push(store::ExecRecord {
            started_at: "before".into(),
            finished_at: "after".into(),
            outcome: store::ExecOutcome::Success,
            run_id: Some("prior-run".into()),
            error: None,
        });
        store::append_execution(&original.id, with_history.history[0].clone()).unwrap();
        let (status, renamed) = h.create("Renamed (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let renamed: ScheduledJob = serde_json::from_value(renamed["job"].clone()).unwrap();
        assert_eq!(renamed.id, original.id);
        assert_eq!(renamed.created_at, original.created_at);
        assert_eq!(
            serde_json::to_value(&renamed.history).unwrap(),
            serde_json::to_value(&with_history.history).unwrap()
        );
        for _ in 0..2 {
            assert_eq!(h.create("Independent", false, None).await.0, StatusCode::OK);
        }
        assert_eq!(store::list_jobs().len(), 3);
        h.readback(&renamed).await;
    })
    .await;
}

#[tokio::test]
async fn calendar_quick_routine_legacy_destination_preserved_null_clears_and_ambiguous_refuses() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, original) = h.create("Legacy (scheduled)", false, None).await;
        assert_eq!(status, StatusCode::OK);
        let mut original: ScheduledJob = serde_json::from_value(original["job"].clone()).unwrap();
        h.state
            .conversations
            .ensure_conversation(
                "existing-durable-destination",
                None,
                Some("Routine history"),
                conversations::Tenancy::Unattributed,
            )
            .await
            .unwrap();
        // The omitted destination must preserve the actual stored transcript.
        let JobTarget::Agent {
            conversation_id, ..
        } = &mut original.target
        else {
            panic!("agent target");
        };
        *conversation_id = Some("existing-durable-destination".into());
        store::save_job(&original).unwrap();
        let (status, retained) = h.create("Renamed (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(retained["job"]["id"], original.id);
        assert_eq!(
            retained["job"]["target"]["conversation_id"],
            "existing-durable-destination"
        );
        let (status, cleared) = h
            .create("Renamed again (scheduled)", true, Some(Value::Null))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(cleared["job"]["target"].get("conversation_id").is_none());
        h.readback(&serde_json::from_value(cleared["job"].clone()).unwrap())
            .await;
        // A separate directory demonstrates ambiguous legacy adoption, without
        // clearing this already established slot.
        let ambiguous = h.directory.path().join("ambiguous");
        store::with_test_jobs_directory(ambiguous.clone(), async {
            h.create("First (scheduled)", false, None).await;
            h.create("Second (scheduled)", false, None).await;
            let before = serde_json::to_value(store::list_jobs()).unwrap();
            let (status, body) = h.create("Reviewed (scheduled)", true, None).await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(
                body,
                json!({"success":false,"error":"multiple legacy quick routines require review"})
            );
            assert_eq!(serde_json::to_value(store::list_jobs()).unwrap(), before);
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn calendar_quick_routine_invalid_target_and_corrupt_slot_refuse_without_job_writes() {
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let inactive = h.state.agent_store.create(crate::agents::CreateAgent { name: "Inactive".into(), ..Default::default() }).await.unwrap();
        let (status, body) = h.create_input(json!({"name":"Inactive routine","quick_routine":true,"schedule":{"kind":"every","interval":"1h"},"target":{"type":"agent","agent_id":inactive.id,"prompt":"Run"}})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"success":false,"error":"agent 'Inactive' is in trial mode and cannot have an enabled automation"}));
        assert!(!h.jobs.exists());
        for (target, error) in [
            (json!({"type":"agent","agent_id":"unknown","prompt":"Run"}), "agent 'unknown' not found"),
            (json!({"type":"agent","agent_id":"ryu","prompt":"Run","conversation_id":"missing-chat"}), "conversation 'missing-chat' not found"),
        ] {
            let (status, body) = h.create_input(json!({"name":"Reviewed","quick_routine":true,"schedule":{"kind":"every","interval":"1h"},"target":target})).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body, json!({"success":false,"error":error}));
            assert!(!h.jobs.exists(), "validation must precede durable slot intent");
        }
        let (status, body) = h.create("Accepted (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let pointer = std::fs::read_dir(h.jobs.join(".quick-routines")).unwrap()
            .map(|entry| entry.unwrap().path()).find(|path| path.extension().is_some_and(|extension| extension == "json")).unwrap();
        let valid = std::fs::read(&pointer).unwrap();
        std::fs::write(&pointer, b"{invalid").unwrap();
        let (status, body) = h.create("Refused (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["success"], false);
        assert!(body["error"].as_str().unwrap().contains("key must be a string"));
        h.readback(&original).await;
        assert_eq!(store::list_jobs().len(), 1);
        std::fs::write(pointer, valid).unwrap();
        let (status, body) = h.create("Retry (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["job"]["id"], original.id);
    }).await;
}

#[cfg(unix)]
#[tokio::test]
async fn calendar_quick_routine_atomic_write_refusal_preserves_full_original_then_retry() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, body) = h.create("Original (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let (status, body) = h.create("Unrelated", false, None).await;
        assert_eq!(status, StatusCode::OK);
        let unrelated: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        struct Restore(std::path::PathBuf, std::fs::Permissions);
        impl Drop for Restore {
            fn drop(&mut self) {
                std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
            }
        }
        let restore = Restore(
            h.jobs.clone(),
            std::fs::metadata(&h.jobs).unwrap().permissions(),
        );
        std::fs::set_permissions(&h.jobs, std::fs::Permissions::from_mode(0o555)).unwrap();
        let refused = h
            .create("Refused replacement (scheduled)", true, None)
            .await;
        drop(restore);
        assert_eq!(
            refused.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "requires a non-root test process"
        );
        h.readback(&original).await;
        h.readback(&unrelated).await;
        let (status, body) = h.create("Retry (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["job"]["id"], original.id);
        let retry: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        h.readback(&retry).await;
        h.readback(&unrelated).await;
        assert_eq!(store::list_jobs().len(), 2);
        let pending_directory = h.directory.path().join("pending-intent");
        std::fs::create_dir_all(pending_directory.join(".quick-routines")).unwrap();
        std::fs::create_dir_all(pending_directory.join(".job-locks")).unwrap();
        store::with_test_jobs_directory(pending_directory.clone(), async {
            let restore = Restore(
                pending_directory.clone(),
                std::fs::metadata(&pending_directory).unwrap().permissions(),
            );
            std::fs::set_permissions(&pending_directory, std::fs::Permissions::from_mode(0o555))
                .unwrap();
            let refused = h.create("New intent (scheduled)", true, None).await;
            drop(restore);
            assert_eq!(refused.0, StatusCode::INTERNAL_SERVER_ERROR);
            assert!(store::list_jobs().is_empty());
            let pointer = std::fs::read_dir(pending_directory.join(".quick-routines"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
                .unwrap();
            let intent: Value = store::read_quick_routine_pointer_for_test(&pointer);
            let (status, retried) = h.create("New intent retry (scheduled)", true, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(retried["job"]["id"], intent["id"]);
            assert_eq!(store::list_jobs().len(), 1);
        })
        .await;
    })
    .await;
}

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

#[cfg(unix)]
#[tokio::test]
async fn calendar_delete_marker_and_unlink_refusals_are_fail_closed_and_retryable() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (status, body) = h.create("Original (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        struct Restore(std::path::PathBuf, std::fs::Permissions);
        impl Drop for Restore {
            fn drop(&mut self) {
                std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
            }
        }
        let locks = h.jobs.join(".job-locks");
        let restore = Restore(
            locks.clone(),
            std::fs::metadata(&locks).unwrap().permissions(),
        );
        std::fs::set_permissions(&locks, std::fs::Permissions::from_mode(0o555)).unwrap();
        let response = delete_job(
            State(h.state.clone()),
            Extension(None),
            Path(original.id.clone()),
        )
        .await;
        drop(restore);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        h.readback(&original).await;
        assert!(!locks.join(format!("{}.deleted", original.id)).exists());
        let response = delete_job(
            State(h.state.clone()),
            Extension(None),
            Path(original.id.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!h.jobs.join(format!("{}.json", original.id)).exists());
        let (status, body) = h.create("Fresh (scheduled)", true, None).await;
        assert_eq!(status, StatusCode::OK);
        let fresh: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let live_path = h.jobs.join(format!("{}.json", fresh.id));
        let full_before = std::fs::read(&live_path).unwrap();
        let restore = Restore(
            h.jobs.clone(),
            std::fs::metadata(&h.jobs).unwrap().permissions(),
        );
        std::fs::set_permissions(&h.jobs, std::fs::Permissions::from_mode(0o555)).unwrap();
        let response = delete_job(
            State(h.state.clone()),
            Extension(None),
            Path(fresh.id.clone()),
        )
        .await;
        drop(restore);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(std::fs::read(&live_path).unwrap(), full_before);
        assert_eq!(
            std::fs::read(locks.join(format!("{}.deleted", fresh.id))).unwrap(),
            b"deleted"
        );
        assert!(store::list_jobs().is_empty());
        assert_eq!(
            store::load_job(&fresh.id).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        // Completion cannot resurrect or overwrite the retained file, which is
        // awaiting an authorized retry of the physical removal.
        store::append_execution(
            &fresh.id,
            store::ExecRecord {
                started_at: "started".into(),
                finished_at: "finished".into(),
                outcome: store::ExecOutcome::Success,
                run_id: None,
                error: None,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&live_path).unwrap(), full_before);
        let response = delete_job(
            State(h.state.clone()),
            Extension(None),
            Path(fresh.id.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!live_path.exists());
    })
    .await;
}

fn completion_record(run_id: &str) -> store::ExecRecord {
    store::ExecRecord {
        started_at: "2026-10-06T01:00:00Z".into(),
        finished_at: "2026-10-06T01:01:00Z".into(),
        outcome: store::ExecOutcome::Success,
        run_id: Some(run_id.into()),
        error: None,
    }
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

#[cfg(unix)]
#[tokio::test]
async fn calendar_refused_authoritative_recreation_retains_minimal_marker_and_retry_identity() {
    use std::os::unix::fs::PermissionsExt;
    struct Restore(std::path::PathBuf, std::fs::Permissions);
    impl Drop for Restore {
        fn drop(&mut self) {
            std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }
    let h = Harness::new();
    store::with_test_jobs_directory(h.jobs.clone(), async {
        let (_, body) = h.create("Original", false, None).await;
        let original: ScheduledJob = serde_json::from_value(body["job"].clone()).unwrap();
        let (_, unrelated_body) = h.create("Unrelated", false, None).await;
        let unrelated: ScheduledJob =
            serde_json::from_value(unrelated_body["job"].clone()).unwrap();
        let old_claim = store::capture_execution(&original).await.unwrap();
        assert!(store::delete_job(&original.id).unwrap());
        let locks = h.jobs.join(".job-locks");
        let marker = locks.join(format!("{}.deleted", original.id));
        let intent_path = locks.join(format!("{}.recreate", original.id));
        let restore = Restore(
            h.jobs.clone(),
            std::fs::metadata(&h.jobs).unwrap().permissions(),
        );
        std::fs::set_permissions(&h.jobs, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut intended = original.clone();
        intended.name = "Authoritative new definition".into();
        assert!(store::recreate_authoritative_job(&intended).is_err());
        assert_eq!(std::fs::read(&marker).unwrap(), b"deleted");
        let intent: Value = serde_json::from_slice(&std::fs::read(&intent_path).unwrap()).unwrap();
        assert_eq!(intent.as_object().unwrap().len(), 2);
        assert!(intent["generation"].as_str().unwrap().len() > 1);
        assert!(store::load_job(&original.id).is_err());
        assert!(!store::append_execution_claim(
            old_claim,
            completion_record("old-refused-generation")
        )
        .await
        .unwrap());
        drop(restore);
        store::recreate_authoritative_job(&intended).unwrap();
        let saved = store::load_job(&original.id).unwrap();
        assert_eq!(saved.name, intended.name);
        assert_eq!(saved.created_at, intent["created_at"].as_str().unwrap());
        assert_eq!(
            std::fs::read_to_string(locks.join(format!("{}.generation", original.id))).unwrap(),
            intent["generation"].as_str().unwrap()
        );
        assert!(!marker.exists());
        assert!(!intent_path.exists());
        assert!(saved.history.is_empty());
        h.readback(&saved).await;
        h.readback(&unrelated).await;
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
