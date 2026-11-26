//! A program started under a private-read scope carries that read into its run.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use super::{inheriting_current_read, RunDataFlow, ToolCaller};
use crate::approvals::exfiltration_guard::scope_sandbox_run;

/// Answers every call and reports the run's private read as the call saw it.
struct SourceEcho;

#[async_trait]
impl ToolCaller for SourceEcho {
    async fn call_tool_with_identity(
        &self,
        _agent_id: Option<&str>,
        _tool_id: &str,
        _arguments: Value,
        _allowlist: Option<&[String]>,
        _user_id: Option<&str>,
        _profile_ids: &[String],
        _session_id: Option<String>,
        _host_conversation_id: Option<&str>,
        data_flow: &Arc<RunDataFlow>,
    ) -> Result<Value, String> {
        Ok(json!({ "source": data_flow.private_read_source() }))
    }
}

async fn first_call(caller: &Arc<dyn ToolCaller>, run: &Arc<RunDataFlow>) -> Value {
    caller
        .call_tool_with_identity(
            None,
            "web.extract",
            json!({}),
            None,
            None,
            &[],
            None,
            None,
            run,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn a_program_started_after_a_device_read_carries_it() {
    let outer = Arc::new(RunDataFlow::default());
    outer.mark_private_read("device.location.current");
    let caller = scope_sandbox_run(outer, async {
        inheriting_current_read(Arc::new(SourceEcho))
    })
    .await;
    // The program's own run starts clean; its first call already sees the read,
    // so the exfiltration guard holds that call if it is egress.
    let run = Arc::new(RunDataFlow::default());
    let seen = first_call(&caller, &run).await;
    assert_eq!(seen["source"], "device.location.current");
    assert_eq!(run.private_read_source(), Some("device.location.current"));
}

#[tokio::test]
async fn a_program_started_outside_a_private_scope_starts_clean() {
    let caller = inheriting_current_read(Arc::new(SourceEcho));
    let run = Arc::new(RunDataFlow::default());
    assert_eq!(first_call(&caller, &run).await["source"], Value::Null);
    assert_eq!(run.private_read_source(), None);

    // A scope with nothing read is not a private read either.
    let caller = scope_sandbox_run(Arc::new(RunDataFlow::default()), async {
        inheriting_current_read(Arc::new(SourceEcho))
    })
    .await;
    let run = Arc::new(RunDataFlow::default());
    assert_eq!(first_call(&caller, &run).await["source"], Value::Null);
}
