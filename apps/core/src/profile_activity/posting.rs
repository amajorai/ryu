//! The POST body, the local Gateway usage read and the background poster.

use super::*;
use crate::server::sync::backend::{account_api_base, BackendError};

/// The POST body: always `source`; `deviceId` and `usage` only together.
pub(super) fn activity_body(
    device_id: Option<&str>,
    usage: Option<&UsageSnapshot>,
) -> serde_json::Value {
    match (device_id, usage) {
        (Some(device_id), Some(usage)) => serde_json::json!({
            "source": "core",
            "deviceId": device_id,
            "usage": usage,
        }),
        _ => serde_json::json!({ "source": "core" }),
    }
}

pub(super) fn valid_device_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// This install's usage device id, created on first use. `None` when it cannot
/// be persisted: a fresh id after every restart would count a day twice.
pub(super) fn load_or_create_device_id() -> Option<String> {
    let path = crate::paths::state_path(DEVICE_ID_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if valid_device_id(existing) {
            return Some(existing.to_owned());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, &id));
    match written {
        Ok(()) => Some(id),
        Err(error) => {
            tracing::debug!("profile-activity: could not persist the device id: {error}");
            None
        }
    }
}

/// Whether a Gateway config enables control-plane reporting. An unreadable or
/// unparsable config counts as reporting, so usage is never double counted.
pub(crate) fn gateway_config_reports_usage(config: Option<&str>) -> bool {
    let Some(config) = config else {
        return false;
    };
    let Ok(config) = toml::from_str::<toml::Value>(config) else {
        return true;
    };
    config
        .get("control_plane")
        .and_then(|control_plane| control_plane.get("enabled"))
        .and_then(toml::Value::as_bool)
        .unwrap_or(false)
}

/// Whether Core's Gateway is the local sidecar whose usage reaches the control
/// plane only through this snapshot: Core spawned it (no remote data plane, no
/// managed node, no operator Gateway) and neither its env nor its config turns
/// on the control-plane reporter. Blocking: reads the Gateway config file.
pub(super) fn local_gateway_is_non_reporting() -> bool {
    if !crate::sidecar::gateway::core_spawned_local_gateway() {
        return false;
    }
    if std::env::var(CONTROL_PLANE_KEY_ENV).is_ok_and(|key| !key.trim().is_empty()) {
        return false;
    }
    // The same path the Gateway loads: `GATEWAY_CONFIG`, else the profile's
    // default `gateway.toml`.
    let config = match crate::server::gateway_config_path() {
        None => None,
        Some(path) => match std::fs::read_to_string(path) {
            Ok(config) => Some(config),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return false,
        },
    };
    !gateway_config_reports_usage(config.as_deref())
}

/// Read one UTC day's rollup, from `from` to the day's end, from the local
/// Gateway with its admin credential.
pub(super) async fn fetch_usage_events(
    client: &reqwest::Client,
    day: NaiveDate,
    from: DateTime<Utc>,
) -> Option<Vec<GatewayUsageEvent>> {
    let end = day.and_hms_opt(0, 0, 0)?.and_utc() + chrono::Duration::days(1);
    if from >= end {
        return Some(Vec::new());
    }
    let key = tokio::task::spawn_blocking(crate::sidecar::gateway::gateway_admin_key)
        .await
        .ok()
        .flatten()?;
    let base = crate::sidecar::gateway::gateway_url();
    let url = format!(
        "{}/v1/audit/usage?from={}&until={}",
        base.trim_end_matches('/'),
        from.format("%Y-%m-%dT%H:%M:%SZ"),
        end.format("%Y-%m-%dT%H:%M:%SZ"),
    );
    let response = match client.get(&url).bearer_auth(key).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::debug!(
                "profile-activity: Gateway usage read returned {}",
                response.status()
            );
            return None;
        }
        Err(error) => {
            tracing::debug!("profile-activity: Gateway usage read failed: {error}");
            return None;
        }
    };
    match response.json::<GatewayUsageRollup>().await {
        Ok(rollup) => Some(rollup.events),
        Err(error) => {
            tracing::debug!("profile-activity: Gateway usage rollup unreadable: {error}");
            None
        }
    }
}

// ── Posting ─────────────────────────────────────────────────────────────────────

