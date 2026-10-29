//! Verification for short-lived, exact-node delegations issued by the control plane.
//!
//! Hosted OAuth and account tokens stop at the hosted resource. Core accepts only
//! this downscoped Ed25519 credential, signed by the key delivered over the
//! authenticated managed-node registration channel.

use base64::{engine::general_purpose, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use super::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RequestBindings,
};

const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_DELEGATION_LIFETIME_SECONDS: u64 = 60;
const MAX_NODE_LIST_LIFETIME_SECONDS: u64 = 12 * 60;
const CLOCK_SKEW_SECONDS: u64 = 5;
const AUDIENCE_PREFIX: &str = "urn:ryu:node:";
/// Client id the control plane signs into the node-list delegation it mints for
/// a member's own signed-in session (`GET /nodes`, used by Desktop and the CLI
/// for managed nodes). Its scopes are derived from that member's organization
/// role, or narrowed to sandbox status reads. A hosted OAuth or MCP client's
/// delegation carries that client's own id and only the scopes its user
/// consented to.
pub(crate) const NODE_LIST_CLIENT_ID: &str = "ryu-control-plane:nodes";

#[derive(Debug, Deserialize, Serialize)]
struct Header {
    alg: String,
    kid: String,
    #[serde(default)]
    typ: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Claims {
    agent_id: String,
    aud: String,
    client_id: String,
    exp: u64,
    iat: u64,
    iss: String,
    jti: String,
    nbf: u64,
    node_id: String,
    org_id: String,
    org_role: String,
    scope: String,
    sub: String,
    #[serde(default)]
    team_id: Option<String>,
}

/// Trusted facts recovered from one verified delegation.
pub struct VerifiedDelegation {
    pub context: AuthorizationContext,
    pub bindings: RequestBindings,
    pub caller: crate::identity_verify::VerifiedCaller,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegationError {
    MissingNodeRegistration,
    MissingVerificationKey,
    Malformed,
    UnsupportedAlgorithm,
    InvalidSignature,
    InvalidIssuer,
    InvalidAudience,
    InvalidNodeBinding,
    InvalidTimeWindow,
    InvalidScope,
}

/// Verify an Ed25519 delegation and bind it to this registered node.
pub fn verify(token: &str, now: u64) -> Result<VerifiedDelegation, DelegationError> {
    let node = crate::sidecar::control_plane::registered_node()
        .ok_or(DelegationError::MissingNodeRegistration)?;
    let public_key = crate::sidecar::control_plane::registered_delegation_key()
        .ok_or(DelegationError::MissingVerificationKey)?;
    verify_for_node(
        token,
        now,
        &node.node_id,
        &node.org.id,
        node.team_id.as_deref(),
        &public_key,
        &expected_issuer(),
    )
}

fn verify_for_node(
    token: &str,
    now: u64,
    expected_node_id: &str,
    expected_org_id: &str,
    expected_team_id: Option<&str>,
    public_key: &str,
    issuer: &str,
) -> Result<VerifiedDelegation, DelegationError> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(DelegationError::Malformed);
    }
    let mut segments = token.split('.');
    let header_segment = segments.next().ok_or(DelegationError::Malformed)?;
    let claims_segment = segments.next().ok_or(DelegationError::Malformed)?;
    let signature_segment = segments.next().ok_or(DelegationError::Malformed)?;
    if segments.next().is_some() {
        return Err(DelegationError::Malformed);
    }

    let header: Header = decode_json_segment(header_segment)?;
    if header.alg != "EdDSA" {
        return Err(DelegationError::UnsupportedAlgorithm);
    }
    if header.kid.trim().is_empty() || header.typ.as_deref().is_some_and(|typ| typ != "JWT") {
        return Err(DelegationError::Malformed);
    }

