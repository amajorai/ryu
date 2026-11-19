//! Microsoft SQL Server and Azure SQL dynamic credentials.
//!
//! Issue runs the role's creation statements (one batch each) with
//! `{{name}}` and `{{password}}` substituted, for example `CREATE LOGIN
//! [{{name}}] WITH PASSWORD = '{{password}}'` and `CREATE USER [{{name}}] FOR
//! LOGIN [{{name}}]`. Revoke runs the revocation statements, by default:
//! drop the database user, end the login's sessions, and drop the login.
//! Logins have no expiry, so renewal is lease bookkeeping and the reaper
//! revokes at lease end. Generated passwords meet SQL Server's complexity
//! policy. A failed issue runs the revocation statements to remove a
//! half-made login.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::mssql_wire::{Connection, Target};
use super::mysql::redact;
use super::naming;
use super::postgres::render;
use super::target_guard::TargetEgress;
use super::Issued;

const DEFAULT_REVOCATION: &[&str] = &[
    "IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{{name}}') DROP USER [{{name}}]",
    "DECLARE @kill NVARCHAR(MAX) = N''; SELECT @kill = @kill + N'KILL ' + CAST(session_id AS NVARCHAR(10)) + N';' FROM sys.dm_exec_sessions WHERE login_name = N'{{name}}'; EXEC(@kill)",
    "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'{{name}}') DROP LOGIN [{{name}}]",
];
const MAX_NAME: usize = 64;

/// SQL Server provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MssqlConfig {
    /// `sqlserver://admin:password@host:1433/db?encrypt=true` (`strict` for
    /// TDS 8.0, `false` only for servers without TLS).
    pub connection_url: String,
    /// Batches that create the login (and user).
    pub creation_statements: Vec<String>,
    /// Batches that remove it. Defaults to drop user, end sessions, drop login.
    #[serde(default)]
    pub revocation_statements: Vec<String>,
    /// PEM CA for the server certificate (configuration managers only).
    #[serde(default)]
    pub ca_pem: Option<String>,
    /// Username prefix (default `ryu`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// Username template (see [`super::username_template`]), instead of
    /// `usernamePrefix`; it must render lowercase letters, digits, or `_`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username_template: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

impl MssqlConfig {
    pub(super) fn validate(&self) -> Result<()> {
        Target::parse(&self.connection_url)?;
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
        if let Some(pem) = &self.ca_pem {
            let der = crate::vault::broker::ca::pem_to_der(pem)
                .map_err(|_| anyhow!("caPem is not a PEM certificate"))?;
            x509_parser::parse_x509_certificate(&der)
                .map_err(|_| anyhow!("caPem is not a PEM certificate"))?;
        }
        naming::validate_username_settings(
            self.username_template.as_deref(),
            self.username_prefix.as_deref(),
            MAX_NAME,
        )
    }

    /// `host:port/db` without credentials.
    pub(super) fn redacted_target(&self) -> String {
        Target::parse(&self.connection_url)
            .map(|target| format!("{}:{}/{}", target.host, target.port, target.database))
            .unwrap_or_else(|_| "invalid".to_owned())
    }

    pub(super) fn summary(&self) -> Value {
        json!({
            "host": self.redacted_target(),
            "statements": self.creation_statements.len(),
        })
    }

    async fn run(&self, statements: &[String], secret: &str) -> Result<()> {
        let target = Target::parse(&self.connection_url)?;
        let mut connection = Connection::open(&target, self.ca_pem.as_deref(), self.egress).await?;
        for statement in statements {
            connection
                .query(statement)
                .await
                .map_err(|error| redact(error, secret))?;
        }
        Ok(())
    }

    async fn drop_login(&self, name: &str) -> Result<()> {
        let statements: Vec<String> = if self.revocation_statements.is_empty() {
            DEFAULT_REVOCATION
                .iter()
                .map(|statement| render(statement, name, "", ""))
                .collect()
        } else {
            self.revocation_statements
                .iter()
                .map(|statement| render(statement, name, "", ""))
                .collect()
        };
        self.run(&statements, "").await
    }
}

