//! Discord-shaped permission resolution for shared resources.
//!
//! This is the FINE-GRAINED half of access control and must not be conflated
//! with `crate::identity_verify::can_access`, which answers a different, coarser
//! question (does this caller reach this row at all, given owner/org/visibility).
//! That one returns an `Access` ladder (`None`/`Read`/`Write`); this one answers
//! yes/no for a single named permission id, so it returns its own [`Decision`]
//! rather than pretending the two lattices are the same. A caller that needs
//! both runs the tenancy gate first and this resolver second.
//!
//! # Relationship to the existing RBAC vocabulary
//!
//! [`crate::identity_verify::permissions`] already owns the canonical permission
//! KEYS (`space.read`, `workflow.edit`, …) and the built-in role → permission-set
//! mapping, shared byte-for-byte with the TypeScript control plane. This module
//! does NOT redefine that vocabulary and must never fork it: a [`PermissionRegistry`]
//! is expected to be populated FROM those keys plus the levels an app declares in
//! its manifest (`PluginManifest::permission_levels`), and a [`RoleCatalog`] from
//! `permissions_for_role` unioned with the custom roles
//! `control_plane::resolve_permissions` returns.
//!
//! What is genuinely new here is the PER-RESOURCE layer. The existing code answers
//! "may this role do X anywhere in the org"; it has no way to say "…except in this
//! one Space, where team B may not". That exception is what overwrites add, and it
//! is why this resolver exists rather than another function in `permissions.rs`.
//!
//! The model, borrowed from Discord because its shape is already understood by
//! anyone who has configured a channel:
//!   - a ROLE carries a BASE set of permission ids;
//!   - any RESOURCE may carry OVERWRITES that allow or deny specific ids,
//!     targeted at an org, a team, a role, or an individual member.
//!
//! # Resolution order
//!
//! 1. Expand IMPLICATIONS over every set (base, allow, deny) FIRST, so the tier
//!    walk below is plain set membership. Resolving an id and expanding
//!    afterwards gives different — wrong — answers on cross-tier cases.
//! 2. Compute the BASE as the union of the catalog's permission sets for the
//!    roles the principal actually holds. A held role that the catalog does not
//!    know contributes nothing.
//! 3. Walk the overwrite tiers MOST SPECIFIC FIRST — member, then role, then
//!    team, then org — considering only overwrites whose target matches the
//!    principal (someone else's member overwrite is not ours to read).
//! 4. The FIRST tier that mentions the permission decides it, and within that
//!    tier deny beats allow — so an overwrite that both allows and denies an id
//!    denies it AT THAT TIER, which a more specific tier can still overturn.
//!    Specificity outranks polarity; polarity only breaks ties inside one tier.
//! 5. If no tier mentions the permission, the base decides it.
//! 6. Everything else is [`Decision::Denied`]: an id the registry does not
//!    declare, an empty input, a principal with no matching role, a permission
//!    that neither a matching overwrite nor the base ever mentions.
//!
//! The consequence of step 4 that reads backwards to most people: **a member
//! allow beats a role deny**. A deny is absolute only against the tiers BELOW
//! it, never against a more specific one — that is what makes "grant this one
//! person an exception" expressible at all.
//!
//! # Implication direction
//!
//! An implication is ONE edge, `edit -> read` ("holding edit implies holding
//! read"), but it propagates in two directions depending on polarity:
//!   - GRANTS travel ALONG the edge: base or allow of `edit` also yields `read`.
//!   - DENIALS travel AGAINST it: denying `read` also denies `edit`, because a
//!     permission that implies a denied one cannot survive its own precondition.
//!
//! Worked: with `space.delete -> space.write -> space.read`, an allow of
//! `space.delete` grants all three; a deny of `space.read` denies all three; and
//! a member allow of `space.write` over a role deny of `space.read` grants
//! `space.write` AND `space.read` (step 4 settles both at the member tier).
//!
//! Everything here is a pure function over its arguments — no I/O, no globals,
//! no clock — for the same reason `can_access` is: this is the layer that has to
//! be exhaustively unit-testable, because a mistake in it is invisible until it
//! leaks data.

// The resolver is the model half of the RBAC epic; the enforcement wiring that
// calls it lands separately, so its public surface is intentionally unused here.
#![allow(dead_code)]

pub mod store;
pub mod vocabulary;

use std::collections::{BTreeMap, BTreeSet};

// ── Resource kinds ───────────────────────────────────────────────────────────
//
// The store keys overwrites by `"<kind>:<id>"`, so a handler that spells its kind
// differently from the editor that wrote the rule reads an empty ACL and the rule
// silently never applies. Constants rather than literals so that mismatch is a
// compile error instead of a permission that quietly does nothing.