    let key_bytes = general_purpose::STANDARD
        .decode(public_key)
        .map_err(|_| DelegationError::Malformed)?;
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| DelegationError::Malformed)?;
    let verifying_key =
        VerifyingKey::from_bytes(&key_bytes).map_err(|_| DelegationError::Malformed)?;
    let signature_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(signature_segment)
        .map_err(|_| DelegationError::Malformed)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| DelegationError::Malformed)?;
    verifying_key
        .verify(
            format!("{header_segment}.{claims_segment}").as_bytes(),
            &signature,
        )
        .map_err(|_| DelegationError::InvalidSignature)?;

    let claims: Claims = decode_json_segment(claims_segment)?;
    validate_times(&claims, now)?;
    if normalize_origin(&claims.iss) != normalize_origin(issuer) {
        return Err(DelegationError::InvalidIssuer);
    }

    if claims.aud != format!("{AUDIENCE_PREFIX}{expected_node_id}") {
        return Err(DelegationError::InvalidAudience);
    }
    if claims.node_id != expected_node_id
        || claims.org_id != expected_org_id
        || claims.team_id.as_deref() != expected_team_id
    {
        return Err(DelegationError::InvalidNodeBinding);
    }
    if claims.sub.trim().is_empty()
        || claims.client_id.trim().is_empty()
        || claims.jti.trim().is_empty()
        || claims.agent_id.trim().is_empty()
    {
        return Err(DelegationError::Malformed);
    }

    let capabilities = parse_capabilities(&claims.scope)?;
    let constraints = GrantConstraints {
        subject_id: Some(claims.sub.clone()),
        client_id: Some(claims.client_id.clone()),
        agent_id: Some(claims.agent_id.clone()),
        node_id: Some(claims.node_id.clone()),
        org_id: Some(claims.org_id.clone()),
        team_id: claims.team_id.clone(),
        ..GrantConstraints::default()
    };
    let bindings = RequestBindings {
        subject_id: Some(claims.sub.clone()),
        client_id: Some(claims.client_id.clone()),
        agent_id: Some(claims.agent_id.clone()),
        node_id: Some(claims.node_id.clone()),
        org_id: Some(claims.org_id.clone()),
        team_id: claims.team_id.clone(),
        ..RequestBindings::default()
    };
    let teams = claims
        .team_id
        .clone()
        .map(|id| crate::identity_verify::TeamMembership {
            id,
            org_id: claims.org_id.clone(),
            role: "member".to_owned(),
        })
        .into_iter()
        .collect();
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: claims.sub.clone(),
        email: None,
        email_verified: false,
        org_id: Some(claims.org_id.clone()),
        role: crate::identity_verify::OrgRole::from_ba_str(&claims.org_role),
        teams,
    };
    Ok(VerifiedDelegation {
        context: AuthorizationContext {
            credential: CredentialKind::ManagedDelegation,
            principal: Principal::User {
                subject_id: claims.sub,
            },
            capabilities,
            constraints,
            issued_at: claims.iat,
            expires_at: Some(claims.exp),
        },
        bindings,
        caller,
    })
}

fn decode_json_segment<T: for<'de> Deserialize<'de>>(segment: &str) -> Result<T, DelegationError> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| DelegationError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| DelegationError::Malformed)
}

fn validate_times(claims: &Claims, now: u64) -> Result<(), DelegationError> {
    let lifetime = claims
        .exp
        .checked_sub(claims.iat)
        .ok_or(DelegationError::InvalidTimeWindow)?;
    let max_lifetime = if claims.client_id == NODE_LIST_CLIENT_ID {
        MAX_NODE_LIST_LIFETIME_SECONDS
    } else {
        MAX_DELEGATION_LIFETIME_SECONDS
    };
    if lifetime == 0
        || lifetime > max_lifetime
        || now >= claims.exp
        || claims.nbf > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.iat > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.nbf > claims.iat
    {
        return Err(DelegationError::InvalidTimeWindow);
    }
    Ok(())
}

fn parse_capabilities(scope: &str) -> Result<CapabilitySet, DelegationError> {
    let capabilities = scope
        .split_ascii_whitespace()
        .map(str::parse::<Capability>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| DelegationError::InvalidScope)?;
    Ok(CapabilitySet::new(capabilities))
}

