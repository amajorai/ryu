//! Static roles: Vault-managed rotation of credentials that already exist.
//!
//! A dynamic role mints a new credential per lease. A static role instead
//! owns one existing account at a target system and rotates its credential on
//! a schedule (`rotationPeriodSecs`) or on demand:
//!
//! * `postgres`: `ALTER ROLE "{{name}}" WITH PASSWORD '{{password}}'` (or the
//!   role's own rotation statements);
//! * `redis` (alias `valkey`): `ACL SETUSER <user> resetpass ><password>`;
//! * `webhook`: a signed `{action: "rotate", role, username, password}` POST
//!   (same HMAC headers as the dynamic webhook provider). The endpoint may
//!   answer `{value: "..."}` to supply the credential itself, which covers
//!   SaaS API keys that only the vendor can mint;
//! * `aws-iam`: `iam:CreateAccessKey` for the IAM user, then
//!   `iam:DeleteAccessKey` for the previous key. A key whose deletion fails
//!   stays recorded and is retried by the next rotation (before it creates a
//!   key, so AWS's two-key limit cannot wedge the role).
//!
//! The new value is written as a new KV version (`source = rotate`) at the
//! role's target coordinates, so every `secret:NAME` reference keeps working
//! and the previous version stays in history.
//!
//! Rotation is crash-safe in the order that matters: the new credential is
//! sealed into the role row as *pending* before it is applied upstream; it
//! is cleared only after the KV write succeeds. A failed attempt keeps the
//! previous KV version current, records `lastError`, and retries the same
//! pending credential (so a password that may already be live upstream is
//! never lost). The scheduler retries failures after [`RETRY_SECS`].

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::postgres::{self, PostgresConfig};
use super::redis;
use super::webhook::{self, WebhookConfig};
use crate::plugin_secrets::kv::Charset;
use crate::plugin_secrets::{
    Generator, PluginSecretStore, SecretCoords, SecretMetadataPatch, VersionSource, WriteRequest,
};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{now_millis, VaultError};

/// Shortest rotation period (five minutes).
pub const MIN_ROTATION_SECS: i64 = 300;
/// Longest rotation period (one year).
pub const MAX_ROTATION_SECS: i64 = 366 * 24 * 3600;
/// Delay before the scheduler retries a failed rotation.
pub const RETRY_SECS: i64 = 300;
const DEFAULT_PASSWORD_LENGTH: u16 = 32;
const DEFAULT_PG_ROTATION: &str = "ALTER ROLE \"{{name}}\" WITH PASSWORD '{{password}}'";
const IAM_HOST: &str = "iam.amazonaws.com";
const IAM_REGION: &str = "us-east-1";

/// The account a static role manages. Sealed at rest with the role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StaticProvider {
    #[serde(rename = "postgres", rename_all = "camelCase")]
    Postgres {
        connection_url: String,
        username: String,
        /// Statements with `{{name}}` and `{{password}}`; default
        /// `ALTER ROLE … WITH PASSWORD …`.
        #[serde(default)]
        rotation_statements: Vec<String>,
    },
    #[serde(rename = "redis", alias = "valkey", rename_all = "camelCase")]
    Redis {
        connection_url: String,
        username: String,
    },
    #[serde(rename = "webhook", rename_all = "camelCase")]
    Webhook {
        url: String,
        signing_secret: String,
        username: String,
    },
    #[serde(rename = "aws-iam", rename_all = "camelCase")]
    AwsIam {
        /// Credentials allowed to call `iam:CreateAccessKey` and
        /// `iam:DeleteAccessKey` on the user.
        access_key_id: String,
        secret_access_key: String,
        /// The IAM user whose access key rotates.
        user_name: String,
        /// The user's current key id, deleted after the first rotation.
        #[serde(default)]
        current_access_key_id: Option<String>,
    },
}

fn validate_pg_username(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 63
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@'))
    {
        bail!("username must be 1-63 letters, digits, or _ - . @");
    }
    Ok(())
}

fn validate_iam_user(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'+' | b'=' | b',' | b'.' | b'@' | b'_' | b'-')
        })
    {
        bail!("userName is not a valid IAM user name");
    }
    Ok(())
}

