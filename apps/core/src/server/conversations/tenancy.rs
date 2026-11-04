//! Tenancy stamps and the SQL read filter shared by every list and search
//! query, so the row gate and the list gate cannot drift apart.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// The SQL twin of `resource_access` (`server/mod.rs`) — the ONE place a tenancy
/// read-filter is expressed for list/search queries, so the row gate and the list
/// gate can never drift apart.
///
///   - `:bound = 0` (node UNBOUND, anonymous caller on a trusted local peer, or an
///     in-process caller): no restriction. This is the node's single local
///     principal, identical to the pre-ACL behaviour.
///   - `:bound = 2` (node UNBOUND, verified caller or anonymous remote request):
///     untenanted legacy rows plus the rows the by-id gate grants this caller. An
///     anonymous remote request therefore sees legacy rows only, matching the
///     realtime gateway's credential-downgrade rule.
///   - A collaborator grant on a row with no org applies on both node kinds,
///     matching `can_access`.
///   - node ORG-BOUND: a row is visible iff the caller OWNS it, or it is explicitly
///     shared with the caller's org/team membership. An untenanted (NULL-owner) row
///     is therefore INVISIBLE on a bound node — matching the ACL's fail-closed
///     reading of an unattributable legacy row.
///   - node ORG-BOUND + anonymous caller (`:uid IS NULL`): nothing matches → empty.
pub(super) const TENANCY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR (:bound = 2 AND c.owner_user_id IS NULL AND c.org_id IS NULL)
        OR (:uid IS NOT NULL AND c.owner_user_id = :uid)
        OR (:uid IS NOT NULL
            AND ((:org IS NOT NULL AND c.org_id = :org)
                 OR (c.org_id IS NULL AND c.owner_user_id IS NOT NULL))
            AND EXISTS (
                SELECT 1 FROM conversation_collaborators collaborator
                WHERE collaborator.conversation_id = c.id
                  AND collaborator.user_id = :uid
            ))
        OR (:uid IS NOT NULL AND :org IS NOT NULL AND c.org_id = :org
            AND (
                c.visibility = 'org'
                OR (c.visibility = 'team' AND c.team_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM json_each(COALESCE(:teams, '[]')) AS caller_team
                        WHERE caller_team.value = c.team_id
                    ))
            ))
     )";

/// The caller context a tenancy-filtered query is evaluated against.
#[derive(Clone, Copy)]
pub(super) struct TenancyFilter<'a> {
    /// Whether THIS node is bound to an org (a shared "company brain"). Unbound →
    /// no filtering at all.
    pub(super) node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    pub(super) owner_user_id: Option<&'a str>,
    /// The caller's org (already narrowed to this node's org by `identity_verify`).
    pub(super) org_id: Option<&'a str>,
    /// JSON array of verified team ids, narrowed to the caller's node org. Kept
    /// as JSON so SQLite can evaluate membership inside the same SQL predicate.
    pub(super) team_ids_json: Option<&'a str>,
    /// On an UNBOUND node, whether this caller is narrower than the node's single
    /// local principal: a verified user (who sees legacy rows plus their own and
    /// shared ones) or an anonymous REMOTE request (legacy rows only). Ignored on
    /// a bound node.
    pub(super) restricted_when_unbound: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationCollaborator {
    pub user_id: String,
    pub role: String,
}

impl<'a> TenancyFilter<'a> {
    /// The in-process, full-trust filter: every row on the node.
    pub(super) fn unrestricted() -> Self {
        Self {
            node_bound: false,
            owner_user_id: None,
            org_id: None,
            team_ids_json: None,
            restricted_when_unbound: false,
        }
    }

    /// The filter for an HTTP caller. Mirrors `resource_access`: an anonymous
    /// request keeps the unbound node's full view only from a trusted local peer.
    pub(super) fn for_http_caller(
        node_bound: bool,
        owner_user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        team_ids_json: Option<&'a str>,
    ) -> Self {
        Self {
            node_bound,
            owner_user_id,
            org_id,
            team_ids_json,
            restricted_when_unbound: owner_user_id.is_some()
                || !crate::server::anonymous_request_is_local(),
        }
    }

    /// `:bound` for [`TENANCY_VISIBLE_PREDICATE`]: `1` bound, `0` unbound full
    /// view, `2` unbound restricted view.
    pub(super) fn bound_flag(&self) -> i64 {
        if self.node_bound {
            1
        } else if self.restricted_when_unbound {
            2
        } else {
            0
        }
    }
}

