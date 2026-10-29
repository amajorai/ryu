//! Exercise the actual approved scheduled action writer without provider execution.
use super::*;
use crate::scheduler::store::{self, JobTarget, Schedule, ScheduledJob};

#[tokio::test]
async fn approved_routine_failure_is_durably_recorded_and_deleted_action_does_not_execute() {
    let directory = tempfile::tempdir().unwrap();
    let jobs = directory.path().join("jobs");
    let engine = ApprovalEngine::new(
        ApprovalStore::open(directory.path().join("approvals.db")).unwrap(),
        reqwest::Client::new(),
    );
    store::with_test_jobs_directory(jobs.clone(), async {
        let workflow_id = format!("missing-approved-{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().to_rfc3339();
        let job = ScheduledJob {
            id: "approved-recording".into(),
            name: "Approved workflow".into(),
            schedule: Schedule::Every {
                interval: "1h".into(),
            },
            target: JobTarget::Workflow {
                workflow_id: workflow_id.clone(),
                input: Default::default(),
            },
            enabled: true,
            require_approval: true,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: now.clone(),
            updated_at: now,
            last_run_at: None,
            last_outcome: None,
            history: vec![],
        };
        store::save_job(&job).unwrap();
        let action = PendingAction::ScheduledJob {
            target: job.target.clone(),
            job_id: Some(job.id.clone()),
        };
        let error = engine.execute_action(&action).await.unwrap_err();
        let expected_error = format!("workflow '{workflow_id}' not found");
        assert_eq!(error.to_string(), expected_error);
        let saved = store::load_job(&job.id).unwrap();
        assert_eq!(saved.history.len(), 1);
        assert_eq!(saved.history[0].outcome, store::ExecOutcome::Failure);
        assert_eq!(
            saved.history[0].error.as_deref(),
            Some(expected_error.as_str())
        );
        assert_eq!(saved.last_outcome, Some(store::ExecOutcome::Failure));
        assert_eq!(
            saved.last_run_at.as_deref(),
            Some(saved.history[0].finished_at.as_str())
        );
        let reopened: ScheduledJob = store::read_job_for_test(&jobs, &job.id);
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(&reopened).unwrap()
        );
        assert!(store::delete_job(&job.id).unwrap());
        assert_eq!(
            engine
                .execute_action(&action)
                .await
                .unwrap_err()
                .to_string(),
            format!("scheduled routine '{}' no longer exists", job.id)
        );
        assert!(store::list_jobs().is_empty());
        assert!(!jobs.join(format!("{}.json", job.id)).exists());
        assert_eq!(
            std::fs::read(jobs.join(".job-locks").join(format!("{}.deleted", job.id))).unwrap(),
            b"deleted"
        );
    })
    .await;
}

#[tokio::test]
async fn approved_routine_retarget_and_prompt_change_refuse_before_execution_or_history_write() {
    let directory = tempfile::tempdir().unwrap();
    let jobs = directory.path().join("jobs");
    let engine = ApprovalEngine::new(
        ApprovalStore::open(directory.path().join("approvals.db")).unwrap(),
        reqwest::Client::new(),
    );
    store::with_test_jobs_directory(jobs.clone(), async {
        let agent_id = format!("unconfigured-approved-{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().to_rfc3339();
        let original = ScheduledJob {
            id: "approved-target-fence".into(),
            name: "Approved instructions".into(),
            schedule: Schedule::Every {
                interval: "1h".into(),
            },
            target: JobTarget::Agent {
                agent_id: agent_id.clone(),
                prompt: "Read the approved report".into(),
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: true,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: now.clone(),
            updated_at: now,
            last_run_at: None,
            last_outcome: None,
            history: vec![],
        };
        store::save_job(&original).unwrap();
        let action = PendingAction::ScheduledJob {
            target: original.target.clone(),
            job_id: Some(original.id.clone()),
        };
        let mut unrelated = original.clone();
        unrelated.id = "unrelated-approved-target".into();
        store::save_job(&unrelated).unwrap();
        let unrelated_path = jobs.join(format!("{}.json", unrelated.id));
        let unrelated_bytes = std::fs::read(&unrelated_path).unwrap();
        // Neither replacement authorizes the parked action: changing the engine
        // target and changing only a prompt both require a fresh approval.
        for target in [
            JobTarget::Workflow {
                workflow_id: format!("unconfigured-retarget-{}", uuid::Uuid::new_v4()),
                input: Default::default(),
            },
            JobTarget::Agent {
                agent_id,
                prompt: "Different unapproved instructions".into(),
                model: None,
                conversation_id: None,
            },
        ] {
            let current = store::load_job(&original.id).unwrap();
            let mut changed = current.clone();
            changed.target = target;
            let acknowledged = store::update_job_if_current(current, changed)
                .await
                .unwrap();
            let path = jobs.join(format!("{}.json", original.id));
            let before = std::fs::read(&path).unwrap();
            let error = engine.execute_action(&action).await.unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "scheduled routine '{}' target changed since approval; request a new approval",
                    original.id
                )
            );
            // Execution errors are recorded by this action. No record here plus
            // the precise approval refusal proves that no target was handed off.
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(std::fs::read(&unrelated_path).unwrap(), unrelated_bytes);
            let reopened: ScheduledJob = store::decode_job_for_test(&original.id, &before);
            assert_eq!(
                serde_json::to_value(&reopened).unwrap(),
                serde_json::to_value(&acknowledged).unwrap()
            );
            assert!(reopened.history.is_empty());
            assert!(reopened.last_run_at.is_none());
            assert!(reopened.last_outcome.is_none());
            assert!(!jobs
                .join(".job-locks")
                .join(format!("{}.generation", original.id))
                .exists());
        }
    })
    .await;
}
