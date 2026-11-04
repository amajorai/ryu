//! Per-resource ACL (the HTTP plane).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Per-resource ACL (the HTTP plane) ────────────────────────────────────────
//
// [`enforce_permission`] above is COARSE org/team RBAC: "may this caller touch
// documents at all?". It cannot answer "may this caller touch THIS document?" —
// so on its own it let any org member with `space.read` read another member's
// PRIVATE doc, and let any holder of the node token read ANY user's conversation.
//
// The realtime WS gateway already closed this on its plane (`decide_access` in
// `server/realtime_ws.rs`): a join is refused unless the caller is authorized for
// the specific room. Without the same gate here, a caller denied at the socket
// could simply `GET` the resource over HTTP — the ACL was strictly weaker on the
// plane that is easier to reach. The helpers below are that plane's twin.
//
// Both gates run, in order: RBAC first (cheap, no row read), then the per-resource
// check. Defense in depth — neither replaces the other.

/// WHAT THIS ACL IS FOR (read this before changing the matrix below).
///
/// It is a **per-user gate for SHARED nodes** — an org-bound "company brain" or a
/// Ryu Cloud node several humans reach. On an **unbound (personal, local-first)
/// node there is exactly one principal**, and the shared `RYU_TOKEN` is the
/// boundary — the same rule [`enforce_permission`] already applies (it ALWAYS
/// ALLOWS when `registered_org()` is `None`). Two consequences, both deliberate:
///
///   1. Tenancy is only STAMPED on rows when the node is org-bound (see
///      [`claim_conversation_tenancy`]). A personal node's rows stay untenanted, so
///      its behaviour — HTTP *and* the realtime WS twin — is byte-identical to
///      before this gate existed. Scoping them would buy no security (the node token
///      already admits everyone who can reach it) and WOULD lock the owner out of
///      their own chats whenever the control plane is unreachable and the desktop
///      cannot mint a user JWT (it is cached in memory only).
///   2. An untenanted row on an ORG-BOUND node is therefore an *unattributable
///      legacy* row, and is DENIED rather than granted — the old unconditional
///      `Access::Write` on NULL tenancy is what made this gate vacuous.
///
/// This node's org binding is passed IN (`node_org`) rather than read from the
/// global, so the matrix stays a pure, unit-testable function.
pub(crate) fn node_org_id() -> Option<String> {
    crate::sidecar::control_plane::registered_org().map(|o| o.id)
}

/// Shared → private is an organization-level visibility change. On a personal
/// node there is no organization administrator to distinguish, so the local node
/// boundary remains authoritative; on a bound node only verified owners/admins
/// may make a shared resource private. The store repeats the transition check
/// while holding its database lock to close a stale-read race between this gate
/// and the final update.
pub(in crate::server) fn visibility_admin_authorized(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> bool {
    let Some(node_org) = node_org_id() else {
        return true;
    };
    caller.is_some_and(|caller| {
        caller.org_id.as_deref() == Some(node_org.as_str())
            && caller
                .role
                .satisfies(crate::identity_verify::OrgRole::Admin)
    })
}

pub(in crate::server) fn conversation_access_manager_authorized(
    tenancy: &crate::identity_verify::ResourceTenancy,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
) -> bool {
    if tenancy.owner_user_id.is_none() && tenancy.org_id.is_none() {
        return node_org.is_none();
    }
    let Some(caller) = caller else {
        return false;
    };
    if tenancy.owner_user_id.as_deref() == Some(caller.user_id.as_str()) {
        return true;
    }
    caller.org_id.as_deref() == tenancy.org_id.as_deref()
        && caller
            .role
            .satisfies(crate::identity_verify::OrgRole::Admin)
}

pub(in crate::server) async fn require_conversation_access_manager(
    state: &ServerState,
    conversation_id: &str,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Result<crate::identity_verify::ResourceTenancy, axum::response::Response> {
    let tenancy = match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(tenancy)) => tenancy,
        Ok(None) => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                format!("conversation '{conversation_id}' not found"),
            ));
        }
        Err(error) => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            ));
        }
    };
    if conversation_access_manager_authorized(&tenancy, caller, node_org_id().as_deref()) {
        Ok(tenancy)
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "forbidden: only the owner or an organization admin can manage access".to_owned(),
        ))
    }
}

