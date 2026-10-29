use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum InstallState {
    NotInstalled,
    Installing {
        started_at: DateTime<Utc>,
    },
    Installed {
        version: String,
        installed_at: DateTime<Utc>,
    },
    Failed {
        error: String,
        failed_at: DateTime<Utc>,
    },
}

impl Default for InstallState {
    fn default() -> Self {
        Self::NotInstalled
    }
}

/// How long an in-flight install claim holds before it is presumed abandoned.
/// Generous: a CUDA llama.cpp build or a multi-GB model on a slow link is slow.
const STALE_INSTALL_AFTER: chrono::Duration = chrono::Duration::hours(3);

#[derive(Debug, Clone)]
pub struct InstallStatusStore {
    states: Arc<RwLock<HashMap<String, InstallState>>>,
}

impl InstallStatusStore {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn get(&self, name: &str) -> InstallState {
        let states = self.states.read().await;
        states.get(name).cloned().unwrap_or_default()
    }

    pub async fn get_all(&self) -> HashMap<String, InstallState> {
        let states = self.states.read().await;
        states.clone()
    }

    pub async fn set_installing(&self, name: &str) {
        let mut states = self.states.write().await;
        states.insert(
            name.to_string(),
            InstallState::Installing {
                started_at: Utc::now(),
            },
        );
    }

    /// Atomically claim `name` for an install: `false` when one is already in
    /// flight, so a second request (a double-clicked Update, or two surfaces at
    /// once) cannot run a parallel installer that clears the version record and
    /// re-extracts over the first.
    ///
    /// A claim older than [`STALE_INSTALL_AFTER`] is treated as abandoned (its
    /// task died without reporting), so a lost task can never block installs
    /// forever.
    pub async fn try_begin_installing(&self, name: &str) -> bool {
        let mut states = self.states.write().await;
        if let Some(InstallState::Installing { started_at }) = states.get(name) {
            if Utc::now().signed_duration_since(*started_at) < STALE_INSTALL_AFTER {
                return false;
            }
        }
        states.insert(
            name.to_string(),
            InstallState::Installing {
                started_at: Utc::now(),
            },
        );
        true
    }

    pub async fn set_installed(&self, name: &str, version: String) {
        let mut states = self.states.write().await;
        states.insert(
            name.to_string(),
            InstallState::Installed {
                version,
                installed_at: Utc::now(),
            },
        );
    }

    pub async fn set_failed(&self, name: &str, error: String) {
        let mut states = self.states.write().await;
        states.insert(
            name.to_string(),
            InstallState::Failed {
                error,
                failed_at: Utc::now(),
            },
        );
    }

    pub async fn clear(&self, name: &str) {
        let mut states = self.states.write().await;
        states.remove(name);
    }
}

impl Default for InstallStatusStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn try_begin_installing_admits_one_claim_at_a_time() {
        let store = InstallStatusStore::new();
        assert!(store.try_begin_installing("whisper").await);
        assert!(!store.try_begin_installing("whisper").await);
        // A claim is per artifact.
        assert!(store.try_begin_installing("piper").await);
    }

    #[tokio::test]
    async fn try_begin_installing_reclaims_after_the_install_ends() {
        let store = InstallStatusStore::new();
        assert!(store.try_begin_installing("whisper").await);
        store.set_failed("whisper", "boom".to_string()).await;
        assert!(store.try_begin_installing("whisper").await);
        store.set_installed("whisper", "1.0.0".to_string()).await;
        assert!(store.try_begin_installing("whisper").await);
    }

    #[tokio::test]
    async fn try_begin_installing_reclaims_an_abandoned_claim() {
        let store = InstallStatusStore::new();
        let fresh = Utc::now() - (STALE_INSTALL_AFTER - chrono::Duration::minutes(5));
        store.states.write().await.insert(
            "whisper".to_string(),
            InstallState::Installing { started_at: fresh },
        );
        assert!(!store.try_begin_installing("whisper").await);

        let stale = Utc::now() - (STALE_INSTALL_AFTER + chrono::Duration::minutes(1));
        store.states.write().await.insert(
            "whisper".to_string(),
            InstallState::Installing { started_at: stale },
        );
        assert!(store.try_begin_installing("whisper").await);
        let InstallState::Installing { started_at } = store.get("whisper").await else {
            panic!("a reclaimed install must be in flight");
        };
        assert!(started_at > stale);
    }
}
