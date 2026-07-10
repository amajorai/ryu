//! Built-in coordinator-threads tools (`threads__*`) — Codex-style cross-thread
//! orchestration.
//!
//! A single *coordinator* agent thread can spin up and manage *worker* threads:
//! create a thread, list/read threads, send a message that runs a worker's agent
//! (optionally in the background, in its own git worktree), and pin / archive /
//! title threads. In Ryu a Codex "thread" is a [`ConversationStore`] conversation,
//! so workers are durable, searchable, and resumable exactly like any chat.
//!
//! Registered as a reserved registry server (`threads`) like spider/exa/
//! search_conversations, so the `<server>__<tool>` id scheme, per-agent allowlist,
//! catalog search, and the single `call_tool` entry all work for free — and it is
//! allowlist-gated + audited on BOTH planes (ACP + openai-compat). Only an agent
//! whose allowlist grants `threads__*` can coordinate, so the capability is opt-in
//! per agent.
//!
//! The hard tool is `send_message_to_thread`: it appends the instruction to a
//! *worker* conversation and runs *that conversation's configured agent* with
//! `persist = true` (both the user instruction and the assistant reply land in the
//! worker's history, so the coordinator can read them back). By default it runs in
//! the **background** and returns immediately — the whole point of the feature is
//! to "work on a lot more at once"; the coordinator polls with `read_thread`.
//! Each worker runs in its own per-conversation git worktree so parallel workers
//! never collide in the same checkout.
//!
//! Background concurrency is bounded by a process-global semaphore
//! ([`MAX_CONCURRENT_WORKERS`]) so a coordinator (or a worker that itself holds the
//! tool) cannot fan out without limit.

use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::RegistryTool;
use crate::server::conversations::ConversationStore;

