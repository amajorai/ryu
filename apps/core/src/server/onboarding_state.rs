//! Node-level onboarding state.
//!
//! This is deliberately separate from the desktop's local onboarding marker.
//! The node owns the setup mode and the shared context that can affect every
//! client connected to it; the desktop owns its own appearance and window
//! preferences. Keeping the boundary here means a new desktop can discover an
//! unfinished node setup, while a returning desktop does not re-run its theme
//! choices just because it connected to another node.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use super::{preferences::PreferencesStore, ServerState};

/// Preferences key for the node's durable onboarding contract.
pub const NODE_ONBOARDING_STATE_PREF_KEY: &str = "node-onboarding-state";

/// Preference key used only by the owner of a registered personal node.
pub const USER_PERSONALIZATION_PREF_KEY: &str = "user-personalization";

/// Current wire/schema version. A future migration can preserve the same
/// endpoint while making old state explicitly incomplete instead of silently
/// treating it as a completed setup.
pub const NODE_ONBOARDING_STATE_VERSION: u32 = 1;

const MAX_COMPANY_CONTEXT_CHARS: usize = 4000;

/// Whether this node is being prepared for one person's private work or a
/// shared team/company workspace.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NodeSetupKind {
    Personal,
    Team,
}

/// Node-level context used by the company knowledge path. It is intentionally
/// bounded and contains no credentials or source contents; connected sources
/// remain read-only inputs to the later profile/knowledge step.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeOnboardingPersonalization {
    pub company_context: String,
    pub company_knowledge_enabled: bool,
}

/// Durable state shared by every desktop connected to this Core node.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeOnboardingState {
    pub completed: bool,
    pub completed_at_ms: Option<i64>,
    pub personalization: NodeOnboardingPersonalization,
    pub setup_kind: Option<NodeSetupKind>,
    pub version: u32,
}

impl Default for NodeOnboardingState {
    fn default() -> Self {
        Self {
            completed: false,
            completed_at_ms: None,
            personalization: NodeOnboardingPersonalization::default(),
            setup_kind: None,
            version: NODE_ONBOARDING_STATE_VERSION,
        }
    }
}

/// State plus the live node permission used by the Gateway settings surface.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct NodeOnboardingStateView {
    #[serde(flatten)]
    state: NodeOnboardingState,
    can_configure: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct NodeOnboardingStateUpdate {
    #[serde(default)]
    company_context: String,
    #[serde(default = "default_company_knowledge_enabled")]
    company_knowledge_enabled: bool,
    #[serde(default)]
    completed: bool,
    setup_kind: NodeSetupKind,
}

fn default_company_knowledge_enabled() -> bool {
    true
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn bounded_context(value: &str) -> String {
    value
        .trim()
        .chars()
        .take(MAX_COMPANY_CONTEXT_CHARS)
        .collect()
}

fn normalize_state(mut state: NodeOnboardingState) -> NodeOnboardingState {
    state.version = NODE_ONBOARDING_STATE_VERSION;
    state.personalization.company_context = bounded_context(&state.personalization.company_context);
    if state.setup_kind != Some(NodeSetupKind::Team) {
        state.personalization.company_context.clear();
        state.personalization.company_knowledge_enabled = false;
    }
    // A completed node must always have a mode. Treat malformed or legacy
    // records as incomplete so the desktop gets the setup step instead of
    // claiming a shared node was configured when it was not.
    if state.completed && state.setup_kind.is_none() {
        state.completed = false;
        state.completed_at_ms = None;
    }
    state
}

/// Read the persisted node state. Missing state is the honest first-run value.
pub async fn read_state(preferences: &PreferencesStore) -> anyhow::Result<NodeOnboardingState> {
    let Some(raw) = preferences.get(NODE_ONBOARDING_STATE_PREF_KEY).await? else {
        return Ok(NodeOnboardingState::default());
    };
    match serde_json::from_str::<NodeOnboardingState>(&raw) {
        Ok(state) => Ok(normalize_state(state)),
        Err(error) => {
            tracing::warn!(error = %error, "node onboarding state is invalid; treating it as incomplete");
            Ok(NodeOnboardingState::default())
        }
    }
}

fn view(state: NodeOnboardingState, can_configure: bool) -> Json<NodeOnboardingStateView> {
    Json(NodeOnboardingStateView {
        state: normalize_state(state),
        can_configure,
    })
}

/// Whether the verified caller may change node onboarding state.
///
/// An unbound local node has one trusted operator. A personal registered node
/// also keeps its owner boundary. Org/team nodes use the same server-side
/// `gateway.configure` permission as the rest of Gateway configuration, so a
/// team member cannot turn shared company context on or reset it by editing the
/// client request.
pub async fn can_configure(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    // A managed node is controlled by Ryu Cloud until its registration has
    // resolved. Do not let the temporary absence of a RegisteredNode turn the
    // shared-node default into an allow-all configuration path.
    if crate::sidecar::control_plane::is_managed_node() {
        return false;
    }
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return true;
    };

    if node.scope == crate::sidecar::control_plane::NodeScope::Personal {
        // Personal nodes are strictly owner-scoped. `gateway.configure` is an
        // organization permission and must not let a same-org administrator
        // rewrite another member's private node onboarding state.
        return personal_owner_matches(&node, caller);
    }

    let Some(current_caller) = caller.as_ref() else {
        return false;
    };
    if !caller_in_node_scope(&node, current_caller) {
        return false;
    }

    super::enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_ok()
}

