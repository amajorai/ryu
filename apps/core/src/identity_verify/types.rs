//! Role ladder, verified identity types and verification errors.

use super::*;

// ── RBAC ladder (ported verbatim from packages/db control-plane.model.ts) ────

/// Organization roles, ordered most- to least-privileged. A higher role
/// inherits every capability of the roles below it. Ported from `ORG_ROLES` /
/// `ROLE_RANK` so Core and the control plane agree on the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrgRole {
    Owner,
    Admin,
    Member,
    Viewer,
}

impl OrgRole {
    /// Lower-case name, as used in `role:<name>` policy subjects.
    pub fn label(self) -> &'static str {
        match self {
            OrgRole::Owner => "owner",
            OrgRole::Admin => "admin",
            OrgRole::Member => "member",
            OrgRole::Viewer => "viewer",
        }
    }

    /// Privilege rank: owner=3 … viewer=0. Mirrors `ROLE_RANK`.
    pub fn rank(self) -> u8 {
        match self {
            OrgRole::Owner => 3,
            OrgRole::Admin => 2,
            OrgRole::Member => 1,
            OrgRole::Viewer => 0,
        }
    }

    /// Maps a Better Auth member-role string onto an [`OrgRole`]. Ports
    /// `mapBaRole`: a comma-separated multi-role takes the highest privilege
    /// present, and anything unrecognised (including the empty string) falls
    /// back to the least-privileged `Viewer` so an unknown role can never widen
    /// access (fail-closed).
    pub fn from_ba_str(ba_role: &str) -> OrgRole {
        let mut best = OrgRole::Viewer;
        for part in ba_role.split(',') {
            let normalized = part.trim().to_ascii_lowercase();
            let candidate = match normalized.as_str() {
                "owner" => Some(OrgRole::Owner),
                "admin" => Some(OrgRole::Admin),
                "member" => Some(OrgRole::Member),
                "viewer" => Some(OrgRole::Viewer),
                _ => None,
            };
            if let Some(candidate) = candidate {
                if candidate.rank() > best.rank() {
                    best = candidate;
                }
            }
        }
        best
    }

    /// Returns true when `self` is at least as privileged as `required`. Ports
    /// `roleSatisfies(role, required)`.
    pub fn satisfies(self, required: OrgRole) -> bool {
        self.rank() >= required.rank()
    }
}

// ── Verified identity types ──────────────────────────────────────────────────

/// One org membership embedded in the JWT payload (`orgs: [{ id, role }]`). The
/// `role` is the raw Better Auth role string; map it via [`OrgRole::from_ba_str`].
#[derive(Debug, Clone)]
pub struct OrgMembership {
    pub id: String,
    pub role: String,
}

/// One team membership embedded in the JWT payload (`teams: [{ id, org, role }]`).
/// Better Auth's `teamMember` row carries no role of its own, so `role` is the
/// user's role in the team's owning org — the same raw Better Auth role string as
/// [`OrgMembership::role`], mapped via [`OrgRole::from_ba_str`].
#[derive(Debug, Clone)]
pub struct TeamMembership {
    pub id: String,
    /// The org that owns this team. A team is only ever meaningful inside its
    /// org, so this is what [`to_caller_for_org`] narrows on.
    pub org_id: String,
    pub role: String,
}

