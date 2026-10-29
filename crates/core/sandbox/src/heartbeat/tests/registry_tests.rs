//! Registration, kill records and run completion.

use super::*;

#[test]
fn verdict_parsing_is_frozen() {
    assert_eq!(parse_verdict("continue"), Verdict::Continue);
    assert_eq!(parse_verdict("warn"), Verdict::Warn);
    assert_eq!(parse_verdict("kill_budget"), Verdict::KillBudget);
    assert_eq!(parse_verdict("kill_balance"), Verdict::KillBalance);
    assert_eq!(parse_verdict("kill_accounting"), Verdict::KillAccounting);
    // Unknown verdicts fail closed to an accounting kill.
    assert_eq!(parse_verdict("explode"), Verdict::KillAccounting);
}

#[test]
fn register_and_unregister_roundtrip() {
    let run_id = format!("run_test_{}", std::process::id());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        WorkspaceId("ws_1".to_owned()),
        sample_spec(),
        1_000_000,
    );
    assert!(lock_runs().contains_key(&run_id));
    unregister(&run_id);
    assert!(!lock_runs().contains_key(&run_id));
}

#[test]
fn re_registering_clears_stale_kill_record() {
    let run_id = format!("run_kill_{}", std::process::id());
    lock_kills().insert(
        run_id.clone(),
        KillRecord {
            run_id: run_id.clone(),
            reason: KillReason::Budget,
            accrued_micro_usd: 42,
        },
    );
    register(
        &run_id,
        None,
        "daytona",
        WorkspaceId("ws_2".to_owned()),
        sample_spec(),
        0,
    );
    assert!(
        kill_record(&run_id).is_none(),
        "re-register must clear stale kill"
    );
    unregister(&run_id);
}

#[test]
fn failed_remote_stop_keeps_metering_until_termination_is_confirmed() {
    let run_id = format!("run_stop_retry_{}", std::process::id());
    let workspace = WorkspaceId("provider-workspace-42".to_owned());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        workspace.clone(),
        sample_spec(),
        1_000_000,
    );
    let job = TickJob {
        run_id: run_id.clone(),
        generation: lock_runs().get(&run_id).map_or(0, |run| run.generation),
        org_id: Some("org_1".to_owned()),
        spec: sample_spec(),
        backend: "daytona".to_owned(),
        workspace,
        per_run_budget_micro_usd: 1_000_000,
        elapsed_seconds_delta: 60,
        tick_index: 0,
        kill_action: KillAction::Destroy,
        size: None,
        box_id: None,
        elapsed_seconds_total: 0,
        minimum_waiver: None,
    };
    assert!(!record_kill_if_stopped(
        &job,
        KillReason::Budget,
        100,
        false
    ));
    assert!(lock_runs().contains_key(&run_id));
    assert!(kill_record(&run_id).is_none());
    assert!(run_is_terminal(&run_id), "a failed stop is still terminal");
    assert!(record_kill_if_stopped(&job, KillReason::Budget, 100, true));
    assert!(!lock_runs().contains_key(&run_id));
    assert!(kill_record(&run_id).is_some());
    lock_kills().remove(&run_id);
    lock_pending_completions().remove(&run_id);
}

#[test]
fn a_kill_pending_run_is_never_ticked_again_and_retries_its_stop() {
    let _cycle = exclusive_metering_cycle();
    let run_id = format!("run_kill_pending_{}", uuid::Uuid::new_v4().simple());
    let workspace = WorkspaceId("provider-workspace-pending".to_owned());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        workspace.clone(),
        sample_spec(),
        100,
    );
    let tick_job = |index| job_for(&run_id, index);
    let later = Instant::now() + Duration::from_secs(10);
    let (jobs, retries) = snapshot_cycle(later);
    assert!(
        jobs.iter().any(|job| job.run_id == run_id),
        "a live run ticks"
    );
    assert!(!retries.iter().any(|retry| retry.job.run_id == run_id));

    // kill_budget at 120 against a cap of 100; the provider DELETE fails.
    record_kill_if_stopped(&tick_job(1), KillReason::Budget, 120, false);
    let index_at_kill = lock_runs().get(&run_id).map(|run| run.tick_index);
    let (jobs, retries) = snapshot_cycle(later + Duration::from_secs(10));
    assert!(
        !jobs.iter().any(|job| job.run_id == run_id),
        "a kill-pending run must not open a fresh Gateway accrual window"
    );
    let retry = retries
        .iter()
        .find(|retry| retry.job.run_id == run_id)
        .expect("the provider stop is retried every cycle");
    assert_eq!(retry.reason, KillReason::Budget);
    assert_eq!(retry.accrued, 120);
    assert_eq!(
        lock_runs().get(&run_id).map(|run| run.tick_index),
        index_at_kill,
        "no tick index is consumed while kill-pending"
    );

    // Normal unregister cannot silently drop a run whose stop is pending.
    unregister(&run_id);
    assert!(lock_runs().contains_key(&run_id));

    // A caller tearing the workspace down gets no residual to charge and
    // sees the kill.
    assert!(deregister_for_final_debit(&run_id).is_none());
    assert_eq!(
        kill_record(&run_id).map(|kill| kill.reason),
        Some(KillReason::Budget)
    );
    assert!(run_is_terminal(&run_id));
    lock_kills().remove(&run_id);
    lock_pending_completions().remove(&run_id);
}