fn denied() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "insufficient permissions: gateway.configure" })),
    )
        .into_response()
}

fn personal_owner_matches(
    node: &crate::sidecar::control_plane::RegisteredNode,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    node.owner_user_id.as_deref() == caller.as_ref().map(|current| current.user_id.as_str())
}

/// Keep registered-node scope separate from the permission grant. A custom
/// `gateway.configure` grant can widen what an in-scope caller may do, but it
/// must never move that caller across a personal or team node boundary.
pub(super) fn caller_in_node_scope(
    node: &crate::sidecar::control_plane::RegisteredNode,
    caller: &crate::identity_verify::VerifiedCaller,
) -> bool {
    match node.scope {
        crate::sidecar::control_plane::NodeScope::Personal => {
            node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
        }
        crate::sidecar::control_plane::NodeScope::Org => {
            caller.org_id.as_deref() == Some(node.org.id.as_str())
                && node.team_id.is_none()
                && node.owner_user_id.is_none()
        }
        crate::sidecar::control_plane::NodeScope::Team => {
            caller.org_id.as_deref() == Some(node.org.id.as_str())
                && node.owner_user_id.is_none()
                && node.team_id.as_deref().is_some_and(|team_id| {
                    caller
                        .teams
                        .iter()
                        .any(|team| team.id == team_id && team.org_id == node.org.id)
                })
        }
    }
}

/// The personal onboarding note is stored in the node's preferences database,
/// so it is readable only on an unbound node or by the owner of a registered
/// personal node. Shared and managed nodes must never expose this key.
pub fn can_access_user_personalization(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    if crate::sidecar::control_plane::is_managed_node() {
        return false;
    }
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return true;
    };
    node.scope == crate::sidecar::control_plane::NodeScope::Personal
        && personal_owner_matches(&node, caller)
}

pub fn routes() -> Router<ServerState> {
    Router::new().route(
        "/api/onboarding/state",
        get(get_state).put(put_state).delete(delete_state),
    )
}

#[utoipa::path(
    get,
    path = "/api/onboarding/state",
    tag = "Preferences",
    summary = "Get node onboarding state",
    responses((status = 200, description = "Node onboarding state", body = NodeOnboardingStateView))
)]
pub(crate) async fn get_state(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    match read_state(&state.preferences).await {
        Ok(onboarding) => view(onboarding, can_configure(&state, &caller).await).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

#[utoipa::path(
    put,
    path = "/api/onboarding/state",
    tag = "Preferences",
    summary = "Save node onboarding state",
    request_body = NodeOnboardingStateUpdate,
    responses((status = 200, description = "Saved node onboarding state", body = NodeOnboardingStateView))
)]
pub(crate) async fn put_state(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(update): Json<NodeOnboardingStateUpdate>,
) -> Response {
    if !can_configure(&state, &caller).await {
        return denied();
    }

    let setup_kind = update.setup_kind;
    let company_knowledge_enabled =
        setup_kind == NodeSetupKind::Team && update.company_knowledge_enabled;
    let next = normalize_state(NodeOnboardingState {
        completed: update.completed,
        completed_at_ms: update.completed.then_some(now_ms()),
        personalization: NodeOnboardingPersonalization {
            company_context: if setup_kind == NodeSetupKind::Team {
                bounded_context(&update.company_context)
            } else {
                String::new()
            },
            company_knowledge_enabled,
        },
        setup_kind: Some(setup_kind),
        version: NODE_ONBOARDING_STATE_VERSION,
    });

    let encoded = match serde_json::to_string(&next) {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    if let Err(error) = state
        .preferences
        .set(NODE_ONBOARDING_STATE_PREF_KEY, &encoded)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response();
    }
    view(next, true).into_response()
}

