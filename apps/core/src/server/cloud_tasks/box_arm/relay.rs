//! Core's credential broker relayed into a cloud task's Box (P0-2 option A;
//! `vault/broker/box_relay.rs`). Before the Box is created, the task owner's
//! services marked for Boxes become a broker session of the Box's own; its
//! token rides in `brokerRelay` to the Box's egress sidecar. Teardown revokes
//! it (`teardown.rs`).
//!
//! Fails closed: when the owner would get relay services but the broker is
//! not running, the node has no public `https` URL, or the Box service does
//! not take `brokerRelay`, the task is refused with a plain message and
//! nothing is minted or created.

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::box_relay::{self, BoxRelayOwner};
use ryu_sandbox::box_session::BoxBrokerRelay;
use ryu_sandbox::box_types::SecretString;

/// Whose `use` grants scope the relay: the caller's policy subjects, as a
/// vault request computes them. Like a vault request, every capability on a
/// node with no control plane registration.
pub(in crate::server::cloud_tasks) fn relay_owner(
    authority: &crate::server::ResolvedAuthorization,
) -> BoxRelayOwner {
    let mut subjects = Vec::new();
    if let Some(caller) = &authority.caller {
        subjects.push(format!("user:{}", caller.user_id));
        subjects.push(format!("role:{}", caller.role.label()));
        subjects.extend(caller.teams.iter().map(|team| format!("team:{}", team.id)));
    }
    BoxRelayOwner {
        subjects,
        manager: crate::sidecar::control_plane::registered_node().is_none(),
    }
}

/// Whether a Box on `network` may reach `host` (exact or `*.` pattern), as
/// the Box service's allowlist check reads it.
pub(super) fn network_admits(network: &BoxNetwork, host: &str) -> bool {
    match network {
        BoxNetwork::None => false,
        BoxNetwork::Egress => true,
        BoxNetwork::Allowlist(patterns) => patterns.iter().any(|pattern| {
            if pattern == "*" {
                return true;
            }
            match pattern.strip_prefix('*') {
                Some(suffix) => host.ends_with(suffix) && host.len() > suffix.len(),
                None => host == pattern,
            }
        }),
    }
}

/// Why a Box that would get relay services cannot have them, or `None`.
pub(super) fn relay_refusal(
    serving: bool,
    relay_url: Option<&str>,
    service_relays: bool,
) -> Option<&'static str> {
    if !serving {
        Some("Vault broker services are marked for Ryu Boxes, but the credential broker is not running on this node. Turn the broker on, or unmark the services.")
    } else if relay_url.is_none() {
        Some("Vault broker services are marked for Ryu Boxes, but this node has no public https URL (RYU_NODE_PUBLIC_URL on port 443) for a Box to reach the broker. Set one, or unmark the services.")
    } else if !service_relays {
        Some("Vault broker services are marked for Ryu Boxes, but this Ryu Box service cannot relay the broker yet. Update it, or unmark the services.")
    } else {
        None
    }
}

/// The relay for the Box of `lease_id`, minted when the owner gets any
/// service; `Ok(None)` when none qualifies (the Box is created as before).
pub(super) async fn plan_relay(
    store: &PluginSecretStore,
    lease_id: &str,
    owner: &BoxRelayOwner,
    network: &BoxNetwork,
    ttl_secs: i64,
    client: &BoxSessionClient,
) -> Result<Option<BoxBrokerRelay>> {
    let admits = |host: &str| network_admits(network, host);
    let qualifies = {
        let conn = store.conn.lock().await;
        let environment = crate::vault::active_environment();
        !box_relay::relay_services(&conn, &environment, owner, &admits)?.is_empty()
    };
    if !qualifies {
        return Ok(None);
    }
    let url = box_relay::relay_url();
    let serving = crate::vault::broker::serving().is_some();
    let service_relays = serving && url.is_some() && client.relays_broker().await.unwrap_or(false);
    if let Some(message) = relay_refusal(serving, url.as_deref(), service_relays) {
        bail!(message);
    }
    let (Some(url), Some(grant)) = (
        url,
        box_relay::mint(store, lease_id, owner, ttl_secs, &admits).await?,
    ) else {
        return Ok(None);
    };
    Ok(Some(BoxBrokerRelay {
        url,
        token: SecretString::new(grant.token),
        lease: lease_id.to_owned(),
        hosts: grant.hosts,
        ca_pem: grant.ca_pem,
    }))
}

/// [`plan_relay`] against the process-wide store; none without one.
pub(super) async fn plan_for_box(
    lease_id: &str,
    owner: &BoxRelayOwner,
    network: &BoxNetwork,
    ttl_secs: u64,
    client: &BoxSessionClient,
) -> Result<Option<BoxBrokerRelay>> {
    let Some(store) = crate::plugin_secrets::global() else {
        return Ok(None);
    };
    let ttl = i64::try_from(ttl_secs).unwrap_or(i64::MAX);
    plan_relay(store, lease_id, owner, network, ttl, client).await
}
