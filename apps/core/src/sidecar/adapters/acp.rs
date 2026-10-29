use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::sidecar::adapters::acp_spawn::AcpSpawn;
use agent_client_protocol::schema::v1::{
    AuthMethodId, AuthenticateRequest, AvailableCommandInput, CancelNotification,
    ClientCapabilities, CloseSessionRequest, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, EmbeddedResourceResource, EnvVariable, ImageContent, InitializeRequest,
    InitializeResponse, KillTerminalRequest, KillTerminalResponse, ListSessionsRequest,
    ListSessionsResponse, LoadSessionRequest, LogoutRequest, McpServer, McpServerStdio,
    NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionId,
    PermissionOptionKind, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    TerminalId, TerminalOutputRequest, TerminalOutputResponse, ToolCall, ToolCallContent,
    ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolKind, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::v1::{ResumeSessionRequest, ResumeSessionResponse};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{Agent, Client, ConnectionTo, SessionMessage};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::sidecar::adapters::acp_probe_cache as probe_cache;
use crate::sidecar::adapters::{
    AgentAdapter, AgentConfig, AgentInfo, ChatChunk, ChatRequest, ImagePart, MemoryEntry, ToolInfo,
};
use crate::sidecar::gateway::{check_exec_scan, ExecScanOutcome};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::BoxFuture;
use crate::win_process::NoWindow;

mod adapter;
mod agent_entries;
mod apply_config;
mod cancel;
mod child_env;
mod config_probe;
mod confinement;
mod failure_usage;
mod gateway_cmds;
mod gateway_probe;
mod launch_policy;
mod managed_pi;
mod observed_tools;
mod permission_caps;
mod permission_waiters;
mod pi_cmd;
mod pool;
mod pool_key;
mod question_waiters;
mod registry;
mod registry_builtin;
mod registry_curated;
mod registry_lookup;
mod sandbox_paths;
mod scoped_fs;
mod serve_dispatch;
mod serve_finish;
mod serve_instance;
mod serve_launch;
mod serve_notification;
mod serve_prepare;
mod serve_prompt;
mod serve_requests;
mod serve_session;
mod serve_turn;
mod session_commands;
mod session_resume;
mod spawn_launch;
mod spawn_prepare;
mod spawn_task;
mod start_failures;
mod tool_access;
mod tool_events;
mod turn_config;
mod wire_types;

pub use adapter::*;
pub use agent_entries::*;
use apply_config::*;
pub use cancel::*;
pub(crate) use child_env::*;
pub use config_probe::*;
use confinement::*;
pub use failure_usage::*;
pub use gateway_cmds::*;
use gateway_probe::*;
use launch_policy::*;
pub use managed_pi::*;
pub use observed_tools::*;
use permission_caps::*;
pub use permission_waiters::*;
pub use pi_cmd::*;
pub use pool::*;
pub(crate) use pool_key::*;
pub use question_waiters::*;
pub use registry::*;
use sandbox_paths::*;
use scoped_fs::*;
use serve_dispatch::*;
use serve_finish::*;
use serve_instance::*;
use serve_launch::*;
use serve_notification::*;
use serve_prepare::*;
use serve_prompt::*;
use serve_requests::*;
use serve_session::*;
use serve_turn::*;
pub use session_commands::*;
use session_resume::*;
pub use spawn_task::*;
pub(crate) use start_failures::*;
pub use tool_access::*;
use tool_events::*;
pub use turn_config::*;
pub use wire_types::*;

#[cfg(test)]
#[path = "acp_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "acp_admission_eviction_tests.rs"]
mod admission_eviction_tests;

#[cfg(test)]
mod claude_code_session_meta_tests {
    use super::{claude_code_session_meta, is_claude_code_spawn};

    /// Without `strictMcpConfig` every chat starts its own copy of each
    /// `~/.claude.json` MCP server; Ryu's shared bridge is the only MCP source.
    #[test]
    fn claude_sessions_use_user_settings_and_only_ryus_mcp_servers() {
        let meta = claude_code_session_meta();
        let options = &meta["claudeCode"]["options"];
        assert_eq!(options["settingSources"], serde_json::json!(["user"]));
        assert_eq!(options["strictMcpConfig"], serde_json::json!(true));
    }

    #[test]
    fn a_resumed_claude_session_keeps_the_same_options_plus_resume() {
        let fresh = super::claude_code_session_meta_resuming(None);
        assert_eq!(fresh, claude_code_session_meta());
        let resumed = super::claude_code_session_meta_resuming(Some("abc-123"));
        let options = &resumed["claudeCode"]["options"];
        assert_eq!(options["resume"], serde_json::json!("abc-123"));
        assert_eq!(options["strictMcpConfig"], serde_json::json!(true));
    }

    #[test]
    fn claude_code_spawns_are_recognized_across_bridge_package_names() {
        assert!(is_claude_code_spawn(
            "cmd /c npx -y @agentclientprotocol/claude-agent-acp@latest"
        ));
        assert!(is_claude_code_spawn(
            "npx -y @zed-industries/claude-code-acp"
        ));
        assert!(!is_claude_code_spawn("npx -y pi-acp"));
    }
}

#[cfg(test)]
mod load_stored_session_tests {
    use super::{load_stored_session, resolve_in_path, ryu_initialize_request};
    use crate::sidecar::adapters::acp_spawn::AcpSpawn;
    use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
    use agent_client_protocol::{Agent, Client, ConnectionTo};

    /// A minimal ACP agent: `session/load` replays three history chunks (as pi-acp
    /// does) before answering, and rejects an unknown session id.
    const FAKE_AGENT: &str = r#"
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/load" && msg.params.sessionId === "stored") {
    for (const text of ["one", "two", "three"]) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stored", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
  }
});
"#;

    #[tokio::test]
    async fn loads_a_stored_session_and_drains_its_replayed_history() {
        let Some(node) = resolve_in_path("node") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.js");
        std::fs::write(&script, FAKE_AGENT).unwrap();
        let agent = AcpSpawn::new(McpServer::Stdio(
            McpServerStdio::new("fake", node).args(vec![script.to_string_lossy().into_owned()]),
        ))
        .into_agent()
        .unwrap();
        let cwd = dir.path().to_path_buf();

        let (loaded_id, leftover, missing_loaded) = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            Client
                .builder()
                .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                    cx.send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    let mut session = load_stored_session(&cx, "stored", &cwd, &[])
                        .await
                        .expect("stored session loads");
                    let loaded_id = session.session_id().to_string();
                    let leftover = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        session.read_update(),
                    )
                    .await
                    .is_ok();
                    let missing_loaded = load_stored_session(&cx, "missing", &cwd, &[])
                        .await
                        .is_some();
                    Ok((loaded_id, leftover, missing_loaded))
                }),
        )
        .await
        .expect("fake agent answered")
        .expect("connection ran");

        assert_eq!(loaded_id, "stored");
        assert!(
            !leftover,
            "replayed history must not reach the chat's first turn"
        );
        assert!(
            !missing_loaded,
            "an unknown session falls back to a fresh one"
        );
    }
}