impl StaticProvider {
    /// Stable provider name.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Postgres { .. } => "postgres",
            Self::Redis { .. } => "redis",
            Self::Webhook { .. } => "webhook",
            Self::AwsIam { .. } => "aws-iam",
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Postgres {
                connection_url,
                username,
                rotation_statements,
            } => {
                let url = url::Url::parse(connection_url).context("connectionUrl is not a URL")?;
                if !matches!(url.scheme(), "postgres" | "postgresql") {
                    bail!("connectionUrl must be a postgres:// URL");
                }
                validate_pg_username(username)?;
                if !rotation_statements.is_empty()
                    && !rotation_statements
                        .iter()
                        .any(|statement| statement.contains("{{password}}"))
                {
                    bail!("rotationStatements must reference {{{{password}}}}");
                }
                Ok(())
            }
            Self::Redis {
                connection_url,
                username,
            } => {
                redis::validate_connection_url(connection_url)?;
                redis::validate_username(username)
            }
            Self::Webhook {
                url,
                signing_secret,
                username,
            } => {
                WebhookConfig {
                    url: url.clone(),
                    signing_secret: signing_secret.clone(),
                }
                .validate()?;
                if username.trim().is_empty() || username.len() > 256 {
                    bail!("username must be 1-256 characters");
                }
                Ok(())
            }
            Self::AwsIam {
                access_key_id,
                secret_access_key,
                user_name,
                current_access_key_id,
            } => {
                if access_key_id.trim().is_empty() || secret_access_key.trim().is_empty() {
                    bail!("accessKeyId and secretAccessKey are required");
                }
                validate_iam_user(user_name)?;
                if current_access_key_id
                    .as_deref()
                    .is_some_and(|id| !id.bytes().all(|b| b.is_ascii_alphanumeric()))
                {
                    bail!("currentAccessKeyId is not an access key id");
                }
                Ok(())
            }
        }
    }

    /// The managed account: provider kind plus host/endpoint and user. Two
    /// configurations with the same account rotate the same credential, even
    /// when their admin credentials or statements differ.
    fn account(&self) -> Value {
        match self {
            Self::AwsIam { user_name, .. } => json!({ "kind": "aws-iam", "userName": user_name }),
            other => json!({ "kind": other.kind(), "account": other.summary() }),
        }
    }

    /// Core-managed fields carried over from the stored configuration of the
    /// same account. The AWS `currentAccessKeyId` is rewritten by every
    /// rotation, so a caller's (possibly stale) value is honored only before
    /// Core has recorded one.
    fn with_managed_fields_from(&self, stored: &Self) -> Self {
        let mut merged = self.clone();
        if let (
            Self::AwsIam {
                current_access_key_id,
                ..
            },
            Self::AwsIam {
                current_access_key_id: Some(stored_id),
                ..
            },
        ) = (&mut merged, stored)
        {
            *current_access_key_id = Some(stored_id.clone());
        }
        merged
    }

    /// Non-secret summary for listings.
    fn summary(&self) -> Value {
        match self {
            Self::Postgres {
                connection_url,
                username,
                ..
            } => {
                let target = PostgresConfig {
                    connection_url: connection_url.clone(),
                    creation_statements: Vec::new(),
                    revocation_statements: Vec::new(),
                    username_prefix: None,
                }
                .redacted_target();
                json!({ "host": target, "username": username })
            }
            Self::Redis {
                connection_url,
                username,
            } => json!({ "host": redis::redacted_target(connection_url), "username": username }),
            Self::Webhook { url, username, .. } => json!({ "url": url, "username": username }),
            Self::AwsIam { user_name, .. } => json!({ "userName": user_name }),
        }
    }
}

/// What is sealed in the role row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedState {
    provider: StaticProvider,
    /// A credential generated (or created upstream) but not yet written to
    /// KV. Reused by the next attempt.
    #[serde(default)]
    pending: Option<String>,
    /// AWS access key ids that a rotation replaced but could not delete.
    /// They stay live at AWS until deleted, so each later rotation retries
    /// them (first before creating a key, so AWS's two-key limit cannot
    /// wedge the role).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired_access_keys: Vec<String>,
}

/// A static role (no secrets).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleInfo {
    pub name: String,
    pub provider: String,
    pub summary: Value,
    pub target: SecretCoords,
    pub rotation_period_secs: i64,
    pub password_length: u16,
    pub next_rotation_at: i64,
    pub last_rotated_at: Option<i64>,
    pub last_error: Option<String>,
    /// A rotation was started and is waiting to be retried.
    pub pending: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Create or replace input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleInput {
    pub provider: StaticProvider,
    pub rotation_period_secs: i64,
    #[serde(default)]
    pub password_length: Option<u16>,
}

/// Create the static role table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_static_roles (
             name                 TEXT PRIMARY KEY,
             provider             TEXT NOT NULL,
             summary              TEXT NOT NULL,
             target               TEXT NOT NULL,
             rotation_period_secs INTEGER NOT NULL,
             password_length      INTEGER NOT NULL,
             next_rotation_at     INTEGER NOT NULL,
             last_rotated_at      INTEGER,
             last_error           TEXT,
             pending              INTEGER NOT NULL DEFAULT 0,
             created_at           INTEGER NOT NULL,
             updated_at           INTEGER NOT NULL,
             nonce                BLOB NOT NULL,
             ciphertext           BLOB NOT NULL,
             key_version          INTEGER NOT NULL DEFAULT 0
         );",
    )
    .context("initializing static role schema")
}

