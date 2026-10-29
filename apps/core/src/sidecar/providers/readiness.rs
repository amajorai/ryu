//! Shared readiness checks for spawned OpenAI-compatible local engines.
//!
//! A TCP connect is not readiness: a stale listener left on the port (oMLX and
//! vLLM both default to `:8000`) accepts the connection while the new child
//! fails its bind, and an early-exiting child would otherwise be waited on for
//! the whole startup window. These helpers model the llama.cpp identity check
//! (`providers/llamacpp`): refuse an occupied port before spawn, poll the child
//! for exit (failing fast with its stderr tail), and require the HTTP API to
//! answer — and, when the engine reports it, to list the expected model.

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

/// How many trailing stderr lines a failed start reports.
const STDERR_TAIL_LINES: usize = 20;
/// Grace period for the log forwarder to drain the final stderr lines of a
/// child that has just exited, so the error carries the actual cause.
const EXIT_LOG_DRAIN: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Bounded ring of a child's most recent stderr lines. Cloned into the stderr
/// forwarding task; the owning process reads it when the child dies early.
#[derive(Clone, Default)]
pub struct StderrTail(Arc<Mutex<VecDeque<String>>>);

impl StderrTail {
    pub fn push(&self, line: &str) {
        let mut lines = self.0.lock().unwrap();
        if lines.len() == STDERR_TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line.to_owned());
    }

    pub fn snapshot(&self) -> String {
        let lines = self.0.lock().unwrap();
        lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// A spawned engine process whose liveness and stderr can be observed while it
/// starts. Implemented by the per-engine `*Process` wrappers.
pub trait ReadinessChild {
    fn is_running(&mut self) -> bool;
    fn stderr_tail(&self) -> String;
}

/// What the engine must report before it counts as ready.
pub struct ReadyProbe<'a> {
    pub engine: &'a str,
    pub port: u16,
    /// Engine-specific health route checked before `/v1/models` (e.g.
    /// `/health`); `None` when the engine has no dedicated route.
    pub health_path: Option<&'a str>,
    /// Model id `/v1/models` must list. `None` for multi-model servers that
    /// start empty, or engines whose listing omits the served model.
    pub expected_model: Option<&'a str>,
    pub timeout: Duration,
}

/// Refuse to spawn onto a port another process already holds. The client URL
/// for each engine is fixed, so a second listener would silently receive chat
/// meant for the new child.
pub async fn ensure_port_free(engine: &str, port: u16) -> anyhow::Result<()> {
    let address = (Ipv4Addr::LOCALHOST, port);
    let connected = matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(address)
        )
        .await,
        Ok(Ok(_))
    );
    if connected || std::net::TcpListener::bind(address).is_err() {
        anyhow::bail!(
            "{engine} cannot start: 127.0.0.1:{port} is already in use by another process. \
             Stop that server (another local engine may still be running) and retry."
        );
    }
    Ok(())
}

/// Wait until the spawned child serves the OpenAI API, failing fast when the
/// child exits and on a stale listener serving a different model.
pub async fn wait_for_child<P: ReadinessChild>(
    client: &reqwest::Client,
    probe: &ReadyProbe<'_>,
    process: &Mutex<Option<P>>,
) -> anyhow::Result<()> {
    wait_until_ready(
        client,
        probe,
        || {
            process
                .lock()
                .unwrap()
                .as_mut()
                .is_some_and(ReadinessChild::is_running)
        },
        || {
            process
                .lock()
                .unwrap()
                .as_ref()
                .map(ReadinessChild::stderr_tail)
                .unwrap_or_default()
        },
    )
    .await
}