#[cfg(test)]
#[path = "acp_turn_config_protocol_tests.rs"]
mod turn_config_protocol_tests;

#[cfg(test)]
mod close_conversation_instances_tests {
    use super::{acp_pool, close_conversation_instances, AcpInstanceActivity, AcpPoolEntry};
    use tokio::sync::mpsc;

    fn entry() -> (AcpPoolEntry, mpsc::UnboundedReceiver<super::AcpTurn>) {
        let (turns, turns_rx) = mpsc::unbounded_channel();
        (
            AcpPoolEntry {
                turns,
                capability_session_id: None,
                inference_grant_id: None,
                activity: AcpInstanceActivity::new(),
            },
            turns_rx,
        )
    }

    #[test]
    fn closes_only_the_named_conversations_instances() {
        let target = format!("delegate-{}", uuid::Uuid::new_v4().simple());
        let other = format!("delegate-{}", uuid::Uuid::new_v4().simple());
        let (a, mut a_rx) = entry();
        let (b, mut b_rx) = entry();
        let (c, mut c_rx) = entry();
        {
            let mut pool = acp_pool().lock().unwrap();
            pool.insert(format!("{target}\u{1}agent-one"), a);
            pool.insert(format!("{target}\u{1}agent-two"), b);
            pool.insert(format!("{other}\u{1}agent-one"), c);
        }

        assert_eq!(close_conversation_instances(&target), 2);
        // A closed instance sees its queue end; the other conversation's stays open.
        assert!(a_rx.try_recv().is_err() && a_rx.is_closed());
        assert!(b_rx.try_recv().is_err() && b_rx.is_closed());
        assert!(!c_rx.is_closed());
        assert_eq!(close_conversation_instances(&target), 0);
        assert_eq!(close_conversation_instances(""), 0);
        assert_eq!(close_conversation_instances(&other), 1);
        assert!(c_rx.try_recv().is_err());
    }