/// Resolve a caller's access to ONE resource from its tenancy quartet, mapping a
/// denial straight to the HTTP response the handler should return.
///
/// The matrix mirrors `decide_access` (`server/realtime_ws.rs`) MINUS its
/// loopback grant for *unknown* rooms. That grant exists so the local single user
/// can pre-join a conversation id that has not been persisted yet; an HTTP read of
/// a row that does not exist is simply a 404, so there is nothing to widen here.
///
///   - lookup `Err`                → 500. Fail closed: never serve a row we could
///                                   not authorize.
///   - `Ok(None)`                  → 404. No such resource.
///   - untenanted row (`owner_user_id` AND `org_id` both NULL) + node **UNBOUND**
///     → [`Access::Write`]. The single-tenant, local-first row: nobody ever
///     authenticated to create it and nobody ever will on this node. Keeps the
///     single-user flow byte-identical to before this gate existed.
///   - untenanted row + node **ORG-BOUND** → 403. An unattributable row on a shared
///     node: it belongs to *someone*, we cannot say who, so nobody gets it. Fail
///     closed. (`ConversationStore::backfill_tenancy` attributes these to the local
///     owner on the first open after the node binds, so this is a narrow window.)
///   - scoped row + verified caller → [`crate::identity_verify::can_access`]
///     verbatim; [`Access::None`] → 403.
///   - scoped row + anonymous caller + node **ORG-BOUND** → 403. The
///     credential-downgrade attack: drop the JWT, re-request, be treated as "the
///     local single user", read someone else's private row.
///   - scoped row + anonymous caller + node **UNBOUND** + trusted local peer →
///     [`Access::Write`]. The row is only scoped because the owner happened to be
///     signed in when they created it, and they must not be locked out of it the
///     next time they open the app offline.
///   - scoped row + anonymous caller + node **UNBOUND** + remote peer → 403. The
///     realtime gateway's credential-downgrade rule: a remote node-token or paired
///     caller must present the user JWT that owns (or was shared) the row.
pub(in crate::server) fn resource_access(
    meta: anyhow::Result<Option<crate::identity_verify::ResourceTenancy>>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
    not_found: &str,
) -> Result<crate::identity_verify::Access, axum::response::Response> {
    use crate::identity_verify::Access;

    let tenancy = match meta {
        Ok(Some(tenancy)) => tenancy,
        Ok(None) => return Err(json_error(StatusCode::NOT_FOUND, not_found.to_owned())),
        Err(e) => {
            tracing::warn!("per-resource ACL: tenancy lookup failed: {e:#}");
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ));
        }
    };

    // Apply the node boundary before the resource tenancy ladder. A team or
    // personal node is a narrower data-plane surface than its parent org; an
    // org membership alone must never turn it into a second route around that
    // node scope.
    if let Some(node) = crate::sidecar::control_plane::registered_node() {
        let in_scope =
            caller.is_some_and(|current| node_scope_denial_reason(&node, current).is_none());
        if !in_scope {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "forbidden: caller is outside this node's scope".to_owned(),
            ));
        }
    }

    if tenancy.owner_user_id.is_none() && tenancy.org_id.is_none() {
        return if node_org.is_none() {
            Ok(Access::Write)
        } else {
            Err(json_error(
                StatusCode::FORBIDDEN,
                "forbidden: this resource has no owner on a shared node".to_owned(),
            ))
        };
    }

    match caller {
        Some(caller) => {
            match crate::identity_verify::can_access(
                caller,
                tenancy.owner_user_id.as_deref(),
                tenancy.org_id.as_deref(),
                &tenancy.visibility,
                tenancy.team_id.as_deref(),
                &tenancy.collaborators,
            ) {
                Access::None => Err(json_error(
                    StatusCode::FORBIDDEN,
                    "forbidden: you do not have access to this resource".to_owned(),
                )),
                granted => Ok(granted),
            }
        }
        // A personal node's owner keeps offline access to their own rows, but
        // only from this machine — the same boundary the realtime gateway draws.
        None if node_org.is_none() && anonymous_request_is_local() => Ok(Access::Write),
        None => Err(json_error(
            StatusCode::FORBIDDEN,
            "forbidden: anonymous caller on a scoped resource".to_owned(),
        )),
    }
}

/// Require at least READ access to a resource. Any grant above [`Access::None`]
/// passes (`resource_access` already turns `None` into a 403).
pub(crate) fn require_resource_read(
    meta: anyhow::Result<Option<crate::identity_verify::ResourceTenancy>>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    require_resource_read_at(meta, caller, node_org_id().as_deref(), not_found)
}

/// [`require_resource_read`] with THIS node's org binding passed in — the pure form
/// the unit tests drive (they cannot register an org).
pub(in crate::server) fn require_resource_read_at(
    meta: anyhow::Result<Option<crate::identity_verify::ResourceTenancy>>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    resource_access(meta, caller, node_org, not_found)?;
    Ok(())
}

/// Require WRITE access to a resource. A read-only grant (e.g. an org `Viewer` on
/// an `org`-visible doc) is refused — mirrors the realtime gateway, which drops a
/// read-only member's mutating frames.
pub(crate) fn require_resource_write(
    meta: anyhow::Result<Option<crate::identity_verify::ResourceTenancy>>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    require_resource_write_at(meta, caller, node_org_id().as_deref(), not_found)
}

/// Require write access to a Space before creating content in it. Ryu-owned
/// system Spaces are shared node filing drawers (Artifacts, Uploads, Canvas,
/// etc.); coarse `space.write` already gates them, while their NULL owner must
/// not make every legitimate upload fail the document ACL's legacy-row rule.
/// Ordinary user Spaces still use the native per-Space tenancy gate.
pub(crate) async fn require_space_content_write(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    space_id: &str,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    let meta = match state.spaces.space_access_meta(space_id).await {
        Ok(Some(meta)) => meta,
        Ok(None) => return Err(json_error(StatusCode::NOT_FOUND, not_found.to_owned())),
        Err(e) => {
            tracing::warn!("per-space ACL: tenancy lookup failed: {e:#}");
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ));
        }
    };
    if meta.system {
        return Ok(());
    }
    require_resource_write(
        Ok(Some(crate::identity_verify::ResourceTenancy {
            owner_user_id: meta.owner_user_id,
            org_id: meta.org_id,
            visibility: meta.visibility,
            team_id: meta.team_id,
            collaborators: Vec::new(),
        })),
        caller.as_ref(),
        not_found,
    )
}

/// [`require_resource_write`] with THIS node's org binding passed in — the pure
/// form the unit tests drive.
pub(in crate::server) fn require_resource_write_at(
    meta: anyhow::Result<Option<crate::identity_verify::ResourceTenancy>>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    let access = resource_access(meta, caller, node_org, not_found)?;
    if access.at_least(crate::identity_verify::Access::Write) {
        return Ok(());
    }
    // `Access::None` never reaches here (it is a 403 above), so this is the
    // read-only grant.
    Err(json_error(
        StatusCode::FORBIDDEN,
        "forbidden: read-only access to this resource".to_owned(),
    ))
}
