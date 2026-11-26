use super::*;
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};

fn scheduled(target: JobTarget) -> crate::approvals::ApprovalRequest {
    crate::approvals::ApprovalRequest::for_scheduled_job(&ScheduledJob {
        id: "job".to_owned(),
        name: "job".to_owned(),
        schedule: Schedule::Every {
            interval: "1h".to_owned(),
        },
        target,
        enabled: true,
        require_approval: true,
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: "t".to_owned(),
        updated_at: "t".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    })
}

/// Approvals that run an app job are hidden unless `include=app_jobs`.
#[test]
fn app_job_approvals_are_listed_only_on_request() {
    let app = scheduled(JobTarget::AppJob {
        plugin_id: "@example/owner".to_owned(),
        job_id: "m1".to_owned(),
        payload: None,
    });
    let agent = scheduled(JobTarget::Agent {
        agent_id: "a".to_owned(),
        prompt: "p".to_owned(),
        model: None,
        conversation_id: None,
    });
    assert!(runs_app_job(&app));
    assert!(!runs_app_job(&agent));
    let query = |include: Option<&str>| ListQuery {
        status: None,
        include: include.map(str::to_owned),
    };
    assert!(!query(None).include_app_jobs());
    assert!(!query(Some("apps")).include_app_jobs());
    assert!(query(Some("app_jobs")).include_app_jobs());
    assert!(query(Some("x, app_jobs")).include_app_jobs());
}

fn created_event() -> crate::approvals::ApprovalEvent {
    crate::approvals::ApprovalEvent::Created {
        request: scheduled(JobTarget::Agent {
            agent_id: "a".to_owned(),
            prompt: "secret-tool-args".to_owned(),
            model: None,
            conversation_id: None,
        }),
    }
}

fn allow(result: bool) -> Revalidate {
    Arc::new(move || Box::pin(async move { result }))
}

/// Reads the next body chunk, or `None` once the stream has ended.
async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<String> {
    use futures_util::StreamExt;
    tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("stream should yield or end")
        .map(|chunk| String::from_utf8_lossy(&chunk.unwrap()).into_owned())
}

#[tokio::test]
async fn authorized_stream_forwards_events() {
    let (tx, rx) = tokio::sync::broadcast::channel(8);
    let far_future = chrono::Utc::now().timestamp() + 3600;
    let response = approval_sse(approval_feed(
        rx,
        Some(far_future),
        allow(true),
        Duration::from_millis(10),
    ));
    let mut body = response.into_body().into_data_stream();
    tx.send(created_event()).unwrap();
    let chunk = next_chunk(&mut body).await.expect("event frame");
    assert!(chunk.contains("secret-tool-args"));
    // Passing re-checks keep the stream open for later events.
    tokio::time::sleep(Duration::from_millis(40)).await;
    tx.send(created_event()).unwrap();
    assert!(next_chunk(&mut body).await.is_some());
}

#[tokio::test]
async fn stream_ends_when_permission_recheck_fails() {
    let (tx, rx) = tokio::sync::broadcast::channel(8);
    let response = approval_sse(approval_feed(
        rx,
        None,
        allow(false),
        Duration::from_millis(20),
    ));
    let mut body = response.into_body().into_data_stream();
    tokio::time::sleep(Duration::from_millis(60)).await;
    // Queued after revocation: never delivered, the stream is closed.
    let _ = tx.send(created_event());
    assert!(next_chunk(&mut body).await.is_none());
}

#[tokio::test]
async fn stream_ends_at_credential_expiry_before_forwarding() {
    let (tx, rx) = tokio::sync::broadcast::channel(8);
    tx.send(created_event()).unwrap();
    let expired = chrono::Utc::now().timestamp() - 1;
    let response = approval_sse(approval_feed(
        rx,
        Some(expired),
        allow(true),
        Duration::from_secs(30),
    ));
    let mut body = response.into_body().into_data_stream();
    assert!(next_chunk(&mut body).await.is_none());
}

/// A caller without a verified identity gets no approval feed on either
/// route (`/api/approvals/events` or the `/api/events/all` channel).
#[tokio::test]
async fn anonymous_caller_is_refused_the_feed() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(dir.path());
    let refused = open_approval_feed(state, None, None, None).await;
    assert_eq!(refused.err(), Some(axum::http::StatusCode::FORBIDDEN));
}

