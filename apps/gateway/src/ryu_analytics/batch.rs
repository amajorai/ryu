//! Bounded batching queue for the usage relay.
//!
//! A model call used to spawn one task and send one POST for its one event,
//! into a relay that admits 60 POSTs per minute per key and 20 events per
//! POST. The queue keeps the request path to one `try_send`: a single task
//! collects events and posts them in batches, when a batch is full or when
//! its oldest event has waited [`Settings::flush_after`], never more often
//! than [`Settings::post_interval`]. A 429 keeps the batch and waits
//! [`Settings::backoff`] before the next POST. The queue is bounded: when it
//! is full the newest event is dropped and counted, so a slow or refusing
//! relay can never hold memory or delay a request.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// The queue's bounds and pacing.
#[derive(Debug, Clone, Copy)]
pub(super) struct Settings {
    /// Events held between the callers and the posting task.
    pub(super) capacity: usize,
    /// Events per POST.
    pub(super) batch_size: usize,
    /// Longest wait of a queued event before a partial batch is posted.
    pub(super) flush_after: Duration,
    /// Shortest gap between two POSTs.
    pub(super) post_interval: Duration,
    /// Wait after the relay answered 429.
    pub(super) backoff: Duration,
}

/// What became of one POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Delivery {
    /// The relay accepted the batch.
    Sent,
    /// The relay answered 429: the batch is kept and retried after the backoff.
    RateLimited,
    /// The batch is gone: the relay refused it, could not be reached, or is
    /// not configured. Telemetry is best effort, so it is not retried.
    Lost,
}

/// Where batches go.
pub(super) trait Post<E>: Send + Sync + 'static {
    fn post<'a>(&'a self, events: &'a [E]) -> BoxFuture<'a, Delivery>;
}

/// The callers' side of the queue.
pub(super) struct Queue<E> {
    events: mpsc::Sender<E>,
    flushes: mpsc::Sender<oneshot::Sender<()>>,
    dropped: Arc<AtomicU64>,
}

impl<E: Send + Sync + 'static> Queue<E> {
    /// Start the posting task on the current runtime.
    pub(super) fn spawn(settings: Settings, post: Arc<dyn Post<E>>) -> Self {
        let (events, queued) = mpsc::channel(settings.capacity);
        let (flushes, flush_requests) = mpsc::channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        tokio::spawn(run(
            queued,
            flush_requests,
            settings,
            post,
            Arc::clone(&dropped),
        ));
        Self {
            events,
            flushes,
            dropped,
        }
    }

    /// Queue one event without waiting. Returns false when the queue is full
    /// (or its task is gone) and the event was dropped.
    pub(super) fn push(&self, event: E) -> bool {
        let queued = self.events.try_send(event).is_ok();
        if !queued {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        queued
    }

    /// Events dropped because the queue was full.
    pub(super) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Post everything queued so far, ignoring the pacing, and wait for it.
    /// It stops at the first batch the relay does not accept.
    pub(super) async fn flush(&self) {
        let (ack, done) = oneshot::channel();
        if self.flushes.send(ack).await.is_ok() {
            let _ = done.await;
        }
    }
}

/// Resolves at `due`, or never when nothing is due.
async fn until(due: Option<Instant>) {
    match due {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn run<E: Send + Sync + 'static>(
    mut queued: mpsc::Receiver<E>,
    mut flush_requests: mpsc::Receiver<oneshot::Sender<()>>,
    settings: Settings,
    post: Arc<dyn Post<E>>,
    dropped: Arc<AtomicU64>,
) {
    let mut batch: Vec<E> = Vec::with_capacity(settings.batch_size);
    // When the oldest event of `batch` arrived, and the earliest next POST.
    let mut first_at = Instant::now();
    let mut not_before = first_at;
    let mut reported = 0;
    loop {
        let full = batch.len() >= settings.batch_size;
        let due = match (batch.is_empty(), full) {
            (true, _) => None,
            (false, true) => Some(not_before),
            (false, false) => Some((first_at + settings.flush_after).max(not_before)),
        };
        tokio::select! {
            biased;
            ack = flush_requests.recv() => {
                let Some(ack) = ack else { return };
                drain(&mut queued, &mut batch, settings.batch_size, post.as_ref()).await;
                let _ = ack.send(());
            }
            () = until(due) => {
                if post.post(&batch).await == Delivery::RateLimited {
                    not_before = Instant::now() + settings.backoff;
                } else {
                    batch.clear();
                    not_before = Instant::now() + settings.post_interval;
                }
                let total = dropped.load(Ordering::Relaxed);
                if total > reported {
                    tracing::debug!(
                        dropped = total - reported,
                        "ryu diagnostics: usage relay queue was full; events dropped"
                    );
                    reported = total;
                }
            }
            // A full batch waits for its POST; the channel then fills to its
            // bound and `push` drops.
            event = queued.recv(), if !full => {
                let Some(event) = event else {
                    if !batch.is_empty() {
                        post.post(&batch).await;
                    }
                    return;
                };
                if batch.is_empty() {
                    first_at = Instant::now();
                }
                batch.push(event);
            }
        }
    }
}

/// Post the open batch and everything still queued, one batch after another.
async fn drain<E: Send + Sync + 'static>(
    queued: &mut mpsc::Receiver<E>,
    batch: &mut Vec<E>,
    batch_size: usize,
    post: &dyn Post<E>,
) {
    loop {
        while batch.len() < batch_size {
            match queued.try_recv() {
                Ok(event) => batch.push(event),
                Err(_) => break,
            }
        }
        if batch.is_empty() {
            return;
        }
        let delivery = post.post(batch).await;
        // A flush is the last chance for these events, so a refused batch is
        // let go, and a relay that refuses one is not sent the rest.
        batch.clear();
        if delivery != Delivery::Sent {
            return;
        }
    }
}

#[cfg(test)]
#[path = "batch_test.rs"]
mod tests;
