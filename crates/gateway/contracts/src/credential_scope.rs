//! Scoped-credential contract: which level supplies a provider key or a
//! connection for one request.
//!
//! Internal design: `docs/scoped-credentials-design.md`. This module is the
//! pure, serde-only core of that design. It decides *which credential
//! reference* wins; it never sees, stores or returns a secret value. Callers
//! fetch the value for the selected [`CredentialRef`] through their own sealed
//! custody path.
//!
//! Two axes are kept separate and never merged:
//!
//! 1. **Which value is used.** The most specific eligible level wins, in
//!    [`LADDER`] order `user > node > project > team > org`. There is no
//!    merging across levels. `managed` (Ryu's fleet vault and managed
//!    OpenRouter sub-keys) is not a level: it is the caller's fallback after
//!    [`Outcome::NotFound`], for inference only.
//! 2. **Which levels may supply a value.** An allowlist ([`SourcePolicy`])
//!    that can only narrow [`default_sources`], never widen it. The contract
//!    enforces this itself rather than trusting the PR #643 cascade, because
//!    that cascade's `narrowPolicyAllowlist` treats an empty inherited list
//!    as unrestricted and returns a lower layer's list unchanged. The only
//!    way to admit `user` on a shared node is the org-only
//!    [`SourcePolicy::org_admits_user`] opt-in.
//!
//! Policy gating (approved providers and models, allowed MCP servers, the
//! merged connector catalog) happens before both axes and is passed in as a
//! precomputed [`GateDecision`], so this crate never grows a third copy of
//! those glob matchers. A credential never widens policy.
//!
//! Every function here is pure: no clock, no IO, no randomness. Candidate
//! expiry is computed by the caller and passed as [`CandidateStatus`].
//!
//! The golden fixture `fixtures/credential-scope-v1.json` is the source of
//! truth shared with the TypeScript twin; any rule change lands as a fixture
//! case first.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Version of this contract and of `fixtures/credential-scope-v1.json`.
pub const CONTRACT_VERSION: u32 = 1;

/// Maximum length of one id component (provider id, toolkit, server id).
pub const MAX_ID_LEN: usize = 128;

/// One level of the credential ladder. Wire names are lowercase.
///
/// `org`, `team`, `project` and `user` are PR #643's `POLICY_LEVELS`
/// (`packages/db/src/models/control-plane.model.ts`, see
/// [`POLICY_LEVEL_NAMES`]). `node` exists only on the credential ladder.
///
/// Deserialization and [`FromStr`] accept the same two aliases,
/// `organization` → `org` and `personal` → `user`. Each alias maps only to
/// the level it names, never to a broader one; every other spelling
/// (including other casings and surrounding whitespace) is rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialLevel {
    #[serde(alias = "personal")]
    User,
    Node,
    Project,
    Team,
    #[serde(alias = "organization")]
    Org,
}

/// Resolution order, most specific first.
///
/// It keeps the shipped Core vault order `user > node > team > org`
/// (`apps/core/src/plugin_secrets/kv.rs:1475-1515`, `candidate_scopes`) as a
/// subsequence, so `secret:` behavior does not change when Core adopts it.
/// Node sits above the shared levels so joining an org never silently replaces
/// a node's own key, and a node with no scoped values resolves exactly as it
/// does today.
pub const LADDER: [CredentialLevel; 5] = [
    CredentialLevel::User,
    CredentialLevel::Node,
    CredentialLevel::Project,
    CredentialLevel::Team,
    CredentialLevel::Org,
];

/// PR #643's `POLICY_LEVELS`, in that array's order
/// (`packages/db/src/models/control-plane.model.ts`, `POLICY_LEVELS`).
///
/// `node` is deliberately absent: it is a credential-ladder level only and is
/// never added to `POLICY_LEVELS`, `FLEET_SCOPE_LEVELS` or `GRANT_SCOPES`.
pub const POLICY_LEVEL_NAMES: [&str; 4] = ["org", "team", "project", "user"];

/// Error for a level string that is not a canonical name or a known alias.
///
/// It does not echo the rejected input, so untrusted strings never flow into
/// logs through this error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseLevelError;

impl fmt::Display for ParseLevelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("unknown credential level")
    }
}

impl std::error::Error for ParseLevelError {}

impl CredentialLevel {
    /// Canonical lowercase wire name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Node => "node",
            Self::Project => "project",
            Self::Team => "team",
            Self::Org => "org",
        }
    }

    /// Specificity rank: a higher rank is more specific and wins. This follows
    /// the PR #643 convention ("more-specific levels win; higher rank = more
    /// specific"). [`LADDER`] is sorted by descending rank.
    pub const fn rank(self) -> u8 {
        match self {
            Self::User => 4,
            Self::Node => 3,
            Self::Project => 2,
            Self::Team => 1,
            Self::Org => 0,
        }
    }
}

impl fmt::Display for CredentialLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for CredentialLevel {
    type Err = ParseLevelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" | "personal" => Ok(Self::User),
            "node" => Ok(Self::Node),
            "project" => Ok(Self::Project),
            "team" => Ok(Self::Team),
            "org" | "organization" => Ok(Self::Org),
            _ => Err(ParseLevelError),
        }
    }
}

/// What a credential is for. Consumers assert the purpose they expect, so a
/// Composio platform key can never reach the inference path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialPurpose {
    /// `provider:<id>`: an inference provider key.
    Inference,
    /// `platform:composio` or `platform:treg`: a platform API key.
    ConnectionPlatform,
    /// `connection:composio:<toolkit>` or `connection:mcp:<serverId>`.
    ConnectionAccount,
    /// `tool:<vendor>`: a third-party tool vendor's API key (Exa, Tavily,
    /// Brave, GitHub, ...), used by Connect's vendor lane and the tool
    /// credential ladder (`crate::tool_credential_ladder`).
    ToolVendor,
}

/// Error for a slot id outside the grammar. Like [`ParseLevelError`] it
/// carries a fixed reason, never the rejected input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseSlotError {
    pub reason: &'static str,
}

impl fmt::Display for ParseSlotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid credential slot: {}", self.reason)
    }
}

impl std::error::Error for ParseSlotError {}

const fn slot_error(reason: &'static str) -> ParseSlotError {
    ParseSlotError { reason }
}

/// The thing a credential unlocks, with a canonical string form
/// ([`CredentialSlot::slot_id`]). The grammar is closed:
///
/// | slot id                          | purpose              | provider     | key             |
/// |----------------------------------|----------------------|--------------|-----------------|
/// | `provider:<id>`                  | `Inference`          | `<id>`       | `None`          |
/// | `platform:composio`              | `ConnectionPlatform` | `composio`   | `None`          |
/// | `platform:treg`                  | `ConnectionPlatform` | `treg`       | `None`          |
/// | `connection:composio:<toolkit>`  | `ConnectionAccount`  | `composio`   | `Some(toolkit)` |
/// | `connection:mcp:<serverId>`      | `ConnectionAccount`  | `mcp`        | `Some(serverId)`|
/// | `tool:<vendor>`                  | `ToolVendor`         | `<vendor>`   | `None`          |
///
/// An id component is 1-128 visible ASCII characters (`!`..=`~`), so no
/// whitespace or control characters. Fail-closed choices beyond that:
///
/// - `*` is never allowed in an id, so an exact source-policy entry can never
///   be confused with a prefix pattern.
/// - Inference provider ids may contain `:` (for example `genai:vertex`), but
///   every `:`-separated segment must be non-empty.
/// - Toolkit and MCP server ids may not contain `:`.
/// - A tool vendor id is a price-contract provider id
///   (`crate::tool_price::is_valid_provider_id`: `[a-z0-9][a-z0-9-]*`, at most
///   64 characters), so one vendor has exactly one slot and it joins the
///   vendor's price and catalog rows.
///
/// It serializes as its slot id string, and deserialization runs
/// [`CredentialSlot::parse`], so an invalid slot never decodes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CredentialSlot {
    pub purpose: CredentialPurpose,
    pub provider: String,
    pub key: Option<String>,
}

fn is_id_byte(byte: u8) -> bool {
    byte.is_ascii_graphic() && byte != b'*'
}

