//! Secret Vault engines layered on the encrypted `plugin-secrets.db` store.
//!
//! [`crate::plugin_secrets`] owns the key/value tables (values, versions,
//! environments, folders) and the dispatch-time `secret:` resolver. This module
//! owns everything that turns that store into a secrets manager:
//!
//! * [`keyring`]: versioned data-encryption keys, rotation, rewrap, and the
//!   `auto`/`shamir` seal modes (with [`shamir`] key shares);
//! * [`audit`]: the append-only, HMAC-chained vault audit log;
//! * [`broker`]: the credential-brokering egress proxy for agents;
//! * [`audit_devices`]: external file, syslog, socket, and HTTP audit devices;
//! * [`events`]: the vault event bus behind the subscription routes;
//! * [`declarative`]: declarative self-initialization from `RYU_VAULT_INIT_FILE`;
//! * [`policy`]: path policies, capabilities, and temporary bindings;
//! * [`changes`]: change requests for protected environments;
//! * [`leases`] and [`dynamic`]: leased, revocable dynamic credentials;
//! * [`transit`], [`pki`], [`ssh`]: cryptography engines;
//! * [`totp`]: server-held TOTP seeds, codes, and validation;
//! * [`password_policy`]: named password policies for generated values;
//! * [`identity_tokens`]: signed workload identity tokens with a public
//!   OIDC discovery document and JWKS;
//! * [`tokens`], [`wrapping`], [`quotas`]: token lifecycle (renew, use
//!   limits, CIDR binding, child tokens, token roles), response wrapping and
//!   cubbyholes, rate-limit and lease-count quotas with lease administration;
//! * [`machine`]: AppRole and OIDC/JWT machine identities and vault tokens,
//!   with [`auth_methods`] adding TLS cert, AWS IAM, and Kubernetes login;
//! * [`seal_ext`]: auto-unseal seal providers, recovery shares, and rekey;
//! * [`dotenv`], [`scan`], [`snapshot`]: developer-workflow helpers;
//! * [`shared`]: the control-plane client for team and organization values;
//! * [`external`]: OpenBao, HashiCorp Vault, and Infisical stores (live or
//!   synced sources, and one-way push destinations);
//! * [`items`]: typed credential items (field schema, per-field sealing,
//!   optimistic versions, and an event timeline);
//! * [`password_managers`]: 1Password and Bitwarden Secrets Manager
//!   references resolved at use time behind per-consumer human approval;
//! * [`scheduler`]: rotation, lease expiry, and audit retention.
//!
//! The canonical contract is `docs/vault-parity-spec.md`.

pub mod agent_accounts;
pub mod audit;
pub mod audit_devices;
pub mod auth_methods;
pub mod broker;
pub mod changes;
pub mod declarative;
pub mod dotenv;
pub mod dynamic;
pub mod events;
pub mod external;
pub mod identity_tokens;
pub mod items;
pub mod keyring;
pub mod leases;
pub mod machine;
pub mod password_managers;
pub mod password_policy;
pub mod pki;
pub mod policy;
pub mod policy_ext;
pub mod quotas;
pub mod scan;
pub mod scheduler;
pub mod seal_ext;
pub mod shamir;
pub mod shared;
pub mod snapshot;
pub mod ssh;
pub mod tokens;
pub mod totp;
pub mod transit;
pub mod wrapping;

use std::time::{SystemTime, UNIX_EPOCH};

/// Default environment slug. Every pre-environment value migrates here.
pub const DEFAULT_ENVIRONMENT: &str = "default";
/// Root folder path.
pub const ROOT_PATH: &str = "/";
/// Maximum folder depth below the root.
pub const MAX_PATH_DEPTH: usize = 8;
/// Maximum length of one folder segment.
pub const MAX_PATH_SEGMENT_LEN: usize = 64;
/// Maximum environment slug length.
pub const MAX_ENVIRONMENT_LEN: usize = 32;
/// Env var naming the node's active environment for `secret:NAME`.
pub const ENV_ACTIVE_ENVIRONMENT: &str = "RYU_VAULT_ENVIRONMENT";

