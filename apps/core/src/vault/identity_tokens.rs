//! Identity tokens: vault-signed JWTs for workload identity federation.
//!
//! A caller (a human on the node bearer, or a machine holding a vault token)
//! asks for a token under a named role and receives an ES256 JWT with
//! `iss`, `sub` (`<kind>:<id>`), `aud` (the role's audience), `iat`, `nbf`,
//! `exp`, plus the claims rendered from the role's template. Relying parties
//! (cloud IAM web-identity federation, third-party APIs) verify it against
//! the public OIDC discovery document and JWKS served under
//! `<issuer>/.well-known/`, as with Vault's identity token engine.
//!
//! Signing keys are ECDSA P-256 (PKCS#8 sealed with the keyring in
//! `vault_identity_keys`). Rotation (on demand, or by the scheduler after
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
}

fn default_rotation() -> i64 {
    DEFAULT_ROTATION_PERIOD_SECS
}

impl Default for IdentityConfig {
    fn default() -> Self {
        Self {
            issuer: None,
            rotation_period_secs: DEFAULT_ROTATION_PERIOD_SECS,
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
    .context("initializing identity token schema")
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

/// Validate an issuer URL: http(s), no query, fragment, or trailing slash.
pub fn validate_issuer(issuer: &str) -> Result<()> {
    let ok = (issuer.starts_with("https://") || issuer.starts_with("http://"))
        && issuer.len() <= 512
        && !issuer.ends_with('/')
        && !issuer.contains(['?', '#', ' '])
        && issuer
            .split("://")
            .nth(1)
            .is_some_and(|rest| !rest.is_empty());
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "issuer must be an http(s) URL without a query, fragment, or trailing slash",
        ))
    }
}

/// JSON-escape `value` for use inside a JSON string literal.
fn escape_in_string(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned());
    quoted[1..quoted.len() - 1].to_owned()
}

/// Render a role template for `subject` into a claims object.
fn render_template(template: &str, subject: &IdentitySubject) -> Result<Map<String, Value>> {
    let policies = serde_json::to_string(&subject.policies)?;
    // Single pass over the template: substituted values are never rescanned,
    // so subject attributes containing `{{` are inserted verbatim.
    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        rendered.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| invalid("template uses an unknown placeholder"))?;
        let value = match &after[..end] {
            "identity.policies" => policies.clone(),
            "identity.id" => escape_in_string(&subject.id),
            "identity.name" => escape_in_string(&subject.name),
            "identity.kind" => escape_in_string(&subject.kind),
            _ => return Err(invalid("template uses an unknown placeholder")),
        };
        rendered.push_str(&value);
        rest = &after[end + 2..];
    }
    rendered.push_str(rest);
    let value: Value = serde_json::from_str(&rendered)
        .map_err(|_| invalid("template must render to a JSON object"))?;
    let Value::Object(claims) = value else {
        return Err(invalid("template must render to a JSON object"));
    };
    if let Some(reserved) = RESERVED_CLAIMS.iter().find(|c| claims.contains_key(**c)) {
        return Err(invalid(format!(
            "template may not set the reserved claim `{reserved}`"
        )));
    }
    Ok(claims)
}

fn validate_role(role: &IdentityRole) -> Result<()> {
    if !super::transit::is_valid_key_name(&role.name) {
        return Err(invalid("role names must match ^[a-z0-9][a-z0-9_-]{0,63}$"));
    }
    let audience = role.audience.trim();
    if audience.is_empty() || audience.len() > 256 {
        return Err(invalid("audience must be 1-256 characters"));
    }
    if !(MIN_TOKEN_TTL_SECS..=MAX_TOKEN_TTL_SECS).contains(&role.ttl_secs) {
        return Err(invalid(format!(
            "ttlSecs must be between {MIN_TOKEN_TTL_SECS} and {MAX_TOKEN_TTL_SECS}"
        )));
    }
    if let Some(template) = &role.template {
        if template.len() > MAX_TEMPLATE_BYTES {
            return Err(invalid("template is too large"));
        }
        let sample = IdentitySubject {
            kind: "machine".into(),
            id: "id".into(),
            name: "name".into(),
            policies: vec!["policy".into()],
        };
        render_template(template, &sample)?;
    }
    Ok(())
}