/// Events on the multiplexed channel are tagged `approvals`, and when the
/// feed ends the whole multiplex ends even though other channels are idle.
#[tokio::test]
async fn multiplex_ends_when_the_approvals_channel_ends() {
    use futures_util::StreamExt;

    let (tx, rx) = tokio::sync::broadcast::channel(8);
    let feed = approval_feed(rx, None, allow(true), Duration::from_secs(30));
    let (channel, ended) = approvals_channel(feed);
    let idle: TaggedEvents = Box::pin(futures_util::stream::pending());
    let mut multiplex = futures_util::stream::select_all(vec![idle, channel]).take_until(ended);
    tx.send(created_event()).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("event")
        .expect("frame");
    // Render the frame through the SSE encoder to read its bytes.
    let mut body = axum::response::sse::Sse::new(futures_util::stream::iter([first]))
        .into_response()
        .into_body()
        .into_data_stream();
    let frame = next_chunk(&mut body).await.expect("frame bytes");
    assert!(frame.contains("event: approvals"));
    assert!(frame.contains("secret-tool-args"));
    // The bus closes: the approvals feed ends, so the multiplex ends too.
    drop(tx);
    let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("multiplex should end");
    assert!(end.is_none());
}

/// A failed re-check ends the multiplex, not just the approvals channel.
#[tokio::test]
async fn multiplex_ends_when_the_permission_recheck_fails() {
    use futures_util::StreamExt;

    let (_tx, rx) = tokio::sync::broadcast::channel(8);
    let feed = approval_feed(rx, None, allow(false), Duration::from_millis(20));
    let (channel, ended) = approvals_channel(feed);
    let idle: TaggedEvents = Box::pin(futures_util::stream::pending());
    let mut multiplex = futures_util::stream::select_all(vec![idle, channel]).take_until(ended);
    let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("multiplex should end");
    assert!(end.is_none());
}

/// An opener that answers each attempt from `outcomes` in order (the last
/// one repeats) and counts the attempts.
fn scripted_open(
    outcomes: Vec<axum::http::StatusCode>,
    bus: tokio::sync::broadcast::Sender<crate::approvals::ApprovalEvent>,
) -> (OpenFeed, Arc<std::sync::atomic::AtomicUsize>) {
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = attempts.clone();
    let open: OpenFeed = Arc::new(move || {
        let attempt = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let outcome = outcomes[attempt.min(outcomes.len() - 1)];
        let rx = bus.subscribe();
        Box::pin(async move {
            if outcome == axum::http::StatusCode::OK {
                Ok(approval_feed(
                    rx,
                    None,
                    allow(true),
                    Duration::from_secs(30),
                ))
            } else {
                Err(outcome)
            }
        })
    });
    (open, attempts)
}

/// A definite denial at connect time opens no approvals channel.
#[tokio::test]
async fn events_all_omits_the_channel_on_a_definite_denial() {
    let (tx, _rx) = tokio::sync::broadcast::channel(8);
    let (open, attempts) = scripted_open(vec![axum::http::StatusCode::FORBIDDEN], tx);
    let channel =
        approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(5)).await;
    assert!(channel.is_none());
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// Approval-derived activity rides `/api/events/all` only when the
/// connect-time check passed: never on a refusal, and never during an
/// outage, even after a background retry later succeeds.
#[tokio::test]
async fn events_all_lets_activity_carry_approvals_only_after_a_passed_check() {
    use futures_util::StreamExt;

    let ok = axum::http::StatusCode::OK;
    let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
    let (tx, _rx) = tokio::sync::broadcast::channel(8);

    let (open, _) = scripted_open(vec![ok], tx.clone());
    let passed = approvals_decision(open, Duration::from_millis(5), Duration::from_millis(5)).await;
    assert!(passed.may_view);
    assert!(passed.channel.is_some());

    let (open, _) = scripted_open(vec![axum::http::StatusCode::FORBIDDEN], tx.clone());
    let denied = approvals_decision(open, Duration::from_millis(5), Duration::from_millis(5)).await;
    assert!(!denied.may_view);
    assert!(denied.channel.is_none());

    let (open, attempts) = scripted_open(vec![unavailable, ok], tx);
    let outage = approvals_decision(open, Duration::from_millis(2), Duration::from_millis(2)).await;
    assert!(!outage.may_view, "an outage is not a passed check");
    let (channel, ended) = outage.channel.expect("an outage is not a denial");
    let (_other_tx, other) = other_channel();
    let mut multiplex = futures_util::stream::select_all(vec![other, channel]).take_until(ended);
    // The retry succeeds and ends the stream; the flag was decided before it.
    let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("the multiplex ends once the check passes");
    assert!(end.is_none());
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
}

/// A test channel other than `approvals`, fed through the returned sender.
fn other_channel() -> (
    tokio::sync::mpsc::UnboundedSender<&'static str>,
    TaggedEvents,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    let stream: TaggedEvents = Box::pin(futures_util::stream::unfold(rx, |mut rx| async move {
        let name = rx.recv().await?;
        let event = axum::response::sse::Event::default().event(name).data("x");
        Some((Ok::<_, std::convert::Infallible>(event), rx))
    }));
    (tx, stream)
}