/// The decoded, signature-verified claims of a Better Auth JWT. This is the raw
/// verified payload before it is narrowed to a single node's org context (see
/// [`to_caller_for_org`]).
#[derive(Debug, Clone)]
pub struct VerifiedClaims {
    /// Stable Better Auth user id (the JWT `id`/`sub`).
    pub user_id: String,
    pub email: Option<String>,
    /// Whether the issuer asserted `email_verified: true` for `email`. Anything
    /// else (an absent claim, `false`, or a non-boolean value) is `false`, so a
    /// token minted before the claim existed never counts as verified.
    pub email_verified: bool,
    /// Every org the user belongs to, as embedded by the `definePayload` hook.
    pub orgs: Vec<OrgMembership>,
    /// Every team the user belongs to, across all of their orgs. Empty for
    /// tokens minted before teams were embedded — absence means "no team
    /// memberships", never an error.
    pub teams: Vec<TeamMembership>,
    /// Rollout flags the control plane evaluated ON for this user when the token
    /// was minted (the `ryu_flags` claim: the catalog's `coreClaim` flags in
    /// `packages/auth/src/lib/feature-flags.ts`). Empty for tokens minted
    /// without it, so absence means "every flag off" — fail closed. Stale for at
    /// most the token lifetime (Better Auth's JWT default is 15 minutes).
    pub feature_flags: BTreeSet<String>,
    /// The organization `feature_flags` was evaluated for (the `ryu_flags_org`
    /// claim): the session's active org at mint, falling back to the user's
    /// earliest membership, exactly as `/subscription-status` resolves it.
    /// `None` when the evaluation had no org context (the user belongs to no
    /// org, or the token predates the claim), in which case only user-scoped
    /// audiences could have contributed to `feature_flags`.
    pub feature_flags_org: Option<String>,
    /// Plan limits the control plane signed for this user (the `ryu_limits`
    /// claim), evaluated for [`Self::feature_flags_org`]. `None` when the claim
    /// is missing or malformed: Core then falls back to the Box service's own
    /// limits, so a missing claim never refuses work by itself.
    pub limits: Option<VerifiedLimits>,
}

/// The signed `ryu_limits` claim: `{ "boxConcurrency": <u32> }`, the running
/// session-Box cap of the user's plan in the org it was evaluated for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedLimits {
    /// Most session Boxes the caller may have running at once.
    pub box_concurrency: u32,
}

/// [`VerifiedLimits`] of a verified token with the org they were evaluated for
/// (the same org as its rollout flags, `ryu_flags_org`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPlanLimits {
    pub limits: VerifiedLimits,
    pub org: Option<String>,
}

/// The rollout flags of a verified token together with the org they were
/// evaluated for. See [`VerifiedClaims::feature_flags`] and
/// [`VerifiedClaims::feature_flags_org`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerifiedFeatureFlags {
    pub keys: BTreeSet<String>,
    pub org: Option<String>,
}

/// A caller's verified identity narrowed to THIS node's org. `org_id`/`role`
/// reflect the membership matching the node's bound org: `org_id` is `None` (and
/// `role` is `Viewer`) when the user is not a member of the node's org, so an
/// org-scoped access check can never match a non-member.
#[derive(Debug, Clone)]
pub struct VerifiedCaller {
    pub user_id: String,
    /// The token's `email` claim. Fine for display and audit attribution; use
    /// [`VerifiedCaller::verified_email`] for anything that grants access by
    /// address, because an identity provider can sign in an unproven mailbox.
    pub email: Option<String>,
    /// Whether the issuer proved the caller owns `email` (see
    /// [`VerifiedClaims::email_verified`]).
    pub email_verified: bool,
    pub org_id: Option<String>,
    pub role: OrgRole,
    /// The caller's teams, narrowed to `org_id`. Teams owned by any other org are
    /// dropped, so a team id minted in a different org can never satisfy a
    /// team-scoped check on this node. Empty whenever `org_id` is `None`.
    pub teams: Vec<TeamMembership>,
}

impl VerifiedCaller {
    /// The caller's email only when the issuer marked it verified. This is the
    /// address to match against email-addressed grants (named editors, invited
    /// viewers): an unverified address is a claim, not proof of mailbox ownership.
    pub fn verified_email(&self) -> Option<&str> {
        if !self.email_verified {
            return None;
        }
        self.email
            .as_deref()
            .map(str::trim)
            .filter(|email| !email.is_empty())
    }
}

/// The access level [`can_access`] resolves for a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    None,
    Read,
    Write,
}

