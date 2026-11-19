//! The provider configuration a dynamic role stores, and the dispatch from a
//! role to its provider's issue, renew, and revoke.
//!
//! test-exempt: dispatch only; each provider is tested in its own module and the
//! store paths in `dynamic/tests.rs`.

use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    aws, aws_iam, azure, gcp, kubernetes, kubernetes_rules, mongodb, mssql, mysql, postgres,
    rabbitmq, random_generator, redis, webhook, Issued,
};
use crate::plugin_secrets::kv::Charset;

/// Provider configuration. Serialized and sealed as one blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProviderConfig {
    #[serde(rename = "postgres")]
    Postgres(postgres::PostgresConfig),
    #[serde(rename = "mysql", alias = "mariadb")]
    Mysql(mysql::MysqlConfig),
    #[serde(rename = "mssql")]
    Mssql(mssql::MssqlConfig),
    #[serde(rename = "mongodb")]
    Mongodb(mongodb::MongoConfig),
    #[serde(rename = "aws-sts")]
    AwsSts(aws::AwsStsConfig),
    #[serde(rename = "aws-iam")]
    AwsIam(aws_iam::AwsIamUserConfig),
    #[serde(rename = "gcp")]
    Gcp(gcp::GcpConfig),
    #[serde(rename = "azure")]
    Azure(azure::AzureConfig),
    #[serde(rename = "kubernetes")]
    Kubernetes(kubernetes::KubernetesConfig),
    #[serde(rename = "kubernetes-rules")]
    KubernetesRules(kubernetes_rules::KubernetesRulesConfig),
    #[serde(rename = "rabbitmq")]
    RabbitMq(rabbitmq::RabbitMqConfig),
    #[serde(rename = "webhook")]
    Webhook(webhook::WebhookConfig),
    #[serde(rename = "redis", alias = "valkey")]
    Redis(redis::RedisConfig),
    #[serde(rename = "random")]
    Random {
        length: u16,
        charset: Charset,
        /// Key the value is returned under (default `value`).
        #[serde(default)]
        field: Option<String>,
    },
}

