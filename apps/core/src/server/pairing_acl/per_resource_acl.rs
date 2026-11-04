//! Per-resource ACL CRUD.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Per-resource ACL CRUD ────────────────────────────────────────────────────

/// `GET /api/acl/resources/:kind/:id` — the overwrites in force on one resource.
///
/// Returns the RAW stored rows rather than the resolved view: an editor must show
/// what is persisted (including a row the resolver drops, e.g. an unknown target
/// type), or saving would silently delete a rule the admin never saw.
pub(in crate::server) async fn acl_get_resource(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    validate_acl_resource(&kind, &id)?;
    // Reading WHO has access is itself sensitive — the rule set names every team
    // and person with an exception on this resource. Gated on the same permission
    // as writing it, so a caller who may not change the rules may not enumerate
    // them either.
    let caller = verified_caller_from_headers(&headers).await;
    if let Err(response) = enforce_node_acl_management(&state, &caller, &kind, &id).await {
        return Err(response);
    }
    let rows = crate::acl::store::stored_for(&crate::acl::store::ResourceKey::new(&kind, &id));
    Ok(Json(json!({
        "kind": kind,
        "id": id,
        "overwrites": rows.iter().map(|r| json!({
            "target_type": r.target_type,
            "target_id": r.target_id,
            "allow": r.allow,
            "deny": r.deny,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct AclPutBody {
    #[serde(default)]
    pub(in crate::server) overwrites: Vec<crate::acl::store::StoredOverwrite>,
}

pub(in crate::server) fn validate_acl_resource(
    kind: &str,
    resource_id: &str,
) -> Result<(), axum::response::Response> {
    if !crate::acl::ENFORCED_KINDS.contains(&kind) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!("unknown ACL resource kind `{kind}`"),
        ));
    }
    if resource_id.is_empty() || resource_id.len() > 300 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "ACL resource id must be between 1 and 300 characters".to_owned(),
        ));
    }
    Ok(())
}

pub(in crate::server) fn validate_acl_overwrites(
    rows: &[crate::acl::store::StoredOverwrite],
) -> Result<(), axum::response::Response> {
    for row in rows {
        if !matches!(row.target_type.as_str(), "org" | "team" | "role" | "member") {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                format!("unknown ACL target type `{}`", row.target_type),
            ));
        }
        if row.target_id.is_empty() || row.target_id.len() > 300 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "ACL target id must be between 1 and 300 characters".to_owned(),
            ));
        }
        if row.target_type == "role" && row.target_id == crate::acl::RESERVED_CUSTOM_ROLE_ID {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "ACL role target id is reserved".to_owned(),
            ));
        }
        if row.allow.len() > 100 || row.deny.len() > 100 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "an ACL target may name at most 100 allowed and 100 denied permissions".to_owned(),
            ));
        }
        for permission in row.allow.iter().chain(row.deny.iter()) {
            if permission.is_empty() || permission.len() > 200 {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    "ACL permission ids must be between 1 and 200 characters".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

/// `PUT /api/acl/resources/:kind/:id` — replace every overwrite on a resource.
///
/// Whole-set replacement rather than per-row patching, deliberately: the editing
/// UI shows the complete list, so a partial update would race a concurrent edit
/// into a state neither admin chose.
///
/// Requires `roles.manage` ON THIS RESOURCE — editing who may do what is itself a
/// permission, or anyone who could read a resource could grant themselves write.
pub(in crate::server) async fn acl_put_resource(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Json(body): Json<AclPutBody>,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    validate_acl_resource(&kind, &id)?;
    let caller = verified_caller_from_headers(&headers).await;
    // Editing WHO may do what is itself a permission, and it is checked ON THIS
    // RESOURCE — otherwise anyone who could read a space could grant themselves
    // write on it.
    if let Err(response) = enforce_node_acl_management(&state, &caller, &kind, &id).await {
        return Err(response);
    }

    validate_acl_overwrites(&body.overwrites)?;

    // Reject unknown permission ids at the EDGE rather than storing them and
    // letting the resolver drop them silently — a rule that never applies but
    // renders in the UI reads as a working grant.
    let vocab = crate::acl::vocabulary::build_vocabulary(crate::acl::declared_levels());
    for row in &body.overwrites {
        for permission in row.allow.iter().chain(row.deny.iter()) {
            if !vocab.registry.is_declared(permission) {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    format!("unknown permission `{permission}`"),
                ));
            }
        }
    }

    // `roles.manage` admits the editor; it does not let them hand out or strip
    // what they do not hold, or retarget someone above them (the control plane's
    // `enforceCeiling` and outrank rules).
    enforce_acl_edit_ceiling(&state, &caller, &kind, &id, &body.overwrites).await?;

    crate::acl::store::set_overwrites(
        &crate::acl::store::ResourceKey::new(&kind, &id),
        body.overwrites,
    )
    .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;

    Ok(Json(json!({ "ok": true })))
}

