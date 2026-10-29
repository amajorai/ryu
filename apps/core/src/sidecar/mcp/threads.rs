//! Built-in coordinator-threads tools (`threads.*`) — Codex-style cross-thread
//! orchestration.
//!
//! A single *coordinator* agent thread can discover active Ryu conversations,
//! spot shared workspaces, and manage *worker* threads: create a thread, list/read
//! threads, send a message that runs a worker's agent (optionally in the background,
//! with optional worktree isolation), wait for a run, and pin / archive / title threads. In
//! Ryu a Codex "thread" is a [`ConversationStore`] conversation, so workers are
//! durable, searchable, and resumable exactly like any chat.
//!
//! Registered as a reserved registry server (`threads`) like spider/exa/
//! search_conversations, so the `<server>.<tool>` id scheme, per-agent allowlist,
//! catalog search, and the single `call_tool` entry all work for free — and it is
//! allowlist-gated + audited on BOTH planes (ACP + openai-compat). Only an agent
//! whose allowlist grants `threads.*` can coordinate, so the capability is opt-in
//! per agent.
//!
//! The hard tool is `send_message_to_thread`: it appends the instruction to a
//! *worker* conversation and runs *that conversation's configured agent* with
//! `persist = true` (both the user instruction and the assistant reply land in the
//! worker's history, so the coordinator can read them back). By default it runs in
//! the **background** and returns immediately — the whole point of the feature is
//! to "work on a lot more at once"; the coordinator polls with `read_thread`.
//! By default workers use the thread's working directory. A Core preference can
//! enable per-call git worktree isolation, and `isolate` can override that choice.
//!
//! Background concurrency is bounded by a process-global semaphore
//! ([`MAX_CONCURRENT_WORKERS`]) so a coordinator (or a worker that itself holds the
//! tool) cannot fan out without limit.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::{RegistryTool, ToolPrincipal};
use crate::server::conversations::ConversationStore;

/// Reserved registry server name for the built-in coordinator-threads provider.
pub const SERVER_NAME: &str = "threads";

/// Core preference key for the default isolation choice on worker turns.
pub const WORKTREE_ISOLATION_DEFAULT_PREF_KEY: &str = "threads-worktree-isolate-by-default";
pub const DEFAULT_WORKTREE_ISOLATION: bool = false;

/// Max number of worker turns running concurrently across the whole process.
/// Mirrors the scheduler's `MAX_CONCURRENT_JOBS`. Excess background turns queue
/// for a permit rather than being rejected.
const MAX_CONCURRENT_WORKERS: usize = 8;

/// Default / max number of recent messages `read_thread` returns.
const DEFAULT_READ_LIMIT: usize = 20;
const MAX_READ_LIMIT: usize = 100;

/// Max characters of a single message body returned by `read_thread`, so a long
/// worker turn doesn't blow the coordinator's context.
const MESSAGE_MAX_CHARS: usize = 2000;

/// A bounded wait lets an agent yield time for a concurrent thread without
/// holding a tool call open forever.
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 300_000;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_ACTIVE_SESSION_ROWS: usize = 100;

/// The process-global background-worker concurrency limiter.
fn worker_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_WORKERS)))
}

fn create_thread_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "Human-readable title for the new worker thread." },
            "agent_id": { "type": "string", "description": "Agent to run this thread (omit to use the default agent)." },
            "cwd": { "type": "string", "description": "Working directory for the thread's runs (a git repo enables per-thread worktree isolation). Omit to use the node's current directory." }
        },
        "required": []
    })
}

fn list_threads_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "include_archived": { "type": "boolean", "description": "Include archived threads (default false)." },
            "active_only": { "type": "boolean", "description": "Show only conversations or Runnable sessions that are currently running (default false). Use this to see concurrent work before editing a shared workspace." }
        },
        "required": []
    })
}

fn wait_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string", "description": "Visible conversation/thread id to wait for." },
            "session_id": { "type": "string", "description": "Visible Ryu Runnable session id to wait for. Provide exactly one of session_id or thread_id." },
            "timeout_ms": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_TIMEOUT_MS, "description": "How long to wait (default 30000, maximum 300000). Use 0 to read the current status without waiting." }
        },
        "required": []
    })
}

fn read_thread_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string", "description": "Id of the thread to read." },
            "limit": { "type": "integer", "description": "Most-recent messages to return (default 20, max 100).", "minimum": 1, "maximum": MAX_READ_LIMIT }
        },
        "required": ["thread_id"]
    })
}

fn send_message_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string", "description": "Id from list_threads for the worker thread or active session's conversation." },
            "message": { "type": "string", "description": "The instruction to send. The worker's agent runs and its reply is persisted to the worker thread." },
            "wait": { "type": "boolean", "description": "Block until the worker replies and return the reply (default false: run in the background and return immediately so you can dispatch more work)." },
            "isolate": { "type": "boolean", "description": "Run in a dedicated git worktree when cwd is a repo. If omitted, uses the Worktrees setting (off by default)." },
            "cwd": { "type": "string", "description": "Override the thread's working directory for this turn." }
        },
        "required": ["thread_id", "message"]
    })
}

fn set_title_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string" },
            "title": { "type": "string" }
        },
        "required": ["thread_id", "title"]
    })
}

fn set_pinned_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string" },
            "pinned": { "type": "boolean", "description": "Pin (default true) or unpin (false)." }
        },
        "required": ["thread_id"]
    })
}

fn set_archived_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string" },
            "archived": { "type": "boolean", "description": "Archive (default true) or unarchive (false)." }
        },
        "required": ["thread_id"]
    })
}