/// The tenancy a conversation row is CREATED with — the explicit, mandatory
/// principal every row-creating store call must supply.
///
/// Deliberately **not** an `Option<&str>` pair: an optional argument reads as "may
/// be omitted", and omitting it is precisely the bug this type exists to make
/// uncompilable. Stamping tenancy at a handful of handlers is what let rows born
/// on other paths (the MCP `create_thread`/`fork_thread` tools, sync replay, the
/// healing simulator) stay NULL-tenanted — and on an org-bound node a NULL-tenanted
/// row is DENIED to everyone, locking an owner out of their own chat. With this
/// type a future creation path must make a DELIBERATE choice; "silently forgot" no
/// longer compiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tenancy {
    /// Attribute the new row to this principal: an org-bound node with a verified
    /// caller, or an in-process agent tool call whose HOST conversation resolved an
    /// owner (see `sidecar::mcp::ToolPrincipal`).
    Owned {
        user_id: String,
        org_id: Option<String>,
    },
    /// Attribute a machine-created conversation to the node's organization
    /// without inventing a human owner. Channel ingress uses this for a shared
    /// bot session so every member of the org can continue the same transcript
    /// from the desktop while the bot remains the write authority.
    SharedOrg { org_id: String },
    /// No principal. This is what an UNBOUND personal node passes: there is exactly
    /// one principal and `RYU_TOKEN` is the boundary, so rows stay NULL-tenanted
    /// exactly as they did before the ACL existed (no offline lockout). It is also
    /// what a path writing into an ALREADY-EXISTING row passes — the choke point's
    /// COALESCE preserves whatever owner is already stamped.
    Unattributed,
}

impl Tenancy {
    /// The `(owner_user_id, org_id)` column pair this tenancy writes. `pub(crate)`
    /// so the Spaces / documents choke points (`spaces::upsert_document_row` /
    /// `upsert_space_row`) can reuse this ONE tenancy type rather than defining a
    /// parallel enum that could drift from the conversation plane's semantics.
    pub(crate) fn parts(&self) -> (Option<&str>, Option<&str>) {
        match self {
            Self::Owned { user_id, org_id } => (Some(user_id.as_str()), org_id.as_deref()),
            Self::SharedOrg { org_id } => (None, Some(org_id.as_str())),
            Self::Unattributed => (None, None),
        }
    }

    /// Attribute to `user_id` unless it is absent, in which case the row is
    /// unattributed. The one place `Option<VerifiedCaller>` is lowered to a
    /// `Tenancy`.
    pub fn owned_by(user_id: Option<&str>, org_id: Option<&str>) -> Self {
        match user_id {
            Some(uid) => Self::Owned {
                user_id: uid.to_owned(),
                org_id: org_id.map(str::to_owned),
            },
            None => Self::Unattributed,
        }
    }

    /// Attribute a machine-created row to an organization without a human owner.
    pub fn shared_with_org(org_id: &str) -> Self {
        Self::SharedOrg {
            org_id: org_id.to_owned(),
        }
    }

    /// Derive a `Tenancy` from the shared [`ResourceKey`] composition layer. The
    /// key's compound `node`/`project`/`session` fields are carried at the layer
    /// above and never affect this collapse: a `Tenancy` is exactly the key's
    /// `(owner_user_id, org_id)` pair, so this is byte-identical to
    /// [`Self::owned_by`] fed the same pair. This is the "constructors accept-or-
    /// derive a ResourceKey internally" seam — the choke point still calls
    /// [`Self::parts`], unchanged.
    ///
    /// Reserved adoption seam: exercised by the behavior-preserving regression test
    /// and available to the choke-point adoption wave. No production path is rewired
    /// this wave (that would churn call sites for zero behavior change), so it is
    /// `allow(dead_code)` until then.
    #[allow(dead_code)]
    pub fn from_resource_key(key: &ResourceKey) -> Self {
        let (user_id, org_id) = key.to_tenancy_parts();
        Self::owned_by(user_id, org_id)
    }

    /// Lift this `Tenancy` into the shared [`ResourceKey`] so a caller can compose
    /// the fuller address (session/project/node) on top before lowering it back.
    /// Round-trips through [`Self::parts`], so it never invents attribution.
    /// Reserved adoption seam (see [`Self::from_resource_key`]); `allow(dead_code)`
    /// until a production path adopts it.
    #[allow(dead_code)]
    pub fn to_resource_key(&self) -> ResourceKey {
        let (user_id, org_id) = self.parts();
        ResourceKey::from_tenancy_parts(user_id, org_id)
    }
}
