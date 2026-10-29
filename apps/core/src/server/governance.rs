use std::collections::BTreeMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::governance::{
    clear_field_path, declared_field_paths, managed_locks, merge_governance_layers,
    validate_governance_values, GatewayGovernanceValues, GitSettings, GovernanceScope,
    HookPolicyOverride, WorktreeSettings,
};
use crate::identity_verify::VerifiedCaller;

const LOCAL_GOVERNANCE_KEY: &str = "gateway-governance-local-v1";
pub const MANAGED_GOVERNANCE_KEY: &str = "gateway-governance-managed-v1";

/// Read the same saved governance layers as Settings; filesystem roots remain node-only.
pub async fn runtime_worktree_options(
    preferences: &crate::server::preferences::PreferencesStore,
) -> Result<ryu_workspace::worktree::ManagedWorktreeOptions, String> {
    let local = preferences
        .get(LOCAL_GOVERNANCE_KEY)
        .await
        .map_err(|error| error.to_string())?;
    let managed = preferences
        .get(MANAGED_GOVERNANCE_KEY)
        .await
        .map_err(|error| error.to_string())?;
    // Runtime worktree resolution has no request caller, so it reads the
    // node-local user layer (the single-user / migrated layer).
    runtime_worktree_options_from_documents(local.as_deref(), managed.as_deref(), None)
}

fn runtime_worktree_options_from_documents(
    local: Option<&str>,
    managed: Option<&str>,
    member: Option<&str>,
) -> Result<ryu_workspace::worktree::ManagedWorktreeOptions, String> {
    let local = local
        .map(serde_json::from_str::<LocalGovernanceDocument>)
        .transpose()
        .map_err(|error| format!("invalid local governance: {error}"))?
        .unwrap_or_default();
    let managed = managed
        .map(serde_json::from_str::<ManagedGovernanceDocument>)
        .transpose()
        .map_err(|error| format!("invalid managed governance: {error}"))?
        .unwrap_or_default();
    let user_layer = local.user_layer(member);
    let user = merge_governance_layers(&managed.user, None, None, Some(&user_layer));
    let effective = merge_governance_layers(
        &local.node,
        Some(&managed.organization),
        Some(&managed.team),
        Some(&user),
    );
    let root = local
        .node
        .worktrees
        .root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    if root.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err("worktree root must be an absolute path".to_owned());
    }
    let limit = effective.worktrees.auto_delete_limit.unwrap_or(15);
    if !(1..=100).contains(&limit) {
        return Err("worktree auto-delete limit must be between 1 and 100".to_owned());
    }
    Ok(ryu_workspace::worktree::ManagedWorktreeOptions {
        root,
        fetch_upstream: effective.worktrees.fetch_upstream.unwrap_or(false),
        auto_delete: effective.worktrees.auto_delete.unwrap_or(true),
        auto_delete_limit: usize::from(limit),
    })
}

const fn schema_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalGovernanceDocument {
    #[serde(default = "schema_version")]
    schema_version: u8,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    node: GatewayGovernanceValues,
    /// The node-local user layer: the only user layer on an unbound/personal
    /// node, and the migrated home of any value saved before per-member
    /// layers existed. On an org/team-bound node it is never written again.
    #[serde(default)]
    user: GatewayGovernanceValues,
    /// Per-member user layers on an org/team-bound node, keyed by the verified
    /// user id, so one member's preferences never apply to another member.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    users: BTreeMap<String, GatewayGovernanceValues>,
}

impl Default for LocalGovernanceDocument {
    fn default() -> Self {
        Self {
            schema_version: schema_version(),
            revision: 0,
            node: GatewayGovernanceValues::default(),
            user: GatewayGovernanceValues::default(),
            users: BTreeMap::new(),
        }
    }
}

impl LocalGovernanceDocument {
    /// The user layer for `member` (a verified user id on a bound node), or
    /// the node-local layer when `None`.
    fn user_layer(&self, member: Option<&str>) -> GatewayGovernanceValues {
        match member {
            Some(member) => self.users.get(member).cloned().unwrap_or_default(),
            None => self.user.clone(),
        }
    }

    fn user_layer_mut(&mut self, member: Option<&str>) -> &mut GatewayGovernanceValues {
        match member {
            Some(member) => self.users.entry(member.to_owned()).or_default(),
            None => &mut self.user,
        }
    }
}

