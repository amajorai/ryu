//! Element identity and locators: what a ref stores to find an element again.

use serde::{Deserialize, Serialize};

use super::{roles, verify, AXTreeNode, Bounds, WindowTarget};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ElementIdentity {
    /// `AXTreeNode::stable_role()`.
    pub role_key: String,
    pub native_id: Option<String>,
    pub identifier: Option<String>,
    /// `None` for mutable-value roles when name == value (numeric-aware).
    pub name: Option<String>,
    /// Tie-break only.
    pub bounds: Option<Bounds>,
}

fn non_empty(s: Option<&str>) -> Option<String> {
    s.filter(|v| !v.is_empty()).map(str::to_string)
}

impl ElementIdentity {
    pub fn from_node(node: &AXTreeNode) -> Self {
        let value = if node.secure {
            None
        } else {
            node.value.as_deref()
        };
        Self::from_parts(
            &node.stable_role(),
            node.title.as_deref(),
            value,
            node.identifier.as_deref(),
            node.native_id.as_deref(),
            node.bounds.clone(),
        )
    }

    pub fn from_parts(
        role_key: &str,
        name: Option<&str>,
        value: Option<&str>,
        identifier: Option<&str>,
        native_id: Option<&str>,
        bounds: Option<Bounds>,
    ) -> Self {
        let mut name = non_empty(name);
        // A mutable-value element whose name mirrors its value (sliders, some text
        // fields) would stop matching once the value changes: drop the name.
        if roles::is_mutable_value_role(role_key) {
            if let (Some(n), Some(v)) = (name.as_deref(), value) {
                if verify::value_matches(role_key, n, v) || n == v {
                    name = None;
                }
            }
        }
        Self {
            role_key: role_key.to_string(),
            native_id: non_empty(native_id),
            identifier: non_empty(identifier),
            name,
            bounds,
        }
    }

    /// No `native_id`, `identifier` or `name`.
    pub fn is_anonymous(&self) -> bool {
        self.native_id.is_none() && self.identifier.is_none() && self.name.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElementLocator {
    /// >0 => STALE_REF on mismatch; 0 => focused window, no pid check (reported).
    pub pid: i32,
    pub window: WindowTarget,
    /// Child indices from the window root, in walker order.
    pub path: Vec<u32>,
    pub identity: ElementIdentity,
}