#[tokio::test]
async fn completion_posts_the_run_id_and_retries_transient_failures() {
    use crate::test_http::{json_response, request_body, ScriptedServer};
    let server = ScriptedServer::start(|index, _request| {
        Some(if index == 0 {
            json_response(503, "{}")
        } else {
            json_response(200, r#"{"run_id":"run_done","removed":true}"#)
        })
    });
    let endpoint = format!("{}/sandbox/complete", server.base_url);
    post_completion(&endpoint, "bearer", "run_done")
        .await
        .expect("second attempt is confirmed");
    let requests = server.finish();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert!(
            request.starts_with("POST /sandbox/complete HTTP/1.1"),
            "{request}"
        );
        let sent: serde_json::Value =
            serde_json::from_str(request_body(request)).expect("completion body is JSON");
        assert_eq!(sent, json!({ "run_id": "run_done" }));
    }

    let refused = ScriptedServer::start(|_index, _request| Some(json_response(401, "{}")));
    let endpoint = format!("{}/sandbox/complete", refused.base_url);
    assert!(post_completion(&endpoint, "bearer", "run_done")
        .await
        .is_err());
    assert_eq!(refused.finish().len(), 1, "protocol errors are not retried");
}

#[tokio::test]
async fn a_failed_kill_stop_stays_terminal_until_a_retry_confirms_it() {
    use crate::daytona::{ENV_DAYTONA_TOKEN, ENV_DAYTONA_URL};
    use crate::test_http::ScriptedServer;
    let _env = crate::daytona::tests::lock_env();
    let _cycle = exclusive_metering_cycle();
    let server = ScriptedServer::start(|index, _request| {
        Some(if index == 0 {
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned()
        } else {
            "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_owned()
        })
    });
    let previous_url = std::env::var_os(ENV_DAYTONA_URL);
    let previous_token = std::env::var_os(ENV_DAYTONA_TOKEN);
    std::env::set_var(ENV_DAYTONA_URL, &server.base_url);
    std::env::set_var(ENV_DAYTONA_TOKEN, "mock-token");
    let run_id = uuid::Uuid::new_v4().to_string();
    let workspace = WorkspaceId("capped-workspace".into());
    register(
        &run_id,
        None,
        "daytona",
        workspace.clone(),
        sample_spec(),
        100,
    );
    let job = job_for(&run_id, 1);
    enforce_kill(&job, KillReason::Budget, 120).await;
    assert!(
        lock_runs().contains_key(&run_id),
        "failed stop keeps the run"
    );
    assert!(run_is_terminal(&run_id));
    let retry = snapshot_cycle(Instant::now() + Duration::from_secs(10))
        .1
        .into_iter()
        .find(|retry| retry.job.run_id == run_id)
        .expect("stop retry scheduled");
    retry_pending_stop(&retry.job, retry.reason, retry.accrued).await;
    let requests = server.finish();
    for (name, value) in [
        (ENV_DAYTONA_URL, previous_url),
        (ENV_DAYTONA_TOKEN, previous_token),
    ] {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert!(
            request.starts_with("DELETE /sandbox/capped-workspace HTTP/1.1"),
            "{request}"
        );
    }
    assert!(!lock_runs().contains_key(&run_id));
    assert_eq!(
        kill_record(&run_id).map(|kill| kill.accrued_micro_usd),
        Some(120)
    );
}
