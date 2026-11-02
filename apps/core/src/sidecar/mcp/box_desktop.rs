//! Session Box tool routing: `computer.*` and `browser.*` on a conversation's
//! own Box screen (design §7.4), and the sub-agent Box scope (design §7.5).
//!
//! The capability facade in [`super`] hands every machine verb of a
//! conversation to [`route`] **before** it resolves the node's provider. When
//! the conversation has (or may acquire) a session Box, the verb runs on that
//! Box through [`call`]: `computer.*` becomes one canonical desktop action on
//! `POST /v1/boxes/:id/desktop/actions`, `browser.*` one
//! `POST /v1/boxes/:id/browser/:verb`. The call goes straight to
//! [`BoxSessionClient`]; it never re-enters the registry's dispatch core, so the
//! cloud-task gate is evaluated exactly once per call.
//!
//! The Box is chosen only from Core state: the verified caller of the turn, the
//! server-derived conversation owner, and the sub-agent child registry below.
//! The canonical verb schemas carry `additionalProperties: false`, and
//! [`plan`] rejects any argument outside them, so a model can never name a Box,
//! a URL, or a session.
//!
//! What stays on the node: owners whose `session-box-computer-target`
//! preference is `node`, callers that may not acquire a Box (rollout flag off,
//! no Box endpoint, a Box service without a desktop), and on an unbound node
//! (the self-hosted local owner) calls without a conversation. Those return
//! `None` from [`route`] and keep today's provider path.
//!
//! A run with no verified chat caller (a scheduled or automation run, an
//! agent-to-agent, voice, plugin-bridge or bot run, or a system call on an
//! org-bound node) has no authority to start a Box. On a node that puts
//! computer use on session Boxes it fails closed with
//! [`NO_TURN_AUTHORITY_REFUSAL`]: it never drives the node's display instead.
//!
//! A conversation whose machine verbs run on a Box never drives the node's
//! display through any other tool either: Shadow computer use and the raw
//! tools of every `local-machine` computer or browser provider (Ghost, Codex
//! computer use, the Chromium sidecar, …) are withheld from its tool list
//! ([`node_display_servers`]) and refused by [`conversation_gate`].

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};

use super::capability_tools::{self, CAP_BROWSER, CAP_COMPUTER};
use super::ToolPrincipal;
use crate::plugin_manifest::ProviderTarget;
use crate::server::conversations::ConversationStore;
use crate::server::session_box::{self, AcquireReason, BoxTarget, SessionBoxKey};
use crate::server::ResolvedAuthorization;
use ryu_sandbox::box_session::BoxSessionClient;
use ryu_sandbox::box_types::BoxApiError;

#[cfg(test)]
#[path = "box_desktop_tests.rs"]
mod tests;

mod resolution;
mod routing;
mod subagent;

pub(crate) use resolution::*;
pub(crate) use routing::*;
pub(crate) use subagent::*;

/// The provider id the session Box answers machine verbs as.
pub(crate) const PROVIDER_ID: &str = "session-box";
/// The owner of a conversation on an unbound node with no verified user.
const NODE_OWNER: &str = "node-owner";
/// Node-local computer-use tools that act on the node's own display. They are
/// refused in a conversation whose machine verbs go to a Box.
pub(crate) const NODE_COMPUTER_USE_TOOLS: &[&str] = &["shadow.computer_use"];
/// How long a turn's verified caller is remembered for its conversation.
const AUTHORITY_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Most remembered turn authorities and registered sub-agent conversations.
const MAX_REMEMBERED: usize = 4096;

/// What the session Box serves, for the layer picker and the provider target
/// invariant (`the_two_computer_control_providers_do_not_claim_the_same_machine`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProviderDescriptor {
    pub id: &'static str,
    pub capabilities: &'static [&'static str],
    /// A session Box is a separate machine, never this node's display.
    pub target: ProviderTarget,
}

/// The session Box's provider descriptor.
pub(crate) fn provider_descriptor() -> ProviderDescriptor {
    ProviderDescriptor {
        id: PROVIDER_ID,
        capabilities: &[CAP_COMPUTER, CAP_BROWSER],
        target: ProviderTarget::RemoteDesktop,
    }
}

/// The tool namespace every app's tools share; a binding into it names one
/// tool, never a whole server.
const SHARED_APP_NAMESPACE: &str = "app";

/// What drives this node's own display: every MCP server a `computer.control`
/// or `browser.control` provider with the `local-machine` target binds its
/// verbs to (Ghost's `ghost`, Codex computer use's `codex_cu`, the Chromium
/// sidecar's `chromium`, …), or, for a binding into the shared `app.`
/// namespace, that one tool id. A `remote-desktop` provider (Bytebot, a
/// hosted browser) acts on another machine and is not listed.
pub(crate) fn node_display_servers(
    manifests: &[crate::plugin_manifest::PluginManifest],
) -> std::collections::BTreeSet<String> {
    manifests
        .iter()
        .flat_map(|manifest| manifest.provides.iter())
        .filter(|entry| {
            (entry.capability == CAP_COMPUTER || entry.capability == CAP_BROWSER)
                && entry.target == Some(ProviderTarget::LocalMachine)
        })
        .flat_map(|entry| entry.tools.values())
        .filter_map(|binding| {
            let (server, _) = binding.tool.split_once('.')?;
            match server {
                "" => None,
                SHARED_APP_NAMESPACE => Some(binding.tool.clone()),
                server => Some(server.to_owned()),
            }
        })
        .collect()
}

