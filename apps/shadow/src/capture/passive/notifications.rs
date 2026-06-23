//! Notification capture — records system notifications (track 10).
//!
//! Honest scope note: upstream Shadow captures notifications via entitled macOS
//! APIs. There is no portable way for a plain, unpackaged process to subscribe to
//! the OS notification stream on Windows/Linux, so rather than ship a fragile
//! native hook that only works under packaged identity, this source exposes the
//! track + envelope and ingests notifications pushed to `/ingest` (track 10,
//! `type: "notification"`). A platform notification listener can be layered on
//! later behind a cfg without changing the data path, timeline, or search.
//!
//! Helpers are public so other modules / future native listeners emit a uniform
//! event shape.

/// Emit a notification event. `app` is the originating app, `title`/`body` the
/// notification content. Used by `/ingest` consumers and any future native hook.
pub fn emit_notification(app: &str, title: &str, body: &str) {
    let text = if body.is_empty() {
        format!("{app}: {title}")
    } else {
        format!("{app}: {title} — {body}")
    };
    super::emit(
        super::TRACK_NOTIFICATION,
        "notification",
        "Notifications",
        &super::truncate(&text, 1024),
        vec![
            ("source_app", rmpv::Value::from(app)),
            ("title", rmpv::Value::from(title)),
            ("body", rmpv::Value::from(body)),
        ],
    );
}

/// No always-on listener (see module note). Logs how to feed notifications so the
/// track is discoverable.
pub fn start() {
    tracing::info!(
        "Notification capture ready on track {} — push to POST /ingest (type: \"notification\")",
        super::TRACK_NOTIFICATION
    );
}