fn fork_thread_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "thread_id": { "type": "string", "description": "Source thread to fork." },
            "up_to_message_id": { "type": "string", "description": "Copy history up to and including this message (omit to copy everything)." }
        },
        "required": ["thread_id"]
    })
}

/// The coordinator tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    let def = |name: &str, description: &str, schema: Value| RegistryTool {
        id: format!("{SERVER_NAME}.{name}"),
        server: SERVER_NAME.to_owned(),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        input_schema: Some(schema),
        ..Default::default()
    };
    vec![
        def(
            "create_thread",
            "Create a new worker thread (conversation) you can delegate work to. Returns its thread_id.",
            create_thread_schema(),
        ),
        def(
            "list_threads",
            "List visible threads and active Ryu Runnable sessions with their status, agent, workspace, branch, and pinned/archived flags. Set active_only=true to inspect concurrent work. A shared workspace path is marked as a possible file conflict.",
            list_threads_schema(),
        ),
        def(
            "read_thread",
            "Read the most recent messages of a thread (the worker's transcript) plus its run status. Use to check a worker's progress and result.",
            read_thread_schema(),
        ),
        def(
            "send_message_to_thread",
            "Send an instruction to a worker thread or active session's conversation and run its agent. Runs in the background by default; use wait_for_thread or read_thread to check the result. Worktree isolation is off by default and can be changed in Worktrees settings or overridden with isolate.",
            send_message_schema(),
        ),
        def(
            "wait_for_thread",
            "Wait for a visible thread or Ryu Runnable session to finish. Provide exactly one of thread_id or session_id. Use after sending work in the background, then read_thread for the transcript.",
            wait_schema(),
        ),
        def(
            "set_thread_title",
            "Set a thread's title.",
            set_title_schema(),
        ),
        def(
            "set_thread_pinned",
            "Pin or unpin a thread to keep it surfaced.",
            set_pinned_schema(),
        ),
        def(
            "set_thread_archived",
            "Archive or unarchive a thread to hide a finished worker.",
            set_archived_schema(),
        ),
        def(
            "fork_thread",
            "Fork a thread into a new independent thread, copying its history. Returns the new thread_id.",
            fork_thread_schema(),
        ),
    ]
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn opt_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MESSAGE_MAX_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(MESSAGE_MAX_CHARS).collect();
    out.push('…');
    out
}

/// The "this thread is not yours" answer. Deliberately identical to the genuine
/// "thread not found" envelope so a denied read is not an existence ORACLE: an
/// agent cannot enumerate which conversation ids exist on the node by probing.
fn not_found() -> Value {
    json!({ "ok": false, "error": "thread not found" })
}

/// Whether `principal` may READ `thread_id`, using the SAME
/// `TENANCY_VISIBLE_PREDICATE` the HTTP plane filters with
/// ([`ConversationStore::visible_conversation_ids`]) — so the agent plane and the
/// REST plane can never drift apart.
async fn can_read(
    store: &ConversationStore,
    principal: &ToolPrincipal,
    thread_id: &str,
) -> Result<bool> {
    if matches!(principal, ToolPrincipal::Unrestricted) {
        return Ok(true);
    }
    let (uid, org, bound) = principal.filter_args();
    Ok(store
        .visible_conversation_ids(uid, org, bound)
        .await?
        .iter()
        .any(|id| id == thread_id))
}

/// Dispatch a `threads` tool call. `store` is the wired conversation store. A
/// malformed call returns `Err`; an unavailable dependency (no agent runner)
/// returns an `ok:false` envelope so the agent can degrade gracefully.
///
/// **Tenancy.** Every arm is gated on `principal` — the owner of the conversation
/// this agent turn runs on behalf of (see [`ToolPrincipal`]). Without this, these
/// tools defeated the entire HTTP ACL in one hop: on an org-bound node Bob's agent
/// could `read_thread` Alice's conversation and print her decrypted messages into
/// Bob's chat. **An agent must never be able to read what its principal cannot
/// read.** READS use the same visible-set predicate as REST; WRITES require a
/// strict owner-match (an org-visible thread is still not writable by a colleague's
/// agent); CREATES stamp the principal as the new row's owner, which is what stops a
/// coordinator being locked out of its own worker threads.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    dispatch_with_default_isolation(
        tool,
        arguments,
        store,
        principal,
        DEFAULT_WORKTREE_ISOLATION,
        None,
    )
    .await
}

