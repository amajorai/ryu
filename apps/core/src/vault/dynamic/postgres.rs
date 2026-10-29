//! PostgreSQL dynamic credentials.
//!
//! Issue runs the role's creation statements in one transaction with
//! `{{name}}`, `{{password}}`, and `{{expiration}}` substituted (the generated
//! name and password are lowercase-alphanumeric, so they are safe inside
//! quoted identifiers and literals); revoke runs the revocation statements (default: terminate the
//! role's sessions and `DROP ROLE`). TLS follows the connection URL's
//! `sslmode` (`disable`, `prefer`, `require`); the platform trust store is
//! used for verification.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{random_suffix, Issued};

const DEFAULT_REVOCATION: &[&str] = &[
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{{name}}'",
    "DROP ROLE IF EXISTS \"{{name}}\"",
];
const DEFAULT_RENEW: &str = "ALTER ROLE \"{{name}}\" VALID UNTIL '{{expiration}}'";

/// Postgres provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresConfig {
    /// `postgres://admin:password@host:5432/db?sslmode=require`.
    pub connection_url: String,
    /// Statements that create the role, e.g.
    /// `CREATE ROLE "{{name}}" LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'`.
    /// They run in one transaction, so statements Postgres forbids inside a
    /// transaction block (such as `CREATE DATABASE`) are not supported.
    pub creation_statements: Vec<String>,
    /// Statements that remove it. Defaults to terminate + `DROP ROLE`.
    #[serde(default)]
    pub revocation_statements: Vec<String>,
    /// Username prefix (default `ryu`).
    #[serde(default)]
    pub username_prefix: Option<String>,
}

impl PostgresConfig {
    pub(super) fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.connection_url).context("connectionUrl is not a URL")?;
        if !matches!(url.scheme(), "postgres" | "postgresql") {
            bail!("connectionUrl must be a postgres:// URL");
        }
        if self.creation_statements.is_empty() {
            bail!("creationStatements must not be empty");
        }
        if !self
            .creation_statements
            .iter()
            .any(|statement| statement.contains("{{name}}"))
        {
            bail!("creationStatements must reference {{{{name}}}}");
        }
        if let Some(prefix) = &self.username_prefix {
            if prefix.is_empty()
                || prefix.len() > 16
                || !prefix
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            {
                bail!("usernamePrefix must be 1-16 lowercase letters, digits, or underscores");
            }
        }
        Ok(())
    }

    /// `host:port/db` without credentials.
    pub(super) fn redacted_target(&self) -> String {
        url::Url::parse(&self.connection_url)
            .map(|url| {
                format!(
                    "{}:{}{}",
                    url.host_str().unwrap_or("?"),
                    url.port().unwrap_or(5432),
                    url.path()
                )
            })
            .unwrap_or_else(|_| "invalid".to_owned())
    }

    fn tls_mode(&self) -> &'static str {
        let url = url::Url::parse(&self.connection_url).ok();
        let mode = url.as_ref().and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "sslmode")
                .map(|(_, value)| value.into_owned())
        });
        match mode.as_deref() {
            Some("disable") => "disable",
            Some("require" | "verify-ca" | "verify-full") => "require",
            _ => "prefer",
        }
    }
}

fn expiration(ttl_secs: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(ttl_secs))
        .format("%Y-%m-%d %H:%M:%S%z")
        .to_string()
}

pub(crate) fn render(statement: &str, name: &str, password: &str, expiration: &str) -> String {
    statement
        .replace("{{name}}", name)
        .replace("{{password}}", password)
        .replace("{{expiration}}", expiration)
}

pub(super) async fn connect(config: &PostgresConfig) -> Result<tokio_postgres::Client> {
    let mode = config.tls_mode();
    // tokio-postgres reads `sslmode` itself; strip it so `require` maps onto
    // our connector and unknown values never reach the parser.
    let mut url = url::Url::parse(&config.connection_url)?;
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "sslmode")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    if url.query() == Some("") {
        url.set_query(None);
    }
    let mut pg: tokio_postgres::Config = url.as_str().parse().context("parsing connectionUrl")?;
    pg.connect_timeout(std::time::Duration::from_secs(10));
    if mode == "disable" {
        pg.ssl_mode(tokio_postgres::config::SslMode::Disable);
        let (client, connection) = pg.connect(tokio_postgres::NoTls).await?;
        tokio::spawn(connection);
        return Ok(client);
    }
    pg.ssl_mode(if mode == "require" {
        tokio_postgres::config::SslMode::Require
    } else {
        tokio_postgres::config::SslMode::Prefer
    });
    let connector = native_tls::TlsConnector::new().context("building TLS connector")?;
    let (client, connection) = pg
        .connect(postgres_native_tls::MakeTlsConnector::new(connector))
        .await
        .context("connecting to postgres")?;
    tokio::spawn(connection);
    Ok(client)
}

pub(super) async fn run(client: &tokio_postgres::Client, statements: &[String]) -> Result<()> {
    for statement in statements {
        client
            .batch_execute(statement)
            .await
            .map_err(|error| anyhow!("postgres statement failed: {error}"))?;
    }
    Ok(())
}

