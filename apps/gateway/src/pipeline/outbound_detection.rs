//! The request-scoped log line for an outbound firewall match that a
//! non-blocking policy lets through. Each delivered response logs its decision
//! once, with the request ID and the first matched pattern, at `warn` when the
//! resolved scanner's `[firewall] log_detections` is on and at `debug` when it
//! is off. Blocks are not logged here: every block site keeps its own `warn`
//! line, which `log_detections` never silences.

use crate::config::FirewallPolicy;

/// Log the decision for an outbound match `policy` let through. `Block` is a
/// no-op; the caller logs blocks itself.
pub(super) fn log_let_through(
    log_detections: bool,
    request_id: &str,
    pattern: &str,
    policy: &FirewallPolicy,
    streaming: bool,
) {
    match (policy, streaming) {
        (FirewallPolicy::Block, _) => {}
        (FirewallPolicy::Sanitize, true) => detection_log!(
            log_detections,
            request_id = %request_id,
            pattern = %pattern,
            "firewall: sanitized outbound response (streaming)"
        ),
        (FirewallPolicy::Sanitize, false) => detection_log!(
            log_detections,
            request_id = %request_id,
            pattern = %pattern,
            "firewall: sanitized outbound response"
        ),
        (FirewallPolicy::WarnAndContinue, true) => detection_log!(
            log_detections,
            request_id = %request_id,
            pattern = %pattern,
            "firewall: outbound violation (warn-and-continue, streaming)"
        ),
        (FirewallPolicy::WarnAndContinue, false) => detection_log!(
            log_detections,
            request_id = %request_id,
            pattern = %pattern,
            "firewall: outbound violation (warn-and-continue)"
        ),
    }
}
