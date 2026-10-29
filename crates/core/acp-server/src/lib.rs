//! ACP **server** mode for Ryu: an Agent Client Protocol agent that an ACP
//! editor (Zed and others) launches over stdio to drive Ryu agents.
//!
//! Core already speaks ACP as a *client* (it drives Claude Code, Codex, Gemini,
//! … through `sidecar/adapters/acp.rs`). This crate is the opposite direction:
//! the editor is the ACP client and Ryu is the agent. It is a thin protocol
//! translator in front of a **running** Core:
//!
//! | ACP                         | Core HTTP API                                 |
//! |-----------------------------|-----------------------------------------------|
//! | `initialize`                | `GET /api/health` (reachability)              |
//! | `session/new`               | `GET /api/agents` (agent → session modes)     |
//! | `session/load`              | `GET /api/conversations/:id` (history replay) |
//! | `session/set_mode`          | — (switches the agent for later turns)        |
//! | `session/prompt`            | `POST /api/chat/stream` (AI SDK UI SSE)       |
//! | `session/cancel`            | `POST /api/chat/cancel`                       |
//! | `session/request_permission`| ← `data-ryu-permission`, → `POST /api/chat/permission` |
//!
//! It never opens Core's stores and never starts a second Core: authentication
//! is the same local node token every other local surface presents. Stdout
//! carries only JSON-RPC frames; diagnostics go to stderr.

mod core_http;
mod endpoint;
mod server;
mod sse;

pub use endpoint::{CliOptions, CoreEndpoint, USAGE};
pub use server::{serve, serve_until, ServerConfig};

use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Run the ACP agent on this process's stdin/stdout until the client hangs up.
///
/// Installs a stderr-only tracing subscriber first so nothing but protocol frames
/// can ever reach stdout. The filter follows `RUST_LOG` and defaults to `warn`.
/// The protocol crate fails pending requests on input EOF but does not end the
/// `connect_with` foreground, so stdin EOF is detected here and ends the process
/// (after stopping in-flight runs).
pub async fn run_stdio(config: ServerConfig) -> Result<(), agent_client_protocol::Error> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    let (eof_tx, eof_rx) = tokio::sync::oneshot::channel();
    let stdin = EofSignallingReader {
        inner: tokio::io::stdin(),
        eof: Some(eof_tx),
    };
    let transport =
        agent_client_protocol::ByteStreams::new(tokio::io::stdout().compat_write(), stdin.compat());
    serve_until(config, transport, async move {
        let _ = eof_rx.await;
    })
    .await
}

/// Passes reads through and fires `eof` the first time the input ends.
struct EofSignallingReader<R> {
    inner: R,
    eof: Option<tokio::sync::oneshot::Sender<()>>,
}

impl<R: AsyncRead + Unpin> AsyncRead for EofSignallingReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let wanted = buf.remaining();
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        let ended =
            matches!(poll, Poll::Ready(Ok(()))) && wanted > 0 && buf.filled().len() == before;
        let failed = matches!(poll, Poll::Ready(Err(_)));
        if ended || failed {
            if let Some(eof) = self.eof.take() {
                let _ = eof.send(());
            }
        }
        poll
    }
}
