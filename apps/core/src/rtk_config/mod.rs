//! RTK per-agent auto-wrap (Phase 2 of the `rtk` plugin).
//!
//! Phase 1 exposes RTK as an explicit `rtk__run` tool — now a fully declarative
//! `command`-backend plugin (`plugins-store/rtk`, mirrored as the built-in
//! fixture `plugin_manifest/fixtures/rtk.plugin.json`); its native provider
//! (`sidecar/mcp/rtk.rs`) was deleted. Phase 2, below, is NOT a tool and cannot be
//! declarative, so it stays as Rust — including [`rtk_bin_path`]/[`is_available`],
//! relocated here from the deleted provider (Phase 2 is their only consumer).
//!
//! Phase 2 makes RTK *transparent* for a Ryu-managed agent: when the user turns on
//! the plugin's per-agent toggle, Core runs `rtk init --agent <id> --hook-only`
//! against that agent's Ryu-owned config dir, installing RTK's PreToolUse hook so
//! the agent's OWN shell commands (its `Bash` tool) are token-compressed
//! automatically — with no per-call tool selection by the model.
//!
//! This is the only way to reach an ACP agent's in-subprocess shell output: Core
//! cannot filter it from the outside (the MCP bridge only sees Ryu-provided tool
//! results, not the agent's built-in Bash). So we delegate to RTK's own public
//! `init` contract, pointing it at the agent's config via the same env var Ryu
//! already uses to isolate that agent (`PI_CODING_AGENT_DIR` for Pi).
//!
//! ## Posture (mirrors [`crate::claude_config`])
//!
//! - **Off by default, opt-in.** Each agent has its own process-global flag,
//!   seeded from a preference at startup and kept in sync on change.
//! - **BYO + fail-open.** When `rtk` is not on PATH, configuration is a logged
//!   no-op; a failing `rtk init` never blocks anything. Nothing is downloaded.
//! - **Reversible.** Turning a toggle off runs `rtk init --uninstall` for that
//!   agent, removing the hook it added.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::win_process::NoWindow;

/// Preference key for auto-wrapping the flagship Ryu (Pi) agent.
pub const WRAP_PI_PREF_KEY: &str = "rtk-wrap-pi";
/// Preference key for auto-wrapping the Claude Code agent.
pub const WRAP_CLAUDE_PREF_KEY: &str = "rtk-wrap-claude";
/// Preference key for the commands RTK should never wrap (comma/newline list).
pub const EXCLUDE_COMMANDS_PREF_KEY: &str = "rtk-exclude-commands";

static WRAP_PI: AtomicBool = AtomicBool::new(false);
static WRAP_CLAUDE: AtomicBool = AtomicBool::new(false);

/// Resolve the `rtk` binary: `RYU_RTK_BIN` override first, else the first `rtk`
/// (`rtk.exe` on Windows) found on `PATH`. Returns `None` when RTK is not
/// installed — the detect-on-PATH, BYO posture (nothing downloaded).
///
/// Relocated verbatim from the deleted `sidecar/mcp/rtk.rs` provider: Phase-2
/// auto-wrap (this module) is its only remaining consumer. The declarative
/// `rtk__run` tool does NOT use this — the generic `command` backend resolves its
/// bin through the Core command-tool allowlist (`RYU_COMMAND_TOOL_ALLOWLIST`).
pub fn rtk_bin_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("RYU_RTK_BIN") {
        let path = PathBuf::from(p);
        return path.exists().then_some(path);
    }
    let exe = if cfg!(target_os = "windows") {
        "rtk.exe"
    } else {
        "rtk"
    };
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.exists())
}

/// True when an `rtk` binary is resolvable (the auto-wrap availability check).
pub fn is_available() -> bool {
    rtk_bin_path().is_some()
}

/// A Ryu-managed agent RTK auto-wrap supports. Each maps to an `rtk init --agent
/// <id>` target and the env that points `rtk` at the agent's Ryu-owned config dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapAgent {
    /// The flagship `ryu` agent (managed Pi). Config dir = `PI_CODING_AGENT_DIR`.
    Pi,
    /// Claude Code (`acp:claude`). Uses RTK's own Claude Code integration.
    Claude,
}

impl WrapAgent {
    /// Every supported agent (for startup seeding / iteration).
    pub const ALL: [WrapAgent; 2] = [WrapAgent::Pi, WrapAgent::Claude];

