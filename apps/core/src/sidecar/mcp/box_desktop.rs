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

// ── Sub-agent scope ──────────────────────────────────────────────────────────

/// The conversation whose `delegate.*` or `threads.*` call is running, so the
/// sub-agents it starts get their own child Boxes (`<conversation>#sub:<n>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubagentScope {
    pub owner: String,
    pub parent_conversation_id: String,
}

tokio::task_local! {
    /// Set by the registry around a `delegate.*` or `threads.*` dispatch.
    static SUBAGENT_BOX_SCOPE: SubagentScope;
}

/// The sub-agent scope of the running task, if any.
pub(crate) fn current_subagent_scope() -> Option<SubagentScope> {
    SUBAGENT_BOX_SCOPE.try_with(Clone::clone).ok()
}

/// Run `future` with `scope` as its sub-agent scope. `None` runs it unscoped.
/// Use it to carry the scope across a `tokio::spawn`, which does not inherit
/// task-locals.
pub(crate) async fn with_subagent_scope<F: std::future::Future>(
    scope: Option<SubagentScope>,
    future: F,
) -> F::Output {
    match scope {
        Some(scope) => SUBAGENT_BOX_SCOPE.scope(scope, future).await,
        None => future.await,
    }
}

#[derive(Default)]
struct ChildTable {
    keys: HashMap<String, SessionBoxKey>,
    order: VecDeque<String>,
}

fn children() -> MutexGuard<'static, ChildTable> {
    static TABLE: OnceLock<Mutex<ChildTable>> = OnceLock::new();
    TABLE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The child key a sub-agent conversation was registered under.
fn child_key(conversation_id: &str) -> Option<SessionBoxKey> {
    children().keys.get(conversation_id).cloned()
}

/// `conversation#sub:n` for a registered sub-agent conversation.
#[cfg(test)]
pub(crate) fn child_session_id(conversation_id: &str) -> Option<String> {
    child_key(conversation_id).map(|key| key.session_id())
}

/// A conversation was deleted: forget every sub-agent registered under it, so a
/// thread worker of the deleted coordinator stops resolving to its tombstoned
/// Box. The child Boxes themselves are released with the conversation.
pub(crate) fn forget_children_of(parent_conversation_id: &str) {
    let mut table = children();
    let ChildTable { keys, order } = &mut *table;
    keys.retain(|_, key| key.conversation_id != parent_conversation_id);
    order.retain(|id| keys.contains_key(id));
}

/// Register `child_conversation_id` as the next sub-agent of `scope`. Its
/// machine verbs then run on the child Box `parent#sub:n` (or on the parent's
/// Box when the plan cap refuses another one). Registering the same
/// conversation again returns its existing key. The child takes the lowest
/// number no running sub-agent holds; with all of them held it shares the
/// parent's Box (design §7.5) rather than another child's.
pub(crate) fn register_child_conversation(
    scope: &SubagentScope,
    child_conversation_id: &str,
) -> Option<SessionBoxKey> {
    if child_conversation_id == scope.parent_conversation_id
        || !crate::sidecar::adapters::acp::is_safe_host_conversation_id(child_conversation_id)
    {
        return None;
    }
    let mut table = children();
    if let Some(existing) = table.keys.get(child_conversation_id) {
        return Some(existing.clone());
    }
    let key = match session_box::next_child_index(&scope.owner, &scope.parent_conversation_id) {
        Some(index) => SessionBoxKey::child(&scope.owner, &scope.parent_conversation_id, index),
        None => SessionBoxKey::session(&scope.owner, &scope.parent_conversation_id),
    };
    let ChildTable { keys, order } = &mut *table;
    while keys.len() >= MAX_REMEMBERED {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        keys.remove(&oldest);
    }
    keys.insert(child_conversation_id.to_owned(), key.clone());
    order.push_back(child_conversation_id.to_owned());
    Some(key)
}

/// A sub-agent conversation finished (a delegate's turn ended): forget it,
/// park its child Box and free its number for the next sub-agent.
pub(crate) async fn release_child_conversation(child_conversation_id: &str) {
    let key = {
        let mut table = children();
        let ChildTable { keys, order } = &mut *table;
        let Some(key) = keys.remove(child_conversation_id) else {
            return;
        };
        order.retain(|id| id != child_conversation_id);
        key
    };
    if key.child.is_some() {
        session_box::release_child(&key).await;
    }
}

