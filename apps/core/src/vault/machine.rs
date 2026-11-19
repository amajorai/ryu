//! Machine identities and vault tokens.
//!
//! CI jobs, services, and agents that run without a person log in with one of
//! two auth methods and receive a short-lived vault token (`rvt_…`):
//!
//! * **AppRole**: a public `roleId` plus a `secretId` issued by an admin
//!   (optionally single-use and expiring). Only SHA-256 digests of secret ids
//!   and tokens are stored.
//! * **OIDC/JWT**: a signed JWT from a trusted issuer (GitHub Actions,
//!   GitLab, Kubernetes service accounts, any OIDC provider), verified against
//!   the configured JWKS URL or PEM key, `iss`/`aud`, and bound claims.
//! * **cert**, **aws-iam**, and **kubernetes**: TLS client certificates,
//!   presigned `sts:GetCallerIdentity`, and Kubernetes `TokenReview`; see
//!   [`super::auth_methods`].
//!
//! A token carries the identity's policies (plus any bound to
//! `machine:<id>`); the HTTP layer sends it as `x-ryu-vault-token` and the
//! vault API authorizes it with [`super::policy::evaluate`] and no baseline.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::dynamic::target_guard::{RoleWriter, TargetEgress};
use super::{now_millis, random_token, sha256_hex, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Default token lifetime (1 hour).
pub const DEFAULT_TOKEN_TTL_SECS: i64 = 3600;
/// Longest token lifetime (24 hours).
pub const MAX_TOKEN_TTL_SECS: i64 = 24 * 3600;
const JWKS_CACHE: Duration = Duration::from_secs(300);
/// Minimum age of a cached JWKS before an unknown `kid` may refetch it.
const JWKS_FORCED_REFRESH_MIN: Duration = Duration::from_secs(30);

/// Auth method of a machine identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AuthMethod {
    #[serde(rename = "approle")]
    AppRole {
        /// Public role identifier (generated on create; ignored if sent).
        #[serde(default)]
        role_id: String,
    },
    #[serde(rename = "jwt")]
    Jwt(JwtConfig),
    /// TLS client certificate issued by a trusted CA ([`super::auth_methods`]).
    #[serde(rename = "cert")]
    Cert(super::auth_methods::CertAuthConfig),
    /// Presigned `sts:GetCallerIdentity` ([`super::auth_methods`]).
    #[serde(rename = "aws-iam")]
    AwsIam(super::auth_methods::AwsIamAuthConfig),
    /// Kubernetes `TokenReview` ([`super::auth_methods`]).
    #[serde(rename = "kubernetes")]
    Kubernetes(super::auth_methods::KubernetesAuthConfig),
}

/// OIDC/JWT login configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtConfig {
    /// Expected `iss`.
    pub issuer: String,
    /// JWKS endpoint, e.g. `https://token.actions.githubusercontent.com/.well-known/jwks`.
    #[serde(default)]
    pub jwks_url: Option<String>,
    /// PEM public key (RSA or EC) instead of a JWKS URL.
    #[serde(default)]
    pub public_key_pem: Option<String>,
    /// Expected `aud` (any match).
    #[serde(default)]
    pub audiences: Vec<String>,
    /// Claims that must equal one of the listed values, e.g.
    /// `{"repository": ["acme/api"], "ref": ["refs/heads/main"]}`. `*` and
    /// `**` globs follow the policy grammar.
    #[serde(default)]
    pub bound_claims: BTreeMap<String, Vec<String>>,
}

impl JwtConfig {
    fn validate(&self) -> Result<()> {
        if self.issuer.trim().is_empty() {
            bail!("issuer is required");
        }
        match (&self.jwks_url, &self.public_key_pem) {
            (Some(url), None) => {
                let parsed = url::Url::parse(url).context("jwksUrl is not a URL")?;
                if parsed.scheme() != "https" {
                    bail!("jwksUrl must be https");
                }
            }
            (None, Some(pem)) => {
                if !pem.contains("BEGIN PUBLIC KEY") && !pem.contains("BEGIN RSA PUBLIC KEY") {
                    bail!("publicKeyPem must be a PEM public key");
                }
            }
            _ => bail!("set exactly one of jwksUrl or publicKeyPem"),
        }
        if self.bound_claims.is_empty() && self.audiences.is_empty() {
            // An issuer alone (for example GitHub's) admits every workflow in
            // every repository; require something that narrows it.
            bail!("set audiences or boundClaims so the issuer alone cannot log in");
        }
        Ok(())
    }
}

/// A machine identity (no secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub id: String,
    pub name: String,
    pub auth: AuthMethod,
    pub policies: Vec<String>,
    pub token_ttl_secs: i64,
    pub disabled: bool,
    pub created_at: i64,
    pub created_by: Option<String>,
    /// Lifecycle settings for issued tokens (see [`super::tokens`]).
    pub token_config: super::tokens::TokenConfig,
}

/// A secret id's metadata (the value is shown once at creation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretIdInfo {
    pub accessor: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub uses_remaining: Option<i64>,
}

