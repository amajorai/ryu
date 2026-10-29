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
    .context("initializing machine identity schema")
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

impl PluginSecretStore {
    /// Create a machine identity. For AppRole, `auth` may carry an empty
    /// `roleId`; one is generated.
    pub async fn machine_create(
        &self,
        name: &str,
        auth: AuthMethod,
        policies: Vec<String>,
        token_ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        if !is_valid_identity_name(name) {
            return Err(VaultError::Invalid("invalid machine identity name".into()).into());
        }
        let auth = match auth {
            AuthMethod::AppRole { .. } => AuthMethod::AppRole {
                role_id: random_token("role_"),
            },
            AuthMethod::Jwt(config) => {
                config
                    .validate()
                    .map_err(|error| VaultError::Invalid(error.to_string()))?;
                AuthMethod::Jwt(config)
            }
            other => {
                super::auth_methods::validate(&other)
                    .map_err(|error| VaultError::Invalid(error.to_string()))?;
                other
            }
        };
        let role_id = match &auth {
            AuthMethod::AppRole { role_id } => Some(role_id.clone()),
            _ => None,
        };
        let ttl = token_ttl_secs
            .unwrap_or(DEFAULT_TOKEN_TTL_SECS)
            .clamp(60, MAX_TOKEN_TTL_SECS);
        let id = random_token("mid_");
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_machine_identities
                 (id, name, auth, role_id, policies, token_ttl_secs, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                name,
                serde_json::to_string(&auth)?,
                role_id,
                serde_json::to_string(&policies)?,
                ttl,
                now_millis(),
                actor.id
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("machine identity `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.create", "ok")
                .details(json!({ "identity": id, "name": name })),
        );
        identity_locked(&conn, &id)
    }

