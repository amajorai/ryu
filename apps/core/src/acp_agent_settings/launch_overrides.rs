use std::path::{Path, PathBuf};

use serde_json::Value;

use super::*;

/// Which agent-specific knob mapping applies to a spawn declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpAgentKind {
    ClaudeCode,
    Codex,
    Other,
}

impl AcpAgentKind {
    /// Classify from the spawn declaration Core resolved BEFORE any user
    /// override, so a custom command cannot change which mapping applies.
    pub fn of_spawn(spawn_cmd: &str) -> Self {
        let lowered = spawn_cmd.to_ascii_lowercase();
        if lowered.contains("claude-agent-acp") || lowered.contains("claude-code-acp") {
            Self::ClaudeCode
        } else if lowered.contains("codex-acp") {
            Self::Codex
        } else {
            Self::Other
        }
    }
}

/// The launch changes [`AcpAgentSettings`] resolve to for one agent kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchOverrides {
    /// Replacement program. When set, the default arguments are dropped.
    pub command: Option<PathBuf>,
    /// Arguments appended after the (kept or dropped) default arguments.
    pub args: Vec<String>,
    /// Environment to add. Names Core already declared are never replaced.
    pub env: Vec<(String, String)>,
}

impl LaunchOverrides {
    pub fn is_empty(&self) -> bool {
        self.command.is_none() && self.args.is_empty() && self.env.is_empty()
    }
}

fn absolute_path(field: &str, value: &str) -> anyhow::Result<String> {
    if !Path::new(value).is_absolute() {
        anyhow::bail!("ACP agent setting `{field}` must be an absolute path, got `{value}`");
    }
    Ok(value.to_owned())
}

/// Resolve user settings into concrete launch changes for an agent of `kind`.
pub fn launch_overrides(
    settings: &AcpAgentSettings,
    kind: AcpAgentKind,
) -> anyhow::Result<LaunchOverrides> {
    let command = settings.command.as_deref().map(PathBuf::from);
    if kind == AcpAgentKind::Codex {
        // Codex is wrapped in Ryu's deletion-containment runner, which recognizes
        // it by name (`agent_sandbox::confine_codex_stdio`). A renamed program
        // would silently skip that boundary, so refuse it instead.
        if let Some(command) = command.as_ref() {
            let name = command
                .file_name()
                .map(|name| name.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !name.contains("codex") {
                anyhow::bail!(
                    "a custom Codex command must be a codex-acp executable (its file name must contain `codex`) so Ryu's deletion boundary still applies"
                );
            }
        }
    }

    let mut args = settings.args.clone();
    let mut env: Vec<(String, String)> = settings
        .env
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let mut set = |name: &str, value: String| {
        env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        env.push((name.to_owned(), value));
    };

    match kind {
        AcpAgentKind::ClaudeCode => {
            if let Some(dir) = settings.config_dir.as_deref() {
                set("CLAUDE_CONFIG_DIR", absolute_path("configDir", dir)?);
            }
            if let Some(cli) = settings.cli_path.as_deref() {
                set("CLAUDE_CODE_EXECUTABLE", absolute_path("cliPath", cli)?);
            }
            if settings.auto_compact == Some(false) {
                set("DISABLE_AUTO_COMPACT", "1".to_owned());
            }
            if let Some(tokens) = settings.auto_compact_tokens {
                let window = tokens.clamp(
                    CLAUDE_AUTO_COMPACT_WINDOW_MIN,
                    CLAUDE_AUTO_COMPACT_WINDOW_MAX,
                );
                set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", window.to_string());
            }
        }
        AcpAgentKind::Codex => {
            if let Some(dir) = settings.config_dir.as_deref() {
                // Core always declares CODEX_HOME for Codex, so this only takes
                // effect if that ever stops being true; it is still validated.
                set("CODEX_HOME", absolute_path("configDir", dir)?);
            }
            if let Some(tokens) = settings.auto_compact_tokens.filter(|tokens| *tokens > 0) {
                args.push("-c".to_owned());
                args.push(format!("model_auto_compact_token_limit={tokens}"));
            }
        }
        AcpAgentKind::Other => {}
    }

    Ok(LaunchOverrides { command, args, env })
}

/// What each knob does for `kind`, for the settings UI. `false` = not offered.
pub fn supported_knobs(kind: AcpAgentKind) -> Value {
    let claude = kind == AcpAgentKind::ClaudeCode;
    let codex = kind == AcpAgentKind::Codex;
    serde_json::json!({
        "configDir": claude,
        "configDirManaged": codex,
        "cliPath": claude,
        "autoCompactToggle": claude,
        "autoCompactTokens": claude || codex,
    })
}
