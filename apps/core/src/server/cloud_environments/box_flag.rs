//! The Fresh cloud box rollout gate (`cloud_tasks.box_backend`).

use super::*;

pub(in crate::server) const BOX_BACKEND_FLAG: &str = "cloud_tasks.box_backend";

/// Who is asking for the box backend, as far as the rollout gate is concerned.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum BoxFeatureSubject<'a> {
    /// The node owner over the node credential with no cloud identity at all.
    LocalOwner,
    /// Any request that carries, or claims, a cloud user identity: a verified
    /// caller, or a user principal. `token` is the request's already verified
    /// user JWT when one exists.
    Cloud { token: Option<&'a str> },
}

pub(super) fn box_feature_subject(auth: &ResolvedAuthorization) -> BoxFeatureSubject<'_> {
    use crate::authorization::Principal;
    if auth.caller.is_none() && matches!(auth.context.principal, Principal::Owner) {
        BoxFeatureSubject::LocalOwner
    } else {
        BoxFeatureSubject::Cloud {
            token: auth.verified_user_jwt.as_deref(),
        }
    }
}

pub(super) fn box_feature_unavailable() -> ApiError {
    error(
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable",
        "The Fresh cloud box backend is not enabled for this account yet.",
    )
}

pub(super) fn box_feature_wrong_org() -> ApiError {
    error(
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable",
        "The Fresh cloud box backend was evaluated for a different organization. Switch to this node's organization and try again.",
    )
}

/// Authoritative Core gate for the `cloud_tasks.box_backend` rollout flag.
///
/// - Verified cloud caller (or any user principal): the flag must be in the
///   signed `ryu_flags` claim of the request's verified user JWT. No token, a
///   token that no longer verifies, or a claim without the key is 403
///   `cloud_environment_feature_unavailable` — fail closed. The claim is
///   evaluated by the control plane when the token is minted, so a flip (or a
///   kill switch) reaches Core within one token lifetime (Better Auth's JWT
///   default is 15 minutes); Core never calls the control plane here.
/// - Org context: the claim is evaluated for one organization (the session's
///   active org at mint, carried as `ryu_flags_org`), so org-role and
///   plan-targeted rules can be on in it. Cloud environments are stored per
///   user and record no org of their own; on an org-bound node they run under
///   the node's org, so a claim evaluated for a DIFFERENT org is refused (same
///   403 code). A claim with no org context (the user belongs to no org, or a
///   token minted before the org claim) carries only user-scoped evaluation and
///   is used as-is, as is any claim on a personal (unbound) node.
/// - Local owner with no cloud identity (node credential, no user JWT): there
///   is no per-user flag to read, so this gate does not apply. The node's Box
///   service configuration remains the gate (`session_box::box_configured()`:
///   the env credential or the installed control-plane source, at prepare,
///   launch and prompt; 503 `cloud_environment_backend_unavailable`).
pub(in crate::server) async fn require_box_backend_feature(
    auth: &ResolvedAuthorization,
) -> Result<(), ApiError> {
    let flags = match box_feature_subject(auth) {
        BoxFeatureSubject::LocalOwner => return Ok(()),
        BoxFeatureSubject::Cloud { token: None } => None,
        BoxFeatureSubject::Cloud { token: Some(token) } => {
            crate::identity_verify::verified_feature_flags(token).await
        }
    };
    box_backend_flag_decision(flags.as_ref(), gate_node_org().as_deref())
}

#[cfg(test)]
tokio::task_local! {
    /// Test-only node org for the box gate. Route tests scope a request with it
    /// to run as an org-bound node without registering one process-wide, which
    /// would change every concurrently running test that reads the binding.
    pub(in crate::server) static TEST_NODE_ORG: Option<String>;
}

/// The org this node is bound to, as the box gate sees it.
pub(super) fn gate_node_org() -> Option<String> {
    #[cfg(test)]
    if let Ok(org) = TEST_NODE_ORG.try_with(Clone::clone) {
        return org;
    }
    crate::server::node_org_id()
}

/// The pure half of [`require_box_backend_feature`]: `flags` is the verified
/// claim (or `None` when nothing verified) and `node_org` this node's bound
/// org, if any.
pub(super) fn box_backend_flag_decision(
    flags: Option<&crate::identity_verify::VerifiedFeatureFlags>,
    node_org: Option<&str>,
) -> Result<(), ApiError> {
    let Some(flags) = flags.filter(|flags| flags.keys.contains(BOX_BACKEND_FLAG)) else {
        return Err(box_feature_unavailable());
    };
    match (node_org, flags.org.as_deref()) {
        (Some(node_org), Some(claim_org)) if node_org != claim_org => Err(box_feature_wrong_org()),
        _ => Ok(()),
    }
}

/// True when a save selects the box backend for an environment that did not
/// already have it. Only these saves need the rollout flag: an environment the
/// user saved while the flag was on stays editable (it still cannot start
/// without the flag, because prepare, launch and prompt check again).
pub(super) fn newly_selects_box(previous: &Snapshot, incoming: &Snapshot) -> bool {
    incoming.environments.iter().any(|environment| {
        environment.runtime.backend == "box"
            && !previous
                .environments
                .iter()
                .any(|old| old.id == environment.id && old.runtime.backend == "box")
    })
}
