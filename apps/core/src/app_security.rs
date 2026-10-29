//! User-controlled security defaults for app UI surfaces.

use crate::server::preferences::PreferencesStore;

/// Preference key shared with the desktop settings client.
pub const ENFORCE_CUSTOM_APP_CSP_PREF_KEY: &str = "enforce-custom-app-csp";

/// Preserve the current deny-by-default behavior unless a user opts out.
pub const DEFAULT_ENFORCE_CUSTOM_APP_CSP: bool = true;

/// Resolve whether custom app UIs without a trusted CSP declaration get the
/// production-style default policy. Invalid or unavailable preferences fail closed.
pub async fn enforce_custom_app_csp_enabled(prefs: &PreferencesStore) -> bool {
    match prefs.get(ENFORCE_CUSTOM_APP_CSP_PREF_KEY).await {
        Ok(Some(value)) => parse_bool(&value),
        _ => DEFAULT_ENFORCE_CUSTOM_APP_CSP,
    }
}

/// Trusted CSPs and any app-provided CSP claim keep the default policy in force.
/// Only an untrusted custom app with no declaration follows the user preference.
pub const fn should_enforce_default_csp(
    trusted_manifest: bool,
    declares_csp: bool,
    enforce_custom_apps: bool,
) -> bool {
    trusted_manifest || declares_csp || enforce_custom_apps
}

fn parse_bool(value: &str) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "false" | "0" | "off" | "no" => false,
        "true" | "1" | "on" | "yes" => true,
        _ => DEFAULT_ENFORCE_CUSTOM_APP_CSP,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        path.push(format!("ryu-app-security-{nanos}.db"));
        path
    }

    #[tokio::test]
    async fn custom_app_csp_defaults_to_enforced_and_reads_saved_value() {
        let path = temp_path();
        let prefs = PreferencesStore::open(path.clone()).expect("open temporary preferences store");

        assert!(enforce_custom_app_csp_enabled(&prefs).await);

        prefs
            .set(ENFORCE_CUSTOM_APP_CSP_PREF_KEY, "false")
            .await
            .expect("save disabled preference");
        assert!(!enforce_custom_app_csp_enabled(&prefs).await);
        drop(prefs);

        let reopened = PreferencesStore::open(path).expect("reopen persisted preferences store");
        assert!(!enforce_custom_app_csp_enabled(&reopened).await);
    }

    #[test]
    fn trusted_or_declared_csp_stays_enforced_when_custom_default_is_off() {
        assert!(should_enforce_default_csp(true, false, false));
        assert!(should_enforce_default_csp(false, true, false));
        assert!(!should_enforce_default_csp(false, false, false));
        assert!(should_enforce_default_csp(false, false, true));
    }

    #[test]
    fn invalid_preference_values_fail_closed() {
        assert!(parse_bool("unknown"));
        assert!(!parse_bool("off"));
        assert!(parse_bool("yes"));
    }
}