/// A Space. Documents live inside one and carry no kind of their own: the
/// permissions guarding them are `space.*`, so an overwrite is authored on the
/// SPACE and every document route resolves against that same id.
/// Every resource kind this node enforces per-resource permissions on, in the
/// order a picker should offer them.
///
/// Served to clients (`GET /api/acl/principals`) rather than duplicated in each
/// one. The desktop previously kept its own list, which said only `space` while
/// Core had grown three more kinds — so agents and workflows were uneditable and
/// nothing failed to say so. A single exported source cannot drift.
pub const ENFORCED_KINDS: &[&str] = &[
    KIND_SPACE,
    KIND_CONVERSATION,
    KIND_AGENT,
    KIND_WORKFLOW,
    KIND_NODE,
];

pub const KIND_SPACE: &str = "space";
/// A conversation (the realtime/chat plane's resource).
pub const KIND_CONVERSATION: &str = "conversation";
/// An agent definition.
pub const KIND_AGENT: &str = "agent";
/// A workflow definition.
pub const KIND_WORKFLOW: &str = "workflow";
/// A managed Core node. App lifecycle ACLs are node-wide rather than package-
/// specific, so every installable package action resolves against this key.
pub const KIND_NODE: &str = "node";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/// The declared permission vocabulary plus its implication graph. An id that is
/// not declared here does not exist as far as the resolver is concerned, which
/// is what makes a typo'd or retired id deny rather than silently allow.
#[derive(Debug, Clone, Default)]
pub struct PermissionRegistry {
    declared: BTreeSet<String>,
    /// `implier -> directly implied`. Grants walk this direction.
    implies: BTreeMap<String, BTreeSet<String>>,
    /// The reverse index of `implies`. Denials walk this direction.
    implied_by: BTreeMap<String, BTreeSet<String>>,
}

impl PermissionRegistry {
    pub fn new<I, S>(declared: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            declared: declared.into_iter().map(Into::into).collect(),
            implies: BTreeMap::new(),
            implied_by: BTreeMap::new(),
        }
    }

    /// Declare that `implier` implies `implied` (e.g. `space.write` implies
    /// `space.read`). An edge touching an undeclared id is dropped: honouring it
    /// would let an unknown id widen a known one.
    #[must_use]
    pub fn with_implication(mut self, implier: &str, implied: &str) -> Self {
        if !self.declared.contains(implier) || !self.declared.contains(implied) {
            return self;
        }
        self.implies
            .entry(implier.to_string())
            .or_default()
            .insert(implied.to_string());
        self.implied_by
            .entry(implied.to_string())
            .or_default()
            .insert(implier.to_string());
        self
    }

    pub fn is_declared(&self, permission: &str) -> bool {
        self.declared.contains(permission)
    }

    pub fn declared(&self) -> impl Iterator<Item = &str> {
        self.declared.iter().map(String::as_str)
    }

    /// Every id held transitively by holding `seeds` (seeds included).
    fn grant_closure<'a>(&self, seeds: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
        self.closure(seeds, &self.implies)
    }

    /// Every id transitively denied by denying `seeds` (seeds included) — the
    /// contrapositive of [`Self::grant_closure`].
    fn denial_closure<'a>(&self, seeds: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
        self.closure(seeds, &self.implied_by)
    }

    /// Breadth-first over `edges` with a visited set, so a cyclic implication
    /// graph (which nothing forbids at construction time) terminates instead of
    /// hanging the request that tripped over it.
    fn closure<'a>(
        &self,
        seeds: impl IntoIterator<Item = &'a str>,
        edges: &BTreeMap<String, BTreeSet<String>>,
    ) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let mut queue: Vec<String> = seeds
            .into_iter()
            .filter(|id| self.declared.contains(*id))
            .map(str::to_string)
            .collect();
        while let Some(id) = queue.pop() {
            if !out.insert(id.clone()) {
                continue;
            }
            if let Some(next) = edges.get(&id) {
                queue.extend(next.iter().cloned());
            }
        }
        out
    }
}

// ── Roles ────────────────────────────────────────────────────────────────────

/// The role definitions in force, keyed by role id.
///
/// A role a principal holds but that is absent here contributes no BASE
/// permissions — but it is still a valid overwrite TARGET, because overwrite
/// matching reads the principal's `role_ids` and never consults this catalog.
/// So a stale assignment to a deleted role grants nothing on its own, yet an
/// overwrite naming that role id still applies to whoever holds it. Deleting a
/// role therefore requires sweeping overwrites that target it; dropping it from
/// this catalog alone is not enough.
#[derive(Debug, Clone, Default)]
pub struct RoleCatalog {
    roles: BTreeMap<String, BTreeSet<String>>,
}

impl RoleCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_role<I, S>(mut self, role_id: &str, base: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.roles.insert(
            role_id.to_string(),
            base.into_iter().map(Into::into).collect(),
        );
        self
    }

    fn base_for(&self, role_id: &str) -> Option<&BTreeSet<String>> {
        self.roles.get(role_id)
    }
}

// ── Principal ────────────────────────────────────────────────────────────────

