//! Accessibility tree node types shared by every backend.
//!
//! New fields are additive on the wire and carry serde defaults, so snapshots
//! sealed before they existed still deserialize.

use serde::{Deserialize, Serialize};

use super::roles;

fn default_true() -> bool {
    true
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// Accessibility tree node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AXTreeNode {
    /// Native role string (Windows: localized; kept for compatibility).
    pub role: String,
    pub title: Option<String>,
    /// Always `None` when `secure` (serializes as `null`).
    pub value: Option<String>,
    /// AXIdentifier / AutomationId / accessible_id.
    pub identifier: Option<String>,
    pub bounds: Option<Bounds>,
    pub children: Vec<AXTreeNode>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub hidden: bool,
    /// macOS AXSubrole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    /// Canonical role key (see `roles.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_key: Option<String>,
    /// macOS AXDOMIdentifier, Linux `"bus:path"`, Windows `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub subtree_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub states: Option<ElementState>,
}

impl Default for AXTreeNode {
    fn default() -> Self {
        Self {
            role: String::new(),
            title: None,
            value: None,
            identifier: None,
            bounds: None,
            children: Vec::new(),
            enabled: true,
            focused: false,
            hidden: false,
            subrole: None,
            role_key: None,
            native_id: None,
            secure: false,
            subtree_truncated: false,
            states: None,
        }
    }
}

impl AXTreeNode {
    /// Drops every value of a secure node (`value` and `states.value`). Every
    /// walker calls it before returning a node.
    pub fn redact(&mut self) {
        if !self.secure {
            return;
        }
        self.value = None;
        if let Some(states) = self.states.as_mut() {
            states.value = None;
            states.secure = true;
        }
    }

    /// The canonical role: `role_key`, else the legacy role normalized.
    pub fn stable_role(&self) -> String {
        match self.role_key.as_deref() {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => roles::normalize_legacy_role(&self.role),
        }
    }
}

/// Read-back state primitives of one element.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ElementState {
    /// `None` = unknown or mixed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    /// `None` when secure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub secure: bool,
}

/// Screen rectangle of an element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
