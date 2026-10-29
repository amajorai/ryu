use super::*;

/// Whether this request should run the unified search-based tool loop.
///
/// Gated on an explicit *per-request* signal so plain chat keeps the fast direct
/// stream and ACP egress never triggers a second tool surface (B-10). The signal
/// is the new `x-ryu-tools` header literally being present
/// (`ctx.tools_header_present`) OR `x-ryu-tool-search: on`
/// (`ctx.tool_search_requested`). Two deliberate exclusions:
///   - the legacy `x-ryu-composio-actions` fallback is NOT a trigger: a bare
///     Composio agent (legacy header only) keeps its fast stream + the legacy
///     Composio loop, instead of being force-buffered into the unified loop.
///     The fallback still feeds `effective_tool_allowlist` for migration.
///   - `config.tools.always_on` is NOT a trigger: it is request-independent, so
///     keying off it would fire on header-less ACP egress — the exact
///     double-surface the design forbids. Always-on tools stay reachable once a
///     per-request signal legitimately activates the loop (injected by
///     `inject_search_tool` and granted by `effective_tool_allowlist`).
///
/// Always inert when `config.tools.enabled` is false.
pub(super) fn tool_signal_active(ctx: &RequestContext, cfg: &crate::config::ToolsConfig) -> bool {
    if !cfg.enabled {
        return false;
    }
    ctx.tools_header_present || ctx.tool_search_requested || ctx.capability_hints.is_some()
}

/// Which completion path the pipeline takes for this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolLoopKind {
    /// Unified search-based tool loop (catalog wired + per-request signal).
    Unified,
    /// Legacy Composio tool loop (Composio configured).
    Composio,
    /// Plain completion — no managed tool loop.
    Plain,
}

