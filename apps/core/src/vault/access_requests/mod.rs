//! Generic access requests: time-bound, approval-gated access to a path.
//!
//! A member asks for capabilities on a glob in one environment
//! (`prod/payments/**`) for a duration, with a reason. Admin-written
//! **access policies** say who approves what: each names a path glob, the
//! capabilities that may be requested under it, the longest duration it
//! allows, and an ordered chain of approval steps. Steps reuse the
//! control-group factor shape (approver subjects plus a count of distinct
//! approvals) and run in order: a step opens only once every earlier step is
//! satisfied.
//!
//! Every access policy whose path may overlap the request applies, so a
//! stricter policy on part of the reach always joins the chain (steps
//! concatenate in policy-name order, the shortest maximum duration and
//! request lifetime win, and each must allow every requested capability). At
//! least one of them must cover the whole request; a path no policy covers
//! cannot be requested at all.
//!
//! When the last step is satisfied the request is granted through the
//! existing binding-expiry machinery: Core writes a one-rule policy
//! `access-<id>` and binds it to the requester with `expires_at` set to the
//! end of the duration. Expired bindings stop applying at once and the
//! scheduler prunes them; revoking deletes the policy and its binding.
//!
//! Safety rules: requesters never approve their own request, one person
//! counts toward one step only, a pending request lapses after its lifetime,
//! approvals gathered under a since-changed chain never grant, `admin` and
//! `approve` can never be requested, and `read` cannot be requested on a path
//! a control group may gate (approval there would bypass the control group).

mod paths;
mod store;

pub use paths::{covers, may_overlap, validate_glob};
pub use store::{
    approve, cancel, create_request, deny, get_request, init_schema, list_requests, prune, revoke,
    NewAccessRequest,
};

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::policy::{Capability, Policy};
use super::policy_ext::{ControlGroupApproval, ControlGroupFactor, ControlGroupSpec};
use super::{now_millis, VaultError};

/// Capabilities a request may ask for. `admin` and `approve` never: a grant
/// must not let its holder rewrite policies or approve requests.
pub const REQUESTABLE: [Capability; 5] = [
    Capability::List,
    Capability::Use,
    Capability::Read,
    Capability::Write,
    Capability::Delete,
];
/// Grant duration bounds (seconds).
pub const MIN_DURATION_SECS: i64 = 60;
pub const MAX_DURATION_SECS: i64 = 30 * 24 * 3600;
/// Maximum access policies per node.
pub const MAX_ACCESS_POLICIES: usize = 64;
/// Maximum approval steps one request may chain.
pub const MAX_CHAIN_STEPS: usize = 10;
/// Maximum reason length.
pub const MAX_REASON_LEN: usize = 512;
/// Name prefix of the policy a grant writes.
pub const GRANT_POLICY_PREFIX: &str = "access-";

/// Who approves requests under a path, and how far they may reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPolicy {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Glob over `ENV/folder/NAME` that requests may fall under.
    pub path: String,
    /// Capabilities that may be requested under `path`.
    pub capabilities: Vec<Capability>,
    /// Longest grant this policy allows.
    pub max_duration_secs: i64,
    /// How long a request waits for its approvals (default one day).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_ttl_secs: Option<i64>,
    /// Sequential approval steps.
    pub steps: Vec<ControlGroupFactor>,
}

impl AccessPolicy {
    fn spec(&self) -> ControlGroupSpec {
        ControlGroupSpec {
            ttl_secs: self.request_ttl_secs,
            factors: self.steps.clone(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if !super::policy::is_valid_policy_name(&self.name) {
            bail!("access policy name must be 1-64 characters of [a-z0-9_-]");
        }
        if self.description.len() > 512 {
            bail!("access policy description is too long");
        }
        validate_glob(&self.path, false)?;
        validate_capabilities(&self.capabilities)?;
        if !(MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&self.max_duration_secs) {
            bail!("maxDurationSecs must be between {MIN_DURATION_SECS} and {MAX_DURATION_SECS}");
        }
        self.spec().validate()
    }
}

/// Validate a requested or allowed capability list.
pub fn validate_capabilities(capabilities: &[Capability]) -> Result<()> {
    if capabilities.is_empty() {
        bail!("at least one capability is required");
    }
    if let Some(bad) = capabilities.iter().find(|c| !REQUESTABLE.contains(c)) {
        bail!("the `{}` capability cannot be requested", bad.as_str());
    }
    Ok(())
}

/// Request status. `Granted` and `Pending` become `Expired` once their time
/// runs out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessRequestStatus {
    Pending,
    Granted,
    Denied,
    Cancelled,
    Revoked,
    Expired,
}

impl AccessRequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Cancelled => "cancelled",
            Self::Revoked => "revoked",
            Self::Expired => "expired",
        }
    }
}

/// A stored access request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub id: String,
    /// `user:<id>` of the requester.
    pub requester: String,
    pub environment: String,
    pub path: String,
    pub capabilities: Vec<Capability>,
    pub duration_secs: i64,
    #[serde(default)]
    pub reason: String,
    /// Access policies whose chains this request follows.
    pub policies: Vec<String>,
    /// The ordered approval chain (`policy/step` names).
    pub steps: Vec<ControlGroupFactor>,
    pub approvals: Vec<ControlGroupApproval>,
    pub status: AccessRequestStatus,
    /// The step waiting for approvals (pending requests only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_step: Option<String>,
    pub created_at: i64,
    /// When a pending request lapses.
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_expires_at: Option<i64>,
}

impl AccessRequest {
    /// Distinct approvers recorded for `step`.
    fn approvers_of(&self, step: &str) -> usize {
        let mut seen: Vec<&str> = Vec::new();
        for approval in self.approvals.iter().filter(|a| a.factor == step) {
            if !seen.contains(&approval.approver.as_str()) {
                seen.push(&approval.approver);
            }
        }
        seen.len()
    }