const INFO_COLUMNS: &str = "name, provider, summary, target, rotation_period_secs, password_length,
     next_rotation_at, last_rotated_at, last_error, pending, created_at, updated_at";

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StaticRoleInfo> {
    let conversion = |index: usize, error: serde_json::Error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    };
    Ok(StaticRoleInfo {
        name: row.get(0)?,
        provider: row.get(1)?,
        summary: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
        target: serde_json::from_str(&row.get::<_, String>(3)?).map_err(|e| conversion(3, e))?,
        rotation_period_secs: row.get(4)?,
        password_length: row.get(5)?,
        next_rotation_at: row.get(6)?,
        last_rotated_at: row.get(7)?,
        last_error: row.get(8)?,
        pending: row.get::<_, i64>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn info_locked(conn: &Connection, name: &str) -> Result<StaticRoleInfo> {
    conn.query_row(
        &format!("SELECT {INFO_COLUMNS} FROM vault_static_roles WHERE name = ?1"),
        params![name],
        info_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("static role `{name}`")).into())
}

/// Serializes rotations so the scheduler and an on-demand rotate never race
/// on one role's pending credential.
fn rotation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ── Upstream calls ────────────────────────────────────────────────────────

fn iam_sign(
    access_key_id: &str,
    secret: &str,
    body: &str,
    amz_date: &str,
) -> Vec<(String, String)> {
    use hmac::{Hmac, Mac};
    let date = &amz_date[..8];
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";
    let canonical_headers =
        format!("content-type:{content_type}\nhost:{IAM_HOST}\nx-amz-date:{amz_date}\n");
    let signed_headers = "content-type;host;x-amz-date";
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{body_hash}");
    let scope = format!("{date}/{IAM_REGION}/iam/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let key = super::aws::signing_key(secret, date, IAM_REGION, "iam");
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("hmac accepts any key length");
    mac.update(string_to_sign.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    vec![
        ("content-type".into(), content_type.into()),
        ("x-amz-date".into(), amz_date.into()),
        (
            "authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
            ),
        ),
    ]
}

async fn iam_call(access_key_id: &str, secret: &str, params: &[(&str, &str)]) -> Result<String> {
    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in params {
            form.append_pair(key, value);
        }
        form.append_pair("Version", "2010-05-08");
        form.finish()
    };
    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut request = reqwest::Client::new()
        .post(iam_endpoint())
        .timeout(std::time::Duration::from_secs(15))
        .body(body.clone());
    for (name, value) in iam_sign(access_key_id, secret, &body, &amz_date) {
        request = request.header(name, value);
    }
    let response = request.send().await.context("calling AWS IAM")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = xml_text(&text, "Code").unwrap_or("unknown");
        bail!("AWS IAM returned {status} ({code})");
    }
    Ok(text)
}

#[cfg(test)]
thread_local! {
    /// Test-only IAM endpoint (a local fake). Tokio tests run on one thread.
    static IAM_ENDPOINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn iam_endpoint() -> String {
    #[cfg(test)]
    if let Some(endpoint) = IAM_ENDPOINT.with(|cell| cell.borrow().clone()) {
        return endpoint;
    }
    format!("https://{IAM_HOST}/")
}

/// Delete `ids` from the IAM user. Returns the ids still live (deletion
/// failed) and a warning describing the failures. A key AWS no longer knows
/// (`NoSuchEntity`) counts as deleted.
async fn iam_delete_access_keys(
    access_key_id: &str,
    secret: &str,
    user_name: &str,
    ids: Vec<String>,
) -> (Vec<String>, Option<String>) {
    let mut kept = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        if kept.contains(&id) {
            continue;
        }
        let result = iam_call(
            access_key_id,
            secret,
            &[
                ("Action", "DeleteAccessKey"),
                ("UserName", user_name),
                ("AccessKeyId", &id),
            ],
        )
        .await;
        match result {
            Ok(_) => {}
            Err(error) if error.to_string().contains("(NoSuchEntity)") => {}
            Err(error) => {
                errors.push(format!("{id}: {error}"));
                kept.push(id);
            }
        }
    }
    let warning = (!errors.is_empty()).then(|| {
        format!(
            "previous access key(s) not deleted yet; retried on the next rotation: {}",
            errors.join("; ")
        )
    });
    (kept, warning)
}

fn xml_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// Apply a password upstream. Returns the value to store (the webhook may
/// supply its own).
async fn apply_password(provider: &StaticProvider, role: &str, password: &str) -> Result<String> {
    match provider {
        StaticProvider::Postgres {
            connection_url,
            username,
            rotation_statements,
        } => {
            let config = PostgresConfig {
                connection_url: connection_url.clone(),
                creation_statements: Vec::new(),
                revocation_statements: Vec::new(),
                username_prefix: None,
            };
            let statements: Vec<String> = if rotation_statements.is_empty() {
                vec![DEFAULT_PG_ROTATION.to_owned()]
            } else {
                rotation_statements.clone()
            }
            .iter()
            .map(|statement| postgres::render(statement, username, password, ""))
            .collect();
            let client = postgres::connect(&config).await?;
            postgres::run(&client, &statements).await?;
            Ok(password.to_owned())
        }
        StaticProvider::Redis {
            connection_url,
            username,
        } => {
            redis::rotate_password(connection_url, username, password).await?;
            Ok(password.to_owned())
        }
        StaticProvider::Webhook {
            url,
            signing_secret,
            username,
        } => {
            let config = WebhookConfig {
                url: url.clone(),
                signing_secret: signing_secret.clone(),
            };
            let answer = webhook::call(
                &config,
                json!({ "action": "rotate", "role": role, "username": username, "password": password }),
            )
            .await?;
            Ok(answer
                .get("value")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(password)
                .to_owned())
        }
        StaticProvider::AwsIam { .. } => bail!("aws-iam roles rotate access keys, not passwords"),
    }
}

