//! Denylist of security-critical routes no agent may call through the self-API.

// ── Denylist (security-critical; reviewable, one comment per entry) ───────────

/// Path prefixes excluded for **every** verb. Non-negotiable.
pub(super) const DENIED_PREFIXES: &[&str] = &[
    // Auth / session — an agent must never drive login/logout/device flow.
    "/api/auth/",
    // Credential vault — never expose stored secrets or their lifecycle.
    "/api/identity/",
    "/api/identities",
    "/api/vault",
    // Capability broker — cross-app privilege escalation surface.
    "/api/host/",
    // Mesh/node control — loopback self-API must not mint or expose peer
    // credentials on behalf of the calling agent.
    "/api/mesh/",
    // The unified tool routes themselves — recursion (search/describe/exec).
    "/api/tools/",
    // Rule discovery accepts a filesystem root. It remains available to the
    // authenticated desktop route, but must not become an agent-controlled
    // loopback file browser through CoreApi.
    "/api/rules/",
];

/// Exact paths excluded for every verb.
pub(super) const DENIED_EXACT: &[&str] = &[
    // The spec route — an agent enumerating the spec to self-expand is pointless
    // recursion and leaks the full surface in one call.
    "/api/openapi.json",
    // The generic MCP tool-invoke route — recursion into tool dispatch.
    "/api/mcp/tools/call",
    // Live Gateway traffic is an SSE feed; a request/response loopback would
    // hang until the timeout.
    "/api/gateway/traffic",
    // Pruning the audit log would let an agent erase the record of what it did.
    "/api/gateway/audit/prune",
    // Provider API keys and the web/speech service accounts are credentials.
    // Like the vault, their lifecycle stays in Settings, where the user types
    // the secret into a field instead of into a chat transcript.
    "/api/gateway/providers",
    "/api/gateway/web-accounts",
    "/api/gateway/cloud-speech-accounts",
    // Hook policy overrides can switch off safety hooks (DLP, approvals). Git
    // and worktree governance stay reachable; this resolved path is caught at
    // dispatch, after the `{kind}` parameter is substituted.
    "/api/gateway/governance/hooks",
    "/api/hooks/overrides",
    // The widget tool bridge runs a tool as the widget instance's agent, and the
    // per-agent MCP endpoint runs one as the agent in its path: both are tool
    // dispatch recursion that would skip the calling agent's own policy. Opening
    // an MCP App runs its entrypoint tool as the agent named in the body, so it
    // is the same recursion.
    "/api/widgets/tools/call",
    "/api/widgets/open",
    "/mcp/{agent_id}",
    // Answers an in-chat permission prompt. On an unbound node an agent could
    // otherwise grant its own pending request (the same self-approval the
    // `/api/approvals/` rule below closes).
    "/api/chat/permission",
];

/// Exact paths whose create/update verbs (POST/PUT/PATCH) are excluded. They
/// write an agent's identity mode and account allowlist, or attach one of the
/// user's connected accounts to an agent. The loopback runs with node power, so
/// an agent limited to its own identity (or to some accounts) could otherwise
/// widen its own access, mint an unrestricted agent, or bind itself to the
/// user's account events, all without the review `configure_agent` requires.
pub(super) const DENIED_AGENT_ACCESS_WRITES: &[&str] = &[
    "/api/agents",
    "/api/agents/{id}",
    "/api/agents/import",
    "/api/agents/published/install",
    "/api/composio/targets",
    "/api/composio/triggers",
    "/api/composio/triggers/subscribe",
];

/// Path prefixes whose writes (every verb but GET) manage the user's account
/// connections or credentials. A prefix matches the path itself or anything
/// below it at a segment boundary. The loopback carries no verified user, so
/// these would connect, re-key or tear down the user's own accounts (the
/// default Composio entity, provider keys and sign-ins, sealed vault values)
/// with node power, for every agent including one that acts as the user. The
/// sanctioned way to connect an account is the `consent.connect_app` card,
/// which the user completes from the desktop. Reads (status, lists) stay.
pub(super) const DENIED_CREDENTIAL_WRITE_PREFIXES: &[&str] = &[
    // Composio connections on the user's entity: initiate, complete, any `/{id}`.
    "/api/composio/connections",
    // Model-provider keys, accounts, pools, checks, sign-ins.
    "/api/pi-config/providers",
    // Provider sign-in sessions.
    "/api/pi-config/login",
    // Gateway BYOK provider keys.
    "/api/gateway/providers",
    // Seals a GitHub token, or imported shell variables, into the user's vault.
    "/api/cloud-environments/github",
    "/api/cloud-environments/import",
    // Pairs a managed chat bot to the user's channels.
    "/api/channels/managed-bot",
    // Mints the backup recovery credential.
    "/api/backups/recovery-key",
];

/// Exact paths whose writes manage credentials (see
/// [`DENIED_CREDENTIAL_WRITE_PREFIXES`]). `/api/pi-config` writes the managed
/// Pi `auth.json` in direct-provider mode; `/api/cloud-environments` replaces
/// templates together with their sealed vault values.
pub(super) const DENIED_CREDENTIAL_WRITE_EXACT: &[&str] =
    &["/api/pi-config", "/api/cloud-environments"];

/// `(method, path)` writes under a denied prefix that change a setting, not a
/// credential, and so stay available. Toggling whether one of a provider's
/// models is offered stores no key or sign-in. The method is part of the match
/// so a resolved `DELETE /api/pi-config/providers/{id}` can never reach it.
pub(super) const ALLOWED_SETTING_WRITES: &[(&str, &str)] = &[
    ("post", "/api/pi-config/providers/model-enabled"),
    // Re-applies the saved provider revision to the running Gateway without
    // changing any credential bytes.
    ("post", "/api/gateway/providers/apply"),
];