    /// The first step still short of its approvals.
    pub fn open_step(&self) -> Option<&ControlGroupFactor> {
        self.steps
            .iter()
            .find(|step| self.approvers_of(&step.name) < usize::from(step.approvals))
    }

    /// Whether any of `subjects` approves some step.
    pub fn is_approver(&self, subjects: &[String]) -> bool {
        self.steps
            .iter()
            .any(|step| step.approvers.iter().any(|a| subjects.contains(a)))
    }

    /// Fill derived fields: lapsed status and the open step.
    fn refresh(&mut self, now: i64) {
        match self.status {
            AccessRequestStatus::Pending if self.expires_at <= now => {
                self.status = AccessRequestStatus::Expired;
            }
            AccessRequestStatus::Granted if self.grant_expires_at.is_some_and(|at| at <= now) => {
                self.status = AccessRequestStatus::Expired;
            }
            _ => {}
        }
        self.current_step = (self.status == AccessRequestStatus::Pending)
            .then(|| self.open_step().map(|step| step.name.clone()))
            .flatten();
    }
}

/// The chain a request under `path` follows today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub policies: Vec<String>,
    pub steps: Vec<ControlGroupFactor>,
    pub max_duration_secs: i64,
    pub request_ttl_secs: i64,
}

/// Work out the approval chain for a request, or why it cannot be made.
pub fn plan(
    policies: &[AccessPolicy],
    path: &str,
    capabilities: &[Capability],
    duration_secs: i64,
) -> Result<Plan> {
    // Defence in depth behind `validate_glob`: system keys gate capabilities
    // (brokering, static roles, transit) no access request may hand out.
    if path.split('/').next() == Some(super::SYS_PREFIX) {
        return Err(VaultError::Denied(format!(
            "`{path}` is a system path; access requests reach environments only"
        ))
        .into());
    }
    let mut applicable: Vec<&AccessPolicy> = policies
        .iter()
        .filter(|policy| may_overlap(&policy.path, path))
        .collect();
    applicable.sort_by(|a, b| a.name.cmp(&b.name));
    if !applicable.iter().any(|policy| covers(&policy.path, path)) {
        return Err(VaultError::Denied(format!(
            "no access policy covers `{path}`; ask an administrator to add one"
        ))
        .into());
    }
    let mut plan = Plan {
        policies: Vec::new(),
        steps: Vec::new(),
        max_duration_secs: MAX_DURATION_SECS,
        request_ttl_secs: super::policy_ext::MAX_CONTROL_GROUP_TTL_SECS,
    };
    for policy in applicable {
        if let Some(missing) = capabilities
            .iter()
            .find(|capability| !policy.capabilities.contains(capability))
        {
            return Err(VaultError::Denied(format!(
                "access policy `{}` does not allow requesting `{}` here",
                policy.name,
                missing.as_str()
            ))
            .into());
        }
        plan.policies.push(policy.name.clone());
        plan.max_duration_secs = plan.max_duration_secs.min(policy.max_duration_secs);
        plan.request_ttl_secs = plan.request_ttl_secs.min(
            policy
                .request_ttl_secs
                .unwrap_or(super::policy_ext::DEFAULT_CONTROL_GROUP_TTL_SECS),
        );
        for step in &policy.steps {
            plan.steps.push(ControlGroupFactor {
                name: format!("{}/{}", policy.name, step.name),
                ..step.clone()
            });
        }
    }
    if plan.steps.len() > MAX_CHAIN_STEPS {
        return Err(VaultError::Denied(format!(
            "`{path}` needs more than {MAX_CHAIN_STEPS} approval steps; request a narrower path"
        ))
        .into());
    }
    if duration_secs > plan.max_duration_secs {
        return Err(VaultError::Invalid(format!(
            "durationSecs may be at most {} here",
            plan.max_duration_secs
        ))
        .into());
    }
    Ok(plan)
}

/// Whether `read` on `path` could reach a value some control group gates.
pub fn read_may_be_gated(policies: &[Policy], path: &str) -> bool {
    policies.iter().any(|policy| {
        policy.rules.iter().any(|rule| {
            !rule.deny
                && rule.control_group.is_some()
                && rule.capabilities.contains(&Capability::Read)
                && may_overlap(&rule.path, path)
        })
    })
}

// ── Access policy storage ──────────────────────────────────────────────────

/// Insert or replace an access policy.
pub fn put_policy(conn: &Connection, policy: &AccessPolicy) -> Result<()> {
    policy
        .validate()
        .map_err(|error| VaultError::Invalid(format!("{error:#}")))?;
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM vault_access_policies WHERE name = ?1",
            params![policy.name],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() && list_policies(conn)?.len() >= MAX_ACCESS_POLICIES {
        return Err(
            VaultError::Conflict(format!("at most {MAX_ACCESS_POLICIES} access policies")).into(),
        );
    }
    let now = now_millis();
    conn.execute(
        "INSERT INTO vault_access_policies (name, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
        params![policy.name, serde_json::to_string(policy)?, now],
    )?;
    Ok(())
}

/// Delete an access policy. Pending requests that followed it stop being
/// approvable (their chain no longer matches).
pub fn delete_policy(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM vault_access_policies WHERE name = ?1",
        params![name],
    )? > 0)
}

/// Every access policy, by name.
pub fn list_policies(conn: &Connection) -> Result<Vec<AccessPolicy>> {
    let mut stmt = conn.prepare("SELECT body FROM vault_access_policies ORDER BY name")?;
    let bodies: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    bodies
        .iter()
        .map(|body| Ok(serde_json::from_str(body)?))
        .collect()
}

#[cfg(test)]
mod tests;
