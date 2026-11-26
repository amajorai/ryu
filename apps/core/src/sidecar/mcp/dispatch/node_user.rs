//! Tools that act as the node's own user, and who may call them on a shared node.
//!
//! Three kinds of tool reach past the person who sent a turn, to the user the
//! node itself runs as: a tool whose backend is handed one of the node's stored
//! credentials in a child process, a tool that drives that user's desktop or
//! browser session, and a tool that reads what was captured from their screen,
//! audio and input. On a node that bounds its members such a tool runs only
//! when every person Core can name for the call holds
//! [`NODE_USER_TOOL_PERMISSION`] on the node. A call that names nobody is
//! refused, and so is every such call on a managed node that is not registered
//! yet. A personal node is not touched.
//!
//! The rule sits in the dispatch core, which every tool plane reaches. The
//! gated entry asks it once more, early, only so a call that will be refused is
//! not queued for approval first.

use crate::identity_verify::VerifiedCaller;
use crate::sidecar::control_plane::{RegisteredNode, ResolvedPermissions};
use crate::sidecar::mcp::*;

/// The permission that lets a person use these tools on a shared node. It lives
/// in this one constant so a key of its own is a one-line change.
pub(crate) const NODE_USER_TOOL_PERMISSION: &str =
    crate::identity_verify::permissions::NODES_MANAGE;

/// The sentence every refusal of this rule carries.
pub(crate) const NODE_USER_TOOL_REFUSAL: &str =
    "On a shared node such a tool runs only for people who manage the node";

/// What makes a tool act as the node's own user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeUserToolClass {
    /// A stored credential reaches a child process, or the tool hands one back.
    Credential,
    /// The tool drives the desktop or the browser session of the node's user.
    DesktopOrBrowser,
    /// The tool reads what was captured from their screen, audio and input.
    Captures,
}

impl NodeUserToolClass {
    fn words(self) -> &'static str {
        match self {
            Self::Credential => "uses a credential stored on this node",
            Self::DesktopOrBrowser => {
                "controls the desktop or the browser of the user this node runs as"
            }
            Self::Captures => {
                "reads what was captured from the screen, audio and input of the user this node runs as"
            }
        }
    }
}

/// Why a call is refused. No reason names a person, a folder or a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    NodeNotRegistered,
    Nobody,
    SenderUnknown,
    EarlierSenderUnknown,
    NotHeld,
    Unavailable,
}

impl Refusal {
    fn words(self) -> &'static str {
        match self {
            Self::NodeNotRegistered => "this node is not registered with its organization yet",
            Self::Nobody => "this call names no person",
            Self::SenderUnknown => "the person who sent this turn is not known",
            Self::EarlierSenderUnknown => {
                "this agent session also served a turn whose sender is not known"
            }
            Self::NotHeld => "a person this call acts for does not hold that permission",
            Self::Unavailable => "the current permissions of a person could not be read",
        }
    }
}

/// The capabilities whose local-machine provider drives the desktop or the
/// browser session of the node's own user.
const NODE_SESSION_CAPABILITIES: &[&str] = &[
    capability_tools::CAP_COMPUTER,
    capability_tools::CAP_BROWSER,
    "browser.session",
];

/// Whether an app drives the desktop or the browser session of the node's own
/// user, judged from what its manifest provides on this machine. A provider
/// that acts on another machine (a hosted browser, a session Box) does not.
pub(in crate::sidecar::mcp) fn manifest_drives_node_session(manifest: &PluginManifest) -> bool {
    manifest.provides.iter().any(|entry| {
        NODE_SESSION_CAPABILITIES
            .iter()
            .any(|capability| entry.capability == *capability)
            && entry.target == Some(crate::plugin_manifest::ProviderTarget::LocalMachine)
    })
}

/// The class of an app tool, from its resolved backend and what its manifest
/// declares. No tool name and no app id decides it.
pub(in crate::sidecar::mcp) fn app_tool_class(
    backend: &crate::plugin_manifest::schema::ToolBackend,
    returns_credential: bool,
    manifest_drives_session: bool,
) -> Option<NodeUserToolClass> {
    use crate::plugin_manifest::schema::ToolBackend;
    match backend {
        ToolBackend::Http { url, .. } if url_reads_desktop_captures(url) => {
            return Some(NodeUserToolClass::Captures);
        }
        ToolBackend::Command { env, .. }
            if env
                .values()
                .any(|source| source_references_user_secret(source)) =>
        {
            return Some(NodeUserToolClass::Credential);
        }
        _ => {}
    }
    if returns_credential {
        return Some(NodeUserToolClass::Credential);
    }
    manifest_drives_session.then_some(NodeUserToolClass::DesktopOrBrowser)
}