impl Access {
    /// Return whether this grant satisfies `required`.
    ///
    /// Keeping the ordering here avoids repeating subtly different `match`
    /// ladders at each resource gate (and makes a read-only team/org grant
    /// impossible to accidentally treat as a write).
    pub fn at_least(self, required: Self) -> bool {
        fn rank(access: Access) -> u8 {
            match access {
                Access::None => 0,
                Access::Read => 1,
                Access::Write => 2,
            }
        }

        rank(self) >= rank(required)
    }
}

/// The tenancy metadata of a shareable resource (conversation or document), loaded
/// from its row and fed verbatim into [`can_access`]. The fields mirror the
/// additive Phase 0 tenancy columns. EXISTING/legacy single-tenant rows carry
/// `owner_user_id = None` AND `org_id = None` (with `visibility = "private"`),
/// which the realtime WS gateway treats as a local-allow (full access) so the
/// single-user local-first flow is never locked out.
#[derive(Debug, Clone)]
pub struct ResourceTenancy {
    pub owner_user_id: Option<String>,
    pub org_id: Option<String>,
    pub visibility: String,
    pub team_id: Option<String>,
    pub collaborators: Vec<ResourceCollaborator>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCollaborator {
    pub user_id: String,
    pub access: Access,
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Why a JWT failed verification. Every variant means DENY; callers must treat
/// any error as "no verified identity" (anonymous), never as privileged.
#[derive(Debug)]
pub enum AuthError {
    /// The token could not be parsed (bad structure / header).
    Malformed,
    /// The token header declares a non-EdDSA algorithm (incl. `none`).
    UnsupportedAlg,
    /// The token header has no `kid`, so no JWKS key can be selected.
    MissingKid,
    /// No JWKS key matches the token's `kid`, even after a refresh.
    UnknownKid,
    /// The JWKS endpoint could not be reached.
    JwksFetch(String),
    /// The resolved JWKS URL is non-loopback but not HTTPS, so fetching it would
    /// expose key material to on-path tampering (forged-token risk). Denied.
    InsecureJwksUrl(String),
    /// The JWKS response could not be parsed into a key set.
    JwksParse(String),
    /// The token is past its `exp`.
    Expired,
    /// The `iss` claim does not equal BASE_URL.
    InvalidIssuer,
    /// The `aud` claim does not equal BASE_URL.
    InvalidAudience,
    /// The signature did not verify, or the claims were otherwise invalid.
    InvalidSignature,
    /// The token carries no usable subject (`id`/`sub`).
    MissingSubject,
    /// The only issuer this Core could use is loopback, and this Core may not
    /// trust a loopback issuer (managed, enrolled, registered, or listening
    /// beyond loopback). Every user JWT is denied until an issuer is configured.
    UntrustedIssuer(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Malformed => write!(f, "malformed token"),
            AuthError::UnsupportedAlg => {
                write!(f, "unsupported signing algorithm (EdDSA required)")
            }
            AuthError::MissingKid => write!(f, "token header missing kid"),
            AuthError::UnknownKid => write!(f, "no JWKS key matches token kid"),
            AuthError::JwksFetch(e) => write!(f, "JWKS fetch failed: {e}"),
            AuthError::InsecureJwksUrl(u) => {
                write!(
                    f,
                    "refusing to fetch JWKS over insecure (non-HTTPS) URL: {u}"
                )
            }
            AuthError::JwksParse(e) => write!(f, "JWKS parse failed: {e}"),
            AuthError::Expired => write!(f, "token expired"),
            AuthError::InvalidIssuer => write!(f, "invalid issuer"),
            AuthError::InvalidAudience => write!(f, "invalid audience"),
            AuthError::InvalidSignature => write!(f, "invalid signature or claims"),
            AuthError::MissingSubject => write!(f, "token missing subject"),
            AuthError::UntrustedIssuer(u) => {
                write!(f, "refusing untrusted identity issuer: {u}")
            }
        }
    }
}

impl std::error::Error for AuthError {}
