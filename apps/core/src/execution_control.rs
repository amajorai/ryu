//! Node-wide emergency pause. Admission and stop notifications share one watch
//! value so a stop followed immediately by resume still cancels older work.
use std::sync::OnceLock;
use tokio::sync::watch;

#[derive(Clone, Copy, Default)]
struct State {
    paused: bool,
    generation: u64,
}

fn state() -> &'static watch::Sender<State> {
    static STATE: OnceLock<watch::Sender<State>> = OnceLock::new();
    STATE.get_or_init(|| watch::channel(State::default()).0)
}

pub const PAUSED_MESSAGE: &str =
    "Chats and bots are paused by Kill Switch. Resume execution to start new work.";

pub fn error_frame() -> Vec<u8> {
    let error = serde_json::json!({ "type": "error", "errorText": PAUSED_MESSAGE });
    format!("data: {error}\n\n").into_bytes()
}

pub fn is_paused() -> bool {
    state().borrow().paused
}

pub fn pause() {
    state().send_modify(|value| {
        value.paused = true;
        value.generation = value.generation.wrapping_add(1);
    });
}

pub fn resume() {
    state().send_modify(|value| value.paused = false);
}

pub async fn control_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static CONTROL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    CONTROL
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

pub struct Admission {
    receiver: watch::Receiver<State>,
    generation: u64,
}

pub fn admit() -> Result<Admission, &'static str> {
    Admission::new(state())
}

impl Admission {
    pub fn is_cancelled(&self) -> bool {
        let value = self.receiver.borrow();
        value.paused || value.generation != self.generation
    }
    pub fn interrupt_stream<S>(
        mut self,
        stream: S,
    ) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::convert::Infallible>>
    where
        S: futures_util::Stream<Item = Result<Vec<u8>, std::convert::Infallible>>,
    {
        use futures_util::StreamExt;
        async_stream::stream! {
            tokio::pin!(stream);
            loop {
                tokio::select! {
                    biased;
                    _ = self.cancelled() => {
                        yield Ok(error_frame());
                        yield Ok(b"data: [DONE]\n\n".to_vec());
                        break;
                    }
                    next = stream.next() => match next {
                        Some(frame) => yield frame,
                        None => break,
                    }
                }
            }
        }
    }