pub(super) fn unified_composio_identity(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<(Option<String>, bool), GatewayError> {
    let identity = ctx
        .org_id
        .as_deref()
        .map(|org_id| {
            crate::composio::ComposioTenantScope::new(org_id)
                .map(|scope| scope.entity_for_user(ctx.user_id.as_deref()))
        })
        .transpose()?;
    // Core treats the tool body's user id as a Composio selector on an unbound
    // node. A shared Gateway must not let a missing org reach that fallback.
    Ok((identity, state.resolve_cache.is_some()))
}

/// Decide which completion branch to run — the single source of truth for the
/// precedence in `run` (unified → legacy Composio → plain).
///
/// Raw passthrough (`x-ryu-raw-tools`, `ctx.raw_tools`) short-circuits to
/// `Plain` so an SDK-side agent loop's own `tools`/`tool_calls` are forwarded
/// verbatim even on a Composio-on node — Core's loop never intercepts them.
pub(super) fn select_tool_loop(
    ctx: &RequestContext,
    has_catalog: bool,
    has_composio: bool,
    cfg: &crate::config::ToolsConfig,
    tools_restricted: bool,
) -> ToolLoopKind {
    // Restrict forbids reinjection and execution, including unsolicited calls.
    if tools_restricted || ctx.raw_tools {
        return ToolLoopKind::Plain;
    }
    // An unverified caller's turn gets managed tools only from an explicit
    // Core-stamped allowlist. Without one, the legacy loop would fall back to
    // the operator's global Composio grants.
    if ctx.untrusted_caller && !ctx.tools_header_present {
        return ToolLoopKind::Plain;
    }
    if has_catalog && tool_signal_active(ctx, cfg) {
        return ToolLoopKind::Unified;
    }
    if has_composio {
        return ToolLoopKind::Composio;
    }
    ToolLoopKind::Plain
}

/// Parse the per-request `x-ryu-tools` CSV into a list of FQ tool ids.
///
/// The wildcard `"*"` is stripped here: it grants *every* tool
/// ([`crate::tools::ToolLoopContext::is_allowed`]) and may only originate from a
/// server-configured `unrestricted` profile, never from the client-controlled
/// header. Without this filter, `x-ryu-tools: *` would bypass the allowlist
/// entirely (both on the no-profile path and when unioned onto a non-`unrestricted`
/// profile's allow set).
pub(super) fn parse_tool_actions(ctx: &RequestContext) -> Vec<String> {
    ctx.tool_actions
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|x| !x.is_empty() && *x != "*")
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn legacy_composio_allowlist(
    requested: Option<&str>,
    configured: &[String],
) -> Vec<String> {
    let Some(requested) = requested else {
        return configured.to_vec();
    };
    let mut allowed = Vec::new();
    for action in requested.split(',').map(str::trim) {
        if action != "*"
            && configured.iter().any(|configured| configured == action)
            && !allowed.iter().any(|existing| existing == action)
        {
            allowed.push(action.to_owned());
        }
    }
    allowed
}

/// Effective egress tool allowlist (FQ ids) for the unified loop.
///
/// Default path (no profile, or an unknown profile name): the per-request
/// `x-ryu-tools` CSV when present, else empty, plus the registry's `always_on`
/// tool names (so always-on tools are callable without a header). This is the
/// byte-for-byte original behavior — selecting no profile changes nothing.
///
/// Profile path (`ctx.tool_profile` names a configured `cfg.profiles` entry),
/// modeled on OpenClaw's profile layering (profile → allow/deny):
///   1. seed the allow set from `profile.allow` (or the wildcard `"*"` when the
///      profile is `unrestricted` — the "full" preset);
///   2. union the explicit `x-ryu-tools` CSV on top (explicit allow augments the
///      profile);
///   3. strip any id listed in `profile.deny` (deny wins over allow);
///   4. append `always_on` names last — they are never deny-stripped, preserving
///      the always-on contract.
///
/// `tool_search` is always permitted by the loop itself, independent of this
/// list. An unrestricted profile's `"*"` is honored by
/// [`crate::tools::ToolLoopContext::is_allowed`].
///
/// An untrusted-caller request (`x-ryu-untrusted-caller`) skips every widening
/// step: no unrestricted `"*"`, no always-on names, and no capability-hint
/// grants. What remains is the explicit allowlist, after any profile deny.
pub(super) fn effective_tool_allowlist(
    ctx: &RequestContext,
    cfg: &crate::config::ToolsConfig,
) -> Vec<String> {
    let profile = ctx
        .tool_profile
        .as_deref()
        .and_then(|name| cfg.profiles.get(name));

    let mut allowed: Vec<String> = match profile {
        // Profile selected and configured: seed from the profile's allow set.
        Some(p) => {
            let mut seed: Vec<String> = if p.unrestricted {
                vec!["*".to_string()]
            } else {
                p.allow.clone()
            };
            // Explicit per-request allow augments/overrides the profile.
            for id in parse_tool_actions(ctx) {
                if !seed.contains(&id) {
                    seed.push(id);
                }
            }
            // Deny wins over allow (does NOT strip always_on, appended below).
            if !p.deny.is_empty() {
                seed.retain(|id| !p.deny.contains(id));
            }
            seed
        }
        // No profile, or an unknown/typo'd name: exactly today's behavior.
        None => parse_tool_actions(ctx),
    };
    if ctx.untrusted_caller {
        allowed.retain(|id| id != "*");
        return allowed;
    }

    for def in &cfg.always_on {
        if let Some(name) = def["function"]["name"].as_str() {
            allowed.push(name.to_string());
        }
    }
    // An unrestricted Core agent has no explicit x-ryu-tools header. Its
    // trusted-forwarder hint envelope is allowed to narrow the current turn to
    // exactly the locally-scoped suggestions, but an ordinary caller can never
    // use this path to self-grant a capability.
    if !ctx.tools_header_present
        && (ctx.is_master_key
            || ctx
                .key_config
                .as_ref()
                .is_some_and(|key| key.trusted_forwarder))
    {
        for id in crate::tools::capability_hint_tool_ids(ctx.capability_hints.as_deref()) {
            if !allowed.contains(&id) {
                allowed.push(id);
            }
        }
        if crate::tools::capability_hint_has_skills(ctx.capability_hints.as_deref())
            && !allowed.iter().any(|id| id == "skills.load")
        {
            allowed.push("skills.load".to_owned());
        }
    }
    allowed
}

/// Offer the unified loop's discovery tools: `tool_search` plus the operator's
/// always-on tools. A restricted request and an untrusted-caller turn get
/// neither; the latter is offered its explicit allowlist through
/// [`unified_loop_hints`] instead.
pub(super) fn inject_unified_loop_tools(
    body: &mut Value,
    ctx: &RequestContext,
    cfg: &crate::config::ToolsConfig,
    tools_restricted: bool,
) {
    if tools_restricted || ctx.untrusted_caller {
        return;
    }
    crate::tools::inject_search_tool(body, &cfg.always_on);
}

/// The capability hints the unified loop describes and offers up front. For an
/// untrusted-caller turn that is exactly its effective allowlist; Core's own
/// suggestions are ignored, so nothing beyond the allowlist is shown.
pub(super) fn unified_loop_hints(ctx: &RequestContext, allowed: &[String]) -> Option<String> {
    if ctx.untrusted_caller {
        crate::tools::allowlist_hint_envelope(allowed)
    } else {
        ctx.capability_hints.clone()
    }
}
