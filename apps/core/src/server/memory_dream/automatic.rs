//! Dream settings and the opt-in automatic review scheduler.

use axum::http::StatusCode;
use chrono::Timelike;
use serde_json::{json, Value};

use super::candidates::run_dream_review_inner;
use super::{
    DREAM_AUTOMATIC_INTERVAL, DREAM_AUTOMATIC_PREF, DREAM_QUIET_END_PREF, DREAM_QUIET_START_PREF,
};
use crate::server::ServerState;

/// Start the opt-in Dream review loop. The loop re-reads preferences on every
/// tick so changing automatic mode or quiet hours takes effect without a Core
/// restart. It deliberately skips org-bound nodes because an unattended tick
/// has no verified user identity with which to select a private memory scope.
pub(crate) fn spawn_automatic_review(state: ServerState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(DREAM_AUTOMATIC_INTERVAL);
        // Do not spend a model call during startup; the first review is due on
        // the next normal scheduler interval.
        interval.tick().await;
        loop {
            interval.tick().await;
            run_automatic_review_tick(&state).await;
        }
    });
}

async fn run_automatic_review_tick(state: &ServerState) {
    if crate::sidecar::control_plane::registered_org().is_some() {
        tracing::debug!("Dream automatic review skipped on an org-bound node without a caller");
        return;
    }
    let settings = match read_settings(state).await {
        Ok(settings) => settings,
        Err(error) => {
            tracing::warn!("Dream automatic review could not read settings: {error:#}");
            return;
        }
    };
    if !settings["automatic"].as_bool().unwrap_or(false) {
        return;
    }
    let hour = chrono::Local::now().hour() as u8;
    let quiet_start = settings["quiet_hours_start"].as_u64().unwrap_or(22) as u8;
    let quiet_end = settings["quiet_hours_end"].as_u64().unwrap_or(8) as u8;
    if is_quiet_hour(hour, quiet_start, quiet_end) {
        tracing::debug!(
            hour,
            quiet_start,
            quiet_end,
            "Dream automatic review is in quiet hours"
        );
        return;
    }
    if crate::server::memory_reflect::reflect_quiet_hours_active(state, hour).await {
        tracing::debug!(hour, "Dream automatic review is in Reflect quiet hours");
        return;
    }
    match run_dream_review_inner(state, &None, "automatic").await {
        Ok(body) => {
            let proposal_count = body["review"]["proposals"].as_array().map_or(0, Vec::len);
            tracing::info!(proposal_count, "Dream automatic review completed");
        }
        Err((status, message)) if status == StatusCode::CONFLICT => {
            tracing::debug!(%message, "Dream automatic review is not ready");
        }
        Err((status, message)) => {
            tracing::warn!(%status, %message, "Dream automatic review failed");
        }
    }
}

pub(super) async fn read_settings(state: &ServerState) -> anyhow::Result<Value> {
    let automatic = state
        .preferences
        .get(DREAM_AUTOMATIC_PREF)
        .await?
        .as_deref()
        .map(parse_bool)
        .unwrap_or(false);
    let quiet_hours_start = state
        .preferences
        .get(DREAM_QUIET_START_PREF)
        .await?
        .as_deref()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|hour| *hour <= 23)
        .unwrap_or(22);
    let quiet_hours_end = state
        .preferences
        .get(DREAM_QUIET_END_PREF)
        .await?
        .as_deref()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|hour| *hour <= 23)
        .unwrap_or(8);
    Ok(json!({
        "automatic": automatic,
        "quiet_hours_start": quiet_hours_start,
        "quiet_hours_end": quiet_hours_end,
    }))
}

pub(super) fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    )
}

pub(in crate::server) fn is_quiet_hour(hour: u8, start: u8, end: u8) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        (start..end).contains(&hour)
    } else {
        hour >= start || hour < end
    }
}
