//! Calendar routine writes refused by the filesystem fail closed and retry cleanly.

use super::*;

#[cfg(unix)]
#[tokio::test]
async fn calendar_quick_routine_atomic_write_refusal_preserves_full_original_then_retry() {
    // These refusals are simulated with read-only directories, which root
    // ignores (as in dev_execution's protected-host test); nothing to prove there.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
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

#[cfg(unix)]
#[tokio::test]
async fn calendar_delete_marker_and_unlink_refusals_are_fail_closed_and_retryable() {
    // These refusals are simulated with read-only directories, which root
    // ignores (as in dev_execution's protected-host test); nothing to prove there.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
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

#[cfg(unix)]
#[tokio::test]
async fn calendar_refused_authoritative_recreation_retains_minimal_marker_and_retry_identity() {
    // These refusals are simulated with read-only directories, which root
    // ignores (as in dev_execution's protected-host test); nothing to prove there.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
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
