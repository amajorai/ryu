use crate::approvals::policy::ApprovalMode;

use super::catalog::catalog;
use super::codes::DeviceErrorCode;
use super::gate::{decide, AdminCap, GateDecision, GateFacts};

fn facts(tool: &str) -> GateFacts<'static> {
    GateFacts {
        tool: catalog().tool(tool).unwrap(),
        cap: AdminCap::None,
        org_denial: None,
        approval_mode: ApprovalMode::Smart,
        has_device_grant: false,
        cross_device: false,
        precise_location: false,
        tainted_input: false,
        over_quota: false,
        persistence_allowed: true,
        home_security_class: true,
    }
}

const ASK_ALWAYS: GateDecision = GateDecision::Ask {
    allow_always: true,
    on_device: false,
};
const ASK_ONCE: GateDecision = GateDecision::Ask {
    allow_always: false,
    on_device: false,
};

#[test]
fn first_call_asks_even_for_reads_and_a_grant_then_runs() {
    assert_eq!(decide(&facts("device.calendar.search")), ASK_ALWAYS);
    for mode in [ApprovalMode::Off, ApprovalMode::Smart] {
        let granted = GateFacts {
            has_device_grant: true,
            approval_mode: mode,
            ..facts("device.calendar.create")
        };
        assert_eq!(decide(&granted), GateDecision::Run);
    }
    let manual = GateFacts {
        has_device_grant: true,
        approval_mode: ApprovalMode::Manual,
        ..facts("device.calendar.search")
    };
    assert_eq!(decide(&manual), ASK_ALWAYS);
}

#[test]
fn admin_caps_only_restrict() {
    let never = GateFacts {
        cap: AdminCap::Never,
        ..facts("device.calendar.search")
    };
    assert_eq!(
        decide(&never),
        GateDecision::Refuse(DeviceErrorCode::AdminBlocked)
    );
    let always = GateFacts {
        cap: AdminCap::Always,
        ..facts("device.calendar.search")
    };
    assert_eq!(
        decide(&always),
        ASK_ALWAYS,
        "admin always never skips the user's ask"
    );
    let ask = GateFacts {
        cap: AdminCap::Ask,
        has_device_grant: true,
        ..facts("device.calendar.search")
    };
    assert_eq!(
        decide(&ask),
        ASK_ONCE,
        "cap ask ignores grants and hides Always allow"
    );
    let org = GateFacts {
        org_denial: Some("blocked".into()),
        ..facts("device.calendar.search")
    };
    assert_eq!(
        decide(&org),
        GateDecision::Refuse(DeviceErrorCode::AdminBlocked)
    );
}

#[test]
fn the_risk_floor_always_asks() {
    let delete = GateFacts {
        has_device_grant: true,
        approval_mode: ApprovalMode::Off,
        ..facts("device.calendar.delete")
    };
    assert_eq!(
        decide(&delete),
        ASK_ONCE,
        "deletes are asked every time and never persistable"
    );
    let home = GateFacts {
        has_device_grant: true,
        ..facts("device.home.set")
    };
    assert_eq!(
        decide(&home),
        GateDecision::Ask {
            allow_always: false,
            on_device: true
        }
    );
    let lamp = GateFacts {
        home_security_class: false,
        has_device_grant: true,
        ..facts("device.home.set")
    };
    assert_eq!(
        decide(&lamp),
        ASK_ONCE,
        "a lamp is still asked every time, but any surface may answer"
    );
    let not_home = GateFacts {
        home_security_class: true,
        ..facts("device.calendar.create")
    };
    assert_eq!(
        decide(&not_home),
        ASK_ALWAYS,
        "only security-class-capable tools go on-device"
    );
    for floor in [
        GateFacts {
            tainted_input: true,
            has_device_grant: true,
            ..facts("device.calendar.search")
        },
        GateFacts {
            precise_location: true,
            has_device_grant: true,
            ..facts("device.location.current")
        },
    ] {
        assert!(matches!(decide(&floor), GateDecision::Ask { .. }));
    }
    let cross = GateFacts {
        cross_device: true,
        has_device_grant: true,
        ..facts("device.calendar.search")
    };
    assert_eq!(decide(&cross), ASK_ONCE);
    let quota = GateFacts {
        over_quota: true,
        has_device_grant: true,
        ..facts("device.contacts.search")
    };
    assert_eq!(
        decide(&quota),
        ASK_ONCE,
        "Always allow cannot satisfy a quota"
    );
}
