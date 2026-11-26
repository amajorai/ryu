//! The stream parser for `codex exec --json`. The Claude lines are covered by
//! `local_runs_pass_text_after_dashes_and_accept_only_edits` in the suite of
//! `subscription_cloud`.

use super::*;

#[test]
fn codex_lines_become_session_log_reply_and_result() {
    let codex = |line: &str| parse_event(Provider::Openai, line);
    assert_eq!(
        codex(r#"{"type":"thread.started","thread_id":"thread_0123456789"}"#),
        Event::Init {
            session_id: "thread_0123456789".into()
        }
    );
    assert_eq!(
        codex(r#"{"type":"thread.started","thread_id":"a b"}"#),
        Event::Other
    );
    assert_eq!(
        codex(r#"{"type":"item.completed","item":{"type":"agent_message","text":" Done "}}"#),
        Event::Reply("Done".into())
    );
    assert_eq!(
        codex(r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}"#),
        Event::Log("→ shell".into())
    );
    assert_eq!(
        codex(r#"{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"rm -rf /"}}"#),
        Event::Log("→ tool".into())
    );
    assert_eq!(
        codex(r#"{"type":"turn.completed"}"#),
        Event::Result {
            is_error: false,
            text: None
        }
    );
    assert_eq!(
        codex(r#"{"type":"turn.failed","error":{"message":"limit"}}"#),
        Event::Result {
            is_error: true,
            text: Some("limit".into())
        }
    );
    assert_eq!(
        codex(r#"{"type":"error","message":"retrying"}"#),
        Event::StreamError(Some("retrying".into()))
    );
    assert_eq!(codex("not json"), Event::Other);
}
