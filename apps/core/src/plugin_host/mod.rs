//! The plugin turn-hook runtime.
//!
//! This is the code-execution layer that makes features like double-check and
//! goal **real installable plugins** rather than hardcoded Core endpoints. A
//! plugin declares a `post_assistant_turn` hook (`contributes.turn_hooks` in its
//! `manifest.json`); the hook is plugin-authored JS run in the **same deny-by-default
//! JS sandbox** the PTC tool-exec uses ([`crate::tool_exec`]). The hook reaches
//! Core only through capability-gated host functions:
//!
//! - `host.sideModel({ prompt, system?, model?, model_pref_key?, effort? })` →
//!   one non-streaming gateway completion (grant `hook:side-model`). The model is
//!   resolved swappably (explicit → pref key → env → local default), never
//!   hardcoded; the call is gateway-governed inside `call_side_model`.
//! - `host.runAgent({ task, agent_id?, preset?, wall_time_secs?, max_tokens? })` →
//!   spawn ONE full sub-agent with a clean context and return its final text
//!   (grant `hook:run-agent`). Routes through the delegation engine
//!   ([`crate::workflow::delegation`]): with a live agent runner the sub-agent runs
//!   the real chat path (its own engine, tools, MCP, Gateway routing), so it can
//!   gather actual evidence instead of judging from the transcript. This is the
//!   "proof of work" primitive that the `proof` plugin builds on.
//! - `host.storage.{get,set,delete,keys,compareAndSet}(key, value?)` → the plugin's own
//!   namespaced KV ([`crate::plugin_storage`]), grant `storage:kv`.
//! - `host.spaces.{ensureSpace,createDoc,getDoc,updateDoc,listDocs,deleteDoc}` →
//!   the plugin's OWN Space documents (`kind = app:<plugin id>`, so it can never
//!   read or write a page/database/whiteboard or another app's doc), grant
//!   `spaces:docs`. `ensureSpace({name})` is what makes the rest reachable from a
//!   hook at all: every other method needs a `space_id`, ids are uuids, and a
//!   headless caller has no route parameter to read one from. Writes go through
//!   the ordinary document path, so a hook's ledger is flattened, re-embedded and
//!   retrievable like anything else in the Space.
//! - `host.log(...)` → captured logs.
//!
//! The hook returns a **directive** the chat path applies:
//! `{kind:"none"}` | `{kind:"note", text}` (surface to the user, not in history)
//! | `{kind:"continue", text}` (inject a follow-up user turn and loop) |
//! `{kind:"replace", text}` (a `pre_user_turn` hook rewrites the outgoing user
//! message before it reaches the model — the auto-expand prompt-improver).
//!
//! Placement (Core vs Gateway): a turn hook decides *what runs next* → Core. Any
//! model call it makes still routes through the Gateway. The sandbox grants
//! capabilities; the Gateway governs every model call.
//!
//! Availability: the sandbox is built in (`js-sandbox`). In a build without it the
//! runtime no-ops (logged), so chat is never blocked — same graceful-degrade
//! posture as the Python `external_runtime` plugins.

pub mod action_stream;
pub mod breaker;
mod bridge;
mod hook_program;
pub(crate) use bridge::node_owner_or_admin;

pub use action_stream::ActionFrameProbe;
pub use bridge::{dispatch_path_for, PluginHookBridge};

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::server::ServerState;
use crate::tool_exec::{self, ExecOutcome, SandboxToolInvoker};
#[cfg(test)]
use hook_program::{build_hook_program, build_middleware_hook_program};
use hook_program::{build_hook_program_in, build_middleware_hook_program_in};

// Split by responsibility; every item keeps its `plugin_host::` path through
// the re-exports below.
mod app_events;
mod context;
mod dispatch;
mod lifecycle_events;
mod middleware;
mod phases;
mod run;
mod view_actions;

#[allow(unused_imports)]
pub use self::{
    app_events::*, context::*, dispatch::*, lifecycle_events::*, middleware::*, phases::*, run::*,
    view_actions::*,
};

#[cfg(test)]
mod hooks_runtime_tests;

#[cfg(test)]
mod agent_comms_delivery_runtime_test;

#[cfg(test)]
mod agent_comms_storage_bridge_test;

#[cfg(test)]
mod chat_title_runtime_test;

#[cfg(test)]
mod agent_react_runtime_test;

#[cfg(test)]
mod tests;