fn valid_component(value: &str, allow_colon: bool) -> bool {
    if value.is_empty() || value.len() > MAX_ID_LEN || !value.bytes().all(is_id_byte) {
        return false;
    }
    if allow_colon {
        value.split(':').all(|segment| !segment.is_empty())
    } else {
        !value.contains(':')
    }
}

impl CredentialSlot {
    /// `provider:<id>`.
    pub fn inference(provider: impl Into<String>) -> Self {
        Self {
            purpose: CredentialPurpose::Inference,
            provider: provider.into(),
            key: None,
        }
    }

    /// `tool:<vendor>`. The vendor id is not checked here; [`Self::is_valid`]
    /// does.
    pub fn tool_vendor(vendor: impl Into<String>) -> Self {
        Self {
            purpose: CredentialPurpose::ToolVendor,
            provider: vendor.into(),
            key: None,
        }
    }

    /// Parse a canonical slot id. Anything outside the grammar is rejected.
    pub fn parse(value: &str) -> Result<Self, ParseSlotError> {
        if let Some(provider) = value.strip_prefix("provider:") {
            if !valid_component(provider, true) {
                return Err(slot_error("provider id must be 1-128 visible ASCII"));
            }
            return Ok(Self::inference(provider));
        }
        if let Some(platform) = value.strip_prefix("platform:") {
            return match platform {
                "composio" | "treg" => Ok(Self {
                    purpose: CredentialPurpose::ConnectionPlatform,
                    provider: platform.to_owned(),
                    key: None,
                }),
                _ => Err(slot_error("platform must be composio or treg")),
            };
        }
        if let Some(rest) = value.strip_prefix("connection:") {
            let (provider, key) = rest
                .split_once(':')
                .ok_or(slot_error("connection slot needs a provider and an id"))?;
            if provider != "composio" && provider != "mcp" {
                return Err(slot_error("connection provider must be composio or mcp"));
            }
            if !valid_component(key, false) {
                return Err(slot_error("connection id must be 1-128 visible ASCII"));
            }
            return Ok(Self {
                purpose: CredentialPurpose::ConnectionAccount,
                provider: provider.to_owned(),
                key: Some(key.to_owned()),
            });
        }
        if let Some(vendor) = value.strip_prefix("tool:") {
            if !crate::tool_price::is_valid_provider_id(vendor) {
                return Err(slot_error("tool vendor must be a provider id"));
            }
            return Ok(Self::tool_vendor(vendor));
        }
        Err(slot_error("unknown slot family"))
    }

    /// Canonical slot id. For a slot built by [`CredentialSlot::parse`] this
    /// round-trips exactly. A hand-built slot may render an id that does not
    /// parse; [`CredentialSlot::is_valid`] detects that.
    pub fn slot_id(&self) -> String {
        match (self.purpose, &self.key) {
            (CredentialPurpose::Inference, _) => format!("provider:{}", self.provider),
            (CredentialPurpose::ConnectionPlatform, _) => format!("platform:{}", self.provider),
            (CredentialPurpose::ConnectionAccount, Some(key)) => {
                format!("connection:{}:{key}", self.provider)
            }
            (CredentialPurpose::ConnectionAccount, None) => format!("connection:{}", self.provider),
            (CredentialPurpose::ToolVendor, _) => format!("tool:{}", self.provider),
        }
    }

    /// True when this slot is exactly what [`CredentialSlot::parse`] would
    /// build from its own [`CredentialSlot::slot_id`]. The fields are public,
    /// so [`resolve_credential`] checks this rather than trusting the caller.
    pub fn is_valid(&self) -> bool {
        Self::parse(&self.slot_id()).is_ok_and(|parsed| &parsed == self)
    }
}

impl TryFrom<String> for CredentialSlot {
    type Error = ParseSlotError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<CredentialSlot> for String {
    fn from(slot: CredentialSlot) -> Self {
        slot.slot_id()
    }
}

impl fmt::Display for CredentialSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.slot_id())
    }
}

/// How a scope id was established. Scope is derived server-side; request
/// claims never count as evidence for a value release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeEvidence {
    /// Bound to the authenticated credential itself (for example
    /// `credential.organizationId`, or a personal credential's owner).
    CredentialBound,
    /// Set by an admin mapping (`ManagedNode.mappedProjectIds` intersected
    /// with the projects allowed for the fleet node).
    AdminMapped,
    /// A live membership the control plane verified.
    VerifiedMembership,
    /// A user JWT the control plane verified itself, plus live org membership.
    VerifiedIdentity,
    /// Only asserted by the node or the request (for example `x-project-id`).
    /// It never unlocks a value: PR #643 accepts such selectors only because
    /// naming a project "can never widen" a tighten-only policy
    /// (PR `packages/api/src/lib/effective-policy.ts:33-35`). That argument
    /// holds for policy, not for releasing a credential.
    NodeAsserted,
}

/// An owner id at one level plus the evidence for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeRef {
    pub id: String,
    pub evidence: ScopeEvidence,
}

impl ScopeRef {
    pub fn new(id: impl Into<String>, evidence: ScopeEvidence) -> Self {
        Self {
            id: id.into(),
            evidence,
        }
    }
}

/// Where the node runs. On a hosted `fleet` node, node keys are Ryu's own and
/// count as `managed`, so the node level never selects there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Tenant,
    Fleet,
}

/// The caller's scope, one optional owner per level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialScope {
    pub org: Option<ScopeRef>,
    pub node: Option<ScopeRef>,
    pub user: Option<ScopeRef>,
    pub team: Option<ScopeRef>,
    pub project: Option<ScopeRef>,
    pub node_kind: NodeKind,
    /// The authenticated credential is personal (its owner is the user).
    /// Personal credentials never reach shared levels.
    pub personal: bool,
}

impl CredentialScope {
    /// The owner at `level`, if any. A [`ScopeRef`] whose id is outside the
    /// id grammar (1-128 visible ASCII) is treated as absent, mirroring the
    /// Core vault's `is_valid_scope_id` filter.
    pub fn owner(&self, level: CredentialLevel) -> Option<&ScopeRef> {
        let owner = match level {
            CredentialLevel::User => self.user.as_ref(),
            CredentialLevel::Node => self.node.as_ref(),
            CredentialLevel::Project => self.project.as_ref(),
            CredentialLevel::Team => self.team.as_ref(),
            CredentialLevel::Org => self.org.as_ref(),
        };
        owner.filter(|scope_ref| valid_owner_id(&scope_ref.id))
    }

    fn has(&self, level: CredentialLevel, evidence: ScopeEvidence) -> bool {
        self.owner(level)
            .is_some_and(|scope_ref| scope_ref.evidence == evidence)
    }
}

fn valid_owner_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// A redacted pointer to a stored credential. It never carries the value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRef {
    pub id: String,
    pub version: u64,
    /// A non-secret account fingerprint (a prefix of the provider account id),
    /// used for circuit and cache keys.
    pub fingerprint: String,
}

/// Lifecycle status, computed by the caller (keeps this contract clock-free).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateStatus {
    Active,
    Disabled,
    Expired,
    Revoked,
}

/// One stored credential that might serve the slot. It has no value field,
/// and `deny_unknown_fields` rejects a payload that tries to smuggle one in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialCandidate {
    pub level: CredentialLevel,
    pub owner_id: String,
    pub slot_id: String,
    pub credential_ref: CredentialRef,
    /// Higher wins, matching `ProviderAccountPolicy.priority`
    /// (`crates/gateway/credentials/src/lib.rs:23-31`).
    pub priority: u16,
    pub status: CandidateStatus,
}

/// The precomputed policy gate (approved providers and models, allowed MCP
/// servers, the merged org and team connector catalog).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GateDecision {
    Allowed,
    Denied { code: String },
}

