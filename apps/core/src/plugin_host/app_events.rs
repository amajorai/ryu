//! App events: plugin-declared phases, their notes and activity items.

use super::*;

// ── App events (plugin-declared phases) ──────────────────────────────────────
//
// Every phase above is a Core-owned constant. An **app event** is the open half of
// the same mechanism: a plugin declares `contributes.hook_events` (see
// [`crate::plugin_manifest::HookEventContribution`]), its sidecar raises the event
// through the `events.emit` kernel capability, and Core dispatches it here as a
// phase named `<owning plugin id>#<event name>`.
//
// That naming is not cosmetic. Core phases are bare words and app events always
// carry a `/`, so the two namespaces cannot collide and `phase_matches` needs no
// special case — an app event flows through the exact same `dispatch_phase` path
// every built-in phase uses. The only thing app events need on top is a narrower
// directive policy, below.

/// Directives an **app-event** hook may return.
///
/// An app event fires with no turn in flight — a meeting ended, a workflow run
/// failed — so most of the [`HookDirective`] vocabulary is meaningless here:
/// there is no outgoing user message to [`Replace`], no context to [`Inject`] into
/// and no turn to [`Continue`]. Applying one would mean silently mutating whatever
/// chat happened to be open, which is not what the hook asked for and not something
/// the user could predict.
///
/// So an app-event hook is observation-plus-notification: [`None`] or [`Note`].
/// Anything else is dropped with a log rather than an error, because the hook is
/// otherwise well-formed and failing the whole dispatch would punish the plugin for
/// a directive that simply has no meaning in this position.
///
/// A plugin that genuinely wants an app event to *drive a conversation* has the
/// right tool already: react to the event with a workflow (a
/// [`crate::workflow::WorkflowTrigger::Event`]), which owns its own run context.
///
/// [`None`]: HookDirective::None
/// [`Note`]: HookDirective::Note
/// [`Replace`]: HookDirective::Replace
/// [`Inject`]: HookDirective::Inject
/// [`Continue`]: HookDirective::Continue
pub(super) fn app_event_directive_allowed(directive: &HookDirective) -> bool {
    matches!(directive, HookDirective::None | HookDirective::Note { .. })
}

/// The maximum serialized size of an app-event payload, in bytes.
///
/// The payload is forwarded verbatim into every consumer's sandbox, so an
/// unbounded one is an amplification channel: a single emit would be copied into N
/// sandbox runs. 64 KiB is far above any real event and far below anything that
/// makes fan-out expensive.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;

/// Dispatch an **app event** to every enabled plugin whose hook declares it.
///
/// Detached-style semantics (fail-open, never blocks the emitter) matching the
/// [`ON_POST_TOOL_USE`] precedent, with directives filtered by
/// [`app_event_directive_allowed`]. Returns the surviving directives so the emit
/// handler can report how many consumers acted.
///
/// Authorization is NOT checked here — this is the dispatch primitive, and the emit
/// seam (`events.emit`) is what proves the caller owns the event. Anything reaching
/// this function is already authorized.
pub async fn dispatch_app_event(
    state: &ServerState,
    event: &str,
    ctx: &HookContext,
) -> Vec<HookDirective> {
    let directives = dispatch_phase(state, event, ctx).await;
    let total = directives.len();
    let kept: Vec<HookDirective> = directives
        .into_iter()
        .filter(app_event_directive_allowed)
        .collect();
    if kept.len() != total {
        tracing::debug!(
            event,
            dropped = total - kept.len(),
            "plugin_host: dropped app-event directives that have no meaning off the chat path"
        );
    }
    kept
}

/// Surface a [`HookDirective::Note`] returned by an app-event hook.
///
/// On the chat path a note is rendered out-of-band next to the answer. An app event
/// has no answer to sit beside, so the note goes to the **unified activity feed** —
/// the one place a user already looks for "something happened while I wasn't
/// watching", and the same sink a fired monitor alert lands in.
///
/// Deliberately NOT the notification fan-out: that reaches configured channels
/// (Telegram, email, push), and a hook firing on every `x.updated` event would turn
/// into a pager. An app-event hook that genuinely warrants telling a human uses
/// `host.notify` (the `notifications:send` grant: one bounded notification for the
/// active user); an app's sidecar uses the `notify.deliver` kernel capability, which
/// needs `notifications:send-to-user` to reach anyone but the active user. The
/// external-channel `notify.fanout` capability is NOT available to hooks or other
/// apps: it stays pinned to `@ryu/monitors`.
///
/// Best-effort — a feed write failure is logged, never propagated to the emitter.
pub async fn notify_app_event_note(state: &ServerState, event: &str, text: &str) {
    let item = ryu_activity::ActivityItem::new("plugin_hook_note", "plugins", event.to_owned())
        .with_body(Some(text.to_owned()))
        .with_level(ryu_activity::ActivityLevel::Info)
        .with_metadata(serde_json::json!({ "event": event }));
    if let Err(e) = state.activity.record(item).await {
        tracing::warn!("plugin_host: failed to record app-event note on activity feed: {e:#}");
    }
}

/// An activity-feed row an app attaches to an `events.emit` call (the body's
/// `activity` field). The app owns the wording; Core owns attribution: `source` is
/// derived from the authenticated caller, never read from here.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AppEventActivity {
    /// The row's class (`meeting`, `quest`, …), `[a-z0-9_.-]{1,64}`.
    pub kind: String,
    /// The row's headline.
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// `info` | `success` | `warning` (default `info`).
    #[serde(default)]
    pub level: Option<String>,
    /// A small JSON object of ids the desktop can deep-link with.
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

