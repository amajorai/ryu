//! Spaces / RAG handlers (spec unit U16).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Spaces / RAG handlers (spec unit U16) ─────────────────────────────────────

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateSpaceBody {
    pub(in crate::server) name: String,
    pub(in crate::server) description: Option<String>,
    /// `private` keeps the Space owner-only; `org` shares it with the node's
    /// organization. The product's Team control maps to the `org` wire scope;
    /// named-team rows remain an internal storage shape until list filtering can
    /// carry every verified team membership.
    #[serde(default)]
    pub(in crate::server) visibility: Option<String>,
    #[serde(default)]
    pub(in crate::server) team_id: Option<String>,
    /// Which retrieval algorithm this Space uses: `"vector"` (default) or
    /// `"graph"`. Optional — omitting it keeps every existing client on exactly the
    /// behaviour it had, falling through to the node-wide `rag_strategy` default,
    /// which itself defaults to `"vector"`.
    ///
    /// Typed as `Option<String>` rather than `Option<RetrievalMode>` on purpose: a
    /// serde enum would make an unknown spelling a 422 from the extractor with an
    /// opaque body. Parsing it by hand ([`spaces::RetrievalMode::parse`]) lets an
    /// unknown value come back as a 400 that names the accepted spellings — the
    /// alternative, a lenient parse, would create a *vector* Space for a caller who
    /// typed `"graphrag"` and report success.
    #[serde(default)]
    pub(in crate::server) retrieval_mode: Option<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct RenameSpaceBody {
    pub(in crate::server) name: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetVisibilityBody {
    #[serde(default)]
    pub(in crate::server) visibility: Option<String>,
    #[serde(default)]
    pub(in crate::server) team_id: Option<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetConversationAccessBody {
    #[serde(default)]
    pub(in crate::server) visibility: Option<String>,
    #[serde(default)]
    pub(in crate::server) team_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) collaborators: Vec<conversations::ConversationCollaborator>,
}

pub(in crate::server) fn conversation_team_scope_authorized(
    team_id: Option<&str>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
) -> bool {
    let Some(team_id) = team_id else {
        return true;
    };
    let Some(org_id) = node_org else {
        return true;
    };
    caller.is_some_and(|caller| {
        caller.org_id.as_deref() == Some(org_id)
            && (caller
                .role
                .satisfies(crate::identity_verify::OrgRole::Admin)
                || caller
                    .teams
                    .iter()
                    .any(|team| team.id == team_id && team.org_id == org_id))
    })
}
pub(in crate::server) fn validate_conversation_visibility<'a>(
    visibility: Option<&'a str>,
    team_id: Option<&'a str>,
) -> Result<(&'a str, Option<&'a str>), String> {
    let visibility = visibility.unwrap_or("private");
    if !matches!(visibility, "private" | "org" | "team") {
        return Err(format!(
            "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
        ));
    }
    if visibility == "team" {
        let team_id = team_id
            .filter(|team_id| !team_id.trim().is_empty())
            .ok_or_else(|| "team visibility requires a non-empty team_id".to_owned())?;
        return Ok((visibility, Some(team_id)));
    }
    Ok((visibility, None))
}

pub(in crate::server) fn validate_visibility<'a>(
    visibility: Option<&'a str>,
    _team_id: Option<&'a str>,
) -> Result<(&'a str, Option<&'a str>), String> {
    let visibility = visibility.unwrap_or("private");
    if !matches!(visibility, "private" | "org") {
        return Err(format!(
            "unknown visibility {visibility:?}: expected \"private\" or \"org\""
        ));
    }
    Ok((visibility, None))
}

/// Resolve the [`spaces::RetrievalMode`] a new Space should be stamped with.
///
/// Precedence (see [`crate::registry::ProviderRegistry::resolve_rag_strategy`]):
/// the request's `retrieval_mode` wins; an absent or empty one falls through to the
/// node-wide `rag_strategy` (`RYU_RAG_STRATEGY` / `registry.json`); that falls
/// through to `"vector"`.
///
/// Two failure shapes, deliberately different:
/// - A bad value from the **caller** is an `Err(message)` → 400. The caller is
///   present and can be told.
/// - A bad value from the **operator's** env/JSON cannot fail the request (the
///   caller did nothing wrong), so it warns loudly and uses `Vector`. Silently
///   honouring a typo as "graph" is impossible; silently creating a vector Space
///   *without* the warning is the defect this branch avoids.
pub(in crate::server) fn resolve_new_space_mode(
    requested: Option<&str>,
) -> Result<spaces::RetrievalMode, String> {
    // `load()`, not `from_env()`. `from_env` is `from_file_path(None)`, and
    // `None.and_then(RegistryFile::load)` is `None` — it opens no file, ever. Built
    // that way, `registry.json {"rag_strategy":"graph"}` was silently inert while
    // this function's own docstring, the resolver's, and the desktop client all
    // promised it worked; only `RYU_RAG_STRATEGY` did anything. `load()` is the
    // constructor the rest of Core's config-reading paths use
    // (`list_agents`, `list_agent_catalog`, `main.rs`, `sidecar::onboarding`).
    //
    // Cost is one small file read per Space creation — a human-rate operation that
    // already does a DB insert — and the upside is that an operator editing
    // `registry.json` does not have to restart Core to be believed.
    let registry = crate::registry::ProviderRegistry::load();
    // `resolve_rag_strategy` treats `Some("")` as absent, so this flag matches its
    // notion of "the caller named a mode" exactly.
    let from_caller = requested.is_some_and(|r| !r.is_empty());
    decide_new_space_mode(registry.resolve_rag_strategy(requested), from_caller)
}