impl PluginSecretStore {
    /// Create or replace a static role. A new or re-targeted role is due at
    /// once; the scheduler (or `static_rotate`) performs the first rotation.
    pub async fn static_put_role(
        &self,
        name: &str,
        input: &StaticRoleInput,
        target: SecretCoords,
        actor: &AuditActor,
    ) -> Result<StaticRoleInfo> {
        if !super::is_valid_role_name(name) {
            return Err(VaultError::Invalid("invalid static role name".into()).into());
        }
        input
            .provider
            .validate()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        if !(MIN_ROTATION_SECS..=MAX_ROTATION_SECS).contains(&input.rotation_period_secs) {
            return Err(VaultError::Invalid(format!(
                "rotationPeriodSecs must be {MIN_ROTATION_SECS} to {MAX_ROTATION_SECS}"
            ))
            .into());
        }
        let length = input.password_length.unwrap_or(DEFAULT_PASSWORD_LENGTH);
        password_generator(length)
            .validate()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let target = target
            .normalize()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let now = now_millis();
        let target_json = serde_json::to_string(&target)?;
        let _guard = rotation_lock().lock().await;
        let conn = self.conn.lock().await;
        // An edit of the same account and target (schedule, admin
        // credentials, statements) keeps the rotation clock, the pending
        // credential, and Core-managed fields; a new account or target
        // rotates from scratch. A pending credential may already be live
        // upstream, so it is never discarded: re-pointing a role while one is
        // pending is refused until the rotation completes.
        let existing: Option<(String, Vec<u8>, Vec<u8>, u32)> = conn
            .query_row(
                "SELECT target, nonce, ciphertext, key_version FROM vault_static_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let mut state = SealedState {
            provider: input.provider.clone(),
            pending: None,
            retired_access_keys: Vec::new(),
        };
        let mut next_rotation_at = now;
        if let Some((old_target, old_nonce, old_ciphertext, old_version)) = existing {
            let old: SealedState = serde_json::from_slice(&self.open_row(
                old_version,
                &old_nonce,
                &old_ciphertext,
            )?)?;
            let same_account =
                old.provider.account() == input.provider.account() && old_target == target_json;
            if same_account {
                state = SealedState {
                    provider: input.provider.with_managed_fields_from(&old.provider),
                    pending: old.pending,
                    retired_access_keys: old.retired_access_keys,
                };
                let info = info_locked(&conn, name)?;
                next_rotation_at = match info.last_rotated_at {
                    Some(at) => at + input.rotation_period_secs * 1000,
                    None => info.next_rotation_at,
                };
            } else if old.pending.is_some() {
                return Err(VaultError::Conflict(format!(
                    "static role `{name}` has a pending rotation for its current account; \
                     rotate it successfully before changing the account or target"
                ))
                .into());
            } else if !old.retired_access_keys.is_empty() {
                return Err(VaultError::Conflict(format!(
                    "static role `{name}` still has replaced access keys ({}) that could not \
                     be deleted; rotate it successfully (or delete them in AWS and recreate \
                     the role) before changing the account or target",
                    old.retired_access_keys.join(", ")
                ))
                .into());
            }
        }
        let keep_pending = state.pending.is_some();
        let sealed = self.seal_row(&serde_json::to_vec(&state)?)?;
        conn.execute(
            "INSERT INTO vault_static_roles
                 (name, provider, summary, target, rotation_period_secs, password_length,
                  next_rotation_at, pending, created_at, updated_at, nonce, ciphertext, key_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12)
             ON CONFLICT(name) DO UPDATE SET provider = excluded.provider,
                 summary = excluded.summary, target = excluded.target,
                 rotation_period_secs = excluded.rotation_period_secs,
                 password_length = excluded.password_length,
                 next_rotation_at = excluded.next_rotation_at, pending = excluded.pending,
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version",
            params![
                name,
                input.provider.kind(),
                input.provider.summary().to_string(),
                target_json,
                input.rotation_period_secs,
                length,
                next_rotation_at,
                keep_pending as i64,
                now,
                sealed.1,
                sealed.2,
                sealed.0
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.role.put", "ok")
                .details(json!({ "role": name, "provider": input.provider.kind() })),
        );
        info_locked(&conn, name)
    }

    /// Every static role.
    pub async fn static_list_roles(&self) -> Result<Vec<StaticRoleInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM vault_static_roles ORDER BY name"
        ))?;
        let rows = stmt.query_map([], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One static role.
    pub async fn static_role(&self, name: &str) -> Result<StaticRoleInfo> {
        let conn = self.conn.lock().await;
        info_locked(&conn, name)
    }

    /// Delete a static role. The account and its last KV value stay as they
    /// are; Ryu just stops rotating it.
    pub async fn static_delete_role(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let _guard = rotation_lock().lock().await;
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM vault_static_roles WHERE name = ?1",
            params![name],
        )?;
        if removed == 0 {
            return Err(VaultError::NotFound(format!("static role `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.role.delete", "ok").details(json!({ "role": name })),
        );
        Ok(())
    }

    /// The current credential (the target's current KV value). The caller
    /// must have checked `read` on the target.
    pub async fn static_read(
        &self,
        name: &str,
        actor: &AuditActor,
    ) -> Result<(StaticRoleInfo, String)> {
        let info = self.static_role(name).await?;
        let value = self
            .reveal(&info.target, None, actor)
            .await
            .map_err(|error| match error.downcast_ref::<VaultError>() {
                Some(VaultError::NotFound(_)) => {
                    VaultError::NotFound(format!("static role `{name}` has not rotated yet")).into()
                }
                _ => error,
            })?;
        Ok((info, value))
    }

    fn static_seal_state(&self, conn: &Connection, name: &str, state: &SealedState) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_row(&serde_json::to_vec(state)?)?;
        conn.execute(
            "UPDATE vault_static_roles SET nonce = ?1, ciphertext = ?2, key_version = ?3,
                 pending = ?4, updated_at = ?5 WHERE name = ?6",
            params![
                nonce,
                ciphertext,
                key_version,
                state.pending.is_some() as i64,
                now_millis(),
                name
            ],
        )?;
        Ok(())
    }

    async fn static_state(&self, name: &str) -> Result<(StaticRoleInfo, SealedState)> {
        let conn = self.conn.lock().await;
        let info = info_locked(&conn, name)?;
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn.query_row(
            "SELECT nonce, ciphertext, key_version FROM vault_static_roles WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        Ok((info, serde_json::from_slice(&plain)?))
    }

    async fn static_record_failure(&self, name: &str, error: &anyhow::Error, actor: &AuditActor) {
        let conn = self.conn.lock().await;
        let message: String = error.to_string().chars().take(500).collect();
        if let Err(write_error) = conn.execute(
            "UPDATE vault_static_roles SET last_error = ?1, next_rotation_at = ?2 WHERE name = ?3",
            params![message, now_millis() + RETRY_SECS * 1000, name],
        ) {
            tracing::warn!("recording static rotation failure for `{name}`: {write_error:#}");
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.rotate", "error")
                .details(json!({ "role": name, "error": message })),
        );
    }

    /// Rotate one static role now.
    pub async fn static_rotate(&self, name: &str, actor: &AuditActor) -> Result<StaticRoleInfo> {
        let _guard = rotation_lock().lock().await;
        let (info, state) = self.static_state(name).await?;
        match self.static_rotate_locked(&info, state, actor).await {
            Ok(()) => self.static_role(name).await,
            Err(error) => {
                self.static_record_failure(name, &error, actor).await;
                Err(error)
            }
        }
    }

    async fn static_rotate_locked(
        &self,
        info: &StaticRoleInfo,
        mut state: SealedState,
        actor: &AuditActor,
    ) -> Result<()> {
        let name = info.name.as_str();
        let mut retired_key: Option<String> = None;
        let value = match &state.provider {
            StaticProvider::AwsIam {
                access_key_id,
                secret_access_key,
                user_name,
                current_access_key_id,
            } => {
                let created = match state.pending.clone() {
                    Some(pending) => pending,
                    None => {
                        // Free AWS's two-key slot from earlier failed
                        // deletions before creating another key.
                        if !state.retired_access_keys.is_empty() {
                            let (kept, _) = iam_delete_access_keys(
                                access_key_id,
                                secret_access_key,
                                user_name,
                                state.retired_access_keys.clone(),
                            )
                            .await;
                            if kept != state.retired_access_keys {
                                state.retired_access_keys = kept;
                                let conn = self.conn.lock().await;
                                self.static_seal_state(&conn, name, &state)?;
                            }
                        }
                        let answer = iam_call(
                            access_key_id,
                            secret_access_key,
                            &[("Action", "CreateAccessKey"), ("UserName", user_name)],
                        )
                        .await?;
                        let id = xml_text(&answer, "AccessKeyId")
                            .ok_or_else(|| anyhow!("AWS IAM returned no access key id"))?;
                        let secret = xml_text(&answer, "SecretAccessKey")
                            .ok_or_else(|| anyhow!("AWS IAM returned no secret access key"))?;
                        let created =
                            json!({ "accessKeyId": id, "secretAccessKey": secret }).to_string();
                        // Persist before anything else can fail: the key is
                        // already live at AWS.
                        state.pending = Some(created.clone());
                        let conn = self.conn.lock().await;
                        self.static_seal_state(&conn, name, &state)?;
                        created
                    }
                };
                retired_key = current_access_key_id.clone();
                created
            }
            provider => {
                let password = match state.pending.clone() {
                    Some(pending) => pending,
                    None => {
                        let password = password_generator(info.password_length).generate();
                        state.pending = Some(password.clone());
                        let conn = self.conn.lock().await;
                        self.static_seal_state(&conn, name, &state)?;
                        password
                    }
                };
                apply_password(provider, name, &password).await?
            }
        };
        self.write_secret(WriteRequest {
            coords: info.target.clone(),
            value: Some(&value),
            patch: SecretMetadataPatch::default(),
            actor,
            source: VersionSource::Rotate,
            expected_version: None,
        })
        .await
        .context("writing the rotated credential")?;

        // The new value is current; retire the old AWS key and record the
        // new one so the next rotation deletes it.
        let mut warning: Option<String> = None;
        if let StaticProvider::AwsIam {
            access_key_id,
            secret_access_key,
            user_name,
            current_access_key_id,
        } = &mut state.provider
        {
            let new_id = serde_json::from_str::<Value>(&value).ok().and_then(|v| {
                v.get("accessKeyId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            // Every replaced key stays recorded until AWS confirms its
            // deletion, so a transient failure is retried instead of leaving
            // a live key Core no longer knows about.
            let mut retired = std::mem::take(&mut state.retired_access_keys);
            if let Some(old) = retired_key.filter(|old| Some(old) != new_id.as_ref()) {
                retired.push(old);
            }
            retired.retain(|id| Some(id) != new_id.as_ref());
            if !retired.is_empty() {
                let (kept, failed) =
                    iam_delete_access_keys(access_key_id, secret_access_key, user_name, retired)
                        .await;
                state.retired_access_keys = kept;
                warning = failed;
            }
            *current_access_key_id = new_id;
        }
        state.pending = None;
        let now = now_millis();
        let conn = self.conn.lock().await;
        self.static_seal_state(&conn, name, &state)?;
        conn.execute(
            "UPDATE vault_static_roles SET last_rotated_at = ?1, next_rotation_at = ?2,
                 last_error = ?3 WHERE name = ?4",
            params![now, now + info.rotation_period_secs * 1000, warning, name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.rotate", "ok")
                .details(json!({ "role": name, "provider": state.provider.kind() })),
        );
        Ok(())
    }

    /// Rotate every due static role. Failures are logged, recorded on the
    /// role, and retried later. Returns how many rotated.
    pub async fn static_rotate_due(&self) -> Result<usize> {
        let due: Vec<String> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT name FROM vault_static_roles WHERE next_rotation_at <= ?1 ORDER BY name",
            )?;
            let rows = stmt.query_map(params![now_millis()], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let actor = AuditActor::system();
        let mut rotated = 0;
        for name in due {
            match self.static_rotate(&name, &actor).await {
                Ok(_) => rotated += 1,
                Err(error) => tracing::warn!("static role `{name}` rotation failed: {error:#}"),
            }
        }
        Ok(rotated)
    }
}

fn password_generator(length: u16) -> Generator {
    Generator::Random {
        length,
        charset: Charset::Alphanumeric,
    }
}

/// Summary map of provider names for docs and listings.
pub fn provider_kinds() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("postgres", "ALTER ROLE password rotation"),
        ("redis", "ACL SETUSER resetpass rotation (alias valkey)"),
        ("webhook", "signed rotate call; may supply the value"),
        ("aws-iam", "CreateAccessKey then DeleteAccessKey"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::SecretScope;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn target() -> SecretCoords {
        SecretCoords::root(SecretScope::Node, "local", None, "CACHE_PASSWORD")
    }

    fn redis_input(url: &str) -> StaticRoleInput {
        serde_json::from_value(json!({
            "provider": { "kind": "valkey", "connectionUrl": url, "username": "app" },
            "rotationPeriodSecs": 3600,
        }))
        .unwrap()
    }

    #[test]
    fn providers_validate_their_targets() {
        let ok: StaticProvider = serde_json::from_value(json!({
            "kind": "postgres", "connectionUrl": "postgres://a:b@db/x", "username": "app_user"
        }))
        .unwrap();
        assert!(ok.validate().is_ok());
        assert_eq!(ok.summary()["username"], "app_user");
        for bad in [
            json!({ "kind": "postgres", "connectionUrl": "mysql://db", "username": "app" }),
            json!({ "kind": "postgres", "connectionUrl": "postgres://db", "username": "a\"b" }),
            json!({ "kind": "postgres", "connectionUrl": "postgres://db", "username": "app",
                    "rotationStatements": ["SELECT 1"] }),
            json!({ "kind": "redis", "connectionUrl": "redis://h", "username": "default" }),
            json!({ "kind": "webhook", "url": "http://example.com", "signingSecret": "x".repeat(16), "username": "u" }),
            json!({ "kind": "aws-iam", "accessKeyId": "", "secretAccessKey": "s", "userName": "ci" }),
            json!({ "kind": "aws-iam", "accessKeyId": "A", "secretAccessKey": "s", "userName": "bad name" }),
        ] {
            let provider: StaticProvider = serde_json::from_value(bad.clone()).unwrap();
            assert!(provider.validate().is_err(), "{bad}");
        }
        assert_eq!(provider_kinds().len(), 4);
    }

    #[tokio::test]
    async fn redis_roles_rotate_into_kv_versions() {
        let (url, log) = redis::tests::fake_server(false).await;
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let role = store
            .static_put_role("cache", &redis_input(&url), target(), &actor)
            .await
            .unwrap();
        assert_eq!(role.provider, "redis");
        assert!(
            role.next_rotation_at <= now_millis(),
            "a new role is due at once"
        );
        assert!(store.static_read("cache", &actor).await.is_err());

        assert_eq!(store.static_rotate_due().await.unwrap(), 1);
        let (info, first) = store.static_read("cache", &actor).await.unwrap();
        assert_eq!(first.len(), 32);
        assert!(info.last_rotated_at.is_some());
        assert!(!info.pending);
        assert!(info.next_rotation_at > now_millis());
        assert_eq!(
            store.static_rotate_due().await.unwrap(),
            0,
            "not due again yet"
        );

        store.static_rotate("cache", &actor).await.unwrap();
        let (_, second) = store.static_read("cache", &actor).await.unwrap();
        assert_ne!(first, second);
        let versions = store.list_versions(&target()).await.unwrap();
        assert_eq!(versions.len(), 2);

        let log = log.lock().unwrap().clone();
        let setusers: Vec<&Vec<String>> = log.iter().filter(|cmd| cmd[0] == "ACL").collect();
        assert_eq!(setusers[0][..4], ["ACL", "SETUSER", "app", "resetpass"]);
        assert_eq!(setusers[0][4], format!(">{first}"));
        assert_eq!(setusers[1][4], format!(">{second}"));
    }

    #[tokio::test]
    async fn failed_rotations_keep_the_old_value_and_retry_the_same_credential() {
        let failing = Arc::new(AtomicBool::new(false));
        let (url, log) = redis::tests::fake_server_with(failing.clone()).await;
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .static_put_role("cache", &redis_input(&url), target(), &actor)
            .await
            .unwrap();
        store.static_rotate("cache", &actor).await.unwrap();
        let (_, before) = store.static_read("cache", &actor).await.unwrap();

        failing.store(true, Ordering::SeqCst);
        assert!(store.static_rotate("cache", &actor).await.is_err());
        let info = store.static_role("cache").await.unwrap();
        assert!(info.pending);
        assert!(info
            .last_error
            .as_deref()
            .unwrap()
            .contains("ACL SETUSER failed"));
        assert!(!info.last_error.as_deref().unwrap().contains('>'));
        let (_, unchanged) = store.static_read("cache", &actor).await.unwrap();
        assert_eq!(unchanged, before, "the previous version stays current");

        failing.store(false, Ordering::SeqCst);
        store.static_rotate("cache", &actor).await.unwrap();
        let (info, after) = store.static_read("cache", &actor).await.unwrap();
        assert!(!info.pending);
        assert!(info.last_error.is_none());
        let log = log.lock().unwrap().clone();
        let sets: Vec<&Vec<String>> = log.iter().filter(|cmd| cmd[0] == "ACL").collect();
        assert_eq!(sets.len(), 3);
        assert_eq!(
            sets[1][4], sets[2][4],
            "the retry reuses the pending password"
        );
        assert_eq!(sets[2][4], format!(">{after}"));
    }

    #[tokio::test]
    async fn schedule_edits_keep_the_clock_and_target_changes_reset_it() {
        let (url, _) = redis::tests::fake_server(false).await;
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .static_put_role("cache", &redis_input(&url), target(), &actor)
            .await
            .unwrap();
        let rotated = store.static_rotate("cache", &actor).await.unwrap();
        let mut slower = redis_input(&url);
        slower.rotation_period_secs = 7200;
        let edited = store
            .static_put_role("cache", &slower, target(), &actor)
            .await
            .unwrap();
        assert_eq!(edited.last_rotated_at, rotated.last_rotated_at);
        assert_eq!(
            edited.next_rotation_at,
            rotated.last_rotated_at.unwrap() + 7_200_000
        );
        let mut moved = target();
        moved.name = "OTHER_PASSWORD".into();
        let retargeted = store
            .static_put_role("cache", &slower, moved, &actor)
            .await
            .unwrap();
        assert!(retargeted.next_rotation_at <= now_millis());

        let mut too_fast = redis_input(&url);
        too_fast.rotation_period_secs = 10;
        assert!(store
            .static_put_role("cache", &too_fast, target(), &actor)
            .await
            .is_err());
        store.static_delete_role("cache", &actor).await.unwrap();
        assert!(store.static_delete_role("cache", &actor).await.is_err());
    }

    fn aws_input(user: &str, current: Option<&str>) -> StaticRoleInput {
        serde_json::from_value(json!({
            "provider": { "kind": "aws-iam", "accessKeyId": "AKIAADMIN", "secretAccessKey": "s",
                          "userName": user, "currentAccessKeyId": current },
            "rotationPeriodSecs": 3600,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn aws_re_puts_keep_the_live_key_id_and_the_pending_key() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .static_put_role("ci", &aws_input("ci", Some("AKIAORIG")), target(), &actor)
            .await
            .unwrap();
        // Simulate a completed rotation (live key AKIANEW) followed by a
        // created-but-unwritten key.
        let (_, mut state) = store.static_state("ci").await.unwrap();
        if let StaticProvider::AwsIam {
            current_access_key_id,
            ..
        } = &mut state.provider
        {
            *current_access_key_id = Some("AKIANEW".into());
        }
        state.pending =
            Some(json!({ "accessKeyId": "AKIAPEND", "secretAccessKey": "x" }).to_string());
        {
            let conn = store.conn.lock().await;
            store.static_seal_state(&conn, "ci", &state).unwrap();
        }

        // Re-sending the original body (stale key id) changes nothing managed.
        let mut slower = aws_input("ci", Some("AKIAORIG"));
        slower.rotation_period_secs = 7200;
        let info = store
            .static_put_role("ci", &slower, target(), &actor)
            .await
            .unwrap();
        assert!(info.pending, "the pending key is kept");
        let (_, kept) = store.static_state("ci").await.unwrap();
        assert_eq!(kept.pending, state.pending);
        assert!(matches!(
            &kept.provider,
            StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW"
        ));
        store
            .static_put_role("ci", &aws_input("ci", None), target(), &actor)
            .await
            .unwrap();
        let (_, kept) = store.static_state("ci").await.unwrap();
        assert!(matches!(
            &kept.provider,
            StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW"
        ));

        // Re-pointing the role while a key is pending is refused.
        let error = store
            .static_put_role("ci", &aws_input("other-user", None), target(), &actor)
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        ));
        let mut moved = target();
        moved.name = "OTHER".into();
        assert!(store
            .static_put_role("ci", &aws_input("ci", None), moved, &actor)
            .await
            .is_err());
    }

    /// A fake IAM endpoint: tracks the user's live keys, enforces AWS's
    /// two-key limit, and can fail `DeleteAccessKey` on demand.
    #[derive(Default)]
    struct FakeIam {
        keys: Vec<String>,
        created: usize,
        fail_delete: bool,
    }

    async fn fake_iam(initial: &str) -> (String, Arc<std::sync::Mutex<FakeIam>>) {
        use axum::http::StatusCode;
        let fake = Arc::new(std::sync::Mutex::new(FakeIam {
            keys: vec![initial.to_owned()],
            ..FakeIam::default()
        }));
        let state = fake.clone();
        let handler = move |body: String| {
            let state = state.clone();
            async move {
                let form: BTreeMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect();
                let mut iam = state.lock().unwrap();
                let error = |status: StatusCode, code: &str| {
                    (status, format!("<Error><Code>{code}</Code></Error>"))
                };
                match form.get("Action").map(String::as_str) {
                    Some("CreateAccessKey") if iam.keys.len() >= 2 => {
                        error(StatusCode::CONFLICT, "LimitExceeded")
                    }
                    Some("CreateAccessKey") => {
                        iam.created += 1;
                        let id = format!("AKIANEW{}", iam.created);
                        iam.keys.push(id.clone());
                        (
                            StatusCode::OK,
                            format!(
                                "<AccessKey><AccessKeyId>{id}</AccessKeyId>\
                                 <SecretAccessKey>s{id}</SecretAccessKey></AccessKey>"
                            ),
                        )
                    }
                    Some("DeleteAccessKey") if iam.fail_delete => {
                        error(StatusCode::INTERNAL_SERVER_ERROR, "ServiceFailure")
                    }
                    Some("DeleteAccessKey") => {
                        let id = form.get("AccessKeyId").cloned().unwrap_or_default();
                        if iam.keys.contains(&id) {
                            iam.keys.retain(|key| key != &id);
                            (StatusCode::OK, "<DeleteAccessKeyResponse/>".to_owned())
                        } else {
                            error(StatusCode::NOT_FOUND, "NoSuchEntity")
                        }
                    }
                    _ => error(StatusCode::BAD_REQUEST, "InvalidAction"),
                }
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(handler);
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        (format!("http://{addr}/"), fake)
    }

    #[tokio::test]
    async fn aws_keys_that_fail_to_delete_are_kept_and_retried() {
        let (endpoint, iam) = fake_iam("AKIAORIG").await;
        IAM_ENDPOINT.with(|cell| *cell.borrow_mut() = Some(endpoint));
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .static_put_role("ci", &aws_input("ci", Some("AKIAORIG")), target(), &actor)
            .await
            .unwrap();

        // The new key is written but the old one cannot be deleted: the
        // rotation completes and keeps the old id for a retry.
        iam.lock().unwrap().fail_delete = true;
        let info = store.static_rotate("ci", &actor).await.unwrap();
        assert!(!info.pending);
        assert!(info.last_error.as_deref().unwrap().contains("AKIAORIG"));
        let (_, state) = store.static_state("ci").await.unwrap();
        assert_eq!(state.retired_access_keys, ["AKIAORIG"]);
        assert!(matches!(
            &state.provider,
            StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW1"
        ));
        assert_eq!(iam.lock().unwrap().keys, ["AKIAORIG", "AKIANEW1"]);

        // A same-account edit keeps the retired id; re-pointing is refused.
        let info = store
            .static_put_role("ci", &aws_input("ci", None), target(), &actor)
            .await
            .unwrap();
        assert!(!info.pending);
        assert_eq!(
            store
                .static_state("ci")
                .await
                .unwrap()
                .1
                .retired_access_keys,
            ["AKIAORIG"]
        );
        let error = store
            .static_put_role("ci", &aws_input("other-user", None), target(), &actor)
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        ));

        // The next rotation deletes the retired key first (AWS allows only
        // two keys), then the key it replaces.
        iam.lock().unwrap().fail_delete = false;
        let info = store.static_rotate("ci", &actor).await.unwrap();
        assert!(info.last_error.is_none());
        let (_, state) = store.static_state("ci").await.unwrap();
        assert!(state.retired_access_keys.is_empty());
        assert_eq!(iam.lock().unwrap().keys, ["AKIANEW2"]);
        let (_, value) = store.static_read("ci", &actor).await.unwrap();
        assert!(value.contains("AKIANEW2"));
        IAM_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
    }

    #[tokio::test]
    async fn redis_admin_credential_edits_keep_a_pending_password() {
        let failing = Arc::new(AtomicBool::new(true));
        let (url, _) = redis::tests::fake_server_with(failing.clone()).await;
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .static_put_role("cache", &redis_input(&url), target(), &actor)
            .await
            .unwrap();
        assert!(store.static_rotate("cache", &actor).await.is_err());
        let (_, before) = store.static_state("cache").await.unwrap();
        assert!(before.pending.is_some());
        // New admin password, same host and user: the pending password stays.
        let edited_url = url.replace("s3cret", "n3w-admin");
        let info = store
            .static_put_role("cache", &redis_input(&edited_url), target(), &actor)
            .await
            .unwrap();
        assert!(info.pending);
        let (_, after) = store.static_state("cache").await.unwrap();
        assert_eq!(after.pending, before.pending);
    }

    #[test]
    fn iam_requests_are_sigv4_signed_for_iam() {
        let headers = iam_sign(
            "AKIDEXAMPLE",
            "secret",
            "Action=CreateAccessKey&UserName=ci&Version=2010-05-08",
            "20260101T000000Z",
        );
        let auth = &headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .unwrap()
            .1;
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/us-east-1/iam/aws4_request"
        ));
        assert_eq!(
            xml_text("<CreateAccessKeyResult><AccessKey><AccessKeyId>AKIA1</AccessKeyId></AccessKey></CreateAccessKeyResult>", "AccessKeyId"),
            Some("AKIA1")
        );
    }
}