/// The class of a configured MCP server's tools, from its stored config: a
/// local (stdio) server that is handed a saved key, or a server of an app that
/// drives the node user's session. A remote server that carries a key in a
/// header is in no class; the organization's tool policy governs it.
pub(in crate::sidecar::mcp) fn server_config_class(
    config: &McpServerConfig,
    owner_drives_session: bool,
) -> Option<NodeUserToolClass> {
    if config.transport_kind() == McpTransportKind::Stdio && config_references_user_secret(config) {
        return Some(NodeUserToolClass::Credential);
    }
    owner_drives_session.then_some(NodeUserToolClass::DesktopOrBrowser)
}

/// Everyone Core can name for one call.
#[derive(Default)]
struct People {
    /// The verified bearer of a direct call.
    caller: Option<VerifiedCaller>,
    /// The verified sender of the live turn, when one is bound.
    sender: Option<VerifiedCaller>,
    /// Everyone the calling ACP instance has served, on its bridge only.
    instance: Option<authenticated_scope::InstanceSenders>,
    /// The owner of the host conversation, known by user id only.
    owner: Option<String>,
}

#[cfg(test)]
tokio::task_local! {
    /// People a test lets the by-user-id lookup find, so no test asks the
    /// control plane.
    static TEST_PEOPLE: Vec<VerifiedCaller>;
}

/// Run `future` with `people` as the answer of the by-user-id lookup.
#[cfg(test)]
pub(crate) async fn with_test_people<F: std::future::Future>(
    people: Vec<VerifiedCaller>,
    future: F,
) -> F::Output {
    TEST_PEOPLE.scope(people, future).await
}

/// Whether this node bounds what its members may reach: a registered Org or
/// Team node, or a managed node that is not registered yet.
fn node_bounds_members() -> bool {
    crate::server::chat_checkpoints::turn_folders::node_bounds_turn_folders()
}

fn holds_permission(
    node: &RegisteredNode,
    person: VerifiedCaller,
    resolved: ResolvedPermissions,
) -> bool {
    crate::server::enforce_permission_on_resolved(
        &Some(person),
        NODE_USER_TOOL_PERMISSION,
        crate::acl::KIND_NODE,
        &node.node_id,
        resolved,
    )
    .is_ok()
}

/// The current membership and permissions of a person known by user id only.
/// Every failure is an error, which the rule turns into a refusal.
async fn current_person(user_id: &str) -> Result<(VerifiedCaller, ResolvedPermissions)> {
    #[cfg(test)]
    if let Ok(people) = TEST_PEOPLE.try_with(Clone::clone) {
        return people
            .into_iter()
            .find(|person| person.user_id == user_id)
            .map(|person| (person, ResolvedPermissions::default()))
            .ok_or_else(|| anyhow!("no such person"));
    }
    crate::sidecar::control_plane::resolve_current_principal(user_id).await
}

/// Why `people` may not use a tool of the three classes on this bounded node,
/// or `None` when every one of them holds the permission.
async fn refusal_for(client: &reqwest::Client, people: People) -> Option<Refusal> {
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return Some(Refusal::NodeNotRegistered);
    };
    // The owner of a conversation is not proof of who sent the turn in it:
    // another person with write access can send one. Without a verified
    // caller or a bound sender the person behind this call is not known.
    if people.owner.is_some() && people.caller.is_none() && people.sender.is_none() {
        return Some(Refusal::SenderUnknown);
    }
    let mut verified: Vec<VerifiedCaller> = Vec::new();
    verified.extend(people.caller);
    verified.extend(people.sender);
    if let Some(instance) = people.instance {
        // The bridge outlives a turn, so a call may belong to an earlier turn
        // than the live one. Everyone the instance served has to hold it.
        if instance.served_without_sender {
            return Some(Refusal::EarlierSenderUnknown);
        }
        verified.extend(instance.senders);
    }
    if verified.is_empty() && people.owner.is_none() {
        return Some(Refusal::Nobody);
    }
    for person in &verified {
        let resolved = Box::pin(crate::sidecar::control_plane::resolve_permission_context(
            client,
            &person.user_id,
        ))
        .await;
        if !holds_permission(&node, person.clone(), resolved) {
            return Some(Refusal::NotHeld);
        }
    }
    // The owner is asked by user id unless a verified caller above already
    // answered for the same person.
    let owner = people
        .owner
        .filter(|owner| !verified.iter().any(|person| &person.user_id == owner));
    if let Some(owner) = owner {
        let Ok((person, resolved)) = Box::pin(current_person(&owner)).await else {
            return Some(Refusal::Unavailable);
        };
        if person.user_id != owner || !holds_permission(&node, person, resolved) {
            return Some(Refusal::NotHeld);
        }
    }
    None
}

