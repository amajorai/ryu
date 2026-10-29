//! OpenTelemetry export seam (#539, P1) — the consent-gated OTLP drain.
//!
//! OTel is **not a backend**; it is the vendor-neutral instrumentation seam. Core
//! already writes `tracing` spans everywhere and keeps an always-on local sink
//! (`server/trace.rs`, the `~/.ryu/traces.db` SQLite store, the stdout `fmt` layer,
//! and an optional bounded file layer for detached launchers). This module adds an
//! *additional, consented* drain: when — and only
//! when — the user has opted in (`diagnostics-export-enabled`) **and** an OTLP
//! endpoint is configured (`diagnostics-otlp-endpoint` / the OTel-standard
//! `OTEL_EXPORTER_OTLP_ENDPOINT`), `main.rs` installs a `tracing-opentelemetry`
//! layer that exports the same `tracing` spans over OTLP/HTTP. With the pref off,
//! a dynamic filter drops every span, so **zero spans egress** and `trace.rs`
//! behaviour is unchanged by construction (it is a plain SQLite store, not a
//! `tracing-subscriber` layer). With no endpoint, the OTel layer is not installed.
//!
//! Exporter presets (`diagnostics-otlp-preset`) shape the destination for
//! Langfuse, LangSmith, Braintrust, Arize Phoenix, Helicone, and Datadog on top
//! of the same exporter (traces URL + auth headers + resource attributes, with
//! credentials given as secret references). The hierarchical run-trace store
//! (`ryu_tracing`) is bridged in through [`TraceSpanBridge`], so agent runs,
//! model/tool calls, and retrieval spans arrive at those backends as one tree.
//!
//! Placement (Core vs Gateway): this exports *what runs* on the local node for
//! the user's own diagnostics; it never enforces policy. The destination is a
//! swappable config value, never a hardcoded vendor — pointing at Axiom, Grafana,
//! a self-hosted Collector, or off is one pref/env change with no code change.

pub mod content;
pub mod propagation;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use opentelemetry::trace::{Span as _, Tracer as _, TracerProvider as _};
use opentelemetry::{Key, KeyValue};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
use opentelemetry_sdk::Resource;
use tracing::Level;
use tracing_subscriber::{
    filter::{filter_fn, LevelFilter},
    Layer,
};

use crate::privacy::ContentMode;
use crate::server::preferences::PreferencesStore;

/// The OTel service name reported for Core's exported spans.
const SERVICE_NAME: &str = "ryu-core";

/// The instrumentation scope name passed to `provider.tracer(..)`.
const TRACER_SCOPE: &str = "ryu-core";

/// Process-global diagnostics consent, seeded at startup and updated by live
/// preference writes. `gateway_spawn_env()` forwards the same gate into the
/// sidecar. The endpoint remains the gate's other half; consent alone never
/// egresses anything.
static EXPORT_CONSENT: AtomicBool = AtomicBool::new(false);

/// Endpoint changes cannot replace the Core provider already installed in the
/// global subscriber. Keep egress off until Core restarts and builds a provider
/// for the new endpoint.
static ENDPOINT_RESTART_REQUIRED: AtomicBool = AtomicBool::new(false);

/// Content-mode opt-in (`diagnostics-otlp-content-mode = content`), seeded at
/// startup and updated by live preference writes. Only half of the gate:
/// [`content_enabled`] also requires export consent.
static CONTENT_MODE: AtomicBool = AtomicBool::new(false);

/// Per-span exported content cap (`diagnostics-otlp-max-content-bytes`).
static MAX_CONTENT_BYTES: AtomicUsize =
    AtomicUsize::new(crate::privacy::DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES);

/// The installed tracer provider, kept so exit paths can flush/shut it down and
/// the test-span route can force a flush. Unset when no exporter was built.
static PROVIDER: std::sync::OnceLock<SdkTracerProvider> = std::sync::OnceLock::new();

/// Why the OTLP exporter could not be built for the configured endpoint (for
/// example an invalid URI). Set at most once at startup; while set, consent
/// stays off so no span is built for a drain that cannot export.
static EXPORTER_ERROR: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The resolved preset destination (`None` = the plain endpoint path). Seeded
/// once at startup; forwarded to the Gateway by [`gateway_export_env`].
static EXPORT_TARGET: std::sync::OnceLock<Option<ryu_tracing::export_presets::ResolvedExport>> =
    std::sync::OnceLock::new();

/// Upper bound on a flush/shutdown so a dead destination cannot hang exit.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// The OTLP/HTTP traces signal path appended to a base endpoint.
const TRACES_PATH: &str = "/v1/traces";

