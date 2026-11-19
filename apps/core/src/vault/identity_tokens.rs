//! Identity tokens: vault-signed JWTs for workload identity federation.
//!
//! A caller (a human on the node bearer, or a machine holding a vault token)
//! asks for a token under a named role and receives a JWT with
//! `iss`, `sub` (`<kind>:<id>`), `aud` (the role's audience), `iat`, `nbf`,
//! `exp`, plus the claims rendered from the role's template. Relying parties
//! (cloud IAM web-identity federation, third-party APIs) verify it against
//! the public OIDC discovery document and JWKS served under
//! `<issuer>/.well-known/`, as with Vault's identity token engine.
//!
//! Signing keys use the configured `signingAlgorithm` (`ES256`, the default,
//! `RS256`, or `EdDSA`; see [`keys`]) and are PKCS#8 sealed with the keyring
//! in `vault_identity_keys`. Changing the algorithm rotates the key at once.
//! Rotation (on demand, or by the scheduler after
//! `rotationPeriodSecs`) retires the active key; a retired key stays in the
//! JWKS for [`MAX_TOKEN_TTL_SECS`] so tokens it signed keep verifying, and is
//! then pruned.
//!
//! The issuer URL is configuration (`PUT /api/vault/identity/config` or
//! `RYU_VAULT_IDENTITY_ISSUER`): it must be the externally reachable URL of
//! `/api/vault/identity` for relying parties to fetch the JWKS. Tokens are
//! refused until it is set.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine as _;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rcgen::KeyPair;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, sha256_hex, VaultError};
use crate::plugin_secrets::PluginSecretStore;

#[path = "identity_tokens_claims.rs"]
mod claims;
#[path = "identity_tokens_keys.rs"]
mod keys;

pub use self::claims::validate_issuer;
use self::claims::{render_template, validate_role};

pub use self::keys::IdentitySigningAlgorithm;

/// Longest token lifetime; also how long a retired key stays published.
pub const MAX_TOKEN_TTL_SECS: i64 = 24 * 3600;
pub const DEFAULT_TOKEN_TTL_SECS: i64 = 3600;
const MIN_TOKEN_TTL_SECS: i64 = 60;
/// Default signing-key rotation period.
pub const DEFAULT_ROTATION_PERIOD_SECS: i64 = 7 * 24 * 3600;
const MIN_ROTATION_PERIOD_SECS: i64 = 3600;
/// Env var naming the issuer when none is configured.
pub const ENV_ISSUER: &str = "RYU_VAULT_IDENTITY_ISSUER";
const MAX_TEMPLATE_BYTES: usize = 4096;
const RESERVED_CLAIMS: [&str; 7] = ["iss", "sub", "aud", "exp", "iat", "nbf", "jti"];

/// A token role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRole {
    pub name: String,
    /// The `aud` claim (for example an AWS IAM OIDC provider client id).
    pub audience: String,
    #[serde(default = "default_ttl")]
    pub ttl_secs: i64,
    /// A JSON object template for extra claims. Placeholders:
    /// `{{identity.id}}`, `{{identity.name}}`, `{{identity.kind}}` (inside
    /// JSON strings) and `{{identity.policies}}` (a bare JSON array).
    #[serde(default)]
    pub template: Option<String>,
}

fn default_ttl() -> i64 {
    DEFAULT_TOKEN_TTL_SECS
}

/// Issuer configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityConfig {
    /// Configured issuer (`None` falls back to `RYU_VAULT_IDENTITY_ISSUER`).
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default = "default_rotation")]
    pub rotation_period_secs: i64,
    /// Algorithm of new signing keys. Omitted on a write, the stored one is
    /// kept; reads always carry it.
    #[serde(default)]
    pub signing_algorithm: Option<IdentitySigningAlgorithm>,
}

fn default_rotation() -> i64 {
    DEFAULT_ROTATION_PERIOD_SECS
}

impl Default for IdentityConfig {
    fn default() -> Self {
        Self {
            issuer: None,
            rotation_period_secs: DEFAULT_ROTATION_PERIOD_SECS,
            signing_algorithm: None,
        }
    }
}

/// Who a token is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentitySubject {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub policies: Vec<String>,
}

/// An issued token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityToken {
    pub token: String,
    pub role: String,
    pub ttl_secs: i64,
    pub expires_at: i64,
}