/// Which levels may supply a value: the effective `allowedCredentialSources`
/// list plus the org-only member opt-in.
///
/// `allowed` is the list after the PR #643 cascade (`narrowPolicyAllowlist`,
/// PR `control-plane.model.ts:920`; frozen by `lockedFields` in
/// `resolvePolicy`, PR `:970`). That cascade is not tighten-only for this
/// field on its own: `narrowPolicyAllowlist([], narrower)` returns `narrower`
/// unchanged, and members author their own user layer. So a member or team
/// layer that writes `["user"]` under an org that left the field empty would
/// reach this contract as `["user"]`. The contract therefore never lets the
/// list add a level; it only narrows [`default_sources`]:
///
/// - An empty list means [`default_sources`].
/// - A non-empty list keeps only its entries whose level is in
///   [`default_sources`]. Entries for any other level are dropped, never
///   honoured. If nothing is left, no level may supply a value (it never
///   re-reads as the default, which would widen it).
/// - `user` is in [`default_sources`] only on a personal credential or when
///   [`SourcePolicy::org_admits_user`] is true. That flag must be computed
///   from the org policy layer alone (an org-only, lockable field that lower
///   layers can neither set nor clear), never through
///   `narrowPolicyAllowlist`.
///
/// So within the default, a non-empty list is the complete allowed set:
/// `["org"]` turns off `node`, `project` and `team` (and `user`).
///
/// Entry grammar:
///
/// - a bare level, `team`: the level may supply any slot;
/// - `level:<slotId>`, `user:provider:openai`: exactly that slot;
/// - `level:<prefix>*`, `user:provider:genai:*`: slots starting with
///   `<prefix>`. The prefix must start with `provider:`, `platform:`,
///   `connection:` or `tool:`, and `*` may appear only as the final character.
///
/// Levels accept the [`CredentialLevel`] aliases. Any other entry, including
/// surrounding whitespace or other casings, makes the whole policy invalid,
/// which [`resolve_credential`] turns into a denial.
///
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePolicy {
    #[serde(default)]
    pub allowed: Vec<String>,
    /// The org admin opted in to member keys (`user`) on shared nodes. Read
    /// from the org layer only; it defaults to `false` (deny by default,
    /// consistency standard §5). It has no effect on a personal credential,
    /// whose `user` is the node owner and is always in the default.
    #[serde(default)]
    pub org_admits_user: bool,
}

/// Which slots a parsed source entry admits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotMatch {
    Any,
    Exact(String),
    Prefix(String),
}

/// One parsed `allowedCredentialSources` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRule {
    pub level: CredentialLevel,
    pub slots: SlotMatch,
}

impl SourceRule {
    fn admits(&self, level: CredentialLevel, slot_id: &str) -> bool {
        self.level == level
            && match &self.slots {
                SlotMatch::Any => true,
                SlotMatch::Exact(exact) => exact == slot_id,
                SlotMatch::Prefix(prefix) => slot_id.starts_with(prefix.as_str()),
            }
    }
}

/// The first invalid entry in a [`SourcePolicy`]. It names the entry's index,
/// never its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourcePolicyError {
    pub index: usize,
    pub reason: &'static str,
}

impl fmt::Display for SourcePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid credential source entry {}: {}",
            self.index, self.reason
        )
    }
}

impl std::error::Error for SourcePolicyError {}

const PREFIX_FAMILIES: [&str; 4] = ["provider:", "platform:", "connection:", "tool:"];

fn parse_source_entry(entry: &str) -> Result<SourceRule, &'static str> {
    let (level_text, slot_text) = match entry.split_once(':') {
        Some((level_text, slot_text)) => (level_text, Some(slot_text)),
        None => (entry, None),
    };
    let level = level_text
        .parse::<CredentialLevel>()
        .map_err(|_| "unknown level")?;
    let Some(slot_text) = slot_text else {
        return Ok(SourceRule {
            level,
            slots: SlotMatch::Any,
        });
    };
    if let Some(prefix) = slot_text.strip_suffix('*') {
        let well_formed = !prefix.is_empty()
            && prefix.len() <= MAX_ID_LEN * 2
            && prefix.bytes().all(is_id_byte)
            && PREFIX_FAMILIES
                .iter()
                .any(|family| prefix.starts_with(family));
        if !well_formed {
            return Err("prefix must start with provider:, platform:, connection: or tool:");
        }
        return Ok(SourceRule {
            level,
            slots: SlotMatch::Prefix(prefix.to_owned()),
        });
    }
    let slot = CredentialSlot::parse(slot_text).map_err(|error| error.reason)?;
    Ok(SourceRule {
        level,
        slots: SlotMatch::Exact(slot.slot_id()),
    })
}

impl SourcePolicy {
    pub fn new<I, S>(allowed: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            allowed: allowed.into_iter().map(Into::into).collect(),
            org_admits_user: false,
        }
    }

    /// The same list with the org-only member opt-in set.
    #[must_use]
    pub fn with_org_admits_user(mut self, org_admits_user: bool) -> Self {
        self.org_admits_user = org_admits_user;
        self
    }

    /// The rules [`resolve_credential`] applies for `scope`: the parsed list
    /// narrowed to [`default_sources`], or the default itself when the list is
    /// empty. Every returned rule's level is in [`default_sources`].
    pub fn effective_rules(
        &self,
        scope: &CredentialScope,
    ) -> Result<Vec<SourceRule>, SourcePolicyError> {
        let parsed = self.parse_sources()?;
        let defaults = default_sources(scope, self.org_admits_user);
        if parsed.is_empty() {
            return Ok(defaults
                .into_iter()
                .map(|level| SourceRule {
                    level,
                    slots: SlotMatch::Any,
                })
                .collect());
        }
        Ok(parsed
            .into_iter()
            .filter(|rule| defaults.contains(&rule.level))
            .collect())
    }

    /// Parse every entry. One unknown entry fails the whole policy (fail
    /// closed: a typo never silently widens or narrows to something else).
    pub fn parse_sources(&self) -> Result<Vec<SourceRule>, SourcePolicyError> {
        self.allowed
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                parse_source_entry(entry).map_err(|reason| SourcePolicyError { index, reason })
            })
            .collect()
    }
}

/// Per-level explanation status. Wire names are snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceStatus {
    /// The scope has no (valid) owner at this level.
    NotInScope,
    /// An owner exists, but its evidence does not unlock a value
    /// ([`evidence_unlocks`]).
    EvidenceInsufficient,
    /// The source policy does not admit this level for this slot.
    SourceNotAllowed,
    /// Eligible, but no active candidate matches the owner and slot.
    Empty,
    /// This level supplied the credential.
    Selected,
    /// Eligible with an active matching candidate, but a more specific level
    /// was already selected. Added beyond the original plan so that every
    /// level gets a truthful entry on the full-ladder trace.
    Shadowed,
}

/// One trace line: a level and what happened there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceEntry {
    pub level: CredentialLevel,
    pub status: TraceStatus,
}

/// The result of one resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Selected {
        level: CredentialLevel,
        credential_ref: CredentialRef,
    },
    /// No tenant level supplied a value. The caller may fall back to
    /// `managed`, and only for [`CredentialPurpose::Inference`] when the org
    /// has managed inference enabled.
    NotFound,
    Denied {
        code: String,
    },
}

/// Outcome plus a redacted explanation for the UI and for audit.
///
/// The trace has one entry per [`LADDER`] level, in ladder order, unless the
/// outcome is a denial raised before the walk (gate, invalid slot, invalid
/// policy), in which case it is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolution {
    pub outcome: Outcome,
    pub trace: Vec<TraceEntry>,
}

/// Denial code for a policy with an unknown `allowedCredentialSources` entry.
pub const DENIED_INVALID_SOURCE_POLICY: &str = "invalid_source_policy";

/// Denial code for a hand-built [`CredentialSlot`] outside the grammar.
pub const DENIED_INVALID_SLOT: &str = "invalid_slot";

/// The most a source policy can admit, in [`LADDER`] order:
/// `[node, project, team, org]`, plus `user` (first) only on a personal
/// credential or when the org-only `org_admits_user` opt-in is set.
///
/// An empty `allowedCredentialSources` list means exactly this set, and a
/// non-empty list can only narrow it ([`SourcePolicy::effective_rules`]).
/// Member BYOK on a shared node therefore stays off until an org admin opts
/// in at the org layer, whatever lower layers write (deny by default,
/// consistency standard §5).
pub fn default_sources(scope: &CredentialScope, org_admits_user: bool) -> Vec<CredentialLevel> {
    LADDER
        .into_iter()
        .filter(|level| *level != CredentialLevel::User || scope.personal || org_admits_user)
        .collect()
}

