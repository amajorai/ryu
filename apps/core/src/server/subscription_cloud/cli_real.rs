//! Production [`super::cli::CliRunner`] that spawns provider CLIs on the node.

use super::cli_child_env::child_env;
use super::Provider;
use super::{CliFailure, CliOutput, CliRunner, Invocation, Streaming};
use std::path::PathBuf;
use std::time::Duration;

/// How much stderr a streaming call keeps (the end, where the error is).
const STREAM_STDERR_TAIL: usize = 16 * 1024;

pub(crate) struct RealCli;

impl RealCli {
    fn command(invocation: &Invocation) -> Result<tokio::process::Command, CliFailure> {
        let program =
            crate::sidecar::manifest_sidecar::which_on_path(invocation.provider.program())
                .ok_or(CliFailure::NotInstalled)?;
        Ok(Self::command_for(program, invocation))
    }

    /// The child command for `program`: the allowlisted environment, then the account's
    /// own config folder.
    pub(in crate::server::subscription_cloud) fn command_for(
        program: PathBuf,
        invocation: &Invocation,
    ) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(program);
        command
            .args(&invocation.args)
            .env_clear()
            .envs(child_env(std::env::vars()))
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        // Last, so a linked account's folder replaces any inherited default.
        if let Some(dir) = &invocation.account_dir {
            let name = super::super::accounts::ProviderId::from(invocation.provider).config_env();
            command.env(name, dir);
        }
        if let Some(cwd) = &invocation.cwd {
            command.current_dir(cwd);
        }
        if invocation.provider == Provider::Anthropic {
            crate::claude_config::apply_to_provider_cli_command(
                &mut command,
                invocation.account_dir.as_deref(),
            );
        }
        command
    }

    fn spawn_stream_inner(invocation: &Invocation) -> Result<Streaming, CliFailure> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = Self::command(invocation)?
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        let stdout = child.stdout.take().ok_or(CliFailure::Io("stdout".into()))?;
        let stderr = child.stderr.take().ok_or(CliFailure::Io("stderr".into()))?;
        let (line_tx, lines) = tokio::sync::mpsc::channel(256);
        let (exit_tx, exit) = tokio::sync::oneshot::channel();
        let (kill, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
        let timeout = invocation.timeout;
        tokio::spawn(async move {
            // Drain stderr to the end so the child never blocks on a full pipe; keep the tail.
            let stderr_tail = tokio::spawn(async move {
                let mut tail = String::new();
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > STREAM_STDERR_TAIL * 2 {
                        let cut = tail.len() - STREAM_STDERR_TAIL;
                        let cut = (cut..tail.len())
                            .find(|index| tail.is_char_boundary(*index))
                            .unwrap_or(tail.len());
                        tail.drain(..cut);
                    }
                }
                tail
            });
            let mut out = BufReader::new(stdout).lines();
            let pump = async {
                while let Ok(Some(line)) = out.next_line().await {
                    if line_tx.send(line).await.is_err() {
                        break;
                    }
                }
            };
            let stopped = tokio::select! {
                () = pump => false,
                Ok(()) = &mut kill_rx => true,
                () = tokio::time::sleep(timeout) => true,
            };
            if stopped {
                let _ = child.start_kill();
            }
            let code = child.wait().await.ok().and_then(|status| status.code());
            let stderr = stderr_tail.await.unwrap_or_default();
            let _ = exit_tx.send(CliOutput {
                exit_code: if stopped { None } else { code },
                stdout: String::new(),
                stderr,
            });
        });
        Ok(Streaming { lines, exit, kill })
    }
}

#[async_trait::async_trait]
impl CliRunner for RealCli {
    fn installed(&self, provider: Provider) -> bool {
        crate::sidecar::manifest_sidecar::which_on_path(provider.program()).is_some()
    }

    async fn run(&self, invocation: Invocation) -> Result<CliOutput, CliFailure> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = Self::command(&invocation)?
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        let stdout = child.stdout.take().ok_or(CliFailure::Io("stdout".into()))?;
        let stderr = child.stderr.take().ok_or(CliFailure::Io("stderr".into()))?;
        let mut out_lines = BufReader::new(stdout).lines();
        let mut err_lines = BufReader::new(stderr).lines();
        let mut output = CliOutput::default();
        let collect = async {
            let (mut out_open, mut err_open) = (true, true);
            while out_open || err_open {
                tokio::select! {
                    line = out_lines.next_line(), if out_open => match line {
                        Ok(Some(line)) => {
                            let stop = invocation.stop_when.is_some_and(|stop| stop(&line));
                            output.stdout.push_str(&line);
                            output.stdout.push('\n');
                            if stop {
                                return true;
                            }
                        }
                        _ => out_open = false,
                    },
                    line = err_lines.next_line(), if err_open => match line {
                        Ok(Some(line)) => {
                            output.stderr.push_str(&line);
                            output.stderr.push('\n');
                        }
                        _ => err_open = false,
                    },
                }
            }
            false
        };
        match tokio::time::timeout(invocation.timeout, collect).await {
            Ok(true) => {
                // The id is out; the session exists. Leave the provisioning checklist.
                let _ = child.start_kill();
                Ok(output)
            }
            Ok(false) => {
                let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
                    .await
                    .map_err(|_| CliFailure::TimedOut)?
                    .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
                output.exit_code = status.code();
                Ok(output)
            }
            Err(_) => {
                let _ = child.start_kill();
                Err(CliFailure::TimedOut)
            }
        }
    }

    fn spawn_detached(&self, invocation: Invocation) -> Result<(), CliFailure> {
        let mut command = Self::command(&invocation)?;
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(false);
        let mut child = command
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        // Reap it whenever the user finishes (or abandons) the provider's sign-in page.
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(15 * 60), child.wait()).await;
            let _ = child.start_kill();
        });
        Ok(())
    }

    fn spawn_stream(&self, invocation: Invocation) -> Result<Streaming, CliFailure> {
        Self::spawn_stream_inner(&invocation)
    }
}

#[cfg(test)]
mod tests {
    use super::super::status_invocation;
    use super::*;

    fn entrypoint_of(command: &tokio::process::Command) -> Option<String> {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    #[test]
    fn only_the_claude_cli_is_labeled_with_the_ryu_entrypoint() {
        // An account folder pins the config dir, so the developer's own
        // `~/.claude/settings.json` cannot change the result.
        let account = tempfile::tempdir().unwrap();
        let mut anthropic = status_invocation(Provider::Anthropic);
        anthropic.account_dir = Some(account.path().to_path_buf());
        let command = RealCli::command_for("/bin/true".into(), &anthropic);
        assert_eq!(
            entrypoint_of(&command).as_deref(),
            Some(crate::claude_config::DEFAULT_CLAUDE_CODE_ENTRYPOINT)
        );

        let mut openai = status_invocation(Provider::Openai);
        openai.account_dir = Some(account.path().to_path_buf());
        let command = RealCli::command_for("/bin/true".into(), &openai);
        assert_eq!(entrypoint_of(&command), None);
    }

    #[test]
    fn the_linked_account_settings_json_label_wins() {
        let account = tempfile::tempdir().unwrap();
        std::fs::write(
            account.path().join("settings.json"),
            r#"{"env":{"CLAUDE_CODE_ENTRYPOINT":"from-settings"}}"#,
        )
        .unwrap();
        let mut invocation = status_invocation(Provider::Anthropic);
        invocation.account_dir = Some(account.path().to_path_buf());
        let command = RealCli::command_for("/bin/true".into(), &invocation);
        assert_eq!(entrypoint_of(&command).as_deref(), Some("from-settings"));
    }
}