/// Closure form of [`wait_for_child`] for engines spawned through
/// [`crate::sidecar::ProcessHandle`].
pub async fn wait_until_ready(
    client: &reqwest::Client,
    probe: &ReadyProbe<'_>,
    mut is_alive: impl FnMut() -> bool,
    stderr_tail: impl Fn() -> String,
) -> anyhow::Result<()> {
    let engine = probe.engine;
    let base = format!("http://127.0.0.1:{}", probe.port);
    let models_url = format!("{base}/v1/models");
    let health_url = probe.health_path.map(|path| format!("{base}{path}"));

    let poll = async {
        loop {
            if !is_alive() {
                tokio::time::sleep(EXIT_LOG_DRAIN).await;
                let tail = stderr_tail();
                if tail.trim().is_empty() {
                    anyhow::bail!("{engine} process exited before becoming ready");
                }
                anyhow::bail!(
                    "{engine} process exited before becoming ready; stderr tail:\n{tail}"
                );
            }

            if let Some(health_url) = &health_url {
                let healthy = client
                    .get(health_url)
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success());
                if !healthy {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
            }

            let payload = match client.get(&models_url).send().await {
                Ok(response) if response.status().is_success() => {
                    response.json::<serde_json::Value>().await.ok()
                }
                _ => None,
            };
            let Some(payload) = payload else {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            };

            if let Some(expected) = probe.expected_model {
                if !super::llamacpp::model_identity_matches(expected, &payload) {
                    let served = super::llamacpp::served_model_ids(&payload);
                    anyhow::bail!(
                        "{engine} served model mismatch: expected '{expected}', got [{}]",
                        served.join(", ")
                    );
                }
            }

            // The answer must come from the child we spawned, not a listener
            // that outlived it.
            if is_alive() {
                return Ok(());
            }
        }
    };

    tokio::time::timeout(probe.timeout, poll)
        .await
        .with_context(|| {
            format!(
                "{engine} did not become ready within {}s",
                probe.timeout.as_secs()
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Json, http::StatusCode, routing::get, Router};
    use serde_json::json;
    use tokio::net::TcpListener;

    async fn openai_fixture(models: serde_json::Value) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture");
        let port = listener.local_addr().expect("fixture address").port();
        let models = Arc::new(models);
        let app = Router::new()
            .route("/health", get(|| async { StatusCode::OK }))
            .route(
                "/v1/models",
                get(move || {
                    let models = Arc::clone(&models);
                    async move { Json((*models).clone()) }
                }),
            );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (port, task)
    }

    fn probe(port: u16, expected_model: Option<&str>) -> ReadyProbe<'_> {
        ReadyProbe {
            engine: "vllm",
            port,
            health_path: Some("/health"),
            expected_model,
            timeout: Duration::from_secs(5),
        }
    }

    #[tokio::test]
    async fn occupied_port_is_refused_before_spawn() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().unwrap().port();
        let error = ensure_port_free("vllm", port)
            .await
            .expect_err("a held port must be refused");
        assert!(error.to_string().contains("already in use"));
        drop(listener);
        ensure_port_free("vllm", port)
            .await
            .expect("a released port is free");
    }

    #[tokio::test]
    async fn ready_when_the_live_child_lists_the_expected_model() {
        let (port, fixture) =
            openai_fixture(json!({ "data": [{ "id": "Qwen/Qwen2.5-1.5B-Instruct" }] })).await;
        wait_until_ready(
            &reqwest::Client::new(),
            &probe(port, Some("Qwen/Qwen2.5-1.5B-Instruct")),
            || true,
            String::new,
        )
        .await
        .expect("matching model should be ready");
        fixture.abort();
    }

    #[tokio::test]
    async fn stale_listener_serving_another_model_is_rejected() {
        let (port, fixture) = openai_fixture(json!({ "data": [{ "id": "other/model" }] })).await;
        let error = wait_until_ready(
            &reqwest::Client::new(),
            &probe(port, Some("Qwen/Qwen2.5-1.5B-Instruct")),
            || true,
            String::new,
        )
        .await
        .expect_err("a different model must not satisfy readiness");
        assert!(error.to_string().contains("served model mismatch"));
        fixture.abort();
    }

    #[tokio::test]
    async fn exited_child_fails_fast_with_its_stderr_tail() {
        // A listener answers, but the child we spawned is gone: never ready.
        let (port, fixture) = openai_fixture(json!({ "data": [] })).await;
        let tail = StderrTail::default();
        tail.push("OSError: [Errno 48] Address already in use");
        let started = std::time::Instant::now();
        let error = wait_until_ready(
            &reqwest::Client::new(),
            &probe(port, None),
            || false,
            || tail.snapshot(),
        )
        .await
        .expect_err("an exited child must not satisfy readiness");
        assert!(started.elapsed() < Duration::from_secs(2));
        let message = error.to_string();
        assert!(message.contains("exited before becoming ready"));
        assert!(message.contains("Address already in use"));
        fixture.abort();
    }

    #[tokio::test]
    async fn silent_port_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut probe = probe(port, None);
        probe.timeout = Duration::from_millis(600);
        let error = wait_until_ready(&reqwest::Client::new(), &probe, || true, String::new)
            .await
            .expect_err("no server must time out");
        assert!(error.to_string().contains("did not become ready"));
    }

    #[test]
    fn stderr_tail_keeps_only_the_latest_lines() {
        let tail = StderrTail::default();
        for index in 0..(STDERR_TAIL_LINES + 5) {
            tail.push(&format!("line {index}"));
        }
        let snapshot = tail.snapshot();
        assert!(!snapshot.contains("line 4\n"));
        assert!(snapshot.starts_with("line 5"));
        assert!(snapshot.ends_with(&format!("line {}", STDERR_TAIL_LINES + 4)));
    }
}
