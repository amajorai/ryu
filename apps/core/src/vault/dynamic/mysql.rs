//! MySQL and MariaDB dynamic credentials.
//!
//! Issue runs the role's creation statements with `{{name}}` and
//! `{{password}}` substituted (for example `CREATE USER '{{name}}'@'%'
//! IDENTIFIED BY '{{password}}'` and a `GRANT`); revoke runs the revocation
//! statements (default `DROP USER IF EXISTS '{{name}}'@'%'`). MySQL has no
//! per-account expiry, so renewal is lease bookkeeping and the reaper drops
//! the account when the lease ends. MySQL DDL commits on its own, so a failed
//! issue runs the revocation statements to remove a half-made account.
//!
//! TLS follows the URL's `ssl-mode` (`DISABLED`, `PREFERRED` (default),
//! `REQUIRED`) and verifies against the platform trust store. Generated
//! names fit MySQL's 32-character limit.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::mysql_wire::{Connection, Target};
use super::naming;
use super::postgres::render;
use super::target_guard::TargetEgress;
use super::Issued;

const DEFAULT_REVOCATION: &[&str] = &["DROP USER IF EXISTS '{{name}}'@'%'"];
const MAX_NAME: usize = 32;

/// MySQL provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlConfig {
    /// `mysql://admin:password@host:3306/db?ssl-mode=REQUIRED`.
    pub connection_url: String,
    /// Statements that create the account (each must be one statement).
    pub creation_statements: Vec<String>,
    /// Statements that remove it. Defaults to `DROP USER IF EXISTS`.
    #[serde(default)]
    pub revocation_statements: Vec<String>,
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

impl MysqlConfig {
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
        naming::validate_username_settings(
            self.username_template.as_deref(),
            self.username_prefix.as_deref(),
            MAX_NAME,
        )?;
        if self.username_prefix.as_deref().unwrap_or("ryu").len() > 16 {
            bail!("usernamePrefix is too long");
        }
        Ok(())
    }

    /// `host:port/db` without credentials.
    pub(super) fn redacted_target(&self) -> String {
        Target::parse(&self.connection_url)
            .map(|target| {
                format!(
                    "{}:{}/{}",
                    target.host,
                    target.port,
                    target.database.unwrap_or_default()
                )
            })
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
        let mut connection = Connection::open(&target, self.egress).await?;
        for statement in statements {
            connection
                .query(statement)
                .await
                .map_err(|error| redact(error, secret))?;
        }
        Ok(())
    }

    async fn drop_account(&self, name: &str) -> Result<()> {
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

/// MySQL syntax errors quote the statement, which holds the new password.
pub(crate) fn redact(error: anyhow::Error, secret: &str) -> anyhow::Error {
    let text = format!("{error:#}");
    if secret.is_empty() || !text.contains(secret) {
        return error;
    }
    anyhow!("{}", text.replace(secret, "[redacted]"))
}

pub(super) async fn issue(config: &MysqlConfig, role: &str, display_name: &str) -> Result<Issued> {
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
        let cleanup = config.drop_account(&name).await;
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

pub(super) async fn revoke(config: &MysqlConfig, revoke_data: &Value) -> Result<()> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("lease has no username"))?;
    if !naming::is_generated_name(name, b'_') {
        bail!("lease username is malformed");
    }
    config.drop_account(name).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::dynamic::mysql_wire::tests::{fake_mysql, FakeMysql};

    fn config(url: &str) -> MysqlConfig {
        MysqlConfig {
            connection_url: url.to_owned(),
            creation_statements: vec![
                "CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'".into(),
                "GRANT SELECT ON app.* TO '{{name}}'@'%'".into(),
            ],
            revocation_statements: vec![],
            username_prefix: None,
            username_template: None,
            egress: TargetEgress::Trusted,
        }
    }

    #[test]
    fn validation_and_redaction() {
        let config = config("mysql://admin:pw@db.internal:3307/app");
        config.validate().unwrap();
        assert_eq!(config.redacted_target(), "db.internal:3307/app");
        assert!(!config.summary().to_string().contains("pw@"));
        let mut bad = config.clone();
        bad.creation_statements = vec!["SELECT 1".into()];
        assert!(bad.validate().is_err());
        bad = config;
        bad.connection_url = "postgres://x".into();
        assert!(bad.validate().is_err());
    }

    #[tokio::test]
    async fn issue_and_revoke_run_the_statements() {
        let (url, log) = fake_mysql(FakeMysql::NATIVE).await;
        let config = config(&url);
        let issued = issue(&config, "reporting", "token").await.unwrap();
        let name = issued.data["username"].clone();
        let password = issued.data["password"].clone();
        assert!(
            name.starts_with("ryu_reporting_") && name.len() <= MAX_NAME,
            "{name}"
        );
        revoke(&config, &issued.revoke_data).await.unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(
            log[1],
            format!("CREATE USER '{name}'@'%' IDENTIFIED BY '{password}'")
        );
        assert_eq!(log[2], format!("GRANT SELECT ON app.* TO '{name}'@'%'"));
        assert_eq!(log[4], format!("DROP USER IF EXISTS '{name}'@'%'"));
    }

    #[tokio::test]
    async fn a_failed_grant_drops_the_account_and_hides_the_password() {
        let (url, log) = fake_mysql(FakeMysql::NATIVE).await;
        let mut config = config(&url);
        config.creation_statements =
            vec!["CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}' FAIL".into()];
        let error = issue(&config, "x", "token")
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("[1064]") && error.contains("cleanup ran"),
            "{error}"
        );
        assert!(error.contains("[redacted]"), "{error}");
        assert!(!error.contains("Ry1-"), "{error}");
        assert!(log
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .starts_with("DROP USER IF EXISTS"));
    }

    #[tokio::test]
    async fn username_templates_name_the_account() {
        let (url, log) = fake_mysql(FakeMysql::NATIVE).await;
        let mut config = config(&url);
        config.username_template = Some("app_{{.RoleName}}_{{random 6}}".into());
        config.validate().unwrap();
        let issued = issue(&config, "billing", "token").await.unwrap();
        let name = issued.data["username"].clone();
        assert!(
            name.starts_with("app_billing_") && name.len() == 18,
            "{name}"
        );
        assert!(log.lock().unwrap()[1].contains(&format!("'{name}'@'%'")));
        config.username_prefix = Some("svc".into());
        assert!(config.validate().is_err(), "prefix and template together");
    }

    #[tokio::test]
    async fn malformed_lease_usernames_never_reach_sql() {
        let (url, log) = fake_mysql(FakeMysql::NATIVE).await;
        let config = config(&url);
        assert!(revoke(
            &config,
            &json!({ "username": "x'@'%'; DROP USER root; --" })
        )
        .await
        .is_err());
        assert!(log.lock().unwrap().is_empty());
    }
}
