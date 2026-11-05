//! The reply an output evaluator's Sanitize sends on the buffered stream path.

use super::*;

/// The reply an evaluator Sanitize sends: the provider's frames rebuilt with
/// every string sanitized, each on its own and a value split across frames
/// as one (the DLP's own Sanitize rewrite), as the non-stream
/// `sanitize_json_strings` sanitizes each string of the response. Never the
/// evaluator text joined: a join can both make a value no string holds and
/// break one apart (a phone rule taking a card's first group across a field
/// switch). The standing refusal follows, as after any reply.
pub(in crate::pipeline) fn evaluator_sanitized(
    scanner: &dyn crate::firewall::FirewallBackend,
    raw: &str,
    policy: &FirewallPolicy,
) -> String {
    evaluator_sanitized_reply(scanner, raw, policy).0
}

/// [`evaluator_sanitized`] and the evaluator text of the reply it rebuilt
/// (`None` when it could not, and the reply is the block notice).
pub(super) fn evaluator_sanitized_reply(
    scanner: &dyn crate::firewall::FirewallBackend,
    raw: &str,
    policy: &FirewallPolicy,
) -> (String, Option<String>) {
    match super::rewrite_sse(raw, scanner, policy, true) {
        Ok((body, sanitized, _)) => (body, Some(sanitized)),
        Err(_) => (
            sse_content_frames(
                "[Ryu firewall] Response blocked because the provider stream could not be scanned.",
            ),
            None,
        ),
    }
}
