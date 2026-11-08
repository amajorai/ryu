//! The broker relayed into cloud-task Boxes (P0-2 option A; design in
//! `docs/vault-env-session-parity/box-broker-relay.md`).
//!
//! When `cloud_tasks/box_arm` creates a Box, [`mint`] gives it a broker
//! session of its own: subject `box:<lease_id>` (no route can mint that
//! subject, so it alone marks a relay session), over the services in the
//! active environment that are enabled, marked [`ServiceInput::box_relay`],
//! and that the task owner holds `use` on, for at most the task's lifetime.
//! The token goes to the Box's egress sidecar, never into the Box, and
//! [`revoke`] ends the session when the Box is destroyed, parked or
//! recovered.
//!
//! The sidecar reaches Core at `{RYU_NODE_PUBLIC_URL}/api/vault/broker/box-relay`
//! over a WebSocket ([`socket`]); Core serves the piped bytes with the
//! broker bound to that one session. A relay session is narrower than a
//! local one: unmatched hosts are refused whatever the environment's policy,
//! placeholders are substituted in headers only, no payment card is used,
//! and the loopback listener refuses it (`proxy/listener.rs`).
//!
//! [`ServiceInput::box_relay`]: super::services::ServiceInput::box_relay

mod socket;

use anyhow::Result;
use serde_json::json;

use super::sessions::{self, BrokerSession, MinterScope};
use super::{service_key, services};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::policy::{Capability, CapabilitySet};

pub use socket::routes;

/// Subject prefix of a Box's relay session.
pub const SUBJECT_PREFIX: &str = "box:";
/// Where the egress sidecar reaches the relay on Core's public URL.
pub const RELAY_PATH: &str = "/api/vault/broker/box-relay";
/// The relay handshake header naming the lease the session was minted for.
pub const LEASE_HEADER: &str = "x-ryu-box-lease";

/// Whether `session` is a Box's relay session.
pub fn is_box_session(session: &BrokerSession) -> bool {
    session.minted_by.starts_with(SUBJECT_PREFIX)
}

/// The subject of the relay session minted for `lease_id`.
pub fn subject_for(lease_id: &str) -> String {
    format!("{SUBJECT_PREFIX}{lease_id}")
}

/// Whose capabilities scope a Box's session: the task owner's policy
/// subjects, and whether they are a manager (every capability), as a vault
/// request computes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BoxRelayOwner {
    pub subjects: Vec<String>,
    pub manager: bool,
}

/// A minted relay: what the Box service's `brokerRelay` field carries.
pub struct BoxRelayGrant {
    pub session_id: String,
    /// The `rvb_` token, shown once.
    pub token: String,
    /// Hosts the session's services cover, for the sidecar to relay.
    pub hosts: Vec<String>,
    /// The broker CA's public certificate.
    pub ca_pem: String,
}

impl std::fmt::Debug for BoxRelayGrant {
    // Never print the token.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoxRelayGrant")
            .field("session_id", &self.session_id)
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}

/// The relay URL for a node public URL: `https` on the default port only
/// (the sidecar dials 443 and refuses anything else), else `None`.
pub fn relay_url_from(public_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(public_url.trim()).ok()?;
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return None;
    }
    let host = url.host_str()?;
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return None;
    }
    let base = url.path().trim_end_matches('/');
    Some(format!("https://{host}{base}{RELAY_PATH}"))
}

/// The relay URL of this node, from `RYU_NODE_PUBLIC_URL`.
pub fn relay_url() -> Option<String> {
    relay_url_from(&crate::sidecar::control_plane::node_public_url()?)
}

/// A host a Box's sidecar can relay: a DNS name (or `*.` wildcard) on 443.
fn relayable(service: &services::BrokerService) -> bool {
    let host = service.input.host.as_str();
    let bare = host.strip_prefix("*.").unwrap_or(host);
    matches!(service.input.port, None | Some(443))
        && bare.contains('.')
        && bare
            .rsplit('.')
            .next()
            .is_some_and(|label| label.starts_with(|c: char| c.is_ascii_alphabetic()))
}