/// A freshly issued vault token (shown once).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedToken {
    pub token: String,
    pub accessor: String,
    pub identity_id: String,
    pub policies: Vec<String>,
    pub expires_at: i64,
}

/// The principal behind a live token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPrincipal {
    pub accessor: String,
    pub identity_id: String,
    pub identity_name: String,
    pub policies: Vec<String>,
    pub expires_at: i64,
}

impl TokenPrincipal {
    pub fn subject(&self) -> String {
        format!("machine:{}", self.identity_id)
    }

    pub fn actor(&self) -> AuditActor {
        AuditActor::new("machine", Some(&self.identity_id))
    }
}

/// Create the machine tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_machine_identities (
             id             TEXT PRIMARY KEY,
             name           TEXT NOT NULL UNIQUE,
             auth           TEXT NOT NULL,
             role_id        TEXT UNIQUE,
             policies       TEXT NOT NULL,
             token_ttl_secs INTEGER NOT NULL,
             disabled       INTEGER NOT NULL DEFAULT 0,
             created_at     INTEGER NOT NULL,
             created_by     TEXT
         );
         CREATE TABLE IF NOT EXISTS vault_approle_secret_ids (
             accessor       TEXT PRIMARY KEY,
             identity_id    TEXT NOT NULL,
             digest         TEXT NOT NULL UNIQUE,
             created_at     INTEGER NOT NULL,
             expires_at     INTEGER,
             uses_remaining INTEGER
         );
         CREATE TABLE IF NOT EXISTS vault_tokens (
             accessor     TEXT PRIMARY KEY,
             digest       TEXT NOT NULL UNIQUE,
             identity_id  TEXT NOT NULL,
             policies     TEXT NOT NULL,
             created_at   INTEGER NOT NULL,
             expires_at   INTEGER NOT NULL,
             last_used_at INTEGER,
             revoked_at   INTEGER
         );
         CREATE INDEX IF NOT EXISTS vault_tokens_identity ON vault_tokens (identity_id);",
    )
    .context("initializing machine identity schema")?;
    super::machine_egress::ensure_writer_column(conn)
}

fn is_valid_identity_name(name: &str) -> bool {
    super::transit::is_valid_key_name(name)
}

fn identity_from_row(row: &Row<'_>) -> rusqlite::Result<MachineIdentity> {
    let auth: String = row.get(2)?;
    let policies: String = row.get(3)?;
    Ok(MachineIdentity {
        id: row.get(0)?,
        name: row.get(1)?,
        auth: serde_json::from_str(&auth).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        policies: serde_json::from_str(&policies).unwrap_or_default(),
        token_ttl_secs: row.get(4)?,
        disabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        created_by: row.get(7)?,
        token_config: row
            .get::<_, Option<String>>(8)?
            .and_then(|config| serde_json::from_str(&config).ok())
            .unwrap_or_default(),
    })
}

/// The identity's own policies plus every unexpired `machine:<id>` binding.
pub(super) fn effective_machine_policies(
    conn: &Connection,
    identity_id: &str,
    identity_policies: &[String],
) -> Result<Vec<String>> {
    let mut policies = identity_policies.to_vec();
    let subject = format!("machine:{identity_id}");
    let now = now_millis();
    for binding in super::policy::list_bindings(conn)? {
        if binding.subject != subject || binding.expires_at.is_some_and(|at| at <= now) {
            continue;
        }
        if !policies.contains(&binding.policy) {
            policies.push(binding.policy);
        }
    }
    Ok(policies)
}

/// The live principal behind a token accessor: not revoked, not expired, its
/// parent chain live, and its identity not disabled, with the policies the
/// token may use now (a scoped child token keeps only its narrowed list).
/// Credential brokering re-checks the token that minted a broker session with
/// this, so revoking the token (or disabling its identity) stops the sessions
/// it minted, and a session never holds more than its minting token.
pub fn principal_by_accessor_locked(
    conn: &Connection,
    accessor: &str,
) -> Result<Option<TokenPrincipal>> {
    let now = now_millis();
    let row: Option<(String, String, i64, String)> = conn
        .query_row(
            "SELECT t.identity_id, i.policies, t.expires_at, i.name
             FROM vault_tokens t JOIN vault_machine_identities i ON i.id = t.identity_id
             WHERE t.accessor = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2
               AND i.disabled = 0",
            params![accessor, now],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((identity_id, policies, expires_at, identity_name)) = row else {
        return Ok(None);
    };
    let identity_policies: Vec<String> = serde_json::from_str(&policies).unwrap_or_default();
    let policies = effective_machine_policies(conn, &identity_id, &identity_policies)?;
    let Some(policies) = super::tokens::token_policies_now_locked(conn, accessor, now, policies)?
    else {
        return Ok(None);
    };
    Ok(Some(TokenPrincipal {
        accessor: accessor.to_owned(),
        identity_id,
        identity_name,
        policies,
        expires_at,
    }))
}

/// The policy documents that apply to a machine principal: exactly its
/// named policies. `principal.policies` already holds the identity's
/// policies and its live `machine:<id>` bindings, narrowed for a scoped
/// child token, so re-adding the bindings here would undo that narrowing.
pub fn principal_policies_locked(
    conn: &Connection,
    principal: &TokenPrincipal,
) -> Result<Vec<super::policy::Policy>> {
    Ok(super::policy::list_policies(conn)?
        .into_iter()
        .filter(|policy| principal.policies.contains(&policy.name))
        .collect())
}

const IDENTITY_COLUMNS: &str =
    "id, name, auth, policies, token_ttl_secs, disabled, created_at, created_by, token_config";

pub(super) fn identity_locked(conn: &Connection, id_or_name: &str) -> Result<MachineIdentity> {
    conn.query_row(
        &format!(
            "SELECT {IDENTITY_COLUMNS} FROM vault_machine_identities WHERE id = ?1 OR name = ?1"
        ),
        params![id_or_name],
        identity_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("machine identity `{id_or_name}`")).into())
}

