//! Process label for Claude Code subprocesses Ryu starts.
//!
//! Anthropic meters `CLAUDE_CODE_ENTRYPOINT` for subscription windows; SDK
//! defaults (`sdk-cli`, `sdk-ts`, …) burn the 5-hour window faster than
//! interactive clients. Ryu labels its own launches `ryu` unless the user
//! configured a different value in Ryu or in Claude's `settings.json` `env`
//! (Claude Code does not read that key from settings — callers must inject it).

use std::path::{Path, PathBuf};

pub const ENV_VAR: &str = "CLAUDE_CODE_ENTRYPOINT";
pub const DEFAULT: &str = "ryu";

/// Host- or SDK-default labels that must not survive into Ryu-spawned processes unless
/// the user set a custom value in Claude's `settings.json` `env` (read separately).
pub fn is_inherited_host_entrypoint(value: &str) -> bool {
    matches!(
        value.trim(),
        "cli" | "claude-vscode" | "claude-desktop" | "sdk-cli" | "sdk-ts" | "sdk-py"
    ) || value.trim().starts_with("sdk-")
}

/// Resolved entrypoint for a Claude Code process Ryu is about to spawn.
///
/// Precedence (matches T3 Code's `mergeClaudeProcessEnvironment`):
/// 1. `settings.json` → `env.CLAUDE_CODE_ENTRYPOINT` under `config_dir`
/// 2. `ryu_configured` — explicit value from Ryu (ACP agent settings `env`, …)
/// 3. [`DEFAULT`] — replaces inherited host values such as `sdk-cli` or
///    `claude-desktop`
pub fn resolve(config_dir: Option<&Path>, ryu_configured: Option<&str>) -> String {
    if let Some(dir) = config_dir {
        if let Some(from_settings) = read_settings_entrypoint(dir) {
            return from_settings;
        }
    }
    if let Some(value) = ryu_configured
        .map(str::trim)
        .filter(|value| !value.is_empty() && !is_inherited_host_entrypoint(value))
    {
        return value.to_owned();
    }
    DEFAULT.to_owned()
}

/// Read `env.CLAUDE_CODE_ENTRYPOINT` from Claude Code's `settings.json`.
pub fn read_settings_entrypoint(config_dir: &Path) -> Option<String> {
    let path = config_dir.join("settings.json");
    let body = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value
        .get("env")?
        .get(ENV_VAR)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The config directory Claude Code will use in an environment read through `var`:
/// a non-empty `CLAUDE_CONFIG_DIR`, else `.claude` under the home folder. On Windows
/// the home folder is `USERPROFILE` first, as Node's `os.homedir()` resolves it.
/// Empty values count as unset: an ACP child env carries blank masks for every
/// inherited variable outside the allowlist, `CLAUDE_CONFIG_DIR` included.
pub fn config_dir_from_env(var: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let non_empty = |name: &str| var(name).filter(|value| !value.trim().is_empty());
    if let Some(dir) = non_empty("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home_vars: &[&str] = if cfg!(windows) {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME"]
    };
    home_vars
        .iter()
        .find_map(|name| non_empty(name))
        .map(|home| PathBuf::from(home).join(".claude"))
}

/// [`config_dir_from_env`] over Core's own process environment.
pub fn process_config_dir() -> Option<PathBuf> {
    config_dir_from_env(|name| std::env::var(name).ok())
}

/// Label a subscription-cloud `claude` subprocess before spawn. A linked account's
/// folder is the config dir the child runs with; otherwise it inherits Core's.
pub fn apply_to_provider_cli_command(
    command: &mut tokio::process::Command,
    account_dir: Option<&Path>,
) {
    let config_dir = account_dir
        .map(Path::to_path_buf)
        .or_else(process_config_dir);
    command.env(ENV_VAR, resolve(config_dir.as_deref(), None));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn default_applied_when_nothing_else_is_configured() {
        assert_eq!(resolve(None, None), DEFAULT);
    }

    #[test]
    fn explicit_ryu_override_wins_over_default() {
        assert_eq!(resolve(None, Some("my-label")), "my-label");
    }

    #[test]
    fn inherited_sdk_labels_are_replaced_by_default() {
        assert_eq!(resolve(None, Some("sdk-cli")), DEFAULT);
        assert_eq!(resolve(None, Some("sdk-ts")), DEFAULT);
        assert_eq!(resolve(None, Some("cli")), DEFAULT);
    }

    #[test]
    fn settings_json_wins_over_explicit_ryu_override() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("settings.json"),
            r#"{"env":{"CLAUDE_CODE_ENTRYPOINT":"from-settings"}}"#,
        )
        .expect("write settings");
        assert_eq!(resolve(Some(dir.path()), Some("instance")), "from-settings");
    }

    #[test]
    fn read_settings_entrypoint_ignores_empty_and_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(read_settings_entrypoint(dir.path()).is_none());
        fs::write(dir.path().join("settings.json"), r#"{"env":{}}"#).expect("write");
        assert!(read_settings_entrypoint(dir.path()).is_none());
    }

    fn lookup<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn config_dir_prefers_a_non_empty_claude_config_dir() {
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        assert_eq!(
            config_dir_from_env(lookup(&[
                ("CLAUDE_CONFIG_DIR", "/cfg"),
                (home_key, "/home/u")
            ])),
            Some(PathBuf::from("/cfg"))
        );
        // A blank mask is unset, never a relative `settings.json` in Core's cwd.
        assert_eq!(
            config_dir_from_env(lookup(&[("CLAUDE_CONFIG_DIR", ""), (home_key, "/home/u")])),
            Some(PathBuf::from("/home/u").join(".claude"))
        );
        assert_eq!(
            config_dir_from_env(lookup(&[("CLAUDE_CONFIG_DIR", "")])),
            None
        );
    }

    #[test]
    #[cfg(windows)]
    fn config_dir_uses_userprofile_on_windows_like_claude_code() {
        assert_eq!(
            config_dir_from_env(lookup(&[("USERPROFILE", "C:\\Users\\u")])),
            Some(PathBuf::from("C:\\Users\\u").join(".claude"))
        );
        assert_eq!(
            config_dir_from_env(lookup(&[("HOME", "/h"), ("USERPROFILE", "C:\\Users\\u")])),
            Some(PathBuf::from("C:\\Users\\u").join(".claude"))
        );
    }

    #[test]
    fn explicit_values_are_trimmed_before_classification() {
        assert_eq!(resolve(None, Some(" sdk-cli ")), DEFAULT);
        assert_eq!(resolve(None, Some(" team ")), "team");
    }
}
