//! Core-local authorization primitives.
//!
//! Authentication answers which credential was presented. This module answers
//! what that credential may do and which identity/resource dimensions it is
//! bound to. The capability names intentionally match `packages/auth/src/scopes.ts`
//! so hosted OAuth/API keys and offline node grants share one vocabulary.

pub mod delegation;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

/// Current serialized local-capability schema.
pub const AUTHORIZATION_SCHEMA_VERSION: u16 = 1;

/// A valid Ryu capability. Enumerating complete pairs makes impossible
/// resource/action combinations (for example `gateway:exec`) unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    ChatRead,
    ChatWrite,
    AgentsRead,
    AgentsManage,
    WorkflowsRead,
    WorkflowsRun,
    WorkflowsManage,
    ToolsRead,
    ToolsExec,
    MemoryRead,
    MemoryWrite,
    GatewayRoute,
    FilesRead,
    FilesWrite,
}

impl Capability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChatRead => "chat:read",
            Self::ChatWrite => "chat:write",
            Self::AgentsRead => "agents:read",
            Self::AgentsManage => "agents:manage",
            Self::WorkflowsRead => "workflows:read",
            Self::WorkflowsRun => "workflows:run",
            Self::WorkflowsManage => "workflows:manage",
            Self::ToolsRead => "tools:read",
            Self::ToolsExec => "tools:exec",
            Self::MemoryRead => "memory:read",
            Self::MemoryWrite => "memory:write",
            Self::GatewayRoute => "gateway:route",
            Self::FilesRead => "files:read",
            Self::FilesWrite => "files:write",
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Capability {
    type Err = UnknownCapability;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "chat:read" => Ok(Self::ChatRead),
            "chat:write" => Ok(Self::ChatWrite),
            "agents:read" => Ok(Self::AgentsRead),
            "agents:manage" => Ok(Self::AgentsManage),
            "workflows:read" => Ok(Self::WorkflowsRead),
            "workflows:run" => Ok(Self::WorkflowsRun),
            "workflows:manage" => Ok(Self::WorkflowsManage),
            "tools:read" => Ok(Self::ToolsRead),
            "tools:exec" => Ok(Self::ToolsExec),
            "memory:read" => Ok(Self::MemoryRead),
            "memory:write" => Ok(Self::MemoryWrite),
            "gateway:route" => Ok(Self::GatewayRoute),
            "files:read" => Ok(Self::FilesRead),
            "files:write" => Ok(Self::FilesWrite),
            _ => Err(UnknownCapability(value.to_owned())),
        }
    }
}

impl Serialize for Capability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Capability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownCapability(String);

impl fmt::Display for UnknownCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unknown capability: {}", self.0)
    }
}

/// A deterministic, duplicate-free set of capabilities.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CapabilitySet(BTreeSet<Capability>);

impl CapabilitySet {
    pub fn new(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self(capabilities.into_iter().collect())
    }

    pub fn paired_read_only() -> Self {
        Self::new([
            Capability::ChatRead,
            Capability::AgentsRead,
            Capability::WorkflowsRead,
            Capability::ToolsRead,
            Capability::MemoryRead,
            Capability::FilesRead,
        ])
    }

    /// Existing unversioned paired credentials migrate to this deliberately
    /// narrow profile. In particular, it grants no execution, write, manage, or
    /// Gateway routing capability.
    pub fn restrictive_legacy_profile() -> Self {
        Self::paired_read_only()
    }

    pub fn contains(&self, capability: Capability) -> bool {
        self.0.contains(&capability)
    }

    pub fn contains_all(&self, required: &Self) -> bool {
        required.0.is_subset(&self.0)
    }

    pub fn is_subset_of(&self, ceiling: &Self) -> bool {
        self.0.is_subset(&ceiling.0)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = Capability> + '_ {
        self.0.iter().copied()
    }
}

