//! What each backend can do, and the run view that carries it.

use super::super::store::RunRecord;
use super::super::CloudTaskBackend;
use serde::Serialize;

// ── What each backend can do (docs/subscription-cloud-sessions.md §5) ────────

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Features {
    pub(crate) follow_up: bool,
    pub(crate) live_status: bool,
    pub(crate) run_log: bool,
    pub(crate) diff_in_ryu: bool,
    pub(crate) pull_request_in_ryu: bool,
    pub(crate) live_screen: bool,
    pub(crate) stop_from_ryu: bool,
    /// Charged in Ryu credits.
    pub(crate) ryu_credits: bool,
}

pub(crate) fn features(backend: CloudTaskBackend) -> Features {
    match backend {
        CloudTaskBackend::RyuBox => Features {
            follow_up: true,
            live_status: true,
            run_log: true,
            diff_in_ryu: true,
            pull_request_in_ryu: true,
            live_screen: true,
            stop_from_ryu: true,
            ryu_credits: true,
        },
        CloudTaskBackend::AnthropicSubscriptionCli => Features {
            follow_up: true,
            live_status: false,
            run_log: false,
            diff_in_ryu: false,
            pull_request_in_ryu: false,
            live_screen: false,
            stop_from_ryu: false,
            ryu_credits: false,
        },
        CloudTaskBackend::AnthropicSubscriptionSdk | CloudTaskBackend::OpenaiSubscriptionSdk => {
            Features {
                follow_up: true,
                live_status: true,
                run_log: true,
                diff_in_ryu: true,
                pull_request_in_ryu: false,
                live_screen: false,
                stop_from_ryu: true,
                ryu_credits: false,
            }
        }
        CloudTaskBackend::OpenaiSubscriptionCli => Features {
            follow_up: false,
            live_status: true,
            run_log: false,
            diff_in_ryu: false,
            pull_request_in_ryu: false,
            live_screen: false,
            stop_from_ryu: false,
            ryu_credits: false,
        },
    }
}

// ── Views ────────────────────────────────────────────────────────────────────

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunView {
    #[serde(flatten)]
    pub(crate) record: RunRecord,
    pub(crate) features: Features,
}

pub(crate) fn run_view(record: RunRecord) -> RunView {
    let features = features(record.backend);
    RunView { record, features }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_ryu_box_is_billed_in_credits_or_shows_a_live_screen() {
        for backend in CloudTaskBackend::ALL {
            let features = features(backend);
            assert_eq!(features.ryu_credits, backend == CloudTaskBackend::RyuBox);
            assert_eq!(features.live_screen, backend == CloudTaskBackend::RyuBox);
        }
        assert!(!features(CloudTaskBackend::OpenaiSubscriptionCli).follow_up);
        assert!(features(CloudTaskBackend::AnthropicSubscriptionSdk).diff_in_ryu);
        assert!(!features(CloudTaskBackend::AnthropicSubscriptionCli).stop_from_ryu);
    }
}
