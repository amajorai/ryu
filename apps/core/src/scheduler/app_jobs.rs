//! App-owned scheduled jobs: the generic `jobs.list` / `jobs.run` contract behind
//! [`JobTarget::AppJob`].
//!
//! Core holds no knowledge of what an app's jobs do. An app that wants scheduled
//! work `provides` two **fan-out** capabilities
//! ([`crate::plugins::binding::FANOUT_CAPABILITIES`]), and Core calls each
//! participating provider directly, by id, over the generic [`CapabilityConsumer`]
//! (no app id, port, sidecar name or route in here):
//!
//! | Capability | Body → reply | Used by |
//! |---|---|---|
//! | `jobs.list` | `{}` → `{ jobs: [{ id, name, schedule, enabled?, payload? }] }` | the reconcile loop ([`spawn`]) |
//! | `jobs.run` | `{ id, payload? }` → any 2xx | the [`JobTarget::AppJob`] tick |
//!
//! `schedule` is the scheduler's own wire form (`{ kind: "every", interval }` or
//! `{ kind: "cron", expr, tz? }`). A non-2xx `jobs.run` reply's `error` string,
//! cleaned and cut to [`MAX_PROVIDER_ERROR_BYTES`], is the job's failure.
//!
//! # Who takes part
//!
//! An ENABLED app that provides BOTH capabilities and is **Core tier**
//! ([`CapabilityConsumer::core_tier_providers_of`]): participation is first-party
//! only until a reviewed per-app budget exists. Only Core calls these capabilities;
//! the broker refuses every fan-out capability.
//!
//! # Reconcile
//!
//! Every provider is listed and applied independently. A job's identity is its
//! target pair `(plugin_id, job_id)`, and its persisted id is the canonical one:
//! the legacy id an older Core wrote, when that job exists
//! ([`legacy_targets::legacy_canonical_id`]), otherwise `app-<hex32>` of
//! `sha256(plugin_id \0 job_id)` ([`app_job_id`]). It never chooses by age. Every
//! other job with the same target, and every job of that provider whose id is
//! absent from the list, is swept. Agent, workflow, system and legacy quest jobs,
//! and other providers' jobs, are never touched.
//!
//! The sweep runs only on an AUTHORITATIVE list: a 2xx reply within
//! [`APP_JOB_LIST_TIMEOUT`] and [`APP_JOB_LIST_MAX_REPLY`] carrying a `jobs` array of
//! at most [`MAX_APP_JOBS_PER_PROVIDER`] entries. Anything else (a disabled,
//! uninstalled or Community-tier app, a timeout, a non-2xx, a missing array, an
//! oversized list) skips that provider entirely: unknown, never "everything was
//! deleted".
//!
//! # Failure posture
//!
//! The scheduler tick skips an app job whose app is disabled, uninstalled, or no
//! longer a Core-tier provider of `jobs.run`, without recording anything
//! ([`app_job_runners`]). A run that still reaches an app that does not provide
//! `jobs.run` (a run-now or an approval) is a recorded failure. Every hop is
//! bounded by a total timeout, because the ext-proxy client sets only a connect
//! timeout (streaming routes must not be severed).

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};

use super::legacy_targets;
use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};
use crate::sidecar::capability_consumer::{
    CapabilityCallError, CapabilityConsumer, CapabilityReply,
};

/// List one app's scheduled jobs.
pub(crate) const CAP_JOBS_LIST: &str = "jobs.list";
/// Run one app job.
pub(crate) const CAP_JOBS_RUN: &str = "jobs.run";
/// Both halves: an app takes part only when it provides every one.
pub(crate) const APP_JOB_CAPABILITIES: &[&str] = &[CAP_JOBS_LIST, CAP_JOBS_RUN];

/// Total bound on one `jobs.list` hop.
pub(crate) const APP_JOB_LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Total bound on one `jobs.run` hop.
pub(crate) const APP_JOB_RUN_TIMEOUT: Duration = Duration::from_secs(120);
/// Largest `jobs.list` reply body Core reads.
pub(crate) const APP_JOB_LIST_MAX_REPLY: usize = 4 * 1024 * 1024;
/// Largest `jobs.run` reply body Core reads.
pub(crate) const APP_JOB_RUN_MAX_REPLY: usize = 64 * 1024;
/// Most jobs one provider may list; a longer list is not authoritative.
pub(crate) const MAX_APP_JOBS_PER_PROVIDER: usize = 500;
/// Shortest `every` interval an app job may tick on (shorter ones are clamped).
pub(crate) const MIN_APP_JOB_INTERVAL: Duration = Duration::from_secs(60);
const MIN_APP_JOB_INTERVAL_TEXT: &str = "1m";
/// Longest provider error text recorded on a job.
pub(crate) const MAX_PROVIDER_ERROR_BYTES: usize = 1024;
/// Longest `jobs.list` entry id.
const MAX_APP_JOB_ID_BYTES: usize = 256;
/// Longest job name, in characters.
const MAX_APP_JOB_NAME_CHARS: usize = 200;
/// Largest `payload` object, serialized.
pub(crate) const MAX_APP_JOB_PAYLOAD_BYTES: usize = 4 * 1024;
/// How often Core reconciles the app jobs.
const RECONCILE_EVERY: Duration = Duration::from_secs(30);

// ── Shared call plumbing (also used by the legacy quest residue) ─────────────────

/// Why an app-backed call produced no usable reply.
#[derive(Debug)]
pub(crate) struct CallFailure {
    /// The providing app is disabled or not installed (or Core has no consumer
    /// yet). The fail-open case: skip quietly.
    pub(crate) unbound: bool,
    pub(crate) message: String,
}

