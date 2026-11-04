//! Live re-authorization of realtime sockets after an ACL change.

use super::*;
use ryu_collab::{classify_doc_sync, DocSyncAction, DocSyncMessage};
use std::sync::atomic::AtomicU8;

const WRITE: u8 = 0;
const READ: u8 = 1;
const DENY: u8 = 2;

/// A lookup whose answer the test controls, standing in for the ACL rows.
fn controlled_lookup(state: Arc<AtomicU8>) -> AccessLookup {
    Arc::new(move || {
        let state = Arc::clone(&state);
        Box::pin(async move {
            match state.load(Ordering::SeqCst) {
                WRITE => AccessOutcome::Grant(Access::Write),
                READ => AccessOutcome::Grant(Access::Read),
                _ => AccessOutcome::Deny("forbidden"),
            }
        })
    })
}

fn event_frame(text: &str) -> Frame {
    Frame::Event(serde_json::json!({ "text": text }))
}

fn text_of(message: Message) -> String {
    match message {
        Message::Text(text) => text,
        other => panic!("expected a text frame, got {other:?}"),
    }
}

#[tokio::test]
async fn forward_task_stops_relaying_once_a_collaborator_is_removed() {
    let acl = Arc::new(AtomicU8::new(WRITE));
    let guard = AccessGuard::new(
        controlled_lookup(Arc::clone(&acl)),
        Access::Write,
        access_epoch(),
    );
    let (room_tx, room_rx) = broadcast::channel(16);
    let (out_tx, mut out_rx) = mpsc::channel(16);
    let forward = spawn_forward_task(room_rx, out_tx, false, guard.clone());

    room_tx.send(event_frame("before")).unwrap();
    let delivered = tokio::time::timeout(Duration::from_secs(5), out_rx.recv())
        .await
        .expect("frame forwarded")
        .expect("channel open");
    assert!(text_of(delivered).contains("before"));

    // The owner removes the collaborator, then a new message is published.
    acl.store(DENY, Ordering::SeqCst);
    notify_access_changed();
    room_tx.send(event_frame("after-revocation")).unwrap();

    tokio::time::timeout(Duration::from_secs(5), forward)
        .await
        .expect("forward task ends after revocation")
        .unwrap();
    assert!(
        out_rx.recv().await.is_none(),
        "no frame may be relayed after access is revoked"
    );
    assert!(guard.revoked().is_cancelled());
    assert!(!guard.can_write());
}

#[tokio::test]
async fn document_updates_are_dropped_after_a_downgrade_to_read() {
    let acl = Arc::new(AtomicU8::new(WRITE));
    let guard = AccessGuard::new(
        controlled_lookup(Arc::clone(&acl)),
        Access::Write,
        access_epoch(),
    );
    let update = DocSyncMessage::Update(vec![1, 2, 3]).encode();
    assert!(guard.ensure_current().await);
    assert!(matches!(
        classify_doc_sync(&update, guard.can_write()),
        DocSyncAction::Apply(_)
    ));

    // The Space is narrowed so this member can now only read.
    acl.store(READ, Ordering::SeqCst);
    notify_access_changed();

    assert!(
        guard.ensure_current().await,
        "read access keeps the socket open"
    );
    assert!(matches!(
        classify_doc_sync(&update, guard.can_write()),
        DocSyncAction::Drop
    ));
    assert!(!guard.revoked().is_cancelled());
}

#[tokio::test]
async fn document_socket_is_revoked_when_the_space_turns_private() {
    let acl = Arc::new(AtomicU8::new(WRITE));
    let guard = AccessGuard::new(
        controlled_lookup(Arc::clone(&acl)),
        Access::Write,
        access_epoch(),
    );

    acl.store(DENY, Ordering::SeqCst);
    notify_access_changed();

    assert!(!guard.ensure_current().await);
    assert!(guard.revoked().is_cancelled());
    assert!(!guard.can_write());
    assert!(matches!(
        revoked_close(),
        Message::Close(Some(frame))
            if frame.code == CLOSE_POLICY && frame.reason == ACCESS_REVOKED_REASON
    ));
}

#[tokio::test]
async fn forced_refresh_consults_the_acl() {
    let calls = Arc::new(AtomicU8::new(0));
    let counted = Arc::clone(&calls);
    let lookup: AccessLookup = Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { AccessOutcome::Grant(Access::Write) })
    });
    let guard = AccessGuard::new(lookup, Access::Write, access_epoch());
    // Other tests may bump the shared epoch concurrently; only assert that a
    // forced refresh always consults the ACL.
    assert!(guard.refresh(true).await);
    assert!(calls.load(Ordering::SeqCst) >= 1);
    assert!(guard.can_write());
}
