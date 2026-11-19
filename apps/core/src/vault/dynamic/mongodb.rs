//! MongoDB dynamic credentials.
//!
//! Issue runs `createUser` with a generated name and password and the role's
//! `roles` (SCRAM-SHA-256 only); revoke runs `dropUser`, treating a user that
//! is already gone as revoked. MongoDB users have no expiry, so renewal is
//! lease bookkeeping and the reaper drops the user when the lease ends.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::mongo_wire::{Bson, Connection, Target};
use super::naming;
use super::target_guard::TargetEgress;
use super::Issued;

/// MongoDB's `UserNotFound`.
const USER_NOT_FOUND: i32 = 11;

/// One granted role, e.g. `{"role": "readWrite", "db": "app"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRole {
    pub role: String,
    /// Database the role applies to (default: the user's database).
    #[serde(default)]
    pub db: Option<String>,
}

/// MongoDB provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoConfig {
    /// `mongodb://admin:password@host:27017/?authSource=admin&tls=true`.
    pub connection_url: String,
    /// Database the users are created in (default `admin`).
    #[serde(default)]
    pub database: Option<String>,
    /// Roles each issued user receives.
    pub roles: Vec<MongoRole>,
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

fn is_db_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name
            .bytes()
            .any(|b| matches!(b, b'/' | b'\\' | b'.' | b' ' | b'"' | b'$' | 0))
}

impl MongoConfig {
    pub(super) fn validate(&self) -> Result<()> {
        Target::parse(&self.connection_url)?;
        if !is_db_name(self.database()) {
            bail!("database is not a valid MongoDB database name");
        }
        if self.roles.is_empty() {
            bail!("roles must name at least one role");
        }
        for role in &self.roles {
            if role.role.is_empty()
                || role.role.len() > 128
                || role.role.bytes().any(|b| b.is_ascii_control())
            {
                bail!("role names must be 1-128 printable characters");
            }
            if role.db.as_deref().is_some_and(|db| !is_db_name(db)) {
                bail!(
                    "role db `{}` is not a valid database name",
                    role.db.as_deref().unwrap_or_default()
                );
            }
        }
        naming::validate_username_settings(
            self.username_template.as_deref(),
            self.username_prefix.as_deref(),
            64,
        )
    }

    fn database(&self) -> &str {
        self.database.as_deref().unwrap_or("admin")
    }

    /// `host:port/database` without credentials.
    pub(super) fn redacted_target(&self) -> String {
        Target::parse(&self.connection_url)
            .map(|target| format!("{}:{}/{}", target.host, target.port, self.database()))
            .unwrap_or_else(|_| "invalid".to_owned())
    }

    pub(super) fn summary(&self) -> Value {
        json!({ "host": self.redacted_target(), "roles": self.roles.len() })
    }

    async fn connect(&self) -> Result<Connection> {
        Connection::open(&Target::parse(&self.connection_url)?, self.egress).await
    }

    async fn drop_user(&self, name: &str) -> Result<()> {
        self.connect()
            .await?
            .command(
                vec![
                    ("dropUser".into(), Bson::String(name.to_owned())),
                    ("$db".into(), Bson::String(self.database().to_owned())),
                ],
                &[USER_NOT_FOUND],
            )
            .await?;
        Ok(())
    }
}

pub(super) async fn issue(config: &MongoConfig, role: &str, display_name: &str) -> Result<Issued> {
    let name = naming::lease_username(
        config.username_template.as_deref(),
        config.username_prefix.as_deref(),
        (role, display_name),
        64,
    )?;
    let password = naming::strong_password();
    let roles = config
        .roles
        .iter()
        .map(|grant| {
            Bson::Document(vec![
                ("role".into(), Bson::String(grant.role.clone())),
                (
                    "db".into(),
                    Bson::String(
                        grant
                            .db
                            .clone()
                            .unwrap_or_else(|| config.database().to_owned()),
                    ),
                ),
            ])
        })
        .collect();
    let created = async {
        config
            .connect()
            .await?
            .command(
                vec![
                    ("createUser".into(), Bson::String(name.clone())),
                    ("pwd".into(), Bson::String(password.clone())),
                    ("roles".into(), Bson::Array(roles)),
                    (
                        "mechanisms".into(),
                        Bson::Array(vec![Bson::String("SCRAM-SHA-256".into())]),
                    ),
                    ("$db".into(), Bson::String(config.database().to_owned())),
                ],
                &[],
            )
            .await
    }
    .await;
    if let Err(error) = created {
        // A reply lost after the server created the user would leave it
        // behind with no lease to revoke it.
        let cleanup = config.drop_user(&name).await;
        return Err(match cleanup {
            Ok(()) => anyhow!("{error:#} (username `{name}`; cleanup ran)"),
            Err(cleanup) => anyhow!("{error:#} (username `{name}`; cleanup failed: {cleanup:#})"),
        });
    }
    Ok(Issued {
        data: BTreeMap::from([
            ("username".to_owned(), name.clone()),
            ("password".to_owned(), password),
            ("database".to_owned(), config.database().to_owned()),
        ]),
        revoke_data: json!({ "username": name }),
        ttl_cap_secs: None,
    })
}

