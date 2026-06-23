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
