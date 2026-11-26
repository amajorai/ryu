//! A PTC program started after a private read made outside the program.
//!
//! A program run starts with a clean [`RunDataFlow`], and the registry scopes
//! each of its calls to that run, which replaces any scope around the
//! `execute` call itself. When `execute` runs under a private-read scope (the
//! ACP bridge after a device read, `device_tools::taint`), the program must
//! inherit that read, or it could send what the agent already holds out with
//! no hold. [`inheriting_current_read`] wraps the caller so every call the
//! program makes marks its run with that read first, and the exfiltration
//! guard holds the program's egress like the bridge's own.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use super::{RunDataFlow, ToolCaller};

struct InheritedReadCaller {
    inner: Arc<dyn ToolCaller>,
    source: String,
}

#[async_trait]
impl ToolCaller for InheritedReadCaller {
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
    ) -> Result<Value, String> {
        data_flow.mark_private_read(&self.source);
        self.inner
            .call_tool_with_identity(
                agent_id,
                tool_id,
                arguments,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
                data_flow,
            )
            .await
    }
}

/// `caller` for a program started now: unchanged outside a private-read
/// scope, else wrapped so the program's run carries the scope's read.
pub(crate) fn inheriting_current_read(caller: Arc<dyn ToolCaller>) -> Arc<dyn ToolCaller> {
    let source = crate::approvals::exfiltration_guard::current_sandbox_run()
        .and_then(|run| run.private_read_source().map(str::to_owned));
    match source {
        Some(source) => Arc::new(InheritedReadCaller {
            inner: caller,
            source,
        }),
        None => caller,
    }
}
