use std::{collections::BTreeSet, fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerTrust {
    #[default]
    Pending,
    Trusted,
    Revoked,
}

impl fmt::Display for PeerTrust {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Pending => "pending",
            Self::Trusted => "trusted",
            Self::Revoked => "revoked",
        })
    }
}

impl FromStr for PeerTrust {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "trusted" => Ok(Self::Trusted),
            "revoked" => Ok(Self::Revoked),
            _ => Err("unknown peer trust state"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    #[default]
    None,
    Bearer,
    ApiKey,
    Basic,
    #[serde(
        rename = "oauth2_client_credentials",
        alias = "o_auth2_client_credentials"
    )]
    OAuth2ClientCredentials,
}

impl fmt::Display for CredentialKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::None => "none",
            Self::Bearer => "bearer",
            Self::ApiKey => "api_key",
            Self::Basic => "basic",
            Self::OAuth2ClientCredentials => "oauth2_client_credentials",
        })
    }
}

impl FromStr for CredentialKind {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "none" => Ok(Self::None),
            "bearer" => Ok(Self::Bearer),
            "api_key" => Ok(Self::ApiKey),
            "basic" => Ok(Self::Basic),
            "oauth2_client_credentials" => Ok(Self::OAuth2ClientCredentials),
            _ => Err("unknown credential kind"),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerCredential {
    None,
    Bearer {
        token: String,
    },
    ApiKey {
        header: String,
        value: String,
    },
    Basic {
        username: String,
        password: String,
    },
    #[serde(
        rename = "oauth2_client_credentials",
        alias = "o_auth2_client_credentials"
    )]
    OAuth2ClientCredentials {
        #[serde(rename = "tokenUrl", alias = "token_url")]
        token_url: String,
        #[serde(rename = "clientId", alias = "client_id")]
        client_id: String,
        #[serde(rename = "clientSecret", alias = "client_secret")]
        client_secret: String,
        #[serde(default)]
        scopes: Vec<String>,
    },
}

impl PeerCredential {
    #[must_use]
    pub const fn kind(&self) -> CredentialKind {
        match self {
            Self::None => CredentialKind::None,
            Self::Bearer { .. } => CredentialKind::Bearer,
            Self::ApiKey { .. } => CredentialKind::ApiKey,
            Self::Basic { .. } => CredentialKind::Basic,
            Self::OAuth2ClientCredentials { .. } => CredentialKind::OAuth2ClientCredentials,
        }
    }
}

