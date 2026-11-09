//! Device routing (design §1.5, P3): which paired phone runs a call.
//!
//! In order: the origin phone (it may need the OS permission prompt); another
//! paired phone that already has the permission (most recently seen wins);
//! any foreground phone that supports the app but has not decided yet (it gets
//! the needs-permission card on its device stream); otherwise wait for one
//! (`waiting-device`), or fail at once when no paired phone's platform can run
//! the app. A phone that is not the origin must be live (fresh foreground
//! lease and a connected device stream) and must have been paired before the
//! call was created. Routing to a phone that is not the origin always asks
//! (`gate`). Once a target is pinned it never moves.

use super::catalog::catalog;
use super::declaration::{AppPermission, ClientDeviceDecl};
use super::offer::DeviceOffer;
use super::registry::{DeviceState, DeviceToolStore};
use super::{device_stream, presence};

/// One paired phone as routing sees it, for one app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) device_id: String,
    pub(crate) label: String,
    pub(crate) platform: String,
    pub(crate) paired_at_ms: i64,
    pub(crate) last_seen_ms: i64,
    /// A fresh foreground lease.
    pub(crate) foreground: bool,
    /// Can receive the request frame: the origin through the turn stream,
    /// any other phone only through a connected device stream.
    pub(crate) reachable: bool,
    /// The app's declared permission; `None` when the phone never declared it.
    pub(crate) permission: Option<AppPermission>,
    pub(crate) user_disabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Target {
        device_id: String,
        label: String,
        cross_device: bool,
        /// The phone must first show the OS permission prompt.
        needs_permission: bool,
        permission_denied: bool,
    },
    /// No phone can take it right now: `waiting-device`.
    Wait,
    /// No paired phone's platform can run this app.
    UnsupportedPlatform,
}

fn platform_supports(app: &str, platform: &str) -> bool {
    catalog()
        .app(app)
        .is_some_and(|entry| entry.platforms.iter().any(|p| p == platform))
}

fn usable(candidate: &Candidate, app: &str) -> bool {
    platform_supports(app, &candidate.platform)
        && !candidate.user_disabled
        && matches!(
            candidate.permission,
            Some(
                AppPermission::Granted
                    | AppPermission::Limited
                    | AppPermission::Undetermined
                    | AppPermission::Denied
            )
        )
}

fn live(candidate: &Candidate, created_ms: i64) -> bool {
    candidate.foreground && candidate.reachable && candidate.paired_at_ms <= created_ms
}

fn has_permission(candidate: &Candidate) -> bool {
    matches!(
        candidate.permission,
        Some(AppPermission::Granted | AppPermission::Limited)
    )
}

fn target(candidate: &Candidate, cross_device: bool) -> Route {
    Route::Target {
        device_id: candidate.device_id.clone(),
        label: candidate.label.clone(),
        cross_device,
        needs_permission: !has_permission(candidate),
        permission_denied: candidate.permission == Some(AppPermission::Denied),
    }
}

fn most_recent<'a>(candidates: impl Iterator<Item = &'a Candidate>) -> Option<&'a Candidate> {
    candidates.max_by_key(|candidate| candidate.last_seen_ms)
}

/// Pick a target for a call on `app` created at `created_ms` (pure).
pub(crate) fn choose(
    origin: &Candidate,
    others: &[Candidate],
    app: &str,
    created_ms: i64,
) -> Route {
    if live(origin, created_ms) && usable(origin, app) {
        return target(origin, false);
    }
    let ready = others
        .iter()
        .filter(|other| other.device_id != origin.device_id)
        .filter(|other| live(other, created_ms) && usable(other, app));
    if let Some(granted) = most_recent(ready.clone().filter(|other| has_permission(other))) {
        return target(granted, true);
    }
    if let Some(undecided) = most_recent(ready) {
        return target(undecided, true);
    }
    let any_platform = std::iter::once(origin)
        .chain(others)
        .any(|candidate| platform_supports(app, &candidate.platform));
    if any_platform {
        Route::Wait
    } else {
        Route::UnsupportedPlatform
    }
}

/// A pinned target (a parked call being retried) never moves: it runs there
/// when live, otherwise the call waits for it.
pub(crate) fn choose_pinned(
    pinned: &Candidate,
    origin_device_id: &str,
    app: &str,
    created_ms: i64,
) -> Route {
    if live(pinned, created_ms) && usable(pinned, app) {
        target(pinned, pinned.device_id != origin_device_id)
    } else {
        Route::Wait
    }
}

fn candidate_from(
    row: &super::registry::DeviceRow,
    decl: Option<&ClientDeviceDecl>,
    is_origin: bool,
    app: &str,
    now_ms: i64,
) -> Candidate {
    let app_decl = decl.and_then(|decl| decl.app(app));
    let label = decl
        .map(ClientDeviceDecl::display_label)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| row.label.clone());
    Candidate {
        device_id: row.device_id.clone(),
        label,
        platform: row.platform.clone(),
        paired_at_ms: row.paired_at_ms,
        last_seen_ms: row.last_seen_ms,
        foreground: presence::is_foreground(&row.principal_id, &row.device_id, now_ms),
        reachable: is_origin || device_stream::is_connected(&row.principal_id, &row.device_id),
        permission: app_decl.map(|entry| entry.permission),
        user_disabled: app_decl.is_some_and(|entry| entry.user_disabled),
    }
}

/// The origin and every other ACTIVE paired phone of the offer's principal,
/// with their latest declarations. `None` when the origin is no longer paired.
pub(crate) fn candidates(
    store: &DeviceToolStore,
    offer: &DeviceOffer,
    app: &str,
    now_ms: i64,
) -> Option<(Candidate, Vec<Candidate>)> {
    let principal_id = offer.principal.id();
    let rows = store.devices(&principal_id).ok()?;
    let mut origin = None;
    let mut others = Vec::new();
    for row in rows.iter().filter(|row| row.state == DeviceState::Active) {
        let latest = presence::declaration(&principal_id, &row.device_id);
        if row.device_id == offer.origin.device_id {
            let decl = latest.as_deref().unwrap_or(&offer.origin);
            origin = Some(candidate_from(row, Some(decl), true, app, now_ms));
        } else {
            others.push(candidate_from(row, latest.as_deref(), false, app, now_ms));
        }
    }
    origin.map(|origin| (origin, others))
}

/// Canonical ids an offer may carry beyond the origin's own apps: those whose
/// app another active paired phone last declared as offerable.
pub(crate) fn other_device_apps(
    store: &DeviceToolStore,
    offer_principal: &str,
    origin_device_id: &str,
) -> Vec<String> {
    let Ok(rows) = store.devices(offer_principal) else {
        return Vec::new();
    };
    let mut apps = Vec::new();
    for row in rows
        .iter()
        .filter(|row| row.state == DeviceState::Active && row.device_id != origin_device_id)
    {
        let Some(decl) = presence::declaration(offer_principal, &row.device_id) else {
            continue;
        };
        for entry in decl
            .tools
            .iter()
            .filter(|entry| super::declaration::offerable(entry))
        {
            if platform_supports(&entry.app, &row.platform) && !apps.contains(&entry.app) {
                apps.push(entry.app.clone());
            }
        }
    }
    apps
}