// ── Turn authority ───────────────────────────────────────────────────────────

struct Remembered {
    authority: Arc<ResolvedAuthorization>,
    at: Instant,
}

/// `(conversation id, owner)`: one remembered turn authority per principal
/// of a conversation, so a collaborator's turn never replaces the owner's.
type AuthorityKey = (String, String);

#[derive(Default)]
struct AuthorityTable {
    entries: HashMap<AuthorityKey, Remembered>,
    order: VecDeque<AuthorityKey>,
}

fn authorities() -> MutexGuard<'static, AuthorityTable> {
    static TABLE: OnceLock<Mutex<AuthorityTable>> = OnceLock::new();
    TABLE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Remember the verified caller of a conversation's current turn.
///
/// Tool calls reach the registry without the HTTP request that started the
/// turn (an ACP agent calls back through the MCP bridge on another task), so
/// the chat route records the turn's [`ResolvedAuthorization`] here, under the
/// principal it speaks for. Machine verbs of that conversation, and of its
/// sub-agents, acquire the conversation owner's Box with the owner's own
/// remembered authority: the rollout flag, the signed plan cap and the owner
/// check all read it. Which owner a conversation's Box belongs to never comes
/// from this table while the conversation has a stored owner, so a
/// collaborator's later turn can neither move the owner's in-flight tool calls
/// onto the collaborator's Box nor lend its authority to the owner's Box.
pub(crate) fn remember_turn_authority(
    conversation_id: &str,
    authority: Arc<ResolvedAuthorization>,
) {
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        return;
    }
    let Ok(owner) = session_box::owner_of(&authority) else {
        return;
    };
    let key = (conversation_id.to_owned(), owner);
    let mut table = authorities();
    let now = Instant::now();
    table
        .entries
        .retain(|_, remembered| now.duration_since(remembered.at) < AUTHORITY_TTL);
    let AuthorityTable { entries, order } = &mut *table;
    order.retain(|id| entries.contains_key(id) && *id != key);
    while entries.len() >= MAX_REMEMBERED {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        entries.remove(&oldest);
    }
    entries.insert(key.clone(), Remembered { authority, at: now });
    order.push_back(key);
}

/// The remembered caller of `conversation_id`'s turn that speaks for `owner`,
/// if still fresh.
fn remembered_authority(conversation_id: &str, owner: &str) -> Option<Arc<ResolvedAuthorization>> {
    let table = authorities();
    let remembered = table
        .entries
        .get(&(conversation_id.to_owned(), owner.to_owned()))?;
    (remembered.at.elapsed() < AUTHORITY_TTL).then(|| Arc::clone(&remembered.authority))
}

/// The owner of a conversation with no stored row, from the turns remembered
/// for it: the one principal whose turn is remembered, or `None` when there
/// is none or several (never guess between principals).
fn sole_remembered_owner(conversation_id: &str) -> Option<String> {
    let table = authorities();
    let mut owners = table.entries.iter().filter(|((id, _), remembered)| {
        id == conversation_id && remembered.at.elapsed() < AUTHORITY_TTL
    });
    let ((_, owner), _) = owners.next()?;
    owners.next().is_none().then(|| owner.clone())
}

/// The authority a Box for `key` is acquired with: the remembered caller of
/// the conversation's turn that speaks for `key.owner`, else the node owner
/// for a node-owner conversation (an unbound node, where only the node's Box
/// configuration gates a local owner).
#[cfg(test)]
fn authority_for(key: &SessionBoxKey) -> Option<Arc<ResolvedAuthorization>> {
    authority_for_conversation(key, &key.conversation_id)
}

/// [`authority_for`] for a call made in `conversation_id`, which differs from
/// `key.conversation_id` for a sub-agent (a thread worker the user later chats
/// in directly). The coordinator's remembered turn is tried first; when it has
/// expired, the sub-agent's own turn for the same owner stands in, so that
/// worker can still acquire its Box.
fn authority_for_conversation(
    key: &SessionBoxKey,
    conversation_id: &str,
) -> Option<Arc<ResolvedAuthorization>> {
    if let Some(authority) = remembered_authority(&key.conversation_id, &key.owner)
        .or_else(|| remembered_authority(conversation_id, &key.owner))
    {
        return Some(authority);
    }
    (key.owner == NODE_OWNER).then(|| Arc::new(crate::server::shadow_proxy::node_owner_authority()))
}