pub(super) const MAX_ACTIVITY_TITLE_BYTES: usize = 512;
pub(super) const MAX_ACTIVITY_BODY_BYTES: usize = 4 * 1024;
pub(super) const MAX_ACTIVITY_METADATA_BYTES: usize = 4 * 1024;

/// The activity source an app's rows are attributed to: the name half of a scoped
/// id (`@ryu/meetings` → `meetings`), or a flat id verbatim. Derived from the
/// authenticated caller so it matches the per-app source the feed already filters on.
#[must_use]
pub fn activity_source_for(plugin_id: &str) -> &str {
    plugin_id.rsplit('/').next().unwrap_or(plugin_id)
}

/// Build the [`ryu_activity::ActivityItem`] for an app's `events.emit` activity hint,
/// or explain why the hint is refused. Pure, so the bounds and the attribution rule
/// are unit-testable.
///
/// # Errors
/// A malformed kind, an empty/oversized title, an oversized body, an unknown level,
/// or metadata that is not a small JSON object.
pub fn app_event_activity_item(
    plugin_id: &str,
    event: &str,
    hint: &AppEventActivity,
) -> Result<ryu_activity::ActivityItem, String> {
    let kind_ok = !hint.kind.is_empty()
        && hint.kind.len() <= 64
        && hint
            .kind
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    if !kind_ok {
        return Err("activity.kind must match [a-z0-9_.-]{1,64}".to_owned());
    }
    let title = hint.title.trim();
    if title.is_empty() || title.len() > MAX_ACTIVITY_TITLE_BYTES {
        return Err("activity.title must be 1..=512 bytes".to_owned());
    }
    if hint
        .body
        .as_ref()
        .is_some_and(|b| b.len() > MAX_ACTIVITY_BODY_BYTES)
    {
        return Err("activity.body exceeds 4 KiB".to_owned());
    }
    let level = match hint.level.as_deref().unwrap_or("info") {
        "info" => ryu_activity::ActivityLevel::Info,
        "success" => ryu_activity::ActivityLevel::Success,
        "warning" => ryu_activity::ActivityLevel::Warning,
        other => return Err(format!("activity.level '{other}' is not supported")),
    };
    let mut metadata = match &hint.metadata {
        None => serde_json::json!({}),
        Some(v @ serde_json::Value::Object(_)) => {
            if serde_json::to_vec(v).map_or(usize::MAX, |b| b.len()) > MAX_ACTIVITY_METADATA_BYTES {
                return Err("activity.metadata exceeds 4 KiB".to_owned());
            }
            v.clone()
        }
        Some(_) => return Err("activity.metadata must be a JSON object".to_owned()),
    };
    metadata["event"] = serde_json::Value::String(event.to_owned());
    Ok(ryu_activity::ActivityItem::new(
        hint.kind.clone(),
        activity_source_for(plugin_id),
        title.to_owned(),
    )
    .with_body(hint.body.clone())
    .with_level(level)
    .with_metadata(metadata))
}

/// Record an app's `events.emit` activity hint on the unified activity feed.
/// Best-effort: a refused hint or a failed write is logged, never propagated.
pub async fn record_app_event_activity(
    state: &ServerState,
    plugin_id: &str,
    event: &str,
    hint: &AppEventActivity,
) {
    match app_event_activity_item(plugin_id, event, hint) {
        Ok(item) => {
            if let Err(e) = state.activity.record(item).await {
                tracing::warn!(plugin = %plugin_id, event, "activity: failed to record app event: {e:#}");
            }
        }
        Err(reason) => {
            tracing::warn!(plugin = %plugin_id, event, "events.emit: activity hint refused: {reason}");
        }
    }
}

/// Every app event declared by a currently **enabled** plugin, as
/// `(event, owning plugin id, contribution)`.
///
/// The catalog behind the event picker in the workflow builder and the consumer
/// docs. Reads the live manifest set, so an enable/disable is reflected without a
/// refresh — same posture as [`collect_enabled_hooks`].
pub async fn collect_declared_events(
    state: &ServerState,
) -> Vec<(String, crate::plugin_manifest::HookEventContribution)> {
    let enabled_ids: HashSet<String> = match state.app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect(),
        Err(e) => {
            tracing::warn!("plugin_host: could not list plugins for event catalog: {e}");
            return Vec::new();
        }
    };
    let manifests = state.app_manifests.read().await;
    let mut events = Vec::new();
    for manifest in manifests.iter() {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        for event in &contributes.hook_events {
            events.push((manifest.id.clone(), event.clone()));
        }
    }
    events
}

/// Whether `plugin_id` declared `event` in its manifest — the authorization
/// predicate behind the emit seam.
///
/// Two conditions, and both matter. The namespace half of the event id must be
/// `plugin_id` (so an app cannot emit into another app's namespace even if it
/// declares the row), and the event must actually appear in that manifest's
/// `hook_events` (so an app cannot emit an event it never published a contract
/// for). Fail-closed: an unknown plugin, a missing `contributes`, or an
/// undeclared event all return `false`.
pub async fn may_emit_event(state: &ServerState, plugin_id: &str, event: &str) -> bool {
    let Some((owner, _)) = crate::plugin_manifest::split_hook_event_id(event) else {
        return false;
    };
    // Kernel events (`core#…`) are Core-originated only. The loader already makes
    // them undeclarable (and the owner id unclaimable); this is the runtime belt.
    if owner == crate::plugin_manifest::KERNEL_EVENT_OWNER || owner != plugin_id {
        return false;
    }
    let manifests = state.app_manifests.read().await;
    manifests
        .iter()
        .find(|m| m.id == plugin_id)
        .and_then(|m| m.contributes.as_ref())
        .is_some_and(|c| c.hook_events.iter().any(|e| e.id == event))
}
