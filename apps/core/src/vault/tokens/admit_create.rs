//! Token admission, lookup, renewal and child or admin-created tokens.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::machine::{
    IssuedToken, MachineIdentity, DEFAULT_TOKEN_TTL_SECS, MAX_TOKEN_TTL_SECS,
};
use crate::vault::{now_millis, VaultError};

use super::*;
use super::{cidr::*, config::*, context::*, issue::*};

impl PluginSecretStore {
    /// Lifecycle checks for a presented token, run under the connection lock
    /// on every authenticated request: the parent chain must be live, the
    /// client address must satisfy the token's CIDRs, and a use is consumed
    /// (the token is revoked as its last use is spent). Returns the policies
    /// the token may use now, or `None` to reject it.
    pub(crate) fn token_admit_locked(
        &self,
        conn: &Connection,
        accessor: &str,
        now: i64,
        mut policies: Vec<String>,
    ) -> Result<Option<Vec<String>>> {
        let info = token_info_locked(conn, accessor)?;
        if live_depth_locked(conn, info.parent_accessor.clone(), now)?.is_none() {
            return Ok(None);
        }
        if !ip_allowed(&info.bound_cidrs, request_client_ip()) {
            self.audit_locked(
                conn,
                &AuditEntry::new(
                    &AuditActor::new("machine", Some(&info.identity_id)),
                    "token.use",
                    "denied",
                )
                .details(json!({ "accessor": accessor, "reason": "source address not allowed" })),
            );
            return Ok(None);
        }
        if info.num_uses_remaining.is_some() {
            // All SET expressions read the pre-update row, so the use that
            // brings the count to zero also revokes the token, atomically.
            let consumed = conn.execute(
                "UPDATE vault_tokens
                 SET num_uses = num_uses - 1,
                     revoked_at = CASE WHEN num_uses <= 1 THEN ?1 ELSE revoked_at END,
                     spent_at = CASE WHEN num_uses <= 1 THEN ?1 ELSE spent_at END
                 WHERE accessor = ?2 AND num_uses > 0 AND revoked_at IS NULL",
                params![now, accessor],
            )?;
            if consumed == 0 {
                return Ok(None);
            }
        }
        narrow_scoped_locked(conn, accessor, &info, &mut policies)?;
        note_request_token(accessor);
        Ok(Some(policies))
    }

    /// Token metadata by accessor.
    pub async fn token_info(&self, accessor: &str) -> Result<TokenInfo> {
        let conn = self.conn.lock().await;
        token_info_locked(&conn, accessor)
    }