pub(super) async fn issue(config: &MssqlConfig, role: &str, display_name: &str) -> Result<Issued> {
    let name = naming::lease_username(
        config.username_template.as_deref(),
        config.username_prefix.as_deref(),
        (role, display_name),
        MAX_NAME,
    )?;
    let password = naming::strong_password();
    let statements: Vec<String> = config
        .creation_statements
        .iter()
        .map(|statement| render(statement, &name, &password, ""))
        .collect();
    if let Err(error) = config.run(&statements, &password).await {
        let cleanup = config.drop_login(&name).await;
        return Err(match cleanup {
            Ok(()) => anyhow!("{error:#} (username `{name}`; cleanup ran)"),
            Err(cleanup) => anyhow!("{error:#} (username `{name}`; cleanup failed: {cleanup:#})"),
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

pub(super) async fn revoke(config: &MssqlConfig, revoke_data: &Value) -> Result<()> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("lease has no username"))?;
    if !naming::is_generated_name(name, b'_') {
        bail!("lease username is malformed");
    }
    config.drop_login(name).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::dynamic::mssql_wire::tests::{fake_mssql, Mode};

    fn config(url: &str, ca: &str) -> MssqlConfig {
        MssqlConfig {
            connection_url: url.to_owned(),
            creation_statements: vec![
                "CREATE LOGIN [{{name}}] WITH PASSWORD = '{{password}}'".into(),
                "CREATE USER [{{name}}] FOR LOGIN [{{name}}]".into(),
            ],
            revocation_statements: vec![],
            ca_pem: Some(ca.to_owned()),
            username_prefix: None,
            username_template: None,
            egress: TargetEgress::Trusted,
        }
    }

    #[test]
    fn validation_and_redaction() {
        let mut config = config("sqlserver://sa:pw@sql.internal:1444/app", "x");
        assert!(config.validate().is_err(), "caPem must be a certificate");
        config.ca_pem = None;
        config.validate().unwrap();
        assert_eq!(config.redacted_target(), "sql.internal:1444/app");
        assert!(!config.summary().to_string().contains("pw@"));
        config.creation_statements = vec!["SELECT 1".into()];
        assert!(config.validate().is_err());
    }

    #[tokio::test]
    async fn issue_and_revoke_run_the_batches_over_tls() {
        let (url, ca, log) = fake_mssql(Mode::Prelogin).await;
        let config = config(&url, &ca);
        let issued = issue(&config, "etl", "token").await.unwrap();
        let name = issued.data["username"].clone();
        let password = issued.data["password"].clone();
        assert!(name.starts_with("ryu_etl_"), "{name}");
        revoke(&config, &issued.revoke_data).await.unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(
            log[1],
            format!("CREATE LOGIN [{name}] WITH PASSWORD = '{password}'")
        );
        assert_eq!(log[2], format!("CREATE USER [{name}] FOR LOGIN [{name}]"));
        assert_eq!(
            log[4],
            format!("IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{name}') DROP USER [{name}]")
        );
        assert!(log[6].ends_with(&format!("DROP LOGIN [{name}]")));
    }

    #[tokio::test]
    async fn a_failed_batch_cleans_up_and_hides_the_password() {
        let (url, ca, log) = fake_mssql(Mode::Plain { require: false }).await;
        let mut config = config(&url, &ca);
        config.creation_statements =
            vec!["CREATE LOGIN [{{name}}] WITH PASSWORD = '{{password}}' FAIL".into()];
        let error = issue(&config, "x", "token")
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("[102]") && error.contains("cleanup ran"),
            "{error}"
        );
        assert!(
            error.contains("[redacted]") && !error.contains("Ry1-"),
            "{error}"
        );
        assert!(log.lock().unwrap().last().unwrap().contains("DROP LOGIN"));
    }

    #[tokio::test]
    async fn malformed_lease_usernames_never_reach_sql() {
        let (url, ca, log) = fake_mssql(Mode::Plain { require: false }).await;
        assert!(revoke(
            &config(&url, &ca),
            &json!({ "username": "x]; DROP LOGIN sa; --" })
        )
        .await
        .is_err());
        assert!(log.lock().unwrap().is_empty());
    }
}
