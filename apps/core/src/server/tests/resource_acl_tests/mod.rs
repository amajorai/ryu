use crate::identity_verify::{Access, OrgRole, ResourceTenancy, TeamMembership, VerifiedCaller};
use crate::server::{require_resource_read_at, require_resource_write_at, resource_access};
use axum::http::StatusCode;

/// This node is bound to `org1` — a SHARED "company brain" node. This is the
/// mode the per-resource ACL exists for, and every denial case below is stated
/// in it. (`None` = an unbound personal node, where the node token is the
/// boundary by design; see the `resource_access` preamble.)
const BOUND: Option<&str> = Some("org1");
const UNBOUND: Option<&str> = None;

/// A resource owned by `owner`, scoped to `org`, at `visibility`.
fn scoped(
    owner: Option<&str>,
    org: Option<&str>,
    visibility: &str,
) -> anyhow::Result<Option<ResourceTenancy>> {
    Ok(Some(ResourceTenancy {
        owner_user_id: owner.map(str::to_owned),
        org_id: org.map(str::to_owned),
        visibility: visibility.to_owned(),
        team_id: None,
        collaborators: Vec::new(),
    }))
}

fn caller(user_id: &str, org: Option<&str>, role: OrgRole) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: org.map(str::to_owned),
        role,
        teams: Vec::new(),
    }
}

fn status(result: Result<(), axum::response::Response>) -> Option<StatusCode> {
    result.err().map(|resp| resp.status())
}

mod newly_gated;
mod row_node;
