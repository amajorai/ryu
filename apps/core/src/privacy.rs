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
//! This unit owns the canonical keys + resolution. The consented runtime seams
//! in `telemetry.rs`, `crash.rs`, and `support_access/` consume these resolvers,
//! so collection/export cannot precede the persisted choice.
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
/// Anonymous community-savings beacon (aggregate compression stats). Opt-out: ON.
pub const COMMUNITY_STATS_ENABLED_PREF_KEY: &str = "community-stats-enabled";
/// Signed-in daily-activity ping that keeps the profile streak honest (see
/// `profile_activity.rs`). Sends "this signed-in account used Ryu today" and, on
/// the local non-reporting Gateway, that day's usage counts for this device.
/// Opt-out: ON.
pub const PROFILE_ACTIVITY_ENABLED_PREF_KEY: &str = "profile-activity-enabled";
/// What OTLP spans may carry: `metadata_only` (default) or `content` (prompts,
/// completions, tool arguments/results). A SEPARATE opt-in from
/// [`DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY`]; content never egresses without export
/// consent. Mirrors Claude Platform's metadata-only/content split.
pub const DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY: &str = "diagnostics-otlp-content-mode";
/// Per-span byte cap for exported content attributes (content mode only).
pub const DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY: &str = "diagnostics-otlp-max-content-bytes";

/// Exporter preset shaping the OTLP destination: `otlp` (default; any OTLP/HTTP
/// endpoint), `langfuse`, `langsmith`, `braintrust`, `phoenix`, `helicone`, or
/// `datadog` (see `ryu_tracing::export_presets`). Still gated by
/// [`DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY`]; a preset never egresses on its own.
pub const DIAGNOSTICS_OTLP_PRESET_PREF_KEY: &str = "diagnostics-otlp-preset";
/// Preset project / app name (LangSmith, Braintrust, Phoenix, Datadog ML app).
pub const DIAGNOSTICS_OTLP_PROJECT_PREF_KEY: &str = "diagnostics-otlp-project";
/// Preset region or site (`us`/`eu`, or a Datadog site such as `us5`).
pub const DIAGNOSTICS_OTLP_REGION_PREF_KEY: &str = "diagnostics-otlp-region";
/// Secret REFERENCE for the preset's API key (`env:NAME`, `file:/path`, or
/// `secret:NAME` from the node vault). Literal keys are rejected.
pub const DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY: &str = "diagnostics-otlp-api-key-ref";
/// Secret REFERENCE for the Langfuse public key.
pub const DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY: &str = "diagnostics-otlp-public-key-ref";

// ── Env-var mirrors (so an operator can set them without the desktop) ───────────

const PRODUCT_ANALYTICS_ENABLED_ENV: &str = "RYU_PRODUCT_ANALYTICS_ENABLED";
const CRASH_REPORTS_ENABLED_ENV: &str = "RYU_CRASH_REPORTS_ENABLED";
const DIAGNOSTICS_EXPORT_ENABLED_ENV: &str = "RYU_DIAGNOSTICS_EXPORT_ENABLED";
/// The OTLP endpoint mirror is the OTel-standard env var, so pointing at a
/// Collector/Axiom needs no Ryu-specific knowledge.
const DIAGNOSTICS_OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const SUPPORT_ACCESS_LOCAL_ENABLED_ENV: &str = "RYU_SUPPORT_ACCESS_LOCAL_ENABLED";
const COMMUNITY_STATS_ENABLED_ENV: &str = "RYU_COMMUNITY_STATS_ENABLED";
const PROFILE_ACTIVITY_ENABLED_ENV: &str = "RYU_PROFILE_ACTIVITY_ENABLED";
/// Env mirror for [`DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY`]. Public because Core
/// forwards the resolved mode to the gateway sidecar under the same name.
pub const DIAGNOSTICS_CONTENT_MODE_ENV: &str = "RYU_DIAGNOSTICS_CONTENT_MODE";
/// Env mirror for [`DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY`], forwarded to
/// the gateway sidecar under the same name.
pub const DIAGNOSTICS_MAX_CONTENT_BYTES_ENV: &str = "RYU_DIAGNOSTICS_MAX_CONTENT_BYTES";