pub(super) fn load_posted() -> Option<ActivityMarker> {
    let bytes = std::fs::read(crate::paths::state_path(STATE_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn save_posted(marker: &ActivityMarker) {
    let path = crate::paths::state_path(STATE_FILE);
    let result = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let bytes = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
            std::fs::write(&path, bytes)
        });
    if let Err(error) = result {
        tracing::debug!("profile-activity: could not persist the last post: {error}");
    }
}

pub(super) enum PostOutcome {
    Recorded,
    /// The control plane refused this token (401/403); wait for a new token.
    Refused,
    /// The control plane rejected the body (a 4xx other than auth, timeout, or
    /// rate limit); resending the same body cannot succeed.
    Rejected,
    /// Network error or a retryable status; back off and try again.
    Retry,
    /// No usable account backend is known; nothing was sent.
    NoBackend(BackendError),
}

/// Post one body as the signed-in account. This is the only place the account
/// bearer leaves this module. `base` is the resolved account backend
/// ([`account_api_base`]); without one no request is made.
pub(super) async fn post_activity(
    client: &reqwest::Client,
    base: Result<String, BackendError>,
    token: &str,
    body: &serde_json::Value,
) -> PostOutcome {
    let base = match base {
        Ok(base) => base,
        Err(error) => return PostOutcome::NoBackend(error),
    };
    let endpoint = activity_endpoint(&base);
    match client
        .post(&endpoint)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => PostOutcome::Recorded,
        Ok(response)
            if matches!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
            ) =>
        {
            tracing::debug!(
                "profile-activity: control plane refused the signed-in token ({})",
                response.status()
            );
            PostOutcome::Refused
        }
        Ok(response)
            if response.status().is_client_error()
                && !matches!(
                    response.status(),
                    reqwest::StatusCode::REQUEST_TIMEOUT | reqwest::StatusCode::TOO_MANY_REQUESTS
                ) =>
        {
            tracing::debug!(
                "profile-activity: control plane rejected the activity POST ({})",
                response.status()
            );
            PostOutcome::Rejected
        }
        Ok(response) => {
            tracing::debug!(
                "profile-activity: activity POST returned {} (will retry)",
                response.status()
            );
            PostOutcome::Retry
        }
        Err(error) => {
            tracing::debug!("profile-activity: activity POST failed (will retry): {error}");
            PostOutcome::Retry
        }
    }
}

/// Log a missing or refused account backend once, until a post can be made again.
pub(super) fn note_no_backend(warned: &mut bool, error: &BackendError) {
    if !std::mem::replace(warned, true) {
        tracing::warn!("profile activity ping is paused, nothing is sent: {error}");
    }
}

/// Read the usage snapshot `plan` names, if it has news for this account.
pub(super) async fn pending_usage(
    client: &reqwest::Client,
    plan: UsagePlan,
    today: NaiveDate,
    account: &str,
    user_id: Option<&str>,
    watch: &AccountWatch,
    usage: &mut UsageState,
) -> Option<UsageSnapshot> {
    let day = match plan {
        UsagePlan::Skip => return None,
        UsagePlan::Today => {
            usage.last_check = Some(Instant::now());
            today
        }
        UsagePlan::YesterdayFinal => today.pred_opt()?,
    };
    let from = watch.usage_window_start(day)?;
    let events = fetch_usage_events(client, day, from).await?;
    // Carry the day's conversations before the count leaves the device, so a
    // restart never sends a smaller session count than one already accepted.
    persist_usage_carry(watch).await;
    let snapshot = aggregate_usage(day, &events, user_id, sessions_on(day, user_id));
    if snapshot_changed(&usage.sent, account, &snapshot) {
        return Some(snapshot);
    }
    if plan == UsagePlan::YesterdayFinal {
        usage.settle(account, day, today);
    }
    None
}

