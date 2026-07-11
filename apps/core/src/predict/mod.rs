//! Predictive typing — the "brain" behind system-wide inline autocomplete.
//!
//! This module owns everything that decides *what to suggest*: the config (model
//! / per-app allowlist / debounce), the process-global enabled flag driven by the
//! built-in **Predict** plugin ([`is_enabled`]), the privacy denylist for
//! password & secure controls, the prompt assembly, and the cleanup of the raw
//! model reply. The native overlay (`apps/predict`) stays deliberately dumb — it
//! reads the caret context, POSTs it here, and renders whatever string comes
//! back. No Gateway URL, key, or model id ever lives in the overlay process.
//!
//! Placement (CLAUDE.md §1, Core vs Gateway): deciding *what runs* (assemble the
//! prompt, enforce the app allowlist, refuse secure fields) is **Core**. The
//! actual model call is handed to the **Gateway** via [`super::server`]'s
//! `call_side_model` (the same one `/btw`, goal, and double-check use), so model
//! routing / firewall / budgets / audit all apply — nothing hardcoded.
//!
//! The shared in-editor copilot (PlateJS ghost text) routes through the Gateway
//! directly from the desktop webview; this endpoint is the *system-wide* sibling
//! for arbitrary native apps, but both speak the same predictive contract.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// Preference key holding the predictive-typing config blob (one JSON object,
/// mirroring how `editor-ai` is stored). The desktop settings tab and the
/// `apps/predict` overlay both read/write this single key.
pub const PREDICT_CONFIG_PREF: &str = "predict-config";

/// Manifest id of the built-in **Predict** plugin. Installing/enabling that
/// plugin is the *single* on/off switch for system-wide predictive typing: Core
/// seeds [`set_enabled`] from the plugin's persisted state at boot (`main.rs`) and
/// flips it live from the plugin enable/disable path (`apply_policy`). There is no
/// separate config toggle — the plugin **is** the switch (CLAUDE.md "nothing
/// hardcoded, one source of truth"). Matches its `CORE_PLUGINS` membership + the
/// desktop's plugin-enabled gate on the settings tab.
pub const PREDICT_PLUGIN_ID: &str = "predict";

/// Process-global "predictive typing is on" flag, owned by the Predict plugin's
/// enabled state. [`super::server::predict_api::complete`] refuses every request
/// while this is false, so the feature is fully inert until the user installs and
/// enables the plugin. Mirrors the `claude_config` / gateway-policy flag pattern:
/// one atomic, flipped on enable, read on the request path.
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

/// Default debounce between caret changes and a prediction request (ms).
pub const DEFAULT_DEBOUNCE_MS: u64 = 400;

/// Default cap on a suggestion's length (characters). Keeps inline ghost text to
/// a sentence-ish continuation rather than a runaway paragraph.
pub const DEFAULT_MAX_CHARS: usize = 240;

/// Persisted predictive-typing configuration. `camelCase` so the desktop
/// settings tab and the overlay can read/write the same JSON shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PredictConfig {
    /// Gateway-routable model id. Empty → resolved from the agent / env / default.
    #[serde(default)]
    pub model: String,
    /// `reasoning_effort` passthrough; empty → omitted.
    #[serde(default)]
    pub effort: String,
    /// Optional agent backing predictions. When set, the agent's bound model wins
    /// over `model`, and the id is forwarded to the Gateway for per-agent
    /// routing / budgets / audit.
    #[serde(default, rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Per-app allowlist of process names (e.g. `notepad.exe`, `chrome.exe`).
    /// **Empty = every app allowed** (the default). A non-empty list restricts
    /// predictions to exactly those apps (case-insensitive match).
    #[serde(default, rename = "appAllowlist")]
    pub app_allowlist: Vec<String>,
    /// Debounce (ms) the overlay waits after the caret settles before requesting.
    #[serde(default = "default_debounce", rename = "debounceMs")]
    pub debounce_ms: u64,
    /// Max characters of a returned suggestion.
    #[serde(default = "default_max_chars", rename = "maxChars")]
    pub max_chars: usize,
}