/// Optional exact-match restrictions attached to a credential.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantConstraints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl GrantConstraints {
    /// Normalize boundary input before it enters a persisted grant. Empty
    /// values become absent and labels are bounded to avoid attacker-controlled
    /// unbounded state.
    pub fn normalized(mut self) -> Self {
        self.subject_id = normalize_constraint(self.subject_id);
        self.client_id = normalize_constraint(self.client_id);
        self.agent_id = normalize_constraint(self.agent_id);
        self.plugin_id = normalize_constraint(self.plugin_id);
        self.node_id = normalize_constraint(self.node_id);
        self.org_id = normalize_constraint(self.org_id);
        self.team_id = normalize_constraint(self.team_id);
        self.resource_id = normalize_constraint(self.resource_id);
        self.tool_name = normalize_constraint(self.tool_name);
        self
    }

    pub fn is_satisfied_by(&self, presented: &RequestBindings) -> bool {
        exact_or_unbound(&self.subject_id, &presented.subject_id)
            && exact_or_unbound(&self.client_id, &presented.client_id)
            && exact_or_unbound(&self.agent_id, &presented.agent_id)
            && exact_or_unbound(&self.plugin_id, &presented.plugin_id)
            && exact_or_unbound(&self.node_id, &presented.node_id)
            && exact_or_unbound(&self.org_id, &presented.org_id)
            && exact_or_unbound(&self.team_id, &presented.team_id)
            && exact_or_unbound(&self.resource_id, &presented.resource_id)
            && exact_or_unbound(&self.tool_name, &presented.tool_name)
    }
}

fn normalize_constraint(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(256).collect())
        }
    })
}

fn exact_or_unbound(required: &Option<String>, presented: &Option<String>) -> bool {
    required
        .as_ref()
        .is_none_or(|required| presented.as_ref() == Some(required))
}

/// Identity/resource dimensions established independently for this request.
/// A constrained grant fails closed when a required dimension is absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestBindings {
    pub subject_id: Option<String>,
    pub client_id: Option<String>,
    pub agent_id: Option<String>,
    pub plugin_id: Option<String>,
    pub node_id: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub resource_id: Option<String>,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialKind {
    None,
    OwnerRecoveryToken,
    PairedCapability {
        grant_id: String,
    },
    /// A Better Auth user JWT accepted by an org-bound managed node. The JWT is
    /// verified against the control-plane JWKS and its role is lowered into the
    /// Core capability vocabulary before route authorization.
    ManagedUserJwt,
    HostedOAuth,
    ManagedDelegation,
    PluginHostGrant,
    NodeWorkload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    Anonymous,
    Owner,
    PairedClient {
        client_id: String,
        subject_id: Option<String>,
    },
    User {
        subject_id: String,
    },
    Plugin {
        plugin_id: String,
    },
    Agent {
        agent_id: String,
    },
    Node {
        node_id: String,
    },
}

/// The fully resolved authorization facts passed to a route policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationContext {
    pub credential: CredentialKind,
    pub principal: Principal,
    pub capabilities: CapabilitySet,
    pub constraints: GrantConstraints,
    pub issued_at: u64,
    pub expires_at: Option<u64>,
}

impl AuthorizationContext {
    pub fn anonymous() -> Self {
        Self {
            credential: CredentialKind::None,
            principal: Principal::Anonymous,
            capabilities: CapabilitySet::default(),
            constraints: GrantConstraints::default(),
            issued_at: 0,
            expires_at: None,
        }
    }

    pub fn owner(issued_at: u64) -> Self {
        Self {
            credential: CredentialKind::OwnerRecoveryToken,
            principal: Principal::Owner,
            capabilities: CapabilitySet::default(),
            constraints: GrantConstraints::default(),
            issued_at,
            expires_at: None,
        }
    }

    pub fn is_owner(&self) -> bool {
        matches!(&self.principal, Principal::Owner)
            && matches!(&self.credential, CredentialKind::OwnerRecoveryToken)
    }

    pub fn is_active_at(&self, now: u64) -> bool {
        self.expires_at.is_none_or(|expires_at| now < expires_at)
    }

    pub fn authorize(
        &self,
        policy: &RoutePolicy,
        bindings: &RequestBindings,
        now: u64,
    ) -> AuthorizationDecision {
        if matches!(policy, RoutePolicy::Public) {
            return AuthorizationDecision::Allow;
        }
        if matches!(&self.principal, Principal::Anonymous) {
            return AuthorizationDecision::Deny(DenialReason::AuthenticationRequired);
        }
        if !self.is_active_at(now) {
            return AuthorizationDecision::Deny(DenialReason::Expired);
        }
        if !self.constraints.is_satisfied_by(bindings) {
            return AuthorizationDecision::Deny(DenialReason::ConstraintMismatch);
        }
        if self.is_owner() {
            return AuthorizationDecision::Allow;
        }

        match policy {
            RoutePolicy::Public | RoutePolicy::Authenticated => AuthorizationDecision::Allow,
            RoutePolicy::OwnerOnly => AuthorizationDecision::Deny(DenialReason::OwnerRequired),
            RoutePolicy::Requires(required) => {
                if self.capabilities.contains_all(required) {
                    AuthorizationDecision::Allow
                } else {
                    AuthorizationDecision::Deny(DenialReason::MissingCapability)
                }
            }
        }
    }
}

