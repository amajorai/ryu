//! Privacy / observability preference keys + resolution (P0 scaffold).
//!
//! This module is the **authoritative source of truth** for the observability,
//! product-analytics, and support-access preference keys defined in
//! `docs/observability-analytics-support-access.md` §6. Later phases import these
//! constants and resolvers instead of re-typing kebab strings (which would
//! drift): P1 (the OTel seam) reads [`diagnostics_export_enabled`] +
//! [`diagnostics_otlp_endpoint`], P3 (closed-UI analytics) reads
//! [`product_analytics_enabled`] / [`crash_reports_enabled`], and P5 (the local
//! Core support channel) reads [`support_access_local`].
//!
//! **This unit ships the keys + resolution only — NO collector, SDK, or exporter
//! is wired here.** Controls exist before any collection so collection can never
//! precede consent.
//!
//! Placement (Core vs Gateway): these store *what the user chose* about their own
//! diagnostics, not policy about what is allowed for others — so they live in
//! Core, like every other user preference. Each resolver follows the same order:
//! the persisted pref value, then an env-var mirror, then the §6 default. Nothing
//! is hardcoded — the OTLP destination in particular is a swappable config value
//! (`diagnostics-otlp-endpoint` / `OTEL_EXPORTER_OTLP_ENDPOINT`), never a lock.

use crate::server::preferences::PreferencesStore;

// ── Canonical preference keys (kebab, shared across every surface) ──────────────

/// Closed-UI product analytics (PostHog). Opt-out: ON by default. (§6)
pub const PRODUCT_ANALYTICS_ENABLED_PREF_KEY: &str = "product-analytics-enabled";
/// Crash reports (Sentry), a separate consent tier. Opt-out: ON by default. (§6)
pub const CRASH_REPORTS_ENABLED_PREF_KEY: &str = "crash-reports-enabled";
/// Data-plane OTLP export of the local trace/audit records. Opt-in: OFF. (§6)
pub const DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY: &str = "diagnostics-export-enabled";
/// The OTLP destination (Axiom / Grafana / a Collector). Empty by default. (§6)
pub const DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY: &str = "diagnostics-otlp-endpoint";
/// Local Core diagnostic support channel. User-granted: OFF by default. (§6)
pub const SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY: &str = "support-access-local-enabled";
/// Hard expiry (unix ms) for the local support channel; 0 = none. (§6)
pub const SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY: &str = "support-access-local-expiry";
/// Anonymous community-savings beacon (aggregate compression stats). Opt-in: OFF.
pub const COMMUNITY_STATS_ENABLED_PREF_KEY: &str = "community-stats-enabled";

// ── Env-var mirrors (so an operator can set them without the desktop) ───────────

const PRODUCT_ANALYTICS_ENABLED_ENV: &str = "RYU_PRODUCT_ANALYTICS_ENABLED";
const CRASH_REPORTS_ENABLED_ENV: &str = "RYU_CRASH_REPORTS_ENABLED";
const DIAGNOSTICS_EXPORT_ENABLED_ENV: &str = "RYU_DIAGNOSTICS_EXPORT_ENABLED";
/// The OTLP endpoint mirror is the OTel-standard env var, so pointing at a
/// Collector/Axiom needs no Ryu-specific knowledge.
const DIAGNOSTICS_OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const SUPPORT_ACCESS_LOCAL_ENABLED_ENV: &str = "RYU_SUPPORT_ACCESS_LOCAL_ENABLED";
const COMMUNITY_STATS_ENABLED_ENV: &str = "RYU_COMMUNITY_STATS_ENABLED";

// ── Defaults (the §6 table, in one place) ───────────────────────────────────────

/// Product analytics: opt-out, so ON by default.
pub const DEFAULT_PRODUCT_ANALYTICS_ENABLED: bool = true;
/// Crash reports: opt-out (separate tier), so ON by default.
pub const DEFAULT_CRASH_REPORTS_ENABLED: bool = true;
/// Data-plane OTLP export: opt-in, so OFF by default.
pub const DEFAULT_DIAGNOSTICS_EXPORT_ENABLED: bool = false;
/// Local support access: user-granted, so OFF by default.
pub const DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED: bool = false;
/// Community-savings beacon: opt-out (phones anonymous aggregate stats home), so ON by default.
pub const DEFAULT_COMMUNITY_STATS_ENABLED: bool = true;

/// Parse a boolean preference/env value, treating only explicit truthy/falsey
/// forms as decisive and falling back to `default` for anything else (unset,
/// empty, or unparseable). Mirrors the desktop's tolerant parsing.
fn parse_bool(value: &str, default: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => true,
        "false" | "0" | "off" | "no" => false,
        _ => default,
    }
}

/// Resolve a boolean privacy pref: stored value → env mirror → default.
async fn resolve_bool(
    prefs: &PreferencesStore,
    pref_key: &str,
    env_key: &str,
    default: bool,
) -> bool {
    if let Ok(Some(stored)) = prefs.get(pref_key).await {
        return parse_bool(&stored, default);
    }
    if let Ok(env) = std::env::var(env_key) {
        return parse_bool(&env, default);
    }
    default
}

/// Whether closed-UI product analytics is enabled (default ON, opt-out).
pub async fn product_analytics_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(
        prefs,
        PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
        PRODUCT_ANALYTICS_ENABLED_ENV,
        DEFAULT_PRODUCT_ANALYTICS_ENABLED,
    )
    .await
}