fn default_debounce() -> u64 {
    DEFAULT_DEBOUNCE_MS
}
fn default_max_chars() -> usize {
    DEFAULT_MAX_CHARS
}

impl Default for PredictConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            effort: String::new(),
            agent_id: None,
            app_allowlist: Vec::new(),
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            max_chars: DEFAULT_MAX_CHARS,
        }
    }
}

impl PredictConfig {
    /// Parse the persisted pref blob, falling back to defaults on absent/garbage.
    pub fn from_pref(raw: Option<&str>) -> Self {
        raw.and_then(|s| serde_json::from_str::<PredictConfig>(s).ok())
            .unwrap_or_default()
    }
}

/// Localized control-type tokens that indicate a **password or otherwise secure**
/// field, where we must NOT read context or suggest. UIA reports a localized
/// control type (e.g. "edit", "password"); some apps expose "password" directly,
/// and browsers surface secure inputs whose name/type carries these markers. We
/// match loosely (substring, case-insensitive) and fail *closed* — if in doubt,
/// refuse. This is the privacy floor the Gateway moat exists to enforce: never
/// exfiltrate a secret to a model just because the user was typing one.
const SECURE_CONTROL_MARKERS: &[&str] = &[
    "password", "passwd", "secure", "pin", "otp", "cvv", "secret",
];

/// True when a control type / field descriptor names a password or secure input.
/// Pure + case-insensitive so it is unit-testable without UIA.
pub fn is_secure_control(control: &str) -> bool {
    let lower = control.to_lowercase();
    SECURE_CONTROL_MARKERS.iter().any(|m| lower.contains(m))
}

/// True when `app` is permitted by `allowlist`. An **empty** allowlist permits
/// every app; otherwise the process name must match an entry (case-insensitive,
/// trimmed). `app` may be a full path or a bare exe name — we compare on the
/// file name component so `C:\\…\\chrome.exe` matches `chrome.exe`.
pub fn app_allowed(allowlist: &[String], app: &str) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    let name = app
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(app)
        .trim()
        .to_lowercase();
    if name.is_empty() {
        return false;
    }
    let name_stem = name.trim_end_matches(".exe");
    allowlist.iter().any(|entry| {
        let e = entry.trim().to_lowercase();
        !e.is_empty() && e.trim_end_matches(".exe") == name_stem
    })
}

/// The predictive system prompt + user message for a given caret context. Pure
/// so the exact wording is testable and lives in one place.
///
/// The instructions mirror the in-editor copilot's (continue naturally, no new
/// block, end on punctuation, return the sentinel `0` for "no good
/// continuation") so both predictive surfaces behave consistently.
pub fn build_messages(context: &str) -> (String, String) {
    let system = "You are an inline autocomplete engine, like GitHub Copilot but for any text \
field. Predict the immediate continuation of the user's text from the context before their cursor. \
Rules:\n\
- Output ONLY the continuation text — never repeat the context, never explain.\n\
- Continue naturally, up to roughly the next clause or sentence.\n\
- Match the existing style, tone, and language.\n\
- Do not start a new line or block; continue in place.\n\
- If you cannot confidently continue, output exactly: 0"
        .to_string();
    let user = format!(
        "Continue the text after the cursor. Text before the cursor:\n\"\"\"\n{context}\n\"\"\""
    );
    (system, user)
}

