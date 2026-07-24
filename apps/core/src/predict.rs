//! Predictive-typing kernel switch — the process-global on/off flag owned by the
//! built-in **Predict** plugin.
//!
//! The completion **engine** (config, per-app allowlist, secure-field denylist,
//! prompt assembly, reply cleanup, and the `/api/predict/*` HTTP surface) now lives
//! in the extracted [`ryu_predict`] crate. What stays here is the tiny kernel
//! coupling that crate must not own: the process-global "predictive typing is on"
//! flag. Installing/enabling the Predict plugin is the *single* switch — Core seeds
//! [`set_enabled`] from the plugin's persisted state at boot (`main.rs`) and flips
//! it live from the plugin enable/disable path (`apply_policy`'s `predict` arm).
//! There is no separate config toggle — the plugin **is** the switch (CLAUDE.md
//! "nothing hardcoded, one source of truth").
//!
//! The moved engine reads this flag through
//! [`ryu_predict::PredictHost::is_enabled`], implemented in [`crate::predict_host`]
//! over [`is_enabled`]. The plugin id const + the `predict.manifest.json` fixture are
//! likewise AppGate/plugin wiring, so they stay in Core.

use std::sync::atomic::{AtomicBool, Ordering};

/// Manifest id of the built-in **Predict** plugin. Installing/enabling that
/// plugin is the *single* on/off switch for system-wide predictive typing: Core
/// seeds [`set_enabled`] from the plugin's persisted state at boot (`main.rs`) and
/// flips it live from the plugin enable/disable path (`apply_policy`). Matches its
/// `CORE_PLUGINS` membership + the desktop's plugin-enabled gate on the settings tab.
pub const PREDICT_PLUGIN_ID: &str = "predict";

/// Process-global "predictive typing is on" flag, owned by the Predict plugin's
/// enabled state. The engine ([`ryu_predict::api::complete`]) refuses every request
/// while this is false (read via [`ryu_predict::PredictHost::is_enabled`]), so the
/// feature is fully inert until the user installs and enables the plugin. Mirrors
/// the `claude_config` / gateway-policy flag pattern: one atomic, flipped on enable,
/// read on the request path.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Set the predictive-typing enabled flag. Called from boot seeding and the
/// plugin enable/disable path (`apply_policy`'s `predict` arm) — never inline in
/// the request handler.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Whether system-wide predictive typing is currently enabled (i.e. the Predict
/// plugin is installed and enabled).
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_flag_defaults_off_and_toggles() {
        // The plugin owns the switch: off until enabled, flips both ways.
        set_enabled(false);
        assert!(!is_enabled());
        set_enabled(true);
        assert!(is_enabled());
        set_enabled(false);
        assert!(!is_enabled());
    }
}