    /// Live tokens, optionally for one identity (id or name), newest first.
    pub async fn token_list(&self, identity: Option<&str>) -> Result<Vec<TokenInfo>> {
        let conn = self.conn.lock().await;
        let identity_id = match identity {
            Some(identity) => Some(crate::vault::machine::identity_locked(&conn, identity)?.id),
            None => None,
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM vault_tokens
             WHERE (?1 IS NULL OR identity_id = ?1) AND revoked_at IS NULL AND expires_at > ?2
             ORDER BY created_at DESC LIMIT 1000"
        ))?;
        let rows = stmt.query_map(params![identity_id, now_millis()], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Renew a token by accessor. A periodic token gains one period; others
    /// gain `increment_secs` (default: the token's TTL). Never past the max
    /// TTL or a live parent's expiry, and never shortened.
    pub async fn token_renew(
        &self,
        accessor: &str,
        increment_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<TokenInfo> {
        let conn = self.conn.lock().await;
        let info = token_info_locked(&conn, accessor)?;
        let now = now_millis();
        if !is_live(&info, now) {
            return Err(VaultError::Conflict("the token has expired or was revoked".into()).into());
        }
        if !info.renewable {
            return Err(VaultError::Denied("this token is not renewable".into()).into());
        }
        if live_depth_locked(&conn, info.parent_accessor.clone(), now)?.is_none() {
            return Err(VaultError::Conflict("the parent token is no longer live".into()).into());
        }
        let ttl_secs: Option<i64> = conn.query_row(
            "SELECT ttl_secs FROM vault_tokens WHERE accessor = ?1",
            params![accessor],
            |row| row.get(0),
        )?;
        let increment = match info.period_secs {
            Some(period) => period,
            None => increment_secs
                .or(ttl_secs)
                .unwrap_or(DEFAULT_TOKEN_TTL_SECS)
                .clamp(1, MAX_TOKEN_MAX_TTL_SECS),
        };
        let mut expires_at = now + increment * 1000;
        if let Some(max) = info.max_expires_at {
            expires_at = expires_at.min(max);
        }
        if let Some(parent) = &info.parent_accessor {
            expires_at = expires_at.min(token_info_locked(&conn, parent)?.expires_at);
        }
        let expires_at = expires_at.max(info.expires_at);
        conn.execute(
            "UPDATE vault_tokens SET expires_at = ?1 WHERE accessor = ?2",
            params![expires_at, accessor],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "token.renew", "ok")
                .details(json!({ "accessor": accessor, "expiresAt": expires_at })),
        );
        token_info_locked(&conn, accessor)
    }

    /// Mint a token for `identity_id`. With `parent`, the token is a child
    /// (policy subset, TTL capped by the parent) unless the role makes it an
    /// orphan; without, an administrator is minting a root token.
    fn token_create_locked(
        &self,
        conn: &Connection,
        identity: &MachineIdentity,
        base_policies: &[String],
        parent: Option<&ParentToken<'_>>,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let now = now_millis();
        let role = match &request.role {
            Some(name) => Some(load_role_locked(conn, name)?),
            None => None,
        };
        let mut parent_info = None;
        if let Some(parent) = parent {
            let info = token_info_locked(conn, parent.accessor)?;
            if info.num_uses_remaining.is_some() {
                return Err(VaultError::Denied(
                    "a use-limited token cannot create child tokens".into(),
                )
                .into());
            }
            let depth = live_depth_locked(conn, info.parent_accessor.clone(), now)?
                .ok_or_else(|| VaultError::Conflict("the parent token is not live".into()))?;
            if depth >= MAX_CHILD_DEPTH {
                return Err(VaultError::Invalid("the token chain is too deep".into()).into());
            }
            parent_info = Some(info);
        }
        let role_orphan = role.as_ref().is_some_and(|role| role.orphan);
        let orphan = match (parent.is_some(), request.orphan) {
            // Only a role an administrator configured can detach a child.
            (true, Some(true)) if !role_orphan => {
                return Err(VaultError::Denied(
                    "orphan child tokens require a token role with `orphan: true`".into(),
                )
                .into())
            }
            (true, _) => role_orphan,
            (false, _) => true,
        };
        let policies = child_policies(base_policies, request.policies, role.as_ref())?;
        let role_config = role
            .as_ref()
            .map(|role| role.token.clone())
            .unwrap_or_default();
        let config = TokenConfig {
            max_ttl_secs: role_config.max_ttl_secs,
            explicit_max_ttl_secs: min_opt(
                role_config.explicit_max_ttl_secs,
                request.explicit_max_ttl_secs,
            ),
            period_secs: role_config.period_secs.or(request.period_secs),
            num_uses: min_opt(role_config.num_uses, request.num_uses.filter(|n| *n > 0)),
            bound_cidrs: request.bound_cidrs.clone().unwrap_or_default(),
            renewable: match (role_config.renewable, request.renewable) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                _ => None,
            },
        }
        .normalize()?;
        if !cidrs_within(&config.bound_cidrs, &role_config.bound_cidrs) {
            return Err(VaultError::Denied("boundCidrs must lie inside the role's".into()).into());
        }
        let inherited_cidrs = parent_info
            .as_ref()
            .map(|info| info.bound_cidrs.clone())
            .unwrap_or_default();
        if !cidrs_within(&config.bound_cidrs, &inherited_cidrs) {
            return Err(
                VaultError::Denied("boundCidrs must lie inside the parent token's".into()).into(),
            );
        }
        let bound_cidrs = [
            &config.bound_cidrs,
            &role_config.bound_cidrs,
            &inherited_cidrs,
        ]
        .into_iter()
        .find(|list| !list.is_empty())
        .cloned()
        .unwrap_or_default();
        let ttl_secs = config
            .period_secs
            .or(request.ttl_secs)
            .or(role.as_ref().and_then(|role| role.ttl_secs))
            .unwrap_or(identity.token_ttl_secs)
            .clamp(MIN_CHILD_TTL_SECS, MAX_TOKEN_TTL_SECS);
        let mut max_expires_at = config.max_expires_at(now, ttl_secs);
        let mut expires_cap = None;
        if let Some(info) = &parent_info {
            // Every child (orphan or not) starts inside its parent's lifetime.
            expires_cap = Some(info.expires_at);
            if !orphan {
                max_expires_at = min_opt(max_expires_at, info.max_expires_at);
            }
        }
        let new = NewToken {
            identity_id: identity.id.clone(),
            policies,
            scoped: true,
            ttl_secs,
            max_expires_at,
            expires_cap,
            period_secs: config.period_secs,
            num_uses: config.num_uses,
            bound_cidrs,
            parent_accessor: if orphan {
                None
            } else {
                parent.map(|parent| parent.accessor.to_owned())
            },
            orphan,
            role: role.as_ref().map(|role| role.name.clone()),
            renewable: config.renewable.unwrap_or(true),
        };
        let issued = insert_token_locked(conn, &new)?;
        let permitted = self.audit_locked(
            conn,
            &AuditEntry::new(actor, "token.create", "ok").details(json!({
                "accessor": issued.accessor,
                "identity": identity.id,
                "parentAccessor": parent.map(|parent| parent.accessor),
                "orphan": orphan,
                "role": new.role,
                "policies": new.policies,
                "numUses": new.num_uses,
            })),
        );
        if !permitted {
            withhold_token_locked(conn, &issued.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(issued)
    }

    /// Mint a child of the presented token.
    pub async fn token_create_child(
        &self,
        parent_accessor: &str,
        parent_policies: &[String],
        identity_id: &str,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity = crate::vault::machine::identity_locked(&conn, identity_id)?;
        if identity.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        if let Some(role) = &request.role {
            // A role can detach a child (orphan) or make it periodic, so a
            // machine may only use one its own policies grant `use` on.
            let key = format!("sys/token-roles/{role}");
            let policies: Vec<_> = crate::vault::policy::list_policies(&conn)?
                .into_iter()
                .filter(|policy| parent_policies.contains(&policy.name))
                .collect();
            let caps = crate::vault::policy::evaluate(
                &crate::vault::policy::CapabilitySet::new(),
                &policies,
                &key,
            );
            if !caps.contains(&crate::vault::policy::Capability::Use) {
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "token.create", "denied")
                        .details(json!({ "parentAccessor": parent_accessor, "role": role })),
                );
                return Err(VaultError::Denied(format!(
                    "using token role `{role}` requires `use` on {key}"
                ))
                .into());
            }
        }
        let parent = ParentToken {
            accessor: parent_accessor,
            policies: parent_policies,
        };
        self.token_create_locked(
            &conn,
            &identity,
            parent.policies,
            Some(&parent),
            request,
            actor,
        )
    }

    /// An administrator mints a root (orphan) token for an identity.
    pub async fn token_create_for_identity(
        &self,
        identity: &str,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity = crate::vault::machine::identity_locked(&conn, identity)?;
        if identity.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        let base = crate::vault::machine::effective_machine_policies(
            &conn,
            &identity.id,
            &identity.policies,
        )?;
        self.token_create_locked(&conn, &identity, &base, None, request, actor)
    }
}
