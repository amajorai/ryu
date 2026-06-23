//! The sandbox-to-Core tool bridge.
//!
//! When sandboxed JS calls `await tools.<server>.<tool>(args)`, the Deno host
//! relays that request over **stdio** (never the network — the sandbox has no
//! net/FS permission) to Core, which routes it through the same
//! [`McpRegistry::call_tool`] path and the same **resolved agent allowlist** the
//! chat tool loop uses. No escalation: a tool the agent may not call in chat it
//! may not call from a program.
//!
//! Dispatch convention (Contract 4 / scope-review HIGH #1/#8): with the
//! Deno-first default the invoker is `Send`, so heterogeneous invokers are a
//! closed enum match-dispatched exactly like `catalog_source::Source` — **no
//! `async-trait`, no `dyn`**. A `Mock` variant lets the security-critical logic
//! (allowlist rejection, `__ryu_elicitation__` → `Suspend`, `agent_id`
//! rejection) be tested without a live registry or subprocess.

use serde_json::Value;
use std::sync::Arc;

use crate::sidecar::mcp::McpRegistry;

use super::{Elicitation, InvokeOutcome, ToolInvocation, ToolInvokeResult};

/// Map a JS tool path (`<server>.<tool>` / `<server>.<a>.<b>`) to the registry
/// id `<server>__<tool>`: first dot segment = server, the remainder (re-joined
/// on `.`) = tool name (Contract 4). Composio actions arrive as
/// `composio.<SLUG>` → `composio__<SLUG>`, matching the built-in id form.
///
/// A path with no dot is treated as already-qualified (returned as-is) so a
/// caller that hands us a literal `spider__crawl` still works.
pub fn tool_path_to_id(path: &str) -> String {
    match path.split_once('.') {
        Some((server, rest)) => format!("{server}__{rest}"),
        None => path.to_owned(),
    }
}

/// Detect the P1 `__ryu_elicitation__` envelope (B-7) in a tool result and
/// decode it into a typed [`Elicitation`]. Returns `None` for normal results.
///
/// The envelope is produced by `mcp::composio::dispatch` when a Composio action
/// needs a connected account; the invoker pauses the whole program on it so the
/// user can complete the connect/consent step, then `resume`s.
pub fn detect_elicitation(value: &Value) -> Option<Elicitation> {
    let inner = value.get("__ryu_elicitation__")?;
    Some(Elicitation {
        kind: inner
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("url")
            .to_owned(),
        message: inner
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("This action requires an additional step.")
            .to_owned(),
        url: inner.get("url").and_then(Value::as_str).map(str::to_owned),
        requested_schema: inner.get("requested_schema").cloned(),
    })
}

/// The invokers a running program can be wired to. Closed enum, match-dispatched.
pub enum SandboxToolInvoker {
    /// Production: route through the MCP registry with the agent's resolved
    /// allowlist (fail-closed: `agent_id` must be `Some` and known).
    Registry(RegistryToolInvoker),
    /// Test-only: a canned responder. Built via [`SandboxToolInvoker::mock`].
    #[cfg(test)]
    Mock(MockInvoker),
}

impl SandboxToolInvoker {
    /// Construct the production registry invoker.
    pub fn registry(
        registry: Arc<McpRegistry>,
        agent_id: String,
        allowlist: Option<Vec<String>>,
        user_id: Option<String>,
    ) -> Self {
        Self::registry_with_identity(registry, agent_id, allowlist, user_id, Vec::new())
    }

    /// Construct the production registry invoker carrying the agent's bound
    /// Identity Vault profiles (epic #517). A program's tool call targeting a
    /// NEEDS_AUTH bound domain suspends (the elicitation envelope → `Suspend`); an
    /// AUTHENTICATED one reads the credential under the gateway grant. Empty
    /// `identity_profile_ids` = no vault consult (the common case).
    pub fn registry_with_identity(
        registry: Arc<McpRegistry>,
        agent_id: String,
        allowlist: Option<Vec<String>>,
        user_id: Option<String>,
        identity_profile_ids: Vec<String>,
    ) -> Self {
        // `agent_id` is retained only for audit attribution / debugging; the
        // gate that matters is `allowlist`, which travels unchanged into
        // `call_tool_with_identity` (no escalation).
        let _ = agent_id;
        SandboxToolInvoker::Registry(RegistryToolInvoker {
            registry,
            allowlist,
            user_id,
            identity_profile_ids,
        })
    }

    /// Invoke a single tool call from the sandbox. Errors from the registry are
    /// surfaced as a `ToolInvokeResult` with `is_error = true` (the program can
    /// catch them) rather than aborting the whole execution.
    pub async fn invoke(&self, call: ToolInvocation) -> InvokeOutcome {
        match self {
            SandboxToolInvoker::Registry(inner) => inner.invoke(call).await,
            #[cfg(test)]
            SandboxToolInvoker::Mock(inner) => inner.invoke(call),
        }
    }