/// The services a Box of `owner` gets in `environment`: enabled, marked for
/// Boxes, relayable, admitted by the Box's network (`admits`), and usable by
/// the owner. At most [`sessions::MAX_SERVICES`].
pub fn relay_services(
    conn: &rusqlite::Connection,
    environment: &str,
    owner: &BoxRelayOwner,
    admits: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Vec<services::BrokerService>> {
    let policies = crate::vault::policy::policies_for(conn, &owner.subjects)?;
    let baseline: CapabilitySet = if owner.manager {
        Capability::ALL.into_iter().collect()
    } else {
        CapabilitySet::new()
    };
    let context = crate::vault::policy_ext::TemplateContext::from_subjects(&owner.subjects);
    Ok(services::list(conn, Some(environment))?
        .into_iter()
        .filter(|service| service.input.enabled && service.input.box_relay)
        .filter(|service| relayable(service) && admits(&service.input.host))
        .filter(|service| {
            crate::vault::policy::evaluate_with(
                &baseline,
                &policies,
                &service_key(service.name()),
                &context,
            )
            .contains(&Capability::Use)
        })
        .take(sessions::MAX_SERVICES)
        .collect())
}

/// Mint the relay session for the Box of `lease_id`, living `ttl_secs`
/// (clamped to the session limits). `Ok(None)` when no service qualifies,
/// so the Box is created without a relay.
pub async fn mint(
    store: &PluginSecretStore,
    lease_id: &str,
    owner: &BoxRelayOwner,
    ttl_secs: i64,
    admits: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Option<BoxRelayGrant>> {
    let environment = crate::vault::active_environment();
    let minted = {
        let conn = store.conn.lock().await;
        let chosen = relay_services(&conn, &environment, owner, admits)?;
        if chosen.is_empty() {
            return Ok(None);
        }
        let mut hosts: Vec<String> = chosen.iter().map(|s| s.input.host.clone()).collect();
        hosts.sort();
        hosts.dedup();
        let request = sessions::MintRequest {
            environment: environment.clone(),
            services: chosen.iter().map(|s| s.name().to_owned()).collect(),
            label: format!("Box {lease_id}").chars().take(128).collect(),
            ttl_secs: Some(ttl_secs.clamp(sessions::MIN_TTL_SECS, sessions::MAX_TTL_SECS)),
            minted_by: subject_for(lease_id),
            not_after: None,
            minted_token: None,
            // The owner's deny rules hold at resolution; cards are refused
            // for relay sessions regardless (`proxy/card_use.rs`).
            minter_scope: Some(MinterScope {
                subjects: owner.subjects.clone(),
                manager: owner.manager,
            }),
        };
        let (token, session) = sessions::mint(&conn, request)?;
        (token, session, hosts)
    };
    let (token, session, hosts) = minted;
    store
        .audit(
            &AuditEntry::new(&AuditActor::system(), "broker.session.create", "ok").details(json!({
                "session": session.id,
                "environment": session.environment,
                "services": session.services,
                "boxLease": lease_id,
            })),
        )
        .await;
    let ca_pem = match super::ca::certificate_pem(store).await {
        Ok(pem) => pem,
        Err(error) => {
            revoke(store, lease_id).await?;
            return Err(error);
        }
    };
    Ok(Some(BoxRelayGrant {
        session_id: session.id,
        token,
        hosts,
        ca_pem,
    }))
}

/// Revoke every live relay session of the Box of `lease_id`; how many.
pub async fn revoke(store: &PluginSecretStore, lease_id: &str) -> Result<usize> {
    let subject = subject_for(lease_id);
    let conn = store.conn.lock().await;
    let mut revoked = 0;
    for session in sessions::list(&conn)? {
        if session.minted_by == subject
            && session.revoked_at.is_none()
            && sessions::revoke(&conn, &session.id)?
        {
            revoked += 1;
            store.audit_locked(
                &conn,
                &AuditEntry::new(&AuditActor::system(), "broker.session.revoke", "ok")
                    .details(json!({ "session": session.id, "reason": "box_stopped" })),
            );
        }
    }
    Ok(revoked)
}

/// [`revoke`] against the process-wide store, for Box teardown paths: a
/// failure is logged (the session still expires with its lifetime).
pub async fn revoke_for_lease(lease_id: &str) {
    let Some(store) = crate::plugin_secrets::global() else {
        return;
    };
    if let Err(error) = revoke(store, lease_id).await {
        tracing::warn!(
            lease = lease_id,
            "revoking a Box's broker relay failed: {error:#}"
        );
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod url_tests {
    use super::relay_url_from;

    #[test]
    fn the_relay_url_needs_https_on_the_default_port() {
        assert_eq!(
            relay_url_from("https://node.example.com").as_deref(),
            Some("https://node.example.com/api/vault/broker/box-relay")
        );
        assert_eq!(
            relay_url_from("https://node.example.com/ryu/").as_deref(),
            Some("https://node.example.com/ryu/api/vault/broker/box-relay")
        );
        for refused in [
            "http://node.example.com",
            "https://node.example.com:8443",
            "https://10.0.0.5",
            "https://user@node.example.com",
            "not a url",
        ] {
            assert_eq!(relay_url_from(refused), None, "{refused}");
        }
    }
}
