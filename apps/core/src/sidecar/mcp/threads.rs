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

use super::{RegistryTool, ToolPrincipal};
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
    match tool {
        "create_thread" => create_thread(arguments, store, principal).await,
        "list_threads" => list_threads(arguments, store, principal).await,
        "read_thread" => read_thread(arguments, store, principal).await,
        "send_message_to_thread" => send_message_to_thread(arguments, store, principal).await,
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
    // Was `list_conversations()` — the UNFILTERED, every-row-on-the-node listing.
    // Now filtered in SQL by the same predicate the REST list uses.
    let (uid, org, bound) = principal.filter_args();
    let mut convs = store.list_conversations_visible(uid, org, bound).await?;
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
        .list_conversations_visible(uid, org, bound)
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

async fn send_message_to_thread(
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let thread_id = require_str(&arguments, "thread_id")?.to_owned();
    let message = require_str(&arguments, "message")?.to_owned();
    let wait = opt_bool(&arguments, "wait", false);
    let isolate = opt_bool(&arguments, "isolate", true);
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
        .list_conversations_visible(uid, org, bound)
        .await?
        .into_iter()
        .find(|c| c.id == thread_id);
    let Some(summary) = summary else {
        return Ok(not_found());
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
    use crate::server::conversations::Tenancy;

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
