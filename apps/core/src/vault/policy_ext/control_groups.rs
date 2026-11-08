//! Control-group specs, approvals, and request types.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::policy::{glob_matches, is_valid_subject, Capability, Policy};
use super::*;

// ── Control groups ────────────────────────────────────────────────────────

/// One approval factor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupFactor {
    pub name: String,
    /// Subjects (`user:`, `team:`, `role:`, `machine:`) allowed to approve.
    pub approvers: Vec<String>,
    /// Distinct approvals required.
    #[serde(default = "one")]
    pub approvals: u8,
}

pub(super) fn one() -> u8 {
    1
}

/// A control group attached to a rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_secs: Option<i64>,
    pub factors: Vec<ControlGroupFactor>,
}

impl ControlGroupSpec {
    pub fn validate(&self) -> Result<()> {
        if let Some(ttl) = self.ttl_secs {
            if !(MIN_CONTROL_GROUP_TTL_SECS..=MAX_CONTROL_GROUP_TTL_SECS).contains(&ttl) {
                bail!(
                    "controlGroup.ttlSecs must be between {MIN_CONTROL_GROUP_TTL_SECS} and {MAX_CONTROL_GROUP_TTL_SECS}"
                );
            }
        }
        if self.factors.is_empty() || self.factors.len() > MAX_CONTROL_GROUP_FACTORS {
            bail!("a control group needs between 1 and {MAX_CONTROL_GROUP_FACTORS} factors");
        }
        let mut names = BTreeSet::new();
        for factor in &self.factors {
            if !super::super::policy::is_valid_policy_name(&factor.name)
                || !names.insert(&factor.name)
            {
                bail!("control-group factor names must be unique [a-z0-9_-]{{1,64}}");
            }
            if factor.approvers.is_empty() || factor.approvers.len() > MAX_FACTOR_APPROVERS {
                bail!(
                    "factor `{}` needs between 1 and {MAX_FACTOR_APPROVERS} approvers",
                    factor.name
                );
            }
            if let Some(bad) = factor.approvers.iter().find(|s| !is_valid_subject(s)) {
                bail!(
                    "factor `{}` approver `{bad}` is not a valid subject",
                    factor.name
                );
            }
            if factor.approvals == 0 || factor.approvals > 5 {
                bail!("factor `{}` approvals must be between 1 and 5", factor.name);
            }
        }
        Ok(())
    }

    pub(super) fn ttl(&self) -> i64 {
        self.ttl_secs.unwrap_or(DEFAULT_CONTROL_GROUP_TTL_SECS)
    }
}

/// The merged control group gating `capability` on `path`, if any. Factors are
/// namespaced `policy/factor`; the shortest TTL wins.
pub fn control_group_for<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
) -> Option<ControlGroupSpec> {
    let mut merged: Option<ControlGroupSpec> = None;
    for policy in policies {
        for (rule_index, rule) in policy.rules.iter().enumerate() {
            let Some(group) = &rule.control_group else {
                continue;
            };
            if rule.deny
                || !rule.capabilities.contains(&capability)
                || !rule_matches(rule, path, context)
            {
                continue;
            }
            let target = merged.get_or_insert_with(|| ControlGroupSpec {
                ttl_secs: Some(group.ttl()),
                factors: Vec::new(),
            });
            target.ttl_secs = Some(target.ttl().min(group.ttl()));
            // Namespace by rule too: factor names are unique only within one
            // rule, so two matching rules of one policy that reuse a name are
            // both enforced (ANDed). Only the same rule of the same policy
            // reached twice (e.g. via a user and a team binding) collapses.
            for factor in &group.factors {
                let name = format!("{}/{}/{}", policy.name, rule_index, factor.name);
                if target.factors.iter().any(|existing| existing.name == name) {
                    continue;
                }
                target.factors.push(ControlGroupFactor {
                    name,
                    ..factor.clone()
                });
            }
        }
    }
    merged
}

/// Whether a control group gates `read` on `path` for any caller: some allow
/// rule granting `read` with a `controlGroup` matches it, with a templated
/// path widened to `*`. Unattended paths that act for no single caller (an
/// external push) leave such values out rather than release them.
pub fn read_gated_for_anyone<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
) -> bool {
    let context = TemplateContext::default();
    policies.into_iter().any(|policy| {
        policy.rules.iter().any(|rule| {
            !rule.deny
                && rule.control_group.is_some()
                && rule.capabilities.contains(&Capability::Read)
                && match expand(&rule.path, &context) {
                    Expansion::Concrete(globs) => globs.iter().any(|glob| glob_matches(glob, path)),
                    Expansion::Unresolved(widened) => glob_matches(&widened, path),
                }
        })
    })
}

/// One recorded approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupApproval {
    pub factor: String,
    pub approver: String,
    pub approved_at: i64,
}

/// Request status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlGroupStatus {
    Pending,
    Approved,
    Redeemed,
    Expired,
}

impl ControlGroupStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Redeemed => "redeemed",
            Self::Expired => "expired",
        }
    }

    pub(super) fn parse(text: &str) -> Self {
        match text {
            "approved" => Self::Approved,
            "redeemed" => Self::Redeemed,
            "expired" => Self::Expired,
            _ => Self::Pending,
        }
    }
}

/// A stored control-group request (never carries the token).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupRequest {
    pub id: String,
    /// Subject of the requester (`user:<id>`).
    pub requester: String,
    /// The `ENV/folder/NAME` policy key being read.
    pub policy_key: String,
    /// What the redeemed token releases (handler-defined JSON).
    pub target: Value,
    pub factors: Vec<ControlGroupFactor>,
    pub approvals: Vec<ControlGroupApproval>,
    pub status: ControlGroupStatus,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redeemed_at: Option<i64>,
}

impl ControlGroupRequest {
    /// Whether every factor has its required distinct approvals.
    pub fn satisfied(&self) -> bool {
        self.factors.iter().all(|factor| {
            let approvers: BTreeSet<&str> = self
                .approvals
                .iter()
                .filter(|approval| approval.factor == factor.name)
                .map(|approval| approval.approver.as_str())
                .collect();
            approvers.len() >= usize::from(factor.approvals)
        })
    }

    /// Whether this request still matches `current`, the control group that
    /// gates its key now: the same factors (names, approver sets, counts),
    /// ignoring order. Approvals gathered under a since-changed group (a
    /// narrowed approver list, a raised count, an added factor) must not
    /// release the value; the requester opens a new request instead.
    pub fn matches_spec(&self, current: &ControlGroupSpec) -> bool {
        fn normalized(factors: &[ControlGroupFactor]) -> BTreeMap<&str, (BTreeSet<&str>, u8)> {
            factors
                .iter()
                .map(|factor| {
                    let approvers = factor.approvers.iter().map(String::as_str).collect();
                    (factor.name.as_str(), (approvers, factor.approvals))
                })
                .collect()
        }
        self.factors.len() == current.factors.len()
            && normalized(&self.factors) == normalized(&current.factors)
    }

    /// Whether any of `subjects` may approve some factor.
    pub fn is_approver(&self, subjects: &[String]) -> bool {
        self.factors
            .iter()
            .any(|factor| factor.approvers.iter().any(|a| subjects.contains(a)))
    }
}
