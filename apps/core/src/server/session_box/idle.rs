//! The 30 s session Box sweep (design §7.3).
//!
//! - A live session Box with no tool call for `idle_secs` and no viewer is
//!   parked with reason `idle`; a viewer counts as activity. Parking a
//!   conversation's own Box parks its sub-agent children too, so a
//!   conversation whose sub-agents are still working on their own Boxes is
//!   not idle: a parent waiting on a fan-out makes no tool calls itself.
//! - A live Box past its run lifetime is parked with reason `ttl`.
//! - A parked Box the Box service has reaped (its TTL) is forgotten.
//! - Leases of an earlier Core process are recovered: parked and registered,
//!   or deleted when their conversation was deleted.
//!
//! `idle_secs` comes from the owner preference `session-box-idle-secs`, then
//! `RYU_SESSION_BOX_IDLE_SECS`, and defaults to 600 (at least 60).
use super::{
    conversation_keys, existing_slot, fetch_view, forget_empty, lock_registry, park,
    recover_leases, relay_viewer_count, remove_lease, unix_now, Phase, SessionBoxKey,
};
use ryu_sandbox::box_types::ParkReason;
use std::time::Duration;

pub(super) const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
pub(super) const DEFAULT_IDLE_SECS: u64 = 600;
const MIN_IDLE_SECS: u64 = 60;
pub(super) const PREF_IDLE_SECS: &str = "session-box-idle-secs";
pub(super) const ENV_IDLE_SECS: &str = "RYU_SESSION_BOX_IDLE_SECS";

/// Parse an idle setting; anything unusable is ignored.
pub(super) fn parse_idle_secs(raw: &str) -> Option<u64> {
    raw.trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| seconds.max(MIN_IDLE_SECS))
}

/// The idle threshold now in effect.
pub(super) async fn idle_secs() -> u64 {
    if let Ok(store) = crate::server::preferences::PreferencesStore::open_default() {
        if let Ok(Some(raw)) = store.get(PREF_IDLE_SECS).await {
            if let Some(seconds) = parse_idle_secs(&raw) {
                return seconds;
            }
        }
    }
    std::env::var(ENV_IDLE_SECS)
        .ok()
        .and_then(|raw| parse_idle_secs(&raw))
        .unwrap_or(DEFAULT_IDLE_SECS)
}

/// Whether a sub-agent child of the conversation `parent` belongs to is
/// working: its own Box is live and was used within `idle`, or it is busy
/// (being created, resumed or used holds its lock).
pub(super) fn children_active(parent: &SessionBoxKey, idle: Duration) -> bool {
    if parent.child.is_some() {
        return false;
    }
    conversation_keys(&parent.conversation_id)
        .into_iter()
        .filter(|key| key.owner == parent.owner && key.child.is_some())
        .filter_map(|key| existing_slot(&key))
        .any(|slot| {
            slot.try_lock().map_or(true, |guard| {
                guard.as_ref().is_some_and(|entry| {
                    entry.phase == Phase::Live && entry.last_activity.elapsed() < idle
                })
            })
        })
}

/// What the sweep decided for one entry.
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Keep,
    Park(ParkReason),
    Forget(String),
}

/// One sweep. Returns the keys it parked, with the reason.
pub(super) async fn sweep_once(idle: Duration) -> Vec<(SessionBoxKey, ParkReason)> {
    let keys: Vec<SessionBoxKey> = lock_registry().keys().cloned().collect();
    let now = unix_now();
    let mut parked = Vec::new();
    for key in keys {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        // An entry being created, resumed or used holds its lock: it is busy.
        let (decision, box_id) = {
            let Ok(guard) = slot.try_lock() else {
                continue;
            };
            let Some(entry) = guard.as_ref() else {
                continue;
            };
            let decision = match entry.phase {
                Phase::Parked if entry.box_expires_at <= now => {
                    Decision::Forget(entry.lease_id.clone())
                }
                Phase::Parked => Decision::Keep,
                Phase::Live if entry.run_until <= now => Decision::Park(ParkReason::Ttl),
                Phase::Live
                    if entry.last_activity.elapsed() >= idle && !children_active(&key, idle) =>
                {
                    Decision::Park(ParkReason::Idle)
                }
                Phase::Live => Decision::Keep,
            };
            (decision, entry.box_id.clone())
        };
        match decision {
            Decision::Keep => {}
            Decision::Forget(lease_id) => {
                if let Some(entry) = slot.lock().await.take() {
                    drop(entry);
                }
                let _ = remove_lease(&lease_id);
                forget_empty(&key, &slot);
            }
            Decision::Park(ParkReason::Idle) => {
                let viewers = relay_viewer_count(&box_id.0).max(
                    fetch_view(&box_id)
                        .await
                        .and_then(|view| view.desktop)
                        .map_or(0, |desktop| desktop.viewers),
                );
                if viewers > 0 {
                    // Someone is watching the screen: that is activity.
                    if let Some(entry) = slot.lock().await.as_mut() {
                        entry.last_activity = std::time::Instant::now();
                    }
                    continue;
                }
                park_for(&key, ParkReason::Idle, &mut parked).await;
            }
            Decision::Park(reason) => park_for(&key, reason, &mut parked).await,
        }
    }
    parked
}

async fn park_for(
    key: &SessionBoxKey,
    reason: ParkReason,
    parked: &mut Vec<(SessionBoxKey, ParkReason)>,
) {
    match park(key, reason).await {
        Ok(()) => parked.push((key.clone(), reason)),
        Err(_) => {
            tracing::warn!(
                reason = reason.as_str(),
                "Session Box could not be parked; retrying on the next sweep"
            );
        }
    }
}

/// Start the sweep once per process.
pub(super) fn start() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    STARTED.call_once(|| {
        handle.spawn(async {
            let mut ticks = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                ticks.tick().await;
                recover_leases().await;
                let idle = Duration::from_secs(idle_secs().await);
                sweep_once(idle).await;
            }
        });
    });
}
