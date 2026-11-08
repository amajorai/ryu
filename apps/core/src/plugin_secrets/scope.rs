//! Vault value scopes, consumer bindings, listing metadata, and the
//! server-derived resolution context. Split from `plugin_secrets/mod.rs`,
//! which re-exports every public item here.

use anyhow::{bail, Result};
use ryu_channel_contracts::credential_scope::{CredentialLevel, LADDER};
use serde::{Deserialize, Serialize};

use super::kv;

/// Whether `key` is a legal secret name: a C-identifier-shaped token, exactly the
/// alphabet a POSIX environment variable may use (`[A-Za-z_][A-Za-z0-9_]*`).
///
/// Delegates to the kernel contract's [`ryu_kernel_contracts::is_env_var_name`] so
/// the REST write path and the manifest validator cannot disagree: a `secret`
/// field the loader accepted must be a key this store will take, or the author
/// ships a field that only fails once a user presses Save.
///
/// The `env:` fallback looks this name up verbatim, so anything that could not be
/// an env var could never be read back — storing it would be a silent no-op the
/// user reads as "saved". The same rule keeps the value safe as a URL path segment
/// (no `/`, no `..`, no `%`).
pub fn is_valid_secret_key(key: &str) -> bool {
    ryu_kernel_contracts::is_env_var_name(key)
}

/// Maximum length of a user-managed vault name. Names intentionally share the
/// environment-variable grammar so the same reference can be used by MCP
/// headers and stdio environments without a second escaping rule.
pub const MAX_VAULT_SECRET_NAME_LEN: usize = 128;

/// Maximum plaintext value accepted by the user-managed vault. This bounds the
/// amount of secret material Core holds in memory during one write and prevents
/// an accidental paste from becoming an unbounded request body.
pub const MAX_VAULT_SECRET_VALUE_LEN: usize = 64 * 1024;

/// Maximum length of an opaque scope or MCP id stored alongside a secret.
pub const MAX_VAULT_SCOPE_ID_LEN: usize = 256;

/// Ownership scope for a user-managed vault value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretScope {
    /// Only the verified user who owns the value may resolve it.
    User,
    /// Every governed execution on one exact node may resolve it.
    Node,
    /// One control-plane project's values, reaching whoever the project's
    /// team (or, for a project with no team, its organization) reaches. They
    /// live only in the control plane: Core resolves them at run time through
    /// [`crate::vault::shared`] and never stores, writes or accepts one in a
    /// request, so this variant is never deserialized.
    #[serde(skip_deserializing)]
    Project,
    /// Members of one verified team may resolve it.
    Team,
    /// Members of one verified organization may resolve it.
    Org,
}

impl SecretScope {
    /// Stable wire/storage spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Node => "node",
            Self::Project => "project",
            Self::Team => "team",
            Self::Org => "org",
        }
    }

    /// Parse a persisted or request value. Unknown values fail closed rather
    /// than being guessed into a broader scope. `project` is not parsed: Core
    /// never persists a project value or takes one in a request.
    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "user" => Some(Self::User),
            "node" => Some(Self::Node),
            "team" => Some(Self::Team),
            "org" | "organization" => Some(Self::Org),
            _ => None,
        }
    }

    /// The vault scope for a contract level. The match is exhaustive so a new
    /// contract level forces an explicit decision here.
    pub const fn from_credential_level(level: CredentialLevel) -> Option<Self> {
        match level {
            CredentialLevel::User => Some(Self::User),
            CredentialLevel::Node => Some(Self::Node),
            CredentialLevel::Project => Some(Self::Project),
            CredentialLevel::Team => Some(Self::Team),
            CredentialLevel::Org => Some(Self::Org),
        }
    }

    /// Vault resolution precedence, most specific first, derived from the
    /// contract [`LADDER`] restricted to the levels the vault stores.
    pub fn precedence() -> impl Iterator<Item = Self> {
        LADDER.into_iter().filter_map(Self::from_credential_level)
    }
}

