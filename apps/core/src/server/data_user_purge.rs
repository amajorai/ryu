//! Per-member app data purge: the fan-out behind account deletion and member
//! removal.
//!
//! `POST /api/data/purge-user` `{ user_id, reason? }` asks every enabled app
//! that declares data categories, and serves a per-member `data.purge`, to
//! delete that one person's data: `data.purge { category, user_id }`. It is the
//! per-person twin of the Danger Zone (`data_admin`), which clears a whole
//! category.
//!
//! # A purge is complete only when the report says so
//!
//! The report carries `complete`. It is `false`, and the status is not 200,
//! whenever any of that person's app data may remain: an app failed (502), or
//! an app declaring data categories was `skipped` (no per-member purge) or is
//! `disabled` (its sidecar cannot be asked) (409). A caller must treat anything
//! but `complete: true` as an unfinished deletion and retry (after the app is
//! enabled or updated) or escalate; it must never record it as done.
//!
//! # Which apps take part
//!
//! An older app reads `data.purge { category }` and ignores fields it does not
//! know, so sending it a `user_id` would wipe the whole category for everyone.
//! A provider therefore opts in by declaring its `data.purge` provides row at
//! version [`PER_USER_PURGE_VERSION`] or later, which promises it honours
//! `user_id` (and `data.count { category, user_id }`). Apps that declare data
//! categories without that promise are reported under `skipped` and never
//! called.
//!
//! # Who may ask
//!
//! - A member, for their own data.
//! - An owner or admin of the organization this node is bound to, for anyone
//!   on this node. An admin of any other organization is refused.
//! - The node owner token on an unbound (personal) node. On an org-bound node
//!   the token is shared by every device, so it counts only from a trusted
//!   local peer, as the Danger Zone refuses unscoped node-token deletes there.
//!
//! The route is not in the OpenAPI document, so no agent tool can reach it.
//! Scoped credentials (OAuth, MCP, paired devices) are kept out by
//! `credential_route_policy`. No control-plane credential reaches it yet: the
//! cloud's account-deletion job and member-removal hooks run without the
//! member's session, so they need a purge-scoped control-plane delegation (or
//! a Core pull of pending purges) before they can call it.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_manifest::PluginManifest;
use crate::sidecar::capability_consumer::CapabilityConsumer;

const CAP_DATA_COUNT: &str = "data.count";
const CAP_DATA_PURGE: &str = "data.purge";
/// The first `data.purge` provides version that honours `user_id`.
pub(crate) const PER_USER_PURGE_VERSION: &str = "1.1.0";
const MAX_USER_ID_BYTES: usize = 256;

/// Body of `POST /api/data/purge-user`.
#[derive(Debug, Deserialize)]
pub struct PurgeUserRequest {
    /// The member whose app data is deleted.
    pub user_id: String,
    /// Why: `account_deleted`, `member_removed` or `self`. Only the matching
    /// [`PurgeReason`] is logged (any other text as `other`); nothing is stored.
    #[serde(default)]
    pub reason: Option<String>,
}

/// Why a member's app data is purged. A caller's free text is never logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeReason {
    AccountDeleted,
    MemberRemoved,
    SelfRequested,
    /// Any other value a caller sends.
    Other,
}

impl PurgeReason {
    /// The reason a request's `reason` text names.
    pub(crate) fn parse(text: &str) -> Self {
        match text.trim() {
            "account_deleted" => Self::AccountDeleted,
            "member_removed" => Self::MemberRemoved,
            "self" => Self::SelfRequested,
            _ => Self::Other,
        }
    }

    /// The value logged for this reason.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AccountDeleted => "account_deleted",
            Self::MemberRemoved => "member_removed",
            Self::SelfRequested => "self",
            Self::Other => "other",
        }
    }
}

/// How the request presented the node owner token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnerToken {
    /// Not at all.
    Absent,
    /// From anywhere but a trusted local peer.
    Remote,
    /// From a trusted local peer (`request_is_from_local_owner`).
    LocalPeer,
}

/// Whether `manifest` promises a per-member `data.purge`: it provides
/// `data.count` and provides `data.purge` at [`PER_USER_PURGE_VERSION`] or later.
pub(crate) fn supports_per_user_purge(manifest: &PluginManifest) -> bool {
    let minimum = semver::Version::parse(PER_USER_PURGE_VERSION).expect("valid constant");
    let provides = manifest.provided_capabilities();
    provides.iter().any(|p| p.capability == CAP_DATA_COUNT)
        && provides.iter().any(|p| {
            p.capability == CAP_DATA_PURGE
                && semver::Version::parse(p.version.trim()).is_ok_and(|v| v >= minimum)
        })
}