/// Create the identity tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_identity_keys (
             kid         TEXT PRIMARY KEY,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             x           TEXT NOT NULL,
             y           TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             retired_at  INTEGER
         );
         CREATE TABLE IF NOT EXISTS vault_identity_roles (
             name       TEXT PRIMARY KEY,
             definition TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_identity_config (
             id                   INTEGER PRIMARY KEY CHECK (id = 1),
             issuer               TEXT,
             rotation_period_secs INTEGER NOT NULL
         );",
    )
    .context("initializing identity token schema")?;
    keys::migrate_schema(conn).context("migrating identity token schema")
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn read_config(conn: &Connection) -> Result<IdentityConfig> {
    Ok(conn
        .query_row(
            "SELECT issuer, rotation_period_secs, algorithm FROM vault_identity_config WHERE id = 1",
            [],
            |row| {
                Ok(IdentityConfig {
                    issuer: row.get(0)?,
                    rotation_period_secs: row.get(1)?,
                    signing_algorithm: Some(
                        row.get::<_, Option<String>>(2)?
                            .and_then(|alg| IdentitySigningAlgorithm::parse(&alg))
                            .unwrap_or_default(),
                    ),
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

/// The algorithm new signing keys use.
fn configured_algorithm(conn: &Connection) -> Result<IdentitySigningAlgorithm> {
    Ok(read_config(conn)?.signing_algorithm.unwrap_or_default())
}

/// The issuer in effect: configured, else the env var.
fn effective_issuer(config: &IdentityConfig) -> Option<String> {
    config.issuer.clone().or_else(|| {
        std::env::var(ENV_ISSUER)
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| validate_issuer(value).is_ok())
    })
}

impl PluginSecretStore {
    /// Current issuer configuration (with the effective issuer resolved).
    pub async fn identity_config(&self) -> Result<IdentityConfig> {
        let conn = self.conn.lock().await;
        let mut config = read_config(&conn)?;
        config.issuer = effective_issuer(&config);
        Ok(config)
    }

    /// Set the issuer and rotation period.
    pub async fn identity_set_config(
        &self,
        config: &IdentityConfig,
        actor: &AuditActor,
    ) -> Result<IdentityConfig> {
        let issuer = config
            .issuer
            .as_deref()
            .map(str::trim)
            .filter(|issuer| !issuer.is_empty());
        if let Some(issuer) = issuer {
            validate_issuer(issuer)?;
        }
        if config.rotation_period_secs < MIN_ROTATION_PERIOD_SECS {
            return Err(invalid(format!(
                "rotationPeriodSecs must be at least {MIN_ROTATION_PERIOD_SECS}"
            )));
        }
        let conn = self.conn.lock().await;
        let algorithm = match config.signing_algorithm {
            Some(algorithm) => algorithm,
            None => configured_algorithm(&conn)?,
        };
        conn.execute(
            "INSERT INTO vault_identity_config (id, issuer, rotation_period_secs, algorithm)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET issuer = excluded.issuer,
                 rotation_period_secs = excluded.rotation_period_secs,
                 algorithm = excluded.algorithm",
            params![issuer, config.rotation_period_secs, algorithm.as_str()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.config", "ok").details(json!({
                "issuer": issuer, "rotationPeriodSecs": config.rotation_period_secs,
                "signingAlgorithm": algorithm.as_str(),
            })),
        );
        let mut stored = read_config(&conn)?;
        stored.issuer = effective_issuer(&stored);
        // A key of another algorithm is retired now; it stays published for
        // the verification window like any rotated key.
        let stale = self
            .active_identity_alg(&conn)?
            .is_some_and(|(_, alg)| alg != algorithm.as_str());
        if stale {
            self.rotate_identity_key_locked(&conn, algorithm, actor)?;
        } else if stored.issuer.is_some() {
            self.ensure_identity_key(&conn, algorithm)?;
        }
        Ok(stored)
    }

    pub async fn identity_put_role(&self, role: &IdentityRole, actor: &AuditActor) -> Result<()> {
        validate_role(role)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_identity_roles (name, definition, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
            params![role.name, serde_json::to_string(role)?, now_millis()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.role.put", "ok")
                .details(json!({ "role": role.name, "audience": role.audience })),
        );
        Ok(())
    }

    pub async fn identity_list_roles(&self) -> Result<Vec<IdentityRole>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT definition FROM vault_identity_roles ORDER BY name")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub async fn identity_delete_role(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM vault_identity_roles WHERE name = ?1",
            params![name],
        )? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.role.delete", "ok").details(json!({ "role": name })),
        );
        Ok(removed)
    }

    /// Sign a token for `subject` under `role_name`.
    pub async fn identity_token(
        &self,
        role_name: &str,
        subject: &IdentitySubject,
        actor: &AuditActor,
    ) -> Result<IdentityToken> {
        let conn = self.conn.lock().await;
        let definition: String = conn
            .query_row(
                "SELECT definition FROM vault_identity_roles WHERE name = ?1",
                params![role_name],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("identity role `{role_name}`")))?;
        let role: IdentityRole = serde_json::from_str(&definition)?;
        let config = read_config(&conn)?;
        let issuer = effective_issuer(&config).ok_or_else(|| {
            invalid(format!(
                "configure the identity issuer (PUT /api/vault/identity/config or {ENV_ISSUER}) first"
            ))
        })?;
        let mut claims = match &role.template {
            Some(template) => render_template(template, subject)?,
            None => Map::new(),
        };
        let now = now_millis() / 1000;
        let expires = now + role.ttl_secs;
        claims.insert("iss".into(), json!(issuer));
        claims.insert(
            "sub".into(),
            json!(format!("{}:{}", subject.kind, subject.id)),
        );
        claims.insert("aud".into(), json!(role.audience));
        claims.insert("iat".into(), json!(now));
        claims.insert("nbf".into(), json!(now));
        claims.insert("exp".into(), json!(expires));
        let key = self.active_identity_key(&conn, configured_algorithm(&conn)?)?;
        let token =
            jsonwebtoken::encode(&key.header(), &Value::Object(claims), &key.encoding_key()?)
                .map_err(|error| anyhow!("signing identity token: {error}"))?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.token", "ok").details(json!({
                "role": role_name, "subject": format!("{}:{}", subject.kind, subject.id),
                "kid": key.kid, "alg": key.alg.as_str(), "expiresAt": expires * 1000,
            })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(IdentityToken {
            token,
            role: role_name.to_owned(),
            ttl_secs: role.ttl_secs,
            expires_at: expires * 1000,
        })
    }

    /// Retire the active signing key and create a new one. Returns the new kid.
    pub async fn identity_rotate_key(&self, actor: &AuditActor) -> Result<String> {
        let conn = self.conn.lock().await;
        let algorithm = configured_algorithm(&conn)?;
        self.rotate_identity_key_locked(&conn, algorithm, actor)
    }

    fn rotate_identity_key_locked(
        &self,
        conn: &Connection,
        algorithm: IdentitySigningAlgorithm,
        actor: &AuditActor,
    ) -> Result<String> {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE vault_identity_keys SET retired_at = ?1 WHERE retired_at IS NULL",
            params![now_millis()],
        )?;
        let key = self.insert_identity_key(&tx, algorithm)?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "identity.key.rotate", "ok")
                .details(json!({ "kid": key.kid, "alg": algorithm.as_str() })),
        );
        tx.commit()?;
        self.flush_audit(conn);
        Ok(key.kid)
    }

    /// The public JWKS: the active key plus retired keys still inside the
    /// verification window.
    pub async fn identity_jwks(&self) -> Result<Value> {
        let cutoff = now_millis() - MAX_TOKEN_TTL_SECS * 1000;
        let conn = self.conn.lock().await;
        // An issuer configured only through the environment never passes
        // through `identity_set_config`; publish its key before first use.
        // Best effort: a sealed vault still serves the keys it already has.
        let config = read_config(&conn)?;
        if effective_issuer(&config).is_some() {
            if let Err(error) = self.ensure_identity_key(&conn, configured_algorithm(&conn)?) {
                tracing::warn!(%error, "could not create the identity signing key for the JWKS");
            }
        }
        let mut stmt = conn.prepare(
            "SELECT kid, x, y, alg, jwk FROM vault_identity_keys
             WHERE retired_at IS NULL OR retired_at > ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let keys = stmt
            .query_map(params![cutoff], |row| {
                Ok(keys::published_jwk(
                    row.get(0)?,
                    &row.get::<_, String>(3)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({ "keys": keys }))
    }

    /// The OIDC discovery document, or `None` without an issuer. It lists
    /// the configured algorithm and any still published from earlier keys.
    pub async fn identity_discovery(&self) -> Result<Option<Value>> {
        let config = self.identity_config().await?;
        let Some(issuer) = config.issuer else {
            return Ok(None);
        };
        let mut algorithms = vec![config
            .signing_algorithm
            .unwrap_or_default()
            .as_str()
            .to_owned()];
        for key in self.identity_jwks().await?["keys"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(alg) = key["alg"]
                .as_str()
                .filter(|alg| !algorithms.iter().any(|a| a == alg))
            {
                algorithms.push(alg.to_owned());
            }
        }
        Ok(Some(json!({
            "issuer": issuer,
            "jwks_uri": format!("{issuer}/.well-known/keys"),
            "response_types_supported": ["id_token"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": algorithms,
            "scopes_supported": ["openid"],
        })))
    }

    /// Scheduler step: rotate an active key older than the rotation period
    /// (only once keys exist) and prune retired keys past the verification
    /// window. Returns `(rotated, pruned)`.
    pub async fn identity_maintain(&self) -> Result<(bool, usize)> {
        let now = now_millis();
        let due = {
            let conn = self.conn.lock().await;
            let period = read_config(&conn)?.rotation_period_secs;
            let newest: Option<i64> = conn.query_row(
                "SELECT MAX(created_at) FROM vault_identity_keys WHERE retired_at IS NULL",
                [],
                |row| row.get(0),
            )?;
            newest.is_some_and(|created| created + period * 1000 <= now)
        };
        if due {
            self.identity_rotate_key(&AuditActor::system()).await?;
        }
        let conn = self.conn.lock().await;
        let pruned = conn.execute(
            "DELETE FROM vault_identity_keys
             WHERE retired_at IS NOT NULL AND retired_at <= ?1",
            params![now - MAX_TOKEN_TTL_SECS * 1000],
        )?;
        Ok((due, pruned))
    }
}

#[cfg(test)]
#[path = "identity_tokens_tests.rs"]
mod tests;