    #[cfg(test)]
    pub fn mock(responder: MockResponder) -> Self {
        SandboxToolInvoker::Mock(MockInvoker { responder })
    }
}

/// Production invoker: closes over the registry + the resolved agent allowlist.
pub struct RegistryToolInvoker {
    registry: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    user_id: Option<String>,
    /// Agent's bound Identity Vault profiles (epic #517). Empty = no vault consult.
    identity_profile_ids: Vec<String>,
}

impl RegistryToolInvoker {
    async fn invoke(&self, call: ToolInvocation) -> InvokeOutcome {
        let tool_id = tool_path_to_id(&call.path);
        match self
            .registry
            .call_tool_with_identity(
                &tool_id,
                call.args,
                self.allowlist.as_deref(),
                self.user_id.as_deref(),
                &self.identity_profile_ids,
                None,
            )
            .await
        {
            Ok(value) => {
                // A Composio connect/consent step surfaces as the elicitation
                // envelope — pause the whole program on it.
                if let Some(elicit) = detect_elicitation(&value) {
                    return InvokeOutcome::Suspend(elicit);
                }
                InvokeOutcome::Result(ToolInvokeResult {
                    value,
                    is_error: false,
                    error: None,
                })
            }
            Err(e) => InvokeOutcome::Result(ToolInvokeResult {
                value: Value::Null,
                is_error: true,
                error: Some(e.to_string()),
            }),
        }
    }
}

#[cfg(test)]
pub type MockResponder = Box<dyn Fn(&ToolInvocation) -> InvokeOutcome + Send + Sync>;

#[cfg(test)]
pub struct MockInvoker {
    responder: MockResponder,
}

#[cfg(test)]
impl MockInvoker {
    fn invoke(&self, call: ToolInvocation) -> InvokeOutcome {
        (self.responder)(&call)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn path_first_segment_is_server() {
        assert_eq!(tool_path_to_id("spider.crawl"), "spider__crawl");
        assert_eq!(
            tool_path_to_id("composio.GITHUB_CREATE_ISSUE"),
            "composio__GITHUB_CREATE_ISSUE"
        );
        // Already-qualified passthrough.
        assert_eq!(tool_path_to_id("spider__crawl"), "spider__crawl");
        // No dot at all → returned verbatim.
        assert_eq!(tool_path_to_id("ping"), "ping");
    }

    #[test]
    fn path_with_dotted_tool_name_keeps_remainder() {
        // First dot is the server split; the rest re-joins on `__`'s source `.`.
        assert_eq!(tool_path_to_id("server.group.tool"), "server__group.tool");
    }

    #[test]
    fn elicitation_envelope_decodes() {
        let v = json!({
            "__ryu_elicitation__": {
                "kind": "url",
                "message": "Connect your GitHub account",
                "url": "https://composio.dev/connect/abc"
            }
        });
        let e = detect_elicitation(&v).expect("should detect");
        assert_eq!(e.kind, "url");
        assert_eq!(e.message, "Connect your GitHub account");
        assert_eq!(e.url.as_deref(), Some("https://composio.dev/connect/abc"));
        assert!(e.requested_schema.is_none());
    }

    #[test]
    fn normal_result_is_not_elicitation() {
        assert!(detect_elicitation(&json!({ "ok": true, "data": [1, 2, 3] })).is_none());
        assert!(detect_elicitation(&json!("just a string")).is_none());
    }

    #[tokio::test]
    async fn mock_invoker_returns_suspend_on_elicitation() {
        let invoker = SandboxToolInvoker::mock(Box::new(|_call| {
            InvokeOutcome::Suspend(Elicitation {
                kind: "url".into(),
                message: "connect".into(),
                url: Some("https://x".into()),
                requested_schema: None,
            })
        }));
        let out = invoker
            .invoke(ToolInvocation {
                path: "composio.GITHUB_X".into(),
                args: json!({}),
            })
            .await;
        assert!(matches!(out, InvokeOutcome::Suspend(_)));
    }

    #[tokio::test]
    async fn mock_invoker_returns_result() {
        let invoker = SandboxToolInvoker::mock(Box::new(|call| {
            InvokeOutcome::Result(ToolInvokeResult {
                value: json!({ "echoed": call.path.clone() }),
                is_error: false,
                error: None,
            })
        }));
        let out = invoker
            .invoke(ToolInvocation {
                path: "spider.crawl".into(),
                args: json!({ "url": "https://example.com" }),
            })
            .await;
        match out {
            InvokeOutcome::Result(r) => {
                assert!(!r.is_error);
                assert_eq!(r.value["echoed"], "spider.crawl");
            }
            InvokeOutcome::Suspend(_) => panic!("expected result"),
        }
    }
}