    /// The `--agent <id>` value RTK's `init` expects.
    pub fn rtk_agent_id(self) -> &'static str {
        match self {
            WrapAgent::Pi => "pi",
            WrapAgent::Claude => "claude",
        }
    }

    /// The preference key this agent's toggle is stored under.
    pub fn pref_key(self) -> &'static str {
        match self {
            WrapAgent::Pi => WRAP_PI_PREF_KEY,
            WrapAgent::Claude => WRAP_CLAUDE_PREF_KEY,
        }
    }

    /// Resolve a preference key back to its agent, if it is a wrap toggle.
    pub fn from_pref_key(key: &str) -> Option<WrapAgent> {
        match key {
            WRAP_PI_PREF_KEY => Some(WrapAgent::Pi),
            WRAP_CLAUDE_PREF_KEY => Some(WrapAgent::Claude),
            _ => None,
        }
    }

    fn flag(self) -> &'static AtomicBool {
        match self {
            WrapAgent::Pi => &WRAP_PI,
            WrapAgent::Claude => &WRAP_CLAUDE,
        }
    }
}

/// Parse the common truthy preference forms the desktop persists.
fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    )
}

/// Seed/update an agent's in-process flag from a preference value.
pub fn set_enabled(agent: WrapAgent, value: &str) {
    agent.flag().store(truthy(value), Ordering::Relaxed);
}

/// Whether RTK auto-wrap is on for `agent`.
pub fn is_enabled(agent: WrapAgent) -> bool {
    agent.flag().load(Ordering::Relaxed)
}

/// Build the `rtk init` argv for enabling or removing an agent's hook. Pure so it
/// is unit-tested without spawning. `--hook-only` installs just the PreToolUse
/// hook (no `RTK.md`); `--auto-patch` is non-interactive (safe from a service).
pub fn init_args(agent: WrapAgent, enable: bool) -> Vec<String> {
    let mut args = vec![
        "init".to_owned(),
        "--agent".to_owned(),
        agent.rtk_agent_id().to_owned(),
        "--auto-patch".to_owned(),
        "--hook-only".to_owned(),
    ];
    if !enable {
        args.push("--uninstall".to_owned());
    }
    args
}

/// Install (or, when `enable` is false, remove) RTK's PreToolUse hook for `agent`.
///
/// Best-effort and fail-open: a missing `rtk` binary is a logged no-op (`Ok`), and
/// a non-zero `rtk init` is surfaced as an `Err` the caller logs but never lets
/// block a spawn. Runs `rtk init` with the agent's Ryu-owned config dir in the
/// environment so the hook lands where the managed agent will read it.
pub async fn configure(agent: WrapAgent, enable: bool) -> anyhow::Result<()> {
    let Some(bin) = rtk_bin_path() else {
        tracing::info!(
            agent = agent.rtk_agent_id(),
            "rtk auto-wrap: rtk not on PATH; skipping hook configuration"
        );
        return Ok(());
    };

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(init_args(agent, enable));

    // Point rtk at the agent's Ryu-owned config dir so its hook patches the same
    // config the managed agent reads — never the user's default agent config.
    match agent {
        WrapAgent::Pi => {
            cmd.env("PI_CODING_AGENT_DIR", crate::pi_config::config_dir_str());
        }
        // Claude Code has no Ryu-isolated config dir; RTK patches the user's
        // Claude Code config, which is RTK's documented Claude integration. This
        // is opt-in (the user set the toggle) and reversible (uninstall).
        WrapAgent::Claude => {}
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.no_window();

    let status = cmd
        .status()
        .await
        .map_err(|e| anyhow::anyhow!("spawn `rtk init`: {e}"))?;
    if !status.success() {
        anyhow::bail!(
            "`rtk init` for agent '{}' exited {status}",
            agent.rtk_agent_id()
        );
    }
    tracing::info!(
        agent = agent.rtk_agent_id(),
        enable,
        "rtk auto-wrap: configured PreToolUse hook"
    );
    Ok(())
}

/// Path to RTK's own `config.toml` (the platform config dir + `rtk`, exactly what
/// `rtk config` reports). RTK reads `[hooks].exclude_commands` from here.
fn rtk_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("rtk").join("config.toml"))
}