/// Segments after `/api/plugins/<id>/` (and its `/api/apps/<id>/` alias)
/// whose writes manage a plugin's MCP sign-ins (`auth`), stored secrets
/// (`secrets`) or the permissions the user granted it (`grants`).
pub(super) const DENIED_PLUGIN_CREDENTIAL_SEGMENTS: &[&str] = &["auth", "secrets", "grants"];

/// Segments after `/api/agents/<id>/` whose writes sign an agent runtime in or
/// out, or switch or remove its accounts.
pub(super) const DENIED_AGENT_LOGIN_SEGMENTS: &[&str] =
    &["accounts", "native-accounts", "authenticate"];

/// Whether `(path, method)` is a write that connects, re-keys or removes one of
/// the user's accounts or credentials. GET is never a credential write. Works on
/// route templates and on resolved paths alike.
pub(super) fn is_credential_write(path: &str, method: &str) -> bool {
    if method.eq_ignore_ascii_case("get") {
        return false;
    }
    if ALLOWED_SETTING_WRITES
        .iter()
        .any(|(verb, allowed)| method.eq_ignore_ascii_case(verb) && path == *allowed)
    {
        return false;
    }
    if DENIED_CREDENTIAL_WRITE_EXACT.contains(&path) {
        return true;
    }
    let under = |prefix: &str| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    if DENIED_CREDENTIAL_WRITE_PREFIXES.iter().any(|p| under(p)) {
        return true;
    }
    let after_id_has = |prefix: &str, segments: &[&str]| {
        path.strip_prefix(prefix).is_some_and(|rest| {
            rest.split('/')
                .skip(1)
                .any(|segment| segments.contains(&segment))
        })
    };
    after_id_has("/api/plugins/", DENIED_PLUGIN_CREDENTIAL_SEGMENTS)
        || after_id_has("/api/apps/", DENIED_PLUGIN_CREDENTIAL_SEGMENTS)
        || after_id_has("/api/agents/", DENIED_AGENT_LOGIN_SEGMENTS)
}

/// Substrings marking non-request/response routes (WebSocket upgrades + SSE
/// streams). A blocking loopback call to these hangs until timeout, so they are
/// never useful as request/response tools and are excluded at generation time.
pub(super) const DENIED_STREAMING_SUBSTRINGS: &[&str] = &[
    "/ws", // websocket upgrade routes (…_ws, /ws/…)
    "_ws", "stream",  // SSE stream routes (…/stream, …_stream)
    "/events", // SSE event feeds
];

/// Whether `(path, method)` must be excluded from the CoreApi catalog.
///
/// `method` is lowercase (`get`/`post`/…). Besides the prefix/exact/streaming
/// rules, **mutating** verbs under `/api/approvals/` are denied: an agent must
/// never be able to approve or reject its own approvals (that would defeat the
/// entire HITL gate). Approvals *reads* (GET) remain allowed.
pub fn is_denied(path: &str, method: &str) -> bool {
    if DENIED_EXACT.contains(&path) {
        return true;
    }
    if DENIED_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return true;
    }
    if DENIED_STREAMING_SUBSTRINGS.iter().any(|s| path.contains(s)) {
        return true;
    }
    // Webhook signing secrets are credentials even though the registry/list
    // routes themselves are metadata-only.
    if path.starts_with("/api/webhooks/") && path.ends_with("/secret") {
        return true;
    }
    // The app host-capability bridge (`/api/plugins/:id/host`, and its `/stream`
    // sibling) is the trusted desktop's channel for Companion frames. It carries
    // user-aware operations (Safe Actions plan review, webhook signing secrets)
    // that a node-token loopback with no user would run as `local-operator` on an
    // unbound node: self-approval and credential exposure. `/host/stream` is also
    // caught by the streaming rule; this names both on purpose. Any `host` segment
    // after the id counts, so a scoped id resolved into the path (`@scope/name`)
    // cannot shift the bridge segment out of reach.
    if let Some(rest) = path.strip_prefix("/api/plugins/") {
        if rest.split('/').skip(1).any(|segment| segment == "host") {
            return true;
        }
    }
    // An agent's own Composio accounts (`/api/agents/{id}/composio/…`) are
    // operator-only for every verb: connecting one adds it to that agent's
    // allowlist, and listing or disconnecting them manages the agent's
    // identity. The loopback runs with node power, so an agent could otherwise
    // grow, inspect or tear down its own accounts without the user. A
    // `composio` segment anywhere after the id counts.
    if let Some(rest) = path.strip_prefix("/api/agents/") {
        if rest.split('/').skip(1).any(|segment| segment == "composio") {
            return true;
        }
    }
    if DENIED_AGENT_ACCESS_WRITES.contains(&path)
        && ["post", "put", "patch"]
            .iter()
            .any(|verb| method.eq_ignore_ascii_case(verb))
    {
        return true;
    }
    // Account connections and credentials: reads OK, writes forbidden for every
    // agent (see `DENIED_CREDENTIAL_WRITE_PREFIXES`).
    if is_credential_write(path, method) {
        return true;
    }
    // Removing a trigger subscription tears down the user's event binding,
    // which only the user may do (creating one is in
    // `DENIED_AGENT_ACCESS_WRITES`).
    if path.starts_with("/api/composio/trigger-subscriptions/")
        && method.eq_ignore_ascii_case("delete")
    {
        return true;
    }
    // Approvals: reads OK, mutations forbidden (self-approval bypass).
    if path.starts_with("/api/approvals/") && !method.eq_ignore_ascii_case("get") {
        return true;
    }
    false
}
