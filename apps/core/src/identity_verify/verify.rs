//! Offline JWT verification and narrowing claims to the node's org.

use super::*;

// ── JWT verification ─────────────────────────────────────────────────────────

/// Raw JWT payload shape. Better Auth's `definePayload` embeds `id`, `email`,
/// `email_verified`, `orgs: [{ id, role }]` and `teams: [{ id, org, role }]`;
/// `sub` is the standard subject fallback.
#[derive(Debug, Deserialize)]
pub(super) struct RawClaims {
    #[serde(default)]
    pub(super) id: Option<String>,
    #[serde(default)]
    pub(super) sub: Option<String>,
    #[serde(default)]
    pub(super) email: Option<String>,
    /// OIDC-style mailbox proof for `email`. Only a JSON `true` counts; any other
    /// value decodes as unverified instead of rejecting the whole token, and an
    /// absent claim (tokens minted before it existed) is unverified too.
    #[serde(default, deserialize_with = "deserialize_strict_true")]
    pub(super) email_verified: bool,
    #[serde(default)]
    pub(super) orgs: Vec<RawOrg>,
    /// Defaulted so every token minted before teams were embedded still verifies.
    #[serde(default)]
    pub(super) teams: Vec<RawTeam>,
    /// Enabled rollout flags. Lenient: a missing or malformed claim (or any
    /// non-string entry) contributes nothing instead of rejecting the token, so
    /// a minter bug can only close a flag, never sign a user out.
    #[serde(default, rename = "ryu_flags", deserialize_with = "lenient_flag_keys")]
    pub(super) ryu_flags: BTreeSet<String>,
    /// The org `ryu_flags` was evaluated for. Lenient like `ryu_flags`: anything
    /// but a non-empty string reads as "no org context".
    #[serde(
        default,
        rename = "ryu_flags_org",
        deserialize_with = "lenient_flag_org"
    )]
    pub(super) ryu_flags_org: Option<String>,
    /// Plan limits (`{ "boxConcurrency": n }`). Lenient: anything else reads as
    /// no claim, so a minter bug cannot sign a user out.
    #[serde(default, rename = "ryu_limits", deserialize_with = "lenient_limits")]
    pub(super) ryu_limits: Option<VerifiedLimits>,
    /// Required by the live-session boundary as well as the handshake validator.
    #[serde(default)]
    pub(super) exp: Option<i64>,
}

/// Decode a claim as `true` only when it is the JSON boolean `true`. A string
/// `"true"`, a number, or `null` is unverified (fail-closed) without failing the
/// token, so a malformed optional claim cannot lock a user out of Core.
pub(super) fn deserialize_strict_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(matches!(
        serde_json::Value::deserialize(deserializer)?,
        serde_json::Value::Bool(true)
    ))
}

#[derive(Debug, Deserialize)]
pub(super) struct RawOrg {
    pub(super) id: String,
    #[serde(default)]
    pub(super) role: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawTeam {
    /// Required, mirroring [`RawOrg::id`]: an entry with no id identifies no team
    /// and only the minter can produce one, so it is a payload bug, not input.
    pub(super) id: String,
    /// Defaulted so an entry missing its org degrades to an unmatchable one
    /// (`""` matches no node org) rather than being silently treated as global.
    #[serde(default)]
    pub(super) org: String,
    /// Defaulted to the empty string, which [`OrgRole::from_ba_str`] maps to
    /// `Viewer` — the least privilege, so a missing role can never widen access.
    #[serde(default)]
    pub(super) role: String,
}

/// Keep only the non-empty string entries of a flag-claim array; anything else
/// (an object, a number, `null`) reads as no flags.
pub(super) fn lenient_flag_keys<'de, D>(deserializer: D) -> Result<BTreeSet<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Array(entries) => entries
            .into_iter()
            .filter_map(|entry| match entry {
                serde_json::Value::String(key) if !key.is_empty() && key.len() <= 128 => Some(key),
                _ => None,
            })
            .collect(),
        _ => BTreeSet::new(),
    })
}

/// Keep a non-empty string org id; anything else (`null`, a number, an object,
/// an empty or oversized string) reads as no org context.
pub(super) fn lenient_flag_org<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(org) if !org.is_empty() && org.len() <= 128 => Some(org),
        _ => None,
    })
}

/// Keep a `ryu_limits` object whose `boxConcurrency` is a non-negative integer
/// that fits in `u32`; anything else (absent, `null`, a string, a negative or
/// fractional number) reads as no claim.
pub(super) fn lenient_limits<'de, D>(deserializer: D) -> Result<Option<VerifiedLimits>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .get("boxConcurrency")
        .and_then(serde_json::Value::as_u64)
        .and_then(|cap| u32::try_from(cap).ok())
        .map(|box_concurrency| VerifiedLimits { box_concurrency }))
}