impl CallFailure {
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self {
            unbound: false,
            message: sanitize_provider_error(&message.into()),
        }
    }

    pub(crate) fn no_consumer(cap: &str) -> Self {
        Self {
            unbound: true,
            message: format!("capability '{cap}': no capability consumer installed"),
        }
    }
}

impl From<CapabilityCallError> for CallFailure {
    fn from(err: CapabilityCallError) -> Self {
        Self {
            unbound: matches!(err, CapabilityCallError::Unbound { .. }),
            message: sanitize_provider_error(&err.to_string()),
        }
    }
}

/// A provider's refusal as job error text: its `error` string when it sent one.
fn reply_error(cap: &str, reply: &CapabilityReply) -> String {
    sanitize_provider_error(
        reply
            .body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{cap} failed: HTTP {}", reply.status))
            .as_str(),
    )
}

/// Call `cap` on its bound provider and require a 2xx reply; a non-2xx reply
/// becomes a failure carrying the provider's (cleaned) `error` text.
pub(crate) async fn call_ok(
    consumer: Option<&CapabilityConsumer>,
    cap: &str,
    body: &Value,
) -> Result<Value, CallFailure> {
    let consumer = consumer.ok_or_else(|| CallFailure::no_consumer(cap))?;
    let reply = consumer.call_capability(cap, body).await?;
    if reply.is_success() {
        return Ok(reply.body);
    }
    Err(CallFailure::failed(reply_error(cap, &reply)))
}

/// Map a tick's failure to the scheduler's outcome: unbound is a no-op.
pub(crate) fn tick_result(cap: &str, result: Result<Value, CallFailure>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(failure) if failure.unbound => {
            tracing::debug!(
                "{cap}: providing app unavailable, tick skipped: {}",
                failure.message
            );
            Ok(())
        }
        Err(failure) => Err(failure.message),
    }
}

/// Bidirectional-text controls that can make a name or an error read as
/// something else (U+200E/F, U+202A–U+202E, U+2066–U+2069).
fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// Provider-supplied text made safe to record and render: line breaks and tabs
/// become spaces, every other control and bidi character is dropped, and the
/// result is cut on a char boundary to [`MAX_PROVIDER_ERROR_BYTES`] plus an
/// ellipsis.
pub(crate) fn sanitize_provider_error(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() || is_bidi_control(c) => None,
            c => Some(c),
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.len() <= MAX_PROVIDER_ERROR_BYTES {
        return cleaned.to_owned();
    }
    let mut cut = MAX_PROVIDER_ERROR_BYTES;
    while !cleaned.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &cleaned[..cut])
}

// ── Ticks ─────────────────────────────────────────────────────────────────────────

/// The apps the scheduler may tick app jobs for right now: every enabled Core-tier
/// provider of `jobs.run`. `None` when the plugin store cannot be read (the tick
/// then falls back to the owner-app gate and fails open); an empty set when Core
/// has no consumer (nothing could run them, so nothing is recorded).
pub(crate) async fn app_job_runners(
    consumer: Option<&CapabilityConsumer>,
) -> Option<HashSet<String>> {
    let Some(consumer) = consumer else {
        return Some(HashSet::new());
    };
    match consumer.core_tier_providers_of(&[CAP_JOBS_RUN]).await {
        Ok(runners) => Some(runners.into_iter().collect()),
        Err(error) => {
            tracing::warn!("scheduler: could not resolve app job runners: {error}");
            None
        }
    }
}

/// The [`JobTarget::AppJob`] tick: run one job through its app's `jobs.run`,
/// bounded by [`APP_JOB_RUN_TIMEOUT`] and [`APP_JOB_RUN_MAX_REPLY`].
pub(crate) async fn run_app_job(
    consumer: Option<&CapabilityConsumer>,
    plugin_id: &str,
    job_id: &str,
    payload: Option<&Value>,
) -> Result<(), String> {
    run_app_job_within(consumer, plugin_id, job_id, payload, APP_JOB_RUN_TIMEOUT).await
}

async fn run_app_job_within(
    consumer: Option<&CapabilityConsumer>,
    plugin_id: &str,
    job_id: &str,
    payload: Option<&Value>,
    timeout: Duration,
) -> Result<(), String> {
    let Some(consumer) = consumer else {
        tracing::debug!("{CAP_JOBS_RUN}: no capability consumer installed; '{job_id}' skipped");
        return Ok(());
    };
    let not_provided = || format!("{plugin_id} does not provide {CAP_JOBS_RUN}");
    match consumer.core_tier_providers_of(&[CAP_JOBS_RUN]).await {
        Ok(runners) if runners.iter().any(|runner| runner == plugin_id) => {}
        Ok(_) => return Err(not_provided()),
        Err(error) => return Err(sanitize_provider_error(&error.to_string())),
    }
    let mut body = json!({ "id": job_id });
    if let Some(payload) = payload {
        body["payload"] = payload.clone();
    }
    let call = consumer.call_provider_capability_limited(
        plugin_id,
        CAP_JOBS_RUN,
        &body,
        APP_JOB_RUN_MAX_REPLY,
    );
    let reply = match tokio::time::timeout(timeout, call).await {
        Err(_) => {
            return Err(format!(
                "{CAP_JOBS_RUN} timed out after {}s",
                timeout.as_secs()
            ))
        }
        Ok(Err(CapabilityCallError::Unbound { .. })) => return Err(not_provided()),
        Ok(Err(error)) => return Err(sanitize_provider_error(&error.to_string())),
        Ok(Ok(reply)) => reply,
    };
    if reply.is_success() {
        Ok(())
    } else {
        Err(reply_error(CAP_JOBS_RUN, &reply))
    }
}

// ── Lists ─────────────────────────────────────────────────────────────────────────

