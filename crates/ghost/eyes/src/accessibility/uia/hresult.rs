// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! HRESULT classification for UI Automation calls.
//!
//! The `UIA_E_*` constants are `u32` in windows 0.59, so codes are compared as
//! `u32`. RPC status codes are literals so `Win32_System_Rpc` stays disabled.

use ::windows::Win32::Foundation::{
    E_ACCESSDENIED, E_INVALIDARG, E_NOINTERFACE, RPC_E_DISCONNECTED, RPC_E_SERVERFAULT,
};
use ::windows::Win32::UI::Accessibility::{
    UIA_E_ELEMENTNOTAVAILABLE, UIA_E_ELEMENTNOTENABLED, UIA_E_NOTSUPPORTED, UIA_E_TIMEOUT,
};
use serde_json::json;

use super::super::StepOutcome;
use crate::contract::{Delivery, ErrorCode, GhostError};

/// `RPC_S_SERVER_UNAVAILABLE` as an HRESULT.
const RPC_SERVER_UNAVAILABLE: u32 = 0x8007_06BA;
/// `RPC_S_CALL_FAILED` as an HRESULT.
const RPC_CALL_FAILED: u32 = 0x8007_06BE;

/// Whether the call that failed had already been sent to the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    /// A read (pattern acquisition, property read): nothing was delivered, so an
    /// otherwise uncertain failure is reported as `NotDelivered`.
    Read,
    /// A mutating call (`Invoke`, `Toggle`, `SetValue`, …).
    Act,
}

/// The null-pattern rule: windows 0.59 reports an unsupported pattern as an `Err`
/// whose code is `HRESULT(0)` (a null out pointer); `E_NOINTERFACE` means the same.
/// Checked before [`classify_code`].
pub(crate) fn is_unsupported_pattern(code: i32) -> bool {
    code == 0 || code == E_NOINTERFACE.0
}

/// Maps an HRESULT from `method` to a step outcome or a contract error.
/// `UIA_E_NOTSUPPORTED` falls through to the next rung (`Ok(NotDelivered)`).
pub(crate) fn classify_code(
    code: i32,
    method: &'static str,
    phase: Phase,
) -> Result<StepOutcome, GhostError> {
    let hr = code as u32;
    let details = json!({ "method": method, "hresult": format!("0x{hr:08X}") });
    let err = if hr == UIA_E_NOTSUPPORTED {
        return Ok(StepOutcome::NotDelivered);
    } else if hr == UIA_E_ELEMENTNOTAVAILABLE {
        GhostError::stale_ref("the element is no longer available")
            .with_suggestion("take a new snapshot")
    } else if hr == UIA_E_ELEMENTNOTENABLED {
        GhostError::new(ErrorCode::ActionFailed, "the element is not enabled")
            .with_delivery(Delivery::NotDelivered)
    } else if code == E_ACCESSDENIED.0 {
        GhostError::perm_denied(
            "access to the element was denied (the target may run at a higher integrity level)",
        )
    } else if code == E_INVALIDARG.0 {
        GhostError::invalid_args("the provider rejected the request as invalid")
    } else if code == RPC_E_SERVERFAULT.0
        || code == RPC_E_DISCONNECTED.0
        || hr == RPC_SERVER_UNAVAILABLE
        || hr == RPC_CALL_FAILED
    {
        uncertain(
            GhostError::new(ErrorCode::AppUnresponsive, "the app did not respond"),
            phase,
        )
    } else if hr == UIA_E_TIMEOUT {
        uncertain(
            GhostError::timeout(
                "the UI Automation call timed out",
                Delivery::DeliveryUncertain,
            ),
            phase,
        )
    } else {
        uncertain(
            GhostError::new(ErrorCode::ActionFailed, "the UI Automation call failed"),
            phase,
        )
    };
    Err(err.with_details(details))
}

fn uncertain(err: GhostError, phase: Phase) -> GhostError {
    match phase {
        Phase::Act => err.with_delivery(Delivery::DeliveryUncertain),
        Phase::Read => err.with_delivery(Delivery::NotDelivered),
    }
}

/// [`classify_code`] for a `windows::core::Error`.
pub(crate) fn classify(
    err: &::windows::core::Error,
    method: &'static str,
    phase: Phase,
) -> Result<StepOutcome, GhostError> {
    classify_code(err.code().0, method, phase)
}

/// [`classify`] for a failure that cannot fall through (e.g. a read needed before
/// acting): `UIA_E_NOTSUPPORTED` becomes ACTION_NOT_SUPPORTED.
pub(crate) fn to_error(
    err: &::windows::core::Error,
    method: &'static str,
    phase: Phase,
) -> GhostError {
    match classify(err, method, phase) {
        Err(e) => e,
        Ok(_) => GhostError::not_supported("the element does not support this action")
            .with_details(json!({ "method": method })),
    }
}