/// Spawn the background poster. Returns immediately; never panics or blocks.
pub fn spawn_profile_activity(prefs: crate::server::preferences::PreferencesStore) {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        let mut posted = tokio::task::spawn_blocking(load_posted)
            .await
            .ok()
            .flatten();
        let mut refused: Option<ActivityMarker> = None;
        let mut watch = AccountWatch::default();
        let mut carried_sessions = None;
        if let Some(carry) = tokio::task::spawn_blocking(load_usage_carry)
            .await
            .ok()
            .flatten()
        {
            watch.carried = carry.since.map(|since| (carry.account, since));
            carried_sessions = Some(carry.sessions);
        }
        let mut usage = UsageState::default();
        let mut device_id: Option<String> = None;
        let mut backend_warned = false;
        let mut first = true;

        loop {
            if !std::mem::take(&mut first) {
                // A turn wakes the task at once; the timeout re-checks for a later
                // sign-in or account switch on a day that already had activity,
                // and for a changed usage snapshot.
                let _ = tokio::time::timeout(RECHECK_INTERVAL, wake().notified()).await;
            }

            let mut backoff = INITIAL_BACKOFF;
            loop {
                // Isolated offline fixtures never reach the control plane.
                let enabled = !crate::offline_test_bootstrap::is_active()
                    && crate::privacy::profile_activity_enabled(&prefs).await;
                // The account is always resolved (even when disabled) so the
                // baseline and the usage stability window follow every switch.
                let signed_in = tokio::task::spawn_blocking(signed_in)
                    .await
                    .ok()
                    .flatten()
                    .filter(|(token, _)| !token.trim().is_empty());
                let (token, user_id) = signed_in.unzip();
                let user_id = user_id.flatten();
                let account = user_id.as_deref().or(token.as_deref()).map(account_key);
                let (active_day, counter, last_unattributed_turn, authored_turn_today) =
                    snapshot(user_id.as_deref());
                let now = Utc::now();
                let since_before = watch.since;
                let baseline = watch.observe(account.as_deref(), counter, now);
                if let Some(carried) = carried_sessions.take() {
                    if watch.resumed {
                        restore_sessions(carried);
                    }
                }
                if watch.since != since_before {
                    persist_usage_carry(&watch).await;
                }
                let today = now.date_naive();
                let post = should_post(PostInputs {
                    enabled,
                    account: account.as_deref(),
                    active_day,
                    last_unattributed_turn,
                    baseline,
                    authored_turn_today,
                    today,
                    posted: posted.as_ref(),
                    refused: refused.as_ref(),
                });
                let (Some(token), Some(account)) = (token, account) else {
                    break;
                };
                let posted_today = posted
                    .as_ref()
                    .is_some_and(|marker| marker.day == today && marker.account == account);
                let refused_today = refused
                    .as_ref()
                    .is_some_and(|marker| marker.day == today && marker.account == account);

                let mut plan = UsagePlan::Skip;
                if enabled && !refused_today && (post || posted_today) {
                    let local_gateway = tokio::task::spawn_blocking(local_gateway_is_non_reporting)
                        .await
                        .unwrap_or(false);
                    plan = plan_usage(UsagePlanInputs {
                        local_gateway,
                        today_qualifies: post || posted_today,
                        account: &account,
                        today,
                        eligible_today: watch.usage_eligible(today),
                        eligible_yesterday: today
                            .pred_opt()
                            .is_some_and(|yesterday| watch.usage_eligible(yesterday)),
                        today_check_due: usage_check_due(usage.last_check, Instant::now()),
                        sent: &usage.sent,
                        settled: &usage.settled,
                    });
                    if plan != UsagePlan::Skip && device_id.is_none() {
                        device_id = tokio::task::spawn_blocking(load_or_create_device_id)
                            .await
                            .ok()
                            .flatten();
                    }
                    if device_id.is_none() {
                        plan = UsagePlan::Skip;
                    }
                }
                let snapshot = pending_usage(
                    &client,
                    plan,
                    today,
                    &account,
                    user_id.as_deref(),
                    &watch,
                    &mut usage,
                )
                .await;
                if !post && snapshot.is_none() {
                    break;
                }

                let body = activity_body(device_id.as_deref(), snapshot.as_ref());
                let marker = ActivityMarker {
                    day: today,
                    account: account.clone(),
                };
                let base = tokio::task::spawn_blocking(account_api_base)
                    .await
                    .unwrap_or(Err(BackendError::NoBackend));
                if base.is_ok() {
                    backend_warned = false;
                }
                match post_activity(&client, base, &token, &body).await {
                    // The account's sign-in backend is unknown or not https:
                    // wait for the next sign-in, a new setting, or a new turn.
                    PostOutcome::NoBackend(error) => {
                        note_no_backend(&mut backend_warned, &error);
                        break;
                    }
                    PostOutcome::Recorded => {
                        if !posted_today {
                            let saved = marker.clone();
                            let _ = tokio::task::spawn_blocking(move || save_posted(&saved)).await;
                            posted = Some(marker);
                        }
                        if let Some(snapshot) = snapshot {
                            usage.accepted(&account, snapshot, today);
                        }
                        // Re-evaluate at once: yesterday's final snapshot may
                        // leave today's to send. Each plan advances its own
                        // cadence, so this settles in a round or two.
                    }
                    PostOutcome::Refused => {
                        refused = Some(marker);
                        break;
                    }
                    // A rejected snapshot (an older control plane's body
                    // limit, a key it refuses) is never resent for that day;
                    // the next round posts the ping without it.
                    PostOutcome::Rejected if snapshot.is_some() => {
                        if let Some(snapshot) = snapshot {
                            usage.settle(&account, snapshot.day, today);
                        }
                    }
                    PostOutcome::Rejected | PostOutcome::Retry => {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                }
            }
        }
    });
}
