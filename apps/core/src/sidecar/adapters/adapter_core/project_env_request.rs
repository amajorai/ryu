use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlatformScripts {
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub macos: String,
    #[serde(default)]
    pub linux: String,
    #[serde(default)]
    pub windows: String,
}

impl PlatformScripts {
    pub(crate) fn current(&self) -> Option<&str> {
        #[cfg(target_os = "macos")]
        let platform = &self.macos;
        #[cfg(target_os = "linux")]
        let platform = &self.linux;
        #[cfg(target_os = "windows")]
        let platform = &self.windows;
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let platform = &self.default;
        let selected = if platform.trim().is_empty() {
            &self.default
        } else {
            platform
        };
        (!selected.trim().is_empty()).then_some(selected.as_str())
    }

    fn is_non_empty(&self) -> bool {
        [
            self.default.as_str(),
            self.macos.as_str(),
            self.linux.as_str(),
            self.windows.as_str(),
        ]
        .iter()
        .any(|script| !script.trim().is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEnvironmentVariable {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectEnvironmentRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub setup: PlatformScripts,
    #[serde(default)]
    pub cleanup: PlatformScripts,
    #[serde(default)]
    pub variables: Vec<ProjectEnvironmentVariable>,
}

impl ProjectEnvironmentRequest {
    pub(crate) fn contains_scripts(&self) -> bool {
        self.setup.is_non_empty() || self.cleanup.is_non_empty()
    }
}

fn valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

pub(crate) fn reserved_environment_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "RYU_TOKEN" | "RYU_PROJECT_PATH" | "RYU_WORKTREE_PATH" | "PI_CODING_AGENT_DIR"
    ) || upper.starts_with("RYU_MCP_")
        // Core's managed-Pi contract (`RYU_PI_ACTIVE_TOOLS` tool scope, the host
        // conversation id the Gateway headers carry). A project must not widen
        // or re-key them.
        || upper.starts_with("RYU_PI_")
        || upper.starts_with("OPENAI_")
        || upper.starts_with("ANTHROPIC_")
}

pub(crate) fn request_environment_variables(req: &ChatStreamRequest) -> Vec<(String, String)> {
    req.project_environment
        .as_ref()
        .map(|environment| {
            environment
                .variables
                .iter()
                .filter_map(|variable| {
                    let key = variable.key.trim();
                    (valid_environment_key(key) && !reserved_environment_key(key))
                        .then(|| (key.to_owned(), variable.value.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Default for [`ChatStreamRequest::persist`] — normal turns persist.
pub(crate) fn default_persist() -> bool {
    true
}