/// `host_conversation_id` is the coordinator thread running this tool call. When
/// present, threads it creates or drives record it as their spawning thread
/// (`spawned_by_conversation_id`), which is what lets a main thread show its
/// sessions and a session link back to the main thread that started it.
pub async fn dispatch_with_default_isolation(
    tool: &str,
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    default_isolate: bool,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    match tool {
        "create_thread" => {
            let result = create_thread(arguments, store, principal).await?;
            record_lineage(store, &result, host_conversation_id).await;
            bind_worker_box(&result);
            Ok(result)
        }
        "list_threads" => list_threads(arguments, store, principal).await,
        "read_thread" => read_thread(arguments, store, principal).await,
        "send_message_to_thread" => {
            // Register the worker as a sub-agent of this coordinator before its
            // turn starts, so its first machine verb already finds its child
            // Box. Only a worker this principal owns is registered.
            if let Some(thread_id) = opt_str(&arguments, "thread_id") {
                if principal.owns(store, &thread_id).await {
                    super::box_desktop::bind_child_conversation(&thread_id);
                }
            }
            let result =
                send_message_to_thread(arguments, store, principal, default_isolate).await?;
            record_lineage(store, &result, host_conversation_id).await;
            Ok(result)
        }
        "wait_for_thread" => wait_for_thread(arguments, store, principal).await,
        "set_thread_title" => {
            let id = require_str(&arguments, "thread_id")?;
            let title = require_str(&arguments, "title")?;
            if !principal.owns(store, id).await {
                return Ok(not_found());
            }
            store.set_title(id, title).await?;
            Ok(json!({ "ok": true, "thread_id": id, "title": title }))
        }
        "set_thread_pinned" => {
            let id = require_str(&arguments, "thread_id")?;
            let pinned = opt_bool(&arguments, "pinned", true);
            if !principal.owns(store, id).await {
                return Ok(not_found());
            }
            store.set_pinned(id, pinned).await?;
            Ok(json!({ "ok": true, "thread_id": id, "pinned": pinned }))
        }
        "set_thread_archived" => {
            let id = require_str(&arguments, "thread_id")?;
            let archived = opt_bool(&arguments, "archived", true);
            if !principal.owns(store, id).await {
                return Ok(not_found());
            }
            store.set_archived(id, archived).await?;
            Ok(json!({ "ok": true, "thread_id": id, "archived": archived }))
        }
        "fork_thread" => {
            let id = require_str(&arguments, "thread_id")?;
            let up_to = opt_str(&arguments, "up_to_message_id");
            // READ is the right gate on the SOURCE (forking only reads it), and the
            // FORKER — i.e. this turn's principal — owns the copy. The copy is born
            // stamped (`principal.tenancy()`), so on an org-bound node the operator
            // can actually reach the thread their agent just created. This replaces
            // the old `(None, None)` fork, which minted a row denied to EVERYONE.
            if !can_read(store, principal, id).await? {
                return Ok(json!({
                    "ok": false,
                    "error": "source thread not found, or up_to_message_id is not a message of it",
                }));
            }
            match store
                .fork_conversation(id, up_to.as_deref(), principal.tenancy())
                .await?
            {
                Some(summary) => Ok(json!({
                    "ok": true,
                    "thread_id": summary.id,
                    "title": summary.title,
                    "message_count": summary.message_count,
                })),
                None => Ok(json!({
                    "ok": false,
                    "error": "source thread not found, or up_to_message_id is not a message of it",
                })),
            }
        }
        other => Err(anyhow::anyhow!("unknown threads tool '{other}'")),
    }
}

/// Register a worker thread this coordinator just created as one of its
/// sub-agents (`SUBAGENT_BOX_SCOPE`, set by the registry around this dispatch):
/// its `computer.*` and `browser.*` calls then run on the child Box
/// `<coordinator>#sub:<n>`, or on the coordinator's Box when the plan cap
/// refuses another one. Outside a scope (no host conversation) nothing changes.
fn bind_worker_box(result: &Value) {
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if let Some(thread_id) = result.get("thread_id").and_then(Value::as_str) {
        super::box_desktop::bind_child_conversation(thread_id);
    }
}

/// Parse the string preference at the Core settings boundary. Missing,
/// malformed, or unknown values retain the safe no-worktree default.
/// Record the coordinator as the spawning thread of a worker it created or drove.
/// Write-once in the store, so the first coordinator wins. Best-effort: lineage is
/// presentation metadata, and a failure must never fail the tool call itself.
async fn record_lineage(store: &ConversationStore, result: &Value, host: Option<&str>) {
    let Some(host) = host.map(str::trim).filter(|host| !host.is_empty()) else {
        return;
    };
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return;
    }
    let Some(thread_id) = result.get("thread_id").and_then(Value::as_str) else {
        return;
    };
    if let Err(error) = store.mark_spawned_by(thread_id, host, None).await {
        tracing::warn!(
            thread_id,
            host,
            "could not record session lineage: {error:#}"
        );
    }
}