/// Env mirrors for the exporter preset prefs (also read by the Gateway when it
/// runs standalone; Core forwards resolved values instead).
pub const DIAGNOSTICS_OTLP_PRESET_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PRESET";
const DIAGNOSTICS_OTLP_PROJECT_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PROJECT";
const DIAGNOSTICS_OTLP_REGION_ENV: &str = "RYU_DIAGNOSTICS_OTLP_REGION";
pub const DIAGNOSTICS_OTLP_API_KEY_REF_ENV: &str = "RYU_DIAGNOSTICS_OTLP_API_KEY_REF";
pub const DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PUBLIC_KEY_REF";

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
/// Profile daily-activity ping: opt-out (the user's own streak), so ON by default.
pub const DEFAULT_PROFILE_ACTIVITY_ENABLED: bool = true;
/// Exported content cap per span (Claude Platform parity: 750 KB).
pub const DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES: usize = 750_000;

/// What exported spans may carry. Default [`ContentMode::MetadataOnly`]: model,
/// token counts, timings, status — never prompt/completion/tool payloads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ContentMode {
    /// Metadata only (the default posture).
    #[default]
    MetadataOnly,
    /// Also export `gen_ai.system_instructions`, `gen_ai.input.messages`,
    /// `gen_ai.output.messages`, and tool call arguments/results.
    Content,
}

impl ContentMode {
    /// The canonical wire value (`metadata_only` | `content`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MetadataOnly => "metadata_only",
            Self::Content => "content",
        }
    }

    /// Tolerant parse: only an explicit `content` (or `full`) opts in; anything
    /// else, including blank/unknown, keeps the metadata-only default.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "content" | "full" => Self::Content,
            _ => Self::MetadataOnly,
        }
    }
}

/// Parse a byte-cap value; non-numeric or zero falls back to the default.
pub fn parse_max_content_bytes(value: &str) -> usize {
    value
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|bytes| *bytes > 0)
        .unwrap_or(DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES)
}

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

/// Resolve an already-read canonical boolean privacy preference.
///
/// Present stored values take precedence, including blank/invalid values which
/// use the key's default. Only absent values consult the environment. Unknown
/// keys return `None` so generic preference callers retain raw KV semantics.
/// This function performs no storage read or write; callers must propagate their
/// own storage errors before supplying a value.
pub fn effective_boolean_privacy_preference(key: &str, stored: Option<&str>) -> Option<bool> {
    let (env_key, default) = match key {
        PRODUCT_ANALYTICS_ENABLED_PREF_KEY => (
            PRODUCT_ANALYTICS_ENABLED_ENV,
            DEFAULT_PRODUCT_ANALYTICS_ENABLED,
        ),
        CRASH_REPORTS_ENABLED_PREF_KEY => {
            (CRASH_REPORTS_ENABLED_ENV, DEFAULT_CRASH_REPORTS_ENABLED)
        }
        DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY => (
            DIAGNOSTICS_EXPORT_ENABLED_ENV,
            DEFAULT_DIAGNOSTICS_EXPORT_ENABLED,
        ),
        COMMUNITY_STATS_ENABLED_PREF_KEY => {
            (COMMUNITY_STATS_ENABLED_ENV, DEFAULT_COMMUNITY_STATS_ENABLED)
        }
        PROFILE_ACTIVITY_ENABLED_PREF_KEY => (
            PROFILE_ACTIVITY_ENABLED_ENV,
            DEFAULT_PROFILE_ACTIVITY_ENABLED,
        ),
        SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY => (
            SUPPORT_ACCESS_LOCAL_ENABLED_ENV,
            DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED,
        ),
        _ => return None,
    };
    Some(match stored {
        Some(value) => parse_bool(value, default),
        None => std::env::var(env_key)
            .map(|value| parse_bool(&value, default))
            .unwrap_or(default),
    })
}

/// Runtime compatibility: unavailable storage retains the env/default fallback.
/// HTTP callers use the already-read helper only after a successful store read.
async fn resolve_bool(prefs: &PreferencesStore, pref_key: &str) -> bool {
    let stored = prefs.get(pref_key).await.ok().flatten();
    effective_boolean_privacy_preference(pref_key, stored.as_deref())
        .expect("runtime boolean resolvers use canonical privacy keys")
}

/// Whether closed-UI product analytics is enabled (default ON, opt-out).
pub async fn product_analytics_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(prefs, PRODUCT_ANALYTICS_ENABLED_PREF_KEY).await
}

