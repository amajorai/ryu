//! The per-call gate (design §2.4), as a pure decision over facts the caller
//! gathered. It fails closed and puts the user first: admin caps only
//! restrict, the risk floor is never overridden, and the effective decision is
//! `min(admin cap, user choice / approval mode, risk floor)`.

use crate::approvals::policy::ApprovalMode;

use super::catalog::{never_persistable, CatalogTool, VerbClass};
use super::codes::DeviceErrorCode;

/// A per-caller admin cap for one app group (P5). Caps only restrict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdminCap {
    /// No cap (a personal unbound node).
    None,
    Never,
    /// Ask every time: Always allow is never offered and grants are ignored.
    Ask,
    /// The user *may* choose Always allow; never skips the user's own checks.
    /// Served by the per-caller resolver (`caps_resolver`).
    Always,
}

/// Everything the gate decides on, all keyed by the canonical id.
pub(crate) struct GateFacts<'a> {
    pub(crate) tool: &'a CatalogTool,
    pub(crate) cap: AdminCap,
    pub(crate) org_denial: Option<String>,
    pub(crate) approval_mode: ApprovalMode,
    /// A `device_grants` row for this principal, device and canonical tool.
    pub(crate) has_device_grant: bool,
    /// The call targets a phone other than the turn's origin.
    pub(crate) cross_device: bool,
    /// `device.location.current` with `accuracy: precise`.
    pub(crate) precise_location: bool,
    /// The turn already holds untrusted external content, or was resumed.
    pub(crate) tainted_input: bool,
    /// An hourly quota is exceeded: ask again; Always allow cannot satisfy it.
    pub(crate) over_quota: bool,
    /// The effective policy lets the user persist a grant.
    pub(crate) persistence_allowed: bool,
    /// For a tool that can be security class (`device.home.set`): Core's
    /// signed accessory cache says this accessory is a lock, door, window,
    /// garage door or alarm, or does not know it (see `home::classify`).
    pub(crate) home_security_class: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GateDecision {
    Run,
    Ask {
        allow_always: bool,
        /// The answer must come signed from the target phone after biometrics.
        on_device: bool,
    },
    Refuse(DeviceErrorCode),
}

pub(crate) fn decide(facts: &GateFacts<'_>) -> GateDecision {
    if facts.cap == AdminCap::Never {
        return GateDecision::Refuse(DeviceErrorCode::AdminBlocked);
    }
    if facts.org_denial.is_some() {
        return GateDecision::Refuse(DeviceErrorCode::AdminBlocked);
    }
    // Home security actions need on-device biometric confirmation; every
    // `home.set` is asked and never persistable (design §3.2).
    let on_device = facts.tool.security_class_possible && facts.home_security_class;
    let floor_asks = never_persistable(facts.tool)
        || on_device
        || facts.cross_device
        || facts.precise_location
        || facts.tainted_input
        || facts.over_quota;
    let allow_always = facts.persistence_allowed
        && facts.cap != AdminCap::Ask
        && !never_persistable(facts.tool)
        && !on_device
        && !facts.over_quota
        && !facts.cross_device;
    if floor_asks {
        return GateDecision::Ask {
            allow_always,
            on_device,
        };
    }
    // `off` and `smart` both run a device tool only on a per-tool grant
    // (the first call per device and tool asks, reads included); `manual`
    // asks every time. A cap of `ask` ignores grants.
    let grant_counts = facts.has_device_grant && facts.cap != AdminCap::Ask;
    let runs = match facts.approval_mode {
        ApprovalMode::Manual => false,
        ApprovalMode::Off | ApprovalMode::Smart => grant_counts,
    };
    if runs {
        GateDecision::Run
    } else {
        GateDecision::Ask {
            allow_always,
            on_device: false,
        }
    }
}

/// Whether a read succeeded on this tool (marks the turn private).
pub(crate) fn is_read(tool: &CatalogTool) -> bool {
    tool.verb == VerbClass::Read
}
