//! The background loop behind [`super::data_purge_pull`]: shortly after boot,
//! then on a slow tick, a node bound to the control plane pulls and runs its
//! queued per-member purges. Failures back off exponentially; an unbound or
//! local-only node sleeps without touching the network.

use std::time::Duration;

use super::data_purge_pull::{
    pull_client_builder, run_cycle, verified_purge_subject, CycleError, PendingAcks,
};
use super::data_user_purge::PurgeReason;
use super::ServerState;

/// First pull after boot: long enough for registration and app sidecars.
pub(crate) const BOOT_DELAY: Duration = Duration::from_secs(60);
/// The slow tick between successful pulls.
pub(crate) const TICK: Duration = Duration::from_secs(5 * 60);
/// The longest backoff after repeated failures.
pub(crate) const MAX_BACKOFF: Duration = Duration::from_secs(60 * 60);

/// The delay before the next cycle after `failures` consecutive failed
/// cycles: the tick, doubled per failure, capped at [`MAX_BACKOFF`].
pub(crate) fn next_delay(failures: u32) -> Duration {
    let factor = 1u64 << failures.min(10);
    TICK.saturating_mul(u32::try_from(factor).unwrap_or(u32::MAX))
        .min(MAX_BACKOFF)
}

/// The control plane and credential to pull with, only once this node is
/// registered (before that the key may still be the single-use bootstrap
/// credential, which a pull must not consume).
fn bound_control_plane() -> Option<(String, String)> {
    crate::sidecar::control_plane::registered_node()?;
    let key = crate::sidecar::control_plane::gateway_key()?;
    Some((crate::sidecar::control_plane::control_plane_url(), key))
}

/// Run one pulled purge exactly like `POST /api/data/purge-user`: revoke the
/// member's app route delegations, then fan the purge out. True when complete.
async fn execute_purge(state: &ServerState, user_id: &str, reason: PurgeReason) -> bool {
    if matches!(
        reason,
        PurgeReason::AccountDeleted | PurgeReason::MemberRemoved
    ) {
        super::app_route_revocation::revoke_user(user_id, crate::pairing::now_secs());
    }
    let report = super::data_user_purge::purge_user_app_data(state, user_id).await;
    report["complete"].as_bool() == Some(true)
}

fn describe(error: CycleError) -> String {
    match error {
        CycleError::Network => "request failed".to_owned(),
        CycleError::Status(status) => format!("control plane returned {status}"),
        CycleError::Decode => "response did not decode".to_owned(),
    }
}

/// Start the pull loop.
pub(crate) fn spawn(state: ServerState) {
    tokio::spawn(async move {
        // Never follows redirects: the node credential stays on its origin.
        let client = match pull_client_builder().build() {
            Ok(client) => client,
            Err(_) => {
                tracing::warn!("data/purge-pull: HTTP client unavailable; pull disabled");
                return;
            }
        };
        let mut pending = PendingAcks::default();
        let mut failures: u32 = 0;
        tokio::time::sleep(BOOT_DELAY).await;
        loop {
            let delay = match bound_control_plane() {
                None => TICK,
                Some((base, key)) => {
                    let verify = |token: &str, now: u64| verified_purge_subject(token, now);
                    let result = run_cycle(
                        &client,
                        &base,
                        &key,
                        &mut pending,
                        &verify,
                        &crate::pairing::now_secs,
                        |user_id, reason| {
                            let state = state.clone();
                            async move { execute_purge(&state, &user_id, reason).await }
                        },
                    )
                    .await;
                    match result {
                        Ok(report) => {
                            failures = 0;
                            if report.pulled > 0 || report.reacked > 0 || report.malformed > 0 {
                                tracing::info!(
                                    pulled = report.pulled,
                                    completed = report.completed,
                                    incomplete = report.incomplete,
                                    refused = report.refused,
                                    unauthorized = report.unauthorized,
                                    malformed = report.malformed,
                                    reacked = report.reacked,
                                    ack_failed = report.ack_failed,
                                    unacked = pending.len(),
                                    "data/purge-pull: queued member purges processed"
                                );
                            }
                            TICK
                        }
                        Err(error) => {
                            failures = failures.saturating_add(1);
                            let delay = next_delay(failures);
                            tracing::warn!(
                                failures,
                                retry_in_secs = delay.as_secs(),
                                "data/purge-pull: pull failed ({}); backing off",
                                describe(error)
                            );
                            delay
                        }
                    }
                }
            };
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_from_the_tick_and_caps_at_an_hour() {
        assert_eq!(next_delay(0), TICK);
        assert_eq!(next_delay(1), TICK * 2);
        assert_eq!(next_delay(2), TICK * 4);
        assert_eq!(next_delay(3), TICK * 8);
        assert_eq!(next_delay(4), MAX_BACKOFF);
        assert_eq!(next_delay(u32::MAX), MAX_BACKOFF);
    }

    #[test]
    fn errors_are_described_without_member_data() {
        assert_eq!(
            describe(CycleError::Status(401)),
            "control plane returned 401"
        );
        assert_eq!(describe(CycleError::Network), "request failed");
        assert_eq!(describe(CycleError::Decode), "response did not decode");
    }

    #[tokio::test]
    async fn an_unregistered_node_never_pulls() {
        let result = crate::sidecar::control_plane::with_test_node_binding(false, None, async {
            bound_control_plane()
        })
        .await;
        assert!(result.is_none());
    }
}
