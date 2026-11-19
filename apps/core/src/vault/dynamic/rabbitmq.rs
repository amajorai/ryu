//! RabbitMQ users through the management HTTP API.
//!
//! Each lease is a user with a generated password, the role's tags, and
//! per-vhost permissions (`vhosts`) and topic permissions (`vhostTopics`).
//! Revocation deletes the user, which closes its connections' access at
//! once. Users have no expiry, so leases renew as bookkeeping.
//!
//! The admin account needs the `administrator` tag (users and permissions
//! are administrator-only in the management API).

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{self, HttpCall};
use super::naming;
use super::target_guard::TargetEgress;
use super::Issued;

const MAX_VHOSTS: usize = 32;

/// Regex grants on one vhost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VhostPermission {
    #[serde(default)]
    pub configure: String,
    #[serde(default)]
    pub write: String,
    #[serde(default)]
    pub read: String,
}

/// Regex grants on one topic exchange.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicPermission {
    #[serde(default)]
    pub write: String,
    #[serde(default)]
    pub read: String,
}

/// RabbitMQ provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RabbitMqConfig {
    /// Management API base, e.g. `https://rabbit.example.com:15671`.
    pub connection_uri: String,
    pub username: String,
    pub password: String,
    /// PEM CA for the management API (configuration managers only).
    #[serde(default)]
    pub ca_pem: Option<String>,
    /// Comma-separated user tags (e.g. `management`); none by default.
    #[serde(default)]
    pub tags: String,
    /// Permissions per vhost.
    pub vhosts: BTreeMap<String, VhostPermission>,
    /// Topic permissions per vhost, then per exchange.
    #[serde(default)]
    pub vhost_topics: BTreeMap<String, BTreeMap<String, TopicPermission>>,
    /// Generated username prefix (default `ryu`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

/// Percent-encode one path segment (vhost `/` becomes `%2F`).
fn segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn check_name(value: &str, what: &str) -> Result<()> {
    if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
        bail!("{what} `{value}` is invalid");
    }
    Ok(())
}

fn check_regex(value: &str) -> Result<()> {
    if value.len() > 1024 || value.chars().any(char::is_control) {
        bail!("permission patterns must be at most 1024 printable characters");
    }
    Ok(())
}

impl RabbitMqConfig {
    pub(super) fn validate(&self) -> Result<()> {
        http::check_https(&self.connection_uri, "connectionUri")?;
        if self.username.trim().is_empty() || self.password.is_empty() {
            bail!("username and password are required");
        }
        if self.vhosts.is_empty() || self.vhosts.len() > MAX_VHOSTS {
            bail!("vhosts must name 1 to {MAX_VHOSTS} vhosts");
        }
        for (vhost, grant) in &self.vhosts {
            check_name(vhost, "vhost")?;
            for pattern in [&grant.configure, &grant.write, &grant.read] {
                check_regex(pattern)?;
            }
        }
        if self.vhost_topics.len() > MAX_VHOSTS {
            bail!("vhostTopics may name at most {MAX_VHOSTS} vhosts");
        }
        for (vhost, exchanges) in &self.vhost_topics {
            check_name(vhost, "vhost")?;
            for (exchange, grant) in exchanges {
                check_name(exchange, "exchange")?;
                check_regex(&grant.write)?;
                check_regex(&grant.read)?;
            }
        }
        if self.tags.len() > 256
            || !self
                .tags
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b',' | b'_' | b'-' | b' '))
        {
            bail!("tags must be comma-separated tag names");
        }
        if let Some(pem) = &self.ca_pem {
            reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| anyhow!("caPem is not a PEM certificate"))?;
        }
        naming::validate_prefix(self.username_prefix.as_deref())
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
        json!({
            "host": http::check_https(&self.connection_uri, "connectionUri")
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|_| "invalid".into()),
            "vhosts": self.vhosts.keys().collect::<Vec<_>>(),
            "tags": self.tags,
        })
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        allow: &[u16],
    ) -> Result<()> {
        let url = format!("{}{path}", self.connection_uri.trim().trim_end_matches('/'));
        let mut call = HttpCall::new(method, url).ca(self.ca_pem.as_deref());
        let basic = B64.encode(format!("{}:{}", self.username, self.password));
        call.headers
            .push(("authorization".into(), format!("Basic {basic}")));
        if let Some(body) = body {
            call = call.json(body);
        }
        http::json(call, self.egress, "the RabbitMQ management API", allow).await?;
        Ok(())
    }

    async fn create_user(&self, name: &str, password: &str) -> Result<()> {
        let user = segment(name);
        self.call(
            "PUT",
            &format!("/api/users/{user}"),
            Some(&json!({ "password": password, "tags": self.tags })),
            &[],
        )
        .await?;
        for (vhost, grant) in &self.vhosts {
            self.call(
                "PUT",
                &format!("/api/permissions/{}/{user}", segment(vhost)),
                Some(&json!({
                    "configure": grant.configure,
                    "write": grant.write,
                    "read": grant.read,
                })),
                &[],
            )
            .await?;
        }
        for (vhost, exchanges) in &self.vhost_topics {
            for (exchange, grant) in exchanges {
                self.call(
                    "PUT",
                    &format!("/api/topic-permissions/{}/{user}", segment(vhost)),
                    Some(&json!({
                        "exchange": exchange,
                        "write": grant.write,
                        "read": grant.read,
                    })),
                    &[],
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn delete_user(&self, name: &str) -> Result<()> {
        self.call(
            "DELETE",
            &format!("/api/users/{}", segment(name)),
            None,
            &[404],
        )
        .await
    }
}

pub(super) async fn issue(config: &RabbitMqConfig, role: &str) -> Result<Issued> {
    let name = naming::generated_name(
        config.username_prefix.as_deref().unwrap_or("ryu"),
        role,
        '_',
        64,
    );
    let password = naming::strong_password();
    if let Err(error) = config.create_user(&name, &password).await {
        // Without a lease nothing would ever delete a half-made user.
        return Err(match config.delete_user(&name).await {
            Ok(()) => anyhow!("{error:#} (user `{name}`; cleanup ran)"),
            Err(cleanup) => anyhow!("{error:#} (user `{name}`; cleanup failed: {cleanup:#})"),
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

pub(super) async fn revoke(config: &RabbitMqConfig, revoke_data: &Value) -> Result<()> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .filter(|name| naming::is_generated_name(name, b'_'))
        .ok_or_else(|| anyhow!("lease username is malformed"))?;
    config.delete_user(name).await
}

#[cfg(test)]
#[path = "rabbitmq_test.rs"]
mod tests;