/// One job an app listed, validated and ready to write.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WantedJob {
    pub(crate) job_id: String,
    pub(crate) name: String,
    pub(crate) schedule: Schedule,
    pub(crate) enabled: bool,
    pub(crate) payload: Option<Value>,
}

/// An authoritative `jobs.list` reply. `invalid` holds the ids of entries that
/// failed validation: they are live (never swept) but not written.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct ListedJobs {
    pub(crate) valid: Vec<WantedJob>,
    pub(crate) invalid: Vec<String>,
}

fn valid_entry_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_APP_JOB_ID_BYTES && !id.chars().any(char::is_control)
}

/// Validate one entry whose id is already usable.
fn parse_entry(id: &str, entry: &Value) -> Result<WantedJob, String> {
    let name = match entry.get("name") {
        None | Some(Value::Null) => id,
        Some(Value::String(name)) if name.trim().is_empty() => id,
        Some(Value::String(name)) => name.trim(),
        Some(_) => return Err("`name` is not a string".to_owned()),
    };
    if name.chars().any(|c| c.is_control() || is_bidi_control(c)) {
        return Err("`name` contains control or bidi characters".to_owned());
    }
    let name: String = name.chars().take(MAX_APP_JOB_NAME_CHARS).collect();

    let mut schedule: Schedule = entry
        .get("schedule")
        .cloned()
        .ok_or_else(|| "missing `schedule`".to_owned())
        .and_then(|raw| serde_json::from_value(raw).map_err(|e| format!("`schedule`: {e}")))?;
    super::validate_schedule(&schedule)?;
    if let Schedule::Every { interval } = &mut schedule {
        let below_floor = humantime::parse_duration(interval)
            .is_ok_and(|duration| duration < MIN_APP_JOB_INTERVAL);
        if below_floor {
            MIN_APP_JOB_INTERVAL_TEXT.clone_into(interval);
        }
    }

    let enabled = match entry.get("enabled") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return Err("`enabled` is not a boolean".to_owned()),
    };
    let payload = match entry.get("payload") {
        None | Some(Value::Null) => None,
        Some(object @ Value::Object(_)) => {
            let size = serde_json::to_vec(object).map_or(usize::MAX, |bytes| bytes.len());
            if size > MAX_APP_JOB_PAYLOAD_BYTES {
                return Err(format!(
                    "`payload` exceeds {MAX_APP_JOB_PAYLOAD_BYTES} bytes"
                ));
            }
            Some(object.clone())
        }
        Some(_) => return Err("`payload` is not an object".to_owned()),
    };
    Ok(WantedJob {
        job_id: id.to_owned(),
        name,
        schedule,
        enabled,
        payload,
    })
}

/// Read a `jobs.list` reply body. A body without a `jobs` array, or with more than
/// [`MAX_APP_JOBS_PER_PROVIDER`] entries, is not authoritative. Entries without a
/// usable id are ignored; a duplicate id keeps its first entry.
pub(crate) fn parse_list_reply(body: &Value) -> Result<ListedJobs, CallFailure> {
    let entries = body
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| CallFailure::failed(format!("{CAP_JOBS_LIST} reply has no `jobs` array")))?;
    if entries.len() > MAX_APP_JOBS_PER_PROVIDER {
        return Err(CallFailure::failed(format!(
            "{CAP_JOBS_LIST} listed {} jobs; at most {MAX_APP_JOBS_PER_PROVIDER} are accepted",
            entries.len()
        )));
    }
    let mut listed = ListedJobs::default();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_entry_id(id))
        else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        match parse_entry(id, entry) {
            Ok(wanted) => listed.valid.push(wanted),
            Err(reason) => {
                tracing::debug!(
                    "{CAP_JOBS_LIST}: entry '{}' kept but not written: {reason}",
                    sanitize_provider_error(id)
                );
                listed.invalid.push(id.to_owned());
            }
        }
    }
    Ok(listed)
}

/// Read one provider's job list, bounded by `timeout` and
/// [`APP_JOB_LIST_MAX_REPLY`].
async fn list_app_jobs_within(
    consumer: &CapabilityConsumer,
    plugin_id: &str,
    timeout: Duration,
) -> Result<ListedJobs, CallFailure> {
    let body = json!({});
    let call = consumer.call_provider_capability_limited(
        plugin_id,
        CAP_JOBS_LIST,
        &body,
        APP_JOB_LIST_MAX_REPLY,
    );
    let reply = match tokio::time::timeout(timeout, call).await {
        Err(_) => {
            return Err(CallFailure::failed(format!(
                "{CAP_JOBS_LIST} timed out after {}s",
                timeout.as_secs()
            )))
        }
        Ok(result) => result?,
    };
    if !reply.is_success() {
        return Err(CallFailure::failed(reply_error(CAP_JOBS_LIST, &reply)));
    }
    parse_list_reply(&reply.body)
}

// ── Reconcile ─────────────────────────────────────────────────────────────────────

