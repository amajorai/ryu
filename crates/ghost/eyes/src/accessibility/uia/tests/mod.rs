//! Pure tests of the UIA HRESULT table and the null-pattern rule (Windows-gated
//! with the module; compiled by the cross-target check, run only on Windows).

use super::hresult::{classify_code, is_unsupported_pattern, Phase};
use crate::accessibility::StepOutcome;
use crate::contract::{Delivery, ErrorCode};

fn code_of(hr: u32, phase: Phase) -> (ErrorCode, Delivery) {
    let err = classify_code(hr as i32, "UIA.Test", phase).expect_err("expected an error");
    (err.code, err.delivery)
}

#[test]
fn null_pattern_and_no_interface_are_unsupported() {
    assert!(is_unsupported_pattern(0));
    assert!(is_unsupported_pattern(0x8000_4002_u32 as i32));
    assert!(!is_unsupported_pattern(0x8004_0201_u32 as i32));
    assert!(!is_unsupported_pattern(0x8007_0005_u32 as i32));
}

#[test]
fn not_supported_falls_through() {
    let r = classify_code(0x8004_0204_u32 as i32, "UIA.Test", Phase::Act);
    assert_eq!(r.ok(), Some(StepOutcome::NotDelivered));
}

#[test]
fn element_errors_are_not_delivered() {
    assert_eq!(
        code_of(0x8004_0201, Phase::Act),
        (ErrorCode::StaleRef, Delivery::NotDelivered)
    );
    assert_eq!(
        code_of(0x8004_0200, Phase::Act),
        (ErrorCode::ActionFailed, Delivery::NotDelivered)
    );
    assert_eq!(
        code_of(0x8007_0005, Phase::Act),
        (ErrorCode::PermDenied, Delivery::NotDelivered)
    );
    assert_eq!(
        code_of(0x8007_0057, Phase::Act),
        (ErrorCode::InvalidArgs, Delivery::NotDelivered)
    );
}

#[test]
fn rpc_failures_are_unresponsive_and_uncertain() {
    for hr in [0x8001_0105, 0x8001_0108, 0x8007_06BA, 0x8007_06BE] {
        assert_eq!(
            code_of(hr, Phase::Act),
            (ErrorCode::AppUnresponsive, Delivery::DeliveryUncertain)
        );
    }
}

#[test]
fn timeouts_and_unknown_failures_are_uncertain() {
    assert_eq!(
        code_of(0x8013_1505, Phase::Act),
        (ErrorCode::Timeout, Delivery::DeliveryUncertain)
    );
    // UIA_E_INVALIDOPERATION is never NotDelivered for a mutating call.
    assert_eq!(
        code_of(0x8013_1509, Phase::Act),
        (ErrorCode::ActionFailed, Delivery::DeliveryUncertain)
    );
    assert_eq!(
        code_of(0x8000_4005, Phase::Act),
        (ErrorCode::ActionFailed, Delivery::DeliveryUncertain)
    );
}

#[test]
fn read_failures_never_claim_delivery() {
    assert_eq!(
        code_of(0x8013_1509, Phase::Read),
        (ErrorCode::ActionFailed, Delivery::NotDelivered)
    );
    assert_eq!(
        code_of(0x8007_06BA, Phase::Read),
        (ErrorCode::AppUnresponsive, Delivery::NotDelivered)
    );
}

#[test]
fn error_details_name_the_method_and_hresult() {
    let err = classify_code(0x8013_1509_u32 as i32, "UIA.Invoke", Phase::Act).unwrap_err();
    let details = err.details.expect("details");
    assert_eq!(details["method"], "UIA.Invoke");
    assert_eq!(details["hresult"], "0x80131509");
}
