//! Bounded capture at sandbox process and provider boundaries.
use anyhow::{ensure, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub(crate) const CAPTURE_LIMIT: usize = 4 * 1024 * 1024;

/// Keep workspace teardown alive when an execution future is cancelled.
pub struct WorkspaceCleanup {
    cleanup: Option<crate::BoxFuture<Result<()>>>,
}

impl WorkspaceCleanup {
    pub fn new(cleanup: crate::BoxFuture<Result<()>>) -> Self {
        Self {
            cleanup: Some(cleanup),
        }
    }
    pub fn disarm(&mut self) {
        self.cleanup = None;
    }
    pub async fn finish(&mut self) -> Result<()> {
        let Some(cleanup) = self.cleanup.as_mut() else {
            return Ok(());
        };
        let result = cleanup.await;
        self.cleanup = None;
        result
    }
}

impl Drop for WorkspaceCleanup {
    fn drop(&mut self) {
        let Some(cleanup) = self.cleanup.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if !matches!(
                    tokio::time::timeout(std::time::Duration::from_secs(90), cleanup).await,
                    Ok(Ok(()))
                ) {
                    tracing::warn!("cancelled sandbox workspace teardown did not complete");
                }
            });
        } else {
            tracing::warn!("cancelled sandbox workspace teardown has no runtime");
        }
    }
}

pub(crate) trait BoundedCommand {
    fn bounded_output(
        &mut self,
    ) -> impl std::future::Future<Output = Result<std::process::Output>> + Send;
}

impl BoundedCommand for tokio::process::Command {
    fn bounded_output(
        &mut self,
    ) -> impl std::future::Future<Output = Result<std::process::Output>> + Send {
        let owned = std::mem::replace(self, tokio::process::Command::new("unused"));
        command(owned, None, Some(30))
    }
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        ensure!(
            bytes.len() + count <= CAPTURE_LIMIT,
            "sandbox output exceeded capture limit"
        );
        bytes.extend_from_slice(&chunk[..count]);
    }
}

pub(crate) async fn command(
    mut command: tokio::process::Command,
    stdin: Option<Vec<u8>>,
    timeout_secs: Option<u64>,
) -> Result<std::process::Output> {
    use std::process::Stdio;
    let seconds = crate::process_output::execution_timeout(timeout_secs, 120)?;
    command
        .kill_on_drop(true)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let writer = child.stdin.take();
    let run = async {
        let write = async {
            if let (Some(mut writer), Some(bytes)) = (writer, stdin) {
                writer.write_all(&bytes).await?;
                writer.shutdown().await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        let (stdout, stderr, _, status) =
            tokio::try_join!(read_bounded(stdout), read_bounded(stderr), write, async {
                Ok::<_, anyhow::Error>(child.wait().await?)
            })?;
        Ok::<_, anyhow::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(seconds), run).await;
    match result {
        Ok(Ok(output)) => Ok(output),
        error => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            match error {
                Ok(Err(error)) => Err(error),
                Err(_) => anyhow::bail!("sandbox command timed out"),
                Ok(Ok(_)) => unreachable!(),
            }
        }
    }
}

pub(crate) async fn response_text(mut response: reqwest::Response) -> Result<String> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= CAPTURE_LIMIT as u64),
        "sandbox provider response exceeded capture limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= CAPTURE_LIMIT,
            "sandbox provider response exceeded capture limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_keeps_teardown_alive_and_success_disarms_it() {
        let (ready, started) = tokio::sync::oneshot::channel();
        let (done, destroyed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _cleanup = WorkspaceCleanup::new(Box::pin(async move {
                let _ = done.send(());
                Ok(())
            }));
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(1), destroyed)
            .await
            .unwrap()
            .unwrap();
        let (done, destroyed) = tokio::sync::oneshot::channel();
        let mut cleanup = WorkspaceCleanup::new(Box::pin(async move {
            let _ = done.send(());
            Ok(())
        }));
        cleanup.disarm();
        drop(cleanup);
        assert!(destroyed.await.is_err());
    }
    #[tokio::test]
    async fn captures_control_and_rejects_overflow() {
        assert_eq!(read_bounded(&b"hello"[..]).await.unwrap(), b"hello");
        assert!(read_bounded(&vec![0; CAPTURE_LIMIT + 1][..]).await.is_err());
    }
    #[tokio::test]
    async fn rejects_streaming_overflow() {
        let (mut writer, reader) = tokio::io::duplex(8192);
        let task = tokio::spawn(async move {
            let _ = writer.write_all(&vec![0; CAPTURE_LIMIT + 1]).await;
        });
        assert!(read_bounded(reader).await.is_err());
        task.await.unwrap();
    }
    fn shell(source: &str) -> tokio::process::Command {
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", source]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", source]);
            command
        };
        crate::win_process::NoWindow::no_window(&mut command);
        command
    }
    #[tokio::test]
    async fn command_control_and_timeout() {
        #[cfg(windows)]
        let source = "[Console]::Write('control'); [Console]::Error.Write('error')";
        #[cfg(not(windows))]
        let source = "printf control; printf error >&2";
        let output = command(shell(source), None, Some(5)).await.unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"control");
        assert_eq!(output.stderr, b"error");
        #[cfg(windows)]
        let source = "Start-Sleep -Seconds 30";
        #[cfg(not(windows))]
        let source = "exec sleep 30";
        let start = std::time::Instant::now();
        assert!(command(shell(source), None, Some(1))
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out"));
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }
    #[tokio::test]
    async fn command_stream_overflow_terminates() {
        #[cfg(windows)]
        let source =
            "$chunk = 'x' * 8192; for ($i=0; $i -lt 1000; $i++) { [Console]::Write($chunk) }";
        #[cfg(not(windows))]
        let source = "head -c 8388608 /dev/zero";
        assert!(command(shell(source), None, Some(10))
            .await
            .unwrap_err()
            .to_string()
            .contains("capture limit"));
    }
    #[tokio::test]
    async fn http_declared_and_streaming_limits() {
        use std::io::{Read, Write};
        for declared in [true, false] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request);
                let header = if declared {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        CAPTURE_LIMIT + 1
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".into()
                };
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&vec![b'x'; CAPTURE_LIMIT + 1]);
            });
            let response = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            assert!(response_text(response)
                .await
                .unwrap_err()
                .to_string()
                .contains("capture limit"));
            // Let the async client finish closing a rejected response before
            // waiting for the fixture's blocking body writer.
            tokio::task::spawn_blocking(move || server.join())
                .await
                .unwrap()
                .unwrap();
        }
    }
}
