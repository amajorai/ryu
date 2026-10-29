use std::{
    collections::BTreeSet,
    path::Path,
    str::FromStr,
    sync::{Mutex, MutexGuard},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

use ryu_crypto::FieldCipher;

use crate::{
    validate_endpoint, validate_task_transition, A2aPeer, A2aPrincipal, A2aPublicAgentBinding,
    A2aScope, A2aServerConfig, A2aTaskRecord, CredentialKind, EndpointError, EndpointPolicy,
    IssuedPrincipalToken, PeerCredential, PeerTrust, PeerUpsert, PublishedAgent,
    PublishedAgentUpsert, PushConfigInput, PushConfigSummary, ResolvedPeer, ResolvedPushConfig,
    TaskCreate, TaskDirection, TaskEventRecord, TaskItemKind, TaskItemRecord, TaskState,
    TransitionError,
};

const MAX_PAGE_SIZE: u32 = 200;
const MAX_PUSH_CONFIGS_PER_TASK: i64 = 16;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("A2A state store is unavailable")]
    Unavailable,
    #[error("A2A record was not found")]
    NotFound,
    #[error("A2A authentication failed")]
    AuthenticationFailed,
    #[error("A2A record conflicts with existing state: {0}")]
    Conflict(String),
    #[error("invalid A2A input: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    InvalidEndpoint(#[from] EndpointError),
    #[error(transparent)]
    InvalidTransition(#[from] TransitionError),
    #[error("A2A data is corrupt: {0}")]
    Corrupt(String),
    #[error("A2A encryption operation failed")]
    Crypto,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub struct A2aStore {
    connection: Mutex<Connection>,
    cipher: FieldCipher,
}

impl A2aStore {
    pub fn open(path: impl AsRef<Path>, cipher: FieldCipher) -> Result<Self, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| StoreError::Unavailable)?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection, cipher)
    }

    pub fn open_in_memory(cipher: FieldCipher) -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?, cipher)
    }

    fn from_connection(connection: Connection, cipher: FieldCipher) -> Result<Self, StoreError> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS a2a_peers (
               id TEXT PRIMARY KEY,
               tenant_id TEXT NOT NULL,
               name TEXT NOT NULL,
               agent_card_url TEXT NOT NULL,
               agent_card_json TEXT,
               credential_kind TEXT NOT NULL,
               credential_sealed TEXT,
               trust TEXT NOT NULL,
               enabled INTEGER NOT NULL,
               last_error TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_a2a_peers_tenant
               ON a2a_peers (tenant_id, updated_at DESC);

             CREATE TABLE IF NOT EXISTS a2a_server_config (
               tenant_id TEXT PRIMARY KEY,
               enabled INTEGER NOT NULL,
               display_name TEXT NOT NULL,
               description TEXT NOT NULL,
               public_base_url TEXT,
               expose_extended_card INTEGER NOT NULL,
               max_payload_bytes INTEGER NOT NULL,
               max_concurrent_tasks INTEGER NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS a2a_principals (
               id TEXT PRIMARY KEY,
               tenant_id TEXT NOT NULL,
               name TEXT NOT NULL,
               token_hash BLOB NOT NULL UNIQUE,
               scopes_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               last_used_at TEXT,
               revoked_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_a2a_principals_tenant
               ON a2a_principals (tenant_id, created_at DESC);

             CREATE TABLE IF NOT EXISTS a2a_published_agents (
               id TEXT PRIMARY KEY,
               tenant_id TEXT NOT NULL,
               agent_id TEXT NOT NULL,
               name TEXT NOT NULL,
               description TEXT NOT NULL,
               skills_json TEXT NOT NULL,
               enabled INTEGER NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE (tenant_id, agent_id)
             );
             CREATE INDEX IF NOT EXISTS idx_a2a_published_agents_tenant
               ON a2a_published_agents (tenant_id, name COLLATE NOCASE);

             CREATE TABLE IF NOT EXISTS a2a_principal_public_bindings (
               principal_id TEXT PRIMARY KEY REFERENCES a2a_principals(id) ON DELETE CASCADE,
               tenant_id TEXT NOT NULL,
               published_agent_id TEXT NOT NULL,
               capability_allowlist_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_a2a_principal_public_bindings_agent
               ON a2a_principal_public_bindings (tenant_id, published_agent_id);

             CREATE TABLE IF NOT EXISTS a2a_tasks (
               id TEXT PRIMARY KEY,
               context_id TEXT NOT NULL,
               tenant_id TEXT NOT NULL,
               owner_id TEXT NOT NULL,
               peer_id TEXT,
               local_agent_id TEXT,
               direction TEXT NOT NULL,
               state TEXT NOT NULL,
               revision INTEGER NOT NULL,
               protocol_task_sealed TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_a2a_tasks_owner
               ON a2a_tasks (tenant_id, owner_id, updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context
               ON a2a_tasks (tenant_id, owner_id, context_id, updated_at DESC);

             CREATE TABLE IF NOT EXISTS a2a_task_items (
               task_id TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
               id TEXT NOT NULL,
               kind TEXT NOT NULL,
               sequence INTEGER NOT NULL,
               payload_sealed TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY (task_id, id),
               UNIQUE (task_id, sequence)
             );

             CREATE TABLE IF NOT EXISTS a2a_task_events (
               task_id TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
               sequence INTEGER NOT NULL,
               event_type TEXT NOT NULL,
               payload_sealed TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY (task_id, sequence)
             );

             CREATE TABLE IF NOT EXISTS a2a_push_configs (
               task_id TEXT NOT NULL REFERENCES a2a_tasks(id) ON DELETE CASCADE,
               id TEXT NOT NULL,
               callback_url TEXT NOT NULL,
               secrets_sealed TEXT NOT NULL,
               token_configured INTEGER NOT NULL,
               authentication_configured INTEGER NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (task_id, id)
             );

             PRAGMA user_version = 1;",
        )?;
        ensure_column(
            &connection,
            "a2a_peers",
            "card_signature_json",
            "card_signature_json TEXT",
        )?;
        ensure_column(
            &connection,
            "a2a_server_config",
            "require_signed_peer_cards",
            "require_signed_peer_cards INTEGER NOT NULL DEFAULT 0",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            cipher,
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.connection.lock().map_err(|_| StoreError::Unavailable)
    }

    pub fn upsert_peer(
        &self,
        input: PeerUpsert,
        endpoint_policy: EndpointPolicy,
    ) -> Result<A2aPeer, StoreError> {
        validate_identifier("tenant ID", &input.tenant_id)?;
        validate_label("peer name", &input.name, 160)?;
        validate_endpoint(&input.agent_card_url, endpoint_policy)?;
        if let Some(credential) = &input.credential {
            let value = serde_json::to_value(credential)?;
            ensure_json_size("peer credential", &value, 64 * 1024)?;
            if let PeerCredential::OAuth2ClientCredentials { token_url, .. } = credential {
                validate_endpoint(token_url, endpoint_policy)?;
            }
        }
        if let Some(card) = &input.agent_card {
            ensure_json_size("agent card", card, 512 * 1024)?;
        }

        let now = timestamp();
        let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_identifier("peer ID", &id)?;
        let connection = self.connection()?;
        let existing = load_peer_row(&connection, &input.tenant_id, &id)?;
        let (credential_kind, credential_sealed) = match input.credential {
            Some(credential) => {
                let serialized = serde_json::to_string(&credential)?;
                let sealed = self
                    .cipher
                    .seal(&serialized)
                    .map_err(|_| StoreError::Crypto)?;
                (credential.kind(), Some(sealed))
            }
            None => existing
                .as_ref()
                .map(|row| (row.credential_kind, row.credential_sealed.clone()))
                .unwrap_or((CredentialKind::None, None)),
        };
        let trust = existing
            .as_ref()
            .map_or(PeerTrust::Pending, |row| row.trust);
        let created_at = existing
            .as_ref()
            .map_or_else(|| now.clone(), |row| row.created_at.clone());
        let card_json = input
            .agent_card
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let card_signature_json = input
            .card_signature
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        connection.execute(
            "INSERT INTO a2a_peers (
               id, tenant_id, name, agent_card_url, agent_card_json,
               credential_kind, credential_sealed, trust, enabled, last_error,
               created_at, updated_at, card_signature_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               agent_card_url = excluded.agent_card_url,
               agent_card_json = excluded.agent_card_json,
               card_signature_json = excluded.card_signature_json,
               credential_kind = excluded.credential_kind,
               credential_sealed = excluded.credential_sealed,
               enabled = excluded.enabled,
               last_error = NULL,
               updated_at = excluded.updated_at
             WHERE a2a_peers.tenant_id = excluded.tenant_id",
            params![
                id,
                input.tenant_id,
                input.name,
                input.agent_card_url,
                card_json,
                credential_kind.to_string(),
                credential_sealed,
                trust.to_string(),
                input.enabled,
                created_at,
                now,
                card_signature_json,
            ],
        )?;
        load_peer_row(&connection, &input.tenant_id, &id)?
            .map(PeerRow::into_public)
            .ok_or_else(|| StoreError::Conflict("peer ID belongs to another tenant".to_owned()))
    }

    pub fn get_peer(&self, tenant_id: &str, peer_id: &str) -> Result<A2aPeer, StoreError> {
        let connection = self.connection()?;
        load_peer_row(&connection, tenant_id, peer_id)?
            .map(PeerRow::into_public)
            .ok_or(StoreError::NotFound)
    }

    pub fn list_peers(&self, tenant_id: &str) -> Result<Vec<A2aPeer>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, tenant_id, name, agent_card_url, agent_card_json,
                    credential_kind, credential_sealed, trust, enabled, last_error,
                    created_at, updated_at, card_signature_json
             FROM a2a_peers WHERE tenant_id = ?1 ORDER BY name COLLATE NOCASE, id",
        )?;
        let rows = statement.query_map([tenant_id], peer_row_from_sql)?;
        rows.map(|row| row.and_then(parse_peer_row).map(PeerRow::into_public))
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn set_peer_trust(
        &self,
        tenant_id: &str,
        peer_id: &str,
        trust: PeerTrust,
    ) -> Result<A2aPeer, StoreError> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE a2a_peers SET trust = ?1, updated_at = ?2
             WHERE tenant_id = ?3 AND id = ?4",
            params![trust.to_string(), timestamp(), tenant_id, peer_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        load_peer_row(&connection, tenant_id, peer_id)?
            .map(PeerRow::into_public)
            .ok_or(StoreError::NotFound)
    }

    pub fn set_peer_error(
        &self,
        tenant_id: &str,
        peer_id: &str,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        if let Some(error) = error {
            validate_label("peer error", error, 1_000)?;
        }
        let changed = self.connection()?.execute(
            "UPDATE a2a_peers SET last_error = ?1, updated_at = ?2
             WHERE tenant_id = ?3 AND id = ?4",
            params![error, timestamp(), tenant_id, peer_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn resolve_peer_for_transport(
        &self,
        tenant_id: &str,
        peer_id: &str,
    ) -> Result<ResolvedPeer, StoreError> {
        let connection = self.connection()?;
        let row = load_peer_row(&connection, tenant_id, peer_id)?.ok_or(StoreError::NotFound)?;
        if !row.enabled || row.trust != PeerTrust::Trusted {
            return Err(StoreError::AuthenticationFailed);
        }
        let credential = match row.credential_sealed.as_deref() {
            Some(sealed) => {
                let serialized = self.cipher.open(sealed).map_err(|_| StoreError::Crypto)?;
                serde_json::from_str(&serialized)?
            }
            None => PeerCredential::None,
        };
        Ok(ResolvedPeer {
            peer: row.into_public(),
            credential,
        })
    }

    pub fn delete_peer(&self, tenant_id: &str, peer_id: &str) -> Result<(), StoreError> {
        let changed = self.connection()?.execute(
            "DELETE FROM a2a_peers WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, peer_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn save_server_config(
        &self,
        mut config: A2aServerConfig,
        endpoint_policy: EndpointPolicy,
    ) -> Result<A2aServerConfig, StoreError> {
        validate_identifier("tenant ID", &config.tenant_id)?;
        validate_label("display name", &config.display_name, 160)?;
        validate_label("description", &config.description, 2_000)?;
        if let Some(base_url) = &config.public_base_url {
            validate_endpoint(base_url, endpoint_policy)?;
        }
        if !(1_024..=16 * 1024 * 1024).contains(&config.max_payload_bytes) {
            return Err(StoreError::InvalidInput(
                "max payload bytes must be between 1 KiB and 16 MiB".to_owned(),
            ));
        }
        if !(1..=1_024).contains(&config.max_concurrent_tasks) {
            return Err(StoreError::InvalidInput(
                "max concurrent tasks must be between 1 and 1024".to_owned(),
            ));
        }
        config.updated_at = timestamp();
        self.connection()?.execute(
            "INSERT INTO a2a_server_config (
               tenant_id, enabled, display_name, description, public_base_url,
               expose_extended_card, max_payload_bytes, max_concurrent_tasks, updated_at,
               require_signed_peer_cards
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(tenant_id) DO UPDATE SET
               enabled = excluded.enabled,
               display_name = excluded.display_name,
               description = excluded.description,
               public_base_url = excluded.public_base_url,
               expose_extended_card = excluded.expose_extended_card,
               max_payload_bytes = excluded.max_payload_bytes,
               max_concurrent_tasks = excluded.max_concurrent_tasks,
               require_signed_peer_cards = excluded.require_signed_peer_cards,
               updated_at = excluded.updated_at",
            params![
                config.tenant_id,
                config.enabled,
                config.display_name,
                config.description,
                config.public_base_url,
                config.expose_extended_card,
                i64::try_from(config.max_payload_bytes).map_err(|_| {
                    StoreError::InvalidInput("max payload bytes is too large".to_owned())
                })?,
                config.max_concurrent_tasks,
                config.updated_at,
                config.require_signed_peer_cards,
            ],
        )?;
        Ok(config)
    }

    pub fn server_config(&self, tenant_id: &str) -> Result<A2aServerConfig, StoreError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT tenant_id, enabled, display_name, description, public_base_url,
                        expose_extended_card, max_payload_bytes, max_concurrent_tasks, updated_at,
                        require_signed_peer_cards
                 FROM a2a_server_config WHERE tenant_id = ?1",
                [tenant_id],
                |row| {
                    Ok(A2aServerConfig {
                        tenant_id: row.get(0)?,
                        enabled: row.get(1)?,
                        display_name: row.get(2)?,
                        description: row.get(3)?,
                        public_base_url: row.get(4)?,
                        expose_extended_card: row.get(5)?,
                        max_payload_bytes: u64::try_from(row.get::<_, i64>(6)?)
                            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(6, -1))?,
                        max_concurrent_tasks: row.get(7)?,
                        require_signed_peer_cards: row.get(9)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .optional()?
            .map_or_else(
                || Ok(A2aServerConfig::defaults_for(tenant_id)),
                Ok::<_, StoreError>,
            )
    }

    pub fn upsert_published_agent(
        &self,
        input: PublishedAgentUpsert,
    ) -> Result<PublishedAgent, StoreError> {
        validate_identifier("tenant ID", &input.tenant_id)?;
        validate_identifier("agent ID", &input.agent_id)?;
        validate_label("published agent name", &input.name, 160)?;
        validate_label("published agent description", &input.description, 4_000)?;
        if input.skills.len() > 256 {
            return Err(StoreError::InvalidInput(
                "a published agent may expose at most 256 skills".to_owned(),
            ));
        }
        let skills_json = serde_json::to_string(&input.skills)?;
        if skills_json.len() > 512 * 1024 {
            return Err(StoreError::InvalidInput(
                "published agent skills exceed the 512 KiB limit".to_owned(),
            ));
        }
        let connection = self.connection()?;
        let existing = connection
            .query_row(
                "SELECT id, created_at FROM a2a_published_agents
                 WHERE tenant_id = ?1 AND agent_id = ?2",
                params![input.tenant_id, input.agent_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let id = input
            .id
            .or_else(|| existing.as_ref().map(|value| value.0.clone()))
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_identifier("published agent record ID", &id)?;
        let now = timestamp();
        let created_at = existing.map_or_else(|| now.clone(), |value| value.1);
        connection.execute(
            "INSERT INTO a2a_published_agents (
               id, tenant_id, agent_id, name, description, skills_json,
               enabled, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               skills_json = excluded.skills_json,
               enabled = excluded.enabled,
               updated_at = excluded.updated_at",
            params![
                id,
                input.tenant_id,
                input.agent_id,
                input.name,
                input.description,
                skills_json,
                input.enabled,
                created_at,
                now,
            ],
        )?;
        drop(connection);
        self.get_published_agent(&input.tenant_id, &id)
    }

    pub fn get_published_agent(
        &self,
        tenant_id: &str,
        published_id: &str,
    ) -> Result<PublishedAgent, StoreError> {
        self.connection()?
            .query_row(
                "SELECT id, tenant_id, agent_id, name, description, skills_json,
                        enabled, created_at, updated_at
                 FROM a2a_published_agents WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, published_id],
                published_agent_from_sql,
            )
            .optional()?
            .ok_or(StoreError::NotFound)
    }

    pub fn list_published_agents(
        &self,
        tenant_id: &str,
        enabled_only: bool,
    ) -> Result<Vec<PublishedAgent>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, tenant_id, agent_id, name, description, skills_json,
                    enabled, created_at, updated_at
             FROM a2a_published_agents
             WHERE tenant_id = ?1 AND (?2 = 0 OR enabled = 1)
             ORDER BY name COLLATE NOCASE, id",
        )?;
        let rows =
            statement.query_map(params![tenant_id, enabled_only], published_agent_from_sql)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn delete_published_agent(
        &self,
        tenant_id: &str,
        published_id: &str,
    ) -> Result<(), StoreError> {
        let changed = self.connection()?.execute(
            "DELETE FROM a2a_published_agents WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, published_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn issue_principal_token(
        &self,
        tenant_id: &str,
        name: &str,
        scopes: BTreeSet<A2aScope>,
    ) -> Result<IssuedPrincipalToken, StoreError> {
        self.issue_principal_token_with_binding(tenant_id, name, scopes, None)
    }

    pub fn issue_public_agent_principal_token(
        &self,
        tenant_id: &str,
        name: &str,
        scopes: BTreeSet<A2aScope>,
        published_agent_id: &str,
        capability_allowlist: BTreeSet<String>,
    ) -> Result<IssuedPrincipalToken, StoreError> {
        validate_identifier("published agent record ID", published_agent_id)?;
        if scopes != BTreeSet::from([A2aScope::Send]) {
            return Err(StoreError::InvalidInput(
                "a public agent principal may only receive the send scope".to_owned(),
            ));
        }
        let published = self.get_published_agent(tenant_id, published_agent_id)?;
        if !published.enabled {
            return Err(StoreError::Conflict(
                "a public principal requires an enabled published agent".to_owned(),
            ));
        }
        validate_public_capability_allowlist(&capability_allowlist)?;
        self.issue_principal_token_with_binding(
            tenant_id,
            name,
            scopes,
            Some(A2aPublicAgentBinding {
                published_agent_id: published_agent_id.to_owned(),
                capability_allowlist,
            }),
        )
    }

    fn issue_principal_token_with_binding(
        &self,
        tenant_id: &str,
        name: &str,
        scopes: BTreeSet<A2aScope>,
        public_agent: Option<A2aPublicAgentBinding>,
    ) -> Result<IssuedPrincipalToken, StoreError> {
        validate_identifier("tenant ID", tenant_id)?;
        validate_label("principal name", name, 160)?;
        if scopes.is_empty() {
            return Err(StoreError::InvalidInput(
                "a principal requires at least one scope".to_owned(),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let token = generate_token();
        let token_hash = hash_token(&token);
        let created_at = timestamp();
        let scopes_json = serde_json::to_string(&scopes)?;
        let capability_allowlist_json = public_agent
            .as_ref()
            .map(|binding| serde_json::to_string(&binding.capability_allowlist))
            .transpose()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO a2a_principals (
               id, tenant_id, name, token_hash, scopes_json, created_at, last_used_at, revoked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            params![
                id,
                tenant_id,
                name,
                token_hash.as_slice(),
                scopes_json,
                created_at
            ],
        )?;
        if let (Some(binding), Some(capability_allowlist_json)) =
            (public_agent.as_ref(), capability_allowlist_json)
        {
            transaction.execute(
                "INSERT INTO a2a_principal_public_bindings (
                   principal_id, tenant_id, published_agent_id, capability_allowlist_json
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    id,
                    tenant_id,
                    binding.published_agent_id,
                    capability_allowlist_json
                ],
            )?;
        }
        transaction.commit()?;
        Ok(IssuedPrincipalToken {
            principal: A2aPrincipal {
                id,
                tenant_id: tenant_id.to_owned(),
                name: name.to_owned(),
                scopes,
                public_agent,
                created_at,
                last_used_at: None,
                revoked_at: None,
            },
            token,
        })
    }

    pub fn authenticate_principal(
        &self,
        tenant_id: &str,
        token: &str,
        required_scope: A2aScope,
    ) -> Result<A2aPrincipal, StoreError> {
        if token.len() > 512 || !token.starts_with("ryu_a2a_") {
            return Err(StoreError::AuthenticationFailed);
        }
        let candidate_hash = hash_token(token);
        let connection = self.connection()?;
        let raw = connection
            .query_row(
                "SELECT principal.id, principal.tenant_id, principal.name,
                        principal.token_hash, principal.scopes_json, principal.created_at,
                        principal.last_used_at, principal.revoked_at,
                        binding.published_agent_id, binding.capability_allowlist_json
                 FROM a2a_principals AS principal
                 LEFT JOIN a2a_principal_public_bindings AS binding
                   ON binding.principal_id = principal.id
                  AND binding.tenant_id = principal.tenant_id
                 WHERE principal.tenant_id = ?1
                   AND principal.token_hash = ?2
                   AND principal.revoked_at IS NULL",
                params![tenant_id, candidate_hash.as_slice()],
                |row| {
                    Ok(PrincipalRow {
                        id: row.get(0)?,
                        tenant_id: row.get(1)?,
                        name: row.get(2)?,
                        token_hash: row.get(3)?,
                        scopes_json: row.get(4)?,
                        created_at: row.get(5)?,
                        last_used_at: row.get(6)?,
                        revoked_at: row.get(7)?,
                        published_agent_id: row.get(8)?,
                        capability_allowlist_json: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or(StoreError::AuthenticationFailed)?;
        if raw.token_hash.len() != candidate_hash.len()
            || !bool::from(raw.token_hash.as_slice().ct_eq(candidate_hash.as_slice()))
        {
            return Err(StoreError::AuthenticationFailed);
        }
        let mut principal = raw.into_public()?;
        if !principal.allows(required_scope) {
            return Err(StoreError::AuthenticationFailed);
        }
        let last_used_at = timestamp();
        connection.execute(
            "UPDATE a2a_principals SET last_used_at = ?1 WHERE id = ?2",
            params![last_used_at, principal.id],
        )?;
        principal.last_used_at = Some(last_used_at);
        Ok(principal)
    }

    pub fn list_principals(&self, tenant_id: &str) -> Result<Vec<A2aPrincipal>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT principal.id, principal.tenant_id, principal.name,
                    principal.token_hash, principal.scopes_json, principal.created_at,
                    principal.last_used_at, principal.revoked_at,
                    binding.published_agent_id, binding.capability_allowlist_json
             FROM a2a_principals AS principal
             LEFT JOIN a2a_principal_public_bindings AS binding
               ON binding.principal_id = principal.id
              AND binding.tenant_id = principal.tenant_id
             WHERE principal.tenant_id = ?1 ORDER BY principal.created_at DESC",
        )?;
        let rows = statement.query_map([tenant_id], |row| {
            Ok(PrincipalRow {
                id: row.get(0)?,
                tenant_id: row.get(1)?,
                name: row.get(2)?,
                token_hash: row.get(3)?,
                scopes_json: row.get(4)?,
                created_at: row.get(5)?,
                last_used_at: row.get(6)?,
                revoked_at: row.get(7)?,
                published_agent_id: row.get(8)?,
                capability_allowlist_json: row.get(9)?,
            })
        })?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(PrincipalRow::into_public)
        })
        .collect()
    }

    pub fn revoke_principal(&self, tenant_id: &str, principal_id: &str) -> Result<(), StoreError> {
        let changed = self.connection()?.execute(
            "UPDATE a2a_principals SET revoked_at = COALESCE(revoked_at, ?1)
             WHERE tenant_id = ?2 AND id = ?3",
            params![timestamp(), tenant_id, principal_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn create_task(&self, input: TaskCreate) -> Result<A2aTaskRecord, StoreError> {
        validate_identifier("task ID", &input.id)?;
        validate_identifier("context ID", &input.context_id)?;
        validate_identifier("tenant ID", &input.tenant_id)?;
        validate_identifier("task owner ID", &input.owner_id)?;
        ensure_json_size("task", &input.protocol_task, 4 * 1024 * 1024)?;
        let serialized = serde_json::to_string(&input.protocol_task)?;
        let sealed = self
            .cipher
            .seal(&serialized)
            .map_err(|_| StoreError::Crypto)?;
        let now = timestamp();
        let connection = self.connection()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO a2a_tasks (
               id, context_id, tenant_id, owner_id, peer_id, local_agent_id,
               direction, state, revision, protocol_task_sealed, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?10)",
            params![
                input.id,
                input.context_id,
                input.tenant_id,
                input.owner_id,
                input.peer_id,
                input.local_agent_id,
                input.direction.to_string(),
                input.state.to_string(),
                sealed,
                now,
            ],
        )?;
        if inserted == 0 {
            let existing = load_task_owned(
                &connection,
                &self.cipher,
                &input.tenant_id,
                &input.owner_id,
                &input.id,
            )
            .map_err(|error| match error {
                StoreError::NotFound => {
                    StoreError::Conflict("task ID is already in use".to_owned())
                }
                other => other,
            })?;
            if existing.context_id == input.context_id
                && existing.direction == input.direction
                && existing.protocol_task == input.protocol_task
            {
                return Ok(existing);
            }
            return Err(StoreError::Conflict(
                "task ID is already in use with different content".to_owned(),
            ));
        }
        load_task_owned(
            &connection,
            &self.cipher,
            &input.tenant_id,
            &input.owner_id,
            &input.id,
        )
    }

    pub fn get_task_owned(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
    ) -> Result<A2aTaskRecord, StoreError> {
        let connection = self.connection()?;
        load_task_owned(&connection, &self.cipher, tenant_id, owner_id, task_id)
    }

    /// Administrative lookup used by Core's authenticated local management API.
    /// Protocol-facing handlers must continue to use [`Self::get_task_owned`].
    pub fn get_task_for_tenant(
        &self,
        tenant_id: &str,
        task_id: &str,
    ) -> Result<A2aTaskRecord, StoreError> {
        let connection = self.connection()?;
        load_task_for_tenant(&connection, &self.cipher, tenant_id, task_id)
    }

    pub fn list_tasks_owned(
        &self,
        tenant_id: &str,
        owner_id: &str,
        context_id: Option<&str>,
        state: Option<TaskState>,
        updated_after: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<A2aTaskRecord>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let state = state.map(|value| value.to_string());
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, context_id, tenant_id, owner_id, peer_id, local_agent_id,
                    direction, state, revision, protocol_task_sealed, created_at, updated_at
             FROM a2a_tasks
             WHERE tenant_id = ?1 AND owner_id = ?2
               AND (?3 IS NULL OR context_id = ?3)
               AND (?4 IS NULL OR state = ?4)
               AND (?5 IS NULL OR updated_at > ?5)
             ORDER BY updated_at DESC, id
             LIMIT ?6 OFFSET ?7",
        )?;
        let rows = statement.query_map(
            params![
                tenant_id,
                owner_id,
                context_id,
                state,
                updated_after,
                limit,
                offset
            ],
            task_row_from_sql,
        )?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(|raw| raw.into_public(&self.cipher))
        })
        .collect()
    }

    pub fn count_tasks_owned(
        &self,
        tenant_id: &str,
        owner_id: &str,
        context_id: Option<&str>,
        state: Option<TaskState>,
        updated_after: Option<&str>,
    ) -> Result<u32, StoreError> {
        let state = state.map(|value| value.to_string());
        let count = self.connection()?.query_row(
            "SELECT COUNT(*) FROM a2a_tasks
             WHERE tenant_id = ?1 AND owner_id = ?2
               AND (?3 IS NULL OR context_id = ?3)
               AND (?4 IS NULL OR state = ?4)
               AND (?5 IS NULL OR updated_at > ?5)",
            params![tenant_id, owner_id, context_id, state, updated_after],
            |row| row.get::<_, i64>(0),
        )?;
        u32::try_from(count).map_err(|_| StoreError::Corrupt("task count overflow".to_owned()))
    }

    /// Administrative task list spanning inbound principals and outbound peers.
    /// This is intentionally separate from caller-owned protocol queries.
    pub fn list_tasks_for_tenant(
        &self,
        tenant_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<A2aTaskRecord>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, context_id, tenant_id, owner_id, peer_id, local_agent_id,
                    direction, state, revision, protocol_task_sealed, created_at, updated_at
             FROM a2a_tasks WHERE tenant_id = ?1
             ORDER BY updated_at DESC, id LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(
            params![tenant_id, limit.clamp(1, MAX_PAGE_SIZE), offset],
            task_row_from_sql,
        )?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(|raw| raw.into_public(&self.cipher))
        })
        .collect()
    }

    pub fn transition_task(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        state: TaskState,
        protocol_task: &Value,
    ) -> Result<A2aTaskRecord, StoreError> {
        ensure_json_size("task", protocol_task, 4 * 1024 * 1024)?;
        let serialized = serde_json::to_string(protocol_task)?;
        let sealed = self
            .cipher
            .seal(&serialized)
            .map_err(|_| StoreError::Crypto)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current = load_task_owned(&transaction, &self.cipher, tenant_id, owner_id, task_id)?;
        validate_task_transition(current.state, state)?;
        if current.state == state && current.protocol_task == *protocol_task {
            transaction.commit()?;
            return Ok(current);
        }
        transaction.execute(
            "UPDATE a2a_tasks
             SET state = ?1, protocol_task_sealed = ?2, revision = revision + 1, updated_at = ?3
             WHERE tenant_id = ?4 AND owner_id = ?5 AND id = ?6",
            params![
                state.to_string(),
                sealed,
                timestamp(),
                tenant_id,
                owner_id,
                task_id
            ],
        )?;
        let updated = load_task_owned(&transaction, &self.cipher, tenant_id, owner_id, task_id)?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn append_task_item(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        item_id: &str,
        kind: TaskItemKind,
        payload: &Value,
    ) -> Result<TaskItemRecord, StoreError> {
        validate_identifier("item ID", item_id)?;
        ensure_json_size("task item", payload, 4 * 1024 * 1024)?;
        let sealed = self
            .cipher
            .seal(&serde_json::to_string(payload)?)
            .map_err(|_| StoreError::Crypto)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        ensure_task_owned(&transaction, tenant_id, owner_id, task_id)?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM a2a_task_items WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        let created_at = timestamp();
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO a2a_task_items (
               task_id, id, kind, sequence, payload_sealed, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task_id,
                item_id,
                kind.to_string(),
                sequence,
                sealed,
                created_at
            ],
        )?;
        if inserted == 0 {
            return load_task_item(&transaction, &self.cipher, task_id, item_id);
        }
        transaction.commit()?;
        Ok(TaskItemRecord {
            id: item_id.to_owned(),
            task_id: task_id.to_owned(),
            kind,
            sequence: u64::try_from(sequence)
                .map_err(|_| StoreError::Corrupt("negative task item sequence".to_owned()))?,
            payload: payload.clone(),
            created_at,
        })
    }

    pub fn list_task_items(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
    ) -> Result<Vec<TaskItemRecord>, StoreError> {
        let connection = self.connection()?;
        ensure_task_owned(&connection, tenant_id, owner_id, task_id)?;
        let mut statement = connection.prepare(
            "SELECT id, task_id, kind, sequence, payload_sealed, created_at
             FROM a2a_task_items WHERE task_id = ?1 ORDER BY sequence",
        )?;
        let rows = statement.query_map([task_id], task_item_row_from_sql)?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(|raw| raw.into_public(&self.cipher))
        })
        .collect()
    }

    pub fn append_event(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        event_type: &str,
        payload: &Value,
    ) -> Result<TaskEventRecord, StoreError> {
        validate_label("event type", event_type, 160)?;
        ensure_json_size("task event", payload, 4 * 1024 * 1024)?;
        let sealed = self
            .cipher
            .seal(&serde_json::to_string(payload)?)
            .map_err(|_| StoreError::Crypto)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        ensure_task_owned(&transaction, tenant_id, owner_id, task_id)?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM a2a_task_events WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        let created_at = timestamp();
        transaction.execute(
            "INSERT INTO a2a_task_events (
               task_id, sequence, event_type, payload_sealed, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, sequence, event_type, sealed, created_at],
        )?;
        transaction.commit()?;
        Ok(TaskEventRecord {
            task_id: task_id.to_owned(),
            sequence: u64::try_from(sequence)
                .map_err(|_| StoreError::Corrupt("negative task event sequence".to_owned()))?,
            event_type: event_type.to_owned(),
            payload: payload.clone(),
            created_at,
        })
    }

    pub fn replay_events(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<TaskEventRecord>, StoreError> {
        let connection = self.connection()?;
        ensure_task_owned(&connection, tenant_id, owner_id, task_id)?;
        let mut statement = connection.prepare(
            "SELECT task_id, sequence, event_type, payload_sealed, created_at
             FROM a2a_task_events
             WHERE task_id = ?1 AND sequence > ?2
             ORDER BY sequence LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                task_id,
                i64::try_from(after_sequence).unwrap_or(i64::MAX),
                limit.clamp(1, MAX_PAGE_SIZE)
            ],
            event_row_from_sql,
        )?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(|raw| raw.into_public(&self.cipher))
        })
        .collect()
    }

    pub fn upsert_push_config(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        input: PushConfigInput,
        endpoint_policy: EndpointPolicy,
    ) -> Result<PushConfigSummary, StoreError> {
        validate_identifier("push configuration ID", &input.id)?;
        validate_endpoint(&input.callback_url, endpoint_policy)?;
        if input
            .token
            .as_ref()
            .is_some_and(|token| token.len() > 4_096)
        {
            return Err(StoreError::InvalidInput(
                "push notification token exceeds 4096 bytes".to_owned(),
            ));
        }
        if let Some(authentication) = &input.authentication {
            ensure_json_size(
                "push notification authentication",
                authentication,
                16 * 1024,
            )?;
        }
        let secrets = PushSecrets {
            token: input.token,
            authentication: input.authentication,
        };
        let secrets_sealed = self
            .cipher
            .seal(&serde_json::to_string(&secrets)?)
            .map_err(|_| StoreError::Crypto)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        ensure_task_owned(&transaction, tenant_id, owner_id, task_id)?;
        let now = timestamp();
        let existing_created_at = transaction
            .query_row(
                "SELECT created_at FROM a2a_push_configs WHERE task_id = ?1 AND id = ?2",
                params![task_id, input.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing_created_at.is_none() {
            let count = transaction.query_row(
                "SELECT COUNT(*) FROM a2a_push_configs WHERE task_id = ?1",
                [task_id],
                |row| row.get::<_, i64>(0),
            )?;
            if count >= MAX_PUSH_CONFIGS_PER_TASK {
                return Err(StoreError::Conflict(
                    "a task may have at most 16 push notification configurations".to_owned(),
                ));
            }
        }
        let created_at = existing_created_at.unwrap_or_else(|| now.clone());
        transaction.execute(
            "INSERT INTO a2a_push_configs (
               task_id, id, callback_url, secrets_sealed, token_configured,
               authentication_configured, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(task_id, id) DO UPDATE SET
               callback_url = excluded.callback_url,
               secrets_sealed = excluded.secrets_sealed,
               token_configured = excluded.token_configured,
               authentication_configured = excluded.authentication_configured,
               updated_at = excluded.updated_at",
            params![
                task_id,
                input.id,
                input.callback_url,
                secrets_sealed,
                secrets.token.is_some(),
                secrets.authentication.is_some(),
                created_at,
                now,
            ],
        )?;
        transaction.commit()?;
        Ok(PushConfigSummary {
            id: input.id,
            task_id: task_id.to_owned(),
            callback_url: input.callback_url,
            token_configured: secrets.token.is_some(),
            authentication_configured: secrets.authentication.is_some(),
            created_at,
            updated_at: now,
        })
    }

    pub fn list_push_configs(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
    ) -> Result<Vec<PushConfigSummary>, StoreError> {
        let connection = self.connection()?;
        ensure_task_owned(&connection, tenant_id, owner_id, task_id)?;
        let mut statement = connection.prepare(
            "SELECT id, task_id, callback_url, token_configured,
                    authentication_configured, created_at, updated_at
             FROM a2a_push_configs WHERE task_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([task_id], push_summary_from_sql)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn resolve_push_config(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        config_id: &str,
    ) -> Result<ResolvedPushConfig, StoreError> {
        let connection = self.connection()?;
        ensure_task_owned(&connection, tenant_id, owner_id, task_id)?;
        let raw = connection
            .query_row(
                "SELECT id, task_id, callback_url, secrets_sealed, token_configured,
                        authentication_configured, created_at, updated_at
                 FROM a2a_push_configs WHERE task_id = ?1 AND id = ?2",
                params![task_id, config_id],
                |row| {
                    Ok((
                        PushConfigSummary {
                            id: row.get(0)?,
                            task_id: row.get(1)?,
                            callback_url: row.get(2)?,
                            token_configured: row.get(4)?,
                            authentication_configured: row.get(5)?,
                            created_at: row.get(6)?,
                            updated_at: row.get(7)?,
                        },
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or(StoreError::NotFound)?;
        let opened = self.cipher.open(&raw.1).map_err(|_| StoreError::Crypto)?;
        let secrets: PushSecrets = serde_json::from_str(&opened)?;
        Ok(ResolvedPushConfig {
            summary: raw.0,
            token: secrets.token,
            authentication: secrets.authentication,
        })
    }

    pub fn delete_push_config(
        &self,
        tenant_id: &str,
        owner_id: &str,
        task_id: &str,
        config_id: &str,
    ) -> Result<(), StoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        ensure_task_owned(&transaction, tenant_id, owner_id, task_id)?;
        let changed = transaction.execute(
            "DELETE FROM a2a_push_configs WHERE task_id = ?1 AND id = ?2",
            params![task_id, config_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        transaction.commit()?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct PushSecrets {
    token: Option<String>,
    authentication: Option<Value>,
}

struct PeerRow {
    id: String,
    tenant_id: String,
    name: String,
    agent_card_url: String,
    agent_card_json: Option<String>,
    credential_kind: CredentialKind,
    credential_sealed: Option<String>,
    trust: PeerTrust,
    enabled: bool,
    last_error: Option<String>,
    created_at: String,
    updated_at: String,
    card_signature_json: Option<String>,
}

impl PeerRow {
    fn into_public(self) -> A2aPeer {
        let agent_card = self
            .agent_card_json
            .and_then(|value| serde_json::from_str(&value).ok());
        A2aPeer {
            id: self.id,
            tenant_id: self.tenant_id,
            name: self.name,
            agent_card_url: self.agent_card_url,
            agent_card,
            card_signature: self
                .card_signature_json
                .and_then(|value| serde_json::from_str(&value).ok()),
            credential_kind: self.credential_kind,
            credential_configured: self.credential_sealed.is_some(),
            trust: self.trust,
            enabled: self.enabled,
            last_error: self.last_error,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

fn peer_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawPeerRow> {
    Ok(RawPeerRow {
        id: row.get(0)?,
        tenant_id: row.get(1)?,
        name: row.get(2)?,
        agent_card_url: row.get(3)?,
        agent_card_json: row.get(4)?,
        credential_kind: row.get(5)?,
        credential_sealed: row.get(6)?,
        trust: row.get(7)?,
        enabled: row.get(8)?,
        last_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        card_signature_json: row.get(12)?,
    })
}

struct RawPeerRow {
    id: String,
    tenant_id: String,
    name: String,
    agent_card_url: String,
    agent_card_json: Option<String>,
    credential_kind: String,
    credential_sealed: Option<String>,
    trust: String,
    enabled: bool,
    last_error: Option<String>,
    created_at: String,
    updated_at: String,
    card_signature_json: Option<String>,
}

fn parse_peer_row(raw: RawPeerRow) -> rusqlite::Result<PeerRow> {
    Ok(PeerRow {
        id: raw.id,
        tenant_id: raw.tenant_id,
        name: raw.name,
        agent_card_url: raw.agent_card_url,
        agent_card_json: raw.agent_card_json,
        credential_kind: parse_enum(raw.credential_kind, "credential kind")?,
        credential_sealed: raw.credential_sealed,
        trust: parse_enum(raw.trust, "peer trust")?,
        enabled: raw.enabled,
        last_error: raw.last_error,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        card_signature_json: raw.card_signature_json,
    })
}

/// Add a column to a table created by an earlier schema, once.
fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
        ))?
        .exists([column])?;
    if !exists {
        connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition};"))?;
    }
    Ok(())
}

fn load_peer_row(
    connection: &Connection,
    tenant_id: &str,
    peer_id: &str,
) -> Result<Option<PeerRow>, StoreError> {
    connection
        .query_row(
            "SELECT id, tenant_id, name, agent_card_url, agent_card_json,
                    credential_kind, credential_sealed, trust, enabled, last_error,
                    created_at, updated_at, card_signature_json
             FROM a2a_peers WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, peer_id],
            peer_row_from_sql,
        )
        .optional()?
        .map(parse_peer_row)
        .transpose()
        .map_err(StoreError::from)
}

struct PrincipalRow {
    id: String,
    tenant_id: String,
    name: String,
    token_hash: Vec<u8>,
    scopes_json: String,
    created_at: String,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
    published_agent_id: Option<String>,
    capability_allowlist_json: Option<String>,
}

impl PrincipalRow {
    fn into_public(self) -> Result<A2aPrincipal, StoreError> {
        let public_agent = match (self.published_agent_id, self.capability_allowlist_json) {
            (None, None) => None,
            (Some(published_agent_id), Some(capability_allowlist_json)) => {
                Some(A2aPublicAgentBinding {
                    published_agent_id,
                    capability_allowlist: serde_json::from_str(&capability_allowlist_json)?,
                })
            }
            _ => {
                return Err(StoreError::Corrupt(
                    "A2A public principal binding is incomplete".to_owned(),
                ));
            }
        };
        Ok(A2aPrincipal {
            id: self.id,
            tenant_id: self.tenant_id,
            name: self.name,
            scopes: serde_json::from_str(&self.scopes_json)?,
            public_agent,
            created_at: self.created_at,
            last_used_at: self.last_used_at,
            revoked_at: self.revoked_at,
        })
    }
}

struct TaskRow {
    id: String,
    context_id: String,
    tenant_id: String,
    owner_id: String,
    peer_id: Option<String>,
    local_agent_id: Option<String>,
    direction: String,
    state: String,
    revision: i64,
    protocol_task_sealed: String,
    created_at: String,
    updated_at: String,
}

impl TaskRow {
    fn into_public(self, cipher: &FieldCipher) -> Result<A2aTaskRecord, StoreError> {
        let opened = cipher
            .open(&self.protocol_task_sealed)
            .map_err(|_| StoreError::Crypto)?;
        Ok(A2aTaskRecord {
            id: self.id,
            context_id: self.context_id,
            tenant_id: self.tenant_id,
            owner_id: self.owner_id,
            peer_id: self.peer_id,
            local_agent_id: self.local_agent_id,
            direction: TaskDirection::from_str(&self.direction)
                .map_err(|error| StoreError::Corrupt(error.to_owned()))?,
            state: TaskState::from_str(&self.state)
                .map_err(|error| StoreError::Corrupt(error.to_owned()))?,
            revision: u64::try_from(self.revision)
                .map_err(|_| StoreError::Corrupt("negative task revision".to_owned()))?,
            protocol_task: serde_json::from_str(&opened)?,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

fn task_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get(0)?,
        context_id: row.get(1)?,
        tenant_id: row.get(2)?,
        owner_id: row.get(3)?,
        peer_id: row.get(4)?,
        local_agent_id: row.get(5)?,
        direction: row.get(6)?,
        state: row.get(7)?,
        revision: row.get(8)?,
        protocol_task_sealed: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn load_task_owned(
    connection: &Connection,
    cipher: &FieldCipher,
    tenant_id: &str,
    owner_id: &str,
    task_id: &str,
) -> Result<A2aTaskRecord, StoreError> {
    let row = connection
        .query_row(
            "SELECT id, context_id, tenant_id, owner_id, peer_id, local_agent_id,
                    direction, state, revision, protocol_task_sealed, created_at, updated_at
             FROM a2a_tasks WHERE tenant_id = ?1 AND owner_id = ?2 AND id = ?3",
            params![tenant_id, owner_id, task_id],
            task_row_from_sql,
        )
        .optional()?
        .ok_or(StoreError::NotFound)?;
    row.into_public(cipher)
}

fn load_task_for_tenant(
    connection: &Connection,
    cipher: &FieldCipher,
    tenant_id: &str,
    task_id: &str,
) -> Result<A2aTaskRecord, StoreError> {
    let row = connection
        .query_row(
            "SELECT id, context_id, tenant_id, owner_id, peer_id, local_agent_id,
                    direction, state, revision, protocol_task_sealed, created_at, updated_at
             FROM a2a_tasks WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, task_id],
            task_row_from_sql,
        )
        .optional()?
        .ok_or(StoreError::NotFound)?;
    row.into_public(cipher)
}

fn ensure_task_owned(
    connection: &Connection,
    tenant_id: &str,
    owner_id: &str,
    task_id: &str,
) -> Result<(), StoreError> {
    let found = connection
        .query_row(
            "SELECT 1 FROM a2a_tasks WHERE tenant_id = ?1 AND owner_id = ?2 AND id = ?3",
            params![tenant_id, owner_id, task_id],
            |_| Ok(()),
        )
        .optional()?;
    found.ok_or(StoreError::NotFound)
}

struct TaskItemRow {
    id: String,
    task_id: String,
    kind: String,
    sequence: i64,
    payload_sealed: String,
    created_at: String,
}

impl TaskItemRow {
    fn into_public(self, cipher: &FieldCipher) -> Result<TaskItemRecord, StoreError> {
        let opened = cipher
            .open(&self.payload_sealed)
            .map_err(|_| StoreError::Crypto)?;
        Ok(TaskItemRecord {
            id: self.id,
            task_id: self.task_id,
            kind: TaskItemKind::from_str(&self.kind)
                .map_err(|error| StoreError::Corrupt(error.to_owned()))?,
            sequence: u64::try_from(self.sequence)
                .map_err(|_| StoreError::Corrupt("negative task item sequence".to_owned()))?,
            payload: serde_json::from_str(&opened)?,
            created_at: self.created_at,
        })
    }
}

fn task_item_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskItemRow> {
    Ok(TaskItemRow {
        id: row.get(0)?,
        task_id: row.get(1)?,
        kind: row.get(2)?,
        sequence: row.get(3)?,
        payload_sealed: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn load_task_item(
    transaction: &Transaction<'_>,
    cipher: &FieldCipher,
    task_id: &str,
    item_id: &str,
) -> Result<TaskItemRecord, StoreError> {
    let row = transaction
        .query_row(
            "SELECT id, task_id, kind, sequence, payload_sealed, created_at
             FROM a2a_task_items WHERE task_id = ?1 AND id = ?2",
            params![task_id, item_id],
            task_item_row_from_sql,
        )
        .optional()?
        .ok_or(StoreError::NotFound)?;
    row.into_public(cipher)
}

struct EventRow {
    task_id: String,
    sequence: i64,
    event_type: String,
    payload_sealed: String,
    created_at: String,
}

impl EventRow {
    fn into_public(self, cipher: &FieldCipher) -> Result<TaskEventRecord, StoreError> {
        let opened = cipher
            .open(&self.payload_sealed)
            .map_err(|_| StoreError::Crypto)?;
        Ok(TaskEventRecord {
            task_id: self.task_id,
            sequence: u64::try_from(self.sequence)
                .map_err(|_| StoreError::Corrupt("negative task event sequence".to_owned()))?,
            event_type: self.event_type,
            payload: serde_json::from_str(&opened)?,
            created_at: self.created_at,
        })
    }
}

fn event_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        task_id: row.get(0)?,
        sequence: row.get(1)?,
        event_type: row.get(2)?,
        payload_sealed: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn push_summary_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<PushConfigSummary> {
    Ok(PushConfigSummary {
        id: row.get(0)?,
        task_id: row.get(1)?,
        callback_url: row.get(2)?,
        token_configured: row.get(3)?,
        authentication_configured: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn published_agent_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<PublishedAgent> {
    let skills_json: String = row.get(5)?;
    let skills = serde_json::from_str(&skills_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PublishedAgent {
        id: row.get(0)?,
        tenant_id: row.get(1)?,
        agent_id: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        skills,
        enabled: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn parse_enum<T>(value: String, label: &str) -> rusqlite::Result<T>
where
    T: FromStr,
{
    T::from_str(&value).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid {label}").into(),
        )
    })
}

fn validate_identifier(label: &str, value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 256 {
        return Err(StoreError::InvalidInput(format!(
            "{label} must contain 1 to 256 bytes"
        )));
    }
    Ok(())
}

fn validate_public_capability_allowlist(capabilities: &BTreeSet<String>) -> Result<(), StoreError> {
    const MAX_PUBLIC_CAPABILITIES: usize = 256;
    const MAX_PUBLIC_CAPABILITY_BYTES: usize = 256;
    const MAX_PUBLIC_CAPABILITY_JSON_BYTES: usize = 64 * 1024;
    const ALLOWED_PREFIXES: [&str; 4] = ["tool:", "composio:", "skill:", "identity:"];

    if capabilities.len() > MAX_PUBLIC_CAPABILITIES {
        return Err(StoreError::InvalidInput(format!(
            "a public principal may allow at most {MAX_PUBLIC_CAPABILITIES} capabilities"
        )));
    }
    for capability in capabilities {
        let Some((prefix, id)) = capability.split_once(':') else {
            return Err(StoreError::InvalidInput(
                "public capabilities must use a supported namespace".to_owned(),
            ));
        };
        let prefix = format!("{prefix}:");
        if !ALLOWED_PREFIXES.contains(&prefix.as_str())
            || id.trim().is_empty()
            || id.len() > MAX_PUBLIC_CAPABILITY_BYTES
            || id.contains('*')
            || id.chars().any(char::is_control)
        {
            return Err(StoreError::InvalidInput(
                "public capabilities must be exact, namespaced identifiers".to_owned(),
            ));
        }
        if capability.len() > MAX_PUBLIC_CAPABILITY_BYTES {
            return Err(StoreError::InvalidInput(
                "a public capability identifier is too long".to_owned(),
            ));
        }
    }
    if serde_json::to_vec(capabilities)?.len() > MAX_PUBLIC_CAPABILITY_JSON_BYTES {
        return Err(StoreError::InvalidInput(
            "the public capability allowlist exceeds the 64 KiB limit".to_owned(),
        ));
    }
    Ok(())
}

fn validate_label(label: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(StoreError::InvalidInput(format!(
            "{label} must contain 1 to {max_bytes} bytes"
        )));
    }
    Ok(())
}

fn ensure_json_size(label: &str, value: &Value, max_bytes: usize) -> Result<(), StoreError> {
    let size = serde_json::to_vec(value)?.len();
    if size > max_bytes {
        return Err(StoreError::InvalidInput(format!(
            "{label} exceeds the {max_bytes}-byte limit"
        )));
    }
    Ok(())
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("ryu_a2a_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    fn store() -> A2aStore {
        A2aStore::open_in_memory(FieldCipher::new(&[7_u8; 32])).expect("open A2A store")
    }

    fn development_policy() -> EndpointPolicy {
        EndpointPolicy {
            allow_loopback_http: true,
        }
    }

    fn trusted_peer(store: &A2aStore) -> A2aPeer {
        let peer = store
            .upsert_peer(
                PeerUpsert {
                    id: Some("peer-1".to_owned()),
                    tenant_id: "tenant-a".to_owned(),
                    name: "Reference agent".to_owned(),
                    agent_card_url: "http://127.0.0.1:7788/.well-known/agent-card.json".to_owned(),
                    agent_card: Some(json!({"name": "Reference agent"})),
                    card_signature: None,
                    credential: Some(PeerCredential::Bearer {
                        token: "super-secret".to_owned(),
                    }),
                    enabled: true,
                },
                development_policy(),
            )
            .expect("save peer");
        store
            .set_peer_trust("tenant-a", &peer.id, PeerTrust::Trusted)
            .expect("trust peer")
    }

    fn create_task(store: &A2aStore, tenant_id: &str, owner_id: &str, task_id: &str) {
        store
            .create_task(TaskCreate {
                id: task_id.to_owned(),
                context_id: "context-1".to_owned(),
                tenant_id: tenant_id.to_owned(),
                owner_id: owner_id.to_owned(),
                peer_id: None,
                local_agent_id: Some("agent-1".to_owned()),
                direction: TaskDirection::Inbound,
                state: TaskState::Submitted,
                protocol_task: json!({"id": task_id, "status": {"state": "submitted"}}),
            })
            .expect("create task");
    }

    #[test]
    fn peer_credentials_are_write_only_and_require_trust() {
        let store = store();
        let peer = store
            .upsert_peer(
                PeerUpsert {
                    id: Some("peer-1".to_owned()),
                    tenant_id: "tenant-a".to_owned(),
                    name: "Reference agent".to_owned(),
                    agent_card_url: "http://127.0.0.1:7788/.well-known/agent-card.json".to_owned(),
                    agent_card: None,
                    card_signature: None,
                    credential: Some(PeerCredential::Bearer {
                        token: "super-secret".to_owned(),
                    }),
                    enabled: true,
                },
                development_policy(),
            )
            .expect("save peer");
        assert!(peer.credential_configured);
        let public_json = serde_json::to_string(&peer).expect("serialize public peer");
        assert!(!public_json.contains("super-secret"));
        assert!(matches!(
            store.resolve_peer_for_transport("tenant-a", "peer-1"),
            Err(StoreError::AuthenticationFailed)
        ));

        store
            .set_peer_trust("tenant-a", "peer-1", PeerTrust::Trusted)
            .expect("trust peer");
        let resolved = store
            .resolve_peer_for_transport("tenant-a", "peer-1")
            .expect("resolve trusted peer");
        assert!(matches!(
            resolved.credential,
            PeerCredential::Bearer { ref token } if token == "super-secret"
        ));
        assert!(!format!("{resolved:?}").contains("super-secret"));
    }

    #[test]
    fn principal_tokens_are_one_time_scoped_and_revocable() {
        let store = store();
        let issued = store
            .issue_principal_token(
                "tenant-a",
                "Hermes",
                BTreeSet::from([A2aScope::Send, A2aScope::Read]),
            )
            .expect("issue token");
        assert!(issued.token.starts_with("ryu_a2a_"));
        assert!(!format!("{issued:?}").contains(&issued.token));
        let principal = store
            .authenticate_principal("tenant-a", &issued.token, A2aScope::Send)
            .expect("authenticate");
        assert_eq!(principal.id, issued.principal.id);
        assert!(matches!(
            store.authenticate_principal("tenant-a", &issued.token, A2aScope::Cancel),
            Err(StoreError::AuthenticationFailed)
        ));
        assert!(matches!(
            store.authenticate_principal("tenant-b", &issued.token, A2aScope::Send),
            Err(StoreError::AuthenticationFailed)
        ));
        store
            .revoke_principal("tenant-a", &issued.principal.id)
            .expect("revoke");
        assert!(matches!(
            store.authenticate_principal("tenant-a", &issued.token, A2aScope::Send),
            Err(StoreError::AuthenticationFailed)
        ));
    }

    #[test]
    fn public_principals_are_bound_to_one_enabled_publication_and_restore_exact_capabilities() {
        let store = store();
        let published = store
            .upsert_published_agent(PublishedAgentUpsert {
                id: Some("publication-a".to_owned()),
                tenant_id: "tenant-a".to_owned(),
                agent_id: "agent-a".to_owned(),
                name: "Agent A".to_owned(),
                description: "A published test agent".to_owned(),
                skills: Vec::new(),
                enabled: true,
            })
            .expect("publish agent");
        let capabilities = BTreeSet::from([
            "tool:files.read_file".to_owned(),
            "skill:public-faq".to_owned(),
        ]);
        let issued = store
            .issue_public_agent_principal_token(
                "tenant-a",
                "Profile visitor",
                BTreeSet::from([A2aScope::Send]),
                &published.id,
                capabilities.clone(),
            )
            .expect("issue public principal");

        assert!(!format!("{issued:?}").contains(&issued.token));
        assert!(issued.principal.allows_published_agent(&published.id));
        assert!(!issued.principal.allows_published_agent("publication-b"));
        assert!(issued
            .principal
            .allows_public_capability("tool:files.read_file"));
        assert!(!issued
            .principal
            .allows_public_capability("tool:files.write_file"));

        let authenticated = store
            .authenticate_principal("tenant-a", &issued.token, A2aScope::Send)
            .expect("authenticate bound principal");
        let binding = authenticated.public_agent.expect("public binding");
        assert_eq!(binding.published_agent_id, published.id);
        assert_eq!(binding.capability_allowlist, capabilities);
    }

    #[test]
    fn public_principal_capabilities_must_be_explicit_and_exact() {
        let store = store();
        let published = store
            .upsert_published_agent(PublishedAgentUpsert {
                id: Some("publication-a".to_owned()),
                tenant_id: "tenant-a".to_owned(),
                agent_id: "agent-a".to_owned(),
                name: "Agent A".to_owned(),
                description: "A published test agent".to_owned(),
                skills: Vec::new(),
                enabled: true,
            })
            .expect("publish agent");
        for capability in ["*", "tool:*", "unknown:capability", "tool: "] {
            assert!(matches!(
                store.issue_public_agent_principal_token(
                    "tenant-a",
                    "Profile visitor",
                    BTreeSet::from([A2aScope::Send]),
                    &published.id,
                    BTreeSet::from([capability.to_owned()]),
                ),
                Err(StoreError::InvalidInput(_))
            ));
        }
        for scopes in [
            BTreeSet::from([A2aScope::Send, A2aScope::Read]),
            BTreeSet::from([A2aScope::Send, A2aScope::Cancel]),
            BTreeSet::from([A2aScope::Send, A2aScope::Subscribe]),
            BTreeSet::from([A2aScope::Send, A2aScope::PushConfig]),
            BTreeSet::from([A2aScope::Send, A2aScope::ExtendedCard]),
            BTreeSet::from([A2aScope::Read]),
        ] {
            assert!(matches!(
                store.issue_public_agent_principal_token(
                    "tenant-a",
                    "Profile visitor",
                    scopes,
                    &published.id,
                    BTreeSet::new(),
                ),
                Err(StoreError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn existing_principals_migrate_as_unbound_without_behavior_changes() {
        let connection = Connection::open_in_memory().expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE a2a_principals (
                   id TEXT PRIMARY KEY,
                   tenant_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   token_hash BLOB NOT NULL UNIQUE,
                   scopes_json TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   last_used_at TEXT,
                   revoked_at TEXT
                 );",
            )
            .expect("create legacy principal schema");
        let token = generate_token();
        let token_hash = hash_token(&token);
        connection
            .execute(
                "INSERT INTO a2a_principals (
                   id, tenant_id, name, token_hash, scopes_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    "legacy-principal",
                    "tenant-a",
                    "Legacy principal",
                    token_hash.as_slice(),
                    serde_json::to_string(&BTreeSet::from([A2aScope::Send])).expect("scopes"),
                    timestamp(),
                ],
            )
            .expect("insert legacy principal");

        let store = A2aStore::from_connection(connection, FieldCipher::new(&[7_u8; 32]))
            .expect("migrate legacy database");
        let principal = store
            .authenticate_principal("tenant-a", &token, A2aScope::Send)
            .expect("authenticate legacy principal");
        assert!(principal.public_agent.is_none());
        assert!(principal.allows_published_agent("any-publication"));
        assert!(principal.allows_public_capability("tool:any-tool"));
    }

    #[test]
    fn legacy_databases_gain_card_signature_columns() {
        let connection = Connection::open_in_memory().expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE a2a_peers (
                   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
                   agent_card_url TEXT NOT NULL, agent_card_json TEXT,
                   credential_kind TEXT NOT NULL, credential_sealed TEXT, trust TEXT NOT NULL,
                   enabled INTEGER NOT NULL, last_error TEXT,
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE a2a_server_config (
                   tenant_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
                   display_name TEXT NOT NULL, description TEXT NOT NULL,
                   public_base_url TEXT, expose_extended_card INTEGER NOT NULL,
                   max_payload_bytes INTEGER NOT NULL, max_concurrent_tasks INTEGER NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO a2a_server_config VALUES
                   ('tenant-a', 1, 'Ryu', 'Legacy', NULL, 0, 1048576, 32, 'then');
                 INSERT INTO a2a_peers VALUES
                   ('peer-1', 'tenant-a', 'Legacy peer', 'https://peer.example.com', NULL,
                    'none', NULL, 'pending', 1, NULL, 'then', 'then');",
            )
            .expect("create legacy schema");
        let store = A2aStore::from_connection(connection, FieldCipher::new(&[7_u8; 32]))
            .expect("migrate legacy database");
        assert!(
            !store
                .server_config("tenant-a")
                .expect("legacy config")
                .require_signed_peer_cards
        );
        assert!(store
            .get_peer("tenant-a", "peer-1")
            .expect("legacy peer")
            .card_signature
            .is_none());

        let mut config = store.server_config("tenant-a").expect("config");
        config.require_signed_peer_cards = true;
        store
            .save_server_config(config, development_policy())
            .expect("save config");
        assert!(
            store
                .server_config("tenant-a")
                .expect("config")
                .require_signed_peer_cards
        );

        let verified = crate::CardSignatureStatus::Verified {
            kid: "kid-1".to_owned(),
            jku: Some("https://peer.example.com/a2a-card/jwks.json".to_owned()),
        };
        let peer = store
            .upsert_peer(
                PeerUpsert {
                    id: Some("peer-1".to_owned()),
                    tenant_id: "tenant-a".to_owned(),
                    name: "Legacy peer".to_owned(),
                    agent_card_url: "https://peer.example.com".to_owned(),
                    agent_card: Some(json!({"name": "Legacy peer"})),
                    card_signature: Some(verified.clone()),
                    credential: None,
                    enabled: true,
                },
                development_policy(),
            )
            .expect("save peer");
        assert_eq!(peer.card_signature, Some(verified.clone()));
        let listed = store.list_peers("tenant-a").expect("list peers");
        assert_eq!(listed[0].card_signature, Some(verified));
        let public = serde_json::to_value(&listed[0]).expect("serialize peer");
        assert_eq!(public["cardSignature"]["status"], "verified");
    }

    #[test]
    fn task_access_is_always_tenant_and_owner_scoped() {
        let store = store();
        create_task(&store, "tenant-a", "principal-a", "task-1");
        assert!(store
            .get_task_owned("tenant-a", "principal-a", "task-1")
            .is_ok());
        assert!(matches!(
            store.get_task_owned("tenant-a", "principal-b", "task-1"),
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.get_task_owned("tenant-b", "principal-a", "task-1"),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn duplicate_create_and_cancel_are_idempotent() {
        let store = store();
        create_task(&store, "tenant-a", "principal-a", "task-1");
        create_task(&store, "tenant-a", "principal-a", "task-1");
        let canceled_payload = json!({"id": "task-1", "status": {"state": "canceled"}});
        let first = store
            .transition_task(
                "tenant-a",
                "principal-a",
                "task-1",
                TaskState::Canceled,
                &canceled_payload,
            )
            .expect("cancel task");
        let second = store
            .transition_task(
                "tenant-a",
                "principal-a",
                "task-1",
                TaskState::Canceled,
                &canceled_payload,
            )
            .expect("repeat cancel");
        assert_eq!(first.revision, second.revision);
        assert!(matches!(
            store.transition_task(
                "tenant-a",
                "principal-a",
                "task-1",
                TaskState::Working,
                &json!({"id": "task-1", "status": {"state": "working"}}),
            ),
            Err(StoreError::InvalidTransition(_))
        ));
    }

    #[test]
    fn events_items_and_push_configs_replay_without_exposing_secrets() {
        let store = store();
        create_task(&store, "tenant-a", "principal-a", "task-1");
        let item = store
            .append_task_item(
                "tenant-a",
                "principal-a",
                "task-1",
                "message-1",
                TaskItemKind::Message,
                &json!({"role": "user", "parts": [{"text": "hello"}]}),
            )
            .expect("append item");
        assert_eq!(item.sequence, 1);
        let first = store
            .append_event(
                "tenant-a",
                "principal-a",
                "task-1",
                "task",
                &json!({"id": "task-1"}),
            )
            .expect("append event");
        let second = store
            .append_event(
                "tenant-a",
                "principal-a",
                "task-1",
                "status-update",
                &json!({"final": false}),
            )
            .expect("append event");
        assert_eq!((first.sequence, second.sequence), (1, 2));
        let replay = store
            .replay_events("tenant-a", "principal-a", "task-1", 1, 20)
            .expect("replay events");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, 2);

        let summary = store
            .upsert_push_config(
                "tenant-a",
                "principal-a",
                "task-1",
                PushConfigInput {
                    id: "push-1".to_owned(),
                    callback_url: "https://example.com/a2a/events".to_owned(),
                    token: Some("push-secret".to_owned()),
                    authentication: Some(json!({"schemes": ["Bearer"]})),
                },
                EndpointPolicy::default(),
            )
            .expect("save push config");
        assert!(summary.token_configured);
        assert!(!serde_json::to_string(&summary)
            .expect("serialize summary")
            .contains("push-secret"));
        let resolved = store
            .resolve_push_config("tenant-a", "principal-a", "task-1", "push-1")
            .expect("resolve push config");
        assert_eq!(resolved.token.as_deref(), Some("push-secret"));
        assert!(!format!("{resolved:?}").contains("push-secret"));
    }

    #[test]
    fn encrypted_tasks_survive_store_restart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("a2a.db");
        let key = [11_u8; 32];
        {
            let store = A2aStore::open(&path, FieldCipher::new(&key)).expect("open first store");
            store
                .create_task(TaskCreate {
                    id: "restart-task".to_owned(),
                    context_id: "restart-context".to_owned(),
                    tenant_id: "tenant-a".to_owned(),
                    owner_id: "principal-a".to_owned(),
                    peer_id: None,
                    local_agent_id: Some("agent-a".to_owned()),
                    direction: TaskDirection::Inbound,
                    state: TaskState::Submitted,
                    protocol_task: json!({
                        "id": "restart-task",
                        "privateMarker": "never-store-this-in-plaintext"
                    }),
                })
                .expect("persist task");
        }

        let database = std::fs::read(&path).expect("read database");
        assert!(!database
            .windows(b"never-store-this-in-plaintext".len())
            .any(|window| window == b"never-store-this-in-plaintext"));

        let reopened = A2aStore::open(&path, FieldCipher::new(&key)).expect("reopen store");
        let task = reopened
            .get_task_owned("tenant-a", "principal-a", "restart-task")
            .expect("load task after restart");
        assert_eq!(
            task.protocol_task["privateMarker"],
            "never-store-this-in-plaintext"
        );
    }

    #[test]
    fn published_agent_upsert_returns_without_relocking_the_store() {
        let store = store();
        let published = store
            .upsert_published_agent(PublishedAgentUpsert {
                id: None,
                tenant_id: "tenant-a".to_owned(),
                agent_id: "agent-a".to_owned(),
                name: "Agent A".to_owned(),
                description: "A published test agent".to_owned(),
                skills: Vec::new(),
                enabled: true,
            })
            .expect("publish agent");
        assert_eq!(published.agent_id, "agent-a");
        assert_eq!(
            store
                .list_published_agents("tenant-a", true)
                .expect("list published agents")
                .len(),
            1
        );
    }

    #[test]
    fn push_configuration_count_is_bounded_per_task() {
        let store = store();
        create_task(&store, "tenant-a", "principal-a", "task-1");
        for index in 0..MAX_PUSH_CONFIGS_PER_TASK {
            store
                .upsert_push_config(
                    "tenant-a",
                    "principal-a",
                    "task-1",
                    PushConfigInput {
                        id: format!("push-{index}"),
                        callback_url: format!("https://push-{index}.example.com/events"),
                        token: None,
                        authentication: None,
                    },
                    EndpointPolicy::default(),
                )
                .expect("save bounded push config");
        }
        assert!(matches!(
            store.upsert_push_config(
                "tenant-a",
                "principal-a",
                "task-1",
                PushConfigInput {
                    id: "push-overflow".to_owned(),
                    callback_url: "https://overflow.example.com/events".to_owned(),
                    token: None,
                    authentication: None,
                },
                EndpointPolicy::default(),
            ),
            Err(StoreError::Conflict(_))
        ));
    }

    #[test]
    fn peer_update_preserves_credential_and_trust_when_secret_is_omitted() {
        let store = store();
        let original = trusted_peer(&store);
        let updated = store
            .upsert_peer(
                PeerUpsert {
                    id: Some(original.id.clone()),
                    tenant_id: "tenant-a".to_owned(),
                    name: "Renamed agent".to_owned(),
                    agent_card_url: original.agent_card_url,
                    agent_card: original.agent_card,
                    card_signature: original.card_signature,
                    credential: None,
                    enabled: true,
                },
                development_policy(),
            )
            .expect("update peer");
        assert_eq!(updated.trust, PeerTrust::Trusted);
        assert!(updated.credential_configured);
        assert!(matches!(
            store
                .resolve_peer_for_transport("tenant-a", &updated.id)
                .expect("resolve")
                .credential,
            PeerCredential::Bearer { ref token } if token == "super-secret"
        ));
    }
}
