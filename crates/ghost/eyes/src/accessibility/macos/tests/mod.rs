//! macOS backend tests: pure classifier/coercion tests plus runtime-skipping smoke tests.

use std::time::Duration;

use serde_json::json;

use super::super::{
    AXTree, AXTreeNode, ActionOptions, ElementAction, ElementIdentity, ElementLocator,
    SnapshotOptions, StepOutcome, WindowTarget,
};
use super::actions_state::{coerce, coerced_matches, truthy, value_readback, Coerced, ValueKind};
use super::ax_error::{
    classify_perform, classify_set, uninformative_outcome, PerformClass, ReadBack,
};
use super::electron::{choose_mode, manual_took_effect, web_state, Mode, WebState};
use super::ffi::*;
use super::walk::checked_from_value;
use super::MacOSAXTree;
use crate::contract::{Delivery, ErrorCode};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("tokio runtime")
}

#[test]
fn perform_unsupported_codes_fall_through() {
    for code in [AX_ACTION_UNSUPPORTED, AX_NOT_IMPLEMENTED] {
        assert_eq!(classify_perform(code, "AXPress"), PerformClass::Unsupported);
    }
    assert_eq!(
        classify_perform(AX_SUCCESS, "AXPress"),
        PerformClass::Success
    );
}

#[test]
fn perform_uninformative_codes_never_fall_through() {
    for code in [AX_ATTRIBUTE_UNSUPPORTED, AX_NO_VALUE] {
        assert_eq!(
            classify_perform(code, "AXPress"),
            PerformClass::Uninformative
        );
        assert_eq!(
            uninformative_outcome(code, "AXPress", true).unwrap(),
            StepOutcome::DeliveredVerified
        );
        let err = uninformative_outcome(code, "AXPress", false).unwrap_err();
        assert_eq!(err.code, ErrorCode::ActionFailed);
        assert_eq!(err.delivery, Delivery::DeliveryUncertain);
    }
}

#[test]
fn perform_common_table() {
    let cases = [
        (
            AX_API_DISABLED,
            ErrorCode::PermDenied,
            Delivery::NotDelivered,
        ),
        (
            AX_INVALID_UI_ELEMENT,
            ErrorCode::StaleRef,
            Delivery::NotDelivered,
        ),
        (
            AX_CANNOT_COMPLETE,
            ErrorCode::AppUnresponsive,
            Delivery::DeliveryUncertain,
        ),
        (
            AX_ILLEGAL_ARGUMENT,
            ErrorCode::InvalidArgs,
            Delivery::NotDelivered,
        ),
        (
            AX_FAILURE,
            ErrorCode::ActionFailed,
            Delivery::DeliveryUncertain,
        ),
        (-1, ErrorCode::ActionFailed, Delivery::DeliveryUncertain),
    ];
    for (code, want, delivery) in cases {
        let PerformClass::Error(e) = classify_perform(code, "AXPress") else {
            panic!("code {code} should be an error");
        };
        assert_eq!(e.code, want, "code {code}");
        assert_eq!(e.delivery, delivery, "code {code}");
        assert_eq!(e.details, Some(json!({ "ax_error": code })));
    }
}

#[test]
fn set_is_decided_by_read_back() {
    for code in [AX_SUCCESS, AX_FAILURE, AX_CANNOT_COMPLETE] {
        assert_eq!(
            classify_set(code, ReadBack::Requested, "AXValue").unwrap(),
            StepOutcome::DeliveredVerified
        );
        assert_eq!(
            classify_set(code, ReadBack::Before, "AXValue").unwrap(),
            StepOutcome::DeliveredWithoutEffect
        );
    }
    assert_eq!(
        classify_set(AX_SUCCESS, ReadBack::Unreadable, "AXValue").unwrap(),
        StepOutcome::DeliveredUnverified
    );
    let e = classify_set(AX_INVALID_UI_ELEMENT, ReadBack::Unreadable, "AXValue").unwrap_err();
    assert_eq!(e.code, ErrorCode::StaleRef);
    let e = classify_set(AX_NOT_IMPLEMENTED, ReadBack::Other, "AXValue").unwrap_err();
    assert_eq!(e.code, ErrorCode::ActionFailed);
    assert_eq!(e.delivery, Delivery::DeliveryUncertain);
}