/// Register `child_conversation_id` under the running task's sub-agent scope.
/// The delegation engine calls this when it starts a delegate's turn.
pub(crate) fn bind_child_conversation(child_conversation_id: &str) -> Option<SessionBoxKey> {
    let scope = current_subagent_scope()?;
    register_child_conversation(&scope, child_conversation_id)
}

/// The scope sub-agents started from `host_conversation_id` belong to. A
/// sub-agent that starts its own sub-agents shares its root conversation's
/// counter, so every child of a session is numbered once.
pub(crate) async fn subagent_scope_for(
    store: Option<&ConversationStore>,
    host_conversation_id: Option<&str>,
) -> Option<SubagentScope> {
    let conversation_id = host_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if let Some(key) = child_key(conversation_id) {
        return Some(SubagentScope {
            owner: key.owner,
            parent_conversation_id: key.conversation_id,
        });
    }
    let owner = conversation_owner(store, conversation_id).await?;
    Some(SubagentScope {
        owner,
        parent_conversation_id: conversation_id.to_owned(),
    })
}

// ── Resolution ───────────────────────────────────────────────────────────────

/// The owner of a conversation as Core derives it: the stored owner (the same
/// rule the cloud tool arm applies). Only a conversation with no stored row
/// takes it from the one principal whose turn is remembered. A later writer
/// (a collaborator with write access) never changes it.
async fn conversation_owner(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> Option<String> {
    let meta = match store {
        Some(store) => match store.get_access_meta(conversation_id).await {
            Ok(meta) => meta,
            Err(_) => return None,
        },
        None => None,
    };
    let Some(meta) = meta else {
        return sole_remembered_owner(conversation_id);
    };
    let principal = ToolPrincipal::resolve_optional(store, Some(conversation_id)).await;
    match (principal, meta.owner_user_id) {
        (ToolPrincipal::Owned { user_id, .. }, Some(owner)) if user_id == owner => {
            Some(format!("user:{owner}"))
        }
        (ToolPrincipal::Unrestricted, Some(owner)) => Some(format!("user:{owner}")),
        (ToolPrincipal::Unrestricted, None) => Some(NODE_OWNER.to_owned()),
        _ => None,
    }
}

/// Which Box key a conversation's machine verbs use, and why.
struct Resolved {
    key: SessionBoxKey,
    reason: AcquireReason,
}

async fn resolve(store: Option<&ConversationStore>, conversation_id: &str) -> Option<Resolved> {
    if let Some(key) = child_key(conversation_id) {
        // A sub-agent conversation with a stored row must still belong to the
        // owner it was registered for.
        let stored = match store {
            Some(store) => store.get_access_meta(conversation_id).await.ok().flatten(),
            None => None,
        };
        if stored.is_some() {
            let owner = conversation_owner(store, conversation_id).await;
            if owner.as_deref() != Some(key.owner.as_str()) {
                return None;
            }
        }
        return Some(Resolved {
            key,
            reason: AcquireReason::SubAgent,
        });
    }
    let owner = conversation_owner(store, conversation_id).await?;
    Some(Resolved {
        key: SessionBoxKey::session(&owner, conversation_id),
        reason: AcquireReason::ComputerUse,
    })
}

#[cfg(test)]
fn bound_for_test() -> MutexGuard<'static, std::collections::HashSet<String>> {
    static BOUND: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    BOUND
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the conversation is bound to a cloud task ("cloud tools only").
async fn conversation_is_bound(conversation_id: &str) -> bool {
    #[cfg(test)]
    if bound_for_test().contains(conversation_id) {
        return true;
    }
    crate::server::cloud_tasks::has_bound_task(conversation_id).await
}

/// Whether the machine verbs of `conversation_id` go to a Box: it (or, for a
/// sub-agent, its parent) has a session Box or a cloud task Box.
async fn machine_verbs_route_to_box(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> bool {
    let Some(resolved) = resolve(store, conversation_id).await else {
        return false;
    };
    session_box::routes_to_box(&resolved.key).await
}

#[cfg(test)]
tokio::task_local! {
    /// Counts gate evaluations of the calls made inside its scope.
    pub(super) static GATE_PROBE: Arc<std::sync::atomic::AtomicUsize>;
}

/// The conversation gate of the registry's dispatch core. Returns the refusal
/// for `tool_id` in `conversation_id`, or `None` to let it run.
///
/// - A cloud-task conversation runs only its cloud tools, plus `computer.*`
///   and `browser.*` when they are routed to its Box.
/// - A conversation whose machine verbs go to a Box never drives the node's
///   own display: not through Shadow computer use, and not through a node
///   display provider's raw tool (`drives_node_display`, which the registry
///   sets from [`node_display_servers`] for a direct call; a capability facade
///   dispatch the Box router left on the node is not one).
pub(crate) async fn conversation_gate(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    tool_id: &str,
    drives_node_display: bool,
) -> Option<&'static str> {
    #[cfg(test)]
    let _ = GATE_PROBE.try_with(|probe| probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    if super::cloud::is_tool(tool_id) {
        return None;
    }
    if (drives_node_display || NODE_COMPUTER_USE_TOOLS.contains(&tool_id))
        && machine_verbs_route_to_box(store, conversation_id).await
    {
        return Some(NODE_COMPUTER_USE_REFUSAL);
    }
    if !conversation_is_bound(conversation_id).await {
        return None;
    }
    if capability_tools::is_machine_verb(tool_id)
        && machine_verbs_route_to_box(store, conversation_id).await
    {
        return None;
    }
    Some(CLOUD_TOOLS_ONLY_REFUSAL)
}

/// The refusal of a non-cloud tool in a cloud-task conversation.
pub(crate) const CLOUD_TOOLS_ONLY_REFUSAL: &str =
    "Cloud tasks may execute only their isolated cloud tools";
/// The refusal of node computer use in a conversation that runs on a Box.
pub(crate) const NODE_COMPUTER_USE_REFUSAL: &str =
    "This conversation's computer use runs on its session Box; use the computer.* and browser.* tools instead of computer use on the node";
/// The refusal of computer use in a run with no verified chat caller, on a
/// node that puts computer use on session Boxes.
pub(crate) const NO_TURN_AUTHORITY_REFUSAL: &str =
    "Computer use and the browser run on a session Box on this node, and this run has no verified chat caller to start one (a scheduled, automation, agent-to-agent, voice, plugin or bot run). Run it from a conversation, or set the computer target to the node";

/// Whether `conversation_id`'s tool list withholds the node display tools:
/// its machine verbs run on a Box.
pub(crate) async fn withholds_node_display(
    store: Option<&ConversationStore>,
    conversation_id: Option<&str>,
) -> bool {
    match conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(conversation_id) => machine_verbs_route_to_box(store, conversation_id).await,
        None => false,
    }
}

/// Whether the computer use of `conversation_id`, as `owner` sees it, runs on
/// a Box. Production code decides this per conversation through [`resolve`]
/// ([`conversation_gate`]); this owner-keyed form is for tests.
#[cfg(test)]
pub(crate) async fn owner_routes_to_box(owner: &str, conversation_id: &str) -> bool {
    match child_key(conversation_id) {
        Some(key) if key.owner == owner => session_box::routes_to_box(&key).await,
        Some(_) => false,
        None => session_box::routes_to_box(&SessionBoxKey::session(owner, conversation_id)).await,
    }
}

// ── Cloud task turns ─────────────────────────────────────────────────────────

/// The function name a cloud task turn offers a machine verb under:
/// `box_computer_click` for `computer.click` (function names cannot hold a
/// dot, and the prefix keeps them apart from the `cloud_*` tools).
pub(crate) fn cloud_machine_tool_name(verb_id: &str) -> String {
    format!("box_{}", verb_id.replace('.', "_"))
}

/// The machine verb a cloud task turn's function name stands for, if any.
pub(crate) fn cloud_machine_verb(name: &str) -> Option<&'static str> {
    name.strip_prefix("box_")?;
    capability_tools::verbs()
        .iter()
        .filter(|verb| capability_tools::is_machine_verb(verb.id))
        .find(|verb| cloud_machine_tool_name(verb.id) == name)
        .map(|verb| verb.id)
}