/// Grant ceiling for `PUT /api/acl/resources/:kind/:id`, after the
/// `roles.manage` admission. Only the changed rows are judged
/// ([`crate::acl::acl_edit_changes`]); the rules are the pure
/// [`crate::acl::check_acl_edit`].
///
/// Exempt: an unbound node (its boundary is the node token, as in
/// [`enforce_permission_on`]), the node's personal owner, and an org owner, who
/// holds every permission and is outranked by no one. Everyone else is judged
/// against what they effectively hold on THIS resource now, including its deny
/// overwrites. A changed member target whose org role cannot be resolved is
/// refused rather than assumed harmless.
pub(in crate::server) async fn enforce_acl_edit_ceiling(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    kind: &str,
    resource_id: &str,
    proposed: &[crate::acl::store::StoredOverwrite],
) -> Result<(), axum::response::Response> {
    let personal_owner = match resource_permission_candidate(caller) {
        Ok(None) => return Ok(()),
        Ok(Some(personal_owner)) => personal_owner,
        Err(status) => {
            return Err(json_error(
                status,
                "insufficient permissions: roles.manage".to_owned(),
            ))
        }
    };
    let Some(caller) = caller.as_ref() else {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: roles.manage".to_owned(),
        ));
    };
    if personal_owner || caller.role == crate::identity_verify::OrgRole::Owner {
        return Ok(());
    }

    let current =
        crate::acl::store::stored_for(&crate::acl::store::ResourceKey::new(kind, resource_id));
    let changes = crate::acl::acl_edit_changes(&current, proposed);
    if changes.is_empty() {
        return Ok(());
    }

    let mut member_roles = std::collections::BTreeMap::new();
    let member_targets = crate::acl::changed_member_targets(&changes, &caller.user_id);
    if !member_targets.is_empty() {
        let roster = crate::sidecar::control_plane::resolve_notify_targets(&state.client, None)
            .await
            .map_err(|_| {
                json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cannot verify the roles of the members this change targets".to_owned(),
                )
            })?;
        for member in roster {
            if !member_targets.contains(&member.user_id) {
                continue;
            }
            // No role on the roster row leaves the member out of the map, which
            // `check_acl_edit` refuses.
            if let Some(role) = member.role.as_deref() {
                member_roles.insert(
                    member.user_id.clone(),
                    crate::identity_verify::OrgRole::from_ba_str(role),
                );
            }
        }
    }

    let resolved =
        crate::sidecar::control_plane::resolve_permission_context(&state.client, &caller.user_id)
            .await;
    crate::acl::check_acl_edit(
        &changes,
        &caller.user_id,
        caller.role,
        &member_roles,
        |perm| {
            crate::acl::decide_with_context(
                caller,
                kind,
                resource_id,
                perm,
                &resolved.permissions,
                &resolved.role_ids,
            )
            .is_allowed()
        },
    )
    .map_err(|refusal| json_error(StatusCode::FORBIDDEN, refusal.message()))
}

/// `GET /api/acl/resources` — every resource carrying an exception, for an
/// admin overview ("where have grants been customized?").
pub(in crate::server) async fn acl_list_resources(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    // The list itself is a disclosure: it names every resource whose access was
    // customised. Gated ORG-WIDE (`enforce_permission`, not `_on`) because it
    // spans resources — there is no single resource whose overwrites could carve
    // an exception for it.
    let caller = verified_caller_from_headers(&headers).await;
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::ROLES_MANAGE,
    )
    .await
    .is_err()
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: roles.manage".to_owned(),
        ));
    }
    let keys = crate::acl::store::resources_with_overwrites();
    Ok(Json(json!({
        "resources": keys.iter().map(|k| json!({ "kind": k.kind, "id": k.id })).collect::<Vec<_>>(),
    })))
}
