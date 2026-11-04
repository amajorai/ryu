//! Unified tool catalog: search + describe (#474).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Unified tool catalog: search + describe (#474) ───────────────────────────

/// The **skill** allowlist to scope a catalog search by — `AgentRecord.skills`
/// for `agent`, or the empty list.
///
/// Empty is not "deny": [`ryu_skills::SkillRegistry::enabled_for`] defines an
/// empty allowlist as *every enabled skill*. So this fails **open** on every
/// degraded path — no `?agent=`, an id no row matches, a store error — which is
/// deliberate and matches the convention the `skills` provider already documents
/// where it resolves the same field for `skills.load`
/// (`sidecar/mcp/mod.rs`). A skill is instruction text with no secrets; the list
/// keeps an agent focused on its own skills rather than guarding a confidence.
/// Failing closed would silently strip skills from the agent-less callers
/// (workflows, monitors, the approval engine) that legitimately have all of them.
///
/// This is **not** `AcpAgentRegistry::allowlist_for`, which is the env-derived
/// *tool* allowlist and a different list entirely — see [`tools_search`].
pub(in crate::server) async fn agent_skill_allowlist(
    store: &AgentStore,
    agent: Option<&str>,
) -> Vec<String> {
    let Some(id) = agent else {
        return Vec::new();
    };
    store
        .get(id)
        .await
        .ok()
        .flatten()
        .map(|rec| rec.skill_allowlist())
        .unwrap_or_default()
}