#[test]
fn coercion_follows_the_current_value_type() {
    assert_eq!(
        coerce(ValueKind::Number, " 42.5 ").unwrap(),
        Coerced::Number(42.5)
    );
    let e = coerce(ValueKind::Number, "abc").unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgs);
    assert!(!e.message.contains("abc"), "the input is never echoed");
    assert_eq!(
        coerce(ValueKind::Number, "NaN").unwrap_err().code,
        ErrorCode::InvalidArgs
    );
    assert_eq!(
        coerce(ValueKind::Boolean, "yes").unwrap(),
        Coerced::Boolean(true)
    );
    assert_eq!(
        coerce(ValueKind::Boolean, "Off").unwrap(),
        Coerced::Boolean(false)
    );
    assert_eq!(
        coerce(ValueKind::Text, "hi").unwrap(),
        Coerced::Text("hi".into())
    );
    assert!(truthy("1") && truthy("true") && !truthy("") && !truthy("0") && !truthy("FALSE"));
}

#[test]
fn coerced_read_back() {
    assert!(coerced_matches("slider", &Coerced::Number(5.0), "5"));
    assert!(coerced_matches(
        "textfield",
        &Coerced::Number(5.0),
        "5.0000001"
    ));
    assert!(coerced_matches("checkbox", &Coerced::Boolean(true), "1"));
    assert!(!coerced_matches("checkbox", &Coerced::Boolean(true), "0"));
    assert!(coerced_matches(
        "textarea",
        &Coerced::Text("a\nb".into()),
        "a\r\nb"
    ));
    let want = Coerced::Text("new".into());
    assert_eq!(
        value_readback("textfield", &want, Some("old"), Some("new")),
        ReadBack::Requested
    );
    assert_eq!(
        value_readback("textfield", &want, Some("old"), Some("old")),
        ReadBack::Before
    );
    assert_eq!(
        value_readback("textfield", &want, Some("old"), Some("x")),
        ReadBack::Other
    );
    assert_eq!(
        value_readback("textfield", &want, Some("old"), None),
        ReadBack::Unreadable
    );
}

#[test]
fn checked_values() {
    assert_eq!(checked_from_value(Some("0")), Some(false));
    assert_eq!(checked_from_value(Some("1")), Some(true));
    assert_eq!(checked_from_value(Some("2")), None);
    assert_eq!(checked_from_value(None), None);
}

fn web(children: usize) -> AXTreeNode {
    AXTreeNode {
        role: "AXWebArea".into(),
        children: vec![AXTreeNode::default(); children],
        ..Default::default()
    }
}

#[test]
fn renderer_mode_and_effect() {
    let win = |c| AXTreeNode {
        children: vec![c],
        ..Default::default()
    };
    assert_eq!(web_state(&AXTreeNode::default()), WebState::Absent);
    assert_eq!(web_state(&win(web(0))), WebState::Empty);
    assert_eq!(web_state(&win(web(2))), WebState::Populated);
    assert_eq!(choose_mode(true, WebState::Absent), Some(Mode::Manual));
    assert_eq!(choose_mode(false, WebState::Empty), Some(Mode::Enhanced));
    assert_eq!(choose_mode(false, WebState::Populated), None);
    assert_eq!(choose_mode(false, WebState::Absent), None);
    assert!(manual_took_effect(WebState::Empty, WebState::Populated));
    assert!(manual_took_effect(WebState::Absent, WebState::Empty));
    assert!(!manual_took_effect(WebState::Empty, WebState::Empty));
}

#[test]
fn snapshot_reports_a_pid() {
    if !crate::accessibility_granted() {
        return; // needs the Accessibility permission and a GUI session
    }
    let snap = runtime().block_on(MacOSAXTree.snapshot(SnapshotOptions::default()));
    match snap {
        Ok(s) => assert!(s.pid > 0),
        Err(e) => assert_eq!(e.code, ErrorCode::AppNotFound, "{e}"),
    }
}

#[test]
fn perform_on_an_exited_process_is_stale() {
    let Ok(mut child) = std::process::Command::new("/usr/bin/true").spawn() else {
        return;
    };
    let pid = i32::try_from(child.id()).expect("pid fits i32");
    let _ = child.wait();
    let locator = ElementLocator {
        pid,
        window: WindowTarget::Pid { pid },
        path: vec![0],
        identity: ElementIdentity {
            role_key: "button".into(),
            name: Some("OK".into()),
            ..Default::default()
        },
    };
    let opts = ActionOptions {
        deadline: Duration::from_secs(2),
        ..Default::default()
    };
    let err = runtime()
        .block_on(MacOSAXTree.perform(&locator, &ElementAction::Press, &opts))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(err.delivery, Delivery::NotDelivered);
}