/// Reserved registry server name for the built-in coordinator-threads provider.
pub const SERVER_NAME: &str = "threads";

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
            "include_archived": { "type": "boolean", "description": "Include archived threads (default false)." }
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
            "thread_id": { "type": "string", "description": "Id of the worker thread to instruct." },
            "message": { "type": "string", "description": "The instruction to send. The worker's agent runs and its reply is persisted to the worker thread." },
            "wait": { "type": "boolean", "description": "Block until the worker replies and return the reply (default false: run in the background and return immediately so you can dispatch more work)." },
            "isolate": { "type": "boolean", "description": "Run in a dedicated git worktree when cwd is a repo (default true), so parallel workers never collide." },
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
        id: format!("{SERVER_NAME}__{name}"),
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
            "List threads with their status, title, message count, and pinned/archived flags. Pinned threads sort first.",
            list_threads_schema(),
        ),
        def(
            "read_thread",
            "Read the most recent messages of a thread (the worker's transcript) plus its run status. Use to check a worker's progress and result.",
            read_thread_schema(),
        ),
        def(
            "send_message_to_thread",
            "Send an instruction to a worker thread and run its agent. Runs in the background by default (returns immediately so you can dispatch more work); poll read_thread for the result. Each worker runs in its own git worktree.",
            send_message_schema(),
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

/// Dispatch a `threads` tool call. `store` is the wired conversation store. A
/// malformed call returns `Err`; an unavailable dependency (no agent runner)
/// returns an `ok:false` envelope so the agent can degrade gracefully.
pub async fn dispatch(tool: &str, arguments: Value, store: &ConversationStore) -> Result<Value> {
    match tool {
        "create_thread" => create_thread(arguments, store).await,
        "list_threads" => list_threads(arguments, store).await,
        "read_thread" => read_thread(arguments, store).await,
        "send_message_to_thread" => send_message_to_thread(arguments, store).await,
        "set_thread_title" => {
            let id = require_str(&arguments, "thread_id")?;
            let title = require_str(&arguments, "title")?;
            store.set_title(id, title).await?;
            Ok(json!({ "ok": true, "thread_id": id, "title": title }))
        }
        "set_thread_pinned" => {
            let id = require_str(&arguments, "thread_id")?;
            let pinned = opt_bool(&arguments, "pinned", true);
            store.set_pinned(id, pinned).await?;
            Ok(json!({ "ok": true, "thread_id": id, "pinned": pinned }))
        }
        "set_thread_archived" => {
            let id = require_str(&arguments, "thread_id")?;
            let archived = opt_bool(&arguments, "archived", true);
            store.set_archived(id, archived).await?;
            Ok(json!({ "ok": true, "thread_id": id, "archived": archived }))
        }
        "fork_thread" => {
            let id = require_str(&arguments, "thread_id")?;
            let up_to = opt_str(&arguments, "up_to_message_id");
            match store.fork_conversation(id, up_to.as_deref()).await? {
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

async fn create_thread(arguments: Value, store: &ConversationStore) -> Result<Value> {
    let title = opt_str(&arguments, "title");
    let agent_id = opt_str(&arguments, "agent_id");
    let cwd = opt_str(&arguments, "cwd");
    let thread_id = uuid::Uuid::new_v4().to_string();
    store
        .ensure_conversation(&thread_id, agent_id.as_deref(), title.as_deref())
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

async fn list_threads(arguments: Value, store: &ConversationStore) -> Result<Value> {
    let include_archived = opt_bool(&arguments, "include_archived", false);
    let mut convs = store.list_conversations().await?;
    if !include_archived {
        convs.retain(|c| !c.archived);
    }
    // Pinned first, otherwise preserve the store's most-recently-updated order.
    convs.sort_by(|a, b| b.pinned.cmp(&a.pinned));
    let threads: Vec<Value> = convs
        .into_iter()
        .map(|c| {
            json!({
                "thread_id": c.id,
                "title": c.title,
                "agent_id": c.agent_id,
                "run_status": c.run_status,
                "message_count": c.message_count,
                "pinned": c.pinned,
                "archived": c.archived,
                "folder_path": c.folder_path,
                "worktree_path": c.worktree_path,
                "updated_at": c.updated_at,
            })
        })
        .collect();
    let count = threads.len();
    Ok(json!({ "ok": true, "threads": threads, "count": count }))
}

async fn read_thread(arguments: Value, store: &ConversationStore) -> Result<Value> {
    let thread_id = require_str(&arguments, "thread_id")?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_READ_LIMIT))
        .unwrap_or(DEFAULT_READ_LIMIT);
    let Some(detail) = store.get_conversation_detail(thread_id).await? else {
        return Ok(json!({ "ok": false, "error": "thread not found" }));
    };
    // Find this thread's run_status from the list (detail omits it).
    let run_status = store
        .list_conversations()
        .await
        .ok()
        .and_then(|convs| convs.into_iter().find(|c| c.id == thread_id))
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

async fn send_message_to_thread(arguments: Value, store: &ConversationStore) -> Result<Value> {
    let thread_id = require_str(&arguments, "thread_id")?.to_owned();
    let message = require_str(&arguments, "message")?.to_owned();
    let wait = opt_bool(&arguments, "wait", false);
    let isolate = opt_bool(&arguments, "isolate", true);
    let cwd_override = opt_str(&arguments, "cwd");

    let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() else {
        return Ok(json!({
            "ok": false,
            "available": false,
            "error": "agent runner is not available on this node (cannot run worker threads)",
        }));
    };

    // Resolve the worker's agent + working folder from its stored row.
    let summary = store
        .list_conversations()
        .await?
        .into_iter()
        .find(|c| c.id == thread_id);
    let Some(summary) = summary else {
        return Ok(json!({ "ok": false, "error": "thread not found" }));
    };
    let agent_id = summary.agent_id.clone();
    let cwd = cwd_override.or_else(|| summary.folder_path.clone());

    if wait {
        // Blocking: bound concurrency with a permit, run, return the reply.
        let _permit = worker_semaphore().acquire().await;
        let reply = runner
            .run_worker(agent_id, thread_id.clone(), message, cwd, isolate)
            .await?;
        return Ok(json!({ "ok": true, "thread_id": thread_id, "reply": reply }));
    }

    // Background: spawn a permit-bounded task and return immediately. The chat
    // path persists both turns and sets the terminal run_status; we only set
    // "failed" defensively on an early error that never reached the persist path.
    let sem = Arc::clone(worker_semaphore());
    let status_store = store.clone();
    let bg_thread_id = thread_id.clone();
    tokio::spawn(async move {
        let _permit = sem.acquire().await;
        if let Err(e) = runner
            .run_worker(agent_id, bg_thread_id.clone(), message, cwd, isolate)
            .await
        {
            tracing::warn!("worker thread {bg_thread_id} turn failed: {e:#}");
            let _ = status_store.set_run_status(&bg_thread_id, "failed").await;
        }
    });

    Ok(json!({
        "ok": true,
        "thread_id": thread_id,
        "dispatched": true,
        "status": "running",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_eight_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.id.starts_with("threads__")));
        assert!(tools
            .iter()
            .any(|t| t.id == "threads__send_message_to_thread"));
    }

    #[tokio::test]
    async fn create_then_list_then_read_roundtrip() {
        let store = ConversationStore::open_in_memory().expect("store");
        let created = dispatch("create_thread", json!({ "title": "Ticket 1" }), &store)
            .await
            .expect("create");
        assert_eq!(created["ok"], json!(true));
        let thread_id = created["thread_id"].as_str().expect("thread_id").to_owned();

        let listed = dispatch("list_threads", json!({}), &store)
            .await
            .expect("list");
        assert_eq!(listed["count"], json!(1));
        assert_eq!(listed["threads"][0]["thread_id"], json!(thread_id));

        let read = dispatch("read_thread", json!({ "thread_id": thread_id }), &store)
            .await
            .expect("read");
        assert_eq!(read["ok"], json!(true));
        assert_eq!(read["message_count"], json!(0));
    }

    #[tokio::test]
    async fn pin_and_archive_flags_affect_listing() {
        let store = ConversationStore::open_in_memory().expect("store");
        let a = dispatch("create_thread", json!({ "title": "A" }), &store)
            .await
            .expect("a")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let b = dispatch("create_thread", json!({ "title": "B" }), &store)
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
        )
        .await
        .expect("pin");
        let listed = dispatch("list_threads", json!({}), &store)
            .await
            .expect("list");
        assert_eq!(listed["threads"][0]["thread_id"], json!(b));

        // Archive A → excluded by default, included when asked.
        dispatch(
            "set_thread_archived",
            json!({ "thread_id": a, "archived": true }),
            &store,
        )
        .await
        .expect("archive");
        let default_list = dispatch("list_threads", json!({}), &store)
            .await
            .expect("list2");
        assert_eq!(default_list["count"], json!(1));
        let full_list = dispatch("list_threads", json!({ "include_archived": true }), &store)
            .await
            .expect("list3");
        assert_eq!(full_list["count"], json!(2));
    }

    #[tokio::test]
    async fn set_title_updates_thread() {
        let store = ConversationStore::open_in_memory().expect("store");
        let id = dispatch("create_thread", json!({}), &store)
            .await
            .expect("create")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        dispatch(
            "set_thread_title",
            json!({ "thread_id": id, "title": "Renamed" }),
            &store,
        )
        .await
        .expect("title");
        let read = dispatch("read_thread", json!({ "thread_id": id }), &store)
            .await
            .expect("read");
        assert_eq!(read["title"], json!("Renamed"));
    }

    #[tokio::test]
    async fn send_message_reports_unavailable_without_runner() {
        // No global agent runner is published in tests, so the tool degrades.
        let store = ConversationStore::open_in_memory().expect("store");
        let id = dispatch("create_thread", json!({}), &store)
            .await
            .expect("create")["thread_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let out = dispatch(
            "send_message_to_thread",
            json!({ "thread_id": id, "message": "do the thing" }),
            &store,
        )
        .await
        .expect("dispatch ok");
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["available"], json!(false));
    }

    #[tokio::test]
    async fn missing_required_args_are_errors() {
        let store = ConversationStore::open_in_memory().expect("store");
        assert!(dispatch("read_thread", json!({}), &store).await.is_err());
        assert!(
            dispatch("set_thread_title", json!({ "thread_id": "x" }), &store)
                .await
                .is_err()
        );
        assert!(dispatch("nope", json!({}), &store).await.is_err());
    }
}
