//! The sandbox-to-Core tool bridge.
//!
//! When sandboxed JS calls `await tools.<server>.<tool>(args)`, the sandbox host
//! relays that request through its `ryu` import (never the network — the
//! WebAssembly guest has no net/FS) to Core, which routes it through the same
//! [`McpRegistry::call_tool`] path and the same **resolved agent allowlist** the
//! chat tool loop uses. No escalation: a tool the agent may not call in chat it
//! may not call from a program.
//!
//! Dispatch convention (Contract 4 / scope-review HIGH #1/#8): the invoker is
//! `Send`, so heterogeneous invokers are a
//! closed enum match-dispatched exactly like `catalog_source::Source` — **no
//! `async-trait`, no `dyn`**. A `Mock` variant lets the security-critical logic
//! (allowlist rejection, `__ryu_elicitation__` → `Suspend`, `agent_id`
//! rejection) be tested without a live registry or subprocess.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use super::{Elicitation, InvokeOutcome, ToolInvocation, ToolInvokeResult};

/// The narrow host-registry seam: the one method the production invoker needs
/// from Core's MCP registry (`McpRegistry::call_tool_with_identity`). Core
/// implements this for `McpRegistry` in its host shim, so this crate stays free
/// of any `apps/core` dependency — the `tool_registry`/`ToolEmbedder` precedent.
/// `agent_id` names the CALLING agent so the host's approval policy can apply
/// the agent's configured per-tool approval list (Layer A); `None` skips it.
/// `data_flow` is the run's [`RunDataFlow`]: the host records private-data reads
/// on it and holds later egress-capable calls in the same run for approval.
#[async_trait]
pub trait ToolCaller: Send + Sync {
    /// Route one tool call through the host registry under the agent's resolved
    /// allowlist + Identity-Vault binding. `Err(String)` is surfaced to the
    /// program as a catchable tool error (never aborts the whole execution).
    #[allow(clippy::too_many_arguments)]
    async fn call_tool_with_identity(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
        data_flow: &Arc<RunDataFlow>,
    ) -> Result<Value, String>;
}

/// What one program run has done with private data, shared by every tool call
/// the run makes (the lethal-trifecta guard's per-run state).
///
/// The crate never classifies tools: the host decides which calls read private
/// data and marks the run, and the host holds a later egress-capable call in the
/// same run for human approval. The state lives on the run's
/// [`RegistryToolInvoker`], so it is never global, it travels with a parked
/// execution through pause and resume, and a new run starts clean. The first
/// source is kept so the hold can name it. `OnceLock` makes concurrent calls from
/// one run (a `Promise.all` fan-out) safe without a lock.
#[derive(Debug, Default)]
pub struct RunDataFlow {
    private_source: std::sync::OnceLock<String>,
}

impl RunDataFlow {
    /// Record that this run read private data through `tool_id`. Only the first
    /// source is kept; later reads change nothing.
    pub fn mark_private_read(&self, tool_id: &str) {
        let _ = self.private_source.set(tool_id.to_owned());
    }

    /// The tool through which this run first read private data, if it has.
    pub fn private_read_source(&self) -> Option<&str> {
        self.private_source.get().map(String::as_str)
    }
}

