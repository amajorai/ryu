use super::*;
use std::time::Duration;

/// The pending permission waiters scoped to one conversation.
fn pending_in(conversation: &str) -> usize {
    pending_permissions()
        .lock()
        .unwrap()
        .values()
        .filter(|(_, scope)| scope.as_deref() == Some(conversation))
        .count()
}

fn conversation(label: &str) -> String {
    format!("{label}-{}", uuid::Uuid::new_v4().simple())
}

async fn next_request(events: &mut mpsc::UnboundedReceiver<AcpEvent>) -> String {
    match events.recv().await {
        Some(AcpEvent::PermissionRequest { request_id, .. }) => request_id,
        other => panic!("expected a permission request, got {other:?}"),
    }
}

/// The prompt goes out as an event. When the receiving side of that stream
/// is gone, nobody can ever answer it, so the tool call is refused at
/// once. The clock is paused, so a call that waited out the ten-minute
/// window would show it as elapsed virtual time without taking 600 s.
#[tokio::test(start_paused = true)]
async fn a_dropped_event_stream_refuses_the_request_at_once_and_drops_the_waiter() {
    let (tx, events) = mpsc::unbounded_channel::<AcpEvent>();
    drop(events);
    let scope = conversation("dropped-stream");
    let started = tokio::time::Instant::now();
    let chosen = request_user_permission(
        &tx,
        serde_json::json!({ "toolCallId": "call-1" }),
        serde_json::json!([]),
        Some(scope.clone()),
    )
    .await;
    assert_eq!(chosen, None);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the refusal waited {:?} for an answer nobody can give",
        started.elapsed()
    );
    assert_eq!(pending_in(&scope), 0, "the waiter was left registered");
}

#[tokio::test(start_paused = true)]
async fn the_users_choice_is_returned_and_the_waiter_is_consumed() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("chosen");
    let call = tokio::spawn({
        let scope = scope.clone();
        async move {
            request_user_permission(
                &tx,
                serde_json::json!({ "toolCallId": "call-2" }),
                serde_json::json!([{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]),
                Some(scope),
            )
            .await
        }
    });
    let (request_id, tool_call, options) = match events.recv().await {
        Some(AcpEvent::PermissionRequest {
            request_id,
            tool_call,
            options,
        }) => (request_id, tool_call, options),
        other => panic!("expected a permission request, got {other:?}"),
    };
    assert_eq!(tool_call["toolCallId"], "call-2");
    assert_eq!(options[0]["optionId"], "allow");
    assert_eq!(
        peek_permission_scope(&request_id),
        Some(Some(scope.clone())),
        "the waiter is scoped to the asking conversation"
    );
    assert!(resolve_permission(&request_id, Some("allow".to_owned())));
    assert_eq!(call.await.unwrap(), Some("allow".to_owned()));
    assert_eq!(pending_in(&scope), 0);
    assert!(
        !resolve_permission(&request_id, Some("allow".to_owned())),
        "a decision is delivered once"
    );
}

#[tokio::test(start_paused = true)]
async fn a_rejection_from_the_user_is_a_refusal() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("rejected");
    let call = tokio::spawn({
        let scope = scope.clone();
        async move {
            request_user_permission(
                &tx,
                serde_json::json!({}),
                serde_json::json!([]),
                Some(scope),
            )
            .await
        }
    });
    let request_id = next_request(&mut events).await;
    assert!(resolve_permission(&request_id, None));
    assert_eq!(call.await.unwrap(), None);
    assert_eq!(pending_in(&scope), 0);
}

/// With a listener present the request waits the whole ten minutes: not
/// refused early, and cancelled (waiter dropped) once the window closes.
#[tokio::test(start_paused = true)]
async fn an_unanswered_request_waits_ten_minutes_then_cancels() {
    let (tx, mut events) = mpsc::unbounded_channel::<AcpEvent>();
    let scope = conversation("unanswered");
    let call = tokio::spawn({
        let scope = scope.clone();
        async move {
            request_user_permission(
                &tx,
                serde_json::json!({}),
                serde_json::json!([]),
                Some(scope),
            )
            .await
        }
    });
    let request_id = next_request(&mut events).await;

    tokio::time::advance(Duration::from_secs(599)).await;
    tokio::task::yield_now().await;
    assert!(!call.is_finished(), "refused before the window closed");
    assert_eq!(pending_in(&scope), 1);

    tokio::time::advance(Duration::from_secs(2)).await;
    assert_eq!(call.await.unwrap(), None);
    assert_eq!(pending_in(&scope), 0, "the timed-out waiter was dropped");
    assert!(
        !resolve_permission(&request_id, Some("allow".to_owned())),
        "a late decision finds no waiter"
    );
}