/// Who is asking. Deliberately a local input struct rather than a borrow of the
/// verified-claims type: the resolver stays testable without a JWT, and the
/// mapping from claims to this lives at the enforcement seam.
#[derive(Debug, Clone, Default)]
pub struct Principal {
    pub user_id: String,
    pub org_id: Option<String>,
    pub team_ids: BTreeSet<String>,
    pub role_ids: BTreeSet<String>,
}

// ── Overwrites ───────────────────────────────────────────────────────────────

/// Ascending specificity. The variant order is documentation only; the walk uses
/// [`TIERS_MOST_SPECIFIC_FIRST`] so the direction is stated once, in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    Org,
    Team,
    Role,
    Member,
}

const TIERS_MOST_SPECIFIC_FIRST: [Tier; 4] = [Tier::Member, Tier::Role, Tier::Team, Tier::Org];

/// Who an overwrite is aimed at. The payload is the id of that org/team/role/user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverwriteTarget {
    Org(String),
    Team(String),
    Role(String),
    Member(String),
}

impl OverwriteTarget {
    fn tier(&self) -> Tier {
        match self {
            Self::Org(_) => Tier::Org,
            Self::Team(_) => Tier::Team,
            Self::Role(_) => Tier::Role,
            Self::Member(_) => Tier::Member,
        }
    }

    fn matches(&self, principal: &Principal) -> bool {
        match self {
            Self::Org(id) => principal.org_id.as_deref() == Some(id.as_str()),
            Self::Team(id) => principal.team_ids.contains(id),
            Self::Role(id) => principal.role_ids.contains(id),
            Self::Member(id) => principal.user_id == *id,
        }
    }
}

/// One allow/deny pair aimed at one target. Both sets may be non-empty; see the
/// module docs for how a contradiction resolves (deny, within the tier).
#[derive(Debug, Clone)]
pub struct Overwrite {
    pub target: OverwriteTarget,
    pub allow: BTreeSet<String>,
    pub deny: BTreeSet<String>,
}

impl Overwrite {
    pub fn new(target: OverwriteTarget) -> Self {
        Self {
            target,
            allow: BTreeSet::new(),
            deny: BTreeSet::new(),
        }
    }

    #[must_use]
    pub fn allowing<I, S>(mut self, ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.allow.extend(ids.into_iter().map(Into::into));
        self
    }

    #[must_use]
    pub fn denying<I, S>(mut self, ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.deny.extend(ids.into_iter().map(Into::into));
        self
    }
}

/// The overwrites carried by one resource. A resource with none of them defers
/// entirely to role bases.
#[derive(Debug, Clone, Default)]
pub struct ResourceAcl {
    pub overwrites: Vec<Overwrite>,
}

impl ResourceAcl {
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, overwrite: Overwrite) -> Self {
        self.overwrites.push(overwrite);
        self
    }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/// `#[must_use]` because dropping this on the floor at an enforcement seam is a
/// silent allow — the one mistake this whole module exists to make impossible.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Denied,
    Allowed,
}

impl Decision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }
}

/// Resolve one permission for one principal against one resource. Pure: the
/// answer is a function of these five arguments and nothing else.
pub fn resolve(
    registry: &PermissionRegistry,
    catalog: &RoleCatalog,
    principal: &Principal,
    acl: &ResourceAcl,
    permission: &str,
) -> Decision {
    if !registry.is_declared(permission) {
        return Decision::Denied;
    }

    for tier in TIERS_MOST_SPECIFIC_FIRST {
        let (allow, deny) = tier_sets(registry, principal, acl, tier);
        if deny.contains(permission) {
            return Decision::Denied;
        }
        if allow.contains(permission) {
            return Decision::Allowed;
        }
    }

    if base_permissions(registry, catalog, principal).contains(permission) {
        Decision::Allowed
    } else {
        Decision::Denied
    }
}

/// Every permission the principal effectively holds on the resource. Equivalent
/// to calling [`resolve`] for each declared id, and asserted to stay that way.
pub fn effective_permissions(
    registry: &PermissionRegistry,
    catalog: &RoleCatalog,
    principal: &Principal,
    acl: &ResourceAcl,
) -> BTreeSet<String> {
    registry
        .declared()
        .filter(|id| resolve(registry, catalog, principal, acl, id).is_allowed())
        .map(str::to_string)
        .collect()
}

/// The implication-expanded allow/deny sets contributed by one tier, counting
/// only overwrites aimed at this principal.
fn tier_sets(
    registry: &PermissionRegistry,
    principal: &Principal,
    acl: &ResourceAcl,
    tier: Tier,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut allow_seeds: Vec<&str> = Vec::new();
    let mut deny_seeds: Vec<&str> = Vec::new();
    for overwrite in &acl.overwrites {
        if overwrite.target.tier() != tier || !overwrite.target.matches(principal) {
            continue;
        }
        allow_seeds.extend(overwrite.allow.iter().map(String::as_str));
        deny_seeds.extend(overwrite.deny.iter().map(String::as_str));
    }
    (
        registry.grant_closure(allow_seeds),
        registry.denial_closure(deny_seeds),
    )
}