/// The resolved OTLP endpoint, seeded once at startup so the gateway-spawn path
/// can forward it. `None` (unset/empty) means no destination → no export.
static OTLP_ENDPOINT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Env var carrying OTLP request headers (the OTel-standard name; e.g.
/// `Authorization=Bearer <key>`). Read directly here to FORWARD it to the
/// gateway child — `opentelemetry-otlp` itself reads this env when it builds the
/// exporter, so a destination needing auth (PostHog, Axiom) works with no
/// Ryu-specific code. This is the vendor-neutral primitive. When only the
/// PostHog key is set, [`derived_exporter_headers`] passes the derived bearer to
/// Core's own exporter too.
pub const OTLP_HEADERS_ENV: &str = "OTEL_EXPORTER_OTLP_HEADERS";

/// PostHog convenience (#548, P6). PostHog's OTLP ingestion authenticates with the
/// project API key as a bearer token. Rather than make the user hand-assemble the
/// `OTEL_EXPORTER_OTLP_HEADERS` string, an operator/desktop may set just the key
/// here and Core derives the standard headers env from it. Still fully swappable:
/// any OTLP destination works via the raw headers env; this is only sugar for the
/// PostHog-LLM-analytics path the issue names. Never hardcodes a vendor endpoint —
/// the endpoint is still `diagnostics-otlp-endpoint`.
pub const POSTHOG_KEY_ENV: &str = "RYU_POSTHOG_KEY";

/// Whether the user consented to data-plane OTLP export to the active endpoint.
/// Used by `gateway_spawn_env()` to forward consent into the gateway sidecar so the
/// gateway's `gen_ai.*` spans drain to the SAME configured destination only when the
/// user opted in. Defaults to `false` until seeded (§6 opt-in posture).
pub fn is_export_consented() -> bool {
    EXPORT_CONSENT.load(Ordering::Relaxed)
}

/// Apply a live consent toggle when the startup endpoint is still active.
pub fn set_export_consent(enabled: bool) {
    EXPORT_CONSENT.store(
        consent_allowed(
            enabled,
            otlp_endpoint().is_some(),
            EXPORTER_ERROR.get().is_some(),
            ENDPOINT_RESTART_REQUIRED.load(Ordering::Relaxed),
        ),
        Ordering::Relaxed,
    );
}

/// Pure consent decision: the user opted in, an endpoint is active, its
/// exporter was built, and no endpoint change is waiting for a restart.
fn consent_allowed(
    enabled: bool,
    endpoint_configured: bool,
    exporter_failed: bool,
    restart_required: bool,
) -> bool {
    enabled && endpoint_configured && !exporter_failed && !restart_required
}

/// Stop egress after the configured destination changes. Core must restart to
/// rebuild its exporter with the new endpoint.
pub fn note_otlp_endpoint_changed() {
    ENDPOINT_RESTART_REQUIRED.store(true, Ordering::Relaxed);
    EXPORT_CONSENT.store(false, Ordering::Relaxed);
}

/// The seeded OTLP endpoint, exposed so `gateway_spawn_env()` can forward it under
/// the OTel-standard `OTEL_EXPORTER_OTLP_ENDPOINT` name. `None` = no destination.
pub fn otlp_endpoint() -> Option<String> {
    OTLP_ENDPOINT.get().cloned().flatten()
}

/// Serialises the tests that drive the process-global export consent, content
/// mode and byte cap, and the env mirrors a Gateway spawn must override.
#[cfg(test)]
static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test seam for [`OTLP_ENDPOINT`], which `build_otlp_layer` seeds once at
/// startup and unit tests never run. The first value wins for the whole test
/// process, so callers assert against the returned endpoint, not their input.
#[cfg(test)]
pub(crate) fn seed_otlp_endpoint_for_test(endpoint: &str) -> String {
    let _ = OTLP_ENDPOINT.set(Some(endpoint.to_owned()));
    otlp_endpoint().expect("the process-wide OTLP endpoint was seeded")
}

/// Holds [`TEST_STATE_LOCK`], resets consent, content mode, byte cap and the two
/// content env mirrors to the shipped defaults, and puts back what it found on
/// drop (also when an assertion unwinds), so no case leaks state to the next.
#[cfg(test)]
pub(crate) struct TestStateGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    consent: bool,
    content: bool,
    max_bytes: usize,
    mirrors: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

#[cfg(test)]
impl TestStateGuard {
    pub(crate) fn acquire() -> Self {
        let lock = TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mirrors = [
            crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV,
            crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV,
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect::<Vec<_>>();
        let guard = Self {
            _lock: lock,
            consent: EXPORT_CONSENT.load(Ordering::Relaxed),
            content: CONTENT_MODE.load(Ordering::Relaxed),
            max_bytes: MAX_CONTENT_BYTES.load(Ordering::Relaxed),
            mirrors,
        };
        EXPORT_CONSENT.store(false, Ordering::Relaxed);
        set_content_mode(ContentMode::MetadataOnly);
        set_max_content_bytes(crate::privacy::DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES);
        for (name, _) in &guard.mirrors {
            std::env::remove_var(name);
        }
        guard
    }
}

#[cfg(test)]
impl Drop for TestStateGuard {
    fn drop(&mut self) {
        EXPORT_CONSENT.store(self.consent, Ordering::Relaxed);
        CONTENT_MODE.store(self.content, Ordering::Relaxed);
        MAX_CONTENT_BYTES.store(self.max_bytes, Ordering::Relaxed);
        for (name, value) in &self.mirrors {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// Apply a live content-mode change. Takes effect for spans created afterwards;
/// the gateway picks it up on its next respawn.
pub fn set_content_mode(mode: ContentMode) {
    CONTENT_MODE.store(mode == ContentMode::Content, Ordering::Relaxed);
}

/// Apply a live content byte-cap change.
pub fn set_max_content_bytes(bytes: usize) {
    MAX_CONTENT_BYTES.store(bytes.max(1), Ordering::Relaxed);
}

/// The user's content-mode choice, independent of consent. Used to forward the
/// mode to the gateway; span call sites use [`content_enabled`] instead.
pub fn content_mode() -> ContentMode {
    if CONTENT_MODE.load(Ordering::Relaxed) {
        ContentMode::Content
    } else {
        ContentMode::MetadataOnly
    }
}

/// Whether spans may carry prompt/completion/tool content right now: the user
/// opted into content mode AND export consent is on (with an active endpoint).
/// Call sites must check this before building any content attribute.
pub fn content_enabled() -> bool {
    content_mode() == ContentMode::Content && is_export_consented()
}

/// The per-span byte cap for exported content (default 750000).
pub fn max_content_bytes() -> usize {
    MAX_CONTENT_BYTES.load(Ordering::Relaxed)
}

/// Whether a content-mode / byte-cap preference write must respawn the managed
/// Gateway: only while export is consented (otherwise the Gateway is forced to
/// `metadata_only` regardless) and only when the effective value changed.
pub fn content_settings_need_gateway_refresh(
    export_consented: bool,
    previous: (ContentMode, usize),
    current: (ContentMode, usize),
) -> bool {
    export_consented && previous != current
}

/// Resolve a configured OTLP base endpoint to the traces signal URL.
///
/// The exporter uses a programmatic endpoint verbatim, so the signal path must
/// be appended here (Claude Platform parity: base URL plus optional prefix):
/// no path or `/` → `/v1/traces`; a path already ending in `/v1/traces` is kept;
/// any other path is treated as a prefix and gets `/v1/traces` appended. A query
/// string is preserved after the path.
pub fn resolve_traces_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    let (base, query) = match trimmed.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (trimmed, None),
    };
    let base = base.trim_end_matches('/');
    let mut resolved = if base.ends_with(TRACES_PATH) {
        base.to_owned()
    } else {
        format!("{base}{TRACES_PATH}")
    };
    if let Some(query) = query {
        resolved.push('?');
        resolved.push_str(query);
    }
    resolved
}

/// Whether a detected `service.name` came from the operator
/// (`OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`) rather than the SDK's
/// `unknown_service` fallback.
fn is_operator_service_name(detected: Option<&str>) -> bool {
    detected.is_some_and(|name| !name.is_empty() && !name.starts_with("unknown_service"))
}

/// Build the exported resource: the SDK env detectors (`OTEL_SERVICE_NAME`,
/// `OTEL_RESOURCE_ATTRIBUTES`, telemetry.sdk.*) win; otherwise `service.name`
/// defaults to `ryu-core` and `service.version` to this build's version.
fn build_resource(extra: &std::collections::BTreeMap<String, String>) -> Resource {
    let detected = Resource::builder().build();
    let service_name = detected
        .get(&Key::from_static_str("service.name"))
        .map(|value| value.as_str().into_owned());
    let mut builder = Resource::builder();
    if !is_operator_service_name(service_name.as_deref()) {
        builder = builder.with_service_name(SERVICE_NAME);
    }
    if detected
        .get(&Key::from_static_str("service.version"))
        .is_none()
    {
        builder =
            builder.with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")));
    }
    for (key, value) in extra {
        builder = builder.with_attribute(KeyValue::new(key.clone(), value.clone()));
    }
    builder.build()
}

/// Headers Core's OWN exporter must add programmatically. `opentelemetry-otlp`
/// already reads `OTEL_EXPORTER_OTLP_HEADERS` itself, so only the derived
/// PostHog bearer (set via `RYU_POSTHOG_KEY` with no raw headers env) needs to be
/// passed explicitly — before this, only the gateway child received it.
fn derived_exporter_headers() -> HashMap<String, String> {
    let raw_set = std::env::var(OTLP_HEADERS_ENV).is_ok_and(|raw| !raw.trim().is_empty());
    if raw_set {
        return HashMap::new();
    }
    otlp_headers_env()
        .map(|headers| parse_headers(&headers))
        .unwrap_or_default()
}

/// Parse the OTel `k=v,k2=v2` headers form (values are not URL-decoded here; the
/// derived bearer never needs it).
fn parse_headers(raw: &str) -> HashMap<String, String> {
    raw.split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

/// Install the global W3C trace-context propagator (idempotent).
pub fn install_propagator() {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
}

/// Flush pending spans (bounded by the batch processor). No-op without an
/// installed exporter. Blocking: call from `spawn_blocking` in async code.
pub fn force_flush() -> Result<(), String> {
    match PROVIDER.get() {
        Some(provider) => provider.force_flush().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Flush and shut down the exporter on graceful exit. Blocking, bounded by
/// [`FLUSH_TIMEOUT`]; safe to call more than once and without an exporter.
pub fn shutdown() {
    if let Some(provider) = PROVIDER.get() {
        if let Err(error) = provider.shutdown_with_timeout(FLUSH_TIMEOUT) {
            crate::log_rotation::write_diagnostic(format!(
                "telemetry: OTLP shutdown flush failed: {error}"
            ));
        }
    }
}

/// Outcome of [`send_test_span`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestSpanError {
    /// Export consent is off (or the endpoint changed and Core must restart).
    ConsentOff,
    /// No OTLP endpoint configured.
    NoExporter,
    /// An endpoint is configured but its exporter could not be built.
    ExporterInvalid(String),
    /// The flush to the destination failed.
    ExportFailed(String),
}

impl std::fmt::Display for TestSpanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConsentOff => f.write_str(
                "diagnostics export is off (or the endpoint changed; restart Core to apply it)",
            ),
            Self::NoExporter => f.write_str("no OTLP endpoint is configured"),
            Self::ExporterInvalid(error) => {
                write!(f, "the configured OTLP endpoint is invalid: {error}")
            }
            Self::ExportFailed(error) => write!(f, "export to the OTLP endpoint failed: {error}"),
        }
    }
}

/// Send one `ryu.test` span to the configured destination and flush it, so the
/// user can verify the endpoint/auth. Refuses unless export consent is on.
/// Blocking (the flush waits on the exporter): call from `spawn_blocking`.
/// Returns the base endpoint on success.
pub fn send_test_span() -> Result<String, TestSpanError> {
    if let Some(error) = EXPORTER_ERROR.get() {
        return Err(TestSpanError::ExporterInvalid(error.clone()));
    }
    if !is_export_consented() {
        return Err(TestSpanError::ConsentOff);
    }
    let (Some(provider), Some(endpoint)) = (PROVIDER.get(), otlp_endpoint()) else {
        return Err(TestSpanError::NoExporter);
    };
    let tracer = provider.tracer(TRACER_SCOPE);
    let mut span = tracer.start("ryu.test");
    span.set_attribute(KeyValue::new("ryu.test", true));
    span.set_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")));
    span.end();
    force_flush().map_err(TestSpanError::ExportFailed)?;
    Ok(endpoint)
}

/// Resolve the OTLP request-headers env value to forward to the gateway child.
///
/// Resolution (nothing hardcoded): an explicit `OTEL_EXPORTER_OTLP_HEADERS` always
/// wins (the vendor-neutral primitive, works for Axiom/Grafana/any OTLP sink). If
/// it is unset but a PostHog key is configured (`RYU_POSTHOG_KEY`), derive the
/// standard bearer-auth headers string PostHog expects. Returns `None` when neither
/// is set (an endpoint that needs no auth, e.g. a local Collector, still works).
pub fn otlp_headers_env() -> Option<String> {
    if let Ok(raw) = std::env::var(OTLP_HEADERS_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(key) = std::env::var(POSTHOG_KEY_ENV) {
        let key = key.trim();
        if !key.is_empty() {
            // OTLP headers are a comma-joined `k=v` list; PostHog ingests with the
            // project key as a bearer token.
            return Some(format!("Authorization=Bearer {key}"));
        }
    }
    None
}

/// Pure gate decision: does the resolved config call for an OTLP exporter?
///
/// Export happens only when the user opted in **and** a non-empty destination is
/// configured. Extracted as a pure fn (mirrors `privacy::SupportAccessLocal::is_active`)
/// so the "pref off / no endpoint → layer absent" rule is unit-testable without
/// touching the process-global subscriber.
pub fn should_export(enabled: bool, endpoint: &str) -> bool {
    enabled && !endpoint.trim().is_empty()
}

/// Resolve the export config from prefs (+ env mirrors) and build the OTLP
/// exporter + tracer provider for a configured endpoint. A dynamic consent filter
/// blocks egress until the user opts in and stops it again on an in-session opt-out.
///
/// Returns `None` when no endpoint is set or the exporter fails to build. With
/// consent off and an endpoint set, it returns a filtered no-op layer so a live
/// opt-in works without restarting Core. Changing the endpoint requires a restart
/// because the exporter binds its destination at construction.
///
/// The layer is boxed (`dyn Layer`) so `main.rs` can add an `Option<BoxedLayer>`
/// uniformly — `Option<L: Layer>` is itself a `Layer`, with `None` doing nothing.
pub async fn build_otlp_layer<S>(
    prefs: &PreferencesStore,
) -> Option<(Box<dyn Layer<S> + Send + Sync>, SdkTracerProvider)>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a> + Send + Sync,
{
    let enabled = crate::privacy::diagnostics_export_enabled(prefs).await;
    let endpoint = crate::privacy::diagnostics_otlp_endpoint(prefs).await;
    set_content_mode(crate::privacy::diagnostics_otlp_content_mode(prefs).await);
    set_max_content_bytes(crate::privacy::diagnostics_otlp_max_content_bytes(prefs).await);
    // Propagation is harmless without an exporter: with no OTel layer the spans
    // carry no valid context, so nothing is injected.
    install_propagator();

    // A preset turns the configured fields into a full traces URL + headers. A
    // preset that cannot resolve (missing key, bad reference) disables export
    // and is reported by the test-span route; it never falls back to sending
    // unauthenticated spans somewhere else.
    let preset_prefs = crate::privacy::diagnostics_otlp_preset(prefs).await;
    let target = match resolve_export_target(&preset_prefs, &endpoint).await {
        Ok(target) => target,
        Err(error) => {
            let _ = OTLP_ENDPOINT.set(None);
            let _ = EXPORT_TARGET.set(None);
            let _ = EXPORTER_ERROR.set(error.clone());
            EXPORT_CONSENT.store(false, Ordering::Relaxed);
            tracing::warn!(
                error = %error,
                "telemetry: OTLP exporter preset could not be resolved; export disabled"
            );
            return None;
        }
    };
    let destination = match &target {
        Some(target) => target.traces_endpoint.clone(),
        None => endpoint.trim().to_string(),
    };

    // Seed the process-globals so the SYNC `gateway_spawn_env()` forwards the same
    // consent and destination to the Gateway sidecar, which has no PreferencesStore.
    let endpoint_configured = !destination.is_empty();
    let _ = OTLP_ENDPOINT.set(if endpoint_configured {
        Some(destination.clone())
    } else {
        None
    });
    let _ = EXPORT_TARGET.set(target.clone());
    ENDPOINT_RESTART_REQUIRED.store(false, Ordering::Relaxed);
    EXPORT_CONSENT.store(enabled && endpoint_configured, Ordering::Relaxed);

    if !endpoint_configured {
        return None;
    }

    let mut headers = derived_exporter_headers();
    let mut resource_attributes = std::collections::BTreeMap::new();
    let traces_url = match &target {
        Some(target) => {
            headers.extend(target.headers.clone());
            resource_attributes.extend(target.resource_attributes.clone());
            target.traces_endpoint.clone()
        }
        None => resolve_traces_endpoint(&destination),
    };
    let endpoint = destination;

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(traces_url)
        .with_headers(headers)
        .build()
    {
        Ok(exporter) => exporter,
        Err(e) => {
            // Nothing can export: keep consent off so no span (or content) is
            // built for a drain that does not exist, and let the test-span
            // route report the real cause.
            let _ = EXPORTER_ERROR.set(e.to_string());
            EXPORT_CONSENT.store(false, Ordering::Relaxed);
            tracing::warn!(
                error = %e,
                "telemetry: OTLP exporter build failed; export disabled (local sink unaffected)"
            );
            return None;
        }
    };
    // Consent is re-checked at export time too: a span that opened while
    // consent was on (a whole agent turn, say) is dropped, not sent, when it
    // ends after an opt-out, and so is anything still queued in the batch.
    let exporter = ConsentGatedExporter {
        inner: exporter,
        consented: is_export_consented,
    };

    // ParentBased(AlwaysOn): honor an inbound `traceparent`'s sampled flag, sample
    // every local root.
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::AlwaysOn)))
        .with_id_generator(PinnedIdGenerator::default())
        .with_resource(build_resource(&resource_attributes))
        .build();
    let _ = PROVIDER.set(provider.clone());

    let tracer = provider.tracer(TRACER_SCOPE);

    if enabled {
        tracing::info!(
            endpoint = %endpoint,
            "telemetry: OTLP export enabled (consented); spans drain to the configured endpoint"
        );
    } else {
        tracing::debug!(endpoint = %endpoint, "telemetry: OTLP exporter is ready but consent is off");
    }

    // Only export INFO+ spans so the drain stays a wide-event stream, not a
    // debug firehose; the local fmt/SQLite sinks keep their own verbosity.
    let endpoint_gate = endpoint.clone();
    let layer = tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_filter(LevelFilter::from_level(Level::INFO))
        .with_filter(filter_fn(move |_| {
            should_export(is_export_consented(), &endpoint_gate)
        }))
        .boxed();

    Some((layer, provider))
}