/// `GET /api/tools/search?q=&kind=&limit=&agent=` — search the unified tool
/// catalog (MCP + built-ins + Composio + plugin tools + Core self-API). `kind` ∈
/// `mcp|builtin|composio|app|core-api|command|skill|ext-api|any` (default
/// `any`) — the accepted set is `ToolKind::parse_filter`'s, never a list
/// maintained here. `agent` narrows
/// results to the agent's allowlist. Returns
/// `{ "object":"list", "data":[ToolDescriptor] }`.
///
/// ## `?agent=` narrows on TWO different lists
///
/// They are genuinely different lists and neither substitutes for the other:
///
/// - the **tool** allowlist — `AcpAgentRegistry::allowlist_for`, derived from
///   `RYU_MCP_ALLOWLIST_<AGENT>` / `RYU_MCP_ALLOWLIST`, applied *after* ranking
///   via `ToolDescriptor::matches_allowlist`. It returns `None` when neither
///   variable is set, which is the stock case, so on most nodes it narrows
///   nothing;
/// - the **skill** allowlist — `AgentRecord.skills`, threaded *into* the search so
///   [`crate::sidecar::mcp::McpRegistry::search_scoped`] merges only the skills
///   this agent may load. Same field, same store the `skills` provider reads when
///   it serves `skills.load` (`sidecar/mcp/mod.rs`, the `skills_allowlist` block).
///
/// Before the skill half existed, an agent scoped to two skills got every enabled
/// skill on the node back from `tool_search`: the tool allowlist does not gate
/// individual skills (its `Skill` arm gates reaching the `skills` *server*) and on
/// a stock node it was `None` anyway. `skills.load` still refused the bodies, so
/// what leaked was the L1 row — id, name, description — for skills the agent was
/// deliberately not given. That reached two planes, because the gateway's
/// openai-compat tool loop calls this same route with `?agent=`
/// (`apps/gateway/src/tools/catalog_client.rs`, `ToolSearchClient::search`).
///
/// On that second plane the id is only present when the gateway was called by a
/// `trusted_forwarder` key — otherwise `pipeline`'s `eff_agent_id` is `None`, no
/// `?agent=` is sent, and this route behaves exactly as it does for any agent-less
/// caller. When it IS present it is `adapters::route_openai_stream`'s
/// `effective_agent_id`, the same value Core hands `resolve_binding` →
/// `agent_store.get(id)` to build that turn's skill *injection* allowlist. Same id,
/// same store, same field as [`agent_skill_allowlist`] — so discovery and injection
/// cannot disagree about which skills the agent has.
///
/// Agent-less callers are unchanged: no `?agent=` ⇒ empty allowlist ⇒ every
/// enabled skill, which is what `SkillRegistry::enabled_for` defines an empty list
/// to mean and what `skills.search` has always done for workflows and monitors.
#[utoipa::path(
    get,
    path = "/api/tools/search",
    tag = "Tools",
    summary = "Search the unified tool catalog",
    params(
        ("q" = Option<String>, Query, description = "Natural-language capability query"),
        ("kind" = Option<String>, Query, description = "mcp|builtin|composio|app|command|core-api|skill|ext-api|any"),
        ("limit" = Option<usize>, Query, description = "Max results (default 8)"),
        ("agent" = Option<String>, Query, description = "Narrow to this agent's allowlist"),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn tools_search(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let query = params.get("q").map(String::as_str).unwrap_or_default();
    let kind = params
        .get("kind")
        .and_then(|k| crate::sidecar::mcp::catalog::ToolKind::parse_filter(k));
    let limit = params
        .get("limit")
        .and_then(|l| l.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(8)
        .min(25);

    // When `?agent=` is present we narrow by the agent's allowlist (search ≠
    // grant, but a UI can ask for only the tools this agent may actually call).
    // Over-fetch first so allowed tools ranked below the top-`limit` are not
    // hidden by truncation, then narrow, then truncate to `limit`.
    let agent = params.get("agent").filter(|s| !s.is_empty());
    let identity = match oauth_discovery_identity(&state, &caller, agent.map(String::as_str)).await
    {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let fetch = if agent.is_some() {
        limit.saturating_mul(4).max(50)
    } else {
        limit
    };
    // Resolved before the search, because it changes which rows the merge
    // produces rather than filtering rows afterwards.
    let skills_allowlist =
        agent_skill_allowlist(&state.agent_store, agent.map(String::as_str)).await;

    let mut results = state
        .mcp
        .search_scoped_for_identity(
            query,
            kind,
            fetch,
            &skills_allowlist,
            caller.as_ref().map(|caller| caller.user_id.as_str()),
            identity.as_ref(),
        )
        .await;
    if let Some(agent) = agent {
        if let Some(allow) = resolved_agent_tool_allowlist(&state, agent).await {
            // Match the execution gate (id || name || server for MCP/built-ins,
            // id-only for Composio) so search doesn't hide tools the agent may
            // actually call (e.g. a server-level grant like `["spider"]`).
            results.retain(|d| d.matches_allowlist(&allow));
        }
        results.truncate(limit);
    }

    Json(json!({ "object": "list", "data": results })).into_response()
}

/// `GET /api/tools/describe?id=` — describe one tool by its fully-qualified id.
/// Returns a `DescribedTool` object as the body root, or 404 when unknown.
#[utoipa::path(
    get,
    path = "/api/tools/describe",
    tag = "Tools",
    summary = "Describe a tool's argument schema",
    params(
        ("id" = String, Query, description = "Fully-qualified tool id (<server>.<tool>)"),
        ("agent" = Option<String>, Query, description = "Installed agent whose saved profiles scope authenticated MCP discovery"),
    ),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Missing `id` query parameter"),
        (status = 404, description = "Unknown tool id"),
    )
)]
pub(in crate::server) async fn tools_describe(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `id`" })),
        )
            .into_response();
    };
    let identity =
        match oauth_discovery_identity(&state, &caller, params.get("agent").map(String::as_str))
            .await
        {
            Ok(identity) => identity,
            Err(response) => return response,
        };
    match state
        .mcp
        .describe_scoped_for_identity(
            id,
            &[],
            caller.as_ref().map(|caller| caller.user_id.as_str()),
            identity.as_ref(),
        )
        .await
    {
        Some(described) => {
            Json(serde_json::to_value(described).unwrap_or_default()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown tool id '{id}'") })),
        )
            .into_response(),
    }
}
