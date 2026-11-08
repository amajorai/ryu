//! Broker sessions for command-tool children (`tool_exec` `command` tools).
//!
//! A command tool reaches the broker only through a service scope its
//! manifest declares: one `vault:broker:<service>` entry per service in its
//! `permission_grants`, which the user consents to with the plugin's other
//! grants. Each invocation mints its own `rvb_` session over the declared
//! services that are enabled in the active environment, hands the child the
//! broker proxy environment ([`super::proxy_env`]), and revokes the session
//! when the child exits (the returned [`RuntimeBrokerLease`] is dropped).
//!
//! The scope is the only way in: there is no wildcard, the session never
//! covers a service the manifest did not name, and it carries no minter
//! scope, so it never uses payment cards. Hosts outside the scope follow the
//! environment's unmatched-host policy, so under `deny` (the default) the
//! child reaches only its declared services.
//!
//! The scope fails closed. A tool that declares one is not spawned when the
//! listener is off, the store is unavailable, none of its services is
//! enabled, the calling agent's account access is limited, or the tool also
//! declares `egress_url_arg` (the per-invocation SSRF egress proxy owns that
//! child's proxy variables; the two cannot share them).

use std::path::Path;

use anyhow::Result;
use serde_json::json;

use super::runtime::{RuntimeBrokerLease, SUBJECT_PREFIX};
use super::{ca, proxy_env, services, sessions};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};

/// Permission-grant prefix that declares a command tool's broker scope.
pub const GRANT_PREFIX: &str = "vault:broker:";

/// The broker services a plugin's grants declare: each valid name after
/// [`GRANT_PREFIX`], sorted and deduplicated. `*` and malformed names are
/// ignored, so a scope always names its services.
pub fn declared_services<'a>(grants: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut names: Vec<String> = grants
        .into_iter()
        .filter_map(|grant| grant.strip_prefix(GRANT_PREFIX))
        .filter(|name| is_service_name(name))
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// A broker service name: 1-64 lowercase letters, digits, `-` or `_`.
fn is_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

/// Why a command tool with a declared scope is not spawned. The text names
/// no credential or value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeRefusal(pub String);

impl std::fmt::Display for ScopeRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Mint a session over `declared` on the listener at `port`, writing the
/// public CA files into `ca_dir`. `ttl_secs` is clamped to the session
/// bounds. Refused when no declared service is enabled in the active
/// environment.
pub async fn lease(
    store: &'static PluginSecretStore,
    port: u16,
    ca_dir: &Path,
    plugin_id: &str,
    declared: &[String],
    ttl_secs: i64,
) -> Result<std::result::Result<RuntimeBrokerLease, ScopeRefusal>> {
    let environment = crate::vault::active_environment();
    let names: Vec<String> = {
        let conn = store.conn.lock().await;
        services::list(&conn, Some(&environment))?
            .into_iter()
            .filter(|service| service.input.enabled && declared.contains(&service.input.name))
            .map(|service| service.input.name)
            .take(sessions::MAX_SERVICES)
            .collect()
    };
    if names.is_empty() {
        return Ok(Err(ScopeRefusal(format!(
            "none of the broker services this tool declares ({}) is enabled in environment '{environment}'",
            declared.join(", ")
        ))));
    }
    let request = sessions::MintRequest {
        environment,
        services: names,
        label: format!("{plugin_id} command"),
        ttl_secs: Some(ttl_secs.clamp(sessions::MIN_TTL_SECS, sessions::MAX_TTL_SECS)),
        minted_by: format!("{SUBJECT_PREFIX}command:{}", uuid::Uuid::new_v4().simple()),
        not_after: None,
        minted_token: None,
        // No minter scope: a command tool's session never uses payment cards.
        minter_scope: None,
    };
    let (token, session) = {
        let conn = store.conn.lock().await;
        sessions::mint(&conn, request)?
    };
    // Built before anything else can fail, so an error revokes the session.
    let mut lease = RuntimeBrokerLease::for_session(store, session.id.clone());
    store
        .audit(
            &AuditEntry::new(&AuditActor::system(), "broker.session.create", "ok").details(json!({
                "session": session.id,
                "environment": session.environment,
                "services": session.services,
                "tool": plugin_id,
            })),
        )
        .await;
    let files = ca::write_bundle_in(ca_dir, &ca::certificate_pem(store).await?)?;
    lease.set_env(proxy_env(&token, port, &files));
    Ok(Ok(lease))
}

/// Mint a session for one command-tool invocation against the process-wide
/// listener and store. `Ok(None)` when the tool declares no scope; `Err` with
/// the reason when it declares one that cannot be honoured, in which case the
/// tool must not run.
pub async fn lease_for_command(
    plugin_id: &str,
    declared: &[String],
    account_confined: bool,
    egress_proxied: bool,
    timeout_secs: u64,
) -> std::result::Result<Option<RuntimeBrokerLease>, ScopeRefusal> {
    if declared.is_empty() {
        return Ok(None);
    }
    if egress_proxied {
        return Err(ScopeRefusal(
            "a command tool cannot declare both egress_url_arg and a broker service scope".into(),
        ));
    }
    if account_confined {
        return Err(ScopeRefusal(
            "this agent's account access is limited, so its tools cannot use broker services"
                .into(),
        ));
    }
    let port = super::listening_port()
        .ok_or_else(|| ScopeRefusal("the credential broker is not running".into()))?;
    let store = crate::plugin_secrets::global()
        .ok_or_else(|| ScopeRefusal("the vault is not available".into()))?;
    let ttl = i64::try_from(timeout_secs.saturating_add(60)).unwrap_or(sessions::MAX_TTL_SECS);
    match lease(
        store,
        port,
        &super::runtime::runtime_ca_dir(),
        plugin_id,
        declared,
        ttl,
    )
    .await
    {
        Ok(result) => result.map(Some),
        Err(error) => {
            tracing::warn!(plugin_id, "command tool broker session failed: {error:#}");
            Err(ScopeRefusal(
                "the credential broker could not start a session".into(),
            ))
        }
    }
}

#[cfg(test)]
#[path = "command_tools_tests.rs"]
mod tests;