// ── Exporter presets ──────────────────────────────────────────────────────────

/// Resolve the preset prefs into a destination. `Ok(None)` keeps the plain
/// endpoint path (generic `otlp` with no API-key reference) byte-identical to
/// the pre-preset behaviour. Errors carry no secret values.
async fn resolve_export_target(
    prefs: &crate::privacy::OtlpPresetPrefs,
    endpoint: &str,
) -> Result<Option<ryu_tracing::export_presets::ResolvedExport>, String> {
    use ryu_tracing::export_presets::{resolve, ExporterPreset, PresetError, PresetSettings};

    let raw_preset = prefs.preset.as_deref().unwrap_or_default();
    let preset = ExporterPreset::parse(raw_preset)
        .ok_or_else(|| PresetError::UnknownPreset(raw_preset.to_owned()).to_string())?;
    if preset == ExporterPreset::Otlp && prefs.api_key_ref.is_none() {
        return Ok(None);
    }
    if preset == ExporterPreset::Otlp && endpoint.trim().is_empty() {
        // An API key with no destination exports nothing: same as unset.
        return Ok(None);
    }
    let api_key = match prefs.api_key_ref.as_deref() {
        Some(reference) => Some(resolve_secret_reference(reference).await?),
        None => None,
    };
    let public_key = match prefs.public_key_ref.as_deref() {
        Some(reference) => Some(resolve_secret_reference(reference).await?),
        None => None,
    };
    let settings = PresetSettings {
        preset,
        endpoint: Some(endpoint.trim().to_owned()).filter(|value| !value.is_empty()),
        project: prefs.project.clone(),
        region: prefs.region.clone(),
        api_key,
        public_key,
    };
    resolve(&settings)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// Resolve one credential reference: `env:` / `file:` locally, `secret:` from
/// this node's vault (node scope, active environment).
async fn resolve_secret_reference(raw: &str) -> Result<String, String> {
    use ryu_tracing::export_presets::SecretReference;

    let reference = SecretReference::parse(raw).map_err(|error| error.to_string())?;
    let SecretReference::Vault(body) = &reference else {
        return reference.resolve_local().map_err(|error| error.to_string());
    };
    let label = reference.label();
    let store = crate::plugin_secrets::open_default()
        .map_err(|error| format!("{label}: the node vault is unavailable ({error})"))?;
    let node_id = crate::sidecar::control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(crate::server::agent_sync::local_node_id);
    let context = crate::plugin_secrets::SecretResolutionContext::node_only(node_id, Vec::new());
    match store.resolve_vault_secret(body, &context).await {
        Ok(Some(value)) if !value.trim().is_empty() => Ok(value.trim().to_owned()),
        Ok(_) => Err(format!("{label} is not set in the node vault")),
        Err(error) => Err(format!("{label}: {error}")),
    }
}

/// The resolved preset destination, when one is active.
pub fn export_target() -> Option<ryu_tracing::export_presets::ResolvedExport> {
    EXPORT_TARGET.get().cloned().flatten()
}

/// Merge two OTel `k=v,k2=v2` strings; keys in `overrides` win.
fn merge_pairs(
    base: Option<&str>,
    overrides: &std::collections::BTreeMap<String, String>,
) -> String {
    let mut merged: Vec<(String, String)> = base
        .map(parse_headers)
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, _)| !overrides.contains_key(key))
        .collect();
    merged.sort();
    merged.extend(overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// The headers the Gateway child must send: the operator's raw OTLP headers
/// (or the PostHog-derived bearer) plus the active preset's auth headers.
pub fn gateway_otlp_headers_env() -> Option<String> {
    let target = export_target();
    let base = otlp_headers_env();
    match target {
        Some(target) if !target.headers.is_empty() => {
            Some(merge_pairs(base.as_deref(), &target.headers))
        }
        _ => base,
    }
}

/// Extra env for the Gateway child inside the consented branch: the preset's
/// verbatim traces URL and resource attributes. Always pins the Gateway's own
/// preset env to `otlp`, because Core has already resolved the destination
/// (an inherited operator preset must not re-resolve it differently).
pub fn gateway_export_env() -> Vec<(String, String)> {
    // Blank the credential references too: with an inherited
    // `RYU_DIAGNOSTICS_OTLP_API_KEY_REF`, the Gateway's generic `otlp` preset
    // would otherwise re-resolve it into an extra `Authorization: Bearer`
    // header next to the auth Core already forwarded.
    let mut env = vec![
        (
            crate::privacy::DIAGNOSTICS_OTLP_PRESET_ENV.to_owned(),
            "otlp".to_owned(),
        ),
        (
            crate::privacy::DIAGNOSTICS_OTLP_API_KEY_REF_ENV.to_owned(),
            String::new(),
        ),
        (
            crate::privacy::DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_ENV.to_owned(),
            String::new(),
        ),
    ];
    if let Some(target) = export_target() {
        env.push((
            OTLP_TRACES_ENDPOINT_ENV.to_owned(),
            target.traces_endpoint.clone(),
        ));
        if !target.resource_attributes.is_empty() {
            let inherited = std::env::var(OTLP_RESOURCE_ATTRIBUTES_ENV).ok();
            env.push((
                OTLP_RESOURCE_ATTRIBUTES_ENV.to_owned(),
                merge_pairs(inherited.as_deref(), &target.resource_attributes),
            ));
        }
    }
    env
}

/// The OTel-standard signal-specific traces URL (used verbatim by exporters).
pub const OTLP_TRACES_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";

/// The OTel-standard resource attributes env.
const OTLP_RESOURCE_ATTRIBUTES_ENV: &str = "OTEL_RESOURCE_ATTRIBUTES";

// ── Run-trace store bridge ────────────────────────────────────────────────────

/// What the local run-trace store may persist as span inputs/outputs: payloads
/// only when the user chose `diagnostics-otlp-content-mode = content`, capped
/// at the content byte limit. Read live on every span.
pub fn trace_content_policy() -> ryu_tracing::ContentPolicy {
    if content_mode() == ContentMode::Content {
        ryu_tracing::ContentPolicy::capture(max_content_bytes())
    } else {
        ryu_tracing::ContentPolicy::metadata_only()
    }
}

/// Registered store name (content-key input; never rename).
pub const TRACE_STORE: &str = "traces.db";

/// Seals captured span payloads (prompts, completions, tool arguments and
/// results) in `traces.db` under the store's content key, each bound to its
/// span row id and column.
pub struct TraceContentSealer {
    cipher: ryu_crypto::ContentCipher,
}

impl TraceContentSealer {
    pub fn new(cipher: ryu_crypto::ContentCipher) -> Self {
        Self { cipher }
    }
}

impl ryu_tracing::ContentSealer for TraceContentSealer {
    fn seal(&self, plaintext: &str, purpose: &str, id: &str) -> anyhow::Result<String> {
        self.cipher
            .seal_text(plaintext, &ryu_crypto::ContentContext::for_id(purpose, id))
    }

    fn open(&self, stored: &str, purpose: &str, id: &str) -> anyhow::Result<String> {
        Ok(self
            .cipher
            .open_text(stored, &ryu_crypto::ContentContext::for_id(purpose, id))?
            .value)
    }

    fn is_sealed(&self, stored: &str) -> bool {
        ryu_crypto::ContentCipher::is_sealed_text(stored)
    }
}

/// Exports each ended run-trace span (agent run, model/tool call, retrieval,
/// …) through Core's consented OTLP provider with its stored trace/span ids,
/// so preset backends receive the same tree the desktop shows. Payloads are
/// attached only while [`content_enabled`] holds.
#[derive(Debug, Default, Clone, Copy)]
pub struct TraceSpanBridge;

impl ryu_tracing::SpanSink for TraceSpanBridge {
    fn on_span_end(&self, span: &ryu_tracing::Span) {
        if !is_export_consented() {
            return;
        }
        let Some(provider) = PROVIDER.get() else {
            return;
        };
        let tracer = provider.tracer(TRACER_SCOPE);
        export_store_span(&tracer, span, content_enabled(), max_content_bytes());
    }
}

fn unix_ms(ms: i64) -> std::time::SystemTime {
    std::time::UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap_or_default())
}

