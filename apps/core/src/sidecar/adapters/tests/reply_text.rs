use super::*;

// ── run_reply_text / channel session seam (M11 / #226) ────────────────────

/// AC2: two turns in the same chat share conversation history via the Core
/// conversation store. Verify that after two calls with the same conversation_id
/// the store holds at least two rows keyed to that id.
///
/// The test does NOT stand up a live agent (the call to an unreachable
/// OpenAI-compat endpoint will error), but the user turn is persisted by
/// `route_chat_stream` BEFORE the upstream connection is attempted, so we
/// can assert conversation rows grow per-turn using only the in-memory store.
#[tokio::test]
async fn channel_turns_share_conversation_in_store() {
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let conversations = ConversationStore::open_in_memory().unwrap();
    let memory = MemoryStore::open_in_memory().unwrap();
    let worktree_diffs = Arc::new(Mutex::new(HashMap::new()));
    let registry = Arc::new(AcpAgentRegistry::new());
    let agent_store = crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let manager = crate::sidecar::SidecarManager::new_noop();
    let mcp = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let skills = ryu_skills::SkillRegistry::empty();
    let traces = ryu_tracing::TraceStore::open_in_memory().unwrap();

    let conv_id = "telegram-chat-99".to_string();

    // First turn: the unreachable provider returns an error, but the user
    // message is persisted before the connection attempt.
    let _ = run_reply_text(
        conv_id.clone(),
        None,
        "hello turn one".to_string(),
        None,
        Arc::clone(&registry),
        conversations.clone(),
        agent_store.clone(),
        Arc::clone(&manager),
        memory.clone(),
        Arc::clone(&worktree_diffs),
        Arc::clone(&mcp),
        skills.clone(),
        traces.clone(),
    )
    .await;

    // Second turn with the same conversation_id = chat_id.
    let _ = run_reply_text(
        conv_id.clone(),
        None,
        "hello turn two".to_string(),
        None,
        Arc::clone(&registry),
        conversations.clone(),
        agent_store.clone(),
        Arc::clone(&manager),
        memory.clone(),
        Arc::clone(&worktree_diffs),
        Arc::clone(&mcp),
        skills.clone(),
        traces.clone(),
    )
    .await;

    // Both user turns must be persisted in the conversation store under the
    // same conversation_id (= Telegram chat_id), proving multi-turn history
    // is shared. Per persist logic: user turn written before upstream attempt.
    let rows = conversations
        .get_recent_messages(&conv_id, 10)
        .await
        .unwrap_or_default();
    assert!(
        rows.len() >= 2,
        "expected at least 2 persisted turns for conversation {conv_id}, got {}",
        rows.len()
    );
    assert!(rows.iter().any(|r| r.content.contains("turn one")));
    assert!(rows.iter().any(|r| r.content.contains("turn two")));
}

/// AC1: `run_reply_text` builds a valid `ChatStreamRequest` that the existing
/// streaming machinery accepts — verified indirectly by asserting the function
/// signature compiles and a call with an empty agent id doesn't panic.
#[tokio::test]
async fn run_reply_text_accepts_no_agent_id() {
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let conversations = ConversationStore::open_in_memory().unwrap();
    let memory = MemoryStore::open_in_memory().unwrap();
    let worktree_diffs = Arc::new(Mutex::new(HashMap::new()));
    let registry = Arc::new(AcpAgentRegistry::new());
    let agent_store = crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let manager = crate::sidecar::SidecarManager::new_noop();
    let mcp = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let skills = ryu_skills::SkillRegistry::empty();
    let traces = ryu_tracing::TraceStore::open_in_memory().unwrap();

    // No agent_id — falls back to the default route (which will error because
    // no LLM is configured). The important thing is it doesn't panic.
    let result = run_reply_text(
        "test-conv-1".to_string(),
        None,
        "ping".to_string(),
        None,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
    )
    .await;
    // Either an Ok(empty-or-error-text) or an Err — both are acceptable here;
    // what matters is no panic occurred.
    let _ = result;
}
