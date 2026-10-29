//! Box runs: waivers, park kills, stop retries, warn hooks and size attribution.

use super::*;

#[tokio::test]
async fn heartbeat_a_waived_resume_tells_the_gateway_on_every_tick_and_the_tail() {
    use crate::test_http::{json_response, request_body, ScriptedServer};
    let _cycle = shared_metering_cycle();
    let waived = format!("run_waived_{}", uuid::Uuid::new_v4().simple());
    insert_waived_box_run(&waived, BoxSize::Default);
    let charged = format!("run_charged_{}", uuid::Uuid::new_v4().simple());
    insert_box_run(&charged, BoxSize::Default, KillAction::Destroy);
    let server = ScriptedServer::start(|_index, _request| {
        Some(json_response(
            200,
            r#"{"verdict":"continue","accrued_micro_usd":1}"#,
        ))
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    deliver_tick(job_for(&waived, 0), &endpoint, Ok("bearer".into())).await;
    deliver_tick(job_for(&charged, 0), &endpoint, Ok("bearer".into())).await;
    let requests = server.finish();
    let sent: serde_json::Value = serde_json::from_str(request_body(&requests[0])).unwrap();
    assert_eq!(sent["minimum_waiver"], WAIVER);
    assert!(sent.get("minimum_waived").is_none());
    assert_eq!(sent["elapsed_seconds_total"], 10);
    // Any other start sends no flag: the Gateway applies the minimum,
    // exactly as for a Core that predates the waiver.
    let other: serde_json::Value = serde_json::from_str(request_body(&requests[1])).unwrap();
    assert!(other.get("minimum_waiver").is_none());

    let residual = deregister_for_final_debit(&waived).expect("live run");
    assert_eq!(residual.minimum_waiver.as_deref(), Some(WAIVER));
    let tail = final_debit_body(
        &waived,
        Some("org_box"),
        &crate::box_types::spec_for(BoxSize::Default),
        4,
        0,
        &residual,
    );
    assert_eq!(
        tail["minimum_waiver"], WAIVER,
        "the tail is priced like the ticks"
    );
    let charged_residual = deregister_for_final_debit(&charged).expect("live run");
    let charged_tail = final_debit_body(
        &charged,
        Some("org_box"),
        &crate::box_types::spec_for(BoxSize::Default),
        4,
        0,
        &charged_residual,
    );
    assert!(charged_tail.get("minimum_waiver").is_none());

    // A generic (non-Box) run never carries the flag, even if set.
    let generic = format!("run_generic_waived_{}", uuid::Uuid::new_v4().simple());
    insert_run(
        generic.clone(),
        None,
        "daytona".into(),
        WorkspaceId("ws".into()),
        sample_spec(),
        0,
        RunOptions {
            minimum_waiver: Some(WAIVER.to_owned()),
            ..RunOptions::default()
        },
    );
    let generic_residual = deregister_for_final_debit(&generic).expect("live run");
    let generic_tail = final_debit_body(
        &generic,
        Some("org_1"),
        &sample_spec(),
        3,
        0,
        &generic_residual,
    );
    assert!(generic_tail.get("minimum_waiver").is_none());
}

#[tokio::test]
async fn heartbeat_park_is_invoked_on_kill_balance() {
    use crate::test_http::{json_response, ScriptedServer};
    let run_id = format!("run_park_{}", uuid::Uuid::new_v4().simple());
    let (action, calls) = counting_park(0);
    insert_box_run(&run_id, BoxSize::Small, action);
    let server = ScriptedServer::start(|_index, _request| {
        Some(json_response(
            200,
            r#"{"verdict":"kill_balance","accrued_micro_usd":500,"balance_micro_usd":-3}"#,
        ))
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    deliver_tick(job_for(&run_id, 0), &endpoint, Ok("bearer".into())).await;
    assert_eq!(*calls.lock().unwrap(), vec![KillReason::Balance]);
    assert!(
        run_snapshot(&run_id).is_none(),
        "a parked run stops metering"
    );
    let kill = kill_record(&run_id).expect("kill recorded");
    assert_eq!(kill.reason, KillReason::Balance);
    assert_eq!(kill.accrued_micro_usd, 500);
    assert_eq!(server.finish().len(), 1);
    lock_kills().remove(&run_id);
}

#[tokio::test]
async fn heartbeat_failing_park_is_retried_until_it_succeeds() {
    let run_id = format!("run_park_retry_{}", uuid::Uuid::new_v4().simple());
    let (action, calls) = counting_park(2);
    insert_box_run(&run_id, BoxSize::Default, action);
    let job = job_for(&run_id, 3);
    enforce_kill_with(&job, KillReason::Budget, 7, |_| Duration::from_millis(20)).await;
    assert_eq!(
        calls.lock().unwrap().len(),
        1,
        "the first attempt runs inline"
    );
    let snapshot = run_snapshot(&run_id).expect("still metered while stopping");
    assert!(snapshot.stopping);
    // A second kill verdict while the stop is retried starts nothing new.
    enforce_kill_with(&job, KillReason::Budget, 7, |_| Duration::from_millis(20)).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while kill_record(&run_id).is_none() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        kill_record(&run_id).map(|kill| kill.reason),
        Some(KillReason::Budget)
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec![KillReason::Budget, KillReason::Budget, KillReason::Budget]
    );
    assert!(run_snapshot(&run_id).is_none());
    lock_kills().remove(&run_id);
}

#[tokio::test]
async fn heartbeat_stop_retries_end_when_the_owner_unregisters() {
    let run_id = format!("run_park_gone_{}", uuid::Uuid::new_v4().simple());
    let (action, calls) = counting_park(usize::MAX);
    insert_box_run(&run_id, BoxSize::Small, action);
    let job = job_for(&run_id, 0);
    enforce_kill_with(&job, KillReason::Balance, 0, |_| Duration::from_millis(20)).await;
    unregister(&run_id);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert!(kill_record(&run_id).is_none());
}

#[tokio::test]
async fn heartbeat_stale_stop_retry_never_acts_on_a_re_registered_run() {
    // A kill verdict's park fails, then the owner parks the Box itself
    // and resumes it under the same run id before the retry wakes.
    let run_id = format!("run_park_resumed_{}", uuid::Uuid::new_v4().simple());
    let (action, calls) = counting_park(usize::MAX);
    insert_box_run(&run_id, BoxSize::Small, action);
    let job = job_for(&run_id, 0);
    enforce_kill_with(&job, KillReason::Balance, 0, |_| Duration::from_millis(40)).await;
    assert_eq!(calls.lock().unwrap().len(), 1);
    unregister(&run_id);
    let (fresh, fresh_calls) = counting_park(0);
    insert_box_run(&run_id, BoxSize::Small, fresh);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        calls.lock().unwrap().len(),
        1,
        "the stale retry stops once the id names a new run"
    );
    assert!(fresh_calls.lock().unwrap().is_empty());
    let snapshot = run_snapshot(&run_id).expect("the resumed run keeps metering");
    assert!(!snapshot.stopping);
    assert!(kill_record(&run_id).is_none());
    // A late confirmation of the old kill does not end the new run.
    record_kill_if_stopped(&job, KillReason::Balance, 0, true);
    assert!(run_snapshot(&run_id).is_some());
    assert!(kill_record(&run_id).is_none());
    unregister(&run_id);
}

#[tokio::test]
async fn heartbeat_warn_balance_and_rate_are_recorded_and_hooked() {
    use crate::test_http::{json_response, ScriptedServer};
    let run_id = format!("run_warn_{}", uuid::Uuid::new_v4().simple());
    insert_box_run(&run_id, BoxSize::Small, KillAction::Destroy);
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    on_tick_accepted(
        run_id.clone(),
        Arc::new(move |accepted| {
            let sender = sender.clone();
            Box::pin(async move {
                let _ = sender.send(accepted);
            })
        }),
    );
    let server = ScriptedServer::start(|index, _request| {
        Some(json_response(
            200,
            if index == 0 {
                r#"{"verdict":"warn","accrued_micro_usd":900,"balance_micro_usd":1500,"rate_micro_usd_per_hour":25000}"#
            } else {
                r#"{"verdict":"continue","accrued_micro_usd":960,"balance_micro_usd":1440}"#
            },
        ))
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    deliver_tick(job_for(&run_id, 4), &endpoint, Ok("bearer".into())).await;
    let snapshot = run_snapshot(&run_id).unwrap();
    assert_eq!(snapshot.last_verdict, Some(Verdict::Warn));
    assert_eq!(snapshot.balance_micro_usd, Some(1500));
    assert_eq!(snapshot.rate_micro_usd_per_hour, Some(25_000));
    assert_eq!(snapshot.accrued_micro_usd, 900);
    assert_eq!(snapshot.size, Some(BoxSize::Small));
    let accepted = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        accepted,
        TickAccepted {
            run_id: run_id.clone(),
            box_id: Some("bx_0123456789abcdef0123456789abcdef".into()),
            tick_index: 4,
            accrued_micro_usd: 900,
            balance_micro_usd: Some(1500),
            verdict: Verdict::Warn,
        }
    );
    deliver_tick(job_for(&run_id, 5), &endpoint, Ok("bearer".into())).await;
    let snapshot = run_snapshot(&run_id).unwrap();
    assert_eq!(snapshot.last_verdict, Some(Verdict::Continue));
    assert_eq!(
        snapshot.rate_micro_usd_per_hour,
        Some(25_000),
        "a response without a rate keeps the last one"
    );
    let serialized = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(serialized["last_verdict"], "continue");
    assert_eq!(serialized["size"], "small");
    unregister(&run_id);
    assert!(lock_callbacks().get(&run_id).is_none());
    server.finish();
}

#[tokio::test]
async fn heartbeat_large_box_ticks_with_its_own_spec_whatever_the_env_says() {
    use crate::test_http::{json_response, request_body, ScriptedServer};
    let _cycle = shared_metering_cycle();
    let _env_lock = crate::box_backend::test_env::lock_box_env().await;
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var(crate::box_backend::ENV_BOX_SIZE, value),
                None => std::env::remove_var(crate::box_backend::ENV_BOX_SIZE),
            }
        }
    }
    let _restore = Restore(std::env::var(crate::box_backend::ENV_BOX_SIZE).ok());
    std::env::set_var(crate::box_backend::ENV_BOX_SIZE, "small");
    let run_id = format!("run_large_{}", uuid::Uuid::new_v4().simple());
    insert_box_run(&run_id, BoxSize::Large, KillAction::Destroy);
    let generic_id = format!("run_generic_{}", uuid::Uuid::new_v4().simple());
    insert_run(
        generic_id.clone(),
        None,
        "daytona".into(),
        WorkspaceId("ws".into()),
        sample_spec(),
        0,
        RunOptions::default(),
    );
    let server = ScriptedServer::start(|_index, _request| {
        Some(json_response(
            200,
            r#"{"verdict":"continue","accrued_micro_usd":1}"#,
        ))
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    deliver_tick(job_for(&run_id, 0), &endpoint, Ok("bearer".into())).await;
    deliver_tick(job_for(&generic_id, 0), &endpoint, Ok("bearer".into())).await;
    let requests = server.finish();
    let sent: serde_json::Value = serde_json::from_str(request_body(&requests[0])).unwrap();
    assert_eq!(sent["spec"]["vcpu"], 8);
    assert_eq!(sent["spec"]["mem_gib"], 16);
    assert_eq!(sent["spec"]["storage_gib"], 100);
    assert_eq!(sent["size"], "large");
    assert_eq!(sent["box_id"], "bx_0123456789abcdef0123456789abcdef");
    // The run's total lets the Gateway price the tick from the body alone.
    assert_eq!(sent["elapsed_seconds_total"], 10);
    let generic: serde_json::Value = serde_json::from_str(request_body(&requests[1])).unwrap();
    assert!(generic.get("size").is_none());
    assert!(generic.get("box_id").is_none());
    assert!(generic.get("elapsed_seconds_total").is_none());
    unregister(&run_id);
    unregister(&generic_id);
}

#[tokio::test]
async fn heartbeat_final_debit_carries_the_box_size_and_id_like_the_ticks() {
    use crate::test_http::{json_response, request_body, ScriptedServer};
    let run_id = format!("run_tail_{}", uuid::Uuid::new_v4().simple());
    insert_box_run(&run_id, BoxSize::Small, KillAction::Destroy);
    let residual = deregister_for_final_debit(&run_id).expect("live run");
    assert_eq!(residual.size, Some(BoxSize::Small));
    assert_eq!(
        residual.box_id.as_deref(),
        Some("bx_0123456789abcdef0123456789abcdef")
    );
    let tail = final_debit_body(
        &run_id,
        Some("org_box"),
        &crate::box_types::spec_for(BoxSize::Small),
        7,
        0,
        &residual,
    );
    let server = ScriptedServer::start(|_index, _request| {
        Some(json_response(
            200,
            r#"{"verdict":"continue","accrued_micro_usd":49}"#,
        ))
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    send_final_debit(&endpoint, "bearer", &run_id, 7, &tail)
        .await
        .expect("final debit confirmed");
    let requests = server.finish();
    let sent: serde_json::Value = serde_json::from_str(request_body(&requests[0])).unwrap();
    assert_eq!(sent["size"], "small", "the tail is priced at the size rate");
    assert_eq!(
        sent["box_id"], "bx_0123456789abcdef0123456789abcdef",
        "the tail's ledger row is labelled box:<id> for reconcile"
    );
    assert_eq!(sent["elapsed_seconds_delta"], 7);
    assert_eq!(sent["tick_index"], residual.next_tick_index);
    assert_eq!(
        sent["elapsed_seconds_total"],
        residual.ticked_seconds + 7,
        "the tail is priced on the run's total, like its ticks"
    );

    // A generic sandbox run's tail keeps the unchanged wire.
    let generic_id = format!("run_generic_tail_{}", uuid::Uuid::new_v4().simple());
    insert_run(
        generic_id.clone(),
        None,
        "daytona".into(),
        WorkspaceId("ws".into()),
        sample_spec(),
        0,
        RunOptions::default(),
    );
    let generic = deregister_for_final_debit(&generic_id).expect("live run");
    assert_eq!((generic.size, generic.box_id.as_deref()), (None, None));
    let generic_tail = final_debit_body(&generic_id, Some("org_1"), &sample_spec(), 3, 0, &generic);
    assert!(generic_tail.get("size").is_none());
    assert!(generic_tail.get("box_id").is_none());
    assert!(generic_tail.get("elapsed_seconds_total").is_none());
}

#[test]
fn heartbeat_kill_retry_schedule_and_reasons() {
    let delays: Vec<u64> = (1..=6).map(|n| kill_retry_delay(n).as_secs()).collect();
    assert_eq!(delays, vec![1, 5, 30, 60, 60, 60]);
    assert_eq!(KillReason::Balance.park_reason(), ParkReason::Balance);
    assert_eq!(KillReason::Budget.park_reason(), ParkReason::Budget);
    assert_eq!(KillReason::Accounting.park_reason(), ParkReason::Balance);
    assert_eq!(KillReason::Accounting.as_str(), "accounting");
    assert_eq!(format!("{:?}", KillAction::default()), "Destroy");
}