/// Clean a raw model reply into an inline suggestion. Strips wrapping quotes /
/// code fences, collapses to a single line, trims, enforces `max_chars`, and
/// maps the `0` sentinel (and empties) to an empty string = "no suggestion".
pub fn clean_suggestion(raw: &str, max_chars: usize) -> String {
    let mut s = raw.trim().to_string();
    // The sentinel for "nothing to suggest".
    if s == "0" {
        return String::new();
    }
    // Strip a leading/trailing code fence if the model wrapped the reply.
    if let Some(rest) = s.strip_prefix("```") {
        s = rest.to_string();
        if let Some(idx) = s.find('\n') {
            s = s[idx + 1..].to_string();
        }
        if let Some(idx) = s.rfind("```") {
            s = s[..idx].to_string();
        }
        s = s.trim().to_string();
    }
    // Strip symmetric wrapping quotes.
    for (open, close) in [('"', '"'), ('\'', '\''), ('“', '”')] {
        if s.starts_with(open) && s.ends_with(close) && s.chars().count() >= 2 {
            let inner: String = s.chars().skip(1).take(s.chars().count() - 2).collect();
            s = inner.trim().to_string();
        }
    }
    // Single line only: inline ghost text never spans blocks.
    if let Some(idx) = s.find(['\n', '\r']) {
        s = s[..idx].to_string();
    }
    let s = s.trim().to_string();
    if s == "0" || s.is_empty() {
        return String::new();
    }
    if s.chars().count() > max_chars {
        return s.chars().take(max_chars).collect::<String>();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_controls_are_refused() {
        assert!(is_secure_control("Password"));
        assert!(is_secure_control("password edit"));
        assert!(is_secure_control("Secure Text Field"));
        assert!(is_secure_control("OTP"));
        assert!(!is_secure_control("edit"));
        assert!(!is_secure_control("document"));
        assert!(!is_secure_control("text box"));
    }

    #[test]
    fn empty_allowlist_permits_all() {
        assert!(app_allowed(&[], "notepad.exe"));
        assert!(app_allowed(&[], "C:\\x\\chrome.exe"));
    }

    #[test]
    fn allowlist_matches_basename_case_insensitive() {
        let allow = vec!["Notepad.exe".to_string(), "chrome".to_string()];
        assert!(app_allowed(&allow, "notepad.exe"));
        assert!(app_allowed(&allow, "C:\\Windows\\System32\\notepad.exe"));
        assert!(app_allowed(&allow, "chrome.exe"));
        assert!(!app_allowed(&allow, "code.exe"));
        assert!(!app_allowed(&allow, ""));
    }

    #[test]
    fn cleans_sentinel_and_empty() {
        assert_eq!(clean_suggestion("0", 240), "");
        assert_eq!(clean_suggestion("   ", 240), "");
        assert_eq!(clean_suggestion("0\n", 240), "");
    }

    #[test]
    fn strips_quotes_and_collapses_to_one_line() {
        assert_eq!(clean_suggestion("\" world\"", 240), "world");
        assert_eq!(clean_suggestion("hello\nthere", 240), "hello");
        assert_eq!(clean_suggestion("```\ncode here\n```", 240), "code here");
    }

    #[test]
    fn enforces_max_chars() {
        let long = "a".repeat(500);
        assert_eq!(clean_suggestion(&long, 10).chars().count(), 10);
    }

    #[test]
    fn config_roundtrips_through_pref() {
        let cfg = PredictConfig {
            model: "gpt-4o-mini".to_string(),
            effort: "low".to_string(),
            agent_id: Some("ryu".to_string()),
            app_allowlist: vec!["notepad.exe".to_string()],
            debounce_ms: 250,
            max_chars: 120,
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        let back = PredictConfig::from_pref(Some(&raw));
        assert_eq!(cfg, back);
    }

    #[test]
    fn missing_pref_is_default() {
        let cfg = PredictConfig::from_pref(None);
        assert_eq!(cfg.debounce_ms, DEFAULT_DEBOUNCE_MS);
        assert_eq!(cfg.max_chars, DEFAULT_MAX_CHARS);
        assert!(cfg.app_allowlist.is_empty());
    }

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

    #[test]
    fn garbage_pref_falls_back_to_default() {
        let cfg = PredictConfig::from_pref(Some("not json"));
        assert_eq!(cfg, PredictConfig::default());
    }
}