#[path = "machine_lifecycle.rs"]
mod lifecycle;
#[path = "machine_login.rs"]
mod login;
#[path = "machine_revoke.rs"]
mod revoke;
pub use revoke::IdentityRevocation;

fn jwks_cache() -> &'static Mutex<HashMap<String, (Instant, jsonwebtoken::jwk::JwkSet)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, jsonwebtoken::jwk::JwkSet)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn jwks(url: &str, refresh: bool, egress: TargetEgress) -> Result<jsonwebtoken::jwk::JwkSet> {
    // A forced refresh (unknown `kid`) happens before the token's signature
    // is checked, so it is rate-limited per URL: unsigned junk cannot turn
    // every login attempt into an outbound JWKS request.
    let fresh_for = if refresh {
        JWKS_FORCED_REFRESH_MIN
    } else {
        JWKS_CACHE
    };
    if let Some(set) = jwks_cache().lock().ok().and_then(|guard| {
        guard
            .get(url)
            .filter(|(fetched, _)| fetched.elapsed() < fresh_for)
            .map(|(_, set)| set.clone())
    }) {
        return Ok(set);
    }
    let set = super::machine_egress::fetch_jwks(url, egress).await?;
    if let Ok(mut guard) = jwks_cache().lock() {
        guard.insert(url.to_owned(), (Instant::now(), set.clone()));
    }
    Ok(set)
}

fn claim_matches(claims: &Value, name: &str, allowed: &[String]) -> bool {
    let Some(value) = claims.get(name) else {
        return false;
    };
    let values: Vec<String> = match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        Value::Bool(flag) => vec![flag.to_string()],
        Value::Number(number) => vec![number.to_string()],
        _ => Vec::new(),
    };
    values.iter().any(|value| {
        allowed
            .iter()
            .any(|pattern| super::policy::glob_matches(pattern, value))
    })
}

/// Verify `jwt` against `config`; returns the claims.
pub async fn verify_jwt(config: &JwtConfig, jwt: &str, egress: TargetEgress) -> Result<Value> {
    use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
    let header = decode_header(jwt).map_err(|_| anyhow!("malformed JWT"))?;
    if matches!(
        header.alg,
        Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512
    ) {
        bail!("symmetric JWT algorithms are not accepted");
    }
    let key = match (&config.jwks_url, &config.public_key_pem) {
        (Some(url), _) => {
            let kid = header.kid.clone();
            let find = |set: &jsonwebtoken::jwk::JwkSet| match &kid {
                Some(kid) => set.find(kid).cloned(),
                None if set.keys.len() == 1 => set.keys.first().cloned(),
                None => None,
            };
            let jwk = match find(&jwks(url, false, egress).await?) {
                Some(jwk) => jwk,
                None => find(&jwks(url, true, egress).await?)
                    .ok_or_else(|| anyhow!("signing key not in JWKS"))?,
            };
            DecodingKey::from_jwk(&jwk)?
        }
        (None, Some(pem)) => match header.alg {
            Algorithm::ES256 | Algorithm::ES384 => DecodingKey::from_ec_pem(pem.as_bytes())?,
            Algorithm::EdDSA => DecodingKey::from_ed_pem(pem.as_bytes())?,
            _ => DecodingKey::from_rsa_pem(pem.as_bytes())?,
        },
        (None, None) => bail!("identity has no verification key"),
    };
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[config.issuer.as_str()]);
    if config.audiences.is_empty() {
        validation.validate_aud = false;
    } else {
        validation.set_audience(&config.audiences);
    }
    validation.leeway = 30;
    let claims = decode::<Value>(jwt, &key, &validation)
        .map_err(|error| anyhow!("{error}"))?
        .claims;
    for (name, allowed) in &config.bound_claims {
        if !claim_matches(&claims, name, allowed) {
            bail!("claim `{name}` is not allowed");
        }
    }
    Ok(claims)
}

#[cfg(test)]
#[path = "machine_tests.rs"]
mod tests;