/// Whether the scope's evidence unlocks a value at `level`. It is false when
/// the level has no valid owner.
///
/// - `user`: `VerifiedIdentity`, or `CredentialBound` on a personal credential.
/// - `node`: an owner on a `tenant` node. The node's own evidence is not
///   consulted: node candidates come only from the node's own custody and are
///   matched against its id, and this keeps a node with no scoped values
///   byte-identical to today. On a `fleet` node, node keys are `managed`.
/// - `project`: not personal, a `VerifiedIdentity` user, and an `AdminMapped`
///   project.
/// - `team`: not personal, a `VerifiedIdentity` user, and a
///   `VerifiedMembership` team.
/// - `org`: not personal, a `CredentialBound` org, and a `VerifiedIdentity`
///   user.
///
/// A shared value is never resolved without a server-verified user, as in the
/// Core vault (`kv.rs:1475-1515`). `NodeAsserted` never unlocks anything.
pub fn evidence_unlocks(level: CredentialLevel, scope: &CredentialScope) -> bool {
    let verified_user = scope.has(CredentialLevel::User, ScopeEvidence::VerifiedIdentity);
    let shared = !scope.personal && verified_user;
    match level {
        CredentialLevel::User => {
            verified_user
                || (scope.personal
                    && scope.has(CredentialLevel::User, ScopeEvidence::CredentialBound))
        }
        CredentialLevel::Node => {
            scope.owner(CredentialLevel::Node).is_some() && scope.node_kind == NodeKind::Tenant
        }
        CredentialLevel::Project => {
            shared && scope.has(CredentialLevel::Project, ScopeEvidence::AdminMapped)
        }
        CredentialLevel::Team => {
            shared && scope.has(CredentialLevel::Team, ScopeEvidence::VerifiedMembership)
        }
        CredentialLevel::Org => {
            shared && scope.has(CredentialLevel::Org, ScopeEvidence::CredentialBound)
        }
    }
}

/// Deterministic, input-order-independent best candidate: highest
/// `priority`, then the smallest `credential_ref.id` (byte order), then the
/// highest `version`, then the smallest `fingerprint`.
fn best_candidate<'a>(
    hits: impl Iterator<Item = &'a CredentialCandidate>,
) -> Option<&'a CredentialCandidate> {
    hits.min_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.credential_ref.id.cmp(&right.credential_ref.id))
            .then_with(|| {
                right
                    .credential_ref
                    .version
                    .cmp(&left.credential_ref.version)
            })
            .then_with(|| {
                left.credential_ref
                    .fingerprint
                    .cmp(&right.credential_ref.fingerprint)
            })
    })
}

fn denied(code: &str) -> Resolution {
    Resolution {
        outcome: Outcome::Denied {
            code: code.to_owned(),
        },
        trace: Vec::new(),
    }
}