impl fmt::Debug for PeerCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PeerCredential")
            .field("kind", &self.kind())
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A2aPeer {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub agent_card_url: String,
    pub agent_card: Option<Value>,
    /// Outcome of checking the stored card's `signatures` at discovery.
    /// `None` when the card was saved without being fetched by Ryu.
    #[serde(default)]
    pub card_signature: Option<crate::CardSignatureStatus>,
    pub credential_kind: CredentialKind,
    pub credential_configured: bool,
    pub trust: PeerTrust,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct PeerUpsert {
    pub id: Option<String>,
    pub tenant_id: String,
    pub name: String,
    pub agent_card_url: String,
    pub agent_card: Option<Value>,
    pub card_signature: Option<crate::CardSignatureStatus>,
    pub credential: Option<PeerCredential>,
    pub enabled: bool,
}

impl fmt::Debug for PeerUpsert {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PeerUpsert")
            .field("id", &self.id)
            .field("tenant_id", &self.tenant_id)
            .field("name", &self.name)
            .field("agent_card_url", &self.agent_card_url)
            .field("card_signature", &self.card_signature)
            .field(
                "credential",
                &self.credential.as_ref().map(PeerCredential::kind),
            )
            .field("enabled", &self.enabled)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct ResolvedPeer {
    pub peer: A2aPeer,
    pub credential: PeerCredential,
}

impl fmt::Debug for ResolvedPeer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedPeer")
            .field("peer", &self.peer)
            .field("credential", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A2aServerConfig {
    pub tenant_id: String,
    pub enabled: bool,
    pub display_name: String,
    pub description: String,
    pub public_base_url: Option<String>,
    pub expose_extended_card: bool,
    pub max_payload_bytes: u64,
    pub max_concurrent_tasks: u32,
    /// Refuse to discover a peer whose Agent Card lacks a verified signature.
    #[serde(default)]
    pub require_signed_peer_cards: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedAgent {
    pub id: String,
    pub tenant_id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub skills: Vec<crate::protocol::AgentSkill>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct PublishedAgentUpsert {
    pub id: Option<String>,
    pub tenant_id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub skills: Vec<crate::protocol::AgentSkill>,
    pub enabled: bool,
}

impl A2aServerConfig {
    #[must_use]
    pub fn defaults_for(tenant_id: impl Into<String>) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            enabled: false,
            display_name: "Ryu".to_owned(),
            description: "A Ryu agent endpoint".to_owned(),
            public_base_url: None,
            expose_extended_card: false,
            max_payload_bytes: 1_048_576,
            max_concurrent_tasks: 32,
            require_signed_peer_cards: false,
            updated_at: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum A2aScope {
    Send,
    Read,
    Cancel,
    Subscribe,
    PushConfig,
    ExtendedCard,
}

impl fmt::Display for A2aScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Send => "send",
            Self::Read => "read",
            Self::Cancel => "cancel",
            Self::Subscribe => "subscribe",
            Self::PushConfig => "push_config",
            Self::ExtendedCard => "extended_card",
        })
    }
}

impl FromStr for A2aScope {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "send" => Ok(Self::Send),
            "read" => Ok(Self::Read),
            "cancel" => Ok(Self::Cancel),
            "subscribe" => Ok(Self::Subscribe),
            "push_config" => Ok(Self::PushConfig),
            "extended_card" => Ok(Self::ExtendedCard),
            _ => Err("unknown A2A scope"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A2aPrincipal {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub scopes: BTreeSet<A2aScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_agent: Option<A2aPublicAgentBinding>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A2aPublicAgentBinding {
    pub published_agent_id: String,
    pub capability_allowlist: BTreeSet<String>,
}

impl A2aPublicAgentBinding {
    #[must_use]
    pub fn allows_capability(&self, capability: &str) -> bool {
        self.capability_allowlist.contains(capability)
    }
}

impl A2aPrincipal {
    #[must_use]
    pub fn allows(&self, scope: A2aScope) -> bool {
        self.revoked_at.is_none() && self.scopes.contains(&scope)
    }

    #[must_use]
    pub fn allows_published_agent(&self, published_agent_id: &str) -> bool {
        self.public_agent
            .as_ref()
            .is_none_or(|binding| binding.published_agent_id == published_agent_id)
    }

    #[must_use]
    pub fn allows_public_capability(&self, capability: &str) -> bool {
        self.public_agent
            .as_ref()
            .is_none_or(|binding| binding.allows_capability(capability))
    }
}

#[derive(Clone)]
pub struct IssuedPrincipalToken {
    pub principal: A2aPrincipal,
    pub token: String,
}

impl fmt::Debug for IssuedPrincipalToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedPrincipalToken")
            .field("principal", &self.principal)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskDirection {
    Inbound,
    Outbound,
}

impl fmt::Display for TaskDirection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        })
    }
}

impl FromStr for TaskDirection {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "inbound" => Ok(Self::Inbound),
            "outbound" => Ok(Self::Outbound),
            _ => Err("unknown task direction"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    AuthRequired,
    Completed,
    Canceled,
    Failed,
    Rejected,
    Unknown,
}

impl TaskState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Canceled | Self::Failed | Self::Rejected
        )
    }
}

impl fmt::Display for TaskState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Submitted => "submitted",
            Self::Working => "working",
            Self::InputRequired => "input_required",
            Self::AuthRequired => "auth_required",
            Self::Completed => "completed",
            Self::Canceled => "canceled",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::Unknown => "unknown",
        })
    }
}

