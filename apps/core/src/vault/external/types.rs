//! External-store records, inputs, and reports.

use super::*;

/// The external store's product.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreKind {
    Openbao,
    HashicorpVault,
    Infisical,
    /// GitHub Actions repository or environment secrets (push only).
    GithubActions,
    /// Vercel project environment variables (push only).
    Vercel,
    /// AWS Secrets Manager: one secret holds the folder as JSON (push only).
    AwsSecretsManager,
    /// Google Cloud Secret Manager: one secret per key (push only).
    GcpSecretManager,
}

impl StoreKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Openbao => "openbao",
            Self::HashicorpVault => "hashicorp-vault",
            Self::Infisical => "infisical",
            Self::GithubActions => "github-actions",
            Self::Vercel => "vercel",
            Self::AwsSecretsManager => "aws-secrets-manager",
            Self::GcpSecretManager => "gcp-secret-manager",
        }
    }

    /// Secret-sync targets accept destinations only: their APIs are
    /// write-only (GitHub) or are not a folder Ryu can pull from.
    pub fn is_sync_target(self) -> bool {
        matches!(
            self,
            Self::GithubActions | Self::Vercel | Self::AwsSecretsManager | Self::GcpSecretManager
        )
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "openbao" => Some(Self::Openbao),
            "hashicorp-vault" => Some(Self::HashicorpVault),
            "infisical" => Some(Self::Infisical),
            "github-actions" => Some(Self::GithubActions),
            "vercel" => Some(Self::Vercel),
            "aws-secrets-manager" => Some(Self::AwsSecretsManager),
            "gcp-secret-manager" => Some(Self::GcpSecretManager),
            _ => None,
        }
    }
}

/// How Core authenticates to the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    /// A static token (Vault/OpenBao token or Infisical access token).
    Token,
    /// Vault/OpenBao AppRole `role_id` + `secret_id`.
    Approle,
    /// Vault/OpenBao Kubernetes auth with the pod's service-account JWT.
    Kubernetes,
    /// Infisical universal auth (machine identity client id + secret).
    UniversalAuth,
    /// AWS access key id + secret access key (optional session token).
    AccessKey,
    /// Google Cloud service-account key (JSON), exchanged for an access token.
    ServiceAccount,
}

impl AuthMethod {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Approle => "approle",
            Self::Kubernetes => "kubernetes",
            Self::UniversalAuth => "universal-auth",
            Self::AccessKey => "access-key",
            Self::ServiceAccount => "service-account",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "token" => Some(Self::Token),
            "approle" => Some(Self::Approle),
            "kubernetes" => Some(Self::Kubernetes),
            "universal-auth" => Some(Self::UniversalAuth),
            "access-key" => Some(Self::AccessKey),
            "service-account" => Some(Self::ServiceAccount),
            _ => None,
        }
    }
}

/// Store credentials. Sealed at rest; never serialized into a response.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    /// A Google Cloud service-account key file's JSON text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_account_key: Option<String>,
}

impl std::fmt::Debug for StoreCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoreCredentials(<redacted>)")
    }
}

pub(super) fn filled(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.trim().is_empty())
}

/// A store connection (no credentials).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRecord {
    pub id: String,
    pub name: String,
    pub kind: StoreKind,
    pub address: String,
    pub namespace: Option<String>,
    pub auth_method: AuthMethod,
    pub auth_mount: Option<String>,
    pub role: Option<String>,
    pub mount: String,
    pub path_prefix: String,
    pub kv_version: u8,
    pub project_id: String,
    pub infisical_environment: String,
    pub secret_path: String,
    /// Secret-sync target settings (empty for vault-to-vault stores).
    #[serde(flatten)]
    pub options: TargetOptions,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Settings only secret-sync targets use. Stored as JSON in `options`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetOptions {
    /// GitHub `owner/repo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// GitHub deployment environment; unset writes repository secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_environment: Option<String>,
    /// Vercel team id (`team_…`) for a team-owned project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Vercel targets (`production`, `preview`, `development`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vercel_targets: Vec<String>,
    /// AWS region (`us-east-1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Request to create a store.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInput {
    pub name: String,
    pub kind: StoreKind,
    /// Optional for secret-sync targets, which default to the public API.
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub auth_mount: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// Refused: the Kubernetes token location is operator configuration
    /// ([`client::ENV_K8S_JWT_PATH`]), never request input.
    #[serde(default)]
    pub jwt_path: Option<String>,
    #[serde(default)]
    pub mount: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub kv_version: Option<u8>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Infisical environment slug (not a Ryu environment).
    #[serde(default)]
    pub infisical_environment: Option<String>,
    #[serde(default)]
    pub secret_path: Option<String>,
    #[serde(default, flatten)]
    pub options: TargetOptions,
    #[serde(default)]
    pub credentials: StoreCredentials,
}

/// Pull mode for a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceMode {
    /// Read-through at resolve time with a TTL cache.
    Live,
    /// Scheduled copy into versioned local values.
    Sync,
}

impl SourceMode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Sync => "sync",
        }
    }
}

/// A folder bound to a remote path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub id: String,
    pub store_id: String,
    pub environment: String,
    pub path: String,
    pub remote_path: String,
    pub mode: SourceMode,
    pub scope_id: String,
    pub cache_ttl_secs: i64,
    pub stale_if_error_secs: i64,
    pub sync_interval_secs: i64,
    pub last_sync_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_count: i64,
    pub created_at: i64,
}

/// Request to bind a folder to a remote path.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub store_id: String,
    pub environment: String,
    pub path: String,
    #[serde(default)]
    pub remote_path: String,
    pub mode: SourceMode,
    #[serde(default)]
    pub cache_ttl_secs: Option<i64>,
    #[serde(default)]
    pub stale_if_error_secs: Option<i64>,
    #[serde(default)]
    pub sync_interval_secs: Option<i64>,
}

/// A folder pushed one-way to a remote path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationRecord {
    pub id: String,
    pub store_id: String,
    pub environment: String,
    pub path: String,
    pub remote_path: String,
    pub scope_id: String,
    pub interval_secs: i64,
    pub dirty: bool,
    pub last_push_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_count: i64,
    /// Consecutive failed pushes; drives the retry backoff.
    pub failures: i64,
    pub created_at: i64,
}

/// Request to push a folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationInput {
    pub store_id: String,
    pub environment: String,
    pub path: String,
    #[serde(default)]
    pub remote_path: String,
    #[serde(default)]
    pub interval_secs: Option<i64>,
}

/// Result of one sync.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub written: usize,
    pub removed: usize,
    pub unchanged: usize,
}

/// Result of one loop pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub synced: usize,
    pub pushed: usize,
    pub failed: usize,
}

/// What a live lookup found for one name in one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveLookup {
    /// The folder has no live source; resolve locally.
    NotSourced,
    Found {
        value: String,
        version: i64,
    },
    /// The folder is sourced and the remote has no such key.
    Missing,
    /// The store is unreachable (or the vault sealed) and no usable stale
    /// answer exists. Resolution fails closed.
    Unavailable,
}
