//! The dashboard refresh loop.
//!
//! A single background task ticks every few seconds, walks every widget, and
//! re-resolves the ones whose interval is due, caching + broadcasting the result.
//! This is intentionally a *dashboard-owned* loop, not a `JobTarget` on the
//! minute-granular scheduler — dashboards want second-to-minute cadence.
//!
//! Cost discipline (the money guard): expensive sources (agent / Composio /
//! workflow / arbitrary HTTP) are skipped entirely when no SSE client is watching
//! the dashboard, and every interval is clamped up to the source's per-kind floor
//! (see [`super::WidgetSource::min_interval_secs`]). Cheap internal reads tick
//! freely; the sources that cost tokens/quota do not run against an empty room.

use std::time::Duration;

use super::{sources, DashboardEngine};

/// How often the loop wakes to look for due widgets. The actual per-widget cadence
/// is governed by each widget's effective interval; this is just the resolution.
const TICK_SECS: u64 = 5;

/// Spawn the refresh loop for the given engine. Call once at startup.
pub fn spawn(engine: DashboardEngine) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            tick.tick().await;
            if let Err(e) = run_once(&engine).await {
                tracing::warn!("dashboard refresh tick failed: {e:#}");
            }
        }
    });
}

/// One pass over all widgets: refresh each that is due.
async fn run_once(engine: &DashboardEngine) -> anyhow::Result<()> {
    let widgets = engine.store.list_all_widgets().await?;
    // Money guard keys off LIVE UI VIEWERS (open SSE streams), not the raw broadcast
    // receiver count — internal subscribers (the hardware nudge loop) must not be
    // mistaken for a human watcher and keep expensive sources running 24/7.
    let has_viewer = engine.store.viewer_count() > 0;
    let now = chrono::Utc::now();

    for widget in widgets {
        if !widget.source.is_refreshable() {
            continue;
        }
        // Money guard: don't run expensive sources when nobody is watching.
        if widget.source.is_expensive() && !has_viewer {
            continue;
        }
        if !is_due(&widget, now) {
            continue;
        }
        let result = sources::resolve(
            &engine.http,
            engine.host.as_ref(),
            &widget.source,
            &widget.id,
        )
        .await
        .map_err(|e| e.to_string());
        if let Err(e) = engine.store.update_widget_value(&widget.id, result).await {
            tracing::warn!("dashboard: caching widget '{}' failed: {e:#}", widget.id);
        }
    }
    Ok(())
}

/// Whether a widget's refresh interval has elapsed since its last refresh. A
/// widget that has never refreshed (no `last_refresh_at`) is always due.
fn is_due(widget: &super::Widget, now: chrono::DateTime<chrono::Utc>) -> bool {
    let interval = widget.effective_interval_secs();
    match widget
        .last_refresh_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        Some(last) => {
            let elapsed = now.signed_duration_since(last.with_timezone(&chrono::Utc));
            elapsed.num_seconds() >= interval as i64
        }
        None => true,
    }
}