/// Whether crash reporting is enabled (default ON, opt-out, separate tier).
pub async fn crash_reports_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(
        prefs,
        CRASH_REPORTS_ENABLED_PREF_KEY,
        CRASH_REPORTS_ENABLED_ENV,
        DEFAULT_CRASH_REPORTS_ENABLED,
    )
    .await
}

/// Whether data-plane OTLP export is enabled (default OFF, opt-in).
pub async fn diagnostics_export_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(
        prefs,
        DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
        DIAGNOSTICS_EXPORT_ENABLED_ENV,
        DEFAULT_DIAGNOSTICS_EXPORT_ENABLED,
    )
    .await
}

/// Whether the anonymous community-savings beacon is enabled (default ON,
/// opt-out). When on, Core periodically snapshots the local gateway's aggregate
/// compression counters and phones them home under an anonymous install id — no
/// hostname, key, or identity value ever leaves the machine.
pub async fn community_stats_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(
        prefs,
        COMMUNITY_STATS_ENABLED_PREF_KEY,
        COMMUNITY_STATS_ENABLED_ENV,
        DEFAULT_COMMUNITY_STATS_ENABLED,
    )
    .await
}

/// Resolve the OTLP export endpoint: stored value → env mirror → empty. An empty
/// string means "no destination configured" (export stays off even if the flag
/// is on). The destination is fully swappable — never a hardcoded vendor.
pub async fn diagnostics_otlp_endpoint(prefs: &PreferencesStore) -> String {
    if let Ok(Some(stored)) = prefs.get(DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY).await {
        let trimmed = stored.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var(DIAGNOSTICS_OTLP_ENDPOINT_ENV)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The resolved local support-access state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupportAccessLocal {
    /// Whether the user has granted the local diagnostic channel.
    pub enabled: bool,
    /// Hard expiry as a unix-ms timestamp; `0` means no expiry was set.
    pub expiry_ms: i64,
}

impl SupportAccessLocal {
    /// Whether the grant is currently active: enabled AND (no expiry OR not yet
    /// past it). `now_ms` is the current unix-ms time (injected so this stays
    /// pure/testable). Later phases re-check this at startup so the grant cannot
    /// silently outlive its expiry across a Core restart.
    pub fn is_active(&self, now_ms: i64) -> bool {
        self.enabled && (self.expiry_ms == 0 || now_ms < self.expiry_ms)
    }
}

/// Resolve the local support-access grant (enabled flag + hard expiry).
pub async fn support_access_local(prefs: &PreferencesStore) -> SupportAccessLocal {
    let enabled = resolve_bool(
        prefs,
        SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
        SUPPORT_ACCESS_LOCAL_ENABLED_ENV,
        DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED,
    )
    .await;
    let expiry_ms = prefs
        .get(SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);
    SupportAccessLocal { enabled, expiry_ms }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> PreferencesStore {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.push(format!("ryu-privacy-test-{nanos}.db"));
        PreferencesStore::open(path).expect("open temp preferences store")
    }

    #[test]
    fn bool_parsing_honors_defaults() {
        // Decisive forms win regardless of default.
        assert!(parse_bool("true", false));
        assert!(parse_bool("  ON ", false));
        assert!(!parse_bool("0", true));
        assert!(!parse_bool("off", true));
        // Anything else falls back to the supplied default.
        assert!(parse_bool("", true));
        assert!(!parse_bool("garbage", false));
    }

    #[tokio::test]
    async fn defaults_match_section_six_when_unset() {
        let store = temp_store();
        // Two on-by-default (opt-out), the rest off / empty / zero.
        assert!(product_analytics_enabled(&store).await);
        assert!(crash_reports_enabled(&store).await);
        assert!(!diagnostics_export_enabled(&store).await);
        assert_eq!(diagnostics_otlp_endpoint(&store).await, "");
        let support = support_access_local(&store).await;
        assert!(!support.enabled);
        assert_eq!(support.expiry_ms, 0);
    }

    #[tokio::test]
    async fn community_stats_defaults_on_when_unset() {
        let store = temp_store();
        // Opt-out beacon: anonymous aggregates phone home until the user turns it off.
        assert!(community_stats_enabled(&store).await);
    }

    #[tokio::test]
    async fn stored_values_override_defaults() {
        let store = temp_store();
        store
            .set(PRODUCT_ANALYTICS_ENABLED_PREF_KEY, "false")
            .await
            .unwrap();
        store
            .set(DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY, "true")
            .await
            .unwrap();
        store
            .set(
                DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
                " https://otlp.example  ",
            )
            .await
            .unwrap();
        assert!(!product_analytics_enabled(&store).await);
        assert!(diagnostics_export_enabled(&store).await);
        assert_eq!(
            diagnostics_otlp_endpoint(&store).await,
            "https://otlp.example"
        );
    }

    #[tokio::test]
    async fn support_access_expiry_is_enforced() {
        let store = temp_store();
        store
            .set(SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY, "true")
            .await
            .unwrap();
        store
            .set(SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY, "2000")
            .await
            .unwrap();
        let support = support_access_local(&store).await;
        assert!(support.enabled);
        assert_eq!(support.expiry_ms, 2000);
        // Active before expiry, inactive after.
        assert!(support.is_active(1000));
        assert!(!support.is_active(3000));
        // A zero expiry never auto-expires.
        let no_expiry = SupportAccessLocal {
            enabled: true,
            expiry_ms: 0,
        };
        assert!(no_expiry.is_active(i64::MAX));
    }
}