fn json_attribute(key: String, value: &serde_json::Value) -> Option<KeyValue> {
    Some(match value {
        serde_json::Value::Bool(flag) => KeyValue::new(key, *flag),
        serde_json::Value::Number(number) => match number.as_i64() {
            Some(int) => KeyValue::new(key, int),
            None => KeyValue::new(key, number.as_f64()?),
        },
        serde_json::Value::String(text) => KeyValue::new(key, text.clone()),
        serde_json::Value::Null => return None,
        other => KeyValue::new(key, other.to_string()),
    })
}

/// One exported payload attribute. Stored payloads are the raw local copy, so
/// they pass Core's export redaction (credentials, tokens, personal data) before
/// they leave the process, exactly like tool content on Core's GenAI tool spans.
/// Returns the attribute and whether it was cut to `max_bytes`.
fn content_attribute(
    key: &'static str,
    value: &serde_json::Value,
    max_bytes: usize,
) -> (KeyValue, bool) {
    let text = match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let redacted = crate::sidecar::gen_ai_spans::redact_tool_content(&text);
    let (kept, truncated) = content::truncate_tool_content(&redacted, max_bytes);
    (KeyValue::new(key, kept), truncated)
}

/// The OTel attributes for one stored span (OpenInference + GenAI names, so
/// Phoenix/Langfuse/LangSmith classify it; Ryu-specific keys under `ryu.`).
fn store_span_attributes(
    span: &ryu_tracing::Span,
    include_content: bool,
    max_bytes: usize,
) -> Vec<KeyValue> {
    let kind = span.normalized_kind();
    let mut attributes = vec![
        KeyValue::new("ryu.span.kind", span.kind.clone()),
        KeyValue::new("ryu.run_id", span.conversation_id.clone()),
        KeyValue::new("session.id", span.conversation_id.clone()),
    ];
    if let Some(kind) = kind {
        attributes.push(KeyValue::new(
            "openinference.span.kind",
            kind.openinference_kind(),
        ));
        if let Some(operation) = kind.gen_ai_operation() {
            attributes.push(KeyValue::new("gen_ai.operation.name", operation));
        }
        match kind {
            ryu_tracing::SpanKind::ModelCall => {
                attributes.push(KeyValue::new("gen_ai.request.model", span.name.clone()));
            }
            ryu_tracing::SpanKind::ToolCall => {
                attributes.push(KeyValue::new("gen_ai.tool.name", span.name.clone()));
            }
            ryu_tracing::SpanKind::AgentRun => {
                attributes.push(KeyValue::new("gen_ai.agent.name", span.name.clone()));
            }
            _ => {}
        }
    }
    if let Some(agent_id) = &span.agent_id {
        attributes.push(KeyValue::new("ryu.agent_id", agent_id.clone()));
        attributes.push(KeyValue::new("gen_ai.agent.id", agent_id.clone()));
    }
    if let Some(args_hash) = &span.args_hash {
        attributes.push(KeyValue::new("ryu.args_hash", args_hash.clone()));
    }
    attributes.extend(
        span.attributes
            .iter()
            .filter_map(|(key, value)| json_attribute(format!("ryu.attr.{key}"), value)),
    );
    if include_content {
        let mut truncated = false;
        for (key, payload) in [("input.value", &span.input), ("output.value", &span.output)] {
            if let Some(payload) = payload {
                let (attribute, cut) = content_attribute(key, payload, max_bytes);
                truncated |= cut;
                attributes.push(attribute);
            }
        }
        if truncated {
            attributes.push(KeyValue::new(content::CONTENT_TRUNCATED_ATTR, true));
        }
    }
    attributes
}

