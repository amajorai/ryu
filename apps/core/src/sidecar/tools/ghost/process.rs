//! Managed child process for the Ghost sidecar (MCP stdio server).

use std::path::PathBuf;

use anyhow::Result;
use tokio::process::Command;

use crate::sidecar::tools::supervised_child::SupervisedChild;

// ── Paths ──────────────────────────────────────────────────────────────────────

fn ghost_dir() -> PathBuf {
    super::data_dir()
}

fn pid_path() -> PathBuf {
    ghost_dir().join("ghost.pid")
}

// ── GhostProcess ───────────────────────────────────────────────────────────────

pub struct GhostProcess {
    child: SupervisedChild,
    binary_path: PathBuf,
}

impl GhostProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            child: SupervisedChild::new("ghost", pid_path()),
            binary_path,
        }
    }

    /// Spawn `ghost mcp` and begin forwarding its stdio to tracing.
    pub async fn start(&mut self) -> Result<()> {
        self.child.begin_start(&self.binary_path).await;

        let mut command = Command::new(&self.binary_path);
        command.args(["mcp"]);
        // Ghost's state lives in the profile-aware data dir: `services/ghost` (also
        // its working dir) and `models/vision/ghost`, so a dev and a release Ghost
        // keep their own recipes. Ghost reads both env vars (`ghost_core::paths`).
        let data_dir = ghost_dir();
        tokio::fs::create_dir_all(&data_dir).await?;
        command
            .current_dir(&data_dir)
            .env("RYU_DIR", crate::paths::ryu_dir())
            .env("GHOST_DATA_DIR", &data_dir)
            .env("GHOST_MODELS_DIR", super::models_dir());
        // Ghost's own component subkey (HKDF of the master key, never the master
        // key). Ghost captures it into memory before any thread starts and never
        // forwards it to a child.
        if let Err(error) = apply_seal_env(&mut command) {
            tracing::warn!("ghost: no seal key for the child ({error})");
        }

        self.child
            .spawn(
                &mut command,
                |line| tracing::info!(target: "ghost", "{line}"),
                |line| tracing::warn!(target: "ghost", "{line}"),
            )
            .await
    }

    /// Gracefully stop the process: SIGTERM → 5 s wait → SIGKILL.
    pub async fn stop(&mut self) -> Result<()> {
        self.child.stop().await
    }

    /// Returns true if the child process is still alive.
    pub fn is_running(&mut self) -> bool {
        self.child.is_running()
    }
}

/// Give the ghost child its component subkey and nothing else: every
/// key-carrying variable inherited from Core (`RYU_MASTER_KEY` above all) is
/// removed first, so the child's initial environment block, which stays in
/// `/proc/<pid>/environ` whatever it later unsets, never holds the master key.
fn apply_seal_env(command: &mut Command) -> anyhow::Result<()> {
    for name in ryu_crypto::SEAL_ENV_VARS {
        command.env_remove(name);
    }
    command.envs(ryu_crypto::component_child_env(
        ryu_crypto::components::GHOST,
    )?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::tools::supervised_child::ProcessState;

    /// Core keeps `RYU_MASTER_KEY` in its own environment (headless setups);
    /// the ghost child must start with that variable removed and only its
    /// component subkey and scope set.
    #[test]
    fn child_env_drops_the_master_key_and_carries_only_the_subkey() {
        crate::server::gateway_seal_test_key();
        let master = std::env::var("RYU_MASTER_KEY").expect("test master key set");
        let mut command = Command::new("/bin/true");
        apply_seal_env(&mut command).expect("a key is available");
        let envs: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("RYU_MASTER_KEY"),
            Some(&None),
            "RYU_MASTER_KEY must be removed from the child"
        );
        assert_eq!(
            envs.get("RYU_SEAL_SCOPE"),
            Some(&Some("component:ghost".to_owned()))
        );
        let subkey = envs
            .get("RYU_SEAL_KEY")
            .cloned()
            .flatten()
            .expect("subkey delivered");
        assert_ne!(subkey, master);
        assert!(envs
            .values()
            .flatten()
            .all(|value| !value.contains(&master)));
    }

    // NOTE: these cover only the pure state-machine defaults and path helpers.
    // `start`/`stop` are deliberately NOT exercised — they spawn or signal real
    // processes, which a unit test must never do. The orphan identity checks are
    // covered in `sidecar::tools::orphan`.

    #[test]
    fn new_starts_in_stopped_state_with_no_child() {
        let mut proc = GhostProcess::new(PathBuf::from("/bin/ghost"));
        assert_eq!(proc.child.state(), &ProcessState::Stopped);
        // No child was spawned, so it is not running and the state is unchanged.
        assert!(!proc.is_running());
        assert_eq!(proc.child.state(), &ProcessState::Stopped);
    }

    #[test]
    fn pid_path_lives_under_the_ghost_dir() {
        let path = pid_path();
        assert!(path.ends_with("ghost.pid"));
        assert_eq!(path.parent().unwrap(), ghost_dir());
        assert!(ghost_dir().ends_with("services/ghost"));
    }
}