/// Pick the credential for `slot`.
///
/// 1. A gate denial is returned unchanged with an empty trace: credentials
///    never widen policy.
/// 2. A slot outside the grammar is `Denied("invalid_slot")`.
/// 3. A policy with any unknown entry is `Denied("invalid_source_policy")`.
/// 4. The policy is narrowed to [`default_sources`]
///    ([`SourcePolicy::effective_rules`]): an empty list is the default, and a
///    non-empty list never adds a level (in particular never `user` on a
///    shared node without the org opt-in).
/// 5. Walk [`LADDER`] and record one trace entry per level. At each level the
///    checks run in order: owner present (`not_in_scope`), evidence
///    (`evidence_insufficient`), source policy (`source_not_allowed`), then
///    active candidates whose `level`, `owner_id` and `slot_id` match exactly
///    (`empty`). The first level with a hit is `selected`; any later level
///    with a hit is `shadowed`.
/// 6. `NotFound` when no level yields a value.
pub fn resolve_credential(
    slot: &CredentialSlot,
    scope: &CredentialScope,
    candidates: &[CredentialCandidate],
    gate: &GateDecision,
    policy: &SourcePolicy,
) -> Resolution {
    if let GateDecision::Denied { code } = gate {
        return denied(code);
    }
    if !slot.is_valid() {
        return denied(DENIED_INVALID_SLOT);
    }
    let Ok(rules) = policy.effective_rules(scope) else {
        return denied(DENIED_INVALID_SOURCE_POLICY);
    };
    let slot_id = slot.slot_id();
    let mut outcome = Outcome::NotFound;
    let mut trace = Vec::with_capacity(LADDER.len());
    for level in LADDER {
        let status = match scope.owner(level) {
            None => TraceStatus::NotInScope,
            Some(_) if !evidence_unlocks(level, scope) => TraceStatus::EvidenceInsufficient,
            Some(_) if !rules.iter().any(|rule| rule.admits(level, &slot_id)) => {
                TraceStatus::SourceNotAllowed
            }
            Some(owner) => {
                let hits = candidates.iter().filter(|candidate| {
                    candidate.level == level
                        && candidate.status == CandidateStatus::Active
                        && candidate.owner_id == owner.id
                        && candidate.slot_id == slot_id
                });
                match best_candidate(hits) {
                    None => TraceStatus::Empty,
                    Some(_) if matches!(outcome, Outcome::Selected { .. }) => TraceStatus::Shadowed,
                    Some(best) => {
                        outcome = Outcome::Selected {
                            level,
                            credential_ref: best.credential_ref.clone(),
                        };
                        TraceStatus::Selected
                    }
                }
            }
        };
        trace.push(TraceEntry { level, status });
    }
    Resolution { outcome, trace }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const IDS: [(CredentialLevel, &str); 5] = [
        (CredentialLevel::User, "u1"),
        (CredentialLevel::Node, "n1"),
        (CredentialLevel::Project, "p1"),
        (CredentialLevel::Team, "t1"),
        (CredentialLevel::Org, "o1"),
    ];

    const EVIDENCE: [ScopeEvidence; 5] = [
        ScopeEvidence::CredentialBound,
        ScopeEvidence::AdminMapped,
        ScopeEvidence::VerifiedMembership,
        ScopeEvidence::VerifiedIdentity,
        ScopeEvidence::NodeAsserted,
    ];

    fn id_for(level: CredentialLevel) -> &'static str {
        IDS.iter()
            .find(|(candidate, _)| *candidate == level)
            .map(|(_, id)| *id)
            .unwrap()
    }

    fn openai() -> CredentialSlot {
        CredentialSlot::inference("openai")
    }

    fn candidate(level: CredentialLevel, ref_id: &str, priority: u16) -> CredentialCandidate {
        CredentialCandidate {
            level,
            owner_id: id_for(level).to_owned(),
            slot_id: "provider:openai".to_owned(),
            credential_ref: CredentialRef {
                id: ref_id.to_owned(),
                version: 1,
                fingerprint: format!("fp_{ref_id}"),
            },
            priority,
            status: CandidateStatus::Active,
        }
    }

    fn every_level_candidates() -> Vec<CredentialCandidate> {
        LADDER
            .into_iter()
            .map(|level| candidate(level, &format!("ref_{level}"), 1))
            .collect()
    }

    fn shared_scope() -> CredentialScope {
        CredentialScope {
            org: Some(ScopeRef::new("o1", ScopeEvidence::CredentialBound)),
            node: Some(ScopeRef::new("n1", ScopeEvidence::CredentialBound)),
            user: Some(ScopeRef::new("u1", ScopeEvidence::VerifiedIdentity)),
            team: Some(ScopeRef::new("t1", ScopeEvidence::VerifiedMembership)),
            project: Some(ScopeRef::new("p1", ScopeEvidence::AdminMapped)),
            node_kind: NodeKind::Tenant,
            personal: false,
        }
    }

    /// Every option for one scope field: absent, or present with each evidence.
    fn field_options(level: CredentialLevel) -> Vec<Option<ScopeRef>> {
        std::iter::once(None)
            .chain(
                EVIDENCE
                    .into_iter()
                    .map(|evidence| Some(ScopeRef::new(id_for(level), evidence))),
            )
            .collect()
    }

    /// Every combination of evidence for every scope field, node kind and
    /// personal flag (6^5 * 2 * 2 = 31,104 scopes).
    fn all_scopes() -> Vec<CredentialScope> {
        let mut scopes = Vec::new();
        for org in field_options(CredentialLevel::Org) {
            for node in field_options(CredentialLevel::Node) {
                for user in field_options(CredentialLevel::User) {
                    for team in field_options(CredentialLevel::Team) {
                        for project in field_options(CredentialLevel::Project) {
                            for node_kind in [NodeKind::Tenant, NodeKind::Fleet] {
                                for personal in [false, true] {
                                    scopes.push(CredentialScope {
                                        org: org.clone(),
                                        node: node.clone(),
                                        user: user.clone(),
                                        team: team.clone(),
                                        project: project.clone(),
                                        node_kind,
                                        personal,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        scopes
    }

    /// A test policy plus an independent description of what its list names.
    #[derive(Debug)]
    struct TestPolicy {
        policy: SourcePolicy,
        /// Per [`LADDER`] position: whether the list has an entry at that level
        /// that matches `provider:openai`. `None` for an empty list.
        listed: Option<[bool; 5]>,
    }

    /// Every subset of bare levels (the empty subset is the default policy),
    /// slot-scoped, prefix and non-matching entries for every level, and a
    /// lone `user:provider:openai` entry, each with and without the org
    /// opt-in.
    fn all_policies() -> Vec<TestPolicy> {
        let mut lists: Vec<(Vec<String>, Option<[bool; 5]>)> = (0_usize..32)
            .map(|mask| {
                let listed: [bool; 5] = std::array::from_fn(|bit| mask & (1 << bit) != 0);
                let entries = LADDER
                    .into_iter()
                    .zip(listed)
                    .filter(|(_, named)| *named)
                    .map(|(level, _)| level.as_str().to_owned())
                    .collect();
                (entries, (mask != 0).then_some(listed))
            })
            .collect();
        for (pattern, matches) in [
            ("provider:openai", true),
            ("provider:*", true),
            ("provider:anthropic", false),
        ] {
            let entries = LADDER.map(|level| format!("{level}:{pattern}")).to_vec();
            lists.push((entries, Some([matches; 5])));
        }
        lists.push((
            vec!["user:provider:openai".to_owned()],
            Some([true, false, false, false, false]),
        ));
        let mut policies = Vec::new();
        for org_admits_user in [false, true] {
            for (entries, listed) in &lists {
                policies.push(TestPolicy {
                    policy: SourcePolicy::new(entries.clone())
                        .with_org_admits_user(org_admits_user),
                    listed: *listed,
                });
            }
        }
        policies
    }

    fn has_evidence(field: &Option<ScopeRef>, evidence: ScopeEvidence) -> bool {
        field
            .as_ref()
            .is_some_and(|scope_ref| scope_ref.evidence == evidence)
    }

    /// The evidence rules written out independently of [`evidence_unlocks`],
    /// so a change to either one fails the property tests.
    fn oracle_evidence(level: CredentialLevel, scope: &CredentialScope) -> bool {
        let verified_user = has_evidence(&scope.user, ScopeEvidence::VerifiedIdentity);
        let shared = !scope.personal && verified_user;
        match level {
            CredentialLevel::User => {
                verified_user
                    || (scope.personal && has_evidence(&scope.user, ScopeEvidence::CredentialBound))
            }
            CredentialLevel::Node => scope.node.is_some() && scope.node_kind == NodeKind::Tenant,
            CredentialLevel::Project => {
                shared && has_evidence(&scope.project, ScopeEvidence::AdminMapped)
            }
            CredentialLevel::Team => {
                shared && has_evidence(&scope.team, ScopeEvidence::VerifiedMembership)
            }
            CredentialLevel::Org => {
                shared && has_evidence(&scope.org, ScopeEvidence::CredentialBound)
            }
        }
    }

    /// The source rules written out independently of
    /// [`SourcePolicy::effective_rules`] and [`default_sources`].
    fn oracle_admits(level: CredentialLevel, scope: &CredentialScope, test: &TestPolicy) -> bool {
        if level == CredentialLevel::User && !scope.personal && !test.policy.org_admits_user {
            return false;
        }
        let position = LADDER.iter().position(|entry| *entry == level).unwrap();
        test.listed.is_none_or(|listed| listed[position])
    }

    /// The full expected trace when every level holds an active candidate.
    fn oracle_trace(scope: &CredentialScope, test: &TestPolicy) -> Vec<TraceEntry> {
        let mut selected = false;
        LADDER
            .into_iter()
            .map(|level| {
                let present = match level {
                    CredentialLevel::User => scope.user.is_some(),
                    CredentialLevel::Node => scope.node.is_some(),
                    CredentialLevel::Project => scope.project.is_some(),
                    CredentialLevel::Team => scope.team.is_some(),
                    CredentialLevel::Org => scope.org.is_some(),
                };
                let status = if !present {
                    TraceStatus::NotInScope
                } else if !oracle_evidence(level, scope) {
                    TraceStatus::EvidenceInsufficient
                } else if !oracle_admits(level, scope, test) {
                    TraceStatus::SourceNotAllowed
                } else if selected {
                    TraceStatus::Shadowed
                } else {
                    selected = true;
                    TraceStatus::Selected
                };
                TraceEntry { level, status }
            })
            .collect()
    }

    fn selected_level(resolution: &Resolution) -> Option<CredentialLevel> {
        match resolution.outcome {
            Outcome::Selected { level, .. } => Some(level),
            _ => None,
        }
    }

    fn for_every_scope_and_policy(
        mut filter: impl FnMut(&CredentialScope) -> bool,
        mut check: impl FnMut(&CredentialScope, &TestPolicy, &Resolution),
    ) {
        let candidates = every_level_candidates();
        let policies = all_policies();
        for scope in all_scopes().iter().filter(|scope| filter(scope)) {
            for test in &policies {
                let resolution = resolve_credential(
                    &openai(),
                    scope,
                    &candidates,
                    &GateDecision::Allowed,
                    &test.policy,
                );
                check(scope, test, &resolution);
            }
        }
    }

    #[test]
    fn level_parse_round_trip_and_aliases() {
        for level in LADDER {
            assert_eq!(level.as_str().parse::<CredentialLevel>(), Ok(level));
            let wire = serde_json::to_value(level).unwrap();
            assert_eq!(wire, json!(level.as_str()));
            assert_eq!(
                serde_json::from_value::<CredentialLevel>(wire).unwrap(),
                level
            );
        }
        assert_eq!("organization".parse(), Ok(CredentialLevel::Org));
        assert_eq!("personal".parse(), Ok(CredentialLevel::User));
        assert_eq!(
            serde_json::from_value::<CredentialLevel>(json!("organization")).unwrap(),
            CredentialLevel::Org
        );
        assert_eq!(
            serde_json::from_value::<CredentialLevel>(json!("personal")).unwrap(),
            CredentialLevel::User
        );
        for rejected in [
            "Org", "node ", "tenant", "", "ORG", " user", "managed", "fleet",
        ] {
            assert_eq!(rejected.parse::<CredentialLevel>(), Err(ParseLevelError));
            assert!(serde_json::from_value::<CredentialLevel>(json!(rejected)).is_err());
        }
    }

    #[test]
    fn ladder_rank_and_policy_level_names() {
        let ranks: Vec<u8> = LADDER.iter().map(|level| level.rank()).collect();
        assert_eq!(ranks, vec![4, 3, 2, 1, 0]);
        let mut names: Vec<&str> = LADDER
            .iter()
            .map(|level| level.as_str())
            .filter(|name| *name != "node")
            .collect();
        let mut policy_names = POLICY_LEVEL_NAMES.to_vec();
        names.sort_unstable();
        policy_names.sort_unstable();
        assert_eq!(names, policy_names);
        assert!(!POLICY_LEVEL_NAMES.contains(&"node"));
    }

    #[test]
    fn slot_id_grammar() {
        for (slot_id, purpose, provider, key) in [
            (
                "provider:openai",
                CredentialPurpose::Inference,
                "openai",
                None,
            ),
            (
                "provider:genai:vertex",
                CredentialPurpose::Inference,
                "genai:vertex",
                None,
            ),
            (
                "platform:composio",
                CredentialPurpose::ConnectionPlatform,
                "composio",
                None,
            ),
            (
                "platform:treg",
                CredentialPurpose::ConnectionPlatform,
                "treg",
                None,
            ),
            (
                "connection:composio:github",
                CredentialPurpose::ConnectionAccount,
                "composio",
                Some("github"),
            ),
            (
                "connection:mcp:com.ryu.browser",
                CredentialPurpose::ConnectionAccount,
                "mcp",
                Some("com.ryu.browser"),
            ),
            ("tool:exa", CredentialPurpose::ToolVendor, "exa", None),
            (
                "tool:brave-search",
                CredentialPurpose::ToolVendor,
                "brave-search",
                None,
            ),
        ] {
            let slot = CredentialSlot::parse(slot_id).unwrap();
            assert_eq!(slot.purpose, purpose, "{slot_id}");
            assert_eq!(slot.provider, provider, "{slot_id}");
            assert_eq!(slot.key.as_deref(), key, "{slot_id}");
            assert_eq!(slot.slot_id(), slot_id);
            assert!(slot.is_valid());
            assert_eq!(serde_json::to_value(&slot).unwrap(), json!(slot_id));
            assert_eq!(
                serde_json::from_value::<CredentialSlot>(json!(slot_id)).unwrap(),
                slot
            );
        }
        let longest = format!("provider:{}", "a".repeat(MAX_ID_LEN));
        assert!(CredentialSlot::parse(&longest).is_ok());
        let too_long = format!("provider:{}", "a".repeat(MAX_ID_LEN + 1));
        let too_long_toolkit = format!("connection:composio:{}", "a".repeat(MAX_ID_LEN + 1));
        for rejected in [
            "",
            "provider:",
            "provider: openai",
            "provider:open ai",
            "provider:openai\n",
            "provider:op\u{e9}nai",
            "provider:open*",
            "provider:genai:",
            "provider::x",
            too_long.as_str(),
            "platform:",
            "platform:other",
            "platform:composio:x",
            "connection:",
            "connection:composio",
            "connection:composio:",
            "connection:composio:a:b",
            "connection:slack:general",
            "connection:mcp:",
            "connection:mcp:a b",
            too_long_toolkit.as_str(),
            "tool:",
            "tool:Exa",
            "tool:exa:search",
            "tool:exa.search",
            "tool:-exa",
            "tool:ex_a",
            "secret:openai",
            "Provider:openai",
            "openai",
        ] {
            assert!(CredentialSlot::parse(rejected).is_err(), "{rejected:?}");
            assert!(
                serde_json::from_value::<CredentialSlot>(json!(rejected)).is_err(),
                "{rejected:?}"
            );
        }
        let hand_built = CredentialSlot {
            purpose: CredentialPurpose::ConnectionPlatform,
            provider: "other".to_owned(),
            key: None,
        };
        assert!(!hand_built.is_valid());
        let mismatched = CredentialSlot {
            purpose: CredentialPurpose::Inference,
            provider: "openai".to_owned(),
            key: Some("extra".to_owned()),
        };
        assert!(!mismatched.is_valid());
        let keyed_vendor = CredentialSlot {
            purpose: CredentialPurpose::ToolVendor,
            provider: "exa".to_owned(),
            key: Some("search".to_owned()),
        };
        assert!(!keyed_vendor.is_valid());
        assert!(CredentialSlot::tool_vendor("exa").is_valid());
        assert!(!CredentialSlot::tool_vendor("Exa").is_valid());
    }

    #[test]
    fn source_policy_grammar() {
        let parsed = SourcePolicy::new([
            "team",
            "organization",
            "personal:provider:openai",
            "user:provider:genai:*",
            "node:connection:*",
            "team:tool:exa",
            "org:tool:*",
        ])
        .parse_sources()
        .unwrap();
        assert_eq!(
            parsed,
            vec![
                SourceRule {
                    level: CredentialLevel::Team,
                    slots: SlotMatch::Any
                },
                SourceRule {
                    level: CredentialLevel::Org,
                    slots: SlotMatch::Any
                },
                SourceRule {
                    level: CredentialLevel::User,
                    slots: SlotMatch::Exact("provider:openai".to_owned())
                },
                SourceRule {
                    level: CredentialLevel::User,
                    slots: SlotMatch::Prefix("provider:genai:".to_owned())
                },
                SourceRule {
                    level: CredentialLevel::Node,
                    slots: SlotMatch::Prefix("connection:".to_owned())
                },
                SourceRule {
                    level: CredentialLevel::Team,
                    slots: SlotMatch::Exact("tool:exa".to_owned())
                },
                SourceRule {
                    level: CredentialLevel::Org,
                    slots: SlotMatch::Prefix("tool:".to_owned())
                },
            ]
        );
        for rejected in [
            "",
            "*",
            "tenant",
            "Org",
            " team",
            "team ",
            "user:",
            "user:*",
            "user:p*",
            "user:provider:*:x",
            "user:provider:a*b",
            "user:provider:open ai",
            "user:platform:other",
            "team:tool:Exa",
            "team:tools:*",
            "managed",
            "user*",
        ] {
            let error = SourcePolicy::new(["org", rejected])
                .parse_sources()
                .unwrap_err();
            assert_eq!(error.index, 1, "{rejected:?}");
        }
    }

    #[test]
    fn default_sources_add_user_only_when_personal() {
        let mut scope = shared_scope();
        assert_eq!(
            default_sources(&scope, false),
            vec![
                CredentialLevel::Node,
                CredentialLevel::Project,
                CredentialLevel::Team,
                CredentialLevel::Org
            ]
        );
        assert_eq!(default_sources(&scope, true), LADDER.to_vec());
        scope.personal = true;
        assert_eq!(default_sources(&scope, false), LADDER.to_vec());
        assert_eq!(default_sources(&scope, true), LADDER.to_vec());
    }

    #[test]
    fn effective_rules_only_narrow_the_default() {
        let scope = shared_scope();
        let levels = |policy: SourcePolicy| -> Vec<CredentialLevel> {
            policy
                .effective_rules(&scope)
                .unwrap()
                .into_iter()
                .map(|rule| rule.level)
                .collect()
        };
        // An org that left the list empty, then a lower layer that wrote
        // `user`: narrowPolicyAllowlist([], ["user"]) hands the contract
        // ["user"], and the entry is dropped.
        assert!(levels(SourcePolicy::new(["user"])).is_empty());
        assert_eq!(
            levels(SourcePolicy::new(["user", "team"])),
            vec![CredentialLevel::Team]
        );
        assert!(levels(SourcePolicy::new(["personal:provider:*"])).is_empty());
        assert_eq!(
            levels(SourcePolicy::new(["user", "team"]).with_org_admits_user(true)),
            vec![CredentialLevel::User, CredentialLevel::Team]
        );
        // An invalid entry still invalidates the policy before narrowing.
        assert!(SourcePolicy::new(["user", "tenant"])
            .effective_rules(&scope)
            .is_err());
    }

    #[test]
    fn lower_layer_user_entry_never_selects_user_without_org_opt_in() {
        let candidates = every_level_candidates();
        for entries in [
            vec!["user"],
            vec!["personal"],
            vec!["user", "team"],
            vec!["user", "node", "project", "team", "org"],
            vec!["user:provider:openai"],
            vec!["user:provider:*"],
        ] {
            let resolution = resolve_credential(
                &openai(),
                &shared_scope(),
                &candidates,
                &GateDecision::Allowed,
                &SourcePolicy::new(entries.clone()),
            );
            assert_ne!(
                selected_level(&resolution),
                Some(CredentialLevel::User),
                "{entries:?}"
            );
            assert_eq!(
                resolution.trace[0],
                TraceEntry {
                    level: CredentialLevel::User,
                    status: TraceStatus::SourceNotAllowed
                },
                "{entries:?}"
            );
        }
    }

    #[test]
    fn user_source_needs_org_opt_in_on_shared_node() {
        for_every_scope_and_policy(
            |scope| !scope.personal,
            |scope, test, resolution| {
                if test.policy.org_admits_user {
                    return;
                }
                assert_ne!(
                    selected_level(resolution),
                    Some(CredentialLevel::User),
                    "{scope:?} {test:?}"
                );
                assert!(
                    !matches!(
                        resolution.trace[0].status,
                        TraceStatus::Selected | TraceStatus::Shadowed
                    ),
                    "{scope:?} {test:?}"
                );
            },
        );
    }

    #[test]
    fn source_lists_never_admit_beyond_the_default() {
        let candidates = every_level_candidates();
        for_every_scope_and_policy(
            |_| true,
            |scope, test, resolution| {
                let Some(level) = selected_level(resolution) else {
                    return;
                };
                let default = resolve_credential(
                    &openai(),
                    scope,
                    &candidates,
                    &GateDecision::Allowed,
                    &SourcePolicy::default().with_org_admits_user(test.policy.org_admits_user),
                );
                let position = LADDER.iter().position(|entry| *entry == level).unwrap();
                assert!(
                    matches!(
                        default.trace[position].status,
                        TraceStatus::Selected | TraceStatus::Shadowed
                    ),
                    "{scope:?} {test:?}"
                );
            },
        );
    }

    #[test]
    fn each_shared_level_accepts_only_its_own_evidence() {
        let required = [
            (CredentialLevel::Project, ScopeEvidence::AdminMapped),
            (CredentialLevel::Team, ScopeEvidence::VerifiedMembership),
            (CredentialLevel::Org, ScopeEvidence::CredentialBound),
            (CredentialLevel::User, ScopeEvidence::VerifiedIdentity),
        ];
        let candidates = every_level_candidates();
        for (level, needed) in required {
            for evidence in EVIDENCE {
                let mut scope = shared_scope();
                let scope_ref = Some(ScopeRef::new(id_for(level), evidence));
                match level {
                    CredentialLevel::Project => scope.project = scope_ref,
                    CredentialLevel::Team => scope.team = scope_ref,
                    CredentialLevel::Org => scope.org = scope_ref,
                    CredentialLevel::User => scope.user = scope_ref,
                    CredentialLevel::Node => unreachable!(),
                }
                let resolution = resolve_credential(
                    &openai(),
                    &scope,
                    &candidates,
                    &GateDecision::Allowed,
                    &SourcePolicy::new([level.as_str()]).with_org_admits_user(true),
                );
                let position = LADDER.iter().position(|entry| *entry == level).unwrap();
                if evidence == needed {
                    assert_eq!(
                        selected_level(&resolution),
                        Some(level),
                        "{level} {evidence:?}"
                    );
                } else {
                    assert_eq!(
                        resolution.outcome,
                        Outcome::NotFound,
                        "{level} {evidence:?}"
                    );
                    assert_eq!(
                        resolution.trace[position].status,
                        TraceStatus::EvidenceInsufficient,
                        "{level} {evidence:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn node_only_candidates_preserve_today() {
        let candidates = [candidate(CredentialLevel::Node, "ref_node", 0)];
        let mut checked = 0_usize;
        for scope in all_scopes()
            .iter()
            .filter(|scope| scope.node_kind == NodeKind::Tenant && scope.node.is_some())
        {
            let resolution = resolve_credential(
                &openai(),
                scope,
                &candidates,
                &GateDecision::Allowed,
                &SourcePolicy::default(),
            );
            assert_eq!(
                resolution.outcome,
                Outcome::Selected {
                    level: CredentialLevel::Node,
                    credential_ref: candidates[0].credential_ref.clone(),
                },
                "{scope:?}"
            );
            checked += 1;
        }
        assert_eq!(checked, 5 * 6 * 6 * 6 * 6 * 2);
    }

    #[test]
    fn shared_levels_need_verified_identity() {
        for_every_scope_and_policy(
            |scope| {
                !scope
                    .user
                    .as_ref()
                    .is_some_and(|user| user.evidence == ScopeEvidence::VerifiedIdentity)
            },
            |scope, policy, resolution| {
                assert!(
                    !matches!(
                        selected_level(resolution),
                        Some(
                            CredentialLevel::Team | CredentialLevel::Project | CredentialLevel::Org
                        )
                    ),
                    "{scope:?} {policy:?} {resolution:?}"
                );
            },
        );
    }

    #[test]
    fn node_asserted_project_never_unlocks() {
        for_every_scope_and_policy(
            |scope| {
                scope
                    .project
                    .as_ref()
                    .is_some_and(|project| project.evidence == ScopeEvidence::NodeAsserted)
            },
            |scope, policy, resolution| {
                assert_ne!(
                    selected_level(resolution),
                    Some(CredentialLevel::Project),
                    "{scope:?} {policy:?}"
                );
            },
        );
    }

    #[test]
    fn empty_policy_never_selects_user_on_shared_node() {
        let candidates = every_level_candidates();
        for scope in all_scopes().iter().filter(|scope| !scope.personal) {
            let resolution = resolve_credential(
                &openai(),
                scope,
                &candidates,
                &GateDecision::Allowed,
                &SourcePolicy::default(),
            );
            assert_ne!(
                selected_level(&resolution),
                Some(CredentialLevel::User),
                "{scope:?}"
            );
        }
    }

    #[test]
    fn personal_never_reaches_shared_levels() {
        for_every_scope_and_policy(
            |scope| scope.personal,
            |scope, policy, resolution| {
                assert!(
                    !matches!(
                        selected_level(resolution),
                        Some(
                            CredentialLevel::Team | CredentialLevel::Project | CredentialLevel::Org
                        )
                    ),
                    "{scope:?} {policy:?}"
                );
            },
        );
    }

    #[test]
    fn trace_covers_ladder_and_matches_outcome() {
        for_every_scope_and_policy(
            |_| true,
            |scope, policy, resolution| {
                let levels: Vec<CredentialLevel> =
                    resolution.trace.iter().map(|entry| entry.level).collect();
                assert_eq!(levels, LADDER.to_vec(), "{scope:?} {policy:?}");
                let selected: Vec<CredentialLevel> = resolution
                    .trace
                    .iter()
                    .filter(|entry| entry.status == TraceStatus::Selected)
                    .map(|entry| entry.level)
                    .collect();
                match &resolution.outcome {
                    Outcome::Selected { level, .. } => assert_eq!(selected, vec![*level]),
                    Outcome::NotFound => {
                        assert!(selected.is_empty());
                        assert!(resolution
                            .trace
                            .iter()
                            .all(|entry| entry.status != TraceStatus::Shadowed));
                    }
                    Outcome::Denied { .. } => panic!("unexpected denial {scope:?} {policy:?}"),
                }
                // The whole trace, and so the selection, matches the truth
                // table written out in the test (`oracle_evidence`,
                // `oracle_admits`), not the implementation's own helpers.
                // Selected{L} therefore implies L's own evidence kind and an
                // admitting source, and conversely the most specific such
                // level is the one selected.
                let expected = oracle_trace(scope, policy);
                assert_eq!(resolution.trace, expected, "{scope:?} {policy:?}");
                let expected_level = expected
                    .iter()
                    .find(|entry| entry.status == TraceStatus::Selected)
                    .map(|entry| entry.level);
                assert_eq!(
                    selected_level(resolution),
                    expected_level,
                    "{scope:?} {policy:?}"
                );
            },
        );
    }

    #[test]
    fn gate_denial_wins() {
        let gate = GateDecision::Denied {
            code: "provider_not_approved".to_owned(),
        };
        let candidates = every_level_candidates();
        for scope in all_scopes() {
            for policy in [
                SourcePolicy::default(),
                SourcePolicy::new(LADDER.map(CredentialLevel::as_str)),
            ] {
                let resolution = resolve_credential(&openai(), &scope, &candidates, &gate, &policy);
                assert_eq!(
                    resolution,
                    Resolution {
                        outcome: Outcome::Denied {
                            code: "provider_not_approved".to_owned()
                        },
                        trace: Vec::new(),
                    }
                );
            }
        }
        // The gate also beats an invalid policy and an invalid slot.
        let invalid_slot = CredentialSlot::inference("open ai");
        let resolution = resolve_credential(
            &invalid_slot,
            &shared_scope(),
            &candidates,
            &gate,
            &SourcePolicy::new(["tenant"]),
        );
        assert_eq!(resolution.outcome, gate_outcome("provider_not_approved"));
    }

    fn gate_outcome(code: &str) -> Outcome {
        Outcome::Denied {
            code: code.to_owned(),
        }
    }

    #[test]
    fn invalid_slot_and_policy_are_denied_with_empty_trace() {
        let candidates = every_level_candidates();
        let resolution = resolve_credential(
            &CredentialSlot::inference(""),
            &shared_scope(),
            &candidates,
            &GateDecision::Allowed,
            &SourcePolicy::default(),
        );
        assert_eq!(resolution.outcome, gate_outcome(DENIED_INVALID_SLOT));
        assert!(resolution.trace.is_empty());
        let resolution = resolve_credential(
            &openai(),
            &shared_scope(),
            &candidates,
            &GateDecision::Allowed,
            &SourcePolicy::new(["org", "Team"]),
        );
        assert_eq!(
            resolution.outcome,
            gate_outcome(DENIED_INVALID_SOURCE_POLICY)
        );
        assert!(resolution.trace.is_empty());
    }

    #[test]
    fn inactive_candidates_skipped_and_tie_break() {
        let scope = shared_scope();
        let policy = SourcePolicy::new(["org"]);
        let resolve = |candidates: &[CredentialCandidate]| {
            resolve_credential(
                &openai(),
                &scope,
                candidates,
                &GateDecision::Allowed,
                &policy,
            )
        };
        let mut inactive = Vec::new();
        for status in [
            CandidateStatus::Disabled,
            CandidateStatus::Expired,
            CandidateStatus::Revoked,
        ] {
            let mut entry = candidate(CredentialLevel::Org, "a_inactive", 99);
            entry.status = status;
            inactive.push(entry);
        }
        assert_eq!(resolve(&inactive).outcome, Outcome::NotFound);
        let mut with_active = inactive.clone();
        with_active.push(candidate(CredentialLevel::Org, "z_active", 1));
        assert_eq!(
            resolve(&with_active).outcome,
            Outcome::Selected {
                level: CredentialLevel::Org,
                credential_ref: with_active[3].credential_ref.clone(),
            }
        );

        let higher_priority = [
            candidate(CredentialLevel::Org, "a", 5),
            candidate(CredentialLevel::Org, "z", 20),
        ];
        let equal_priority = [
            candidate(CredentialLevel::Org, "b", 10),
            candidate(CredentialLevel::Org, "a", 10),
            candidate(CredentialLevel::Org, "c", 5),
        ];
        for (candidates, winner) in [
            (higher_priority.to_vec(), "z"),
            (equal_priority.to_vec(), "a"),
        ] {
            let mut reversed = candidates.clone();
            reversed.reverse();
            for ordering in [candidates, reversed] {
                match resolve(&ordering).outcome {
                    Outcome::Selected { credential_ref, .. } => {
                        assert_eq!(credential_ref.id, winner)
                    }
                    other => panic!("expected a selection, got {other:?}"),
                }
            }
        }

        // Same ref id: the newest version wins, regardless of input order.
        let mut old = candidate(CredentialLevel::Org, "a", 10);
        old.credential_ref.version = 1;
        let mut new = candidate(CredentialLevel::Org, "a", 10);
        new.credential_ref.version = 2;
        for ordering in [
            vec![old.clone(), new.clone()],
            vec![new.clone(), old.clone()],
        ] {
            match resolve(&ordering).outcome {
                Outcome::Selected { credential_ref, .. } => assert_eq!(credential_ref.version, 2),
                other => panic!("expected a selection, got {other:?}"),
            }
        }
    }

    #[test]
    fn foreign_owners_and_other_slots_are_ignored() {
        let mut foreign = candidate(CredentialLevel::Org, "foreign", 99);
        foreign.owner_id = "o2".to_owned();
        let mut other_slot = candidate(CredentialLevel::Org, "anthropic", 99);
        other_slot.slot_id = "provider:anthropic".to_owned();
        let mut wrong_level = candidate(CredentialLevel::Team, "wrong_level", 99);
        wrong_level.owner_id = "o1".to_owned();
        let resolution = resolve_credential(
            &openai(),
            &shared_scope(),
            &[foreign, other_slot, wrong_level],
            &GateDecision::Allowed,
            &SourcePolicy::new(["org"]),
        );
        assert_eq!(resolution.outcome, Outcome::NotFound);
    }

    #[test]
    fn invalid_scope_ids_are_not_in_scope() {
        let mut scope = shared_scope();
        scope.org = Some(ScopeRef::new("", ScopeEvidence::CredentialBound));
        let mut empty_owner = candidate(CredentialLevel::Org, "empty", 1);
        empty_owner.owner_id = String::new();
        let resolution = resolve_credential(
            &openai(),
            &scope,
            &[empty_owner],
            &GateDecision::Allowed,
            &SourcePolicy::new(["org"]),
        );
        assert_eq!(resolution.outcome, Outcome::NotFound);
        assert_eq!(
            resolution.trace[4],
            TraceEntry {
                level: CredentialLevel::Org,
                status: TraceStatus::NotInScope
            }
        );
        scope.org = Some(ScopeRef::new("o 1", ScopeEvidence::CredentialBound));
        assert!(scope.owner(CredentialLevel::Org).is_none());
    }

    fn collect_keys(value: &Value, keys: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, nested) in map {
                    keys.push(key.clone());
                    collect_keys(nested, keys);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect_keys(item, keys)),
            _ => {}
        }
    }

    #[test]
    fn serde_shapes_are_camel_case_and_carry_no_secret() {
        let entry = candidate(CredentialLevel::Org, "ref_org", 3);
        let candidate_json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            candidate_json,
            json!({
                "level": "org",
                "ownerId": "o1",
                "slotId": "provider:openai",
                "credentialRef": { "id": "ref_org", "version": 1, "fingerprint": "fp_ref_org" },
                "priority": 3,
                "status": "active"
            })
        );
        let resolution = resolve_credential(
            &openai(),
            &shared_scope(),
            &[entry],
            &GateDecision::Allowed,
            &SourcePolicy::default(),
        );
        let resolution_json = serde_json::to_value(&resolution).unwrap();
        assert_eq!(
            resolution_json["outcome"],
            json!({
                "type": "selected",
                "level": "org",
                "credentialRef": { "id": "ref_org", "version": 1, "fingerprint": "fp_ref_org" }
            })
        );
        assert_eq!(
            resolution_json["trace"][0],
            json!({ "level": "user", "status": "source_not_allowed" })
        );
        assert_eq!(
            serde_json::to_value(GateDecision::Denied {
                code: "x".to_owned()
            })
            .unwrap(),
            json!({ "type": "denied", "code": "x" })
        );
        assert_eq!(
            serde_json::to_value(Outcome::NotFound).unwrap(),
            json!({ "type": "not_found" })
        );
        assert_eq!(
            serde_json::to_value(SourcePolicy::new(["org"]).with_org_admits_user(true)).unwrap(),
            json!({ "allowed": ["org"], "orgAdmitsUser": true })
        );
        // The opt-in defaults to off when a payload omits it.
        assert_eq!(
            serde_json::from_value::<SourcePolicy>(json!({ "allowed": ["user"] })).unwrap(),
            SourcePolicy::new(["user"])
        );
        let scope_json = serde_json::to_value(shared_scope()).unwrap();
        assert_eq!(scope_json["nodeKind"], json!("tenant"));
        assert_eq!(scope_json["user"]["evidence"], json!("verified_identity"));

        let mut keys = Vec::new();
        for value in [&candidate_json, &resolution_json, &scope_json] {
            collect_keys(value, &mut keys);
        }
        for key in &keys {
            let lower = key.to_ascii_lowercase();
            assert!(
                !lower.contains("value") && !lower.contains("secret"),
                "{key}"
            );
            assert!(!key.contains('_'), "{key} is not camelCase");
        }
        assert_eq!(
            serde_json::from_value::<Resolution>(resolution_json).unwrap(),
            resolution
        );

        // A payload that tries to carry a value is rejected outright.
        let mut smuggled = candidate_json.clone();
        smuggled["value"] = json!("sk-should-never-be-here");
        assert!(serde_json::from_value::<CredentialCandidate>(smuggled).is_err());
        let mut smuggled_ref = candidate_json;
        smuggled_ref["credentialRef"]["secret"] = json!("sk-should-never-be-here");
        assert!(serde_json::from_value::<CredentialCandidate>(smuggled_ref).is_err());
    }
}