/// Every non-public route must choose a positive requirement. Unknown routes
/// receive `OwnerOnly` through `Default`, never an implicit broad grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutePolicy {
    Public,
    Authenticated,
    Requires(CapabilitySet),
    OwnerOnly,
}

impl Default for RoutePolicy {
    fn default() -> Self {
        Self::OwnerOnly
    }
}

impl RoutePolicy {
    pub fn requires(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self::Requires(CapabilitySet::new(capabilities))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationDecision {
    Allow,
    Deny(DenialReason),
}

impl AuthorizationDecision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allow)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenialReason {
    AuthenticationRequired,
    Expired,
    ConstraintMismatch,
    MissingCapability,
    OwnerRequired,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired_context(scopes: CapabilitySet) -> AuthorizationContext {
        AuthorizationContext {
            credential: CredentialKind::PairedCapability {
                grant_id: "pc_test".to_owned(),
            },
            principal: Principal::PairedClient {
                client_id: "client_test".to_owned(),
                subject_id: None,
            },
            capabilities: scopes,
            constraints: GrantConstraints::default(),
            issued_at: 10,
            expires_at: None,
        }
    }

    #[test]
    fn tools_read_cannot_execute_tools() {
        let context = paired_context(CapabilitySet::new([Capability::ToolsRead]));
        assert!(context
            .authorize(
                &RoutePolicy::requires([Capability::ToolsRead]),
                &RequestBindings::default(),
                20,
            )
            .is_allowed());
        assert_eq!(
            context.authorize(
                &RoutePolicy::requires([Capability::ToolsExec]),
                &RequestBindings::default(),
                20,
            ),
            AuthorizationDecision::Deny(DenialReason::MissingCapability)
        );
    }

    #[test]
    fn unknown_route_policy_falls_back_to_owner_only() {
        let paired = paired_context(CapabilitySet::paired_read_only());
        let owner = AuthorizationContext::owner(10);
        let policy = RoutePolicy::default();

        assert_eq!(
            paired.authorize(&policy, &RequestBindings::default(), 20),
            AuthorizationDecision::Deny(DenialReason::OwnerRequired)
        );
        assert!(owner
            .authorize(&policy, &RequestBindings::default(), 20)
            .is_allowed());
    }

    #[test]
    fn missing_or_wrong_subject_fails_a_subject_bound_grant() {
        let mut context = paired_context(CapabilitySet::new([Capability::ChatRead]));
        context.constraints.subject_id = Some("user_expected".to_owned());
        let policy = RoutePolicy::requires([Capability::ChatRead]);

        assert_eq!(
            context.authorize(&policy, &RequestBindings::default(), 20),
            AuthorizationDecision::Deny(DenialReason::ConstraintMismatch)
        );
        assert_eq!(
            context.authorize(
                &policy,
                &RequestBindings {
                    subject_id: Some("user_other".to_owned()),
                    ..RequestBindings::default()
                },
                20,
            ),
            AuthorizationDecision::Deny(DenialReason::ConstraintMismatch)
        );
        assert!(context
            .authorize(
                &policy,
                &RequestBindings {
                    subject_id: Some("user_expected".to_owned()),
                    ..RequestBindings::default()
                },
                20,
            )
            .is_allowed());
    }

    #[test]
    fn tool_and_resource_constraints_are_both_exact_match() {
        let mut context = paired_context(CapabilitySet::new([Capability::ToolsExec]));
        context.constraints.tool_name = Some("filesystem.read".to_owned());
        context.constraints.resource_id = Some("space_docs".to_owned());
        let policy = RoutePolicy::requires([Capability::ToolsExec]);

        assert_eq!(
            context.authorize(
                &policy,
                &RequestBindings {
                    tool_name: Some("filesystem.read".to_owned()),
                    resource_id: Some("space_other".to_owned()),
                    ..RequestBindings::default()
                },
                20,
            ),
            AuthorizationDecision::Deny(DenialReason::ConstraintMismatch)
        );
        assert!(context
            .authorize(
                &policy,
                &RequestBindings {
                    tool_name: Some("filesystem.read".to_owned()),
                    resource_id: Some("space_docs".to_owned()),
                    ..RequestBindings::default()
                },
                20,
            )
            .is_allowed());
    }
}
