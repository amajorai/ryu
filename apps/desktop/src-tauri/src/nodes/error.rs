//! The failure shape the node-list commands hand to the webview.
//!
//! Same contract as `fs_command_error.rs` and `update_error.rs`: the native
//! layer never words a user-facing sentence. `add_node`, `update_node_token`,
//! `remove_node` and `set_default_node` reject with a stable
//! [`NodeCommandErrorCode`], the node `name` in `values` for the sentence's
//! placeholder, and the raw save error in `detail`, which is logged, never
//! shown. The webview maps each code to one whole translated sentence
//! (`apps/desktop/src/lib/node-command-error.ts`). Codes are wire names
//! (`snake_case`), so renaming a variant is a breaking change there.

use serde::Serialize;

/// Why a node-list command failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeCommandErrorCode {
    /// The name is empty or has characters other than letters, digits and hyphens.
    InvalidName,
    /// A node with this name is already saved.
    DuplicateName,
    /// No saved node has this name.
    NotFound,
    /// The built-in local node cannot be removed.
    LocalNode,
    /// `nodes.json` could not be written (see `detail`).
    SaveFailed,
}

/// The values a sentence may interpolate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeCommandErrorValues {
    pub name: String,
}

/// A coded failure: `{ "code": "...", "values": { "name": "..." }, "detail"?: "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeCommandError {
    pub code: NodeCommandErrorCode,
    pub values: NodeCommandErrorValues,
    /// The raw technical cause, never a sentence meant for the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl NodeCommandError {
    pub fn new(code: NodeCommandErrorCode, name: impl Into<String>) -> Self {
        Self {
            code,
            values: NodeCommandErrorValues { name: name.into() },
            detail: None,
        }
    }

    /// A failed `nodes.json` write; the cause stays in `detail`.
    pub fn save_failed(name: impl Into<String>, error: impl ToString) -> Self {
        Self {
            detail: Some(error.to_string()),
            ..Self::new(NodeCommandErrorCode::SaveFailed, name)
        }
    }
}

/// The rule `add_node` enforces (and both Add-node dialogs pre-check): a
/// non-empty run of letters, digits and hyphens.
pub fn is_valid_node_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '-')
}

impl std::fmt::Display for NodeCommandError {
    /// Log form only; the webview words the user-facing sentence.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = serde_json::to_value(self.code).unwrap_or_default();
        write!(
            f,
            "{} ({})",
            code.as_str().unwrap_or("unknown"),
            self.values.name
        )?;
        if let Some(detail) = &self.detail {
            write!(f, ": {detail}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_serialize_to_a_code_and_values_never_a_sentence() {
        assert_eq!(
            serde_json::to_value(NodeCommandError::new(
                NodeCommandErrorCode::DuplicateName,
                "laptop"
            ))
            .unwrap(),
            json!({ "code": "duplicate_name", "values": { "name": "laptop" } })
        );
        let failed = NodeCommandError::save_failed("laptop", "disk full");
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            json!({
                "code": "save_failed",
                "values": { "name": "laptop" },
                "detail": "disk full"
            })
        );
        assert_eq!(failed.to_string(), "save_failed (laptop): disk full");
    }

    #[test]
    fn every_code_has_a_snake_case_wire_name() {
        use NodeCommandErrorCode::*;
        for (code, wire) in [
            (InvalidName, "invalid_name"),
            (DuplicateName, "duplicate_name"),
            (NotFound, "not_found"),
            (LocalNode, "local_node"),
            (SaveFailed, "save_failed"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
    }

    #[test]
    fn node_names_are_letters_digits_and_hyphens() {
        for valid in ["laptop", "mesh-box-2", "Kanäle", "東京"] {
            assert!(is_valid_node_name(valid), "{valid}");
        }
        for invalid in ["", "My Laptop", "a_b", "a.b", "a/b"] {
            assert!(!is_valid_node_name(invalid), "{invalid}");
        }
    }
}