pub fn default_worktree_isolation(preference: Option<&str>) -> bool {
    preference.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

fn isolate_for_call(arguments: &Value, default_isolate: bool) -> bool {
    opt_bool(arguments, "isolate", default_isolate)
}

async fn create_thread(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let title = opt_str(&arguments, "title");
    let agent_id = opt_str(&arguments, "agent_id");
    let cwd = opt_str(&arguments, "cwd");
    let thread_id = uuid::Uuid::new_v4().to_string();
    // The new worker thread is born OWNED by this turn's principal. Previously it
    // was minted untenanted, which on an org-bound node made it invisible and
    // undeniably-denied to its own operator — a lockout, not a leak.
    store
        .ensure_conversation(
            &thread_id,
            agent_id.as_deref(),
            title.as_deref(),
            principal.tenancy(),
        )
        .await?;
    if let Some(ref dir) = cwd {
        // Record the working folder so list_threads surfaces it; the worktree
        // itself is created lazily on the first send_message_to_thread.
        store
            .set_run_metadata(&thread_id, Some(dir), None, None)
            .await?;
    }
    Ok(json!({
        "ok": true,
        "thread_id": thread_id,
        "title": title,
        "agent_id": agent_id,
        "cwd": cwd,
    }))
}

async fn list_threads(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let include_archived = opt_bool(&arguments, "include_archived", false);
    let active_only = opt_bool(&arguments, "active_only", false);
    // Was `list_conversations()` — the UNFILTERED, every-row-on-the-node listing.
    // Now filtered in SQL by the same predicate the REST list uses.
    let (uid, org, bound) = principal.filter_args();
    let mut convs = store.list_conversations_visible(uid, org, bound).await?;
    let active_sessions = store
        .list_running_sessions_visible(uid, org, bound, MAX_ACTIVE_SESSION_ROWS)
        .await?;
    let active_session_list_truncated = active_sessions.len() == MAX_ACTIVE_SESSION_ROWS;
    let mut sessions_by_conversation = HashMap::<String, Vec<Value>>::new();
    for session in active_sessions {
        sessions_by_conversation
            .entry(session.conversation_id.clone())
            .or_default()
            .push(json!({
                "session_id": session.id,
                "runnable_id": session.runnable_id,
                "runnable_kind": session.runnable_kind,
                "status": "running",
                "updated_at": session.updated_at,
            }));
    }
    if !include_archived && !active_only {
        convs.retain(|c| !c.archived);
    }
    if active_only {
        convs.retain(|c| {
            c.run_status.as_deref() == Some("running")
                || sessions_by_conversation.contains_key(&c.id)
        });
    }
    // Pinned first, otherwise preserve the store's most-recently-updated order.
    convs.sort_by(|a, b| b.pinned.cmp(&a.pinned));

    let mut workspace_counts = HashMap::new();
    for conversation in &convs {
        let session_count = sessions_by_conversation
            .get(&conversation.id)
            .map_or(0, Vec::len);
        let conversation_run_count = if conversation.run_status.as_deref() == Some("running") {
            1
        } else {
            0
        };
        let active_run_count = session_count.max(conversation_run_count);
        if active_run_count == 0 {
            continue;
        }
        if let Some(path) = conversation
            .worktree_path
            .as_deref()
            .or(conversation.folder_path.as_deref())
        {
            *workspace_counts
                .entry(workspace_key(path))
                .or_insert(0usize) += active_run_count;
        }
    }
    let threads: Vec<Value> = convs
        .into_iter()
        .map(|c| {
            let sessions = sessions_by_conversation.remove(&c.id).unwrap_or_default();
            let is_active = c.run_status.as_deref() == Some("running") || !sessions.is_empty();
            let run_status = if is_active {
                Some("running")
            } else {
                c.run_status.as_deref()
            };
            let workspace_path = c.worktree_path.as_deref().or(c.folder_path.as_deref());
            let workspace_overlap = is_active
                && workspace_path.is_some_and(|path| {
                    workspace_counts
                        .get(&workspace_key(path))
                        .is_some_and(|count| *count > 1)
                });
            json!({
                "thread_id": c.id,
                "title": c.title,
                "agent_id": c.agent_id,
                "run_status": run_status,
                "sessions": sessions,
                "message_count": c.message_count,
                "pinned": c.pinned,
                "archived": c.archived,
                "folder_path": c.folder_path,
                "branch": c.branch,
                "worktree_path": c.worktree_path,
                "workspace_overlap": workspace_overlap,
                "updated_at": c.updated_at,
            })
        })
        .collect();
    let count = threads.len();
    Ok(json!({
        "ok": true,
        "threads": threads,
        "count": count,
        "active_sessions_may_be_truncated": active_session_list_truncated,
    }))
}

fn workspace_key(path: &str) -> String {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

async fn wait_for_thread(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let thread_id = opt_str(&arguments, "thread_id");
    let session_id = opt_str(&arguments, "session_id");
    let (target_id, target_field, is_session) = match (thread_id, session_id) {
        (Some(thread_id), None) => (thread_id, "thread_id", false),
        (None, Some(session_id)) => (session_id, "session_id", true),
        _ => anyhow::bail!("provide exactly one of thread_id or session_id"),
    };
    if target_id.len() > 512 {
        anyhow::bail!("thread_id and session_id must be at most 512 bytes");
    }
    let timeout_ms = match arguments.get("timeout_ms") {
        None => DEFAULT_WAIT_TIMEOUT_MS,
        Some(value) => match value.as_u64() {
            Some(value) if value <= MAX_WAIT_TIMEOUT_MS => value,
            _ => anyhow::bail!("timeout_ms must be an integer between 0 and {MAX_WAIT_TIMEOUT_MS}"),
        },
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let (owner_user_id, org_id, node_bound) = principal.filter_args();

    loop {
        let status = if is_session {
            store
                .get_session_status_visible(&target_id, owner_user_id, org_id, node_bound)
                .await?
                .map(Some)
        } else {
            store
                .get_run_status_visible(&target_id, owner_user_id, org_id, node_bound)
                .await?
        };
        match status {
            None => return Ok(not_found()),
            Some(None) => {
                return Ok(wait_result(target_field, &target_id, "not_running", false));
            }
            Some(Some(status)) if status != "running" => {
                return Ok(wait_result(target_field, &target_id, &status, false));
            }
            Some(Some(_)) => {}
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(wait_result(target_field, &target_id, "running", true));
        }
        tokio::time::sleep(WAIT_POLL_INTERVAL.min(deadline - now)).await;
    }
}

fn wait_result(target_field: &str, target_id: &str, status: &str, timed_out: bool) -> Value {
    let mut result = json!({
        "ok": true,
        "status": status,
        "timed_out": timed_out,
    });
    result[target_field] = json!(target_id);
    result
}

async fn read_thread(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let thread_id = require_str(&arguments, "thread_id")?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_READ_LIMIT))
        .unwrap_or(DEFAULT_READ_LIMIT);
    // THE GATE. `get_conversation_detail` returns DECRYPTED message bodies, so this
    // check must run BEFORE it — a non-visible thread is indistinguishable from a
    // non-existent one.
    if !can_read(store, principal, thread_id).await? {
        return Ok(not_found());
    }
    let Some(detail) = store.get_conversation_detail(thread_id).await? else {
        return Ok(not_found());
    };
    // Find this thread's run_status from the list (detail omits it).
    let (uid, org, bound) = principal.filter_args();
    let run_status = store
        .get_summary_visible(thread_id, uid, org, bound)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.run_status);
    let total = detail.messages.len();
    let messages: Vec<Value> = detail
        .messages
        .into_iter()
        .skip(total.saturating_sub(limit))
        .map(|m| {
            json!({
                "id": m.id,
                "role": m.role,
                "content": truncate(&m.content),
                "agent_id": m.agent_id,
                "created_at": m.created_at,
            })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "thread_id": thread_id,
        "title": detail.title,
        "run_status": run_status,
        "message_count": total,
        "messages": messages,
    }))
}