    #[test]
    fn closes_every_conversation_of_one_workflow_run() {
        let run = uuid::Uuid::new_v4().simple().to_string();
        let (a, a_rx) = entry();
        let (b, b_rx) = entry();
        let (c, c_rx) = entry();
        {
            let mut pool = acp_pool().lock().unwrap();
            pool.insert(format!("wfrun-{run}-node1\u{1}agent"), a);
            pool.insert(format!("wfrun-{run}-node2\u{1}agent"), b);
            pool.insert(format!("wfrun-{run}x-node1\u{1}agent"), c);
        }
        assert_eq!(
            super::close_conversation_instances_with_prefix(&format!("wfrun-{run}-")),
            2
        );
        assert!(a_rx.is_closed() && b_rx.is_closed());
        assert!(!c_rx.is_closed());
        assert_eq!(
            super::close_conversation_instances_with_prefix(&format!("wfrun-{run}x-")),
            1
        );
        assert_eq!(super::close_conversation_instances_with_prefix(""), 0);
    }
}

#[cfg(test)]
#[path = "acp_retire_superseded_instances_tests.rs"]
mod retire_superseded_instances_tests;

#[cfg(test)]
mod observed_tools_cap_tests {
    use super::{observed_tools_for, record_observed_tool, MAX_OBSERVED_TOOLS_PER_AGENT};

    #[test]
    fn per_call_tool_titles_stop_growing_at_the_cap() {
        let agent = format!("obs-cap-{}", uuid::Uuid::new_v4().simple());
        for i in 0..(MAX_OBSERVED_TOOLS_PER_AGENT + 50) {
            record_observed_tool(&agent, &format!("Read src/file_{i}.rs"), "read");
        }
        assert_eq!(
            observed_tools_for(&agent).len(),
            MAX_OBSERVED_TOOLS_PER_AGENT
        );
        // A title already recorded stays listed once the cap is reached.
        record_observed_tool(&agent, "Read src/file_0.rs", "read");
        assert_eq!(
            observed_tools_for(&agent).len(),
            MAX_OBSERVED_TOOLS_PER_AGENT
        );
    }
}

#[cfg(test)]
#[path = "acp_untrusted_package_runner_tests.rs"]
mod untrusted_package_runner_tests;

#[cfg(test)]
#[path = "acp_permission_request_tests.rs"]
mod permission_request_tests;

#[cfg(test)]
#[path = "acp_question_request_tests.rs"]
mod question_request_tests;

#[cfg(test)]
#[path = "acp_instance_lifecycle_tests.rs"]
mod instance_lifecycle_tests;

#[cfg(test)]
#[path = "acp_account_sandbox_tests.rs"]
mod account_sandbox_tests;