/// The persisted id of an app job no older Core wrote:
/// `app-<first 32 hex of sha256(plugin_id \0 job_id)>`.
pub(crate) fn app_job_id(plugin_id: &str, job_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(plugin_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(job_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("app-{}", &digest[..32])
}

/// What one provider's reconcile writes and deletes.
#[derive(Debug, Default, Clone)]
pub(crate) struct ReconcilePlan {
    /// Jobs to write (created, or changed since the last pass).
    pub(crate) upserts: Vec<ScheduledJob>,
    /// Job ids to delete.
    pub(crate) sweep: Vec<String>,
}

/// Whether two jobs would behave identically (everything but bookkeeping).
fn same_configuration(current: &ScheduledJob, wanted: &ScheduledJob) -> bool {
    current.name == wanted.name
        && current.schedule == wanted.schedule
        && current.target == wanted.target
        && current.enabled == wanted.enabled
        && current.require_approval == wanted.require_approval
        && current.owner_app == wanted.owner_app
        && current.owner_user_id == wanted.owner_user_id
        && current.org_id == wanted.org_id
}

/// Plan one provider's reconcile from its AUTHORITATIVE list. Pure, so every
/// identity and sweep decision is unit-testable without the job store.
pub(crate) fn plan_reconcile(
    provider: &str,
    listed: &ListedJobs,
    existing: &[ScheduledJob],
    now: &str,
) -> ReconcilePlan {
    let mut groups: BTreeMap<&str, Vec<&ScheduledJob>> = BTreeMap::new();
    for job in existing {
        if let JobTarget::AppJob {
            plugin_id, job_id, ..
        } = &job.target
        {
            if plugin_id == provider {
                groups.entry(job_id.as_str()).or_default().push(job);
            }
        }
    }
    let canonical_id = |job_id: &str| -> String {
        let group = groups.get(job_id).map(Vec::as_slice).unwrap_or(&[]);
        legacy_targets::legacy_canonical_id(provider, job_id)
            .filter(|legacy| group.iter().any(|job| job.id == *legacy))
            .unwrap_or_else(|| app_job_id(provider, job_id))
    };

    let mut plan = ReconcilePlan::default();
    for wanted in &listed.valid {
        let id = canonical_id(&wanted.job_id);
        let current = groups
            .get(wanted.job_id.as_str())
            .and_then(|group| group.iter().find(|job| job.id == id))
            .copied();
        let job = ScheduledJob {
            id,
            name: wanted.name.clone(),
            schedule: wanted.schedule.clone(),
            target: JobTarget::AppJob {
                plugin_id: provider.to_owned(),
                job_id: wanted.job_id.clone(),
                payload: wanted.payload.clone(),
            },
            enabled: wanted.enabled,
            require_approval: false,
            owner_app: Some(provider.to_owned()),
            owner_user_id: None,
            org_id: None,
            created_at: current.map_or_else(|| now.to_owned(), |job| job.created_at.clone()),
            updated_at: now.to_owned(),
            last_run_at: current.and_then(|job| job.last_run_at.clone()),
            last_outcome: current.and_then(|job| job.last_outcome),
            history: current.map(|job| job.history.clone()).unwrap_or_default(),
        };
        if current.is_some_and(|current| same_configuration(current, &job)) {
            continue;
        }
        plan.upserts.push(job);
    }

    let written: HashSet<&str> = listed.valid.iter().map(|w| w.job_id.as_str()).collect();
    let kept: HashSet<&str> = listed.invalid.iter().map(String::as_str).collect();
    for (job_id, group) in &groups {
        if kept.contains(job_id) {
            // Listed but unwritable: live, so its jobs stay exactly as they are.
            continue;
        }
        let keep = written.contains(job_id).then(|| canonical_id(job_id));
        plan.sweep.extend(
            group
                .iter()
                .filter(|job| keep.as_deref() != Some(job.id.as_str()))
                .map(|job| job.id.clone()),
        );
    }
    plan.sweep.sort();
    plan
}

/// What one reconcile pass did for one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileOutcome {
    /// The list was not authoritative (app disabled, unreachable, failing,
    /// oversized): nothing was written or swept.
    Skipped,
    /// The list was authoritative: `written` jobs were written, `swept` removed.
    Reconciled { written: usize, swept: usize },
}

/// Write and delete what `plan` says, through the store's authoritative paths.
fn apply_plan(provider: &str, plan: &ReconcilePlan) -> ReconcileOutcome {
    for job in &plan.upserts {
        if let Err(error) = job_store::recreate_authoritative_job(job) {
            tracing::warn!("app job '{}' of '{provider}' not written: {error}", job.id);
        }
    }
    let mut swept = 0;
    for id in &plan.sweep {
        match job_store::delete_job(id) {
            Ok(true) => swept += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!("app job '{id}' of '{provider}' not swept: {error}"),
        }
    }
    ReconcileOutcome::Reconciled {
        written: plan.upserts.len(),
        swept,
    }
}

async fn reconcile_provider(
    consumer: &CapabilityConsumer,
    provider: &str,
    list_timeout: Duration,
) -> ReconcileOutcome {
    let listed = match list_app_jobs_within(consumer, provider, list_timeout).await {
        Ok(listed) => listed,
        Err(failure) => {
            tracing::debug!(
                "app job reconcile for '{provider}' skipped (list not authoritative): {}",
                failure.message
            );
            return ReconcileOutcome::Skipped;
        }
    };
    let now = chrono::Utc::now().to_rfc3339();
    let plan = plan_reconcile(provider, &listed, &job_store::list_jobs(), &now);
    apply_plan(provider, &plan)
}

/// Reconcile every participating provider's jobs, each independently. Empty when
/// Core has no consumer or the plugin store cannot be read (nothing is touched).
pub(crate) async fn reconcile_app_jobs(
    consumer: Option<&CapabilityConsumer>,
) -> BTreeMap<String, ReconcileOutcome> {
    reconcile_app_jobs_within(consumer, APP_JOB_LIST_TIMEOUT).await
}

async fn reconcile_app_jobs_within(
    consumer: Option<&CapabilityConsumer>,
    list_timeout: Duration,
) -> BTreeMap<String, ReconcileOutcome> {
    let mut outcomes = BTreeMap::new();
    let Some(consumer) = consumer else {
        return outcomes;
    };
    let providers = match consumer.core_tier_providers_of(APP_JOB_CAPABILITIES).await {
        Ok(providers) => providers,
        Err(error) => {
            tracing::debug!("app job reconcile skipped: {error}");
            return outcomes;
        }
    };
    for provider in providers {
        let outcome = reconcile_provider(consumer, &provider, list_timeout).await;
        outcomes.insert(provider, outcome);
    }
    outcomes
}

/// Reconcile every app-backed job family now. Also run after a bulk data purge, so
/// the purged items' jobs are torn down immediately instead of on the next tick.
pub(crate) async fn reconcile_all(consumer: Option<&CapabilityConsumer>) {
    reconcile_app_jobs(consumer).await;
    super::legacy_quest_jobs::reconcile_quest_jobs(consumer).await;
}

/// Spawn the long-lived reconcile loop over the process-global consumer.
/// Best-effort and self-healing across a provider restart or a re-enable.
pub(crate) fn spawn() {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        loop {
            tick.tick().await;
            reconcile_all(crate::sidecar::capability_consumer::global()).await;
        }
    });
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Core-tier fixture providers for the app-job tests (here and in the
    //! scheduler): several providers side by side, each on its own port.

    use std::sync::Arc;

    use crate::plugin_manifest::PluginManifest;
    use crate::plugins::PluginStore;
    use crate::sidecar::capability_consumer::test_support::{
        fixture_manifest_for, reserve_port, try_register_sidecar_for,
    };
    use crate::sidecar::capability_consumer::CapabilityConsumer;
    use crate::sidecar::SidecarManager;

    /// A fixture id `tier_for_manifest` can grant Core tier to (test-only prefix).
    pub(crate) fn core_tier_id(name: &str) -> String {
        format!("@ryu/__test-verified-official-jobs-{name}")
    }

    /// The provenance of a digest-bound verified official install of `manifest`:
    /// installing with it makes the manifest Core tier.
    pub(crate) fn verified_official(
        manifest: &PluginManifest,
    ) -> crate::plugins::isolation::PluginProvenance {
        use crate::plugins::isolation::{
            manifest_sha256, PluginProvenance, OFFICIAL_MARKETPLACE_SOURCE_ID,
        };
        PluginProvenance {
            source_id: Some(OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            signature_verified: true,
            manifest_sha256: Some(manifest_sha256(manifest)),
            ..PluginProvenance::default()
        }
    }

    /// One fixture provider to build.
    pub(crate) struct Provider<'a> {
        pub(crate) id: String,
        pub(crate) provides: &'a [(&'a str, Option<&'a str>)],
        pub(crate) enabled: bool,
        pub(crate) core_tier: bool,
    }

    /// A consumer over `providers`, each installed (and enabled when asked),
    /// registered on its own reserved port. Returns the consumer, its store and
    /// each provider's port, in order.
    pub(crate) async fn consumer_over(
        providers: &[Provider<'_>],
    ) -> (CapabilityConsumer, PluginStore, Vec<u16>) {
        let store = PluginStore::open_in_memory().unwrap();
        let manager = SidecarManager::new_noop();
        let mut manifests = Vec::new();
        let mut ports = Vec::new();
        for provider in providers {
            // A released port can be claimed by a parallel test before the manager
            // registers it; take another one when that happens.
            let mut port = reserve_port();
            let mut attempts = 0;
            while let Err(error) = try_register_sidecar_for(&manager, &provider.id, port).await {
                attempts += 1;
                assert!(
                    attempts < 10,
                    "could not register a fixture sidecar: {error:#}"
                );
                port = reserve_port();
            }
            let manifest = fixture_manifest_for(&provider.id, port, provider.provides);
            // Installing records (or clears) the id's verified digest, so the
            // provenance travels with the insert.
            let provenance = provider.core_tier.then(|| verified_official(&manifest));
            store
                .insert_with_provenance(&provider.id, "1.0.0", provenance.as_ref())
                .await
                .unwrap();
            if provider.enabled {
                store.set_enabled(&provider.id, &[]).await.unwrap();
            }
            manifests.push(manifest);
            ports.push(port);
        }
        let consumer = CapabilityConsumer::new(
            Arc::clone(&manager),
            Arc::new(tokio::sync::RwLock::new(manifests)),
            store.clone(),
        );
        (consumer, store, ports)
    }

    /// Both job capabilities on the fixture's `/jobs/list` and `/jobs/run` routes.
    pub(crate) const JOB_ROUTES: &[(&str, Option<&str>)] = &[
        (super::CAP_JOBS_LIST, Some("/jobs/list")),
        (super::CAP_JOBS_RUN, Some("/jobs/run")),
    ];
}

#[cfg(test)]
mod tests {
    use super::test_support::{consumer_over, core_tier_id, Provider, JOB_ROUTES};
    use super::*;
    use crate::scheduler::store::{ExecOutcome, ExecRecord};
    use crate::sidecar::capability_consumer::test_support::serve;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{Json, Router};

    const PROVIDER: &str = "@example/jobs-a";
    const OTHER: &str = "@example/jobs-b";

    fn job(id: &str, target: JobTarget) -> ScheduledJob {
        ScheduledJob {
            id: id.to_owned(),
            name: id.to_owned(),
            schedule: Schedule::Every {
                interval: "2m".into(),
            },
            target,
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        }
    }

    fn app_target(plugin: &str, id: &str) -> JobTarget {
        JobTarget::AppJob {
            plugin_id: plugin.to_owned(),
            job_id: id.to_owned(),
            payload: None,
        }
    }

    fn app_job(plugin: &str, id: &str) -> ScheduledJob {
        job(&app_job_id(plugin, id), app_target(plugin, id))
    }

    fn wanted(id: &str) -> WantedJob {
        WantedJob {
            job_id: id.to_owned(),
            name: format!("job {id}"),
            schedule: Schedule::Every {
                interval: "5m".into(),
            },
            enabled: true,
            payload: None,
        }
    }

    fn listed(valid: &[&str], invalid: &[&str]) -> ListedJobs {
        ListedJobs {
            valid: valid.iter().map(|id| wanted(id)).collect(),
            invalid: invalid.iter().map(|id| (*id).to_owned()).collect(),
        }
    }

    // ── Planner ─────────────────────────────────────────────────────────────

    /// Deleting an app's LAST job is a reachable-but-empty list: its jobs go, and
    /// nothing else does (another app's jobs, quest, agent and system jobs).
    #[test]
    fn an_authoritative_empty_list_sweeps_only_this_providers_app_jobs() {
        let jobs = vec![
            app_job(PROVIDER, "a1"),
            app_job(OTHER, "b1"),
            job(
                "quest-q1",
                JobTarget::Quest {
                    quest_id: "q1".into(),
                },
            ),
            job("identity-health", JobTarget::IdentityHealth),
            job(
                "agent",
                JobTarget::Agent {
                    agent_id: "a".into(),
                    prompt: "p".into(),
                    model: None,
                    conversation_id: None,
                },
            ),
        ];
        let plan = plan_reconcile(PROVIDER, &ListedJobs::default(), &jobs, "now");
        assert!(plan.upserts.is_empty());
        assert_eq!(plan.sweep, vec![app_job_id(PROVIDER, "a1")]);
    }

    #[test]
    fn a_partial_list_sweeps_only_the_missing_ids() {
        let jobs = vec![app_job(PROVIDER, "a1"), app_job(PROVIDER, "a2")];
        let plan = plan_reconcile(PROVIDER, &listed(&["a1"], &[]), &jobs, "now");
        assert_eq!(plan.sweep, vec![app_job_id(PROVIDER, "a2")]);
    }

    /// A new job is written at `app-<hex32>`, a valid persisted job id; an
    /// unchanged one is not rewritten; a changed one keeps its bookkeeping.
    #[test]
    fn new_jobs_get_a_hashed_id_and_changes_carry_history_forward() {
        let plan = plan_reconcile(PROVIDER, &listed(&["a1"], &[]), &[], "now");
        assert_eq!(plan.upserts.len(), 1);
        let created = &plan.upserts[0];
        assert_eq!(created.id, app_job_id(PROVIDER, "a1"));
        assert!(job_store::is_valid_job_id(&created.id), "{}", created.id);
        assert_eq!(created.id.len(), "app-".len() + 32);
        assert_eq!(created.owner_app.as_deref(), Some(PROVIDER));
        assert!(!created.require_approval);
        assert_ne!(app_job_id(PROVIDER, "a1"), app_job_id(OTHER, "a1"));

        let mut existing = created.clone();
        existing.created_at = "2026-01-01".into();
        existing.record_execution(ExecRecord {
            started_at: "s".into(),
            finished_at: "f".into(),
            outcome: ExecOutcome::Failure,
            run_id: None,
            error: Some("boom".into()),
        });
        let plan = plan_reconcile(
            PROVIDER,
            &listed(&["a1"], &[]),
            &[existing.clone()],
            "later",
        );
        assert!(plan.upserts.is_empty() && plan.sweep.is_empty(), "{plan:?}");

        let mut renamed = listed(&["a1"], &[]);
        renamed.valid[0].enabled = false;
        let plan = plan_reconcile(PROVIDER, &renamed, &[existing], "later");
        let updated = &plan.upserts[0];
        assert!(!updated.enabled);
        assert_eq!(updated.created_at, "2026-01-01");
        assert_eq!(updated.history.len(), 1);
        assert_eq!(updated.last_outcome, Some(ExecOutcome::Failure));
    }

    /// Duplicates of one target keep the canonical id and sweep the rest; an
    /// invalid-but-listed entry keeps every job it has untouched.
    #[test]
    fn duplicates_are_swept_and_invalid_entries_stay_live() {
        let mut stray = job("job_1", app_target(PROVIDER, "a1"));
        stray.created_at = "2020-01-01".into();
        let jobs = vec![stray, app_job(PROVIDER, "a1"), app_job(PROVIDER, "bad")];
        let plan = plan_reconcile(PROVIDER, &listed(&["a1"], &["bad"]), &jobs, "now");
        assert_eq!(plan.sweep, vec!["job_1".to_owned()]);
        assert!(plan
            .upserts
            .iter()
            .all(|j| j.id == app_job_id(PROVIDER, "a1")));
    }

    // ── Entry validation ────────────────────────────────────────────────────

    #[test]
    fn invalid_entries_are_live_but_not_written_and_short_intervals_are_clamped() {
        let big = "x".repeat(MAX_APP_JOB_PAYLOAD_BYTES);
        let body = json!({ "jobs": [
            { "id": "ok", "name": "  Fine  ", "schedule": { "kind": "every", "interval": "10s" } },
            { "id": "cron", "schedule": { "kind": "cron", "expr": "0 9 * * *" }, "enabled": false,
              "payload": { "k": 1 } },
            { "id": "bad-schedule", "name": "x", "schedule": { "kind": "every", "interval": "soon" } },
            { "id": "no-schedule", "name": "x" },
            { "id": "big-payload", "schedule": { "kind": "every", "interval": "5m" },
              "payload": { "blob": big } },
            { "id": "list-payload", "schedule": { "kind": "every", "interval": "5m" },
              "payload": [1] },
            { "id": "bidi", "name": "evil\u{202E}txt.exe", "schedule": { "kind": "every", "interval": "5m" } },
            { "id": "ctrl", "name": "a\u{7}b", "schedule": { "kind": "every", "interval": "5m" } },
            { "id": "ok", "name": "duplicate", "schedule": { "kind": "every", "interval": "5m" } },
            { "id": "", "schedule": { "kind": "every", "interval": "5m" } },
            { "name": "no id", "schedule": { "kind": "every", "interval": "5m" } },
        ] });
        let listed = parse_list_reply(&body).unwrap();
        let ids: Vec<&str> = listed.valid.iter().map(|w| w.job_id.as_str()).collect();
        assert_eq!(ids, vec!["ok", "cron"]);
        assert_eq!(listed.valid[0].name, "Fine");
        assert_eq!(
            listed.valid[0].schedule,
            Schedule::Every {
                interval: "1m".into()
            }
        );
        assert_eq!(
            listed.valid[1].name, "cron",
            "a missing name falls back to the id"
        );
        assert!(!listed.valid[1].enabled);
        assert_eq!(listed.valid[1].payload, Some(json!({ "k": 1 })));
        assert_eq!(
            listed.invalid,
            vec![
                "bad-schedule",
                "no-schedule",
                "big-payload",
                "list-payload",
                "bidi",
                "ctrl"
            ]
        );

        // Invalid entries are live: their existing jobs are not swept.
        let jobs = vec![app_job(PROVIDER, "bidi")];
        assert!(plan_reconcile(PROVIDER, &listed, &jobs, "now")
            .sweep
            .is_empty());
    }

    #[test]
    fn long_names_are_cut_and_oversized_or_unlisted_replies_are_not_authoritative() {
        let long = "n".repeat(MAX_APP_JOB_NAME_CHARS + 50);
        let listed = parse_list_reply(&json!({ "jobs": [
            { "id": "a", "name": long, "schedule": { "kind": "every", "interval": "1h" } }
        ] }))
        .unwrap();
        assert_eq!(listed.valid[0].name.chars().count(), MAX_APP_JOB_NAME_CHARS);

        let entry = json!({ "id": "x", "schedule": { "kind": "every", "interval": "5m" } });
        let too_many = json!({ "jobs": vec![entry; MAX_APP_JOBS_PER_PROVIDER + 1] });
        assert!(parse_list_reply(&too_many).is_err());
        assert!(parse_list_reply(&json!({ "error": "locked" })).is_err());
        assert!(parse_list_reply(&json!({ "jobs": {} })).is_err());
        assert!(parse_list_reply(&Value::Null).is_err());
    }

    /// The entries an app sidecar lists reconcile to the same names, schedules and
    /// enabled state the retired per-app backing jobs had (intervals of 1m or more).
    #[test]
    fn sidecar_entries_reconcile_like_the_retired_backing_jobs() {
        let listed = parse_list_reply(&json!({ "jobs": [
            { "id": "m1", "name": "monitor: Site",
              "schedule": { "kind": "every", "interval": "1h" }, "enabled": true },
            { "id": "m2", "name": "monitor: Cron",
              "schedule": { "kind": "cron", "expr": "0 9 * * *" }, "enabled": false },
            { "id": "m3", "name": "monitor: Default",
              "schedule": { "kind": "every", "interval": "5m" } },
        ] }))
        .unwrap();
        assert!(listed.invalid.is_empty());
        let plan = plan_reconcile(PROVIDER, &listed, &[], "now");
        let by_name: Vec<(&str, &Schedule, bool)> = plan
            .upserts
            .iter()
            .map(|j| (j.name.as_str(), &j.schedule, j.enabled))
            .collect();
        assert_eq!(
            by_name,
            vec![
                (
                    "monitor: Site",
                    &Schedule::Every {
                        interval: "1h".into()
                    },
                    true
                ),
                (
                    "monitor: Cron",
                    &Schedule::Cron {
                        expr: "0 9 * * *".into(),
                        tz: None
                    },
                    false
                ),
                (
                    "monitor: Default",
                    &Schedule::Every {
                        interval: "5m".into()
                    },
                    true
                ),
            ]
        );
    }

    #[test]
    fn provider_error_is_sanitized_and_truncated() {
        let noisy = format!("bad\u{0}\u{1b}[31m\u{202E}{}\nend", "é".repeat(1024 * 1024));
        let clean = sanitize_provider_error(&noisy);
        assert!(clean.len() <= MAX_PROVIDER_ERROR_BYTES + '…'.len_utf8());
        assert!(clean.ends_with('…'));
        assert!(!clean.chars().any(|c| c.is_control() || is_bidi_control(c)));
        assert!(clean.starts_with("bad[31m"));
        assert_eq!(sanitize_provider_error("line\nbreak"), "line break");
    }

    // ── Fan-out against fixture providers ───────────────────────────────────

    /// Each provider is listed and applied on its own: a failing, unlisted or slow
    /// provider skips only itself.
    #[tokio::test]
    async fn a_failing_provider_skips_only_itself() {
        let ok = core_tier_id("fanout-ok");
        let failing = core_tier_id("fanout-500");
        let unlisted = core_tier_id("fanout-nolist");
        let slow = core_tier_id("fanout-slow");
        let ids = [&ok, &failing, &unlisted, &slow];
        let (consumer, _store, ports) = consumer_over(&ids.map(|id| Provider {
            id: id.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }))
        .await;
        let list = |reply: Value, status: StatusCode| {
            Router::new().route(
                "/api/fixture/jobs/list",
                post(move || {
                    let reply = reply.clone();
                    async move { (status, Json(reply)) }
                }),
            )
        };
        let servers = vec![
            serve(
                ports[0],
                list(
                    json!({ "jobs": [{ "id": "j1", "schedule": { "kind": "every", "interval": "5m" } }] }),
                    StatusCode::OK,
                ),
            )
            .await,
            serve(ports[1], list(json!({ "error": "store locked" }), StatusCode::INTERNAL_SERVER_ERROR)).await,
            serve(ports[2], list(json!({ "items": [] }), StatusCode::OK)).await,
            serve(
                ports[3],
                Router::new().route(
                    "/api/fixture/jobs/list",
                    post(|| async {
                        std::future::pending::<()>().await;
                        Json(json!({ "jobs": [] }))
                    }),
                ),
            )
            .await,
        ];
        let directory = tempfile::tempdir().unwrap();
        job_store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            // Jobs the failing providers already own must survive.
            for id in [&failing, &unlisted, &slow] {
                job_store::recreate_authoritative_job(&app_job(id, "old")).unwrap();
            }
            let outcomes =
                reconcile_app_jobs_within(Some(&consumer), Duration::from_millis(500)).await;
            assert_eq!(
                outcomes.get(&ok),
                Some(&ReconcileOutcome::Reconciled {
                    written: 1,
                    swept: 0
                })
            );
            for id in [&failing, &unlisted, &slow] {
                assert_eq!(outcomes.get(id), Some(&ReconcileOutcome::Skipped), "{id}");
            }
            let jobs = job_store::list_jobs();
            assert_eq!(jobs.len(), 4, "{jobs:?}");
            assert!(jobs.iter().any(|j| j.id == app_job_id(&ok, "j1")));
        })
        .await;
        for server in servers {
            server.abort();
        }
    }

    /// Disabled, list-only and Community-tier providers are never reconciled, and
    /// no consumer means nothing is touched.
    #[tokio::test]
    async fn only_enabled_core_tier_providers_of_both_capabilities_take_part() {
        let disabled = core_tier_id("part-disabled");
        let list_only = core_tier_id("part-listonly");
        let community = "@example/jobs-community".to_owned();
        let (consumer, _store, _ports) = consumer_over(&[
            Provider {
                id: disabled.clone(),
                provides: JOB_ROUTES,
                enabled: false,
                core_tier: true,
            },
            Provider {
                id: list_only.clone(),
                provides: &[(CAP_JOBS_LIST, Some("/jobs/list"))],
                enabled: true,
                core_tier: true,
            },
            Provider {
                id: community.clone(),
                provides: JOB_ROUTES,
                enabled: true,
                core_tier: false,
            },
        ])
        .await;
        assert!(consumer
            .core_tier_providers_of(APP_JOB_CAPABILITIES)
            .await
            .unwrap()
            .is_empty());
        assert!(reconcile_app_jobs(Some(&consumer)).await.is_empty());
        assert!(reconcile_app_jobs(None).await.is_empty());
        assert_eq!(app_job_runners(None).await, Some(HashSet::new()));
        assert_eq!(app_job_runners(Some(&consumer)).await, Some(HashSet::new()));
        // No consumer: a quiet Ok (headless).
        assert_eq!(run_app_job(None, &disabled, "j", None).await, Ok(()));
        for id in [&disabled, &list_only, &community] {
            let err = run_app_job(Some(&consumer), id, "j", None)
                .await
                .unwrap_err();
            assert_eq!(err, format!("{id} does not provide jobs.run"));
        }
    }

    /// `jobs.run` reaches the provider as `{ id, payload }`; a refusal is the job's
    /// cleaned error, an oversized reply fails, and a hang times out.
    #[tokio::test]
    async fn runs_speak_the_contract_and_are_bounded() {
        let id = core_tier_id("run-contract");
        let (consumer, _store, ports) = consumer_over(&[Provider {
            id: id.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }])
        .await;
        let app = Router::new().route(
            "/api/fixture/jobs/run",
            post(|Json(body): Json<Value>| async move {
                match body["id"].as_str() {
                    Some("ok") if body["payload"] == json!({ "k": "v" }) => {
                        (StatusCode::OK, Json(json!({ "status": "ok" })))
                    }
                    Some("refused") => (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": "no such\njob\u{202E}" })),
                    ),
                    Some("huge") => (
                        StatusCode::OK,
                        Json(json!({ "blob": "x".repeat(APP_JOB_RUN_MAX_REPLY) })),
                    ),
                    Some("hang") => {
                        std::future::pending::<()>().await;
                        (StatusCode::OK, Json(json!({})))
                    }
                    _ => (StatusCode::BAD_REQUEST, Json(json!({ "body": body }))),
                }
            }),
        );
        let server = serve(ports[0], app).await;
        let payload = json!({ "k": "v" });
        assert_eq!(
            run_app_job(Some(&consumer), &id, "ok", Some(&payload)).await,
            Ok(())
        );
        assert_eq!(
            run_app_job(Some(&consumer), &id, "refused", None).await,
            Err("no such job".to_owned())
        );
        let err = run_app_job(Some(&consumer), &id, "huge", None)
            .await
            .unwrap_err();
        assert!(err.contains("jobs.run"), "{err}");
        let err = run_app_job_within(
            Some(&consumer),
            &id,
            "hang",
            None,
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("jobs.run timed out after"), "{err}");
        server.abort();
    }

    /// A list reply over the read bound is not authoritative.
    #[tokio::test]
    async fn an_oversized_list_reply_is_skipped() {
        let id = core_tier_id("list-huge");
        let (consumer, _store, ports) = consumer_over(&[Provider {
            id: id.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }])
        .await;
        let app = Router::new().route(
            "/api/fixture/jobs/list",
            post(|| async {
                Json(json!({ "jobs": [], "pad": "x".repeat(APP_JOB_LIST_MAX_REPLY) }))
            }),
        );
        let server = serve(ports[0], app).await;
        let directory = tempfile::tempdir().unwrap();
        job_store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            job_store::recreate_authoritative_job(&app_job(&id, "kept")).unwrap();
            let outcomes = reconcile_app_jobs(Some(&consumer)).await;
            assert_eq!(outcomes.get(&id), Some(&ReconcileOutcome::Skipped));
            assert_eq!(job_store::list_jobs().len(), 1);
        })
        .await;
        server.abort();
    }
}