/// The principal's role-derived floor, implication-expanded.
fn base_permissions(
    registry: &PermissionRegistry,
    catalog: &RoleCatalog,
    principal: &Principal,
) -> BTreeSet<String> {
    let seeds: Vec<&str> = principal
        .role_ids
        .iter()
        .filter_map(|role_id| catalog.base_for(role_id))
        .flat_map(|base| base.iter().map(String::as_str))
        .collect();
    registry.grant_closure(seeds)
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ: &str = "space.read";
    const WRITE: &str = "space.write";
    const DELETE: &str = "space.delete";

    /// `delete -> write -> read`, so every test exercises a TRANSITIVE chain
    /// rather than a single edge — a resolver that only expands one hop passes
    /// the two-id version of these tests and fails here.
    fn registry() -> PermissionRegistry {
        PermissionRegistry::new([READ, WRITE, DELETE])
            .with_implication(WRITE, READ)
            .with_implication(DELETE, WRITE)
    }

    fn catalog() -> RoleCatalog {
        RoleCatalog::new()
            .with_role("editor", [WRITE])
            .with_role("viewer", [READ])
    }

    fn principal(roles: &[&str]) -> Principal {
        Principal {
            user_id: "user_1".into(),
            org_id: Some("org_1".into()),
            team_ids: ["team_1".to_string()].into_iter().collect(),
            role_ids: roles.iter().map(|r| (*r).to_string()).collect(),
        }
    }

    fn decide(principal: &Principal, acl: &ResourceAcl, permission: &str) -> Decision {
        resolve(&registry(), &catalog(), principal, acl, permission)
    }

    #[test]
    fn deny_beats_allow_on_the_same_target() {
        // A single overwrite that both allows and denies is a misconfiguration;
        // it must land on the safe side rather than on whichever set is read last.
        let acl = ResourceAcl::new().with(
            Overwrite::new(OverwriteTarget::Member("user_1".into()))
                .allowing([WRITE])
                .denying([WRITE]),
        );
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Denied
        );
    }

    #[test]
    fn deny_beats_allow_across_two_overwrites_at_the_same_tier() {
        // Two roles the principal holds disagree. Same rule, but the sets arrive
        // from different overwrites, which is the case a per-overwrite short
        // circuit gets wrong.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).allowing([WRITE]))
            .with(Overwrite::new(OverwriteTarget::Role("auditor".into())).denying([WRITE]));
        let mut who = principal(&["editor"]);
        who.role_ids.insert("auditor".into());
        assert_eq!(decide(&who, &acl, WRITE), Decision::Denied);
    }

    #[test]
    fn member_overwrite_beats_role_overwrite() {
        // The surprising direction: a member ALLOW survives a role DENY, because
        // specificity outranks polarity. Without this, per-person exceptions are
        // inexpressible.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).denying([WRITE]))
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([WRITE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Allowed
        );
    }

    #[test]
    fn role_overwrite_beats_team_overwrite() {
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Team("team_1".into())).denying([WRITE]))
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).allowing([WRITE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Allowed
        );
    }

    #[test]
    fn team_overwrite_beats_org_overwrite() {
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Org("org_1".into())).denying([WRITE]))
            .with(Overwrite::new(OverwriteTarget::Team("team_1".into())).allowing([WRITE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Allowed
        );
    }

    #[test]
    fn a_less_specific_deny_still_applies_when_no_higher_tier_mentions_it() {
        // Specificity only outranks polarity where the tiers actually collide; an
        // org deny is otherwise fully in force, base grant or not.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Org("org_1".into())).denying([WRITE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Denied
        );
    }

    #[test]
    fn a_member_allow_of_a_wider_id_overturns_an_org_deny_of_the_narrower_one() {
        // The member allow of DELETE expands to {delete, write, read}, so all
        // three are settled at the member tier and the org deny of WRITE is never
        // consulted — the two-way expansion and the tier walk composing.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Org("org_1".into())).denying([WRITE]))
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([DELETE]));
        let roleless = principal(&[]);
        assert_eq!(decide(&roleless, &acl, WRITE), Decision::Allowed);
        assert_eq!(decide(&roleless, &acl, READ), Decision::Allowed);
    }

    #[test]
    fn a_contradiction_at_one_tier_is_still_overridden_by_a_more_specific_tier() {
        // A contradictory overwrite is a floor for ITS tier only, not a terminal
        // deny — the reading of "deny wins over allow" that step 6 of the module
        // doc must not be taken to mean.
        let acl = ResourceAcl::new()
            .with(
                Overwrite::new(OverwriteTarget::Role("editor".into()))
                    .allowing([WRITE])
                    .denying([WRITE]),
            )
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([WRITE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Allowed
        );

        // …and with the member overwrite gone, the same contradiction denies.
        let role_only = ResourceAcl::new().with(
            Overwrite::new(OverwriteTarget::Role("editor".into()))
                .allowing([WRITE])
                .denying([WRITE]),
        );
        assert_eq!(
            decide(&principal(&["editor"]), &role_only, WRITE),
            Decision::Denied
        );
    }

    #[test]
    fn holding_edit_grants_implied_read() {
        // Grants travel ALONG the implication edge: the editor role lists only
        // `space.write`, yet `space.read` comes with it.
        let acl = ResourceAcl::new();
        assert_eq!(
            decide(&principal(&["editor"]), &acl, READ),
            Decision::Allowed
        );
    }

    #[test]
    fn denying_read_also_denies_the_edit_that_implies_it() {
        // Denials travel AGAINST the edge. Denying only `space.read` must take
        // `space.write` (and transitively `space.delete`) with it, or the deny is
        // trivially bypassable by asking for the wider permission instead.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).denying([READ]));
        let who = principal(&["editor"]);
        assert_eq!(decide(&who, &acl, READ), Decision::Denied);
        assert_eq!(decide(&who, &acl, WRITE), Decision::Denied);
        assert_eq!(decide(&who, &acl, DELETE), Decision::Denied);
    }

    #[test]
    fn implication_expansion_is_transitive_for_grants() {
        // One allow of the widest id must reach the far end of the chain.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([DELETE]));
        let who = principal(&[]);
        assert_eq!(decide(&who, &acl, DELETE), Decision::Allowed);
        assert_eq!(decide(&who, &acl, WRITE), Decision::Allowed);
        assert_eq!(decide(&who, &acl, READ), Decision::Allowed);
    }

    #[test]
    fn member_allow_of_edit_grants_implied_read_over_a_role_deny_of_read() {
        // The composition of both rules, and the whole reason expansion happens
        // BEFORE the tier walk: the role deny expands to {read, write, delete}
        // and the member allow expands to {write, read}, and the member tier is
        // consulted first, so both ids come back allowed.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).denying([READ]))
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([WRITE]));
        let who = principal(&["editor"]);
        assert_eq!(decide(&who, &acl, WRITE), Decision::Allowed);
        assert_eq!(decide(&who, &acl, READ), Decision::Allowed);
        // `delete` is mentioned by neither tier's expansion in the allow
        // direction, so the role deny still reaches it.
        assert_eq!(decide(&who, &acl, DELETE), Decision::Denied);
    }

    #[test]
    fn undeclared_permission_id_is_denied() {
        // A typo or a retired id must not fall through to the base, and must not
        // be grantable by an overwrite that names it either.
        let acl = ResourceAcl::new().with(
            Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing(["space.nuke"]),
        );
        assert_eq!(
            decide(&principal(&["editor"]), &acl, "space.nuke"),
            Decision::Denied
        );
    }

    #[test]
    fn a_deny_naming_an_undeclared_id_cannot_reach_a_declared_one() {
        // Otherwise anyone able to name a bogus id could revoke a real
        // permission through an implication edge.
        //
        // NOTE ON WHAT THIS PROVES: three independent mechanisms enforce this —
        // the seed filter in `closure`, the unknown-id guard at the top of
        // `resolve`, and the edge guard in `with_implication`. Verified by
        // mutation: disabling any ONE leaves this green, and only disabling all
        // three turns it red. So read this as pinning the observable CONTRACT
        // ("an undeclared id is inert"), not any single guard. The redundancy is
        // deliberate defence in depth; do not delete a guard because a test still
        // passes without it.
        let registry = PermissionRegistry::new([READ]).with_implication("space.nuke", READ);
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).denying(["space.nuke"]));
        assert_eq!(
            resolve(&registry, &catalog(), &principal(&["viewer"]), &acl, READ),
            Decision::Allowed,
            "a deny on an undeclared id must not reach READ"
        );
    }

    #[test]
    fn undeclared_ids_are_inert_in_both_polarities() {
        // The full contract for an id the registry does not declare: it can
        // neither be granted nor used as a lever. Asking about it denies, and
        // ALLOWING it grants nothing either — an overwrite naming a retired or
        // typo'd id must not quietly become a grant when that id is later added
        // back to the vocabulary.
        let registry = PermissionRegistry::new([READ]).with_implication(WRITE, READ);
        let allowing_unknown = ResourceAcl::new().with(
            Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing(["space.nuke"]),
        );
        assert_eq!(
            resolve(
                &registry,
                &catalog(),
                &principal(&["viewer"]),
                &allowing_unknown,
                "space.nuke"
            ),
            Decision::Denied,
            "an undeclared id is never granted, even when explicitly allowed"
        );
        // And it does not disturb a declared id resolved against the same ACL.
        assert_eq!(
            resolve(
                &registry,
                &catalog(),
                &principal(&["viewer"]),
                &allowing_unknown,
                READ
            ),
            Decision::Allowed
        );
    }

    #[test]
    fn empty_overwrite_set_falls_through_to_base_in_both_polarities() {
        // Both directions, or the test cannot tell fall-through apart from a
        // blanket deny.
        let acl = ResourceAcl::new();
        assert_eq!(
            decide(&principal(&["editor"]), &acl, WRITE),
            Decision::Allowed
        );
        assert_eq!(
            decide(&principal(&["viewer"]), &acl, WRITE),
            Decision::Denied
        );
    }

    #[test]
    fn a_role_the_catalog_does_not_define_grants_nothing() {
        // A stale assignment to a deleted role must not widen anything.
        let acl = ResourceAcl::new();
        assert_eq!(
            decide(&principal(&["ghost_role"]), &acl, READ),
            Decision::Denied
        );
    }

    #[test]
    fn a_principal_with_no_roles_at_all_is_denied() {
        let acl = ResourceAcl::new();
        assert_eq!(decide(&principal(&[]), &acl, READ), Decision::Denied);
    }

    #[test]
    fn a_role_base_naming_an_undeclared_id_grants_nothing() {
        let catalog = RoleCatalog::new().with_role("editor", ["space.nuke"]);
        let acl = ResourceAcl::new();
        for permission in [READ, WRITE, DELETE, "space.nuke"] {
            assert_eq!(
                resolve(
                    &registry(),
                    &catalog,
                    &principal(&["editor"]),
                    &acl,
                    permission
                ),
                Decision::Denied,
                "{permission} leaked from an undeclared base entry"
            );
        }
    }

    #[test]
    fn an_overwrite_aimed_at_someone_else_is_ignored() {
        // Target matching is per-axis: another user's member overwrite, another
        // org's, another team's and an unheld role's must all be inert.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Member("user_2".into())).allowing([DELETE]))
            .with(Overwrite::new(OverwriteTarget::Org("org_2".into())).allowing([DELETE]))
            .with(Overwrite::new(OverwriteTarget::Team("team_2".into())).allowing([DELETE]))
            .with(Overwrite::new(OverwriteTarget::Role("admin".into())).allowing([DELETE]));
        assert_eq!(
            decide(&principal(&["editor"]), &acl, DELETE),
            Decision::Denied
        );
    }

    #[test]
    fn an_org_overwrite_needs_the_principal_to_be_in_that_org() {
        // A principal with no org must not match an org-targeted overwrite.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Org("org_1".into())).allowing([DELETE]));
        let orgless = Principal {
            org_id: None,
            ..principal(&[])
        };
        assert_eq!(decide(&orgless, &acl, DELETE), Decision::Denied);
    }

    #[test]
    fn wholly_empty_input_denies_everything() {
        let registry = PermissionRegistry::default();
        let decision = resolve(
            &registry,
            &RoleCatalog::new(),
            &Principal::default(),
            &ResourceAcl::new(),
            READ,
        );
        assert_eq!(decision, Decision::Denied);
    }

    #[test]
    fn a_cyclic_implication_graph_terminates_and_stays_fail_closed() {
        // Nothing validates the graph at construction, so a cycle is reachable;
        // it must not hang the request, and a cycle must not manufacture a grant
        // for an id nobody granted.
        let registry = PermissionRegistry::new([READ, WRITE])
            .with_implication(WRITE, READ)
            .with_implication(READ, WRITE);
        let catalog = RoleCatalog::new().with_role("viewer", [READ]);
        let acl = ResourceAcl::new();
        // The cycle makes read and write mutually implied, so the viewer's read
        // legitimately reaches write — the claim under test is termination plus
        // the absence of any id outside the closure.
        assert_eq!(
            resolve(&registry, &catalog, &principal(&["viewer"]), &acl, WRITE),
            Decision::Allowed
        );
        assert_eq!(
            resolve(
                &registry,
                &catalog,
                &principal(&["viewer"]),
                &acl,
                "space.delete"
            ),
            Decision::Denied
        );
    }

    #[test]
    fn effective_permissions_agrees_with_per_id_resolution() {
        // The bulk helper is the surface a UI will render; it drifting from the
        // enforcement path is exactly the bug that shows the wrong padlock.
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("editor".into())).denying([READ]))
            .with(Overwrite::new(OverwriteTarget::Member("user_1".into())).allowing([WRITE]));
        let registry = registry();
        let catalog = catalog();
        let who = principal(&["editor"]);

        let bulk = effective_permissions(&registry, &catalog, &who, &acl);
        let per_id: BTreeSet<String> = registry
            .declared()
            .filter(|id| resolve(&registry, &catalog, &who, &acl, id).is_allowed())
            .map(str::to_string)
            .collect();
        assert_eq!(bulk, per_id);
        assert_eq!(
            bulk,
            [READ.to_string(), WRITE.to_string()].into_iter().collect()
        );
    }
}