// ── Routing ──────────────────────────────────────────────────────────────────

/// Run a machine verb of a conversation on its session Box.
///
/// `None` means "not a Box call": not a machine verb, no conversation, no
/// resolvable owner, or a caller who keeps the node (see the module docs). The
/// facade then resolves the node's provider as before.
pub(crate) async fn route(
    store: Option<&ConversationStore>,
    host_conversation_id: Option<&str>,
    tool_id: &str,
    arguments: &Value,
) -> Option<Result<Value>> {
    if !capability_tools::is_machine_verb(tool_id) {
        return None;
    }
    let conversation_id = host_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let resolved = match conversation_id {
        Some(conversation_id) => resolve(store, conversation_id).await,
        None => None,
    };
    let (Some(conversation_id), Some(resolved)) = (conversation_id, resolved) else {
        return unattributed(store, conversation_id).await.map(Err);
    };
    // Refuse arguments outside the canonical schema before any Box is acquired.
    if let Err(error) = plan(tool_id, arguments) {
        return Some(Err(error));
    }
    let target = match target_for(&resolved, conversation_id).await {
        Ok(Some(target)) => target,
        Ok(None) => return None,
        Err(error) => return Some(Err(error)),
    };
    let result = call(&target, tool_id, arguments.clone()).await;
    session_box::touch(&resolved.key).await;
    Some(result)
}

