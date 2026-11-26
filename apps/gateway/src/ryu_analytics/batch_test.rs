//! The relay queue: flush on size, flush on the timer, flush on request, the
//! 429 backoff, the pacing, and the bound.

use std::collections::VecDeque;
use std::sync::Mutex;

use super::*;

/// Records every POST with its arrival time and answers from a script
/// (`Sent` once the script is empty).
struct Sink {
    posts: Mutex<Vec<(std::time::Instant, Vec<u32>)>>,
    script: Mutex<VecDeque<Delivery>>,
    /// While set, a POST does not return.
    stalled: tokio::sync::Semaphore,
    stall: std::sync::atomic::AtomicBool,
}

impl Sink {
    fn scripted(script: &[Delivery]) -> Arc<Self> {
        Arc::new(Self {
            posts: Mutex::default(),
            script: Mutex::new(script.iter().copied().collect()),
            stalled: tokio::sync::Semaphore::new(0),
            stall: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn posts(&self) -> Vec<(std::time::Instant, Vec<u32>)> {
        self.posts.lock().unwrap().clone()
    }

    fn batches(&self) -> Vec<Vec<u32>> {
        self.posts().into_iter().map(|(_, batch)| batch).collect()
    }

    /// Wait until `count` POSTs arrived (or fail after ten seconds).
    async fn wait_for(&self, count: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while self.posts.lock().unwrap().len() < count {
            assert!(std::time::Instant::now() < deadline, "no POST {count}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

impl Post<u32> for Sink {
    fn post<'a>(&'a self, events: &'a [u32]) -> BoxFuture<'a, Delivery> {
        Box::pin(async move {
            self.posts
                .lock()
                .unwrap()
                .push((std::time::Instant::now(), events.to_vec()));
            if self.stall.load(Ordering::SeqCst) {
                let _ = self.stalled.acquire().await;
            }
            let next = self.script.lock().unwrap().pop_front();
            next.unwrap_or(Delivery::Sent)
        })
    }
}

/// Fast pacing and a flush delay no test reaches unless it sets one.
fn settings() -> Settings {
    Settings {
        capacity: 2_000,
        batch_size: 20,
        flush_after: Duration::from_secs(600),
        post_interval: Duration::from_millis(1),
        backoff: Duration::from_millis(1),
    }
}

fn queue(settings: Settings, sink: &Arc<Sink>) -> Queue<u32> {
    Queue::spawn(settings, Arc::clone(sink) as Arc<dyn Post<u32>>)
}

#[tokio::test]
async fn one_hundred_events_take_five_posts_of_twenty_in_arrival_order() {
    let sink = Sink::scripted(&[]);
    let queue = queue(settings(), &sink);
    for event in 0..100 {
        assert!(queue.push(event));
    }
    sink.wait_for(5).await;
    // Nothing is left to post: a sixth POST would mean a partial batch.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let batches = sink.batches();
    assert_eq!(batches.len(), 5);
    assert!(batches.iter().all(|batch| batch.len() == 20));
    let all: Vec<u32> = batches.into_iter().flatten().collect();
    assert_eq!(all, (0..100).collect::<Vec<_>>());
    assert_eq!(queue.dropped(), 0);
}

#[tokio::test]
async fn a_partial_batch_is_posted_once_its_oldest_event_waited_the_flush_delay() {
    let sink = Sink::scripted(&[]);
    let flush_after = Duration::from_millis(150);
    let queue = queue(
        Settings {
            flush_after,
            ..settings()
        },
        &sink,
    );
    let pushed = std::time::Instant::now();
    for event in 0..3 {
        assert!(queue.push(event));
    }
    sink.wait_for(1).await;
    let posts = sink.posts();
    assert_eq!(posts[0].1, vec![0, 1, 2]);
    assert!(
        posts[0].0.duration_since(pushed) >= flush_after,
        "{:?}",
        posts[0].0.duration_since(pushed)
    );
}

#[tokio::test]
async fn flush_posts_everything_queued_without_waiting_for_the_timer() {
    let sink = Sink::scripted(&[]);
    let queue = queue(settings(), &sink);
    for event in 0..45 {
        assert!(queue.push(event));
    }
    queue.flush().await;
    let batches = sink.batches();
    assert_eq!(batches.len(), 3, "{batches:?}");
    assert!(batches.iter().all(|batch| batch.len() <= 20));
    let all: Vec<u32> = batches.into_iter().flatten().collect();
    assert_eq!(all, (0..45).collect::<Vec<_>>());
    // The queue keeps working after a flush.
    for event in 100..120 {
        assert!(queue.push(event));
    }
    sink.wait_for(4).await;
    assert_eq!(sink.batches()[3], (100..120).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_flush_stops_at_the_first_batch_the_relay_does_not_accept() {
    let sink = Sink::scripted(&[Delivery::Lost]);
    let queue = queue(
        Settings {
            batch_size: 2,
            ..settings()
        },
        &sink,
    );
    // Stall the first POST so the rest is still queued when the flush runs.
    sink.stall.store(true, Ordering::SeqCst);
    for event in 0..6 {
        assert!(queue.push(event));
    }
    sink.wait_for(1).await;
    sink.stall.store(false, Ordering::SeqCst);
    sink.script.lock().unwrap().push_back(Delivery::RateLimited);
    sink.stalled.add_permits(1);
    queue.flush().await;
    // POST 1 was lost, the flush's POST was refused, and nothing followed it.
    assert_eq!(sink.batches(), vec![vec![0, 1], vec![2, 3]]);
}

#[tokio::test]
async fn a_429_keeps_the_batch_and_waits_out_the_backoff() {
    let sink = Sink::scripted(&[Delivery::RateLimited]);
    let backoff = Duration::from_millis(200);
    let queue = queue(
        Settings {
            backoff,
            ..settings()
        },
        &sink,
    );
    for event in 0..40 {
        assert!(queue.push(event));
    }
    sink.wait_for(3).await;
    let posts = sink.posts();
    // The refused batch is sent again, unchanged, and only after the backoff.
    assert_eq!(posts[0].1, (0..20).collect::<Vec<_>>());
    assert_eq!(posts[1].1, posts[0].1);
    assert!(
        posts[1].0.duration_since(posts[0].0) >= backoff,
        "{:?}",
        posts[1].0.duration_since(posts[0].0)
    );
    assert_eq!(posts[2].1, (20..40).collect::<Vec<_>>());
}

#[tokio::test]
async fn posts_are_at_least_the_post_interval_apart() {
    let sink = Sink::scripted(&[]);
    let post_interval = Duration::from_millis(120);
    let queue = queue(
        Settings {
            post_interval,
            ..settings()
        },
        &sink,
    );
    for event in 0..60 {
        assert!(queue.push(event));
    }
    sink.wait_for(3).await;
    let posts = sink.posts();
    for pair in posts.windows(2) {
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(gap >= post_interval, "{gap:?}");
    }
}

#[tokio::test]
async fn a_full_queue_drops_the_newest_events_and_counts_them() {
    let sink = Sink::scripted(&[]);
    sink.stall.store(true, Ordering::SeqCst);
    let queue = queue(
        Settings {
            capacity: 4,
            batch_size: 2,
            ..settings()
        },
        &sink,
    );
    // The relay does not answer: one batch is in flight and the channel fills.
    assert!(queue.push(0));
    assert!(queue.push(1));
    sink.wait_for(1).await;
    let accepted = (2..40).filter(|event| queue.push(*event)).count();
    assert_eq!(accepted, 4, "the channel bound");
    assert_eq!(queue.dropped(), 34);
    // Once the relay answers, what was accepted is delivered in order.
    sink.stall.store(false, Ordering::SeqCst);
    sink.stalled.add_permits(1);
    sink.wait_for(3).await;
    assert_eq!(sink.batches(), vec![vec![0, 1], vec![2, 3], vec![4, 5]]);
}
