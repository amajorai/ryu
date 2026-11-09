//! Per-caller admin caps for phone apps (design §2.4 step 4, §2.5; P5).
//!
//! The control plane serves `deviceToolCaps` (`{ "<app>": "never" | "ask" |
//! "always" }`) inside the caller's effective rules from
//! `/gateway/tool-policy` (see `caps_resolver`). Caps only restrict:
//!
//! - `never`: the app's tools are never offered; a call anyway is `admin_blocked`;
//! - `ask`: every call asks; Always allow is never offered and grants are ignored;
//! - `always`: the user *may* choose Always allow; it never skips the user's checks.
//!
//! The control plane merges the org, team and member layers
//! most-restrictive-wins (`never > ask > always`) before serving them. A value
//! Core does not understand is `never` (fail closed).

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::catalog::catalog;
use super::gate::AdminCap;

fn parse_cap(value: &Value) -> AdminCap {
    match value.as_str().map(str::trim) {
        Some("always") => AdminCap::Always,
        Some("ask") => AdminCap::Ask,
        _ => AdminCap::Never,
    }
}

fn cap_name(cap: AdminCap) -> Option<&'static str> {
    match cap {
        AdminCap::None => None,
        AdminCap::Always => Some("always"),
        AdminCap::Ask => Some("ask"),
        AdminCap::Never => Some("never"),
    }
}

/// The caps in force for one caller.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DeviceToolCaps {
    /// Every app is `never` (the caller's rules are unavailable or refused).
    all_never: bool,
    per_app: BTreeMap<String, AdminCap>,
}

impl DeviceToolCaps {
    /// No caps (a personal unbound node, or an org that set none).
    pub(crate) fn none() -> Self {
        Self::default()
    }

    /// Fail closed: every app is `never`.
    pub(crate) fn never() -> Self {
        Self {
            all_never: true,
            per_app: BTreeMap::new(),
        }
    }

    /// Parse the wire `deviceToolCaps` value. Absent or `null` is no caps;
    /// anything that is not an object of known values fails closed.
    pub(crate) fn from_wire(value: Option<&Value>) -> Self {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Self::none();
        };
        let Some(entries) = value.as_object() else {
            return Self::never();
        };
        let mut per_app = BTreeMap::new();
        for (app, cap) in entries {
            // Unknown app ids have no tools in this Core; nothing to cap.
            if catalog().app(app).is_some() {
                per_app.insert(app.clone(), parse_cap(cap));
            }
        }
        Self {
            all_never: false,
            per_app,
        }
    }

    /// The cap for one app group.
    pub(crate) fn cap_for(&self, app: &str) -> AdminCap {
        if self.all_never {
            return AdminCap::Never;
        }
        self.per_app.get(app).copied().unwrap_or(AdminCap::None)
    }

    /// The `caps` field of `GET /api/device-tools/catalog`: `"never"` or
    /// `{ "<app>": "never" | "ask" | "always" }` (apps without a cap omitted).
    pub(crate) fn to_json(&self) -> Value {
        if self.all_never {
            return json!("never");
        }
        let entries: serde_json::Map<String, Value> = self
            .per_app
            .iter()
            .filter_map(|(app, cap)| cap_name(*cap).map(|name| (app.clone(), json!(name))))
            .collect();
        Value::Object(entries)
    }
}