/// Split the exclude preference (comma- or newline-separated) into a clean list.
fn parse_excludes(raw: &str) -> Vec<String> {
    raw.split([',', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Merge the exclude list into RTK's `config.toml` `[hooks].exclude_commands`,
/// preserving every other key (read-modify-write, atomic replace). A no-op when
/// `rtk` is not on PATH (so Ryu never creates a config for an rtk that isn't
/// installed). Best-effort: a parse/write failure is surfaced as `Err` for the
/// caller to log, never fatal.
pub fn set_exclude_commands(raw: &str) -> anyhow::Result<()> {
    if rtk_bin_path().is_none() {
        return Ok(());
    }
    let Some(path) = rtk_config_path() else {
        return Ok(());
    };
    let excludes = parse_excludes(raw);

    // Start from the existing config (or an empty table) so we only touch the one
    // key — never clobber the user's other RTK settings.
    let mut root: toml::Value = match std::fs::read_to_string(&path) {
        Ok(s) => toml::from_str(&s).unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new())),
        Err(_) => toml::Value::Table(toml::map::Map::new()),
    };
    let table = root
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("rtk config root is not a table"))?;
    let hooks = table
        .entry("hooks".to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let hooks_table = hooks
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("rtk config [hooks] is not a table"))?;
    hooks_table.insert(
        "exclude_commands".to_owned(),
        toml::Value::Array(excludes.into_iter().map(toml::Value::String).collect()),
    );

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let rendered = toml::to_string_pretty(&root)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, &rendered)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Seed every wrap flag from preferences and reconcile each agent's hook to match
/// (install when on, uninstall when off). Called at startup; best-effort per agent
/// so one failure never aborts the rest. When `rtk` is absent every call no-ops.
pub async fn seed_and_apply(preferences: &crate::server::preferences::PreferencesStore) {
    for agent in WrapAgent::ALL {
        if let Ok(Some(value)) = preferences.get(agent.pref_key()).await {
            set_enabled(agent, &value);
        }
        if let Err(e) = configure(agent, is_enabled(agent)).await {
            tracing::warn!(agent = agent.rtk_agent_id(), error = %e, "rtk auto-wrap: startup configuration failed");
        }
    }
    // Push the exclude list into rtk's config so both the auto-wrap hooks and the
    // `rtk__run` tool honour it. No-op when rtk is absent or the pref is unset.
    if let Ok(Some(raw)) = preferences.get(EXCLUDE_COMMANDS_PREF_KEY).await {
        if let Err(e) = set_exclude_commands(&raw) {
            tracing::warn!(error = %e, "rtk auto-wrap: writing exclude_commands failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_forms_parse() {
        assert!(truthy("true"));
        assert!(truthy("  ON "));
        assert!(truthy("1"));
        assert!(truthy("yes"));
        assert!(!truthy("false"));
        assert!(!truthy("0"));
        assert!(!truthy(""));
    }

    #[test]
    fn pref_key_roundtrips_to_agent() {
        assert_eq!(
            WrapAgent::from_pref_key(WRAP_PI_PREF_KEY),
            Some(WrapAgent::Pi)
        );
        assert_eq!(
            WrapAgent::from_pref_key(WRAP_CLAUDE_PREF_KEY),
            Some(WrapAgent::Claude)
        );
        assert_eq!(WrapAgent::from_pref_key("something-else"), None);
        assert_eq!(WrapAgent::Pi.pref_key(), WRAP_PI_PREF_KEY);
        assert_eq!(WrapAgent::Claude.pref_key(), WRAP_CLAUDE_PREF_KEY);
    }

    #[test]
    fn init_args_install_and_uninstall() {
        let install = init_args(WrapAgent::Pi, true);
        assert_eq!(
            install,
            vec!["init", "--agent", "pi", "--auto-patch", "--hook-only"]
        );
        let uninstall = init_args(WrapAgent::Claude, false);
        assert_eq!(
            uninstall,
            vec![
                "init",
                "--agent",
                "claude",
                "--auto-patch",
                "--hook-only",
                "--uninstall"
            ]
        );
    }

    #[test]
    fn parse_excludes_splits_and_trims() {
        assert_eq!(
            parse_excludes("curl, playwright,  npm run dev "),
            vec!["curl", "playwright", "npm run dev"]
        );
        assert_eq!(
            parse_excludes("curl\nplaywright"),
            vec!["curl", "playwright"]
        );
        assert!(parse_excludes("  ,, \n ").is_empty());
        assert!(parse_excludes("").is_empty());
    }

    #[test]
    fn enabled_flag_tracks_set() {
        set_enabled(WrapAgent::Pi, "true");
        assert!(is_enabled(WrapAgent::Pi));
        set_enabled(WrapAgent::Pi, "off");
        assert!(!is_enabled(WrapAgent::Pi));
    }
}