/// Optional consumer binding for a vault value. An absent binding is usable by
/// any supported MCP consumer in the caller's scope; an MCP binding narrows the
/// value to one exact server/plugin identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretBinding {
    /// The only runtime consumer kind currently supported.
    pub kind: SecretBindingKind,
    /// Stable MCP server or owning plugin id, never a display label.
    pub id: String,
}

/// Supported consumer binding kinds. Skills remain instruction text and do not
/// receive secret values; a skill can use a tool whose MCP binding resolves one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretBindingKind {
    Mcp,
}

impl SecretBinding {
    /// Validate a binding before it is persisted or used in a lookup.
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() || !is_valid_scope_id(&self.id) {
            bail!("MCP binding id is empty or invalid");
        }
        Ok(())
    }

    pub(super) fn storage_parts(&self) -> (&'static str, &str) {
        match self.kind {
            SecretBindingKind::Mcp => ("mcp", self.id.as_str()),
        }
    }
}

/// Metadata returned by the vault listing. It deliberately contains no value,
/// nonce, ciphertext, or length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultSecretInfo {
    pub name: String,
    pub scope: SecretScope,
    pub scope_id: String,
    pub binding: Option<SecretBinding>,
    pub updated_at: i64,
    /// Environment slug (`default` for pre-environment values).
    pub environment: String,
    /// Normalized folder path (`/` for the root).
    pub path: String,
    /// Current version number (1-based).
    pub version: i64,
    pub metadata: kv::SecretMetadata,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    /// Epoch millis of the last value change (rotation clock).
    pub rotated_at: i64,
    /// Epoch millis of a soft delete; `None` while live.
    pub deleted_at: Option<i64>,
    /// Metadata check-and-set counter; bumped on every metadata change.
    pub metadata_version: i64,
}

/// Server-derived context used to resolve `secret:NAME`. The fields are built
/// from the current node and the owning chat conversation, never from the
/// model-authored arguments or the legacy client-supplied Composio selector.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecretResolutionContext {
    pub user_id: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    /// The control-plane project whose values this run may resolve, between
    /// the node and team levels. Server-derived for a chat run (the run's
    /// workspace folder mapped to an organization project, see
    /// [`crate::vault::run_project`]) or picked by a signed-in caller for an
    /// export. Only a hint: the control plane re-checks the project's
    /// organization, team, archive state and the user's membership.
    pub project_id: Option<String>,
    pub team_authority: Option<VerifiedTeamSecretScope>,
    pub node_id: String,
    /// Exact MCP/server/plugin aliases accepted for this dispatch. A value
    /// bound to any one of them is still narrower than an unbound value.
    pub mcp_ids: Vec<String>,
    /// Environment for unqualified references; `None` uses the node's active
    /// environment ([`crate::vault::active_environment`]).
    pub environment: Option<String>,
    /// Owning conversation, recorded on audit rows for correlation only.
    pub conversation_id: Option<String>,
    /// The verified owner's organization role names (`member`, `viewer`, …),
    /// so `role:<name>` policies apply at dispatch as they do in management.
    pub roles: Vec<String>,
    /// A bound node could not verify the owner's current principal (control
    /// plane unreachable, timeout, refusal, or no complete team list). Their
    /// role and team policy subjects are then unknown, so resolution fails
    /// closed instead of evaluating policies without the `role:`/`team:`
    /// denies that bind them.
    pub principal_unverified: bool,
    /// Policy subjects a human broker session recorded when it was minted
    /// (`user:<id>`, `role:<name>`, `team:<id>`). Their `role:`/`team:`
    /// entries apply only when the recorded `user:` subject is this
    /// context's user, the same subjects card substitution evaluates.
    pub minted_subjects: Vec<String>,
}

/// Team credential authority built only from a verified, current membership.
/// Sharing metadata alone cannot construct this witness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedTeamSecretScope {
    user_id: String,
    org_id: String,
    /// Teams whose Team-scope values this context may resolve. On a team node
    /// the control plane narrows these to the node's own team.
    team_ids: Vec<String>,
    /// Every team the owner holds in the org, for `team:<id>` policy
    /// subjects. Never narrowed: a deny bound to any of them applies.
    policy_team_ids: Vec<String>,
}

