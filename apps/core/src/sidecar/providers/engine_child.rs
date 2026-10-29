//! Live-child gate and readiness wait shared by the Python inference engines
//! (vLLM, SGLang, MLX, oMLX, MLX-VLM).
//!
//! Each of those providers holds its server child in a `Mutex<Option<_>>` slot,
//! spawned with `kill_on_drop(false)`. Storing a new child in an occupied slot
//! drops the old handle without stopping the process, orphaning a serving (or
//! still loading) engine that keeps its port and GPU memory while Core no longer
//! tracks it. `start()` therefore never respawns while the held child is alive,
//! and readiness only counts a listener while the child it spawned is alive, so
//! it cannot pass on someone else's server holding the port.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use anyhow::Context;

/// How long `start()` waits for an engine's HTTP server to accept connections.
pub(super) const READY_TIMEOUT: Duration = Duration::from_secs(120);

/// A spawned engine server held in a provider's process slot.
pub(super) trait EngineChild {
    /// Whether the child is alive. Reaps an exited child, so a crashed server
    /// reads `false` and the next start respawns it.
    fn child_alive(&mut self) -> bool;
}

macro_rules! impl_engine_child {
    ($($process:ty),+ $(,)?) => {
        $(impl EngineChild for $process {
            fn child_alive(&mut self) -> bool {
                self.is_running()
            }
        })+
    };
}

impl_engine_child!(
    super::vllm::VllmProcess,
    super::sglang::SglangProcess,
    super::mlx::MlxProcess,
    super::omlx::OmlxProcess,
    super::mlx_vlm::MlxVlmProcess,
);

/// Is the child in this slot still alive?
pub(super) fn held_child_is_running<P: EngineChild>(process: &Mutex<Option<P>>) -> bool {
    process
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
        .is_some_and(EngineChild::child_alive)
}

/// Wait until `127.0.0.1:port` accepts connections while the held child is
/// alive. Fails as soon as the child exits (a bind failure or an out-of-memory
/// crash), and after `timeout` with the child left in its slot: a slow first
/// load keeps loading, stays tracked, and the next `start()` waits on it again.
pub(super) async fn wait_for_listener<P: EngineChild>(
    process: &Mutex<Option<P>>,
    port: u16,
    engine: &str,
    timeout: Duration,
) -> anyhow::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    tokio::time::timeout(timeout, async {
        loop {
            if !held_child_is_running(process) {
                anyhow::bail!("{engine} exited before it began listening on {addr}");
            }
            if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                // A listener that answers as our child dies is not our server.
                anyhow::ensure!(
                    held_child_is_running(process),
                    "{engine} exited before it began listening on {addr}"
                );
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .with_context(|| format!("{engine} did not start within {} s", timeout.as_secs()))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    struct TestChild(tokio::process::Child);

    impl EngineChild for TestChild {
        fn child_alive(&mut self) -> bool {
            matches!(self.0.try_wait(), Ok(None))
        }
    }

    fn sleeping() -> Mutex<Option<TestChild>> {
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeping child fixture");
        Mutex::new(Some(TestChild(child)))
    }

    async fn exited() -> Mutex<Option<TestChild>> {
        let mut child = tokio::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn exited child fixture");
        child.wait().await.expect("wait exited child fixture");
        Mutex::new(Some(TestChild(child)))
    }

    #[tokio::test]
    async fn held_child_gate_tracks_liveness() {
        assert!(held_child_is_running(&sleeping()));
        assert!(!held_child_is_running(&exited().await));
        assert!(!held_child_is_running(&Mutex::new(None::<TestChild>)));
    }

    #[tokio::test]
    async fn readiness_passes_once_the_live_child_listens() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        wait_for_listener(&sleeping(), port, "engine", Duration::from_secs(5))
            .await
            .expect("a live child with a listener is ready");
    }

    /// A foreign listener (an orphaned engine from an earlier start) must not
    /// make a child that already exited look ready.
    #[tokio::test]
    async fn readiness_fails_when_the_child_exits_while_another_listener_holds_the_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let error = wait_for_listener(&exited().await, port, "engine", Duration::from_secs(5))
            .await
            .expect_err("an exited child is never ready");
        assert!(error.to_string().contains("exited"), "{error:#}");
    }
}
