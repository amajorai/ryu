//! Device data as private reads (design §2.4 step 9).
//!
//! A successful device read marks the turn (`DeviceOffer::private_read`, the
//! same `RunDataFlow` the PTC exfiltration guard uses). In the ACP bridge the
//! next registry call then runs inside that run scope, so the existing guard
//! holds any egress-capable call for Layer A approval, which in-chat grants do
//! not satisfy. In the OpenAI plane the only other tools are browser tools,
//! which are egress-capable and have no approval engine path, so they are
//! refused outright once the turn read device data.
//!
//! An ACP agent's OWN tools (its fetch, shell, file edits) never pass through
//! the bridge, so the guard cannot hold them. After a device read on the live
//! ACP turn of a conversation, their permission requests are therefore always
//! put to the user, and "always" options are withheld so no rule is persisted
//! in the agent's own settings ([`agent_egress_hold`]). A conversation whose
//! history already holds a device read starts its ACP turns private, because
//! the agent keeps that raw result in its own history (`turn_context`). What
//! remains outside Core's reach: a native tool the agent runs without asking
//! (its own allow rules); see `docs/device-tools.md`.
//!
//! The other direction: a turn that already holds untrusted external content
//! (`mark_tainted_input`, set from the stored history, from browser results
//! and from any non-device tool an ACP agent reports) asks for every device
//! call.

use std::future::Future;
use std::sync::Arc;

use super::offer::DeviceOffer;

/// Record a successful device read on the turn.
pub(crate) fn mark_device_read(offer: &DeviceOffer, canonical_id: &str) {
    offer.private_read.mark_private_read(canonical_id);
}

/// The device tool that made this turn private, if any.
pub(crate) fn private_read_source(offer: &DeviceOffer) -> Option<String> {
    offer.private_read.private_read_source().map(str::to_owned)
}

/// The refusal a browser tool gets after a device read in the same turn.
pub(crate) fn browser_egress_refusal(offer: Option<&DeviceOffer>) -> Option<String> {
    let source = private_read_source(offer?)?;
    Some(format!(
        "This page action was not run: this turn already read private data from the phone with `{source}`, and sending data out after that needs your approval."
    ))
}

/// Run a bridge registry call under the turn's private-read scope when the
/// turn read device data and no PTC run scope is already set, so the
/// exfiltration guard holds later egress.
pub(crate) async fn with_device_read_scope<F: Future>(
    offer: Option<&Arc<DeviceOffer>>,
    future: F,
) -> F::Output {
    let tainted = offer.filter(|offer| private_read_source(offer).is_some());
    match tainted {
        Some(offer) if crate::approvals::exfiltration_guard::current_sandbox_run().is_none() => {
            crate::approvals::exfiltration_guard::scope_sandbox_run(
                Arc::clone(&offer.private_read),
                future,
            )
            .await
        }
        _ => future.await,
    }
}

/// ACP tool kinds that cannot carry data out of the machine.
const NON_EGRESS_KINDS: &[&str] = &["read", "think", "switch_mode"];

/// Whether an agent tool of this ACP kind can send data out (fetch, execute,
/// edit, search and unknown kinds all can).
pub(crate) fn agent_kind_can_egress(kind: &str) -> bool {
    !NON_EGRESS_KINDS.contains(&kind)
}

/// The device tool that made the live ACP turn of `conversation_id` private,
/// when an agent tool of `kind` must be put to the user without an "always"
/// option.
pub(crate) fn agent_egress_hold(conversation_id: &str, kind: &str) -> Option<String> {
    if !agent_kind_can_egress(kind) {
        return None;
    }
    let offer = super::turn_context::live_offer_for_conversation(conversation_id)?;
    private_read_source(&offer)
}