#[cfg(test)]
mod enforcement_tests {
    use super::*;
    use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
    use std::collections::HashSet;

    fn caller(role: OrgRole, teams: &[(&str, &str)]) -> VerifiedCaller {
        VerifiedCaller {
            user_id: "u1".to_owned(),
            email: None,
            org_id: Some("org_1".to_owned()),
            role,
            teams: teams
                .iter()
                .map(|(id, org)| TeamMembership {
                    id: (*id).to_owned(),
                    org_id: (*org).to_owned(),
                    role: "member".to_owned(),
                })
                .collect(),
        }
    }

    #[test]
    fn a_callers_role_becomes_the_role_id_the_catalog_is_keyed_by() {
        // If these drift, a real caller finds no base permissions at all and
        // every org-wide grant silently evaporates.
        let catalog = vocabulary::builtin_role_catalog();
        let vocab = vocabulary::build_vocabulary(Vec::new());
        for role in [
            OrgRole::Owner,
            OrgRole::Admin,
            OrgRole::Member,
            OrgRole::Viewer,
        ] {
            let principal = principal_from_caller(&caller(role, &[]));
            let expected = crate::identity_verify::permissions::permissions_for_role(role);
            for perm in &expected {
                assert_eq!(
                    resolve(
                        &vocab.registry,
                        &catalog,
                        &principal,
                        &ResourceAcl::new(),
                        perm
                    ),
                    Decision::Allowed,
                    "{role:?} should hold {perm} with no overwrites"
                );
            }
        }
    }