/// A machine verb with no Box key: no conversation, or one whose owner Core
/// cannot derive (an org-bound node's system call, an untenanted
/// conversation). On an unbound node a call without a conversation is the
/// local owner's and keeps the node (design §7.4). Otherwise there is no
/// verified caller to start a Box, so on a node that puts computer use on
/// session Boxes the call fails closed rather than driving the node display.
async fn unattributed(
    store: Option<&ConversationStore>,
    conversation_id: Option<&str>,
) -> Option<anyhow::Error> {
    let principal = ToolPrincipal::resolve_optional(store, conversation_id).await;
    if conversation_id.is_none() && principal == ToolPrincipal::Unrestricted {
        return None;
    }
    session_box::computer_use_goes_to_boxes()
        .await
        .then(|| anyhow!(NO_TURN_AUTHORITY_REFUSAL))
}

/// The Box a resolved conversation's verb runs on, acquiring one when the
/// caller may. `Ok(None)` keeps the call on the node.
async fn target_for(resolved: &Resolved, conversation_id: &str) -> Result<Option<BoxTarget>> {
    let key = &resolved.key;
    if let Some(authority) = authority_for_conversation(key, conversation_id) {
        return match session_box::desktop_target(&authority, key, Some(resolved.reason)).await {
            Ok(Some(target)) => Ok(Some(target)),
            Ok(None) if conversation_is_bound(conversation_id).await => Err(anyhow!(
                "This cloud conversation's Box is not available; stop and resume the session"
            )),
            // A conversation that has a Box (its own, its parent's, or this
            // child's) never falls back to the node's display: the caller
            // may not acquire one right now (an expired turn token, a failed
            // Box credential), which a new message fixes.
            Ok(None)
                if session_box::routes_to_box(key).await
                    && session_box::computer_target_is_auto().await =>
            {
                Err(anyhow!(
                    "This conversation's session Box is not available for this turn; send the message again from the conversation"
                ))
            }
            Ok(None) => Ok(None),
            Err(refusal) => Err(refusal_error(&refusal)),
        };
    }
    // Without the turn's verified caller only an existing cloud task Box may be
    // used: its owner is server-derived, and nothing is created.
    if key.child.is_none() {
        if let Some(target) =
            crate::server::cloud_tasks::bound_box(&key.owner, &key.conversation_id).await
        {
            return Ok(Some(target));
        }
    }
    if session_box::routes_to_box(key).await || conversation_is_bound(conversation_id).await {
        return Err(anyhow!(
            "This conversation's session Box needs the verified caller of the turn; send the message again from the conversation"
        ));
    }
    // No chat turn of the owner is remembered: a scheduled, automation,
    // agent-to-agent, voice, plugin-bridge or bot run on a stored
    // conversation. It may not start a Box, and on a node that puts computer
    // use on Boxes it never falls back to the node's display.
    if session_box::computer_use_goes_to_boxes().await {
        return Err(anyhow!(NO_TURN_AUTHORITY_REFUSAL));
    }
    Ok(None)
}

/// A session Box route refusal (`(status, {error:{code,message}})`) as a
/// model-facing error.
fn refusal_error(refusal: &session_box::ApiError) -> anyhow::Error {
    let error = &refusal.1 .0["error"];
    let code = error["code"].as_str().unwrap_or("session_box_unavailable");
    let message = error["message"]
        .as_str()
        .unwrap_or("The session Box could not be used.");
    match error["retryAfter"].as_u64() {
        Some(seconds) => anyhow!("{message} ({code}; retry after {seconds}s)"),
        None => anyhow!("{message} ({code})"),
    }
}

