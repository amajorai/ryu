use super::*;
use std::time::Duration;

fn conversation(label: &str) -> String {
    format!("{label}-{}", uuid::Uuid::new_v4().simple())
}

fn input() -> serde_json::Value {
    serde_json::json!({ "questions": [{ "id": "q-0", "title": "Deploy now?" }] })
}

/// The card goes out as an event. When the receiving side of that stream
/// is gone, nobody can ever answer it, so the waiter is not registered at
/// all and the caller learns that at once.
#[tokio::test]
async fn posting_to_a_dropped_event_stream_returns_nothing_and_leaves_no_waiter() {
    let (tx, events) = mpsc::unbounded_channel::<AcpEvent>();
    drop(events);
    let scope = conversation("post-dropped");
    assert!(post_question(&tx, &scope, "call-1", input()).is_none());
    assert_eq!(
        pending_question_count(&scope),
        0,
        "the waiter was left registered"
    );
    assert_eq!(peek_question_scope(&scope, "call-1"), None);
}

#[tokio::test]
async fn posting_to_a_live_stream_sends_the_card_and_registers_the_waiter() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("post-live");
    let rx = post_question(&tx, &scope, "call-2", input()).expect("a live stream");
    match events.recv().await {
        Some(AcpEvent::QuestionRequest {
            tool_call_id,
            input: card,
        }) => {
            assert_eq!(tool_call_id, "call-2");
            assert_eq!(card, input());
        }
        other => panic!("expected the question card, got {other:?}"),
    }
    assert_eq!(peek_question_scope(&scope, "call-2"), Some(scope.clone()));
    assert!(resolve_question(
        &scope,
        "call-2",
        serde_json::json!(["yes"])
    ));
    assert_eq!(rx.await.unwrap(), serde_json::json!(["yes"]));
    assert_eq!(pending_question_count(&scope), 0);
}

/// The elicitation handler waits through this function. The clock is
/// paused, so a call that waited out the ten-minute window would show it
/// as elapsed virtual time without taking 600 s.
#[tokio::test(start_paused = true)]
async fn a_dropped_event_stream_cancels_the_question_at_once_and_drops_the_waiter() {
    let (tx, events) = mpsc::unbounded_channel::<AcpEvent>();
    drop(events);
    let scope = conversation("answer-dropped");
    let started = tokio::time::Instant::now();
    let answers = request_user_answer(&tx, &scope, "call-3", input()).await;
    assert_eq!(answers, None);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the question waited {:?} for an answer nobody can give",
        started.elapsed()
    );
    assert_eq!(
        pending_question_count(&scope),
        0,
        "the waiter was left registered"
    );
}

#[tokio::test(start_paused = true)]
async fn the_users_answer_is_returned_and_the_waiter_is_consumed() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("answered");
    let call = tokio::spawn({
        let scope = scope.clone();
        async move { request_user_answer(&tx, &scope, "call-4", input()).await }
    });
    assert!(matches!(
        events.recv().await,
        Some(AcpEvent::QuestionRequest { .. })
    ));
    assert_eq!(pending_question_count(&scope), 1);
    let answers = serde_json::json!([{ "kind": "text", "text": "yes" }]);
    assert!(resolve_question(&scope, "call-4", answers.clone()));
    assert_eq!(call.await.unwrap(), Some(answers));
    assert_eq!(pending_question_count(&scope), 0);
    assert!(
        !resolve_question(&scope, "call-4", serde_json::json!([])),
        "a second answer finds no waiter"
    );
}

/// With a listener present the question waits the whole ten minutes: not
/// cancelled early, and cancelled (waiter dropped) once the window closes.
#[tokio::test(start_paused = true)]
async fn an_unanswered_question_waits_ten_minutes_then_cancels() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("unanswered-question");
    let call = tokio::spawn({
        let scope = scope.clone();
        async move { request_user_answer(&tx, &scope, "call-5", input()).await }
    });
    assert!(matches!(
        events.recv().await,
        Some(AcpEvent::QuestionRequest { .. })
    ));

    tokio::time::advance(Duration::from_secs(599)).await;
    tokio::task::yield_now().await;
    assert!(!call.is_finished(), "cancelled before the window closed");
    assert_eq!(pending_question_count(&scope), 1);

    tokio::time::advance(Duration::from_secs(2)).await;
    assert_eq!(call.await.unwrap(), None);
    assert_eq!(
        pending_question_count(&scope),
        0,
        "the timed-out waiter was dropped"
    );
    assert!(
        !resolve_question(&scope, "call-5", serde_json::json!([])),
        "a late answer finds no waiter"
    );
}