fn normalize_origin(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn expected_issuer() -> String {
    normalize_origin(
        &std::env::var("RYU_CONTROL_PLANE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3000".to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn claims() -> Claims {
        Claims {
            agent_id: "ryu".to_owned(),
            aud: "urn:ryu:node:n1".to_owned(),
            client_id: "client".to_owned(),
            exp: 146,
            iat: 100,
            iss: "https://ryu.example".to_owned(),
            jti: "jti".to_owned(),
            nbf: 98,
            node_id: "n1".to_owned(),
            org_id: "o1".to_owned(),
            org_role: "member".to_owned(),
            scope: "tools:exec".to_owned(),
            sub: "u1".to_owned(),
            team_id: None,
        }
    }

    fn signed_token(claims: &Claims) -> (String, String) {
        let signing_key = SigningKey::from_bytes(&[0x52; 32]);
        let header = Header {
            alg: "EdDSA".to_owned(),
            kid: "fleet:v1".to_owned(),
            typ: Some("JWT".to_owned()),
        };
        let header = general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&header).expect("header serializes"));
        let payload = general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(claims).expect("claims serialize"));
        let signing_input = format!("{header}.{payload}");
        let signature = signing_key.sign(signing_input.as_bytes());
        let token = format!(
            "{signing_input}.{}",
            general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        let public_key = general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
        (token, public_key)
    }

    #[test]
    fn delegation_lifetime_is_strictly_bounded() {
        let claims = claims();
        assert!(validate_times(&claims, 101).is_ok());
        assert_eq!(
            validate_times(&Claims { exp: 161, ..claims }, 101),
            Err(DelegationError::InvalidTimeWindow)
        );
    }

    #[test]
    fn node_list_delegation_has_a_separate_refresh_window() {
        let mut claims = claims();
        claims.client_id = "ryu-control-plane:nodes".to_owned();
        claims.exp = claims.iat + MAX_NODE_LIST_LIFETIME_SECONDS;
        assert!(validate_times(&claims, 101).is_ok());
        claims.exp += 1;
        assert_eq!(
            validate_times(&claims, 101),
            Err(DelegationError::InvalidTimeWindow)
        );
    }

    #[test]
    fn unknown_scopes_fail_closed() {
        assert_eq!(
            parse_capabilities("tools:exec owner:all"),
            Err(DelegationError::InvalidScope)
        );
    }

    #[test]
    fn issuer_normalization_only_removes_boundary_slashes() {
        assert_eq!(
            normalize_origin(" https://ryu.example/ "),
            "https://ryu.example"
        );
        assert_ne!(
            normalize_origin("https://evil.example"),
            "https://ryu.example"
        );
    }

    #[test]
    fn exact_node_audience_is_required() {
        let claims = claims();
        let (token, public_key) = signed_token(&claims);
        assert!(verify_for_node(
            &token,
            101,
            "n1",
            "o1",
            None,
            &public_key,
            "https://ryu.example",
        )
        .is_ok());
        assert_eq!(
            verify_for_node(
                &token,
                101,
                "n2",
                "o1",
                None,
                &public_key,
                "https://ryu.example",
            )
            .err(),
            Some(DelegationError::InvalidAudience)
        );
    }

    #[test]
    fn tampering_and_expiry_fail_closed() {
        let claims = claims();
        let (token, public_key) = signed_token(&claims);
        let signature_start = token.rfind('.').expect("signature segment") + 1;
        let replacement = if &token[signature_start..signature_start + 1] == "A" {
            "B"
        } else {
            "A"
        };
        let mut tampered = token.clone();
        tampered.replace_range(signature_start..signature_start + 1, replacement);
        assert!(verify_for_node(
            &tampered,
            101,
            "n1",
            "o1",
            None,
            &public_key,
            "https://ryu.example",
        )
        .is_err());
        assert_eq!(
            verify_for_node(
                &token,
                claims.exp,
                "n1",
                "o1",
                None,
                &public_key,
                "https://ryu.example",
            )
            .err(),
            Some(DelegationError::InvalidTimeWindow)
        );
    }
}