/// Whose user layer a request reads/writes. On an org/team-bound node every
/// member has their own layer keyed by the verified user id; an unbound or
/// personal node keeps the single node-local layer (`None`). `Err` means the
/// node is bound but the caller is unverified, so no user layer may be written.
fn governance_member(caller: Option<&VerifiedCaller>) -> Result<Option<String>, ()> {
    member_for(
        crate::sidecar::control_plane::registered_org().is_some(),
        caller.map(|caller| caller.user_id.as_str()),
    )
}

fn member_for(bound: bool, verified_user: Option<&str>) -> Result<Option<String>, ()> {
    if !bound {
        return Ok(None);
    }
    verified_user
        .filter(|user| !user.trim().is_empty())
        .map(|user| Some(user.to_owned()))
        .ok_or(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedGovernanceDocument {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    organization: GatewayGovernanceValues,
    #[serde(default)]
    team: GatewayGovernanceValues,
    #[serde(default)]
    user: GatewayGovernanceValues,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernanceLayerResponse {
    pub revision: u64,
    pub scope: GovernanceScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub values: GatewayGovernanceValues,
    pub writable: bool,
    /// Field paths (`git.branchPrefix`, `worktrees.autoDelete`, `hooks.<key>`)
    /// this layer cannot change. On the organization/team layers these are the
    /// locks the layer imposes; on the user layer they are every managed lock,
    /// so the desktop renders those fields read-only.
    pub locked_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayGovernanceSnapshot {
    pub schema_version: u8,
    pub layers: Vec<GovernanceLayerResponse>,
}

pub fn snapshot_from_documents(
    local_json: Option<&str>,
    managed_json: Option<&str>,
    managed_available: bool,
    member: Option<&str>,
) -> Result<GatewayGovernanceSnapshot, String> {
    let local = local_json
        .and_then(|value| serde_json::from_str::<LocalGovernanceDocument>(value).ok())
        .unwrap_or_default();
    let managed = managed_json
        .and_then(|value| serde_json::from_str::<ManagedGovernanceDocument>(value).ok())
        .unwrap_or_default();
    let unavailable_reason = (!managed_available).then(|| "This node is not managed.".to_owned());
    let user_layer = local.user_layer(member);
    let mut user_values = merge_governance_layers(&managed.user, None, None, Some(&user_layer));
    user_values.locked_fields.clear();
    let user_locks: Vec<String> = managed_locks(Some(&managed.organization), Some(&managed.team))
        .into_iter()
        .collect();
    let organization_locks = managed.organization.locked_fields.clone();
    let team_locks = managed.team.locked_fields.clone();
    Ok(GatewayGovernanceSnapshot {
        schema_version: schema_version(),
        layers: vec![
            GovernanceLayerResponse {
                revision: local.revision,
                scope: GovernanceScope::Node,
                unavailable_reason: None,
                values: local.node,
                writable: true,
                locked_fields: Vec::new(),
            },
            GovernanceLayerResponse {
                revision: managed.revision,
                scope: GovernanceScope::Organization,
                unavailable_reason: unavailable_reason.clone(),
                values: managed.organization,
                writable: false,
                locked_fields: organization_locks,
            },
            GovernanceLayerResponse {
                revision: managed.revision,
                scope: GovernanceScope::Team,
                unavailable_reason,
                values: managed.team,
                writable: false,
                locked_fields: team_locks,
            },
            GovernanceLayerResponse {
                revision: local.revision.max(managed.revision),
                scope: GovernanceScope::User,
                unavailable_reason: None,
                values: user_values,
                writable: true,
                locked_fields: user_locks,
            },
        ],
    })
}

async fn read_snapshot(
    state: &crate::server::ServerState,
    member: Option<&str>,
) -> Result<GatewayGovernanceSnapshot, String> {
    let local = state
        .preferences
        .get(LOCAL_GOVERNANCE_KEY)
        .await
        .map_err(|error| error.to_string())?;
    let managed = state
        .preferences
        .get(MANAGED_GOVERNANCE_KEY)
        .await
        .map_err(|error| error.to_string())?;
    snapshot_from_documents(
        local.as_deref(),
        managed.as_deref(),
        crate::sidecar::control_plane::gateway_key().is_some(),
        member,
    )
}

#[utoipa::path(
    get,
    path = "/api/gateway/governance",
    tag = "Gateway",
    summary = "Read Gateway governance (git, hook and worktree settings) with organization locks",
    responses((status = 200, description = "Effective settings per layer", body = serde_json::Value))
)]
pub async fn get_gateway_governance(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> Response {
    // An unverified caller on a bound node reads the node-local layer only;
    // it never sees (or writes) another member's user layer.
    let member = governance_member(caller.as_ref()).unwrap_or_default();
    match read_snapshot(&state, member.as_deref()).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn managed_user_locks(
    state: &crate::server::ServerState,
) -> std::collections::BTreeSet<String> {
    let managed = state
        .preferences
        .get(MANAGED_GOVERNANCE_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<ManagedGovernanceDocument>(&value).ok())
        .unwrap_or_default();
    managed_locks(Some(&managed.organization), Some(&managed.team))
}

/// `GET /api/gateway/org-features` — the organization feature toggles that
/// apply to the verified caller on this node, so the desktop can hide or
/// disable controls the organization turned off. An unbound node reports
/// `managed: false` and an empty map (everything stays available locally).
#[utoipa::path(
    get,
    path = "/api/gateway/org-features",
    tag = "Gateway",
    summary = "List the features your organization turned on or off for you",
    responses((status = 200, description = "Feature switches", body = serde_json::Value))
)]
pub async fn get_org_features(Extension(caller): Extension<Option<VerifiedCaller>>) -> Response {
    let user_id = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::org_policy::effective_features(user_id).await {
        Ok(None) => {
            Json(json!({ "managed": false, "available": true, "features": {} })).into_response()
        }
        Ok(Some(features)) => Json(json!({
            "managed": true,
            "available": true,
            "features": features,
        }))
        .into_response(),
        Err(error) => Json(json!({
            "managed": true,
            "available": false,
            "features": {},
            "error": error,
        }))
        .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct GovernanceUpdate {
    scope: GovernanceScope,
    values: Value,
}

fn apply_kind(
    target: &mut GatewayGovernanceValues,
    kind: &str,
    values: Value,
) -> Result<(), String> {
    match kind {
        "git" => {
            target.git = serde_json::from_value::<GitSettings>(values)
                .map_err(|error| format!("invalid git settings: {error}"))?;
        }
        "hooks" => {
            target.hooks = serde_json::from_value::<BTreeMap<String, HookPolicyOverride>>(values)
                .map_err(|error| format!("invalid hook settings: {error}"))?;
        }
        "worktrees" => {
            let settings = serde_json::from_value::<WorktreeSettings>(values)
                .map_err(|error| format!("invalid worktree settings: {error}"))?;
            if settings
                .root
                .as_deref()
                .map(str::trim)
                .filter(|root| !root.is_empty())
                .is_some_and(|root| !std::path::Path::new(root).is_absolute())
            {
                return Err("worktree root must be an absolute path".to_owned());
            }
            target.worktrees = settings;
        }
        _ => return Err("unknown governance kind".to_owned()),
    }
    Ok(())
}

#[utoipa::path(
    put,
    path = "/api/gateway/governance/{kind}",
    tag = "Gateway",
    summary = "Update Gateway git or worktree settings for this node or for you",
    params(("kind" = String, Path, description = "`git` or `worktrees`")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value))
)]
pub async fn put_gateway_governance(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(kind): Path<String>,
    Json(update): Json<GovernanceUpdate>,
) -> Response {
    if !matches!(update.scope, GovernanceScope::Node | GovernanceScope::User) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "organization and team policy are managed by the control plane" }),
            ),
        )
            .into_response();
    }
    if update.scope == GovernanceScope::Node
        && super::enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::GATEWAY_CONFIGURE,
        )
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: gateway.configure" })),
        )
            .into_response();
    }

    let stored = state
        .preferences
        .get(LOCAL_GOVERNANCE_KEY)
        .await
        .ok()
        .flatten();
    let mut document = stored
        .as_deref()
        .and_then(|value| serde_json::from_str::<LocalGovernanceDocument>(value).ok())
        .unwrap_or_default();
    let target = match update.scope {
        GovernanceScope::Node => &mut document.node,
        GovernanceScope::User => {
            let Ok(member) = governance_member(caller.as_ref()) else {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": "user governance on an organization node requires a verified user"
                    })),
                )
                    .into_response();
            };
            document.user_layer_mut(member.as_deref())
        }
        GovernanceScope::Organization | GovernanceScope::Team => unreachable!(),
    };
    if let Err(error) = apply_kind(target, &kind, update.values)
        .and_then(|()| validate_governance_values(update.scope, target))
    {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    // Fields an organization/team administrator locked cannot be overridden by
    // the user layer; drop any such value instead of persisting a dead override.
    if update.scope == GovernanceScope::User {
        let locks = managed_user_locks(&state).await;
        for path in declared_field_paths(target) {
            if locks.contains(&path) {
                clear_field_path(target, &path);
            }
        }
    }
    document.revision = document.revision.saturating_add(1);
    let encoded = match serde_json::to_string(&document) {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    if let Err(error) = state.preferences.set(LOCAL_GOVERNANCE_KEY, &encoded).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response();
    }
    get_gateway_governance(State(state), Extension(caller)).await
}

