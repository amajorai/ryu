//! Tools that hand back the value of a stored credential, and the list of the
//! ones the node's owner allowed.
//!
//! A manifest marks such a tool with `"returns_credential": true` in its tool
//! config. A marked tool is refused, on every node and on every tool plane,
//! until its exact id is named in the node preference
//! [`CREDENTIAL_TOOLS_ALLOWED_PREF_KEY`]. There is no approval in between: a
//! held call would put the secret on the approval record, where it is not kept
//! today, and would not hand it to the turn that asked.
//!
//! The refusal sits in the dispatch core beside the node-user rule, so a
//! workflow, a routine or an approved replay gets the same answer as a turn.

use crate::sidecar::mcp::*;

/// The node preference that names the allowed tools: a JSON array of exact
/// tool ids, for example `["bitwarden.get","bitwarden.list"]`. A value that
/// does not parse allows nothing.
pub(crate) const CREDENTIAL_TOOLS_ALLOWED_PREF_KEY: &str = "credential-tools-allowed";

/// The words every refusal of this rule carries.
pub(crate) const CREDENTIAL_TOOL_REFUSAL: &str = "returns the value of a stored credential";

static ALLOWED: RwLock<Vec<String>> = RwLock::new(Vec::new());

#[cfg(test)]
tokio::task_local! {
    /// A per-task allow list, so a test never changes the list that
    /// concurrently running tests read.
    static TEST_ALLOWED: Vec<String>;
}

/// Run `future` with `allowed` as the node's allow list.
#[cfg(test)]
pub(crate) async fn with_test_credential_tools_allowed<F: std::future::Future>(
    allowed: Vec<String>,
    future: F,
) -> F::Output {
    TEST_ALLOWED.scope(allowed, future).await
}

/// The tool ids a preference value names. Anything but a JSON array of strings
/// names none.
pub(in crate::sidecar::mcp) fn parse_allowed(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value)
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect()
}

/// Load the allow list from the preference value (startup and on change).
pub(crate) fn set_credential_tools_allowed_from_pref(value: &str) {
    let parsed = parse_allowed(value);
    match ALLOWED.write() {
        Ok(mut allowed) => *allowed = parsed,
        Err(poisoned) => *poisoned.into_inner() = parsed,
    }
}

fn is_allowed(tool_id: &str) -> bool {
    #[cfg(test)]
    if let Ok(found) = TEST_ALLOWED.try_with(|allowed| allowed.iter().any(|id| id == tool_id)) {
        return found;
    }
    ALLOWED
        .read()
        .is_ok_and(|allowed| allowed.iter().any(|id| id == tool_id))
}

impl McpRegistry {
    /// Whether the manifest of the app tool that runs for `tool_id` marks it as
    /// returning a stored credential's value.
    async fn tool_returns_credential(&self, tool_id: &str) -> bool {
        self.app_tool_serves_call(tool_id).await
            && self
                .resolve_app_tool_backend(tool_id)
                .await
                .is_some_and(|resolved| resolved.returns_credential)
    }

    /// Refuse a tool that returns a stored credential's value unless the
    /// node's owner allowed it by name.
    pub(in crate::sidecar::mcp) async fn enforce_credential_tool_allowed(
        &self,
        tool_id: &str,
    ) -> Result<()> {
        if is_allowed(tool_id) {
            return Ok(());
        }
        if !self.tool_returns_credential(tool_id).await {
            return Ok(());
        }
        bail!(
            "tool '{tool_id}' {CREDENTIAL_TOOL_REFUSAL} and is not allowed on this node. The node's owner allows it by adding its exact id to the setting {CREDENTIAL_TOOLS_ALLOWED_PREF_KEY}"
        );
    }
}

#[cfg(test)]
#[path = "../tests/credential_tools.rs"]
mod tests;