/// Tables whose rows carry `(key_version, nonce, ciphertext)` sealed with the
/// keyring. `rewrap_all` and keyring rotation walk exactly this list; a new
/// encrypted table must be added here (the rewrap test checks coverage).
pub const ENCRYPTED_TABLES: &[&str] = &[
    "plugin_secrets",
    "vault_secrets",
    "vault_secret_versions",
    "vault_change_requests",
    "vault_transit_keys",
    "vault_ssh_cas",
    "vault_pki_issuers",
    "vault_leases",
    "vault_dynamic_roles",
    "vault_broker_ca",
    "vault_wrapped_responses",
    "vault_cubbyhole",
    "vault_totp_keys",
    "vault_identity_keys",
    "vault_external_stores",
    "vault_item_values",
    "vault_static_roles",
    "vault_pm_accounts",
];

/// Add each missing `(column, declaration)` to `table`. Additive schema
/// upgrades for tables created by an earlier release; idempotent.
pub(crate) fn ensure_columns(
    conn: &rusqlite::Connection,
    table: &str,
    columns: &[(&str, &str)],
) -> anyhow::Result<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (column, declaration) in columns {
        if !existing.iter().any(|name| name == column) {
            conn.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
            ))?;
        }
    }
    Ok(())
}

/// Current epoch milliseconds.
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Policy-key prefix for non-secret resources (`sys/transit/<key>`,
/// `sys/pki/<role>`, ...). Reserved, so no environment can shadow it.
pub const SYS_PREFIX: &str = "sys";

/// Whether `value` is a valid environment slug (`^[a-z0-9][a-z0-9-]{0,31}$`,
/// not the reserved `sys`).
pub fn is_valid_environment(value: &str) -> bool {
    let bytes = value.as_bytes();
    value != SYS_PREFIX
        && !bytes.is_empty()
        && bytes.len() <= MAX_ENVIRONMENT_LEN
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn is_valid_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_PATH_SEGMENT_LEN
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Normalize a folder path. Accepts `""`, `/`, `a/b`, `/a/b/`; returns `/` or
/// `/a/b`. Rejects traversal, empty segments, and over-deep or malformed paths.
pub fn normalize_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return Some(ROOT_PATH.to_owned());
    }
    let inner = trimmed.trim_start_matches('/').trim_end_matches('/');
    if inner.is_empty() {
        return Some(ROOT_PATH.to_owned());
    }
    let segments: Vec<&str> = inner.split('/').collect();
    if segments.len() > MAX_PATH_DEPTH || !segments.iter().all(|s| is_valid_path_segment(s)) {
        return None;
    }
    Some(format!("/{}", segments.join("/")))
}

/// The node's active environment for unqualified references. An invalid
/// configured value falls back to the default rather than widening lookup.
pub fn active_environment() -> String {
    std::env::var(ENV_ACTIVE_ENVIRONMENT)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| is_valid_environment(value))
        .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_owned())
}

/// A parsed `secret:` reference body (the text after `secret:`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRef {
    /// Explicit environment, or `None` for the active environment.
    pub environment: Option<String>,
    /// Normalized folder path.
    pub path: String,
    /// Env-var-shaped secret name.
    pub name: String,
}

impl SecretRef {
    /// Parse `NAME`, `/folder/NAME`, `ENV:NAME`, or `ENV:/folder/NAME`.
    pub fn parse(body: &str) -> Option<Self> {
        let body = body.trim();
        if body.is_empty() {
            return None;
        }
        let (environment, rest) = match body.split_once(':') {
            Some((env, rest)) => {
                if !is_valid_environment(env) {
                    return None;
                }
                (Some(env.to_owned()), rest)
            }
            None => (None, body),
        };
        let (path, name) = match rest.rfind('/') {
            Some(index) => {
                let folder = &rest[..index];
                // A relative `a/NAME` is ambiguous with an environment-less
                // folder; require the leading slash for folders.
                if !rest.starts_with('/') {
                    return None;
                }
                (normalize_path(folder)?, &rest[index + 1..])
            }
            None => (ROOT_PATH.to_owned(), rest),
        };
        if !crate::plugin_secrets::is_valid_vault_secret_name(name) {
            return None;
        }
        Some(Self {
            environment,
            path,
            name: name.to_owned(),
        })
    }

    /// The environment this reference resolves in.
    pub fn environment_or(&self, active: &str) -> String {
        self.environment
            .clone()
            .unwrap_or_else(|| active.to_owned())
    }

    /// The policy path key `ENV/folder/NAME` (no leading slash).
    #[cfg(test)]
    pub fn policy_key(&self, active: &str) -> String {
        policy_key(&self.environment_or(active), &self.path, &self.name)
    }
}

/// Build a policy path key `ENV/folder/NAME`.
pub fn policy_key(environment: &str, path: &str, name: &str) -> String {
    if path == ROOT_PATH {
        format!("{environment}/{name}")
    } else {
        format!("{environment}{path}/{name}")
    }
}