    fn new(sender: &watch::Sender<State>) -> Result<Self, &'static str> {
        let receiver = sender.subscribe();
        let value = *receiver.borrow();
        if value.paused {
            return Err(PAUSED_MESSAGE);
        }
        Ok(Self {
            receiver,
            generation: value.generation,
        })
    }

    pub async fn cancelled(&mut self) {
        loop {
            let value = *self.receiver.borrow_and_update();
            if value.paused || value.generation != self.generation {
                return;
            }
            if self.receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paused_stream_closes_without_polling_upstream() {
        use futures_util::StreamExt;
        let (sender, _) = watch::channel(State::default());
        let admission = Admission::new(&sender).unwrap();
        sender.send_modify(|value| {
            value.paused = true;
            value.generation += 1;
        });
        let upstream = futures_util::stream::poll_fn(
            |_| -> std::task::Poll<Option<Result<Vec<u8>, std::convert::Infallible>>> {
                panic!("a stopped turn must not poll the provider");
            },
        );
        let frames = admission
            .interrupt_stream(upstream)
            .collect::<Vec<_>>()
            .await;
        assert_eq!(frames.len(), 2);
        assert!(String::from_utf8(frames[0].as_ref().unwrap().clone())
            .unwrap()
            .contains(PAUSED_MESSAGE));
        assert_eq!(frames[1].as_ref().unwrap(), b"data: [DONE]\n\n");
    }

    #[tokio::test]
    async fn stop_and_immediate_resume_cancels_existing_work() {
        let (sender, _) = watch::channel(State::default());
        let mut first = Admission::new(&sender).unwrap();
        let mut second = Admission::new(&sender).unwrap();
        sender.send_modify(|value| {
            value.paused = true;
            value.generation += 1;
        });
        assert!(Admission::new(&sender).is_err());
        sender.send_modify(|value| value.paused = false);
        tokio::time::timeout(std::time::Duration::from_millis(100), first.cancelled())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_millis(100), second.cancelled())
            .await
            .unwrap();
        let mut fresh = Admission::new(&sender).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), fresh.cancelled())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn kill_switch_resume_only_admits_new_generation() {
        let _control = control_lock().await;
        resume();
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                resume();
            }
        }
        let _restore = Restore;
        let mut old = admit().expect("initial admission");
        pause();
        assert!(is_paused());
        assert_eq!(admit().err(), Some(PAUSED_MESSAGE));
        resume();
        assert!(!is_paused());
        assert!(
            old.is_cancelled(),
            "resume cannot resurrect work cancelled by pause"
        );
        tokio::time::timeout(std::time::Duration::from_millis(100), old.cancelled())
            .await
            .expect("old work must observe cancellation");
        let mut current = admit().expect("fresh admission after resume");
        resume();
        assert!(
            !current.is_cancelled(),
            "idempotent resume does not cancel accepted work"
        );
        pause();
        resume();
        assert!(
            current.is_cancelled(),
            "a subsequent pause cancels the newer generation too"
        );
        tokio::time::timeout(std::time::Duration::from_millis(100), current.cancelled())
            .await
            .expect("second generation cancellation");
        let fresh = admit().expect("new work after the second resume");
        assert!(!fresh.is_cancelled());
    }

    #[tokio::test]
    async fn kill_switch_midstream_pause_closes_and_drops_provider() {
        use futures_util::{Stream, StreamExt};
        use std::pin::Pin;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::task::{Context, Poll};

        struct Provider {
            polls: Arc<AtomicUsize>,
            dropped: Arc<AtomicBool>,
        }
        impl Stream for Provider {
            type Item = Result<Vec<u8>, std::convert::Infallible>;
            fn poll_next(
                self: Pin<&mut Self>,
                _context: &mut Context<'_>,
            ) -> Poll<Option<Self::Item>> {
                if self.polls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Poll::Ready(Some(Ok(b"data: {\"text\":\"Started\"}\n\n".to_vec())))
                } else {
                    Poll::Pending
                }
            }
        }
        impl Drop for Provider {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }

        let _control = control_lock().await;
        resume();
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                resume();
            }
        }
        let _restore = Restore;
        let polls = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let admission = admit().expect("running turn admission");
        let stream = admission.interrupt_stream(Provider {
            polls: polls.clone(),
            dropped: dropped.clone(),
        });
        tokio::pin!(stream);
        let first = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
            .await
            .expect("first provider frame")
            .expect("frame")
            .expect("infallible");
        assert_eq!(first, b"data: {\"text\":\"Started\"}\n\n");
        assert!(!dropped.load(Ordering::SeqCst));
        pause();
        let error = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
            .await
            .expect("bounded cancellation")
            .expect("error frame")
            .expect("infallible");
        let error = std::str::from_utf8(&error).expect("UTF-8 SSE error");
        let json = error
            .strip_prefix("data: ")
            .expect("SSE prefix")
            .strip_suffix("\n\n")
            .expect("complete SSE frame");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(json).expect("error JSON"),
            serde_json::json!({"type": "error", "errorText": PAUSED_MESSAGE})
        );
        let done = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
            .await
            .expect("terminal frame")
            .expect("DONE")
            .expect("infallible");
        assert_eq!(done, b"data: [DONE]\n\n");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
                .await
                .expect("cancelled stream must terminate")
                .is_none()
        );
        assert_eq!(
            polls.load(Ordering::SeqCst),
            1,
            "no upstream polls after pause"
        );
        assert!(
            dropped.load(Ordering::SeqCst),
            "completed cancellation drops the provider stream"
        );
        assert_eq!(admit().err(), Some(PAUSED_MESSAGE));
    }

    #[tokio::test]
    async fn kill_switch_natural_completion_keeps_provider_frames_and_fresh_admission() {
        use futures_util::StreamExt;
        let _control = control_lock().await;
        resume();
        let frames = vec![
            Ok::<_, std::convert::Infallible>(b"data: {\"text\":\"Finished\"}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ];
        let admission = admit().expect("normal admission");
        let received = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            admission
                .interrupt_stream(futures_util::stream::iter(frames.clone()))
                .collect::<Vec<_>>(),
        )
        .await
        .expect("natural provider completion");
        assert_eq!(
            received, frames,
            "normal completion must not manufacture a pause error"
        );
        assert!(!is_paused());
        assert!(!admit().expect("next turn remains admitted").is_cancelled());
    }
}
