//! Read-only provider calls for apps that refresh sources nobody approves.
//!
//! A dashboard widget is a provider call that repeats on a timer, and the
//! dashboard builder lets a model write one. In chat the same action would wait
//! for the person when it writes to a connected account; a refresh has nobody
//! to ask. So an app that stores such sources is held to reads: its calls are
//! classified with [`crate::connection_policy::require_unattended_read`] and
//! anything else is refused here, before Gateway is asked to run it.
//!
//! No app is named. The app's own manifest decides: one that provides the
//! widget authoring capability the builder writes through
//! ([`crate::dashboard_capabilities::CAP_UPSERT_WIDGET`]) is held, whichever
//! app that is. The rule is by construction, not by trust in what a widget
//! says about itself: the action id is the only input.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ryu_app_events::ManagedProviderCall;
use serde_json::json;

use crate::plugin_manifest::PluginManifest;
use crate::server::ServerState;

/// The `reason` field of the refusal, so an app can tell it from other 403s.
pub(super) const REASON: &str = "read_only_source";

/// Whether this app stores sources that are refreshed with nobody watching.
pub(super) fn refreshes_stored_sources(manifest: &PluginManifest) -> bool {
    manifest
        .provides
        .iter()
        .any(|entry| entry.capability == crate::dashboard_capabilities::CAP_UPSERT_WIDGET)
}

/// Why `call` is not a plain read, or `None` when it is one.
///
/// Composio's `capabilities` operation lists a toolkit's public tools and
/// touches no account. `execute` (and a call that names no operation) runs the
/// action, so the action id is classified. Every other operation changes
/// something (`connect`, `disconnect`, `file_upload`) and is refused.
///
/// The operation and the provider are compared exactly as sent. Gateway reads
/// them exactly too, and the call is forwarded unchanged, so a padded or
/// respelled name is refused here and never read one way by Core and another
/// way upstream.
pub(super) fn not_a_read(call: &ManagedProviderCall) -> Option<String> {
    match call.operation.as_deref() {
        Some("capabilities") if call.provider == crate::connection_policy::COMPOSIO_PROVIDER => {
            None
        }
        Some("execute") | None => {
            crate::connection_policy::require_unattended_read(&call.provider, &call.tool_id).err()
        }
        Some(operation) => Some(format!(
            "the provider operation '{operation}' cannot run here. {}",
            crate::connection_policy::UNATTENDED_READ_RULE
        )),
    }
}

/// The refusal for a provider call of `plugin_id`, or `None` when the call may
/// go on: the app is not held to reads, or the call is a read.
///
/// The capability dispatcher has already matched the caller against its
/// manifest for the grant check, so an app with no loaded manifest never gets
/// this far.
pub(super) async fn refusal(
    state: &ServerState,
    plugin_id: &str,
    call: &ManagedProviderCall,
) -> Option<Response> {
    let held = state
        .app_manifests
        .read()
        .await
        .iter()
        .any(|manifest| manifest.id == plugin_id && refreshes_stored_sources(manifest));
    if !held {
        return None;
    }
    let message = not_a_read(call)?;
    tracing::warn!(
        plugin_id,
        provider = %call.provider,
        tool_id = %call.tool_id,
        "provider call refused: an app that refreshes stored sources may only read"
    );
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": message, "reason": REASON })),
        )
            .into_response(),
    )
}