/// Typed vault failure classes that HTTP handlers map onto stable codes.
#[derive(Debug)]
pub enum VaultError {
    Sealed,
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Denied(String),
    /// Fail-closed auditing is on and no audit device accepted the row.
    AuditUnavailable,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sealed => write!(f, "vault_sealed: the vault is sealed"),
            Self::AuditUnavailable => write!(
                f,
                "vault_audit_unavailable: no audit device accepted the audit record"
            ),
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Denied(message) => write!(f, "{}: {message}", self.code()),
        }
    }
}

impl std::error::Error for VaultError {}

impl VaultError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Sealed => "vault_sealed",
            Self::Invalid(_) => "vault_invalid_request",
            Self::NotFound(_) => "vault_not_found",
            Self::Conflict(_) => "vault_conflict",
            Self::Denied(_) => "vault_denied",
            Self::AuditUnavailable => "vault_audit_unavailable",
        }
    }
}

/// Generate `len` random bytes.
pub(crate) fn random_bytes(len: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut out = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut out);
    out
}

/// URL-safe random token with a type prefix, e.g. `rvt_…`.
pub(crate) fn random_token(prefix: &str) -> String {
    use base64::Engine as _;
    format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes(32))
    )
}

/// Hex SHA-256 digest.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest as _;
    hex::encode(sha2::Sha256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environments_follow_the_slug_grammar() {
        for ok in ["default", "prod", "staging-2", "0dev"] {
            assert!(is_valid_environment(ok), "{ok}");
        }
        for bad in ["", "Prod", "-x", "a_b", "has space", "sys", &"a".repeat(33)] {
            assert!(!is_valid_environment(bad), "{bad}");
        }
    }

    #[test]
    fn paths_normalize_and_reject_traversal() {
        assert_eq!(normalize_path("").as_deref(), Some("/"));
        assert_eq!(normalize_path("/").as_deref(), Some("/"));
        assert_eq!(normalize_path("db").as_deref(), Some("/db"));
        assert_eq!(
            normalize_path("/db/primary/").as_deref(),
            Some("/db/primary")
        );
        for bad in ["/../x", "/a//b", "/a/./b", "/a b", "/é"] {
            assert_eq!(normalize_path(bad), None, "{bad}");
        }
        let deep = format!("/{}", ["a"; MAX_PATH_DEPTH + 1].join("/"));
        assert_eq!(normalize_path(&deep), None);
    }

    #[test]
    fn references_parse_every_documented_form() {
        assert_eq!(
            SecretRef::parse("API_KEY"),
            Some(SecretRef {
                environment: None,
                path: "/".into(),
                name: "API_KEY".into()
            })
        );
        assert_eq!(
            SecretRef::parse("/db/PASSWORD"),
            Some(SecretRef {
                environment: None,
                path: "/db".into(),
                name: "PASSWORD".into()
            })
        );
        assert_eq!(
            SecretRef::parse("prod:API_KEY"),
            Some(SecretRef {
                environment: Some("prod".into()),
                path: "/".into(),
                name: "API_KEY".into()
            })
        );
        assert_eq!(
            SecretRef::parse("prod:/db/main/PASSWORD")
                .unwrap()
                .policy_key("default"),
            "prod/db/main/PASSWORD"
        );
        for bad in ["", "db/PASSWORD", "Prod:KEY", "/../KEY", "prod:", "1BAD"] {
            assert_eq!(SecretRef::parse(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn every_sealed_table_is_listed_for_rewrap() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .unwrap();
            let rows = stmt.query_map([], |row| row.get(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        for table in tables {
            let columns: Vec<String> = {
                let mut stmt = conn
                    .prepare(&format!("PRAGMA table_info({table})"))
                    .unwrap();
                let rows = stmt.query_map([], |row| row.get::<_, String>(1)).unwrap();
                rows.collect::<rusqlite::Result<_>>().unwrap()
            };
            let sealed = ["key_version", "nonce", "ciphertext"]
                .iter()
                .all(|column| columns.iter().any(|c| c == column));
            assert_eq!(
                sealed,
                ENCRYPTED_TABLES.contains(&table.as_str()),
                "{table} sealed={sealed}"
            );
        }
    }

    #[test]
    fn policy_keys_omit_the_root_slash() {
        assert_eq!(policy_key("default", "/", "A"), "default/A");
        assert_eq!(policy_key("prod", "/db", "A"), "prod/db/A");
    }
}