fn refusal_text(subject: &str, refusal: Refusal) -> String {
    format!(
        "{subject}. {NODE_USER_TOOL_REFUSAL} (permission {NODE_USER_TOOL_PERMISSION}), and {}",
        refusal.words()
    )
}

/// The Recipes recorder taps the input of the node's own user through a helper
/// Core starts itself, outside the registry, so the dispatch core never sees it.
/// On a bounded node it is refused unless its caller is known and holds the
/// permission. `Err` carries the refusal text.
pub(crate) async fn enforce_node_user_recorder_access(
    client: &reqwest::Client,
    caller: Option<&VerifiedCaller>,
) -> std::result::Result<(), String> {
    if !node_bounds_members() {
        return Ok(());
    }
    let people = People {
        caller: caller.cloned(),
        ..People::default()
    };
    match refusal_for(client, people).await {
        None => Ok(()),
        Some(refusal) => Err(refusal_text(
            "recording taps the input of the user this node runs as",
            refusal,
        )),
    }
}

impl McpRegistry {
    async fn plugin_drives_node_session(&self, plugin_id: &str) -> bool {
        let Some(manifests) = self.self_build_manifests.as_ref() else {
            return false;
        };
        manifests
            .read()
            .await
            .iter()
            .find(|manifest| manifest.id == plugin_id)
            .is_some_and(manifest_drives_node_session)
    }

    /// The class of the tool that really runs for `tool_id`, or `None`. A
    /// facade verb and an app alias re-enter the dispatch core with their
    /// target's id, so each is judged there, on the tool that runs.
    pub(in crate::sidecar::mcp) async fn node_user_tool_class(
        &self,
        tool_id: &str,
    ) -> Option<NodeUserToolClass> {
        if self.app_tool_serves_call(tool_id).await {
            if let Some(resolved) = self.resolve_app_tool_backend(tool_id).await {
                let drives = self.plugin_drives_node_session(&resolved.plugin_id).await;
                let class = app_tool_class(&resolved.backend, resolved.returns_credential, drives);
                if class.is_some() {
                    return class;
                }
            }
        } else if let Some(server) = self.external_mcp_server_for(tool_id) {
            let config = self
                .servers
                .read()
                .ok()
                .and_then(|servers| servers.get(server).cloned());
            if let Some(config) = config {
                let drives = match config.owner_plugin_id.as_deref() {
                    Some(plugin_id) => self.plugin_drives_node_session(plugin_id).await,
                    None => false,
                };
                let class = server_config_class(&config, drives);
                if class.is_some() {
                    return class;
                }
            }
        }
        self.drives_node_display(tool_id)
            .await
            .then_some(NodeUserToolClass::DesktopOrBrowser)
    }

    /// Refuse a tool that acts as the node's own user unless every person Core
    /// can name for this call may use such tools on this node.
    pub(in crate::sidecar::mcp) async fn enforce_node_user_tool_access(
        &self,
        tool_id: &str,
        host_conversation_id: Option<&str>,
    ) -> Result<()> {
        if !node_bounds_members() {
            return Ok(());
        }
        let Some(class) = self.node_user_tool_class(tool_id).await else {
            return Ok(());
        };
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let people = People {
            caller: authenticated_scope::current_verified_caller(),
            sender: authenticated_scope::current_turn_sender(),
            instance: authenticated_scope::current_instance_senders(),
            owner: match principal {
                ToolPrincipal::Owned { user_id, .. } => Some(user_id),
                ToolPrincipal::Unrestricted | ToolPrincipal::Unresolved => None,
            },
        };
        let Some(refusal) = refusal_for(&self.http, people).await else {
            return Ok(());
        };
        // The audit line goes to the node's Gateway; a test never sends one.
        #[cfg(not(test))]
        crate::org_policy::record_denial("node_user_tool.refused", tool_id, refusal.words());
        Err(anyhow!(refusal_text(
            &format!("tool '{tool_id}' {}", class.words()),
            refusal
        )))
    }
}

#[cfg(test)]
#[path = "../tests/node_user_fixtures.rs"]
pub(crate) mod fixtures;

#[cfg(test)]
#[path = "../tests/node_user_classes.rs"]
mod class_tests;

#[cfg(test)]
#[path = "../tests/dispatch_node_user.rs"]
mod dispatch_tests;
