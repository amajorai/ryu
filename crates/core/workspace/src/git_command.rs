//! The one place this crate builds a `git` process.
//!
//! A workspace is untrusted input. Its `.git/config` and `.git/hooks` can name
//! programs that git starts on plain reads: `core.fsmonitor` on `status` and
//! `diff`, `diff.external` and textconv drivers on `diff`, hooks,
//! `core.sshCommand`, `credential.helper`, the `ext::` transport, and the
//! configuration of a bare repository embedded in a subfolder. Every `git`
//! this crate starts against a workspace goes through [`git_command`], which
//! overrides those settings on the command line and in the environment, so a
//! repository cannot start a program on the Core host through its own
//! configuration.
//!
//! Machine and user configuration (`--system`, `--global`) stays in force. It
//! belongs to the person who runs Core, it is out of a repository's reach, and
//! on Windows it carries `core.autocrlf` and the credential manager. That is
//! why this builder does not set `GIT_CONFIG_NOSYSTEM`, and why it names the
//! user's own credential helpers again after clearing the helper list.

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::win_process::NoWindow;

/// A hooks directory that can hold no hook. A writable temp directory could be
/// filled by another local process between creation and use.
const NULL_HOOKS_PATH: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// Overrides passed as `-c` to every invocation. Command line configuration
/// wins over the repository's `.git/config`.
const FIXED_OVERRIDES: &[&str] = &[
    "core.fsmonitor=false",
    "protocol.ext.allow=never",
    "core.pager=cat",
    "safe.bareRepository=explicit",
];

/// Subcommands that write patches and so can reach `diff.external` and a
/// textconv driver. An empty `diff.external` override makes git try to start
/// an empty program, so these get the two flags instead.
const PATCH_COMMANDS: &[&str] = &["diff", "show", "log"];
const PATCH_GUARDS: [&str; 2] = ["--no-ext-diff", "--no-textconv"];

/// Keys read from the user's own configuration and passed on explicitly.
const USER_LEVEL_KEYS: &str = r"^(credential\.(.*\.)?helper|core\.sshcommand)$";

/// How long one read of the user's configuration is reused. Status is polled
/// every few seconds, and a helper added with `gh auth setup-git` while Core
/// runs should still work without a restart.
const USER_LEVEL_TTL: Duration = Duration::from_secs(60);

/// Program settings from the configuration of the person who runs Core.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct UserLevelSettings {
    /// `credential.helper` and `credential.<url>.helper` entries, in order.
    pub(crate) credential_helpers: Vec<(String, String)>,
    /// `core.sshCommand`, when the user set one.
    pub(crate) ssh_command: Option<String>,
}

/// Build a hardened `git` invocation for `args`. Callers add the working
/// directory, further arguments, stdio and environment as they need.
pub(crate) fn git_command(args: &[&str]) -> Command {
    let user = user_level_settings();
    let mut command = Command::new("git");
    apply_overrides(&mut command, &user);
    command.args(guarded_args(args));
    command
}

/// [`git_command`] for a caller outside this crate that hands git its own
/// environment (Core's cloud task runner passes an allowlist). The process
/// environment is cleared, `envs` is applied, and the overrides come last so
/// `envs` cannot undo them.
pub fn git_command_with_env<I, K, V>(args: &[&str], envs: I) -> Command
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<std::ffi::OsStr>,
    V: AsRef<std::ffi::OsStr>,
{
    let user = user_level_settings();
    let mut command = Command::new("git");
    command.env_clear().envs(envs);
    apply_overrides(&mut command, &user);
    command.args(guarded_args(args));
    command
}

/// The ssh program git may start: the process environment first, then the
/// user's own configuration, then plain `ssh`. Never the repository's value.
pub(crate) fn trusted_ssh_command() -> String {
    ssh_command_from(
        std::env::var("GIT_SSH_COMMAND").ok(),
        &user_level_settings(),
    )
}

fn ssh_command_from(environment: Option<String>, user: &UserLevelSettings) -> String {
    environment
        .filter(|value| !value.trim().is_empty())
        .or_else(|| user.ssh_command.clone())
        .unwrap_or_else(|| "ssh".to_string())
}

fn apply_overrides(command: &mut Command, user: &UserLevelSettings) {
    for value in FIXED_OVERRIDES {
        command.arg("-c").arg(value);
    }
    command
        .arg("-c")
        .arg(format!("core.hooksPath={NULL_HOOKS_PATH}"));
    // An empty value clears every helper read so far, the repository's
    // included. The user's own helpers are then named again, in their order.
    command.arg("-c").arg("credential.helper=");
    for (key, value) in &user.credential_helpers {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // The environment wins over `core.sshCommand` and `core.askPass`.
        .env(
            "GIT_SSH_COMMAND",
            ssh_command_from(std::env::var("GIT_SSH_COMMAND").ok(), user),
        )
        .env(
            "GIT_ASKPASS",
            std::env::var_os("GIT_ASKPASS").unwrap_or_default(),
        )
        .no_window();
}

/// `args` with the patch guards placed right after a patch-writing subcommand.
/// Leading global options (`-c key=value`, `-C dir`, other dashed options) are
/// skipped to find the subcommand.
pub(crate) fn guarded_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut out = Vec::with_capacity(args.len() + PATCH_GUARDS.len());
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        out.push(arg);
        index += 1;
        if arg == "-c" || arg == "-C" {
            if let Some(value) = args.get(index) {
                out.push(value);
                index += 1;
            }
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        if PATCH_COMMANDS.contains(&arg) {
            out.extend(PATCH_GUARDS);
        }
        break;
    }
    out.extend_from_slice(&args[index..]);
    out
}

fn user_level_settings() -> UserLevelSettings {
    static CACHE: Mutex<Option<(Instant, UserLevelSettings)>> = Mutex::new(None);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((read_at, settings)) = cache.as_ref() {
        if read_at.elapsed() < USER_LEVEL_TTL {
            return settings.clone();
        }
    }
    let settings = read_user_level_settings();
    *cache = Some((Instant::now(), settings.clone()));
    settings
}

/// Read the two scopes a repository cannot write. Each scope is named
/// explicitly, so no repository configuration is consulted whatever the
/// working directory is. A failed read (no such file, old git) yields nothing.
fn read_user_level_settings() -> UserLevelSettings {
    let mut records = String::new();
    for scope in ["--system", "--global"] {
        // The only bare `git` in this crate besides the checkpoint store. It
        // reads configuration only and touches no repository.
        let output = Command::new("git")
            .args(["config", scope, "--includes", "-z", "--get-regexp"])
            .arg(USER_LEVEL_KEYS)
            .stdin(Stdio::null())
            .no_window()
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                records.push_str(&String::from_utf8_lossy(&output.stdout));
            }
        }
    }
    parse_user_level_settings(&records)
}

/// Parse `git config -z --get-regexp` output: records end with NUL, and a
/// record is the key, a newline and the value.
pub(crate) fn parse_user_level_settings(records: &str) -> UserLevelSettings {
    let mut settings = UserLevelSettings::default();
    for record in records.split('\0').filter(|record| !record.is_empty()) {
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        if key == "core.sshcommand" {
            settings.ssh_command = Some(value.to_string()).filter(|v| !v.trim().is_empty());
        } else if key.starts_with("credential.") && key.ends_with(".helper") {
            settings
                .credential_helpers
                .push((key.to_string(), value.to_string()));
        }
    }
    settings
}

#[cfg(test)]
mod tests;