async fn send_message_to_thread(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    default_isolate: bool,
) -> Result<Value> {
    let thread_id = require_str(&arguments, "thread_id")?.to_owned();
    let message = require_str(&arguments, "message")?.to_owned();
    let wait = opt_bool(&arguments, "wait", false);
    let isolate = isolate_for_call(&arguments, default_isolate);
    let cwd_override = opt_str(&arguments, "cwd");

    // THE WRITE GATE. This runs a REAL agent turn against the target thread (reading
    // its history as context and appending to it), so it needs strict owner-match,
    // not mere read-visibility.
    if !principal.owns(store, &thread_id).await {
        return Ok(not_found());
    }

    let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() else {
        return Ok(json!({
            "ok": false,
            "available": false,
            "error": "agent runner is not available on this node (cannot run worker threads)",
        }));
    };

    // Resolve the worker's agent + working folder from its stored row.
    let (uid, org, bound) = principal.filter_args();
    let summary = store
        .get_summary_visible(&thread_id, uid, org, bound)
        .await?;
    let Some(summary) = summary else {
        return Ok(not_found());
    };
    let agent_id = summary.agent_id.clone();
    // Echoed back so the coordinator's transcript can label the session card
    // without a second read.
    let title = summary.title.clone();
    let cwd = cwd_override.or_else(|| summary.folder_path.clone());

    if wait {
        // Blocking: bound concurrency with a permit, run, return the reply.
        let _permit = worker_semaphore().acquire().await;
        let reply = runner
            .run_worker(agent_id.clone(), thread_id.clone(), message, cwd, isolate)
            .await?;
        return Ok(json!({
            "ok": true,
            "thread_id": thread_id,
            "title": title,
            "agent_id": agent_id,
            "reply": reply,
        }));
    }

    // Background: spawn a permit-bounded task and return immediately. The chat
    // path persists both turns and sets the terminal run_status; we only set
    // "failed" defensively on an early error that never reached the persist path.
    let sem = Arc::clone(worker_semaphore());
    let status_store = store.clone();
    let bg_thread_id = thread_id.clone();
    let reported_agent_id = agent_id.clone();
    let worker = async move {
        let _permit = sem.acquire().await;
        if let Err(e) = runner
            .run_worker(agent_id, bg_thread_id.clone(), message, cwd, isolate)
            .await
        {
            tracing::warn!("worker thread {bg_thread_id} turn failed: {e:#}");
            let _ = status_store.set_run_status(&bg_thread_id, "failed").await;
        }
    };
    // The worker turn is a sub-turn of the coordinator's: keep its attribution.
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        worker,
    ));

    Ok(json!({
        "ok": true,
        "thread_id": thread_id,
        "title": title,
        "agent_id": reported_agent_id,
        "dispatched": true,
        "status": "running",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runnable::RunnableKind;
    use crate::server::conversations::{SessionStatus, Tenancy};

    #[test]
    fn worktree_isolation_defaults_off_and_reads_saved_preference() {
        assert!(!DEFAULT_WORKTREE_ISOLATION);
        assert!(!default_worktree_isolation(None));
        assert!(!default_worktree_isolation(Some("false")));
        assert!(default_worktree_isolation(Some(" TRUE ")));
        assert!(!default_worktree_isolation(Some("unknown")));
    }

    #[test]
    fn explicit_isolation_value_overrides_saved_default() {
        assert!(isolate_for_call(&json!({}), true));
        assert!(!isolate_for_call(&json!({}), false));
        assert!(isolate_for_call(&json!({ "isolate": true }), false));
        assert!(!isolate_for_call(&json!({ "isolate": false }), true));
    }

    #[test]
    fn lists_nine_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 9);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.id.starts_with("threads.")));
        assert!(tools
            .iter()
            .any(|t| t.id == "threads.send_message_to_thread"));
        assert!(tools.iter().any(|t| t.id == "threads.wait_for_thread"));
    }

    #[tokio::test]
    async fn create_then_list_then_read_roundtrip() {
        let store = ConversationStore::open_in_memory().expect("store");
        let created = dispatch(
            "create_thread",
            json!({ "title": "Ticket 1" }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("create");
        assert_eq!(created["ok"], json!(true));
        let thread_id = created["thread_id"].as_str().expect("thread_id").to_owned();

        let listed = dispatch(
            "list_threads",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("list");
        assert_eq!(listed["count"], json!(1));
        assert_eq!(listed["threads"][0]["thread_id"], json!(thread_id));

        let read = dispatch(
            "read_thread",
            json!({ "thread_id": thread_id }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("read");
        assert_eq!(read["ok"], json!(true));
        assert_eq!(read["message_count"], json!(0));
    }

    #[tokio::test]
    async fn active_thread_list_reports_shared_workspace_overlap() {
        let store = ConversationStore::open_in_memory().expect("store");
        for id in ["active-a", "active-b", "finished"] {
            store
                .ensure_conversation(id, Some("ryu"), Some(id), owner("alice"))
                .await
                .expect("conversation");
        }
        for id in ["active-a", "active-b"] {
            store
                .set_run_status(id, "running")
                .await
                .expect("run status");
            store
                .set_run_metadata(id, Some("D:\\work\\ryu"), Some("main"), None)
                .await
                .expect("workspace metadata");
        }
        let active_session = store
            .create_session(
                "agent-session",
                RunnableKind::Agent,
                Some("agent-session"),
                Some("Runnable session"),
                owner("alice"),
            )
            .await
            .expect("create Runnable session");
        store
            .update_session_status(&active_session.id, SessionStatus::Running)
            .await
            .expect("start Runnable session");
        store
            .set_run_metadata(
                &active_session.conversation_id,
                Some("D:\\work\\ryu"),
                Some("main"),
                None,
            )
            .await
            .expect("Runnable workspace metadata");
        dispatch(
            "set_thread_archived",
            json!({ "thread_id": "active-a", "archived": true }),
            &store,
            &alice(),
        )
        .await
        .expect("archive active thread");
        store
            .set_run_status("finished", "completed")
            .await
            .expect("run status");

        let listed = dispatch(
            "list_threads",
            json!({ "active_only": true }),
            &store,
            &alice(),
        )
        .await
        .expect("list active threads");

        assert_eq!(listed["count"], json!(3));
        for thread in listed["threads"].as_array().expect("threads") {
            assert_eq!(thread["workspace_overlap"], json!(true));
            assert_eq!(thread["branch"], json!("main"));
        }
        assert!(listed["threads"].as_array().unwrap().iter().any(|thread| {
            thread["thread_id"] == "active-a" && thread["archived"] == json!(true)
        }));
        let session_thread = listed["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|thread| thread["thread_id"] == active_session.conversation_id)
            .expect("active Runnable session thread");
        assert_eq!(session_thread["run_status"], json!("running"));
        assert_eq!(
            session_thread["sessions"][0]["session_id"],
            json!(active_session.id)
        );
    }

    #[tokio::test]
    async fn wait_for_thread_observes_completion_and_timeout() {
        let store = ConversationStore::open_in_memory().expect("store");
        store
            .ensure_conversation("worker", Some("ryu"), Some("worker"), owner("alice"))
            .await
            .expect("conversation");
        store
            .set_run_status("worker", "running")
            .await
            .expect("run status");

        let timed_out = dispatch(
            "wait_for_thread",
            json!({ "thread_id": "worker", "timeout_ms": 0 }),
            &store,
            &alice(),
        )
        .await
        .expect("wait snapshot");
        assert_eq!(timed_out["status"], json!("running"));
        assert_eq!(timed_out["timed_out"], json!(true));

        let principal = alice();
        let invalid_timeout = wait_for_thread(
            json!({ "thread_id": "worker", "timeout_ms": -1 }),
            &store,
            &principal,
        )
        .await;
        assert!(invalid_timeout.is_err());

        let waiting_store = store.clone();
        let waiter = tokio::spawn(async move {
            let principal = alice();
            wait_for_thread(
                json!({ "thread_id": "worker", "timeout_ms": 1_000 }),
                &waiting_store,
                &principal,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        store
            .set_run_status("worker", "completed")
            .await
            .expect("complete run");
        let completed = waiter.await.expect("wait task").expect("wait result");
        assert_eq!(completed["status"], json!("completed"));
        assert_eq!(completed["timed_out"], json!(false));
    }

    #[tokio::test]
    async fn wait_does_not_reveal_another_users_thread() {
        let (store, alice_id, _) = two_tenant_store().await;
        let result = dispatch(
            "wait_for_thread",
            json!({ "thread_id": alice_id }),
            &store,
            &bob(),
        )
        .await
        .expect("wait dispatch");

        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("thread not found"));
    }

    #[tokio::test]
    async fn wait_accepts_a_visible_runnable_session_id() {
        let store = ConversationStore::open_in_memory().expect("store");
        let session = store
            .create_session(
                "agent-session",
                RunnableKind::Agent,
                Some("agent-session"),
                Some("worker"),
                owner("alice"),
            )
            .await
            .expect("create session");
        store
            .update_session_status(&session.id, SessionStatus::Running)
            .await
            .expect("start session");

        let current = dispatch(
            "wait_for_thread",
            json!({ "session_id": session.id, "timeout_ms": 0 }),
            &store,
            &alice(),
        )
        .await
        .expect("wait for session");
        assert_eq!(current["session_id"], json!(session.id));
        assert_eq!(current["status"], json!("running"));
        assert_eq!(current["timed_out"], json!(true));

        store
            .update_session_status(&session.id, SessionStatus::Completed)
            .await
            .expect("complete session");
        let completed = dispatch(
            "wait_for_thread",
            json!({ "session_id": session.id, "timeout_ms": 0 }),
            &store,
            &alice(),
        )
        .await
        .expect("read completed session");
        assert_eq!(completed["status"], json!("completed"));

        let hidden = dispatch(
            "wait_for_thread",
            json!({ "session_id": session.id, "timeout_ms": 0 }),
            &store,
            &bob(),
        )
        .await
        .expect("cross-tenant wait");
        assert_eq!(hidden["ok"], json!(false));
        assert_eq!(hidden["error"], json!("thread not found"));
    }

    #[tokio::test]
    async fn pin_and_archive_flags_affect_listing() {
        let store = ConversationStore::open_in_memory().expect("store");
        let a = dispatch(
            "create_thread",
            json!({ "title": "A" }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("a")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let b = dispatch(
            "create_thread",
            json!({ "title": "B" }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("b")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Pin B → it should sort first.
        dispatch(
            "set_thread_pinned",
            json!({ "thread_id": b, "pinned": true }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("pin");
        let listed = dispatch(
            "list_threads",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("list");
        assert_eq!(listed["threads"][0]["thread_id"], json!(b));

        // Archive A → excluded by default, included when asked.
        dispatch(
            "set_thread_archived",
            json!({ "thread_id": a, "archived": true }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("archive");
        let default_list = dispatch(
            "list_threads",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("list2");
        assert_eq!(default_list["count"], json!(1));
        let full_list = dispatch(
            "list_threads",
            json!({ "include_archived": true }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("list3");
        assert_eq!(full_list["count"], json!(2));
    }

    #[tokio::test]
    async fn set_title_updates_thread() {
        let store = ConversationStore::open_in_memory().expect("store");
        let id = dispatch(
            "create_thread",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("create")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        dispatch(
            "set_thread_title",
            json!({ "thread_id": id, "title": "Renamed" }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("title");
        let read = dispatch(
            "read_thread",
            json!({ "thread_id": id }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("read");
        assert_eq!(read["title"], json!("Renamed"));
    }

    #[tokio::test]
    async fn send_message_reports_unavailable_without_runner() {
        // No global agent runner is published in tests, so the tool degrades.
        let store = ConversationStore::open_in_memory().expect("store");
        let id = dispatch(
            "create_thread",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("create")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let out = dispatch(
            "send_message_to_thread",
            json!({ "thread_id": id, "message": "do the thing" }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .expect("dispatch ok");
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["available"], json!(false));
    }

    #[tokio::test]
    async fn missing_required_args_are_errors() {
        let store = ConversationStore::open_in_memory().expect("store");
        assert!(dispatch(
            "read_thread",
            json!({}),
            &store,
            &ToolPrincipal::Unrestricted
        )
        .await
        .is_err());
        assert!(dispatch(
            "set_thread_title",
            json!({ "thread_id": "x" }),
            &store,
            &ToolPrincipal::Unrestricted
        )
        .await
        .is_err());
        assert!(
            dispatch("nope", json!({}), &store, &ToolPrincipal::Unrestricted)
                .await
                .is_err()
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // THE MCP AGENT PLANE (task item 2). The hole these close, concretely: on an
    // org-bound node Bob tells his agent "read thread <alice's id>" / "list my
    // threads" / "send a message to <alice's thread>", and the tool obliges — the
    // agent plane had NO principal, so it defeated the entire HTTP ACL in one hop.
    //
    // `ToolPrincipal::Owned { bob }` is exactly what `resolve` produces on a bound
    // node from the host conversation Bob's turn is running in.
    // ══════════════════════════════════════════════════════════════════════════

    const ORG: &str = "org1";

    fn owner(user: &str) -> Tenancy {
        Tenancy::Owned {
            user_id: user.to_owned(),
            org_id: Some(ORG.to_owned()),
        }
    }

    fn bob() -> ToolPrincipal {
        ToolPrincipal::Owned {
            user_id: "bob".to_owned(),
            org_id: Some(ORG.to_owned()),
        }
    }

    fn alice() -> ToolPrincipal {
        ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some(ORG.to_owned()),
        }
    }

    /// Alice has a private thread with a distinctive secret in it; Bob has his own.
    async fn two_tenant_store() -> (ConversationStore, String, String) {
        let store = ConversationStore::open_in_memory().expect("store");
        store
            .ensure_conversation("alice-thread", None, Some("Alice Q3"), owner("alice"))
            .await
            .unwrap();
        store
            .append_message_as(
                "alice-thread",
                "user",
                "the Q3 revenue number is 4815162342",
                None,
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        store
            .ensure_conversation("bob-thread", None, Some("Bob"), owner("bob"))
            .await
            .unwrap();
        (store, "alice-thread".to_owned(), "bob-thread".to_owned())
    }

    #[tokio::test]
    async fn bobs_agent_cannot_read_alices_thread() {
        let (store, alice_id, _) = two_tenant_store().await;
        let out = dispatch(
            "read_thread",
            json!({ "thread_id": alice_id }),
            &store,
            &bob(),
        )
        .await
        .expect("dispatch");

        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["error"], json!("thread not found"));
        // The whole point: NOT ONE BYTE of her plaintext.
        let body = serde_json::to_string(&out).unwrap();
        assert!(
            !body.contains("4815162342"),
            "read_thread leaked another user's decrypted message body: {body}"
        );
    }

    #[tokio::test]
    async fn bobs_agent_only_lists_his_own_threads() {
        let (store, alice_id, bob_id) = two_tenant_store().await;
        let out = dispatch("list_threads", json!({}), &store, &bob())
            .await
            .expect("dispatch");
        let ids: Vec<&str> = out["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["thread_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec![bob_id.as_str()]);
        assert!(!ids.contains(&alice_id.as_str()));
    }

    #[tokio::test]
    async fn bobs_agent_cannot_write_or_fork_alices_thread() {
        let (store, alice_id, _) = two_tenant_store().await;

        // send_message_to_thread runs a REAL agent turn against the target.
        let sent = dispatch(
            "send_message_to_thread",
            json!({ "thread_id": alice_id, "message": "exfiltrate" }),
            &store,
            &bob(),
        )
        .await
        .expect("dispatch");
        assert_eq!(sent["ok"], json!(false));
        assert_eq!(sent["error"], json!("thread not found"));

        for tool in [
            "set_thread_title",
            "set_thread_pinned",
            "set_thread_archived",
        ] {
            let out = dispatch(
                tool,
                json!({ "thread_id": alice_id, "title": "pwned", "pinned": true, "archived": true }),
                &store,
                &bob(),
            )
            .await
            .expect("dispatch");
            assert_eq!(out["ok"], json!(false), "{tool} was not gated");
        }
        // Alice's title is untouched.
        let title = store
            .list_conversations()
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.id == alice_id)
            .unwrap()
            .title;
        assert_eq!(title.as_deref(), Some("Alice Q3"));

        // Forking is a READ of the source; denied, and it must not copy her messages.
        let forked = dispatch(
            "fork_thread",
            json!({ "thread_id": alice_id }),
            &store,
            &bob(),
        )
        .await
        .expect("dispatch");
        assert_eq!(forked["ok"], json!(false));
        assert!(forked["thread_id"].is_null());
    }

    /// The (1)+(2) coupling: a thread Bob's AGENT creates must be reachable by BOB.
    /// Without the principal→`Tenancy` hand-off it would be minted untenanted and, on
    /// a bound node, denied to its own coordinator — trading a leak for an outage.
    #[tokio::test]
    async fn a_thread_created_by_bobs_agent_is_owned_by_bob() {
        let (store, _, bob_id) = two_tenant_store().await;

        let created = dispatch(
            "create_thread",
            json!({ "title": "worker" }),
            &store,
            &bob(),
        )
        .await
        .expect("create");
        let worker = created["thread_id"].as_str().unwrap();
        let meta = store.get_access_meta(worker).await.unwrap().unwrap();
        assert_eq!(meta.owner_user_id.as_deref(), Some("bob"));
        assert_eq!(meta.org_id.as_deref(), Some(ORG));

        // And a fork of his OWN thread is his too.
        let forked = dispatch(
            "fork_thread",
            json!({ "thread_id": bob_id }),
            &store,
            &bob(),
        )
        .await
        .expect("fork");
        assert_eq!(forked["ok"], json!(true));
        let fork_id = forked["thread_id"].as_str().unwrap();
        let meta = store.get_access_meta(fork_id).await.unwrap().unwrap();
        assert_eq!(meta.owner_user_id.as_deref(), Some("bob"));

        // Bob's agent can see everything it just created.
        let listed = dispatch("list_threads", json!({}), &store, &bob())
            .await
            .expect("list");
        assert_eq!(listed["count"], json!(3));
    }

    /// FAIL CLOSED: a bound node with no resolvable principal sees nothing.
    #[tokio::test]
    async fn an_unresolved_principal_on_a_bound_node_sees_nothing() {
        let (store, alice_id, _) = two_tenant_store().await;
        let out = dispatch(
            "list_threads",
            json!({}),
            &store,
            &ToolPrincipal::Unresolved,
        )
        .await
        .expect("list");
        assert_eq!(out["count"], json!(0));
        let read = dispatch(
            "read_thread",
            json!({ "thread_id": alice_id }),
            &store,
            &ToolPrincipal::Unresolved,
        )
        .await
        .expect("read");
        assert_eq!(read["ok"], json!(false));
    }

    /// UNBOUND PARITY: `resolve_at` with no node org yields `Unrestricted`, and the
    /// tools then behave exactly as they did before the gate existed.
    #[tokio::test]
    async fn an_unbound_node_is_unrestricted_and_unchanged() {
        let (store, alice_id, _) = two_tenant_store().await;
        let principal = ToolPrincipal::resolve_at(&store, None, None).await;
        assert_eq!(principal, ToolPrincipal::Unrestricted);

        let listed = dispatch("list_threads", json!({}), &store, &principal)
            .await
            .expect("list");
        assert_eq!(
            listed["count"],
            json!(2),
            "unbound node must still see every thread"
        );

        let read = dispatch(
            "read_thread",
            json!({ "thread_id": alice_id }),
            &store,
            &principal,
        )
        .await
        .expect("read");
        assert_eq!(read["ok"], json!(true));
    }

    /// The principal really is derived from the HOST conversation's owner.
    #[tokio::test]
    async fn resolve_at_derives_the_principal_from_the_host_conversation() {
        let (store, alice_id, bob_id) = two_tenant_store().await;
        assert_eq!(
            ToolPrincipal::resolve_at(&store, Some(&bob_id), Some(ORG)).await,
            ToolPrincipal::Owned {
                user_id: "bob".to_owned(),
                org_id: Some(ORG.to_owned())
            }
        );
        assert_eq!(
            ToolPrincipal::resolve_at(&store, Some(&alice_id), Some(ORG)).await,
            ToolPrincipal::Owned {
                user_id: "alice".to_owned(),
                org_id: Some(ORG.to_owned())
            }
        );
        // No host conversation on a bound node ⇒ fail closed.
        assert_eq!(
            ToolPrincipal::resolve_at(&store, None, Some(ORG)).await,
            ToolPrincipal::Unresolved
        );
        // An UNTENANTED host conversation on a bound node ⇒ fail closed too.
        store
            .ensure_conversation("orphan", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        assert_eq!(
            ToolPrincipal::resolve_at(&store, Some("orphan"), Some(ORG)).await,
            ToolPrincipal::Unresolved
        );
    }
}