/// The data categories `manifest` declares.
fn declared_categories(manifest: &PluginManifest) -> Vec<String> {
    manifest
        .contributes
        .as_ref()
        .map(|contributes| {
            contributes
                .data_categories
                .iter()
                .map(|category| category.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Which apps a per-member purge reaches, and which hold data it cannot.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PurgePlan {
    /// Enabled, opted-in apps to call: `(plugin, categories)`.
    pub(crate) targets: Vec<(String, Vec<String>)>,
    /// Enabled apps declaring data categories without a per-member purge.
    pub(crate) skipped: Vec<String>,
    /// Disabled apps declaring data categories: their sidecar cannot be asked.
    pub(crate) disabled: Vec<String>,
}

impl PurgePlan {
    /// Whether every app holding data categories is called.
    pub(crate) fn reaches_every_app(&self) -> bool {
        self.skipped.is_empty() && self.disabled.is_empty()
    }
}

/// Plan a per-member purge over `manifests`. No app that declares data
/// categories is left out silently: each one is a target, `skipped` or
/// `disabled`.
pub(crate) fn plan_user_purge<'a>(
    manifests: impl IntoIterator<Item = &'a PluginManifest>,
    enabled: &dyn Fn(&str) -> bool,
) -> PurgePlan {
    let mut plan = PurgePlan::default();
    for manifest in manifests {
        let categories = declared_categories(manifest);
        if categories.is_empty() {
            continue;
        }
        if !enabled(&manifest.id) {
            plan.disabled.push(manifest.id.clone());
        } else if supports_per_user_purge(manifest) {
            plan.targets.push((manifest.id.clone(), categories));
        } else {
            plan.skipped.push(manifest.id.clone());
        }
    }
    plan
}

/// Whether a request may purge `user_id`'s data. `node_org` is the
/// organization this node is bound to (`None`: a personal node).
pub(crate) fn may_purge(
    owner_token: OwnerToken,
    caller: Option<&VerifiedCaller>,
    user_id: &str,
    node_org: Option<&str>,
) -> bool {
    match owner_token {
        OwnerToken::LocalPeer => return true,
        OwnerToken::Remote if node_org.is_none() => return true,
        OwnerToken::Remote | OwnerToken::Absent => {}
    }
    caller.is_some_and(|caller| {
        caller.user_id == user_id
            || node_org.is_some_and(|node_org| {
                caller.org_id.as_deref() == Some(node_org) && caller.role.satisfies(OrgRole::Admin)
            })
    })
}

/// Fan `data.purge { category, user_id }` out to every opted-in enabled app.
/// Returns `{ removed, apps: [{ plugin, category, removed | error }], skipped,
/// disabled, complete }`; `complete` is true only when every app holding data
/// categories was called and none failed.
pub(crate) async fn purge_user_app_data(state: &ServerState, user_id: &str) -> Value {
    let enabled = super::enabled_plugin_records(state)
        .await
        .unwrap_or_default();
    let plan = {
        let manifests = state.app_manifests.read().await;
        plan_user_purge(manifests.iter(), &|id| enabled.contains_key(id))
    };
    let reaches_every_app = plan.reaches_every_app();
    let PurgePlan {
        targets,
        skipped,
        disabled,
    } = plan;
    let consumer = CapabilityConsumer::from_state(state);
    let mut total = 0u64;
    let mut apps = Vec::new();
    for (plugin, categories) in targets {
        for category in categories {
            let body = json!({ "category": category, "user_id": user_id });
            let outcome = consumer
                .call_provider_capability(&plugin, CAP_DATA_PURGE, &body)
                .await;
            let removed = match outcome {
                Ok(reply) if reply.is_success() => {
                    reply.body.get("removed").and_then(Value::as_u64)
                }
                _ => None,
            };
            match removed {
                Some(removed) => {
                    total += removed;
                    apps.push(
                        json!({ "plugin": plugin, "category": category, "removed": removed }),
                    );
                }
                None => apps.push(
                    json!({ "plugin": plugin, "category": category, "error": "purge failed" }),
                ),
            }
        }
    }
    crate::scheduler::app_jobs::reconcile_all(Some(&consumer)).await;
    let failed = apps.iter().any(|app| app.get("error").is_some());
    json!({
        "removed": total,
        "apps": apps,
        "skipped": skipped,
        "disabled": disabled,
        "complete": reaches_every_app && !failed,
    })
}

/// The status for a purge report: 200 only when it is complete, 502 when an
/// app failed, 409 when an app holding data was skipped or is disabled.
pub(crate) fn purge_report_status(report: &Value) -> StatusCode {
    let failed = report["apps"]
        .as_array()
        .is_some_and(|apps| apps.iter().any(|app| app.get("error").is_some()));
    if failed {
        StatusCode::BAD_GATEWAY
    } else if report["complete"].as_bool() == Some(true) {
        StatusCode::OK
    } else {
        StatusCode::CONFLICT
    }
}

/// `POST /api/data/purge-user` body `{ user_id, reason? }`.
pub async fn purge_user(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(request): Json<PurgeUserRequest>,
) -> (StatusCode, Json<Value>) {
    let user_id = request.user_id.trim();
    if user_id.is_empty() || user_id.len() > MAX_USER_ID_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "user_id is required" })),
        );
    }
    let owner_token = if !crate::server::request_presents_owner_token() {
        OwnerToken::Absent
    } else if crate::server::request_is_from_local_owner() {
        OwnerToken::LocalPeer
    } else {
        OwnerToken::Remote
    };
    let node_org = super::node_org_id();
    if !may_purge(owner_token, caller.as_ref(), user_id, node_org.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(
                json!({ "error": "forbidden: only the member, an admin of this node's organization or the node owner may purge this data" }),
            ),
        );
    }
    let report = purge_user_app_data(&state, user_id).await;
    let status = purge_report_status(&report);
    tracing::info!(
        reason = request
            .reason
            .as_deref()
            .map_or("unspecified", |text| PurgeReason::parse(text).as_str()),
        removed = report["removed"].as_u64().unwrap_or(0),
        complete = report["complete"].as_bool().unwrap_or(false),
        status = status.as_u16(),
        "data/purge-user: per-member app data purge fanned out"
    );
    (status, Json(report))
}

#[cfg(test)]
#[path = "data_user_purge_tests.rs"]
mod tests;