/// One machine verb, checked against its canonical schema.
#[derive(Clone, Debug, PartialEq)]
enum Planned {
    /// A canonical desktop action for `/desktop/actions`.
    Desktop(Value),
    /// A browser verb and its body for `/browser/:verb`.
    Browser { verb: &'static str, body: Value },
}

/// Check `arguments` against the verb's canonical schema and build the Box
/// request. Fields the schema does not declare are refused: a model cannot
/// name a Box, URL or session.
fn plan(tool_id: &str, arguments: &Value) -> Result<Planned> {
    let verb = capability_tools::verb_by_id(tool_id)
        .filter(|verb| verb.capability == CAP_COMPUTER || verb.capability == CAP_BROWSER)
        .ok_or_else(|| anyhow!("'{tool_id}' is not a computer or browser verb"))?;
    let arguments = match arguments {
        Value::Null => Map::new(),
        Value::Object(map) => map.clone(),
        _ => bail!("{} arguments must be an object", verb.id),
    };
    check_against_schema(verb.id, &(verb.schema)(), &arguments)?;
    if verb.capability == CAP_BROWSER {
        return Ok(Planned::Browser {
            verb: verb.name,
            body: Value::Object(arguments),
        });
    }
    let action = match verb.name {
        "capture" => "screenshot",
        other => other,
    };
    let mut body = Map::with_capacity(arguments.len() + 1);
    body.insert("action".to_owned(), Value::String(action.to_owned()));
    body.extend(arguments);
    Ok(Planned::Desktop(Value::Object(body)))
}

/// The top-level checks of a canonical verb schema: declared fields only,
/// required fields present, JSON types and enums respected.
fn check_against_schema(
    verb_id: &str,
    schema: &Value,
    arguments: &Map<String, Value>,
) -> Result<()> {
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    for (name, value) in arguments {
        let Some(property) = properties.get(name) else {
            bail!("{verb_id} does not accept '{name}'; the target comes from the conversation");
        };
        if value.is_null() {
            continue;
        }
        if !matches_type(property, value) {
            bail!("{verb_id}: '{name}' has the wrong type");
        }
        if let Some(allowed) = property["enum"].as_array() {
            if !allowed.contains(value) {
                bail!("{verb_id}: '{name}' is not one of the allowed values");
            }
        }
    }
    for required in schema["required"].as_array().into_iter().flatten() {
        let Some(name) = required.as_str() else {
            continue;
        };
        if arguments.get(name).is_none_or(Value::is_null) {
            bail!("{verb_id} requires '{name}'");
        }
    }
    Ok(())
}

fn matches_type(property: &Value, value: &Value) -> bool {
    match property["type"].as_str() {
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_number(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("object") => value.is_object(),
        Some("array") => value.as_array().is_some_and(|items| {
            property["items"]["type"].as_str() != Some("string")
                || items.iter().all(Value::is_string)
        }),
        _ => true,
    }
}

/// Run one machine verb on the Box of `target` (design §7.4 table). Calls the
/// Box service directly, never the registry.
pub(crate) async fn call(target: &BoxTarget, verb: &str, args: Value) -> Result<Value> {
    let planned = plan(verb, &args)?;
    let client = session_box::box_client()
        .await
        .map_err(|error| anyhow!("Ryu Box is not configured on this node: {error}"))?;
    execute(&client, target, &planned).await
}

async fn execute(
    client: &BoxSessionClient,
    target: &BoxTarget,
    planned: &Planned,
) -> Result<Value> {
    match planned {
        Planned::Desktop(action) => {
            let raw = client
                .desktop_action(&target.box_id, action)
                .await
                .map_err(|error| box_error("desktop action", &error))?;
            Ok(desktop_result(raw))
        }
        Planned::Browser { verb, body } => {
            let raw = client
                .browser_call(&target.box_id, verb, body)
                .await
                .map_err(|error| box_error("browser", &error))?;
            Ok(json!({
                "provider": PROVIDER_ID,
                "target": "remote-desktop",
                "verb": verb,
                "result": raw.get("result").cloned().unwrap_or(Value::Null),
            }))
        }
    }
}

/// The Box's desktop action answer without its envelope: the screenshot
/// fields (`image`, `encoding`, `mime`, `width`, `height`, …) or nothing.
fn desktop_result(raw: Value) -> Value {
    let mut fields = match raw {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    fields.remove("ok");
    fields.remove("type");
    fields.insert("provider".to_owned(), Value::String(PROVIDER_ID.to_owned()));
    fields.insert(
        "target".to_owned(),
        Value::String("remote-desktop".to_owned()),
    );
    Value::Object(fields)
}

fn box_error(what: &str, error: &BoxApiError) -> anyhow::Error {
    match error {
        BoxApiError::Http {
            status,
            code,
            message,
        } => anyhow!("The session Box {what} failed ({status} {code}): {message}"),
        other => refusal_error(&session_box::box_api_error(other)),
    }
}
