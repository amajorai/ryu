// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! AXError classification for semantic actions.
//!
//! `classify_perform` covers `AXUIElementPerformAction`; `classify_set` covers
//! `AXUIElementSetAttributeValue`, which is always decided after a read-back.

use serde_json::json;

use super::super::StepOutcome;
use super::ffi::*;
use crate::contract::{Delivery, ErrorCode, GhostError};

fn with_ax(err: GhostError, code: i32) -> GhostError {
    err.with_details(json!({ "ax_error": code }))
}

/// The mappings shared by both classifiers; `None` for codes they handle themselves.
pub(crate) fn common(code: i32, what: &str) -> Option<GhostError> {
    let err = match code {
        AX_API_DISABLED => GhostError::perm_denied(
            "accessibility access is disabled for this process; grant it in System Settings",
        ),
        AX_INVALID_UI_ELEMENT => {
            GhostError::stale_ref(format!("the element went away during {what}"))
                .with_suggestion("take a new snapshot")
        }
        AX_CANNOT_COMPLETE => GhostError::new(
            ErrorCode::AppUnresponsive,
            format!("the application did not answer {what}"),
        )
        .with_delivery(Delivery::DeliveryUncertain),
        AX_ILLEGAL_ARGUMENT => {
            GhostError::invalid_args(format!("the application rejected the arguments of {what}"))
        }
        AX_FAILURE => GhostError::new(ErrorCode::ActionFailed, format!("{what} failed"))
            .with_delivery(Delivery::DeliveryUncertain),
        _ => return None,
    };
    Some(with_ax(err, code))
}

/// Any code outside the common table: ACTION_FAILED with uncertain delivery.
fn unlisted(code: i32, what: &str) -> GhostError {
    with_ax(
        GhostError::new(
            ErrorCode::ActionFailed,
            format!("{what} failed with an unexpected accessibility error"),
        )
        .with_delivery(Delivery::DeliveryUncertain),
        code,
    )
}

/// How an `AXUIElementPerformAction` result is to be treated.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PerformClass {
    /// The call succeeded; the rung decides verification.
    Success,
    /// ActionUnsupported / NotImplemented: `NotDelivered`, the chain falls through.
    Unsupported,
    /// AttributeUnsupported / NoValue: decided by the observable effect only.
    Uninformative,
    Error(GhostError),
}

pub(crate) fn classify_perform(code: i32, what: &str) -> PerformClass {
    match code {
        AX_SUCCESS => PerformClass::Success,
        AX_ACTION_UNSUPPORTED | AX_NOT_IMPLEMENTED => PerformClass::Unsupported,
        AX_ATTRIBUTE_UNSUPPORTED | AX_NO_VALUE => PerformClass::Uninformative,
        _ => PerformClass::Error(common(code, what).unwrap_or_else(|| unlisted(code, what))),
    }
}

/// An uninformative perform result never falls through: the effect decides.
pub(crate) fn uninformative_outcome(
    code: i32,
    what: &str,
    effect_observed: bool,
) -> Result<StepOutcome, GhostError> {
    if effect_observed {
        Ok(StepOutcome::DeliveredVerified)
    } else {
        Err(with_ax(
            GhostError::new(
                ErrorCode::ActionFailed,
                format!("{what} returned no usable status and no effect was observed"),
            )
            .with_delivery(Delivery::DeliveryUncertain),
            code,
        ))
    }
}

/// What a read-back after a set showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadBack {
    /// Equal to the requested value.
    Requested,
    /// Equal to the value before the write.
    Before,
    /// Some other value.
    Other,
    /// Could not be read.
    Unreadable,
}

/// Decides an `AXUIElementSetAttributeValue` result from its read-back.
pub(crate) fn classify_set(
    code: i32,
    readback: ReadBack,
    what: &str,
) -> Result<StepOutcome, GhostError> {
    match readback {
        ReadBack::Requested => return Ok(StepOutcome::DeliveredVerified),
        ReadBack::Before => return Ok(StepOutcome::DeliveredWithoutEffect),
        ReadBack::Other | ReadBack::Unreadable => {}
    }
    if code == AX_SUCCESS {
        return Ok(StepOutcome::DeliveredUnverified);
    }
    Err(common(code, what).unwrap_or_else(|| unlisted(code, what)))
}
