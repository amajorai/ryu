//! The account a static role manages: its configuration, validation, and
//! the non-secret views (`account`, `summary`) listings and edits use.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::postgres::{self, PostgresConfig};
use super::super::redis;
use super::super::target_guard::TargetEgress;
use super::super::webhook::{self, WebhookConfig};
use super::ai_keys;

const DEFAULT_PG_ROTATION: &str = "ALTER ROLE \"{{name}}\" WITH PASSWORD '{{password}}'";

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
    /// OpenAI: each rotation creates a project service account; its API key
    /// is the value. The previous service account is then deleted.
    #[serde(rename = "openai", rename_all = "camelCase")]
    OpenAi {
        /// Organization Admin API key (`api.management.write`).
        admin_api_key: String,
        /// The project (`proj_…`) the service accounts belong to.
        project_id: String,
        /// Name prefix for the service accounts Ryu creates.
        #[serde(default = "ai_keys::default_service_account_name")]
        service_account_name: String,
        /// The service account holding the current key, deleted by the next
        /// rotation. Core-managed once it has rotated.
        #[serde(default)]
        current_service_account_id: Option<String>,
    },
    /// Anthropic: the Admin API cannot create keys, so a person stages a
    /// replacement key; rotation writes it and deactivates the previous key.
    #[serde(rename = "anthropic", rename_all = "camelCase")]
    Anthropic {
        /// Organization Admin API key (`sk-ant-admin…`).
        admin_api_key: String,
        /// Limit key lookups to one workspace.
        #[serde(default)]
        workspace_id: Option<String>,
        /// A key created in the Console, waiting to become the value.
        #[serde(default)]
        replacement_api_key: Option<String>,
        /// The id of the current key, deactivated by the next rotation.
        #[serde(default)]
        current_api_key_id: Option<String>,
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
            Self::OpenAi { .. } => "openai",
            Self::Anthropic { .. } => "anthropic",
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
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
                    egress: TargetEgress::default(),
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
            Self::OpenAi {
                admin_api_key,
                project_id,
                service_account_name,
                current_service_account_id,
            } => ai_keys::validate_openai(
                admin_api_key,
                project_id,
                service_account_name,
                current_service_account_id.as_deref(),
            ),
            Self::Anthropic {
                admin_api_key,
                workspace_id,
                replacement_api_key,
                current_api_key_id,
            } => ai_keys::validate_anthropic(
                admin_api_key,
                workspace_id.as_deref(),
                replacement_api_key.as_deref(),
                current_api_key_id.as_deref(),
            ),
        }
    }

    /// The managed account: provider kind plus host/endpoint and user. Two
    /// configurations with the same account rotate the same credential, even
    /// when their admin credentials or statements differ.
    pub(super) fn account(&self) -> Value {
        match self {
            Self::AwsIam { user_name, .. } => json!({ "kind": "aws-iam", "userName": user_name }),
            Self::OpenAi { project_id, .. } => json!({ "kind": "openai", "projectId": project_id }),
            Self::Anthropic { workspace_id, .. } => {
                json!({ "kind": "anthropic", "workspaceId": workspace_id })
            }
            other => json!({ "kind": other.kind(), "account": other.summary() }),
        }
    }

    /// Core-managed fields carried over from the stored configuration of the
    /// same account. The current key id is rewritten by every rotation, so a
    /// caller's (possibly stale) value is honored only before Core has
    /// recorded one. A staged Anthropic replacement that has not been used
    /// yet survives an edit that does not send one.
    pub(super) fn with_managed_fields_from(&self, stored: &Self) -> Self {
        let mut merged = self.clone();
        if let Some(stored_id) = stored.current_key_id() {
            merged.set_current_key_id(Some(stored_id));
        }
        if let (
            Self::Anthropic {
                replacement_api_key: replacement @ None,
                ..
            },
            Self::Anthropic {
                replacement_api_key: Some(staged),
                ..
            },
        ) = (&mut merged, stored)
        {
            *replacement = Some(staged.clone());
        }
        merged
    }

    /// Whether rotation mints (or adopts) a new upstream key with an id,
    /// instead of setting a generated password.
    pub(super) fn mints_keys(&self) -> bool {
        matches!(
            self,
            Self::AwsIam { .. } | Self::OpenAi { .. } | Self::Anthropic { .. }
        )
    }

    /// The upstream id of the key the target value currently holds.
    pub(super) fn current_key_id(&self) -> Option<String> {
        match self {
            Self::AwsIam {
                current_access_key_id: id,
                ..
            }
            | Self::OpenAi {
                current_service_account_id: id,
                ..
            }
            | Self::Anthropic {
                current_api_key_id: id,
                ..
            } => id.clone(),
            _ => None,
        }
    }

    pub(super) fn set_current_key_id(&mut self, value: Option<String>) {
        match self {
            Self::AwsIam {
                current_access_key_id: id,
                ..
            }
            | Self::OpenAi {
                current_service_account_id: id,
                ..
            }
            | Self::Anthropic {
                current_api_key_id: id,
                ..
            } => *id = value,
            _ => {}
        }
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
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
                    egress: TargetEgress::default(),
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
            Self::OpenAi {
                project_id,
                service_account_name,
                ..
            } => json!({ "projectId": project_id, "serviceAccountName": service_account_name }),
            Self::Anthropic {
                workspace_id,
                replacement_api_key,
                ..
            } => json!({
                "workspaceId": workspace_id,
                "replacementStaged": replacement_api_key.is_some(),
            }),
        }
    }
}

/// Apply a password upstream. Returns the value to store (the webhook may
/// supply its own).
pub(super) async fn apply_password(
    provider: &StaticProvider,
    role: &str,
    password: &str,
    egress: TargetEgress,
) -> Result<String> {
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
                egress,
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
            redis::rotate_password(connection_url, username, password, egress).await?;
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
                egress,
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
        StaticProvider::AwsIam { .. }
        | StaticProvider::OpenAi { .. }
        | StaticProvider::Anthropic { .. } => {
            bail!("{} roles rotate keys, not passwords", provider.kind())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anthropic(replacement: Option<&str>, current: Option<&str>) -> StaticProvider {
        StaticProvider::Anthropic {
            admin_api_key: "sk-ant-admin01-x".into(),
            workspace_id: None,
            replacement_api_key: replacement.map(str::to_owned),
            current_api_key_id: current.map(str::to_owned),
        }
    }

    #[test]
    fn edits_keep_the_current_key_id_and_an_unused_staged_key() {
        let stored = anthropic(Some("sk-ant-api03-staged"), Some("apikey_1"));
        let merged = anthropic(None, None).with_managed_fields_from(&stored);
        assert_eq!(merged, stored);
        // A newly staged key replaces the stored one; the id stays Core's.
        let merged =
            anthropic(Some("sk-ant-api03-new"), Some("apikey_9")).with_managed_fields_from(&stored);
        assert_eq!(
            merged,
            anthropic(Some("sk-ant-api03-new"), Some("apikey_1"))
        );
        assert!(merged.mints_keys());
        assert_eq!(stored.account(), anthropic(None, None).account());
    }

    #[tokio::test]
    async fn key_minting_providers_never_take_a_password() {
        let error = apply_password(
            &anthropic(None, None),
            "role",
            "pw",
            TargetEgress::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("anthropic roles rotate keys"));
    }
}
