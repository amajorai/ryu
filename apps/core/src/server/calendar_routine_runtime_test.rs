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

fn completion_record(run_id: &str) -> store::ExecRecord {
    store::ExecRecord {
        started_at: "2026-10-06T01:00:00Z".into(),
        finished_at: "2026-10-06T01:01:00Z".into(),
        outcome: store::ExecOutcome::Success,
        run_id: Some(run_id.into()),
        error: None,
    }
}

mod refusals_test;
mod workflows_test;
