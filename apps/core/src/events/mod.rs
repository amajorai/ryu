//! Process-global app-events broadcast.
//!
//! A tiny in-process pub/sub channel for events Core wants to push to a connected
//! UI but cannot render itself — first consumer is **desktop notifications**: the
//! built-in `notify__desktop` MCP action (an agent tool) publishes here, and the
//! desktop subscribes via the `/api/events/notifications/stream` SSE endpoint and
//! renders a native OS notification.
//!
//! Kept separate from the monitors alert store (which is durable, queryable
//! monitoring data) — these are ephemeral fire-and-forget UI signals. The sender
//! self-initialises on first use, so there is nothing to wire at startup.
//!
//! Placement note (Core vs Gateway): this is orchestration plumbing for "what
//! runs" surfacing a result to the user — Core, not Gateway.

use std::sync::OnceLock;

use serde::Serialize;
use tokio::sync::broadcast;

/// A desktop notification request, fanned out to SSE subscribers.
#[derive(Clone, Debug, Serialize)]
pub struct DesktopNotification {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// One of `info` | `success` | `warning` | `error`. Advisory only.
    pub level: String,
    /// When set, this notification is meant for one specific member. A connected
    /// desktop whose logged-in user differs ignores it, so a shared team node can
    /// fan a workflow ping to the right person only. Unset = broadcast to every
    /// connected surface (the prior behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<String>,
    /// The app-inbox row this event mirrors, so the desktop can deep-link a tapped
    /// OS toast straight to the inbox item (and its Ack action).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
}

static EVENTS: OnceLock<broadcast::Sender<DesktopNotification>> = OnceLock::new();

fn sender() -> &'static broadcast::Sender<DesktopNotification> {
    EVENTS.get_or_init(|| broadcast::channel(64).0)
}

/// Publish a desktop notification to all live subscribers. A send error just
/// means no UI is currently connected — never an error for the caller.
pub fn publish(notification: DesktopNotification) {
    let _ = sender().send(notification);
}

/// Subscribe to the desktop-notification stream (used by the SSE endpoint).
pub fn subscribe() -> broadcast::Receiver<DesktopNotification> {
    sender().subscribe()
}

/// A **navigation request** from a sandboxed app to the host shell — the
/// `host.navigate` primitive. A sandboxed app UI cannot deep-link or navigate the
/// shell itself; it emits this and the connected surface (desktop/web/…) consumes
/// the SSE stream and performs the navigation. Fire-and-forget, like a notification.
#[derive(Clone, Debug, Serialize)]
pub struct NavigationRequest {
    /// The plugin that requested the navigation (audit + so the shell can scope the
    /// target to that app's routes).
    pub plugin_id: String,
    /// The navigation target — a shell route or `ryu://` deep link (e.g.
    /// `"/library/monitors"`). Interpreted by the surface's router.
    pub target: String,
    /// Optional structured params for the target (query/state). Opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

static NAV_EVENTS: OnceLock<broadcast::Sender<NavigationRequest>> = OnceLock::new();

fn nav_sender() -> &'static broadcast::Sender<NavigationRequest> {
    NAV_EVENTS.get_or_init(|| broadcast::channel(64).0)
}

/// Publish a navigation request to all live subscribers (the `host.navigate`
/// primitive). No subscriber = no-op, never an error for the caller.
pub fn publish_navigation(request: NavigationRequest) {
    let _ = nav_sender().send(request);
}

/// Subscribe to the navigation-request stream (used by the SSE endpoint the shell
/// consumes).
pub fn subscribe_navigation() -> broadcast::Receiver<NavigationRequest> {
    nav_sender().subscribe()
}
