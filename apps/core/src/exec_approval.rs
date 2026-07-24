//! Command-approval gate toggle (native-tool governance surface).
//!
//! Every ACP agent's tool calls are pre-scanned through the gateway
//! command-approval scanner at the `request_permission` seam
//! (`sidecar::adapters::acp::acp_exec_scan_verdict` → `check_exec_scan`) — this
//! covers Claude Code's / Codex's own native `Bash`/`Write`/`Edit` tools, not
//! just Ryu-injected tools. That scan is **armed by default** (an unset
//! `RYU_EXEC_APPROVAL_MODE` scans); only an explicit `off` disarms it (see
//! `sidecar::gateway::exec_approval_enabled`) — the default-on posture is what
//! keeps headless (non-interactive) runs from auto-approving unscanned commands.
//!
//! This module lets the desktop set the gate's mode via a preference instead of
//! requiring the env var to be exported by hand. The pref seeds the env var
//! **once at startup** — before any request thread runs — so there is no
//! concurrent `set_var`/`var` race. Changing the pref is therefore
//! **restart-to-apply**, mirroring the crash-reporting / OTLP prefs.
//!
//! We intentionally do NOT add filesystem hooks (Claude `settings.json` /
//! Codex `config.toml`): that would re-implement the tool gate the ACP
//! `request_permission` seam already provides, and would cost either a
//! folder-trust supply-chain hole (adding `project`/`local` settingSources) or a
//! subscription-credential migration (relocating `CLAUDE_CONFIG_DIR`). The ACP
//! seam governs every agent uniformly with neither cost.

/// Env var the gateway scan gate reads (`sidecar::gateway`). Kept in sync here so
/// the pref maps onto exactly the value that module checks.
const ENV_EXEC_APPROVAL_MODE: &str = "RYU_EXEC_APPROVAL_MODE";

/// Preferences key the desktop writes to enable/disable the command-approval
/// gate. Value is the mode string forwarded to the gateway scan (`off` disarms;
/// any other value — e.g. `enforce` — keeps the fail-closed scan armed, which
/// is also the unset default).
pub const EXEC_APPROVAL_MODE_PREF_KEY: &str = "exec-approval-mode";

/// Seed `RYU_EXEC_APPROVAL_MODE` from a persisted preference value. Call ONCE at
/// startup (single-threaded, before request threads spawn) so there is no
/// data race with the readers in `sidecar::gateway`. An explicit env var already
/// present is respected — a hand-exported override wins over the pref, so ops can
/// force the gate on regardless of the stored preference.
///
/// The gate is armed by default (unset env scans), so a pref of `off` must be
/// seeded EXPLICITLY into the env — leaving it unset would silently re-arm a
/// gate the user turned off. An empty pref leaves the env unset (default: armed).
pub fn seed_from_pref(value: &str) {
    // A real env override takes precedence and is never clobbered.
    if std::env::var(ENV_EXEC_APPROVAL_MODE)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }
    let v = value.trim();
    if v.is_empty() {
        // No stored preference → leave unset; the gate's default (armed) rules.
        return;
    }
    // SAFETY: called once at startup before any other thread reads the env.
    // `off` is seeded verbatim so the user's opt-out survives the armed default.
    std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    // These mutate the process-global gate env var; serialize with the same
    // crate-wide lock the gateway scan-gate tests use so they never race.
    #[test]
    fn seed_enables_on_non_off_value() {
        let _g = crate::sidecar::gateway::GATEWAY_ENV_TEST_LOCK.lock();
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        seed_from_pref("enforce");
        assert_eq!(
            std::env::var(ENV_EXEC_APPROVAL_MODE).as_deref(),
            Ok("enforce")
        );
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
    }

    #[test]
    fn seed_writes_off_explicitly_and_leaves_empty_unset() {
        let _g = crate::sidecar::gateway::GATEWAY_ENV_TEST_LOCK.lock();
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        // An empty pref leaves the env unset — the armed default rules.
        seed_from_pref("   ");
        assert!(std::env::var(ENV_EXEC_APPROVAL_MODE).is_err());
        // `off` must be seeded EXPLICITLY: the gate is armed by default, so an
        // unset env would silently re-arm a gate the user turned off.
        seed_from_pref("off");
        assert_eq!(std::env::var(ENV_EXEC_APPROVAL_MODE).as_deref(), Ok("off"));
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
    }

    #[test]
    fn seed_respects_existing_env_override() {
        let _g = crate::sidecar::gateway::GATEWAY_ENV_TEST_LOCK.lock();
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "enforce");
        seed_from_pref("off"); // pref says off, but the env override wins
        assert_eq!(
            std::env::var(ENV_EXEC_APPROVAL_MODE).as_deref(),
            Ok("enforce")
        );
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
    }
}