/// Build and end one OTel span from a stored span row. Rows without v2 ids
/// (written before the hierarchy existed) are skipped.
fn export_store_span<T>(
    tracer: &T,
    span: &ryu_tracing::Span,
    include_content: bool,
    max_bytes: usize,
) where
    T: opentelemetry::trace::Tracer,
{
    use opentelemetry::trace::{
        SpanBuilder, SpanContext, SpanId, SpanKind, Status, TraceContextExt as _, TraceFlags,
        TraceId, TraceState,
    };

    let (Some(trace_hex), Some(span_hex), Some(ended_at)) = (
        span.trace_id.as_deref(),
        span.span_id.as_deref(),
        span.ended_at,
    ) else {
        return;
    };
    let (Ok(trace_id), Ok(span_id)) = (TraceId::from_hex(trace_hex), SpanId::from_hex(span_hex))
    else {
        return;
    };
    let parent = match span
        .parent_span_id
        .as_deref()
        .and_then(|hex| SpanId::from_hex(hex).ok())
    {
        Some(parent_id) => {
            opentelemetry::Context::new().with_remote_span_context(SpanContext::new(
                trace_id,
                parent_id,
                TraceFlags::SAMPLED,
                true,
                TraceState::default(),
            ))
        }
        None => opentelemetry::Context::new(),
    };
    let status = match span.status {
        // The stored error is the tool's or memory store's own error text, which can
        // echo a request or response body. Like any other payload it leaves the process
        // only with the separate content opt-in, redacted and cut; metadata-only mode
        // exports just the status name.
        ryu_tracing::SpanStatus::Error | ryu_tracing::SpanStatus::Cancelled => {
            Status::error(match span.error.as_deref().filter(|_| include_content) {
                Some(error) => {
                    let redacted = crate::sidecar::gen_ai_spans::redact_tool_content(error);
                    content::truncate_tool_content(&redacted, max_bytes).0
                }
                None => span.status.to_string(),
            })
        }
        _ => Status::Ok,
    };
    let builder = SpanBuilder::from_name(span.name.clone())
        .with_kind(SpanKind::Internal)
        .with_start_time(unix_ms(span.started_at))
        .with_attributes(store_span_attributes(span, include_content, max_bytes));
    // The SDK takes ids from the provider's generator; pin the stored ids for
    // exactly this synchronous build (see `PinnedIdGenerator`).
    PINNED_IDS.with(|pinned| pinned.set(Some((trace_id, span_id))));
    let mut otel_span = tracer.build_with_context(builder, &parent);
    PINNED_IDS.with(|pinned| pinned.set(None));
    otel_span.set_status(status);
    otel_span.end_with_timestamp(unix_ms(ended_at));
}