impl VerifiedTeamSecretScope {
    pub fn from_verified_caller(caller: &crate::identity_verify::VerifiedCaller) -> Option<Self> {
        let org_id = caller.org_id.as_ref()?;
        let team_ids: Vec<String> = caller
            .teams
            .iter()
            .filter(|team| &team.org_id == org_id)
            .map(|team| team.id.clone())
            .collect();
        Some(Self {
            user_id: caller.user_id.clone(),
            org_id: org_id.clone(),
            policy_team_ids: team_ids.clone(),
            team_ids,
        })
    }

    /// Replace the policy teams with the owner's complete team list in the
    /// org, as the control plane reports it alongside a narrowed principal.
    /// Candidate Team scopes stay limited to the verified `team_ids`.
    #[must_use]
    pub fn with_policy_team_ids(mut self, policy_team_ids: Vec<String>) -> Self {
        let mut ids = policy_team_ids;
        ids.extend(self.team_ids.iter().cloned());
        ids.retain(|id| is_valid_scope_id(id));
        ids.sort();
        ids.dedup();
        self.policy_team_ids = ids;
        self
    }

    pub(super) fn allows(&self, context: &SecretResolutionContext, team_id: &str) -> bool {
        context.user_id.as_deref() == Some(self.user_id.as_str())
            && context.org_id.as_deref() == Some(self.org_id.as_str())
            && self.team_ids.iter().any(|id| id == team_id)
    }

    /// Every verified team of the context's owner, as policy subjects. Like
    /// management's caller subjects, this is independent of the single team
    /// the conversation or node requests as a candidate scope, so a
    /// `team:<id>`-bound deny applies to every member at dispatch.
    pub(super) fn policy_team_ids(&self, context: &SecretResolutionContext) -> &[String] {
        if context.user_id.as_deref() == Some(self.user_id.as_str())
            && context.org_id.as_deref() == Some(self.org_id.as_str())
        {
            &self.policy_team_ids
        } else {
            &[]
        }
    }
}
impl SecretResolutionContext {
    /// Apply the owner's current principal to a bound node's dispatch
    /// context: `Some((caller, policy_team_ids))` when the control plane
    /// verified the owner and reported every team they hold in the org,
    /// `None` when the lookup failed or the team list is incomplete. A
    /// missing principal or team list leaves the owner's `role:`/`team:`
    /// policy subjects unknown, so the context fails closed
    /// ([`Self::principal_unverified`]).
    pub fn apply_owner_principal(
        &mut self,
        principal: Option<(&crate::identity_verify::VerifiedCaller, Option<Vec<String>>)>,
    ) {
        let verified = principal.and_then(|(caller, policy_team_ids)| {
            let authority = VerifiedTeamSecretScope::from_verified_caller(caller)?
                .with_policy_team_ids(policy_team_ids?);
            Some((authority, caller.role.label().to_owned()))
        });
        match verified {
            Some((authority, role)) => {
                self.team_authority = Some(authority);
                self.roles = vec![role];
                self.principal_unverified = false;
            }
            None => {
                self.team_authority = None;
                self.roles = Vec::new();
                self.principal_unverified = true;
            }
        }
    }

    /// Build a node-only context for a caller that has no user principal.
    pub fn node_only(node_id: impl Into<String>, mcp_ids: Vec<String>) -> Self {
        Self {
            node_id: node_id.into(),
            mcp_ids,
            ..Self::default()
        }
    }
}

/// Whether a vault name follows the bounded env-compatible grammar.
pub fn is_valid_vault_secret_name(name: &str) -> bool {
    name.len() <= MAX_VAULT_SECRET_NAME_LEN && is_valid_secret_key(name)
}

/// Whether an opaque scope id or MCP binding id is safe bounded metadata.
pub fn is_valid_scope_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_VAULT_SCOPE_ID_LEN
        && trimmed
            .chars()
            .all(|ch| !ch.is_control() && !ch.is_whitespace())
}

/// One entry in the "which secrets are set" listing. Carries NO value — by
/// construction, not by omission at the call site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretKeyInfo {
    /// The variable name, e.g. `RYU_TAVILY_API_KEY`.
    pub key: String,
    /// Epoch millis of the last write.
    pub updated_at: i64,
}
