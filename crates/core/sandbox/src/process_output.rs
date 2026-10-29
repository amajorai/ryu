//! Bounded host-side capture for sandbox CLI children.

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::timeout;

const MAX_STREAM_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(crate) const MAX_TIMEOUT_SECS: u64 = 300;

pub(crate) fn execution_timeout(timeout_secs: Option<u64>, default_secs: u64) -> Result<u64> {
    let seconds = timeout_secs.unwrap_or(default_secs);
    anyhow::ensure!(
        (1..=MAX_TIMEOUT_SECS).contains(&seconds),
        "sandbox timeout must be between 1 and {MAX_TIMEOUT_SECS} seconds"
    );
    Ok(seconds)
}

async fn read_capped(reader: impl AsyncRead + Unpin, label: &str) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_STREAM_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_STREAM_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{label} output exceeded the 4 MiB stream limit"),
        ));
    }
    Ok(bytes)
}

pub(crate) async fn output_capped(
    cmd: &mut Command,
    input: Option<Vec<u8>>,
    timeout_secs: Option<u64>,
    label: &str,
) -> Result<std::process::Output> {
    let secs = execution_timeout(timeout_secs, DEFAULT_TIMEOUT_SECS)?;
    cmd.stdin(if input.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("{label} spawn failed: {e}"))?;
    let mut stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("{label} stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("{label} stderr unavailable"))?;
    let run = async {
        let write = async {
            if let (Some(mut writer), Some(bytes)) = (stdin.take(), input) {
                writer.write_all(&bytes).await?;
            }
            Ok::<(), std::io::Error>(())
        };
        tokio::try_join!(
            child.wait(),
            read_capped(stdout, label),
            read_capped(stderr, label),
            write
        )
    };
    let result = match timeout(Duration::from_secs(secs), run).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(anyhow!("{label} timed out after {secs}s"));
        }
    };
    match result {
        Ok((status, stdout, stderr, ())) => Ok(std::process::Output {
            status,
            stdout,
            stderr,
        }),
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_bounded_and_unsafe_timeouts_are_rejected() {
        assert_eq!(execution_timeout(None, 30).unwrap(), 30);
        assert_eq!(execution_timeout(None, 120).unwrap(), 120);
        assert_eq!(execution_timeout(Some(1), 30).unwrap(), 1);
        assert_eq!(execution_timeout(Some(300), 30).unwrap(), 300);
        for value in [0, 301, u64::MAX] {
            assert!(execution_timeout(Some(value), 120).is_err());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn omitted_timeout_terminates_a_quiet_child() {
        let mut child = Command::new("sh");
        child
            .args(["-c", "exec sleep 120"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let started = std::time::Instant::now();
        let error = output_capped(&mut child, None, None, "test")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out after 30s"));
        assert!(started.elapsed() < Duration::from_secs(35));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_timeout_before_spawn_and_preserves_normal_output() {
        let mut invalid = Command::new("definitely-not-a-real-command");
        assert!(output_capped(&mut invalid, None, Some(u64::MAX), "test")
            .await
            .unwrap_err()
            .to_string()
            .contains("timeout must"));
        let mut ordinary = Command::new("sh");
        ordinary.args(["-c", "printf ordinary"]);
        let output = output_capped(&mut ordinary, None, None, "test")
            .await
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ordinary");
    }
}