    /// Every machine identity.
    pub async fn machine_list(&self) -> Result<Vec<MachineIdentity>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {IDENTITY_COLUMNS} FROM vault_machine_identities ORDER BY name"
        ))?;
        let rows = stmt.query_map([], identity_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One identity by id or name.
    pub async fn machine_get(&self, id_or_name: &str) -> Result<MachineIdentity> {
        let conn = self.conn.lock().await;
        identity_locked(&conn, id_or_name)
    }

    /// Update policies, TTL, or the disabled flag. Disabling revokes every
    /// live token for the identity.
    pub async fn machine_update(
        &self,
        id_or_name: &str,
        policies: Option<Vec<String>>,
        token_ttl_secs: Option<i64>,
        disabled: Option<bool>,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        if let Some(policies) = policies {
            conn.execute(
                "UPDATE vault_machine_identities SET policies = ?1 WHERE id = ?2",
                params![serde_json::to_string(&policies)?, identity.id],
            )?;
        }
        if let Some(ttl) = token_ttl_secs {
            conn.execute(
                "UPDATE vault_machine_identities SET token_ttl_secs = ?1 WHERE id = ?2",
                params![ttl.clamp(60, MAX_TOKEN_TTL_SECS), identity.id],
            )?;
        }
        if let Some(disabled) = disabled {
            conn.execute(
                "UPDATE vault_machine_identities SET disabled = ?1 WHERE id = ?2",
                params![disabled as i64, identity.id],
            )?;
            if disabled {
                conn.execute(
                    "UPDATE vault_tokens SET revoked_at = ?1
                     WHERE identity_id = ?2 AND revoked_at IS NULL",
                    params![now_millis(), identity.id],
                )?;
            }
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.update", "ok")
                .details(json!({ "identity": identity.id })),
        );
        identity_locked(&conn, &identity.id)
    }

    /// Delete an identity with its secret ids and tokens.
    pub async fn machine_delete(&self, id_or_name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM vault_tokens WHERE identity_id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_approle_secret_ids WHERE identity_id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_machine_identities WHERE id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_policy_bindings WHERE subject = ?1",
            params![format!("machine:{}", identity.id)],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "machine.delete", "ok")
                .details(json!({ "identity": identity.id })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(())
    }

    /// Issue an AppRole secret id. The plaintext is returned once.
    pub async fn machine_issue_secret_id(
        &self,
        id_or_name: &str,
        ttl_secs: Option<i64>,
        uses: Option<i64>,
        actor: &AuditActor,
    ) -> Result<(String, SecretIdInfo)> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        if !matches!(identity.auth, AuthMethod::AppRole { .. }) {
            return Err(VaultError::Invalid("secret ids are for AppRole identities".into()).into());
        }
        let secret = random_token("sid_");
        let info = SecretIdInfo {
            accessor: random_token("sida_"),
            created_at: now_millis(),
            expires_at: ttl_secs.map(|ttl| now_millis() + ttl.max(1) * 1000),
            uses_remaining: uses.map(|uses| uses.max(1)),
        };
        conn.execute(
            "INSERT INTO vault_approle_secret_ids
                 (accessor, identity_id, digest, created_at, expires_at, uses_remaining)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                info.accessor,
                identity.id,
                sha256_hex(secret.as_bytes()),
                info.created_at,
                info.expires_at,
                info.uses_remaining
            ],
        )?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.secret_id.create", "ok")
                .details(json!({ "identity": identity.id, "accessor": info.accessor })),
        ) {
            // Withhold the secret id and leave no usable row behind.
            conn.execute(
                "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                params![info.accessor],
            )?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok((secret, info))
    }

    /// AppRole secret ids for an identity.
    pub async fn machine_list_secret_ids(&self, id_or_name: &str) -> Result<Vec<SecretIdInfo>> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        let mut stmt = conn.prepare(
            "SELECT accessor, created_at, expires_at, uses_remaining FROM vault_approle_secret_ids
             WHERE identity_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![identity.id], |row| {
            Ok(SecretIdInfo {
                accessor: row.get(0)?,
                created_at: row.get(1)?,
                expires_at: row.get(2)?,
                uses_remaining: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Destroy one secret id.
    pub async fn machine_revoke_secret_id(&self, accessor: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
            params![accessor],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.secret_id.revoke", "ok")
                .details(json!({ "accessor": accessor })),
        );
        Ok(())
    }

    /// Issue a login token for `identity`. `token_cidrs` carries an AppRole
    /// secret id's `tokenBoundCidrs`, which replace the identity's.
    pub(super) fn issue_token_locked(
        &self,
        conn: &Connection,
        identity: &MachineIdentity,
        token_cidrs: Option<Vec<String>>,
    ) -> Result<IssuedToken> {
        let policies = effective_machine_policies(conn, &identity.id, &identity.policies)?;
        let new = super::tokens::identity_token(identity, policies, token_cidrs, now_millis());
        super::tokens::insert_token_locked(conn, &new)
    }

    /// AppRole login.
    pub async fn approle_login(&self, role_id: &str, secret_id: &str) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity: Option<MachineIdentity> = conn
            .query_row(
                &format!(
                    "SELECT {IDENTITY_COLUMNS} FROM vault_machine_identities WHERE role_id = ?1"
                ),
                params![role_id],
                identity_from_row,
            )
            .optional()?;
        let denied = |conn: &Connection, reason: &str| -> anyhow::Error {
            self.audit_locked(
                conn,
                &AuditEntry::new(
                    &AuditActor::new("machine", None),
                    "auth.approle.login",
                    "denied",
                )
                .details(json!({ "reason": reason })),
            );
            VaultError::Denied("invalid role id or secret id".into()).into()
        };
        let Some(identity) = identity.filter(|identity| !identity.disabled) else {
            return Err(denied(&conn, "unknown or disabled role"));
        };
        let now = now_millis();
        type SecretIdRow = (
            String,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
        );
        let row: Option<SecretIdRow> = conn
            .query_row(
                "SELECT accessor, expires_at, uses_remaining, cidr_list, token_bound_cidrs
                 FROM vault_approle_secret_ids WHERE identity_id = ?1 AND digest = ?2",
                params![identity.id, sha256_hex(secret_id.as_bytes())],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((accessor, expires_at, uses, cidr_list, token_cidrs)) = row else {
            return Err(denied(&conn, "secret id mismatch"));
        };
        if expires_at.is_some_and(|at| at <= now) {
            return Err(denied(&conn, "secret id expired"));
        }
        let parse = |text: Option<String>| -> Vec<String> {
            text.and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default()
        };
        let client = super::tokens::request_client_ip();
        // Address checks run before a use is consumed, so a request from the
        // wrong network cannot burn a single-use secret id.
        if !super::tokens::ip_allowed(&parse(cidr_list), client) {
            return Err(denied(
                &conn,
                "source address not allowed for this secret id",
            ));
        }
        let token_cidrs = Some(parse(token_cidrs)).filter(|cidrs| !cidrs.is_empty());
        // The identity's current boundCidrs always apply: a secret id issued
        // before an administrator narrowed them cannot keep its wider override.
        let identity_cidrs = &identity.token_config.bound_cidrs;
        if !super::tokens::ip_allowed(identity_cidrs, client) {
            return Err(denied(&conn, "source address not allowed for the identity"));
        }
        if token_cidrs
            .as_ref()
            .is_some_and(|cidrs| !super::tokens::cidrs_within(cidrs, identity_cidrs))
        {
            return Err(denied(
                &conn,
                "secret id token CIDRs are no longer inside the identity's boundCidrs",
            ));
        }
        let effective_cidrs = token_cidrs
            .clone()
            .unwrap_or_else(|| identity.token_config.bound_cidrs.clone());
        if !super::tokens::ip_allowed(&effective_cidrs, client) {
            return Err(denied(&conn, "source address not allowed for the token"));
        }
        let tx = conn.unchecked_transaction()?;
        match uses {
            Some(1) => {
                tx.execute(
                    "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                    params![accessor],
                )?;
            }
            Some(_) => {
                tx.execute(
                    "UPDATE vault_approle_secret_ids SET uses_remaining = uses_remaining - 1
                     WHERE accessor = ?1",
                    params![accessor],
                )?;
            }
            None => {}
        }
        let token = self.issue_token_locked(&tx, &identity, token_cidrs)?;
        tx.commit()?;
        // Audit after commit: inside a transaction the fail-closed verdict
        // is deferred, and the token must not leave without an accepted row.
        // A refused row leaves the secret-id use consumed.
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                "auth.approle.login",
                "ok",
            )
            .details(json!({ "tokenAccessor": token.accessor })),
        ) {
            super::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(token)
    }

    /// OIDC/JWT login against the named identity.
    pub async fn jwt_login(&self, identity_name: &str, jwt: &str) -> Result<IssuedToken> {
        // Unknown, disabled and other-method identities, and a login from
        // outside the identity's boundCidrs, are each refused (and audited,
        // with the attempted name) before the JWT is looked at.
        let identity = self
            .login_identity(identity_name, "jwt", |auth| {
                matches!(auth, AuthMethod::Jwt(_))
            })
            .await?;
        let AuthMethod::Jwt(config) = &identity.auth else {
            return Err(VaultError::Invalid("identity does not use jwt login".into()).into());
        };
        if let Err(error) = verify_jwt(config, jwt).await {
            self.audit(
                &AuditEntry::new(
                    &AuditActor::new("machine", Some(&identity.id)),
                    "auth.jwt.login",
                    "denied",
                )
                .details(json!({ "reason": error.to_string() })),
            )
            .await;
            return Err(VaultError::Denied(format!("JWT rejected: {error}")).into());
        }
        let conn = self.conn.lock().await;
        let token = self.issue_token_locked(&conn, &identity, None)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                "auth.jwt.login",
                "ok",
            )
            .details(json!({ "tokenAccessor": token.accessor })),
        ) {
            super::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(token)
    }

    /// Resolve a presented token to its principal. `None` for unknown,
    /// expired, revoked, or disabled.
    pub async fn token_lookup(&self, token: &str) -> Result<Option<TokenPrincipal>> {
        if !token.starts_with("rvt_") {
            return Ok(None);
        }
        let conn = self.conn.lock().await;
        let now = now_millis();
        // The identity's own policies come from its current row, not the
        // token: the token's stored list is only what applied at issue time.
        let row: Option<(String, String, String, i64, String, i64)> = conn
            .query_row(
                "SELECT t.accessor, t.identity_id, i.policies, t.expires_at, i.name, i.disabled
                 FROM vault_tokens t JOIN vault_machine_identities i ON i.id = t.identity_id
                 WHERE t.digest = ?1 AND t.revoked_at IS NULL",
                params![sha256_hex(token.as_bytes())],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((accessor, identity_id, policies, expires_at, identity_name, disabled)) = row
        else {
            return Ok(None);
        };
        if expires_at <= now || disabled != 0 {
            return Ok(None);
        }
        // Bindings are re-read on every use, so a temporary `machine:<id>`
        // binding stops granting access at its `expiresAt`, even to tokens
        // minted while it was live.
        let identity_policies: Vec<String> = serde_json::from_str(&policies).unwrap_or_default();
        let policies = effective_machine_policies(&conn, &identity_id, &identity_policies)?;
        // Parent chain, CIDR binding, use limit, and child-token narrowing.
        let Some(policies) = self.token_admit_locked(&conn, &accessor, now, policies)? else {
            return Ok(None);
        };
        conn.execute(
            "UPDATE vault_tokens SET last_used_at = ?1 WHERE accessor = ?2",
            params![now, accessor],
        )?;
        Ok(Some(TokenPrincipal {
            accessor,
            identity_id,
            identity_name,
            policies,
            expires_at,
        }))
    }

    /// Revoke a token by accessor, with its non-orphan descendants, their
    /// cubbyholes, and the leases they hold.
    pub async fn token_revoke(&self, accessor: &str, actor: &AuditActor) -> Result<()> {
        self.token_revoke_tree(accessor, false, actor)
            .await
            .map(|_| ())
    }

    /// Delete tokens and secret ids that expired more than a day ago.
    pub async fn machine_prune(&self) -> Result<usize> {
        let cutoff = now_millis() - 24 * 3600 * 1000;
        let conn = self.conn.lock().await;
        let tokens = conn.execute(
            "DELETE FROM vault_tokens WHERE expires_at < ?1 OR revoked_at < ?1",
            params![cutoff],
        )?;
        let secret_ids = conn.execute(
            "DELETE FROM vault_approle_secret_ids WHERE expires_at IS NOT NULL AND expires_at < ?1",
            params![cutoff],
        )?;
        Ok(tokens + secret_ids)
    }
}

fn jwks_cache() -> &'static Mutex<HashMap<String, (Instant, jsonwebtoken::jwk::JwkSet)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, jsonwebtoken::jwk::JwkSet)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn jwks(url: &str, refresh: bool) -> Result<jsonwebtoken::jwk::JwkSet> {
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
    let set: jsonwebtoken::jwk::JwkSet = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("parsing JWKS")?;
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
pub async fn verify_jwt(config: &JwtConfig, jwt: &str) -> Result<Value> {
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
            let jwk = match find(&jwks(url, false).await?) {
                Some(jwk) => jwk,
                None => find(&jwks(url, true).await?)
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
mod tests {
    use super::*;

    /// A throwaway P-256 key generated per test run, so no private key is
    /// committed to the repository.
    static TEST_KEY: std::sync::LazyLock<rcgen::KeyPair> =
        std::sync::LazyLock::new(|| rcgen::KeyPair::generate().unwrap());

    #[tokio::test]
    async fn expired_bindings_stop_granting_to_already_issued_tokens() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let identity = store
            .machine_create(
                "deploy",
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec![],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let token = {
            let conn = store.conn.lock().await;
            super::super::policy::put_policy(
                &conn,
                &super::super::policy::Policy {
                    name: "temp".into(),
                    description: String::new(),
                    rules: vec![super::super::policy::PolicyRule {
                        path: "default/**".into(),
                        capabilities: vec![super::super::policy::Capability::Read],
                        deny: false,
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
            let subject = format!("machine:{}", identity.id);
            super::super::policy::bind(&conn, "temp", &subject, Some(now_millis() + 60_000), None)
                .unwrap();
            store.issue_token_locked(&conn, &identity, None).unwrap()
        };
        assert!(token.policies.contains(&"temp".to_owned()));
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_policy_bindings SET expires_at = ?1",
                params![now_millis() - 1],
            )
            .unwrap();
        }
        let principal = store.token_lookup(&token.token).await.unwrap().unwrap();
        assert!(!principal.policies.contains(&"temp".to_owned()));
    }

    #[tokio::test]
    async fn approle_login_issues_scoped_tokens_and_honors_single_use() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let identity = store
            .machine_create(
                "ci",
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec!["ci-read".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = &identity.auth else {
            panic!("approle")
        };
        let (secret, _) = store
            .machine_issue_secret_id("ci", None, Some(1), &admin)
            .await
            .unwrap();
        assert!(store.approle_login(role_id, "sid_wrong").await.is_err());
        let token = store.approle_login(role_id, &secret).await.unwrap();
        assert_eq!(token.policies, vec!["ci-read".to_owned()]);
        // Single use: the second login with the same secret id fails.
        assert!(store.approle_login(role_id, &secret).await.is_err());
        let principal = store.token_lookup(&token.token).await.unwrap().unwrap();
        assert_eq!(principal.identity_name, "ci");
        store
            .token_revoke(&principal.accessor, &admin)
            .await
            .unwrap();
        assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn disabling_an_identity_revokes_its_tokens() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::system();
        let identity = store
            .machine_create(
                "svc",
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec![],
                None,
                &admin,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth.clone() else {
            panic!("approle")
        };
        let (secret, _) = store
            .machine_issue_secret_id("svc", Some(60), None, &admin)
            .await
            .unwrap();
        let token = store.approle_login(&role_id, &secret).await.unwrap();
        store
            .machine_update("svc", None, None, Some(true), &admin)
            .await
            .unwrap();
        assert!(store.token_lookup(&token.token).await.unwrap().is_none());
        store.machine_delete("svc", &admin).await.unwrap();
        assert!(store.machine_list().await.unwrap().is_empty());
    }

    fn sign(claims: Value) -> String {
        let key =
            jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY.serialize_pem().as_bytes()).unwrap();
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
            &claims,
            &key,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn jwt_login_checks_issuer_audience_and_bound_claims() {
        let store = PluginSecretStore::in_memory().unwrap();
        let config = JwtConfig {
            issuer: "https://token.actions.githubusercontent.com".into(),
            jwks_url: None,
            public_key_pem: Some(TEST_KEY.public_key_pem()),
            audiences: vec!["ryu".into()],
            bound_claims: BTreeMap::from([("repository".into(), vec!["acme/*".into()])]),
        };
        store
            .machine_create(
                "gha",
                AuthMethod::Jwt(config),
                vec!["deploy".into()],
                None,
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let exp = chrono::Utc::now().timestamp() + 300;
        let good = sign(json!({
            "iss": "https://token.actions.githubusercontent.com", "aud": "ryu",
            "repository": "acme/api", "exp": exp
        }));
        let token = store.jwt_login("gha", &good).await.unwrap();
        assert_eq!(token.policies, vec!["deploy".to_owned()]);
        let wrong_repo = sign(json!({
            "iss": "https://token.actions.githubusercontent.com", "aud": "ryu",
            "repository": "evil/api", "exp": exp
        }));
        assert!(store.jwt_login("gha", &wrong_repo).await.is_err());
        let wrong_aud = sign(json!({
            "iss": "https://token.actions.githubusercontent.com", "aud": "other",
            "repository": "acme/api", "exp": exp
        }));
        assert!(store.jwt_login("gha", &wrong_aud).await.is_err());
    }

    #[test]
    fn jwt_configs_must_narrow_the_issuer() {
        let config = JwtConfig {
            issuer: "https://issuer".into(),
            jwks_url: Some("https://issuer/jwks".into()),
            public_key_pem: None,
            audiences: vec![],
            bound_claims: BTreeMap::new(),
        };
        assert!(config.validate().is_err());
    }
}