#[utoipa::path(
    delete,
    path = "/api/onboarding/state",
    tag = "Preferences",
    summary = "Reset node onboarding state",
    responses((status = 200, description = "Reset node onboarding state", body = NodeOnboardingStateView))
)]
pub(crate) async fn delete_state(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if !can_configure(&state, &caller).await {
        return denied();
    }
    if let Err(error) = state
        .preferences
        .delete(NODE_ONBOARDING_STATE_PREF_KEY)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response();
    }
    view(NodeOnboardingState::default(), true).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn personal_node(owner_user_id: Option<&str>) -> crate::sidecar::control_plane::RegisteredNode {
        crate::sidecar::control_plane::RegisteredNode {
            org: crate::sidecar::control_plane::RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: crate::sidecar::control_plane::NodeScope::Personal,
            team_id: None,
            owner_user_id: owner_user_id.map(str::to_owned),
        }
    }

    fn team_node(team_id: Option<&str>) -> crate::sidecar::control_plane::RegisteredNode {
        crate::sidecar::control_plane::RegisteredNode {
            org: crate::sidecar::control_plane::RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: crate::sidecar::control_plane::NodeScope::Team,
            team_id: team_id.map(str::to_owned),
            owner_user_id: None,
        }
    }

    fn caller(user_id: &str) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            org_id: Some("org-1".to_owned()),
            role: crate::identity_verify::OrgRole::Admin,
            teams: Vec::new(),
        }
    }

    #[test]
    fn missing_state_is_an_incomplete_first_run() {
        let state = NodeOnboardingState::default();
        assert!(!state.completed);
        assert_eq!(state.setup_kind, None);
        assert_eq!(state.version, NODE_ONBOARDING_STATE_VERSION);
    }

    #[test]
    fn personal_state_never_keeps_shared_company_context() {
        let state = normalize_state(NodeOnboardingState {
            completed: true,
            completed_at_ms: Some(1),
            personalization: NodeOnboardingPersonalization {
                company_context: "secret company context".to_owned(),
                company_knowledge_enabled: true,
            },
            setup_kind: Some(NodeSetupKind::Personal),
            version: 99,
        });
        assert!(state.completed);
        assert!(state.personalization.company_context.is_empty());
        assert!(!state.personalization.company_knowledge_enabled);
        assert_eq!(state.version, NODE_ONBOARDING_STATE_VERSION);
    }

    #[test]
    fn completed_state_without_a_mode_is_incomplete() {
        let state = normalize_state(NodeOnboardingState {
            completed: true,
            completed_at_ms: Some(1),
            personalization: NodeOnboardingPersonalization::default(),
            setup_kind: None,
            version: 1,
        });
        assert!(!state.completed);
        assert_eq!(state.completed_at_ms, None);
    }

    #[test]
    fn personal_node_configuration_is_strictly_owner_scoped() {
        let node = personal_node(Some("owner"));
        assert!(personal_owner_matches(&node, &Some(caller("owner"))));
        assert!(!personal_owner_matches(&node, &Some(caller("admin"))));
        assert!(!personal_owner_matches(&node, &None));
        assert!(!personal_owner_matches(
            &personal_node(None),
            &Some(caller("owner"))
        ));
    }

    #[test]
    fn team_node_configuration_requires_the_registered_team() {
        let node = team_node(Some("team-1"));
        let mut member = caller("member");
        member.role = crate::identity_verify::OrgRole::Member;
        member.teams.push(crate::identity_verify::TeamMembership {
            id: "team-1".to_owned(),
            org_id: "org-1".to_owned(),
            role: "member".to_owned(),
        });
        assert!(caller_in_node_scope(&node, &member));

        member.teams[0].id = "team-2".to_owned();
        assert!(!caller_in_node_scope(&node, &member));
        assert!(!caller_in_node_scope(&node, &caller("admin")));
    }
}
