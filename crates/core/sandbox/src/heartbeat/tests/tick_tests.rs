//! Tick failure grace, tick posting, budget kills and rate quotes.

use super::*;

#[test]
fn transient_tick_failures_get_a_bounded_grace() {
    let run_id = format!("run_grace_{}", uuid::Uuid::new_v4().simple());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        WorkspaceId("ws_grace".to_owned()),
        sample_spec(),
        1_000_000,
    );
    for expected in 1..=2 {
        let streak = note_tick_failure(&run_id).expect("run still registered");
        assert_eq!(streak.failures, expected);
        assert!(
            !tick_grace_exhausted(streak),
            "a transient streak below the limit keeps the run live"
        );
    }
    assert!(lock_runs().contains_key(&run_id));
    let third = note_tick_failure(&run_id).expect("run still registered");
    assert!(
        tick_grace_exhausted(third),
        "the third failure stops the run"
    );
    unregister(&run_id);
    assert_eq!(note_tick_failure(&run_id), None);
}

#[test]
fn a_parsed_tick_resets_the_failure_streak() {
    let run_id = format!("run_reset_{}", uuid::Uuid::new_v4().simple());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        WorkspaceId("ws_reset".to_owned()),
        sample_spec(),
        1_000_000,
    );
    note_tick_failure(&run_id);
    note_tick_failure(&run_id);
    note_tick_success(
        &run_id,
        TickReport {
            accrued: 42,
            verdict: Verdict::Continue,
            balance: None,
            rate: None,
        },
    );
    assert_eq!(
        lock_runs()
            .get(&run_id)
            .map(|run| (run.last_accrued_micro_usd, run.tick_failing_since)),
        Some((42, None))
    );
    assert_eq!(
        note_tick_failure(&run_id).map(|streak| streak.failures),
        Some(1)
    );
    unregister(&run_id);
}

#[test]
fn a_long_failure_streak_exhausts_the_grace_before_the_tick_count() {
    // A Gateway hang stretches each sequential tick cycle, so the second
    // failed tick can land well past the time grace.
    let run_id = format!("run_grace_time_{}", uuid::Uuid::new_v4().simple());
    register(
        &run_id,
        Some("org_1".to_owned()),
        "daytona",
        WorkspaceId("ws_grace_time".to_owned()),
        sample_spec(),
        1_000_000,
    );
    let first = note_tick_failure(&run_id).expect("run still registered");
    assert!(!tick_grace_exhausted(first));
    let Some(long_ago) =
        Instant::now().checked_sub(MAX_TICK_FAILURE_GRACE + Duration::from_secs(1))
    else {
        unregister(&run_id);
        return;
    };
    if let Some(run) = lock_runs().get_mut(&run_id) {
        run.tick_failing_since = Some(long_ago);
    }
    let second = note_tick_failure(&run_id).expect("run still registered");
    assert_eq!(second.failures, 2);
    assert!(
        tick_grace_exhausted(second),
        "a streak older than the time grace stops the run"
    );
    unregister(&run_id);
}

#[test]
fn only_overload_and_outage_statuses_are_transient() {
    use reqwest::StatusCode;
    for status in [
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::REQUEST_TIMEOUT,
    ] {
        assert!(is_transient_status(status), "{status}");
    }
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::BAD_REQUEST,
        StatusCode::NOT_FOUND,
    ] {
        assert!(!is_transient_status(status), "{status}");
    }
}