    #[test]
    fn a_deny_overwrite_removes_a_permission_the_org_role_grants() {
        // THE point of the whole per-resource layer: an owner holds
        // `space.delete` org-wide, and a single resource must be able to say no.
        let owner = caller(OrgRole::Owner, &[]);
        let principal = principal_from_caller(&owner);
        let vocab = vocabulary::build_vocabulary(Vec::new());
        let catalog = vocabulary::builtin_role_catalog();
        let perm = crate::identity_verify::permissions::SPACE_DELETE;

        assert_eq!(
            resolve(
                &vocab.registry,
                &catalog,
                &principal,
                &ResourceAcl::new(),
                perm
            ),
            Decision::Allowed,
            "precondition: an owner holds space.delete org-wide"
        );

        let denied_here = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Role("owner".into())).denying([perm]));
        assert_eq!(
            resolve(&vocab.registry, &catalog, &principal, &denied_here, perm),
            Decision::Denied
        );
    }

    #[test]
    fn an_allow_overwrite_grants_a_permission_the_org_role_lacks() {
        // The other direction: a viewer gets write on ONE space without being
        // promoted org-wide. Without this the layer could only ever subtract.
        let viewer = caller(OrgRole::Viewer, &[]);
        let principal = principal_from_caller(&viewer);
        let vocab = vocabulary::build_vocabulary(Vec::new());
        let catalog = vocabulary::builtin_role_catalog();
        let perm = crate::identity_verify::permissions::SPACE_WRITE;

        assert_eq!(
            resolve(
                &vocab.registry,
                &catalog,
                &principal,
                &ResourceAcl::new(),
                perm
            ),
            Decision::Denied,
            "precondition: a viewer does not hold space.write org-wide"
        );

        let granted_here = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Member("u1".into())).allowing([perm]));
        assert_eq!(
            resolve(&vocab.registry, &catalog, &principal, &granted_here, perm),
            Decision::Allowed
        );
    }

    #[test]
    fn a_team_overwrite_reaches_only_members_of_that_team() {
        // "which team can access what" — the feature this exists for.
        let vocab = vocabulary::build_vocabulary(Vec::new());
        let catalog = vocabulary::builtin_role_catalog();
        let perm = crate::identity_verify::permissions::SPACE_WRITE;
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Team("team_a".into())).allowing([perm]));

        let in_team = principal_from_caller(&caller(OrgRole::Viewer, &[("team_a", "org_1")]));
        assert_eq!(
            resolve(&vocab.registry, &catalog, &in_team, &acl, perm),
            Decision::Allowed
        );

        let other_team = principal_from_caller(&caller(OrgRole::Viewer, &[("team_b", "org_1")]));
        assert_eq!(
            resolve(&vocab.registry, &catalog, &other_team, &acl, perm),
            Decision::Denied
        );
    }

    #[test]
    fn a_custom_role_permission_is_still_overridable_by_a_deny() {
        // A custom org role is an ORG-WIDE grant; the resource exception must
        // still win, or a custom role would be an unrevokable back door.
        let member = caller(OrgRole::Member, &[]);
        let perm = crate::identity_verify::permissions::SPACE_DELETE;
        let mut extra = HashSet::new();
        extra.insert(perm.to_owned());

        let vocab = vocabulary::build_vocabulary(Vec::new());
        let mut catalog = vocabulary::builtin_role_catalog();
        catalog = catalog.with_role("__custom_role", extra.iter().cloned());
        let mut principal = principal_from_caller(&member);
        principal.role_ids.insert("__custom_role".to_owned());

        let denied = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Member("u1".into())).denying([perm]));
        assert_eq!(
            resolve(&vocab.registry, &catalog, &principal, &denied, perm),
            Decision::Denied
        );
    }
}