pub(super) async fn revoke(config: &MongoConfig, revoke_data: &Value) -> Result<()> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("lease has no username"))?;
    if !naming::is_generated_name(name, b'_') {
        bail!("lease username is malformed");
    }
    config.drop_user(name).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::dynamic::mongo_wire::{get, tests::fake_mongo};

    fn config(url: &str) -> MongoConfig {
        MongoConfig {
            connection_url: url.to_owned(),
            database: Some("app".into()),
            roles: vec![
                MongoRole {
                    role: "readWrite".into(),
                    db: None,
                },
                MongoRole {
                    role: "read".into(),
                    db: Some("reports".into()),
                },
            ],
            username_prefix: None,
            username_template: None,
            egress: TargetEgress::Trusted,
        }
    }

    #[test]
    fn validation_and_redaction() {
        let mut config = config("mongodb://admin:pw@db.internal:27018/?authSource=admin");
        config.validate().unwrap();
        assert_eq!(config.redacted_target(), "db.internal:27018/app");
        assert!(!config.summary().to_string().contains("pw"));
        config.roles[1].db = Some("a.b".into());
        assert!(config.validate().is_err());
        config.roles.clear();
        assert!(config.validate().is_err());
    }

    #[tokio::test]
    async fn issue_creates_and_revoke_drops_the_user() {
        let (url, log) = fake_mongo(false).await;
        let config = config(&url);
        let issued = issue(&config, "orders", "token").await.unwrap();
        let name = issued.data["username"].clone();
        assert!(name.starts_with("ryu_orders_"), "{name}");
        assert_eq!(issued.data["database"], "app");
        revoke(&config, &issued.revoke_data).await.unwrap();
        // A user that is already gone counts as revoked.
        revoke(&config, &json!({ "username": "missing" }))
            .await
            .unwrap();
        let log = log.lock().unwrap().clone();
        let created = &log[0];
        assert_eq!(
            get(created, "createUser"),
            Some(&Bson::String(name.clone()))
        );
        assert_eq!(
            get(created, "pwd"),
            Some(&Bson::String(issued.data["password"].clone()))
        );
        assert_eq!(get(created, "$db"), Some(&Bson::String("app".into())));
        let Some(Bson::Array(roles)) = get(created, "roles") else {
            panic!("no roles");
        };
        assert_eq!(
            roles[1],
            Bson::Document(vec![
                ("role".into(), Bson::String("read".into())),
                ("db".into(), Bson::String("reports".into())),
            ])
        );
        assert_eq!(get(&log[1], "dropUser"), Some(&Bson::String(name)));
    }

    #[tokio::test]
    async fn a_refused_create_reports_and_cleans_up() {
        let (url, log) = fake_mongo(false).await;
        let mut config = config(&url);
        config.roles = vec![MongoRole {
            role: "boom".into(),
            db: None,
        }];
        let error = issue(&config, "x", "token")
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("No role named boom") && error.contains("cleanup ran"),
            "{error}"
        );
        assert!(!error.contains("Ry1-"), "{error}");
        let log = log.lock().unwrap().clone();
        assert!(get(&log[0], "dropUser").is_some());
    }

    #[tokio::test]
    async fn malformed_lease_usernames_are_never_sent() {
        let (url, log) = fake_mongo(false).await;
        assert!(revoke(&config(&url), &json!({ "username": "root\"" }))
            .await
            .is_err());
        assert!(log.lock().unwrap().is_empty());
    }
}