thread_local! {
    /// Ids [`PinnedIdGenerator`] hands out for the span being built on this
    /// thread; `None` outside [`export_store_span`].
    static PINNED_IDS: std::cell::Cell<
        Option<(opentelemetry::trace::TraceId, opentelemetry::trace::SpanId)>,
    > = const { std::cell::Cell::new(None) };
}

/// Random ids, except while [`export_store_span`] pins a stored span's ids, so
/// run-trace spans keep their `trace_id`/`span_id` when exported (a parent is
/// referenced by its stored id, and backends can be cross-referenced with the
/// desktop viewer).
#[derive(Debug, Default)]
struct PinnedIdGenerator {
    random: opentelemetry_sdk::trace::RandomIdGenerator,
}

impl opentelemetry_sdk::trace::IdGenerator for PinnedIdGenerator {
    fn new_trace_id(&self) -> opentelemetry::trace::TraceId {
        PINNED_IDS
            .with(std::cell::Cell::get)
            .map_or_else(|| self.random.new_trace_id(), |(trace_id, _)| trace_id)
    }

    fn new_span_id(&self) -> opentelemetry::trace::SpanId {
        PINNED_IDS
            .with(std::cell::Cell::get)
            .map_or_else(|| self.random.new_span_id(), |(_, span_id)| span_id)
    }
}

/// Drops every batch while export consent is off. The layer filter only gates
/// span *creation*; this gates what actually leaves the process.
#[derive(Debug)]
struct ConsentGatedExporter<E> {
    inner: E,
    consented: fn() -> bool,
}