/// Verify a Better Auth JWT offline and return its claims plus its validated
/// expiration timestamp (for transports that outlive the request that
/// authenticated them, such as WebSockets).
///
/// Steps (all fail-closed): decode the header and REJECT unless `alg == EdDSA`;
/// select the JWKS key by `kid` (refresh-on-unknown); then validate the
/// signature, `exp`, `iss` (== BASE_URL) and `aud` (== BASE_URL). On success the
/// `orgs` membership array is returned for org narrowing. The timestamp is taken
/// from the same validated decode, never from an untrusted payload parse.
pub async fn verify_jwt_with_expiry(token: &str) -> Result<(VerifiedClaims, i64), AuthError> {
    let header = decode_header(token).map_err(|_| AuthError::Malformed)?;
    // Defense in depth: explicit alg check rejects `none`/confusion before we
    // ever touch a key; `Validation::new(EdDSA)` rejects them again at decode.
    if header.alg != Algorithm::EdDSA {
        return Err(AuthError::UnsupportedAlg);
    }
    // An empty-string kid is as useless as a missing one — reject it before it can
    // slip through to trigger a JWKS refresh.
    let kid = header
        .kid
        .filter(|k| !k.is_empty())
        .ok_or(AuthError::MissingKid)?;
    let key = cache().decoding_key(&kid).await?;

    let base = trusted_issuer()?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[&base]);
    // NOTE (stage 3 verify): Better Auth sets `aud == BASE_URL`. If a live token
    // is ever found to omit `aud`, this audience requirement would deny it — to
    // be confirmed against a real token when middleware wiring lands.
    validation.set_audience(&[&base]);

    let decoded = decode::<RawClaims>(token, &key, &validation).map_err(map_jwt_error)?;
    let claims = decoded.claims;
    let expires_at = claims.exp.ok_or(AuthError::Expired)?;

    let user_id = claims
        .id
        .or(claims.sub)
        .filter(|s| !s.is_empty())
        .ok_or(AuthError::MissingSubject)?;

    let orgs = claims
        .orgs
        .into_iter()
        .map(|o| OrgMembership {
            id: o.id,
            role: o.role,
        })
        .collect();

    let teams = claims
        .teams
        .into_iter()
        .map(|t| TeamMembership {
            id: t.id,
            org_id: t.org,
            role: t.role,
        })
        .collect();

    Ok((
        VerifiedClaims {
            user_id,
            email: claims.email,
            email_verified: claims.email_verified,
            orgs,
            teams,
            feature_flags: claims.ryu_flags,
            feature_flags_org: claims.ryu_flags_org,
            limits: claims.ryu_limits,
        },
        expires_at,
    ))
}

/// The enabled rollout flags carried by a user JWT, with the org they were
/// evaluated for, or `None` when the token does not verify (fail closed). Used by gates that hold the request's already
/// verified raw token (`server::VerifiedUserJwt` / `ResolvedAuthorization`)
/// rather than widening [`VerifiedCaller`]; verification is offline against the
/// cached JWKS, so this re-check is cheap and also re-applies `exp`.
pub async fn verified_feature_flags(token: &str) -> Option<VerifiedFeatureFlags> {
    verify_jwt_with_expiry(token)
        .await
        .ok()
        .map(|(claims, _)| VerifiedFeatureFlags {
            keys: claims.feature_flags,
            org: claims.feature_flags_org,
        })
}

/// The signed plan limits carried by a user JWT, with the org they were
/// evaluated for. `None` when the token does not verify or carries no
/// `ryu_limits` claim. Offline against the cached JWKS, like
/// [`verified_feature_flags`].
pub async fn verified_limits(token: &str) -> Option<VerifiedPlanLimits> {
    let (claims, _) = verify_jwt_with_expiry(token).await.ok()?;
    Some(VerifiedPlanLimits {
        limits: claims.limits?,
        org: claims.feature_flags_org,
    })
}

/// Translate a `jsonwebtoken` error into an [`AuthError`], preserving the
/// specific failure where the underlying library distinguishes it.
pub(super) fn map_jwt_error(err: jsonwebtoken::errors::Error) -> AuthError {
    use jsonwebtoken::errors::ErrorKind;
    match err.kind() {
        ErrorKind::ExpiredSignature => AuthError::Expired,
        ErrorKind::InvalidIssuer => AuthError::InvalidIssuer,
        ErrorKind::InvalidAudience => AuthError::InvalidAudience,
        ErrorKind::InvalidAlgorithm | ErrorKind::InvalidAlgorithmName => AuthError::UnsupportedAlg,
        _ => AuthError::InvalidSignature,
    }
}

/// Narrow verified claims to a single node's org. Selects the membership whose
/// org matches `node_org_id`: a member yields `org_id = Some(node)` with the
/// mapped role; a non-member yields `org_id = None` and `Viewer` so an org-scoped
/// check can never match. When the node is not org-bound (`None`), the caller has
/// no org context (`org_id = None`, `Viewer`). `teams` is narrowed the same way:
/// only teams owned by the resolved org survive.
pub fn to_caller_for_org(claims: &VerifiedClaims, node_org_id: Option<&str>) -> VerifiedCaller {
    let (org_id, role) = match node_org_id {
        Some(node) => match claims.orgs.iter().find(|m| m.id == node) {
            Some(membership) => (
                Some(node.to_owned()),
                OrgRole::from_ba_str(&membership.role),
            ),
            None => (None, OrgRole::Viewer),
        },
        None => (None, OrgRole::Viewer),
    };

    // Narrow off the ALREADY-narrowed `org_id`, not `node_org_id`: a caller who is
    // not a member of the node's org resolves to `None` above and so carries no
    // teams here either, without a second membership check.
    let teams = match org_id.as_deref() {
        Some(org) => claims
            .teams
            .iter()
            .filter(|t| t.org_id == org)
            .cloned()
            .collect(),
        None => Vec::new(),
    };

    VerifiedCaller {
        user_id: claims.user_id.clone(),
        email: claims.email.clone(),
        email_verified: claims.email_verified,
        org_id,
        role,
        teams,
    }
}