/// Run creation statements in one transaction, so a later statement's
/// failure rolls back a role an earlier one created.
async fn run_in_transaction(
    client: &mut tokio_postgres::Client,
    statements: &[String],
) -> Result<()> {
    let transaction = client
        .transaction()
        .await
        .map_err(|error| anyhow!("postgres transaction failed to start: {error}"))?;
    for statement in statements {
        transaction
            .batch_execute(statement)
            .await
            .map_err(|error| anyhow!("postgres statement failed: {error}"))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| anyhow!("postgres commit failed: {error}"))
}

pub(super) async fn issue(config: &PostgresConfig, role: &str, ttl_secs: i64) -> Result<Issued> {
    let prefix = config.username_prefix.as_deref().unwrap_or("ryu");
    let role_part: String = role
        .bytes()
        .filter(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        .take(16)
        .map(char::from)
        .collect();
    let name = format!("{prefix}_{role_part}_{}", random_suffix(10));
    let password = random_suffix(32);
    let expires = expiration(ttl_secs);
    let statements: Vec<String> = config
        .creation_statements
        .iter()
        .map(|statement| render(statement, &name, &password, &expires))
        .collect();
    let mut client = connect(config).await?;
    if let Err(error) = run_in_transaction(&mut client, &statements).await {
        // The transaction rolled back, so a role created by an earlier
        // statement is gone. A COMMIT the server applied but whose reply was
        // lost would still leave it behind, and without a lease nothing could
        // revoke it later, so drop it now on a best-effort basis.
        let cleanup = revoke(config, &json!({ "username": name })).await;
        return Err(match cleanup {
            Ok(()) => anyhow!("{error} (username `{name}`; cleanup ran)"),
            Err(cleanup_error) => {
                anyhow!("{error} (username `{name}`; cleanup failed: {cleanup_error})")
            }
        });
    }
    Ok(Issued {
        data: BTreeMap::from([
            ("username".to_owned(), name.clone()),
            ("password".to_owned(), password),
        ]),
        revoke_data: json!({ "username": name }),
        ttl_cap_secs: None,
    })
}

fn username(revoke_data: &Value) -> Result<&str> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("lease has no username"))?;
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        bail!("lease username is malformed");
    }
    Ok(name)
}

pub(super) async fn renew(
    config: &PostgresConfig,
    revoke_data: &Value,
    ttl_secs: i64,
) -> Result<()> {
    let name = username(revoke_data)?;
    let client = connect(config).await?;
    run(
        &client,
        &[render(DEFAULT_RENEW, name, "", &expiration(ttl_secs))],
    )
    .await
}

pub(super) async fn revoke(config: &PostgresConfig, revoke_data: &Value) -> Result<()> {
    let name = username(revoke_data)?;
    let statements: Vec<String> = if config.revocation_statements.is_empty() {
        DEFAULT_REVOCATION
            .iter()
            .map(|s| render(s, name, "", ""))
            .collect()
    } else {
        config
            .revocation_statements
            .iter()
            .map(|s| render(s, name, "", ""))
            .collect()
    };
    let client = connect(config).await?;
    run(&client, &statements).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PostgresConfig {
        PostgresConfig {
            connection_url: "postgres://admin:pw@db.internal:6543/app?sslmode=require".into(),
            creation_statements: vec![
                "CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'"
                    .into(),
            ],
            revocation_statements: vec![],
            username_prefix: None,
        }
    }

    #[test]
    fn validation_and_redaction() {
        let config = config();
        config.validate().unwrap();
        assert_eq!(config.redacted_target(), "db.internal:6543/app");
        assert_eq!(config.tls_mode(), "require");
        let mut bad = config.clone();
        bad.creation_statements = vec!["SELECT 1".into()];
        assert!(bad.validate().is_err());
        bad = config;
        bad.connection_url = "mysql://x".into();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn statements_render_placeholders() {
        assert_eq!(
            render(
                "CREATE ROLE \"{{name}}\" PASSWORD '{{password}}'",
                "ryu_a",
                "pw",
                ""
            ),
            "CREATE ROLE \"ryu_a\" PASSWORD 'pw'"
        );
    }

    #[test]
    fn malformed_usernames_never_reach_sql() {
        assert!(username(&json!({ "username": "x\"; DROP TABLE t; --" })).is_err());
        assert_eq!(
            username(&json!({ "username": "ryu_db_abc" })).unwrap(),
            "ryu_db_abc"
        );
    }

    /// Live round-trip against `RYU_VAULT_TEST_POSTGRES_URL` when set.
    #[tokio::test]
    async fn live_round_trip_when_configured() {
        let Ok(url) = std::env::var("RYU_VAULT_TEST_POSTGRES_URL") else {
            return;
        };
        let mut config = config();
        config.connection_url = url;
        let issued = issue(&config, "test", 60).await.unwrap();
        renew(&config, &issued.revoke_data, 120).await.unwrap();
        revoke(&config, &issued.revoke_data).await.unwrap();
    }
}