#[cfg(test)]
mod tests {
    use super::snapshot_from_documents;
    use crate::governance::GovernanceScope;

    #[test]
    fn runtime_worktrees_resolve_saved_layers_with_node_only_root() {
        let local = serde_json::json!({
            "node": { "worktrees": { "root": std::env::temp_dir(), "fetchUpstream": false, "autoDeleteLimit": 8 } },
            "user": { "worktrees": { "autoDelete": false } }
        }).to_string();
        let managed = r#"{"organization":{"worktrees":{"fetchUpstream":true}},"team":{"worktrees":{"autoDeleteLimit":5}},"user":{"worktrees":{"autoDelete":true,"root":"invalid-managed-root"}}}"#;
        let options =
            super::runtime_worktree_options_from_documents(Some(&local), Some(managed), None)
                .expect("runtime options");
        assert_eq!(options.root, Some(std::env::temp_dir()));
        assert!(options.fetch_upstream);
        assert!(!options.auto_delete);
        assert_eq!(options.auto_delete_limit, 5);
    }

    #[test]
    fn runtime_worktrees_defaults_and_invalid_saved_values() {
        let options =
            super::runtime_worktree_options_from_documents(None, None, None).expect("defaults");
        assert!(options.root.is_none());
        assert!(!options.fetch_upstream);
        assert!(options.auto_delete);
        assert_eq!(options.auto_delete_limit, 15);
        assert!(
            super::runtime_worktree_options_from_documents(Some("invalid"), None, None).is_err()
        );
        assert!(super::runtime_worktree_options_from_documents(
            Some(r#"{"node":{"worktrees":{"root":"relative"}}}"#),
            None,
            None
        )
        .is_err());
        assert!(super::runtime_worktree_options_from_documents(
            Some(r#"{"node":{"worktrees":{"autoDeleteLimit":101}}}"#),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn saving_worktrees_rejects_relative_root_and_accepts_default() {
        let mut values = crate::governance::GatewayGovernanceValues::default();
        assert!(super::apply_kind(
            &mut values,
            "worktrees",
            serde_json::json!({"root": "relative/path"})
        )
        .is_err());
        assert!(values.worktrees.root.is_none());
        super::apply_kind(&mut values, "worktrees", serde_json::json!({"root": ""}))
            .expect("default root");
        super::apply_kind(
            &mut values,
            "worktrees",
            serde_json::json!({"root": std::env::temp_dir()}),
        )
        .expect("absolute root");
    }

    #[test]
    fn unmanaged_snapshot_keeps_local_layers_and_marks_managed_layers_unavailable() {
        let local = r#"{
            "schemaVersion": 1,
            "revision": 3,
            "node": { "git": { "branchPrefix": "node/" } },
            "user": { "git": { "createDraftPullRequests": false } }
        }"#;

        let snapshot = snapshot_from_documents(Some(local), None, false, None)
            .expect("valid local governance document");

        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.layers.len(), 4);
        assert_eq!(snapshot.layers[0].scope, GovernanceScope::Node);
        assert!(snapshot.layers[0].writable);
        assert_eq!(snapshot.layers[1].scope, GovernanceScope::Organization);
        assert_eq!(
            snapshot.layers[1].unavailable_reason.as_deref(),
            Some("This node is not managed.")
        );
        assert_eq!(snapshot.layers[3].scope, GovernanceScope::User);
        assert_eq!(
            snapshot.layers[3].values.git.create_draft_pull_requests,
            Some(false)
        );
    }

    #[test]
    fn managed_snapshot_reports_locks_on_managed_and_user_layers() {
        let managed = r#"{
            "revision": 2,
            "organization": { "git": { "branchPrefix": "org/" }, "lockedFields": ["git.branchPrefix"] },
            "team": { "lockedFields": ["worktrees.autoDelete"] },
            "user": {}
        }"#;
        let local = r#"{ "user": { "git": { "branchPrefix": "me/" } } }"#;
        let snapshot = snapshot_from_documents(Some(local), Some(managed), true, None)
            .expect("managed snapshot");
        assert_eq!(
            snapshot.layers[1].locked_fields,
            vec!["git.branchPrefix".to_owned()]
        );
        assert_eq!(
            snapshot.layers[3].locked_fields,
            vec![
                "git.branchPrefix".to_owned(),
                "worktrees.autoDelete".to_owned()
            ]
        );
        let options = super::runtime_worktree_options_from_documents(
            Some(r#"{"user":{"worktrees":{"autoDelete":false}}}"#),
            Some(managed),
            None,
        )
        .expect("runtime options");
        // The team locked autoDelete, so the user's `false` cannot apply.
        assert!(options.auto_delete);
    }

    #[test]
    fn bound_nodes_keep_one_user_layer_per_verified_member() {
        // Unbound/personal nodes keep the single node-local layer.
        assert_eq!(super::member_for(false, Some("alice")), Ok(None));
        assert_eq!(super::member_for(false, None), Ok(None));
        // Bound nodes key by the verified id and refuse unverified writers.
        assert_eq!(
            super::member_for(true, Some("alice")),
            Ok(Some("alice".to_owned()))
        );
        assert_eq!(super::member_for(true, None), Err(()));
        assert_eq!(super::member_for(true, Some(" ")), Err(()));

        // A legacy document's single `user` value migrates as the local layer.
        let legacy = r#"{ "user": { "git": { "branchPrefix": "legacy/" } } }"#;
        let mut document: super::LocalGovernanceDocument =
            serde_json::from_str(legacy).expect("legacy document");
        document.user_layer_mut(Some("alice")).git.branch_prefix = Some("alice/".to_owned());
        document.user_layer_mut(Some("bob")).git.branch_prefix = Some("bob/".to_owned());
        assert_eq!(
            document.user_layer(None).git.branch_prefix.as_deref(),
            Some("legacy/")
        );
        let encoded = serde_json::to_string(&document).expect("encode");

        let layer_for = |member: Option<&str>| {
            snapshot_from_documents(Some(&encoded), None, true, member)
                .expect("snapshot")
                .layers[3]
                .values
                .git
                .branch_prefix
                .clone()
        };
        assert_eq!(layer_for(Some("alice")).as_deref(), Some("alice/"));
        assert_eq!(layer_for(Some("bob")).as_deref(), Some("bob/"));
        // A member with no saved layer sees nobody else's values.
        assert_eq!(layer_for(Some("carol")), None);
        assert_eq!(layer_for(None).as_deref(), Some("legacy/"));

        let alice = r#"{ "users": { "alice": { "worktrees": { "autoDelete": false } } } }"#;
        let for_alice =
            super::runtime_worktree_options_from_documents(Some(alice), None, Some("alice"))
                .expect("alice options");
        assert!(!for_alice.auto_delete);
        let for_bob =
            super::runtime_worktree_options_from_documents(Some(alice), None, Some("bob"))
                .expect("bob options");
        assert!(for_bob.auto_delete);
    }

    #[test]
    fn malformed_stored_documents_fail_soft_to_empty_layers() {
        let snapshot = snapshot_from_documents(Some("not-json"), Some("[]"), true, None)
            .expect("stored corruption is isolated from the management read");

        assert_eq!(snapshot.layers.len(), 4);
        assert!(snapshot
            .layers
            .iter()
            .all(|layer| layer.values.hooks.is_empty()));
    }
}