fn read_config(conn: &Connection) -> Result<IdentityConfig> {
    Ok(conn
        .query_row(
            "SELECT issuer, rotation_period_secs FROM vault_identity_config WHERE id = 1",
            [],
            |row| {
                Ok(IdentityConfig {
                    issuer: row.get(0)?,
                    rotation_period_secs: row.get(1)?,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
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

struct SigningKey {
    kid: String,
    pkcs8: Vec<u8>,
}

impl PluginSecretStore {
    fn insert_identity_key(&self, conn: &Connection) -> Result<SigningKey> {
        let key =
            KeyPair::generate().map_err(|error| anyhow!("generating identity key: {error}"))?;
        let raw = key.public_key_raw();
        if raw.len() != 65 || raw[0] != 0x04 {
            return Err(anyhow!("unexpected identity public key encoding"));
        }
        let x = B64URL.encode(&raw[1..33]);
        let y = B64URL.encode(&raw[33..65]);
        let kid = sha256_hex(raw)[..16].to_owned();
        let pkcs8 = key.serialize_der();
        let (key_version, nonce, ciphertext) = self.seal_row(&pkcs8)?;
        conn.execute(
            "INSERT INTO vault_identity_keys (kid, nonce, ciphertext, key_version, x, y, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![kid, nonce, ciphertext, key_version, x, y, now_millis()],
        )?;
        Ok(SigningKey { kid, pkcs8 })
    }

    /// The active signing key, created on first use.
    fn active_identity_key(&self, conn: &Connection) -> Result<SigningKey> {
        let row: Option<(String, Vec<u8>, Vec<u8>, u32)> = conn
            .query_row(
                "SELECT kid, nonce, ciphertext, key_version FROM vault_identity_keys
                 WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        match row {
            Some((kid, nonce, ciphertext, key_version)) => Ok(SigningKey {
                kid,
                pkcs8: self.open_row(key_version, &nonce, &ciphertext)?,
            }),
            None => self.insert_identity_key(conn),
        }
    }

    /// Create the signing key now if none is active, so discovery and the JWKS
    /// are complete before the first token is issued.
    fn ensure_identity_key(&self, conn: &Connection) -> Result<()> {
        let active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_identity_keys WHERE retired_at IS NULL)",
            [],
            |row| row.get(0),
        )?;
        if !active {
            self.insert_identity_key(conn)?;
        }
        Ok(())
    }

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
        conn.execute(
            "INSERT INTO vault_identity_config (id, issuer, rotation_period_secs) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET issuer = excluded.issuer,
                 rotation_period_secs = excluded.rotation_period_secs",
            params![issuer, config.rotation_period_secs],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.config", "ok").details(json!({
                "issuer": issuer, "rotationPeriodSecs": config.rotation_period_secs,
            })),
        );
        let mut stored = read_config(&conn)?;
        stored.issuer = effective_issuer(&stored);
        if stored.issuer.is_some() {
            self.ensure_identity_key(&conn)?;
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
        let issuer = effective_issuer(&read_config(&conn)?).ok_or_else(|| {
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
        let key = self.active_identity_key(&conn)?;
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(key.kid.clone());
        let token = jsonwebtoken::encode(
            &header,
            &Value::Object(claims),
            &EncodingKey::from_ec_der(&key.pkcs8),
        )
        .map_err(|error| anyhow!("signing identity token: {error}"))?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "identity.token", "ok").details(json!({
                "role": role_name, "subject": format!("{}:{}", subject.kind, subject.id),
                "kid": key.kid, "expiresAt": expires * 1000,
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
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE vault_identity_keys SET retired_at = ?1 WHERE retired_at IS NULL",
            params![now_millis()],
        )?;
        let key = self.insert_identity_key(&tx)?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "identity.key.rotate", "ok").details(json!({ "kid": key.kid })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
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
        if effective_issuer(&read_config(&conn)?).is_some() {
            if let Err(error) = self.ensure_identity_key(&conn) {
                tracing::warn!(%error, "could not create the identity signing key for the JWKS");
            }
        }
        let mut stmt = conn.prepare(
            "SELECT kid, x, y FROM vault_identity_keys
             WHERE retired_at IS NULL OR retired_at > ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let keys = stmt
            .query_map(params![cutoff], |row| {
                Ok(json!({
                    "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig",
                    "kid": row.get::<_, String>(0)?,
                    "x": row.get::<_, String>(1)?,
                    "y": row.get::<_, String>(2)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({ "keys": keys }))
    }

    /// The OIDC discovery document, or `None` without an issuer.
    pub async fn identity_discovery(&self) -> Result<Option<Value>> {
        let conn = self.conn.lock().await;
        Ok(effective_issuer(&read_config(&conn)?).map(|issuer| {
            json!({
                "issuer": issuer,
                "jwks_uri": format!("{issuer}/.well-known/keys"),
                "response_types_supported": ["id_token"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["ES256"],
                "scopes_supported": ["openid"],
            })
        }))
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
mod tests {
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};

    use super::*;

    fn actor() -> AuditActor {
        AuditActor::new("user", Some("u1"))
    }

    fn subject() -> IdentitySubject {
        IdentitySubject {
            kind: "machine".into(),
            id: "mid_1".into(),
            name: "ci \"runner\"".into(),
            policies: vec!["deploy".into()],
        }
    }

    async fn configured_store() -> PluginSecretStore {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .identity_set_config(
                &IdentityConfig {
                    issuer: Some("https://node.example.com/api/vault/identity".into()),
                    ..IdentityConfig::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        store
    }

    fn verify(jwks: &Value, token: &str, audience: &str) -> Map<String, Value> {
        let kid = decode_header(token).unwrap().kid.unwrap();
        let jwk = jwks["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|key| key["kid"] == kid)
            .expect("kid is published");
        let key =
            DecodingKey::from_ec_components(jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap())
                .unwrap();
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_audience(&[audience]);
        validation.set_issuer(&["https://node.example.com/api/vault/identity"]);
        decode::<Map<String, Value>>(token, &key, &validation)
            .unwrap()
            .claims
    }

    #[tokio::test]
    async fn tokens_verify_against_the_published_jwks() {
        let store = configured_store().await;
        store
            .identity_put_role(
                &IdentityRole {
                    name: "aws".into(),
                    audience: "sts.amazonaws.com".into(),
                    ttl_secs: 900,
                    template: Some(
                        r#"{"machine": "{{identity.name}}", "policies": {{identity.policies}}}"#
                            .into(),
                    ),
                },
                &actor(),
            )
            .await
            .unwrap();
        let issued = store
            .identity_token("aws", &subject(), &actor())
            .await
            .unwrap();
        let claims = verify(
            &store.identity_jwks().await.unwrap(),
            &issued.token,
            "sts.amazonaws.com",
        );
        assert_eq!(claims["sub"], "machine:mid_1");
        assert_eq!(claims["machine"], "ci \"runner\"");
        assert_eq!(claims["policies"], json!(["deploy"]));
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            900
        );
        let discovery = store.identity_discovery().await.unwrap().unwrap();
        assert_eq!(
            discovery["jwks_uri"],
            "https://node.example.com/api/vault/identity/.well-known/keys"
        );
    }

    #[tokio::test]
    async fn jwks_is_published_before_the_first_token() {
        let store = configured_store().await;
        assert_eq!(
            store.identity_jwks().await.unwrap()["keys"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn template_values_are_substituted_once() {
        let tricky = IdentitySubject {
            kind: "machine".into(),
            id: "{{identity.kind}}".into(),
            name: "{{unknown}}".into(),
            policies: Vec::new(),
        };
        let claims = render_template(
            r#"{"id": "{{identity.id}}", "name": "{{identity.name}}"}"#,
            &tricky,
        )
        .unwrap();
        assert_eq!(claims["id"], "{{identity.kind}}");
        assert_eq!(claims["name"], "{{unknown}}");
        assert!(render_template(r#"{"x": "{{identity.id"}"#, &tricky).is_err());
    }

    #[tokio::test]
    async fn rotation_keeps_old_tokens_verifiable_and_prunes_later() {
        let store = configured_store().await;
        store
            .identity_put_role(
                &IdentityRole {
                    name: "gcp".into(),
                    audience: "gcp".into(),
                    ttl_secs: 600,
                    template: None,
                },
                &actor(),
            )
            .await
            .unwrap();
        let old = store
            .identity_token("gcp", &subject(), &actor())
            .await
            .unwrap();
        let new_kid = store.identity_rotate_key(&actor()).await.unwrap();
        let jwks = store.identity_jwks().await.unwrap();
        assert_eq!(jwks["keys"].as_array().unwrap().len(), 2);
        verify(&jwks, &old.token, "gcp");
        let fresh = store
            .identity_token("gcp", &subject(), &actor())
            .await
            .unwrap();
        assert_eq!(
            decode_header(&fresh.token).unwrap().kid.as_deref(),
            Some(new_kid.as_str())
        );
        // Not due yet; nothing pruned inside the window.
        assert_eq!(store.identity_maintain().await.unwrap(), (false, 0));
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_identity_keys SET retired_at = retired_at - ?1
                 WHERE retired_at IS NOT NULL",
                params![MAX_TOKEN_TTL_SECS * 1000 + 1],
            )
            .unwrap();
        }
        assert_eq!(store.identity_maintain().await.unwrap(), (false, 1));
        assert_eq!(
            store.identity_jwks().await.unwrap()["keys"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn roles_and_config_are_validated() {
        let store = PluginSecretStore::in_memory().unwrap();
        let role = |template: &str| IdentityRole {
            name: "r".into(),
            audience: "a".into(),
            ttl_secs: 300,
            template: Some(template.into()),
        };
        assert!(store
            .identity_put_role(&role(r#"{"sub": "x"}"#), &actor())
            .await
            .is_err());
        assert!(store
            .identity_put_role(&role(r#"{"x": "{{identity.secret}}"}"#), &actor())
            .await
            .is_err());
        assert!(store
            .identity_put_role(&role(r#"["not", "an", "object"]"#), &actor())
            .await
            .is_err());
        assert!(store
            .identity_put_role(
                &IdentityRole {
                    ttl_secs: MAX_TOKEN_TTL_SECS + 1,
                    ..role("{}")
                },
                &actor()
            )
            .await
            .is_err());
        store
            .identity_put_role(&role("{}"), &actor())
            .await
            .unwrap();
        // No issuer: tokens are refused and discovery is absent.
        if std::env::var(ENV_ISSUER).is_err() {
            assert!(store
                .identity_token("r", &subject(), &actor())
                .await
                .is_err());
            assert!(store.identity_discovery().await.unwrap().is_none());
        }
        for bad in [
            "ftp://x",
            "https://x/",
            "https://x?y",
            "https://",
            "node.example.com",
        ] {
            assert!(
                store
                    .identity_set_config(
                        &IdentityConfig {
                            issuer: Some(bad.into()),
                            ..IdentityConfig::default()
                        },
                        &actor()
                    )
                    .await
                    .is_err(),
                "{bad}"
            );
        }
        assert!(store
            .identity_token("missing", &subject(), &actor())
            .await
            .is_err());
    }
}