impl FromStr for TaskState {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "submitted" => Ok(Self::Submitted),
            "working" => Ok(Self::Working),
            "input_required" => Ok(Self::InputRequired),
            "auth_required" => Ok(Self::AuthRequired),
            "completed" => Ok(Self::Completed),
            "canceled" | "cancelled" => Ok(Self::Canceled),
            "failed" => Ok(Self::Failed),
            "rejected" => Ok(Self::Rejected),
            "unknown" => Ok(Self::Unknown),
            _ => Err("unknown task state"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TaskCreate {
    pub id: String,
    pub context_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub peer_id: Option<String>,
    pub local_agent_id: Option<String>,
    pub direction: TaskDirection,
    pub state: TaskState,
    pub protocol_task: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A2aTaskRecord {
    pub id: String,
    pub context_id: String,
    pub tenant_id: String,
    pub owner_id: String,
    pub peer_id: Option<String>,
    pub local_agent_id: Option<String>,
    pub direction: TaskDirection,
    pub state: TaskState,
    pub revision: u64,
    pub protocol_task: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskItemKind {
    Message,
    Artifact,
}

impl fmt::Display for TaskItemKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Message => "message",
            Self::Artifact => "artifact",
        })
    }
}

impl FromStr for TaskItemKind {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "message" => Ok(Self::Message),
            "artifact" => Ok(Self::Artifact),
            _ => Err("unknown task item kind"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItemRecord {
    pub id: String,
    pub task_id: String,
    pub kind: TaskItemKind,
    pub sequence: u64,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventRecord {
    pub task_id: String,
    pub sequence: u64,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone)]
pub struct PushConfigInput {
    pub id: String,
    pub callback_url: String,
    pub token: Option<String>,
    pub authentication: Option<Value>,
}

impl fmt::Debug for PushConfigInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PushConfigInput")
            .field("id", &self.id)
            .field("callback_url", &self.callback_url)
            .field("token", &self.token.as_ref().map(|_| "[REDACTED]"))
            .field(
                "authentication",
                &self.authentication.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigSummary {
    pub id: String,
    pub task_id: String,
    pub callback_url: String,
    pub token_configured: bool,
    pub authentication_configured: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct ResolvedPushConfig {
    pub summary: PushConfigSummary,
    pub token: Option<String>,
    pub authentication: Option<Value>,
}

impl fmt::Debug for ResolvedPushConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedPushConfig")
            .field("summary", &self.summary)
            .field("token", &self.token.as_ref().map(|_| "[REDACTED]"))
            .field(
                "authentication",
                &self.authentication.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// Stable local record id for a task owned by a remote peer.
///
/// A2A task ids are unique within one agent, not across every peer a Ryu node
/// can call. Namespace them before persistence while retaining the original id
/// inside the encrypted protocol task.
#[must_use]
pub fn outbound_task_record_id(peer_id: &str, remote_task_id: &str) -> String {
    let digest = Sha256::digest(format!("{peer_id}\0{remote_task_id}").as_bytes());
    format!("remote-{}", hex::encode(digest))
}

#[cfg(test)]
mod tests {
    use super::{outbound_task_record_id, CredentialKind, PeerCredential};

    #[test]
    fn outbound_task_records_are_namespaced_by_peer() {
        let first = outbound_task_record_id("peer-a", "task-1");
        let second = outbound_task_record_id("peer-b", "task-1");
        assert_ne!(first, second);
        assert_eq!(first, outbound_task_record_id("peer-a", "task-1"));
        assert!(first.len() <= 256);
    }

    #[test]
    fn oauth_peer_credentials_use_camel_case_and_read_legacy_fields() {
        let credential = PeerCredential::OAuth2ClientCredentials {
            token_url: "https://auth.example.com/token".to_owned(),
            client_id: "client".to_owned(),
            client_secret: "secret".to_owned(),
            scopes: vec!["a2a.send".to_owned()],
        };
        let value = serde_json::to_value(&credential).expect("serialize credential");
        assert_eq!(value["kind"], "oauth2_client_credentials");
        assert_eq!(
            serde_json::to_value(CredentialKind::OAuth2ClientCredentials)
                .expect("serialize credential kind"),
            "oauth2_client_credentials"
        );
        assert_eq!(value["tokenUrl"], "https://auth.example.com/token");
        assert!(value.get("token_url").is_none());

        let legacy = serde_json::json!({
            "kind": "oauth2_client_credentials",
            "token_url": "https://auth.example.com/token",
            "client_id": "client",
            "client_secret": "secret",
            "scopes": []
        });
        serde_json::from_value::<PeerCredential>(legacy).expect("read legacy OAuth fields");
    }
}