/// Keep a JS tool path (`<server>.<tool>` / `<server>.<a>.<b>`) in the registry's
/// canonical dotted id form. The first dot still names the server and the rest
/// is the tool name (Contract 4); preserving the path avoids minting the legacy
/// double-underscore spelling at this boundary.
///
/// A path with no dot is treated as already-qualified (returned as-is) so a
/// caller that hands us a legacy literal `spider__crawl` still reaches Core's
/// single compatibility ingress and remains callable.
pub fn tool_path_to_id(path: &str) -> String {
    path.to_owned()
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

/// A generic host-callback bridge so the same sandbox substrate can be reused
/// for **non-tool** host capabilities (the plugin turn-hook runtime calls
/// `host.sideModel` / `host.storage_*` instead of `tools.*`). This is a cold
/// path (per-turn, not per-token), so a `dyn` + boxed future is acceptable here
/// — it keeps all plugin-specific logic out of `tool_exec` and in
/// Core's `plugin_host`, which implements this trait.
pub trait SandboxBridge: Send + Sync {
    /// Handle one `<server>.<method>(args)` call the sandbox made.
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = InvokeOutcome> + Send + '_>>;
}

/// The invokers a running program can be wired to. Closed enum, match-dispatched.
pub enum SandboxToolInvoker {
    /// Production: route through the MCP registry with the agent's resolved
    /// allowlist (fail-closed: `agent_id` must be `Some` and known).
    Registry(RegistryToolInvoker),
    /// A caller-supplied host bridge (plugin host capabilities), not the MCP
    /// registry. Used by the plugin turn-hook runtime.
    Bridge(Arc<dyn SandboxBridge>),
    /// Test-only: a canned responder. Built via [`SandboxToolInvoker::mock`].
    #[cfg(test)]
    Mock(MockInvoker),
}

impl SandboxToolInvoker {
    /// Construct the production registry invoker.
    pub fn registry(
        caller: Arc<dyn ToolCaller>,
        agent_id: String,
        allowlist: Option<Vec<String>>,
        user_id: Option<String>,
    ) -> Self {
        Self::registry_with_identity_and_conversation(
            caller,
            agent_id,
            allowlist,
            user_id,
            Vec::new(),
            None,
        )
    }

    /// Construct the production registry invoker carrying the agent's bound
    /// Identity Vault profiles (epic #517). A program's tool call targeting a
    /// NEEDS_AUTH bound domain suspends (the elicitation envelope → `Suspend`); an
    /// AUTHENTICATED one reads the credential under the gateway grant. Empty
    /// `identity_profile_ids` = no vault consult (the common case).
    pub fn registry_with_identity(
        caller: Arc<dyn ToolCaller>,
        agent_id: String,
        allowlist: Option<Vec<String>>,
        user_id: Option<String>,
        identity_profile_ids: Vec<String>,
    ) -> Self {
        Self::registry_with_identity_and_conversation(
            caller,
            agent_id,
            allowlist,
            user_id,
            identity_profile_ids,
            None,
        )
    }

    /// Construct the production registry invoker with a server-derived host
    /// conversation. This context is kept separate from `user_id`: the latter is
    /// a client-supplied Composio entity/audit selector, while this value is the
    /// authorization principal resolved by Core for conversation-scoped tools.
    pub fn registry_with_identity_and_conversation(
        caller: Arc<dyn ToolCaller>,
        agent_id: String,
        allowlist: Option<Vec<String>>,
        user_id: Option<String>,
        identity_profile_ids: Vec<String>,
        host_conversation_id: Option<String>,
    ) -> Self {
        SandboxToolInvoker::Registry(RegistryToolInvoker {
            caller,
            agent_id,
            allowlist,
            user_id,
            identity_profile_ids,
            host_conversation_id,
            data_flow: Arc::default(),
        })
    }

    /// Invoke a single tool call from the sandbox. Errors from the registry are
    /// surfaced as a `ToolInvokeResult` with `is_error = true` (the program can
    /// catch them) rather than aborting the whole execution.
    pub async fn invoke(&self, call: ToolInvocation) -> InvokeOutcome {
        match self {
            SandboxToolInvoker::Registry(inner) => inner.invoke(call).await,
            SandboxToolInvoker::Bridge(inner) => inner.handle(call.path, call.args).await,
            #[cfg(test)]
            SandboxToolInvoker::Mock(inner) => inner.invoke(call),
        }
    }

    /// Construct a host-bridge invoker (plugin host capabilities).
    pub fn bridge(bridge: Arc<dyn SandboxBridge>) -> Self {
        SandboxToolInvoker::Bridge(bridge)
    }

    #[cfg(test)]
    pub fn mock(responder: MockResponder) -> Self {
        SandboxToolInvoker::Mock(MockInvoker { responder })
    }
}

/// Production invoker: closes over the host tool-caller + the resolved agent
/// allowlist.
pub struct RegistryToolInvoker {
    caller: Arc<dyn ToolCaller>,
    /// The calling agent — feeds the host approval policy's per-agent
    /// `approval_tools` (Layer A), in addition to audit attribution.
    agent_id: String,
    allowlist: Option<Vec<String>>,
    user_id: Option<String>,
    /// Agent's bound Identity Vault profiles (epic #517). Empty = no vault consult.
    identity_profile_ids: Vec<String>,
    /// Core-validated conversation principal for conversation-scoped tools.
    host_conversation_id: Option<String>,
    /// This run's private-data state, handed to every call (see [`RunDataFlow`]).
    data_flow: Arc<RunDataFlow>,
}

impl RegistryToolInvoker {
    async fn invoke(&self, call: ToolInvocation) -> InvokeOutcome {
        let tool_id = tool_path_to_id(&call.path);
        match self
            .caller
            .call_tool_with_identity(
                Some(self.agent_id.as_str()).filter(|s| !s.is_empty()),
                &tool_id,
                call.args,
                self.allowlist.as_deref(),
                self.user_id.as_deref(),
                &self.identity_profile_ids,
                None,
                self.host_conversation_id.as_deref(),
                &self.data_flow,
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
                error: Some(e),
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
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingCaller {
        host_conversation_id: Mutex<Option<String>>,
        /// Each call's tool id and the address of the run state it was handed.
        flows: Mutex<Vec<(String, usize)>>,
    }

    fn flow_address(flow: &Arc<RunDataFlow>) -> usize {
        Arc::as_ptr(flow) as usize
    }

    #[async_trait]
    impl ToolCaller for RecordingCaller {
        async fn call_tool_with_identity(
            &self,
            _agent_id: Option<&str>,
            tool_id: &str,
            _arguments: Value,
            _allowlist: Option<&[String]>,
            _user_id: Option<&str>,
            _profile_ids: &[String],
            _session_id: Option<String>,
            host_conversation_id: Option<&str>,
            data_flow: &Arc<RunDataFlow>,
        ) -> Result<Value, String> {
            *self.host_conversation_id.lock().unwrap() = host_conversation_id.map(str::to_owned);
            self.flows
                .lock()
                .unwrap()
                .push((tool_id.to_owned(), flow_address(data_flow)));
            if tool_id == "search_conversations.search" {
                data_flow.mark_private_read(tool_id);
            }
            Ok(json!({ "ok": true }))
        }
    }

    fn registry_invoker(caller: Arc<RecordingCaller>) -> SandboxToolInvoker {
        SandboxToolInvoker::registry(caller, "agent-1".into(), None, None)
    }

    fn call(path: &str) -> ToolInvocation {
        ToolInvocation {
            path: path.into(),
            args: json!({}),
        }
    }

    fn run_flow(invoker: &SandboxToolInvoker) -> &Arc<RunDataFlow> {
        match invoker {
            SandboxToolInvoker::Registry(inner) => &inner.data_flow,
            _ => panic!("expected a registry invoker"),
        }
    }

    #[test]
    fn run_data_flow_marks_once_and_keeps_first_source() {
        let flow = RunDataFlow::default();
        assert_eq!(flow.private_read_source(), None);
        flow.mark_private_read("memory.search");
        flow.mark_private_read("search_conversations.search");
        assert_eq!(flow.private_read_source(), Some("memory.search"));
    }

    #[tokio::test]
    async fn registry_invoker_hands_one_run_flow_to_every_call() {
        let caller = Arc::new(RecordingCaller::default());
        let invoker = registry_invoker(caller.clone());
        invoker.invoke(call("search_conversations.search")).await;
        invoker.invoke(call("web.extract")).await;

        let flows = caller.flows.lock().unwrap();
        assert_eq!(flows.len(), 2);
        assert_eq!(flows[0].1, flows[1].1, "one run shares one state");
        assert_eq!(flows[0].1, flow_address(run_flow(&invoker)));
        assert_eq!(
            run_flow(&invoker).private_read_source(),
            Some("search_conversations.search")
        );
    }

    #[tokio::test]
    async fn each_registry_invoker_starts_with_a_clean_flow() {
        let caller = Arc::new(RecordingCaller::default());
        let first = registry_invoker(caller.clone());
        first.invoke(call("search_conversations.search")).await;
        let second = registry_invoker(caller.clone());
        second.invoke(call("web.extract")).await;

        let flows = caller.flows.lock().unwrap();
        assert_ne!(flows[0].1, flows[1].1, "runs never share state");
        assert_eq!(
            run_flow(&first).private_read_source(),
            Some("search_conversations.search")
        );
        assert_eq!(run_flow(&second).private_read_source(), None);
    }

    #[test]
    fn path_first_segment_is_server() {
        assert_eq!(tool_path_to_id("spider.crawl"), "spider.crawl");
        assert_eq!(
            tool_path_to_id("composio.GITHUB_CREATE_ISSUE"),
            "composio.GITHUB_CREATE_ISSUE"
        );
        // Already-qualified passthrough.
        assert_eq!(tool_path_to_id("spider__crawl"), "spider__crawl");
        // No dot at all → returned verbatim.
        assert_eq!(tool_path_to_id("ping"), "ping");
    }

    #[test]
    fn path_with_dotted_tool_name_keeps_remainder() {
        // The complete dotted path is the canonical id; the first dot remains
        // the server boundary and later dots stay part of the tool name.
        assert_eq!(tool_path_to_id("server.group.tool"), "server.group.tool");
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

    #[tokio::test]
    async fn registry_invoker_forwards_validated_host_conversation() {
        let caller = Arc::new(RecordingCaller::default());
        let invoker = SandboxToolInvoker::registry_with_identity_and_conversation(
            caller.clone(),
            "agent-1".into(),
            None,
            None,
            Vec::new(),
            Some("conversation-1".into()),
        );

        let out = invoker
            .invoke(ToolInvocation {
                path: "threads.list".into(),
                args: json!({}),
            })
            .await;

        assert!(matches!(out, InvokeOutcome::Result(result) if !result.is_error));
        assert_eq!(
            caller.host_conversation_id.lock().unwrap().as_deref(),
            Some("conversation-1")
        );
    }
}