// ── Enforcement seam ─────────────────────────────────────────────────────────

/// Build the [`Principal`] the resolver takes from a verified caller.
///
/// `role_ids` carries the caller's Better Auth org role. Custom org roles are
/// deliberately NOT merged in here: they are resolved per-caller by the control
/// plane and arrive as a permission SET rather than a role id, so they are handed
/// to [`decide_with_extra`] separately instead of being faked into a role.
pub fn principal_from_caller(caller: &crate::identity_verify::VerifiedCaller) -> Principal {
    Principal {
        user_id: caller.user_id.clone(),
        org_id: caller.org_id.clone(),
        // Only teams inside THIS node's org survive narrowing, so a team from
        // another org can never match an overwrite here.
        team_ids: caller.teams.iter().map(|t| t.id.clone()).collect(),
        role_ids: [ba_role_id(caller.role)].into_iter().collect(),
    }
}

/// The Better Auth role string for an [`OrgRole`], matching the ids
/// [`vocabulary::builtin_role_catalog`] is keyed by.
fn ba_role_id(role: crate::identity_verify::OrgRole) -> String {
    use crate::identity_verify::OrgRole;
    match role {
        OrgRole::Owner => "owner",
        OrgRole::Admin => "admin",
        OrgRole::Member => "member",
        OrgRole::Viewer => "viewer",
    }
    .to_owned()
}