impl ProviderConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "postgres",
            Self::Mysql(_) => "mysql",
            Self::Mssql(_) => "mssql",
            Self::Mongodb(_) => "mongodb",
            Self::AwsSts(_) => "aws-sts",
            Self::AwsIam(_) => "aws-iam",
            Self::Gcp(_) => "gcp",
            Self::Azure(_) => "azure",
            Self::Kubernetes(_) => "kubernetes",
            Self::KubernetesRules(_) => "kubernetes-rules",
            Self::RabbitMq(_) => "rabbitmq",
            Self::Webhook(_) => "webhook",
            Self::Redis(_) => "redis",
            Self::Random { .. } => "random",
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Postgres(config) => config.validate(),
            Self::Mysql(config) => config.validate(),
            Self::Mssql(config) => config.validate(),
            Self::Mongodb(config) => config.validate(),
            Self::AwsSts(config) => config.validate(),
            Self::AwsIam(config) => config.validate(),
            Self::Gcp(config) => config.validate(),
            Self::Azure(config) => config.validate(),
            Self::Kubernetes(config) => config.validate(),
            Self::KubernetesRules(config) => config.validate(),
            Self::RabbitMq(config) => config.validate(),
            Self::Webhook(config) => config.validate(),
            Self::Redis(config) => config.validate(),
            Self::Random {
                length, charset, ..
            } => random_generator(*length, *charset).validate(),
        }
    }

    /// Whether a lease can outlive its first TTL. Credentials with a fixed
    /// upstream expiry (STS sessions, Kubernetes tokens, GCP access tokens,
    /// Azure secrets) cannot.
    pub(super) fn renewable(&self) -> bool {
        match self {
            Self::AwsSts(_) | Self::Azure(_) | Self::Kubernetes(_) | Self::KubernetesRules(_) => {
                false
            }
            Self::Gcp(config) => config.renewable(),
            _ => true,
        }
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
        match self {
            Self::Postgres(config) => json!({
                "host": config.redacted_target(),
                "statements": config.creation_statements.len(),
            }),
            Self::Mysql(config) => config.summary(),
            Self::Mssql(config) => config.summary(),
            Self::Mongodb(config) => config.summary(),
            Self::AwsSts(config) => json!({ "roleArn": config.role_arn, "region": config.region }),
            Self::Gcp(config) => config.summary(),
            Self::Azure(config) => config.summary(),
            Self::Kubernetes(config) => config.summary(),
            Self::KubernetesRules(config) => config.summary(),
            Self::RabbitMq(config) => config.summary(),
            Self::AwsIam(config) => config.summary(),
            // Only the origin: userinfo, query, fragment and path can carry
            // tokens, and summaries reach audit rows and role listings.
            Self::Webhook(config) => json!({ "url": webhook::url_origin(&config.url) }),
            Self::Redis(config) => json!({
                "host": config.redacted_target(),
                "rules": config.acl_rules.len(),
            }),
            Self::Random {
                length, charset, ..
            } => json!({ "length": length, "charset": charset }),
        }
    }

    /// Mint a credential for `role`. `display_name` (the caller) feeds
    /// `usernameTemplate`.
    pub(super) async fn issue(
        &self,
        role: &str,
        display_name: &str,
        ttl_secs: i64,
    ) -> Result<Issued> {
        match self {
            Self::Postgres(config) => postgres::issue(config, role, display_name, ttl_secs).await,
            Self::Mysql(config) => mysql::issue(config, role, display_name).await,
            Self::Mssql(config) => mssql::issue(config, role, display_name).await,
            Self::Mongodb(config) => mongodb::issue(config, role, display_name).await,
            Self::AwsSts(config) => aws::issue(config, role, ttl_secs).await,
            Self::Gcp(config) => gcp::issue(config, ttl_secs).await,
            Self::Azure(config) => azure::issue(config, role, ttl_secs).await,
            Self::Kubernetes(config) => kubernetes::issue(config, role, ttl_secs).await,
            Self::KubernetesRules(config) => kubernetes_rules::issue(config, role, ttl_secs).await,
            Self::RabbitMq(config) => rabbitmq::issue(config, role).await,
            Self::AwsIam(config) => aws_iam::issue(config, role).await,
            Self::Webhook(config) => webhook::issue(config, role, ttl_secs).await,
            Self::Redis(config) => redis::issue(config, role, display_name).await,
            Self::Random {
                length,
                charset,
                field,
            } => Ok(Issued {
                data: BTreeMap::from([(
                    field.clone().unwrap_or_else(|| "value".to_owned()),
                    random_generator(*length, *charset).generate(),
                )]),
                revoke_data: Value::Null,
                ttl_cap_secs: None,
            }),
        }
    }

    /// Extend a credential upstream where the provider has an expiry to
    /// move; the rest is lease bookkeeping.
    pub(super) async fn renew(
        &self,
        role: &str,
        lease_id: &str,
        revoke_data: &Value,
        ttl_secs: i64,
    ) -> Result<()> {
        match self {
            Self::Postgres(config) => postgres::renew(config, revoke_data, ttl_secs).await,
            Self::Webhook(config) => {
                webhook::renew(config, role, lease_id, revoke_data, ttl_secs).await
            }
            _ => Ok(()),
        }
    }

    /// Delete a credential upstream. `lease_id` is empty when cleaning up a
    /// credential whose lease could not be recorded.
    pub(super) async fn revoke(
        &self,
        role: &str,
        lease_id: &str,
        revoke_data: &Value,
    ) -> Result<()> {
        match self {
            Self::Postgres(config) => postgres::revoke(config, revoke_data).await,
            Self::Mysql(config) => mysql::revoke(config, revoke_data).await,
            Self::Mssql(config) => mssql::revoke(config, revoke_data).await,
            Self::Mongodb(config) => mongodb::revoke(config, revoke_data).await,
            Self::Gcp(config) => gcp::revoke(config, revoke_data).await,
            Self::Azure(config) => azure::revoke(config, revoke_data).await,
            Self::Kubernetes(config) => kubernetes::revoke(config, revoke_data).await,
            Self::KubernetesRules(config) => kubernetes_rules::revoke(config, revoke_data).await,
            Self::RabbitMq(config) => rabbitmq::revoke(config, revoke_data).await,
            Self::AwsIam(config) => aws_iam::revoke(config, revoke_data).await,
            Self::Webhook(config) => webhook::revoke(config, role, lease_id, revoke_data).await,
            Self::Redis(config) => redis::revoke(config, revoke_data).await,
            // STS sessions and random values have nothing to delete upstream.
            Self::AwsSts(_) | Self::Random { .. } => Ok(()),
        }
    }
}
