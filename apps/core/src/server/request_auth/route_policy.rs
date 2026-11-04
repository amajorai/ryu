//! Server state, the remote-auth gate, route policy and the `require_auth` middleware: `route_policy` through `capabilities_for_managed_user`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) fn route_policy(
    method: &Method,
    path: &str,
) -> crate::authorization::RoutePolicy {
    use crate::authorization::{Capability, RoutePolicy};
    let read = matches!(*method, Method::GET | Method::HEAD);
    if path_has_prefix(path, "/api/cloud-tasks") {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path_has_prefix(path, "/api/session-boxes") || path_has_prefix(path, "/api/security-key") {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path_has_prefix(path, "/api/cloud-environments") {
        if path.ends_with("/launch") {
            return RoutePolicy::requires([Capability::GatewayRoute, Capability::ToolsExec]);
        }
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/api/ws/ticket" {
        return RoutePolicy::Authenticated;
    }
    if path_has_prefix(path, "/api/local-content") {
        // Seals local clients' own files (CLI history) with this node's key:
        // the owner only, and the handlers also require a loopback peer.
        return RoutePolicy::OwnerOnly;
    }
    if path_has_prefix(path, "/api/local-egress/route") {
        // The handlers admit only the node token or this node's owning user.
        return RoutePolicy::Authenticated;
    }
    if path == "/api/onboarding/state" || path == "/api/onboarding/skills" {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/api/language-packs/installed" {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/api/language-packs/import" {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/api/onboarding/access" || path_has_prefix(path, "/api/onboarding/profile") {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path_has_prefix(path, "/api/marketplace/packages") {
        // Package handlers perform the operation-specific node ACL check. This
        // route gate admits managed users to that check while keeping unknown
        // routes default-denied elsewhere.
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/api/preferences/user-personalization" {
        // The preference handler applies the stricter personal-node owner check;
        // GatewayRoute is only the managed-user admission step.
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path == "/mcp" || path_has_prefix(path, "/mcp") {
        return RoutePolicy::Authenticated;
    }
    if path_has_prefix(path, "/api/pair") || path == "/api/node/token/rotate" {
        return RoutePolicy::OwnerOnly;
    }
    if path_has_prefix(path, "/api/chat")
        || path_has_prefix(path, "/api/conversations")
        || path_has_prefix(path, "/api/proactive")
        || path_has_prefix(path, "/api/channels/run")
    {
        return RoutePolicy::requires([if read {
            Capability::ChatRead
        } else {
            Capability::ChatWrite
        }]);
    }
    // Admit only registered conversation hierarchy operations. Main-thread slot
    // creation, scope defaults, and memory migration remain owner-only until
    // their resource gates exist before mutation.
    if let Some(suffix) = path.strip_prefix("/api/hierarchy/") {
        let segments: Vec<_> = suffix.split('/').collect();
        let capability = match segments.as_slice() {
            ["main-threads"] if read => Some(Capability::ChatRead),
            ["threads", id] | ["threads", id, "sessions"] if read && !id.is_empty() => {
                Some(Capability::ChatRead)
            }
            ["threads", id, "project" | "coordination"]
                if *method == Method::PUT && !id.is_empty() =>
            {
                Some(Capability::ChatWrite)
            }
            ["projects", id, "threads"] if read && !id.is_empty() => Some(Capability::ChatRead),
            _ => None,
        };
        if let Some(capability) = capability {
            return RoutePolicy::requires([capability]);
        }
    }
    if let Some(agent_path) = path.strip_prefix("/api/agents/") {
        if let Some((_, operation)) = agent_path.split_once('/') {
            // Launch settings include credentials, even when read. Keep the
            // per-agent resource ACL and require management authority first.
            if operation == "acp-settings" {
                return RoutePolicy::requires([Capability::AgentsManage]);
            }
            // Native accounts are node-wide credentials; optimizer replays use
            // the node's Gateway administrator credential.
            // An agent's own Composio accounts are the same kind of node
            // credential as the user's Composio accounts, which are owner-only.
            if operation == "accounts"
                || operation.starts_with("accounts/")
                || operation == "composio"
                || operation.starts_with("composio/")
                || operation == "native-accounts"
                || operation.starts_with("native-accounts/")
                || operation == "optimizations/analyze"
            {
                return RoutePolicy::OwnerOnly;
            }
        }
    }
    if path_has_prefix(path, "/api/agents") || path_has_prefix(path, "/api/agent-ui") {
        return RoutePolicy::requires([if read {
            Capability::AgentsRead
        } else {
            Capability::AgentsManage
        }]);
    }
    if path_has_prefix(path, "/api/prompt-suites")
        || path_has_prefix(path, "/api/annotation-queues")
    {
        return RoutePolicy::requires([if read {
            Capability::AgentsRead
        } else {
            Capability::AgentsManage
        }]);
    }
    if path_has_prefix(path, "/api/workflows") || path_has_prefix(path, "/api/automations") {
        if path.ends_with("/run") || path.ends_with("/execute") {
            return RoutePolicy::requires([Capability::WorkflowsRun]);
        }
        return RoutePolicy::requires([if read {
            Capability::WorkflowsRead
        } else {
            Capability::WorkflowsManage
        }]);
    }
    if path == "/api/mcp/tools/call"
        || path == "/api/composio/events/consume"
        || path == "/api/composio/targets"
    {
        return RoutePolicy::requires([Capability::ToolsExec]);
    }
    if path == "/api/sandboxes" {
        return if read {
            RoutePolicy::requires([Capability::NodeSandboxRead])
        } else {
            RoutePolicy::OwnerOnly
        };
    }
    if path == "/api/mcp/tools" || path_has_prefix(path, "/api/tools") {
        return RoutePolicy::requires([if read {
            Capability::ToolsRead
        } else {
            Capability::ToolsExec
        }]);
    }
    if path_has_prefix(path, "/api/memory") {
        return RoutePolicy::requires([if read {
            Capability::MemoryRead
        } else {
            Capability::MemoryWrite
        }]);
    }
    if path_has_prefix(path, "/api/retrieval")
        || path_has_prefix(path, "/api/spaces")
        || path_has_prefix(path, "/api/media")
    {
        return RoutePolicy::requires([if read || path.ends_with("/search") {
            Capability::FilesRead
        } else {
            Capability::FilesWrite
        }]);
    }
    // Audit rows contain member, model, cost, and node attribution. They are
    // operator data, not ordinary inference routing, so delegated
    // `gateway:route` credentials must never inherit access to them.
    if path_has_prefix(path, "/api/gateway/batches")
        || path_has_prefix(path, "/api/gateway/audit")
        || path_has_prefix(path, "/api/gateway/phone-calls")
    {
        return RoutePolicy::OwnerOnly;
    }
    if path_has_prefix(path, "/api/usage/history") {
        // Node-local histories and explicit provider admin reports are private
        // owner data, even when a caller has ordinary agent-read permission.
        return RoutePolicy::OwnerOnly;
    }
    // A member's own usage: the handler pins the audit `user_id` filter to the
    // verified caller, so it is safe for any member who may route inference.
    if path == "/api/usage/me" {
        return RoutePolicy::requires([Capability::GatewayRoute]);
    }
    if path_has_prefix(path, "/api/gateway") {
        return if read {
            RoutePolicy::requires([Capability::GatewayRoute])
        } else {
            RoutePolicy::OwnerOnly
        };
    }
    // Dictation and read-aloud for members who may already chat. Exact paths
    // only: engine and model installs and speech processing stay owner-only, and
    // `speak` refuses voice-reference (cloning) fields for non-owners itself.
    if path == "/api/voice/transcribe" || path == "/api/voice/speak" {
        return RoutePolicy::requires([Capability::ChatWrite]);
    }
    if read && (path == "/api/voice/tts-engines" || path == "/api/voice/tts-models") {
        return RoutePolicy::requires([Capability::ChatRead]);
    }
    if path_has_prefix(path, "/api/vault") {
        // Reading metadata remains routable, but a scoped OAuth client needs
        // explicit vault-write consent before any value can be changed.
        // `subkeys` is a GET that decrypts the value to derive its key
        // structure, so it needs the same consent as `reveal` (a POST). The
        // other GETs below release secret or key material outright: transit
        // key export and backup, a static role's current password, a live
        // TOTP code, and a password generated from a policy.
        let decrypting_read = (path.starts_with("/api/vault/secrets/")
            && path.ends_with("/subkeys"))
            || (path.starts_with("/api/vault/sys/password-policies/")
                && path.ends_with("/generate"))
            || [
                "/api/vault/transit/export/",
                "/api/vault/transit/backup/",
                "/api/vault/static/creds/",
                "/api/vault/totp/code/",
            ]
            .iter()
            .any(|prefix| path.starts_with(prefix));
        return RoutePolicy::requires([if read && !decrypting_read {
            Capability::GatewayRoute
        } else {
            Capability::VaultWrite
        }]);
    }
    RoutePolicy::OwnerOnly
}

/// Lower the built-in organization role into the capability vocabulary used by
/// Core's route and MCP method gates. Custom permissions remain enforced by the
/// handler-level organization checks; this mapping is the safe baseline needed
/// before a request can reach a handler at all.
pub(in crate::server) fn capabilities_for_managed_user(
    role: crate::identity_verify::OrgRole,
) -> crate::authorization::CapabilitySet {
    use crate::authorization::Capability;
    use crate::identity_verify::permissions;

    let mut capabilities = Vec::new();
    if permissions::can(role, permissions::SPACE_READ) {
        capabilities.extend([
            Capability::ChatRead,
            Capability::ToolsRead,
            Capability::MemoryRead,
            Capability::FilesRead,
        ]);
    }
    if permissions::can(role, permissions::SPACE_WRITE) {
        capabilities.extend([
            Capability::ChatWrite,
            Capability::MemoryWrite,
            Capability::FilesWrite,
        ]);
    }
    if permissions::can(role, permissions::AGENT_VIEW) {
        capabilities.push(Capability::AgentsRead);
    }
    if permissions::can(role, permissions::AGENT_EDIT) {
        capabilities.push(Capability::AgentsManage);
    }
    if permissions::can(role, permissions::WORKFLOW_VIEW) {
        capabilities.push(Capability::WorkflowsRead);
    }
    if permissions::can(role, permissions::WORKFLOW_RUN) {
        capabilities.push(Capability::WorkflowsRun);
    }
    if permissions::can(role, permissions::WORKFLOW_EDIT) {
        capabilities.push(Capability::WorkflowsManage);
    }
    if permissions::can(role, permissions::TOOL_EXEC) {
        capabilities.push(Capability::ToolsExec);
    }
    if permissions::can(role, permissions::GATEWAY_VIEW) {
        capabilities.push(Capability::GatewayRoute);
    }
    if permissions::can(role, permissions::SPACE_WRITE) {
        capabilities.push(Capability::VaultWrite);
    }
    crate::authorization::CapabilitySet::new(capabilities)
}