/// Whether crash reporting is enabled (default ON, opt-out, separate tier).
pub async fn crash_reports_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(prefs, CRASH_REPORTS_ENABLED_PREF_KEY).await
}

/// Whether data-plane OTLP export is enabled (default OFF, opt-in).
pub async fn diagnostics_export_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(prefs, DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY).await
}

/// Whether the anonymous community-savings beacon is enabled (default ON,
/// opt-out). When on, Core periodically snapshots the local gateway's aggregate
/// compression counters and phones them home under an anonymous install id — no
/// hostname, key, or identity value ever leaves the machine.
pub async fn community_stats_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(prefs, COMMUNITY_STATS_ENABLED_PREF_KEY).await
}

/// Whether the signed-in profile daily-activity ping is enabled (default ON,
/// opt-out). When on, Core tells the control plane at most once per UTC day that
/// the signed-in account used Ryu, so the profile streak counts local and
/// scheduled agent work. On the local Gateway, which never reports usage, it also
/// sends this device's absolute daily token, request, and session counts (with
/// request counts per model) under a random device id. No content, prompt,
/// agent, or conversation is sent.
pub async fn profile_activity_enabled(prefs: &PreferencesStore) -> bool {
    resolve_bool(prefs, PROFILE_ACTIVITY_ENABLED_PREF_KEY).await
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

/// Resolve a non-boolean pref: a non-blank stored value wins, then the env
/// mirror, then `None`.
async fn resolve_string(prefs: &PreferencesStore, pref_key: &str, env_key: &str) -> Option<String> {
    if let Ok(Some(stored)) = prefs.get(pref_key).await {
        let trimmed = stored.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Resolve the OTLP content mode (default `metadata_only`). This is only the
/// user's choice; the runtime gate (`telemetry::content_enabled`) additionally
/// requires export consent, so content never egresses with export off.
pub async fn diagnostics_otlp_content_mode(prefs: &PreferencesStore) -> ContentMode {
    resolve_string(
        prefs,
        DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY,
        DIAGNOSTICS_CONTENT_MODE_ENV,
    )
    .await
    .map(|value| ContentMode::parse(&value))
    .unwrap_or_default()
}

/// Resolve the per-span exported content byte cap (default 750000).
pub async fn diagnostics_otlp_max_content_bytes(prefs: &PreferencesStore) -> usize {
    resolve_string(
        prefs,
        DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY,
        DIAGNOSTICS_MAX_CONTENT_BYTES_ENV,
    )
    .await
    .map(|value| parse_max_content_bytes(&value))
    .unwrap_or(DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES)
}

/// The exporter-preset configuration as the user wrote it: secret fields are
/// still REFERENCES here; `telemetry` resolves them at exporter build time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OtlpPresetPrefs {
    /// Raw preset name (`None` = the generic `otlp` destination).
    pub preset: Option<String>,
    pub project: Option<String>,
    pub region: Option<String>,
    pub api_key_ref: Option<String>,
    pub public_key_ref: Option<String>,
}

/// Resolve the exporter-preset prefs (stored value → env mirror → unset).
pub async fn diagnostics_otlp_preset(prefs: &PreferencesStore) -> OtlpPresetPrefs {
    OtlpPresetPrefs {
        preset: resolve_string(
            prefs,
            DIAGNOSTICS_OTLP_PRESET_PREF_KEY,
            DIAGNOSTICS_OTLP_PRESET_ENV,
        )
        .await,
        project: resolve_string(
            prefs,
            DIAGNOSTICS_OTLP_PROJECT_PREF_KEY,
            DIAGNOSTICS_OTLP_PROJECT_ENV,
        )
        .await,
        region: resolve_string(
            prefs,
            DIAGNOSTICS_OTLP_REGION_PREF_KEY,
            DIAGNOSTICS_OTLP_REGION_ENV,
        )
        .await,
        api_key_ref: resolve_string(
            prefs,
            DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY,
            DIAGNOSTICS_OTLP_API_KEY_REF_ENV,
        )
        .await,
        public_key_ref: resolve_string(
            prefs,
            DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY,
            DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_ENV,
        )
        .await,
    }
}

/// Reject an exporter-preset preference write that could never resolve, before
/// it is stored: an unknown preset name, or a credential field holding anything
/// other than a secret reference. The second check keeps a pasted API key out
/// of the plain preferences store entirely (blank clears the field).
pub fn validate_otlp_preset_pref(key: &str, value: &str) -> Result<(), String> {
    use ryu_tracing::export_presets::{ExporterPreset, PresetError, SecretReference};

    let value = value.trim();
    match key {
        DIAGNOSTICS_OTLP_PRESET_PREF_KEY => ExporterPreset::parse(value)
            .map(drop)
            .ok_or_else(|| PresetError::UnknownPreset(value.to_owned()).to_string()),
        DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY | DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY
            if !value.is_empty() =>
        {
            SecretReference::parse(value)
                .map(drop)
                .map_err(|error| error.to_string())
        }
        _ => Ok(()),
    }
}

/// Whether a preference write changes the OTLP destination (endpoint, preset,
/// or its credentials). The running exporter binds its destination at build
/// time, so such a write pauses export until Core restarts.
pub fn is_otlp_destination_pref_key(key: &str) -> bool {
    matches!(
        key,
        DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY
            | DIAGNOSTICS_OTLP_PRESET_PREF_KEY
            | DIAGNOSTICS_OTLP_PROJECT_PREF_KEY
            | DIAGNOSTICS_OTLP_REGION_PREF_KEY
            | DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY
            | DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY
    )
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
    let enabled = resolve_bool(prefs, SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY).await;
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

    #[test]
    fn effective_boolean_reads_share_canonical_keys_and_stored_precedence() {
        // Present stored inputs deliberately avoid process-global environment
        // mutation and must win regardless of an operator's environment.
        for (key, default) in [
            (
                PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
                DEFAULT_PRODUCT_ANALYTICS_ENABLED,
            ),
            (
                CRASH_REPORTS_ENABLED_PREF_KEY,
                DEFAULT_CRASH_REPORTS_ENABLED,
            ),
            (
                DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
                DEFAULT_DIAGNOSTICS_EXPORT_ENABLED,
            ),
            (
                COMMUNITY_STATS_ENABLED_PREF_KEY,
                DEFAULT_COMMUNITY_STATS_ENABLED,
            ),
            (
                PROFILE_ACTIVITY_ENABLED_PREF_KEY,
                DEFAULT_PROFILE_ACTIVITY_ENABLED,
            ),
            (
                SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED,
            ),
        ] {
            for value in ["true", "1", " ON ", "yes"] {
                assert_eq!(
                    effective_boolean_privacy_preference(key, Some(value)),
                    Some(true),
                    "{key}={value}"
                );
            }
            for value in ["false", "0", " OFF ", "no"] {
                assert_eq!(
                    effective_boolean_privacy_preference(key, Some(value)),
                    Some(false),
                    "{key}={value}"
                );
            }
            for value in ["", "   ", "invalid"] {
                assert_eq!(
                    effective_boolean_privacy_preference(key, Some(value)),
                    Some(default),
                    "{key}={value}"
                );
            }
        }
        for key in [
            DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
            SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY,
            "ordinary-optional-preference",
        ] {
            assert_eq!(effective_boolean_privacy_preference(key, None), None);
            assert_eq!(
                effective_boolean_privacy_preference(key, Some("true")),
                None
            );
        }
    }

    #[tokio::test]
    async fn defaults_match_section_six_when_unset() {
        // The content mode and cap resolve through their env mirrors when unset,
        // which the Gateway spawn-env cases set on purpose; hold the same lock.
        let _telemetry = crate::telemetry::TestStateGuard::acquire();
        let store = temp_store();
        // Two on-by-default (opt-out), the rest off / empty / zero.
        assert!(product_analytics_enabled(&store).await);
        assert!(crash_reports_enabled(&store).await);
        assert!(!diagnostics_export_enabled(&store).await);
        assert_eq!(diagnostics_otlp_endpoint(&store).await, "");
        assert_eq!(
            diagnostics_otlp_content_mode(&store).await,
            ContentMode::MetadataOnly
        );
        assert_eq!(
            diagnostics_otlp_max_content_bytes(&store).await,
            DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES
        );
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
    async fn profile_activity_defaults_on_and_honors_opt_out() {
        let store = temp_store();
        // Opt-out: the user's own streak ping is on until they turn it off.
        assert!(profile_activity_enabled(&store).await);
        store
            .set(PROFILE_ACTIVITY_ENABLED_PREF_KEY, "false")
            .await
            .unwrap();
        assert!(!profile_activity_enabled(&store).await);
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

    #[test]
    fn content_mode_parsing_is_opt_in_only() {
        assert_eq!(ContentMode::parse("content"), ContentMode::Content);
        assert_eq!(ContentMode::parse(" CONTENT "), ContentMode::Content);
        assert_eq!(ContentMode::parse("full"), ContentMode::Content);
        for value in ["", "metadata_only", "true", "garbage"] {
            assert_eq!(
                ContentMode::parse(value),
                ContentMode::MetadataOnly,
                "{value}"
            );
        }
        assert_eq!(ContentMode::Content.as_str(), "content");
        assert_eq!(ContentMode::MetadataOnly.as_str(), "metadata_only");
        assert_eq!(parse_max_content_bytes("1024"), 1024);
        assert_eq!(
            parse_max_content_bytes("0"),
            DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES
        );
        assert_eq!(
            parse_max_content_bytes("x"),
            DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES
        );
    }

    #[tokio::test]
    async fn stored_content_mode_overrides_default() {
        let store = temp_store();
        store
            .set(DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY, "content")
            .await
            .unwrap();
        store
            .set(DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY, "2048")
            .await
            .unwrap();
        assert_eq!(
            diagnostics_otlp_content_mode(&store).await,
            ContentMode::Content
        );
        assert_eq!(diagnostics_otlp_max_content_bytes(&store).await, 2048);
    }

    #[tokio::test]
    async fn otlp_preset_prefs_resolve_stored_values() {
        let store = temp_store();
        assert_eq!(
            diagnostics_otlp_preset(&store).await.api_key_ref,
            std::env::var(DIAGNOSTICS_OTLP_API_KEY_REF_ENV).ok()
        );
        store
            .set(DIAGNOSTICS_OTLP_PRESET_PREF_KEY, " langfuse ")
            .await
            .unwrap();
        store
            .set(DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY, "secret:LANGFUSE_SK")
            .await
            .unwrap();
        store
            .set(DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY, "env:LANGFUSE_PK")
            .await
            .unwrap();
        let resolved = diagnostics_otlp_preset(&store).await;
        assert_eq!(resolved.preset.as_deref(), Some("langfuse"));
        assert_eq!(resolved.api_key_ref.as_deref(), Some("secret:LANGFUSE_SK"));
        assert_eq!(resolved.public_key_ref.as_deref(), Some("env:LANGFUSE_PK"));
    }

    #[test]
    fn preset_pref_writes_reject_unknown_presets_and_literal_keys() {
        assert!(validate_otlp_preset_pref(DIAGNOSTICS_OTLP_PRESET_PREF_KEY, "langfuse").is_ok());
        assert!(validate_otlp_preset_pref(DIAGNOSTICS_OTLP_PRESET_PREF_KEY, "").is_ok());
        assert!(validate_otlp_preset_pref(DIAGNOSTICS_OTLP_PRESET_PREF_KEY, "splunk").is_err());
        assert!(
            validate_otlp_preset_pref(DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY, "env:LS_KEY").is_ok()
        );
        assert!(validate_otlp_preset_pref(DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY, " ").is_ok());
        let literal =
            validate_otlp_preset_pref(DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY, "pk-lf-123")
                .unwrap_err();
        assert!(!literal.contains("pk-lf-123"), "{literal}");
        assert!(validate_otlp_preset_pref(DIAGNOSTICS_OTLP_PROJECT_PREF_KEY, "anything").is_ok());
    }

    #[test]
    fn destination_pref_keys_cover_endpoint_and_preset_fields() {
        for key in [
            DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
            DIAGNOSTICS_OTLP_PRESET_PREF_KEY,
            DIAGNOSTICS_OTLP_PROJECT_PREF_KEY,
            DIAGNOSTICS_OTLP_REGION_PREF_KEY,
            DIAGNOSTICS_OTLP_API_KEY_REF_PREF_KEY,
            DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_PREF_KEY,
        ] {
            assert!(is_otlp_destination_pref_key(key), "{key}");
        }
        assert!(!is_otlp_destination_pref_key(
            DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY
        ));
        assert!(!is_otlp_destination_pref_key(
            DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY
        ));
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