impl<E: opentelemetry_sdk::trace::SpanExporter> opentelemetry_sdk::trace::SpanExporter
    for ConsentGatedExporter<E>
{
    async fn export(
        &self,
        batch: Vec<opentelemetry_sdk::trace::SpanData>,
    ) -> opentelemetry_sdk::error::OTelSdkResult {
        if !(self.consented)() {
            return Ok(());
        }
        self.inner.export(batch).await
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> opentelemetry_sdk::error::OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
        self.inner.force_flush()
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

#[cfg(test)]
mod preset_bridge_tests {
    use super::{
        export_store_span, merge_pairs, resolve_export_target, store_span_attributes,
        PinnedIdGenerator,
    };
    use crate::privacy::OtlpPresetPrefs;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_sdk::trace::{SdkTracerProvider, SpanData};
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone, Default)]
    struct Capture(Arc<Mutex<Vec<SpanData>>>);

    impl opentelemetry_sdk::trace::SpanExporter for Capture {
        async fn export(&self, batch: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
            self.0.lock().unwrap().extend(batch);
            Ok(())
        }
    }

    fn key_file(contents: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ryu-otlp-preset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("key");
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[tokio::test]
    async fn generic_otlp_without_a_key_keeps_the_plain_endpoint_path() {
        let prefs = OtlpPresetPrefs::default();
        assert_eq!(
            resolve_export_target(&prefs, "https://otlp.example").await,
            Ok(None)
        );
    }

    #[tokio::test]
    async fn presets_resolve_file_references_and_reject_literals() {
        let path = key_file("ls-key\n");
        let prefs = OtlpPresetPrefs {
            preset: Some("langsmith".into()),
            project: Some("agents".into()),
            api_key_ref: Some(format!("file:{}", path.display())),
            ..OtlpPresetPrefs::default()
        };
        let target = resolve_export_target(&prefs, "").await.unwrap().unwrap();
        assert_eq!(
            target.traces_endpoint,
            "https://api.smith.langchain.com/otel/v1/traces"
        );
        assert_eq!(target.headers["x-api-key"], "ls-key");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();

        let literal = OtlpPresetPrefs {
            preset: Some("datadog".into()),
            api_key_ref: Some("dd-raw-key".into()),
            ..OtlpPresetPrefs::default()
        };
        let error = resolve_export_target(&literal, "").await.unwrap_err();
        assert!(error.contains("literal value"), "{error}");
        assert!(!error.contains("dd-raw-key"));

        let unknown = OtlpPresetPrefs {
            preset: Some("splunk".into()),
            ..OtlpPresetPrefs::default()
        };
        assert!(resolve_export_target(&unknown, "").await.is_err());

        let missing = OtlpPresetPrefs {
            preset: Some("helicone".into()),
            ..OtlpPresetPrefs::default()
        };
        assert!(resolve_export_target(&missing, "")
            .await
            .unwrap_err()
            .contains("Helicone API key"));
    }

    #[test]
    fn gateway_env_pins_the_generic_preset_and_blanks_credential_refs() {
        let env: std::collections::HashMap<_, _> =
            super::gateway_export_env().into_iter().collect();
        assert_eq!(env[crate::privacy::DIAGNOSTICS_OTLP_PRESET_ENV], "otlp");
        assert_eq!(env[crate::privacy::DIAGNOSTICS_OTLP_API_KEY_REF_ENV], "");
        assert_eq!(env[crate::privacy::DIAGNOSTICS_OTLP_PUBLIC_KEY_REF_ENV], "");
    }

    #[test]
    fn merge_pairs_lets_preset_headers_win() {
        let mut overrides = std::collections::BTreeMap::new();
        overrides.insert("Authorization".to_owned(), "Basic abc".to_owned());
        assert_eq!(
            merge_pairs(Some("Authorization=Bearer old,x-team=ops"), &overrides),
            "x-team=ops,Authorization=Basic abc"
        );
        assert_eq!(merge_pairs(None, &overrides), "Authorization=Basic abc");
    }

    fn stored_span(parent: Option<&str>) -> ryu_tracing::Span {
        let mut attributes = serde_json::Map::new();
        attributes.insert("hits".into(), serde_json::json!(3));
        ryu_tracing::Span {
            id: "row".into(),
            conversation_id: "conv-1".into(),
            kind: "tool-call".into(),
            name: "read_file".into(),
            args_hash: Some("abc".into()),
            started_at: 1_700_000_000_000,
            ended_at: Some(1_700_000_000_250),
            error: Some("denied".into()),
            session_id: None,
            seq: 1,
            trace_id: Some("0123456789abcdef0123456789abcdef".into()),
            span_id: Some("0123456789abcdef".into()),
            parent_span_id: parent.map(str::to_owned),
            status: ryu_tracing::SpanStatus::Error,
            agent_id: Some("agent-1".into()),
            attributes,
            input: Some(serde_json::json!({"path": "/etc/hosts"})),
            output: Some(serde_json::json!("x".repeat(64))),
        }
    }

    #[test]
    fn content_attributes_require_the_content_gate() {
        let span = stored_span(None);
        let keys = |include| -> Vec<String> {
            store_span_attributes(&span, include, 8)
                .into_iter()
                .map(|kv| kv.key.as_str().to_owned())
                .collect()
        };
        let metadata = keys(false);
        assert!(metadata.contains(&"openinference.span.kind".to_owned()));
        assert!(metadata.contains(&"gen_ai.tool.name".to_owned()));
        assert!(metadata.contains(&"ryu.attr.hits".to_owned()));
        assert!(!metadata.contains(&"input.value".to_owned()));
        let content = store_span_attributes(&span, true, 8);
        let output = content
            .iter()
            .find(|kv| kv.key.as_str() == "output.value")
            .unwrap();
        assert_eq!(output.value.as_str().len(), 8, "content is capped");
        assert!(content
            .iter()
            .any(|kv| kv.key.as_str() == "ryu.content.truncated"));
    }

    #[test]
    fn exported_payloads_are_redacted() {
        let mut span = stored_span(None);
        span.input = Some(serde_json::json!({
            "token": "ghp_abcdefghijklmnopqrstuvwxyz0123"
        }));
        span.output = Some(serde_json::json!("done"));
        let attributes = store_span_attributes(&span, true, 10_000);
        let input = attributes
            .iter()
            .find(|kv| kv.key.as_str() == "input.value")
            .unwrap()
            .value
            .as_str()
            .into_owned();
        assert!(
            !input.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"),
            "{input}"
        );
        assert!(input.contains("[REDACTED:"), "{input}");
        assert!(!attributes
            .iter()
            .any(|kv| kv.key.as_str() == "ryu.content.truncated"));
    }

    #[test]
    fn error_text_leaves_only_with_the_content_opt_in_and_redacted() {
        let status_message = |include_content: bool| {
            let capture = Capture::default();
            let provider = SdkTracerProvider::builder()
                .with_simple_exporter(capture.clone())
                .with_id_generator(PinnedIdGenerator::default())
                .build();
            let tracer = provider.tracer("test");
            let mut span = stored_span(None);
            span.error = Some("401 for key ghp_abcdefghijklmnopqrstuvwxyz0123".into());
            export_store_span(&tracer, &span, include_content, 4096);
            let spans = capture.0.lock().unwrap();
            match &spans[0].status {
                opentelemetry::trace::Status::Error { description } => description.to_string(),
                other => panic!("expected an error status, got {other:?}"),
            }
        };
        let metadata_only = status_message(false);
        assert_eq!(metadata_only, "error");
        let with_content = status_message(true);
        assert!(
            !with_content.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"),
            "{with_content}"
        );
        assert!(with_content.contains("[REDACTED:"), "{with_content}");
    }

    #[test]
    fn bridge_exports_with_stored_ids_parent_and_timing() {
        let capture = Capture::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(capture.clone())
            .with_id_generator(PinnedIdGenerator::default())
            .build();
        let tracer = provider.tracer("test");
        export_store_span(&tracer, &stored_span(Some("fedcba9876543210")), false, 100);
        let mut legacy = stored_span(None);
        legacy.span_id = None;
        export_store_span(&tracer, &legacy, false, 100);

        let spans = capture.0.lock().unwrap();
        assert_eq!(spans.len(), 1, "pre-v2 rows are not exported");
        let span = &spans[0];
        assert_eq!(
            span.span_context.trace_id().to_string(),
            "0123456789abcdef0123456789abcdef"
        );
        assert_eq!(span.span_context.span_id().to_string(), "0123456789abcdef");
        assert_eq!(span.parent_span_id.to_string(), "fedcba9876543210");
        let elapsed = span.end_time.duration_since(span.start_time).unwrap();
        assert_eq!(elapsed.as_millis(), 250);
        assert!(matches!(
            span.status,
            opentelemetry::trace::Status::Error { .. }
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consent_allowed, content_settings_need_gateway_refresh, is_operator_service_name,
        parse_headers, resolve_traces_endpoint, should_export, ConsentGatedExporter,
    };
    use opentelemetry_sdk::trace::{SpanData, SpanExporter as _};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Debug, Clone, Default)]
    struct Counting(Arc<AtomicUsize>);

    impl opentelemetry_sdk::trace::SpanExporter for Counting {
        async fn export(&self, batch: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
            self.0.fetch_add(batch.len().max(1), Ordering::SeqCst);
            Ok(())
        }
    }

    static GATE: AtomicBool = AtomicBool::new(false);
    fn gate() -> bool {
        GATE.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn consent_gated_exporter_drops_batches_after_opt_out() {
        let sent = Counting::default();
        let exporter = ConsentGatedExporter {
            inner: sent.clone(),
            consented: gate,
        };
        GATE.store(true, Ordering::SeqCst);
        exporter.export(Vec::new()).await.unwrap();
        assert_eq!(sent.0.load(Ordering::SeqCst), 1);
        // Opted out: late-ending or queued spans are dropped, not sent.
        GATE.store(false, Ordering::SeqCst);
        exporter.export(Vec::new()).await.unwrap();
        assert_eq!(sent.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn content_settings_refresh_only_on_consented_change() {
        use crate::privacy::ContentMode::{Content, MetadataOnly};
        // Export off: the Gateway never sees content settings.
        assert!(!content_settings_need_gateway_refresh(
            false,
            (MetadataOnly, 750_000),
            (Content, 750_000)
        ));
        // Same value re-written: no respawn.
        assert!(!content_settings_need_gateway_refresh(
            true,
            (Content, 1_000),
            (Content, 1_000)
        ));
        assert!(content_settings_need_gateway_refresh(
            true,
            (MetadataOnly, 750_000),
            (Content, 750_000)
        ));
        assert!(content_settings_need_gateway_refresh(
            true,
            (Content, 750_000),
            (Content, 1_000)
        ));
    }

    #[test]
    fn consent_requires_a_built_exporter() {
        assert!(consent_allowed(true, true, false, false));
        assert!(!consent_allowed(false, true, false, false));
        assert!(!consent_allowed(true, false, false, false));
        // An invalid endpoint (exporter build failed) keeps consent off.
        assert!(!consent_allowed(true, true, true, false));
        assert!(!consent_allowed(true, true, false, true));
    }

    #[test]
    fn traces_endpoint_appends_signal_path() {
        for (input, expected) in [
            ("https://otlp.example", "https://otlp.example/v1/traces"),
            ("https://otlp.example/", "https://otlp.example/v1/traces"),
            (" http://localhost:4318 ", "http://localhost:4318/v1/traces"),
            (
                "https://otlp.example/v1/traces",
                "https://otlp.example/v1/traces",
            ),
            (
                "https://otlp.example/v1/traces/",
                "https://otlp.example/v1/traces",
            ),
            (
                "https://us.i.posthog.com/i",
                "https://us.i.posthog.com/i/v1/traces",
            ),
            (
                "https://otlp.example/prefix/",
                "https://otlp.example/prefix/v1/traces",
            ),
            (
                "https://otlp.example/p?x=1",
                "https://otlp.example/p/v1/traces?x=1",
            ),
        ] {
            assert_eq!(resolve_traces_endpoint(input), expected, "{input}");
        }
    }

    #[test]
    fn service_name_defaults_unless_operator_set() {
        assert!(!is_operator_service_name(None));
        assert!(!is_operator_service_name(Some("unknown_service")));
        assert!(!is_operator_service_name(Some("unknown_service:ryu-core")));
        assert!(is_operator_service_name(Some("my-node")));
    }

    #[test]
    fn headers_parse_otel_form() {
        let headers = parse_headers("Authorization=Bearer abc, x-team = ops,bad");
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer abc")
        );
        assert_eq!(headers.get("x-team").map(String::as_str), Some("ops"));
        assert_eq!(headers.len(), 2);
    }

    #[test]
    fn export_requires_consent_and_endpoint() {
        // The opt-in default posture: off + empty → no export.
        assert!(!should_export(false, ""));
        // Endpoint set but consent withheld → still no export (pref off wins).
        assert!(!should_export(false, "https://otlp.example"));
        // Consented but no destination → nothing to export to.
        assert!(!should_export(true, ""));
        assert!(!should_export(true, "   "));
        // Both present → export.
        assert!(should_export(true, "https://otlp.example"));
    }
}