async fn frame_text(frame: Result<axum::response::sse::Event, std::convert::Infallible>) -> String {
    let mut body = axum::response::sse::Sse::new(futures_util::stream::iter([frame]))
        .into_response()
        .into_body()
        .into_data_stream();
    next_chunk(&mut body).await.expect("frame bytes")
}

/// Drive `multiplex` until `attempts` reaches `target`, failing if it yields
/// anything (approvals or an end) in the meantime.
async fn drive_until_attempt<S>(
    multiplex: &mut S,
    attempts: &std::sync::atomic::AtomicUsize,
    target: usize,
) where
    S: futures_util::Stream + Unpin,
{
    use futures_util::StreamExt;
    let reached = async {
        while attempts.load(std::sync::atomic::Ordering::SeqCst) < target {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    };
    tokio::select! {
        _ = multiplex.next() => panic!("nothing is forwarded and the stream stays open during the outage"),
        waited = tokio::time::timeout(Duration::from_secs(5), reached) => waited.expect("retried"),
    }
}

/// During a control-plane outage the other channels keep flowing, no
/// approval is forwarded, and the connection stays open while the check
/// keeps failing with `503`.
#[tokio::test]
async fn events_all_outage_forwards_no_approvals_and_keeps_other_channels() {
    use futures_util::StreamExt;

    let (tx, _rx) = tokio::sync::broadcast::channel(8);
    let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
    let (open, attempts) = scripted_open(vec![unavailable], tx.clone());
    let (channel, ended) =
        approvals_channel_retrying(open, Duration::from_millis(2), Duration::from_millis(4))
            .await
            .expect("an outage is not a denial");
    let (other_tx, other) = other_channel();
    let mut multiplex = futures_util::stream::select_all(vec![other, channel]).take_until(ended);
    let _ = tx.send(created_event());
    drive_until_attempt(&mut multiplex, &attempts, 4).await;
    let _ = tx.send(created_event());
    other_tx.send("notifications").unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("other channel still flows")
        .expect("frame");
    let frame = frame_text(frame).await;
    assert!(frame.contains("event: notifications"));
    assert!(!frame.contains("event: approvals"));
}

/// When the check passes again after an outage, the connection ends instead
/// of starting approvals mid-stream: the client reconnects, resyncs what it
/// missed during the outage, and is authorized with its current credential.
#[tokio::test]
async fn events_all_ends_the_stream_once_the_check_passes_after_an_outage() {
    use futures_util::StreamExt;

    let (tx, _rx) = tokio::sync::broadcast::channel(8);
    let unavailable = axum::http::StatusCode::SERVICE_UNAVAILABLE;
    let (open, attempts) = scripted_open(
        vec![unavailable, unavailable, axum::http::StatusCode::OK],
        tx.clone(),
    );
    let (channel, ended) =
        approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(20))
            .await
            .expect("an outage is not a denial");
    let (_other_tx, other) = other_channel();
    let mut multiplex = futures_util::stream::select_all(vec![other, channel]).take_until(ended);
    // Sent before any check passed: no feed is subscribed, nothing leaks.
    let _ = tx.send(created_event());
    let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("the multiplex ends once the check passes");
    assert!(
        end.is_none(),
        "no approval frame is forwarded on this connection"
    );
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
}

/// A refusal on a retry (a revoked grant, or a credential that expired
/// during the outage) also ends the stream, so the client reconnects with a
/// fresh token rather than keeping a connection without approvals.
#[tokio::test]
async fn events_all_ends_the_stream_when_a_retry_is_refused() {
    use futures_util::StreamExt;

    let (tx, _rx) = tokio::sync::broadcast::channel(8);
    let (open, attempts) = scripted_open(
        vec![
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::http::StatusCode::FORBIDDEN,
        ],
        tx.clone(),
    );
    let (channel, ended) =
        approvals_channel_retrying(open, Duration::from_millis(5), Duration::from_millis(5))
            .await
            .expect("an outage is not a denial");
    let (other_tx, other) = other_channel();
    let mut multiplex = futures_util::stream::select_all(vec![other, channel]).take_until(ended);
    // The other channel flows while the outage lasts.
    other_tx.send("notifications").unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("other channel flows")
        .expect("frame");
    assert!(frame_text(frame).await.contains("event: notifications"));
    let _ = tx.send(created_event());
    let end = tokio::time::timeout(Duration::from_secs(5), multiplex.next())
        .await
        .expect("the multiplex ends on the refused retry");
    assert!(end.is_none());
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
}