/// The decision half of [`resolve_new_space_mode`], split out so the mapping from a
/// resolved string to a [`spaces::RetrievalMode`] (and to the two different failure
/// shapes) can be exhaustively tested without touching process env.
///
/// The split originally existed because env mutation here would race
/// `registry::tests`, which mutate the same vars under their own lock. That reason
/// no longer applies: `registry::lock_registry_env` is `pub(crate)` under
/// `cfg(test)` precisely so the test below can take *that* lock and drive the whole
/// composition. Keep both levels of test — this one for the branch matrix, the
/// env-driven one for the wiring — because a pure-function test cannot notice the
/// handler building its registry with a constructor that reads no file.
///
/// `resolved` is whatever `resolve_rag_strategy` returned; `from_caller` says
/// whether that string came from the request body rather than the node config.
pub(in crate::server) fn decide_new_space_mode(
    resolved: &str,
    from_caller: bool,
) -> Result<spaces::RetrievalMode, String> {
    if let Some(mode) = spaces::RetrievalMode::parse(resolved) {
        return Ok(mode);
    }
    if from_caller {
        return Err(format!(
            "unknown retrieval_mode {resolved:?}: expected \"vector\" or \"graph\""
        ));
    }
    tracing::warn!(
        "registry rag_strategy {resolved:?} is not a known retrieval mode \
         (expected \"vector\" or \"graph\"); creating this Space as \"vector\""
    );
    Ok(spaces::RetrievalMode::Vector)
}

#[utoipa::path(
    post,
    path = "/api/spaces",
    tag = "Spaces",
    summary = "Create a space",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_space(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateSpaceBody>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        );
    }
    if body.name.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    let mode = match resolve_new_space_mode(body.retrieval_mode.as_deref()) {
        Ok(mode) => mode,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    let (visibility, team_id) =
        match validate_visibility(body.visibility.as_deref(), body.team_id.as_deref()) {
            Ok(value) => value,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
        };
    match state
        .spaces
        .create_space_with_mode_and_visibility(
            body.name.trim(),
            body.description.as_deref(),
            mode,
            &spaces::owner_of(&caller_tenancy(&caller)),
            visibility,
            team_id,
        )
        .await
    {
        // Echo the resolved mode: the caller may have omitted the field and picked
        // up the node default, so "what did I actually get" must not require a
        // follow-up GET.
        Ok(id) => Json(json!({
            "id": id,
            "retrieval_mode": mode.as_str(),
            "visibility": visibility,
            "team_id": team_id,
        }))
        .into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/spaces/:id/name` — rename a user-created Space. The retrieval index
/// and every document remain unchanged; only the display name and timestamp move.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/name",
    tag = "Spaces",
    summary = "Rename a space",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn rename_space(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<RenameSpaceBody>,
) -> axum::response::Response {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
        crate::acl::KIND_SPACE,
        &id,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        );
    }
    if let Err(resp) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return resp;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    match state.spaces.rename_space(&id, name).await {
        Ok(true) => Json(json!({ "success": true, "name": name })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/spaces",
    tag = "Spaces",
    summary = "List spaces",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_spaces(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    match state.spaces.list_spaces(caller_doc_filter(&caller)).await {
        Ok(items) => Json(json!({ "spaces": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct SpacePackageImportBody {
    pub(in crate::server) archive_base64: String,
    #[serde(default)]
    pub(in crate::server) name: Option<String>,
}

pub(in crate::server) fn space_package_filename(name: &str) -> String {
    let mut output = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            output.push(character);
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        "space".to_owned()
    } else {
        output.to_ascii_lowercase()
    }
}
