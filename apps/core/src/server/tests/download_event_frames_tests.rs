use crate::downloads::{DownloadEvent, DownloadTask};
use crate::server::resyncing_download_frames;
use futures_util::StreamExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn frame(event: &DownloadEvent) -> String {
    serde_json::to_string(event).unwrap()
}

fn removed(id: &str) -> DownloadEvent {
    DownloadEvent::Removed { id: id.to_owned() }
}

#[tokio::test]
async fn sends_a_snapshot_first_then_live_deltas() {
    let (tx, rx) = tokio::sync::broadcast::channel(8);
    let first = Mutex::new(Some(rx));
    let mut frames = std::pin::pin!(resyncing_download_frames(move || {
        let rx = first.lock().unwrap().take().expect("opened once");
        async move { (Vec::<DownloadTask>::new(), rx) }
    }));
    let empty_snapshot = DownloadEvent::Snapshot { tasks: Vec::new() };

    assert_eq!(frames.next().await, Some(frame(&empty_snapshot)));
    tx.send(removed("a")).unwrap();
    assert_eq!(frames.next().await, Some(frame(&removed("a"))));
    drop(tx);
    assert_eq!(frames.next().await, None);
}

#[tokio::test]
async fn resends_a_snapshot_after_the_subscriber_lags() {
    let (tx, rx) = tokio::sync::broadcast::channel(1);
    let first = Mutex::new(Some(rx));
    let resubscribe = tx.clone();
    let snapshots = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&snapshots);
    let mut frames = std::pin::pin!(resyncing_download_frames(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        // The resync takes a fresh receiver with its snapshot, as
        // `snapshot_and_subscribe` does, so it starts after the snapshot.
        let rx = first
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| resubscribe.subscribe());
        async move { (Vec::<DownloadTask>::new(), rx) }
    }));
    let empty_snapshot = DownloadEvent::Snapshot { tasks: Vec::new() };
    assert_eq!(frames.next().await, Some(frame(&empty_snapshot)));

    // Overflow the one-slot buffer: "a" and "b" are dropped for this
    // subscriber, which might have been a task's terminal update.
    for id in ["a", "b", "c"] {
        tx.send(removed(id)).unwrap();
    }
    assert_eq!(frames.next().await, Some(frame(&empty_snapshot)));
    // The resync snapshot already holds "c"; only later commits follow it.
    tx.send(removed("d")).unwrap();
    assert_eq!(frames.next().await, Some(frame(&removed("d"))));
    assert_eq!(snapshots.load(Ordering::SeqCst), 2);
}

/// The stream takes its snapshot and subscription on its first poll, not
/// when the route builds it: commits that land before that poll are in the
/// snapshot and are never replayed after it (a replayed progress delta would
/// step a row back for one event).
#[tokio::test]
async fn commits_before_the_first_poll_are_in_the_snapshot_and_not_replayed() {
    // `_retained` keeps the channel open while nothing else subscribes.
    let (tx, _retained) = tokio::sync::broadcast::channel(8);
    let commits = Arc::new(AtomicUsize::new(0));
    let commits_at_open = Arc::new(Mutex::new(Vec::new()));
    let mut frames = std::pin::pin!(resyncing_download_frames({
        let tx = tx.clone();
        let commits = Arc::clone(&commits);
        let commits_at_open = Arc::clone(&commits_at_open);
        move || {
            // As `snapshot_and_subscribe`: the snapshot holds every commit
            // so far, and the receiver starts right after it.
            commits_at_open
                .lock()
                .unwrap()
                .push(commits.load(Ordering::SeqCst));
            let rx = tx.subscribe();
            async move { (Vec::<DownloadTask>::new(), rx) }
        }
    }));
    let commit = |id: &str| {
        commits.fetch_add(1, Ordering::SeqCst);
        tx.send(removed(id)).unwrap();
    };
    commit("a");
    commit("b");
    let empty_snapshot = DownloadEvent::Snapshot { tasks: Vec::new() };
    assert_eq!(frames.next().await, Some(frame(&empty_snapshot)));
    assert_eq!(*commits_at_open.lock().unwrap(), vec![2]);
    commit("c");
    assert_eq!(frames.next().await, Some(frame(&removed("c"))));
}