/// Decide one permission for one caller on one resource, reading the persisted
/// overwrites. This is the single entry point routes should call.
///
/// `extra_permissions` are the custom-role permissions the control plane resolved
/// for this caller. They widen the BASE only — they can never override a deny
/// overwrite, because a custom role is an org-wide grant and the whole point of a
/// resource overwrite is to carve an exception out of exactly that.
pub fn decide_with_extra(
    caller: &crate::identity_verify::VerifiedCaller,
    kind: &str,
    resource_id: &str,
    permission: &str,
    extra_permissions: &std::collections::HashSet<String>,
) -> Decision {
    decide_with_context(
        caller,
        kind,
        resource_id,
        permission,
        extra_permissions,
        &std::collections::HashSet::new(),
    )
}

/// Decide one permission while carrying both the custom-role permission union
/// and the custom role ids assigned to this caller. The permission union is
/// what grants the capability; the ids are needed so a resource ACL can target
/// a named custom role without making the node invent a second role catalog.
pub fn decide_with_context(
    caller: &crate::identity_verify::VerifiedCaller,
    kind: &str,
    resource_id: &str,
    permission: &str,
    extra_permissions: &std::collections::HashSet<String>,
    extra_role_ids: &std::collections::HashSet<String>,
) -> Decision {
    let vocab = cached_vocabulary();
    let mut catalog = vocabulary::builtin_role_catalog();

    let principal = principal_from_caller(caller);
    if !extra_permissions.is_empty() || !extra_role_ids.is_empty() {
        // Fold the custom-role grant into a synthetic role the principal holds.
        // A reserved id that Better Auth can never issue, so it cannot collide
        // with a real role or be named by an overwrite.
        const CUSTOM: &str = "__custom_role";
        catalog = catalog.with_role(CUSTOM, extra_permissions.iter().cloned());
        let mut principal = principal;
        principal.role_ids.extend(extra_role_ids.iter().cloned());
        principal.role_ids.insert(CUSTOM.to_owned());
        let acl = store::acl_for(&store::ResourceKey::new(kind, resource_id));
        return resolve(&vocab.registry, &catalog, &principal, &acl, permission);
    }

    let acl = store::acl_for(&store::ResourceKey::new(kind, resource_id));
    resolve(&vocab.registry, &catalog, &principal, &acl, permission)
}

/// Every permission level declared by an installed app, for the registry.
pub fn declared_levels() -> Vec<vocabulary::DeclaredLevel> {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .flat_map(|manifest| {
            let plugin_id = manifest.id.clone();
            manifest
                .permission_levels
                .into_iter()
                .map(move |level| vocabulary::DeclaredLevel {
                    plugin_id: plugin_id.clone(),
                    id: level.id,
                    label: level.label,
                    description: level.description,
                    implies: level.implies,
                })
        })
        .collect()
}

/// Process-wide cache of the assembled vocabulary.
///
/// [`declared_levels`] reads every installed manifest off DISK, and
/// `decide_with_extra` runs on an authorization path that a busy node hits many
/// times per request. Rebuilding it each time turned every permission check into
/// a directory scan plus N JSON parses.
///
/// The set only changes when a plugin is installed, enabled, or removed, so it is
/// cached and invalidated explicitly by [`invalidate_vocabulary`] rather than
/// timed out — a TTL would either serve a stale vocabulary after an install or
/// re-scan for nothing.
static VOCABULARY_CACHE: std::sync::Mutex<Option<vocabulary::Vocabulary>> =
    std::sync::Mutex::new(None);

fn cached_vocabulary() -> vocabulary::Vocabulary {
    let mut guard = VOCABULARY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(|| vocabulary::build_vocabulary(declared_levels()))
        .clone()
}

/// Drop the cached vocabulary. MUST be called whenever the installed plugin set
/// changes, or an app's newly-declared levels stay unknown until restart and
/// every grant naming one is rejected as an unknown permission.
pub fn invalidate_vocabulary() {
    let mut guard = VOCABULARY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}