#[tokio::test]
async fn tick_post_retries_transient_statuses_with_the_same_tick_index() {
    use crate::test_http::{json_response, request_body, ScriptedServer};
    let server = ScriptedServer::start(|index, _request| {
        Some(if index < 2 {
            json_response(503, "{}")
        } else {
            json_response(200, r#"{"verdict":"continue","accrued_micro_usd":1}"#)
        })
    });
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    let body = json!({ "run_id": "run_retry", "tick_index": 7 });
    let response = post_tick(&endpoint, "bearer", &body)
        .await
        .expect("third attempt reaches the gateway");
    assert!(response.status().is_success());
    let requests = server.finish();
    assert_eq!(requests.len(), 3);
    for request in &requests {
        let sent: serde_json::Value =
            serde_json::from_str(request_body(request)).expect("tick body is JSON");
        assert_eq!(sent["tick_index"], 7, "retries must reuse the tick index");
    }
}

#[tokio::test]
async fn tick_post_does_not_retry_protocol_errors() {
    use crate::test_http::{json_response, ScriptedServer};
    let server = ScriptedServer::start(|_index, _request| Some(json_response(401, "{}")));
    let endpoint = format!("{}/sandbox/tick", server.base_url);
    let response = post_tick(&endpoint, "bearer", &json!({ "tick_index": 0 }))
        .await
        .expect("gateway answered");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn budget_kill_deletes_the_registered_provider_workspace() {
    use crate::daytona::{ENV_DAYTONA_TOKEN, ENV_DAYTONA_URL};
    let _env = crate::daytona::tests::lock_env();
    use std::io::{Read, Write};
    struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 4096];
        let count = stream.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
        request
    });
    let _restore = Restore(vec![
        (ENV_DAYTONA_TOKEN, std::env::var_os(ENV_DAYTONA_TOKEN)),
        (ENV_DAYTONA_URL, std::env::var_os(ENV_DAYTONA_URL)),
    ]);
    std::env::set_var(ENV_DAYTONA_URL, format!("http://{address}"));
    std::env::set_var(ENV_DAYTONA_TOKEN, "mock-token");
    let run_id = uuid::Uuid::new_v4().to_string();
    let workspace = WorkspaceId("real-billed-workspace".into());
    register(
        &run_id,
        None,
        "daytona",
        workspace.clone(),
        sample_spec(),
        100,
    );
    let job = TickJob {
        run_id: run_id.clone(),
        generation: lock_runs().get(&run_id).map_or(0, |run| run.generation),
        org_id: None,
        spec: sample_spec(),
        backend: "daytona".into(),
        workspace,
        per_run_budget_micro_usd: 100,
        elapsed_seconds_delta: 10,
        tick_index: 0,
        kill_action: KillAction::Destroy,
        size: None,
        box_id: None,
        elapsed_seconds_total: 0,
        minimum_waiver: None,
    };
    enforce_kill(&job, KillReason::Budget, 100).await;
    assert!(server
        .join()
        .unwrap()
        .starts_with("DELETE /sandbox/real-billed-workspace HTTP/1.1"));
    assert!(!lock_runs().contains_key(&run_id));
    assert_eq!(kill_record(&run_id).unwrap().reason, KillReason::Budget);
}

#[tokio::test]
async fn quote_rate_reads_the_gateway_rate_for_the_box_shape() {
    let (endpoint, server) = one_shot_server("200 OK", r#"{"rate_micro_usd_per_hour":31000}"#);
    let spec = crate::box_types::spec_for(BoxSize::Small);
    assert_eq!(
        quote_rate_at(&endpoint, "sk-forwarder", &spec, Some(BoxSize::Small)).await,
        Ok(31_000)
    );
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /sandbox/quote HTTP/1.1"));
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer sk-forwarder"));
    let body: serde_json::Value =
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["size"], "small");
    assert_eq!(body["spec"]["vcpu"], 2);
    assert_eq!(body["spec"]["mem_gib"], 4);
}

#[tokio::test]
async fn quote_rate_is_unknown_when_the_gateway_cannot_price() {
    let spec = crate::box_types::spec_for(BoxSize::Large);
    let (endpoint, server) = one_shot_server("401 Unauthorized", r#"{"error":"no"}"#);
    assert!(quote_rate_at(&endpoint, "k", &spec, Some(BoxSize::Large))
        .await
        .is_err());
    server.join().unwrap();
    let (endpoint, server) = one_shot_server("200 OK", r#"{"rate_micro_usd_per_hour":0}"#);
    assert!(quote_rate_at(&endpoint, "k", &spec, Some(BoxSize::Large))
        .await
        .is_err());
    server.join().unwrap();
    let (endpoint, server) = one_shot_server("200 OK", r#"{"other":1}"#);
    assert!(quote_rate_at(&endpoint, "k", &spec, Some(BoxSize::Large))
        .await
        .is_err());
    server.join().unwrap();
}
