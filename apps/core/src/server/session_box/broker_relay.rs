//! Core's credential broker relayed into a chat-started session Box (P0-2
//! option A; `vault/broker/box_relay.rs`, design
//! `docs/vault-env-session-parity/box-broker-relay.md`). Cloud task Boxes get
//! theirs in `cloud_tasks/box_arm/relay.rs`.
//!
//! Before a session Box (or a sub-agent child) is created, the services the
//! turn's caller holds `use` on and that an admin marked for Boxes become a
//! broker session of the Box's own; its token rides in `brokerRelay` to the
//! Box's egress sidecar. A session Box has the `Egress` network, so every
//! relayable marked service qualifies.
//!
//! The Box keeps its sealed egress configuration across park and resume, so
//! the session spans them and lives for the broker's session maximum
//! ([`MAX_TTL_SECS`]); after that the relayed hosts answer 502 until a new
//! Box is started. It is revoked when the Box is deleted: a failed create,
//! a deleted conversation, an expired or reaped Box.
//!
//! Fails closed like a cloud task: when the caller would get relay services
//! but the broker is not running, the node has no public `https` URL, or the
//! Box service does not take `brokerRelay`, no session is minted and no Box
//! is created.

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::box_relay::{self, BoxRelayOwner};
use crate::vault::broker::sessions::MAX_TTL_SECS;
use ryu_sandbox::box_session::BoxBrokerRelay;
use ryu_sandbox::box_types::SecretString;

/// The store relay sessions live in: the process-wide one (a test's own in
/// tests).
fn store() -> Option<&'static PluginSecretStore> {
    #[cfg(test)]
    if let Some(store) = tests::test_store() {
        return Some(store);
    }
    crate::plugin_secrets::global()
}

/// A session Box's network admits every host.
fn admits_any(_host: &str) -> bool {
    true
}

/// Whose `use` grants scope the relay: the turn caller's policy subjects, as
/// a vault request computes them, and every capability on a node with no
/// control plane registration.
pub(crate) fn relay_owner(auth: &ResolvedAuthorization) -> BoxRelayOwner {
    let mut subjects = Vec::new();
    if let Some(caller) = &auth.caller {
        subjects.push(format!("user:{}", caller.user_id));
        subjects.push(format!("role:{}", caller.role.label()));
        subjects.extend(caller.teams.iter().map(|team| format!("team:{}", team.id)));
    }
    BoxRelayOwner {
        subjects,
        manager: crate::sidecar::control_plane::registered_node().is_none(),
    }
}

/// Why a session Box that would get relay services cannot have them, or
/// `None`.
pub(crate) fn refusal(
    serving: bool,
    relay_url: Option<&str>,
    service_relays: bool,
) -> Option<&'static str> {
    if !serving {
        Some("Vault broker services are marked for Ryu Boxes, but the credential broker is not running on this node, so no session Box was started. Turn the broker on, or unmark the services.")
    } else if relay_url.is_none() {
        Some("Vault broker services are marked for Ryu Boxes, but this node has no public https URL (RYU_NODE_PUBLIC_URL on port 443) for a session Box to reach the broker, so none was started. Set one, or unmark the services.")
    } else if !service_relays {
        Some("Vault broker services are marked for Ryu Boxes, but this Ryu Box service cannot relay the broker yet, so no session Box was started. Update it, or unmark the services.")
    } else {
        None
    }
}

fn relay_error(message: &str) -> ApiError {
    api_error(
        StatusCode::CONFLICT,
        "session_box_broker_relay_unavailable",
        message,
    )
}

/// The relay for the session Box of `lease_id`, minted when `owner` gets any
/// service; `Ok(None)` when none qualifies (the Box is created as before).
pub(crate) async fn plan_relay(
    store: &PluginSecretStore,
    lease_id: &str,
    owner: &BoxRelayOwner,
    client: &BoxSessionClient,
) -> Result<Option<BoxBrokerRelay>, ApiError> {
    let failed = |_| unavailable("The vault broker relay could not be prepared.");
    let qualifies = {
        let conn = store.conn.lock().await;
        let environment = crate::vault::active_environment();
        !box_relay::relay_services(&conn, &environment, owner, &admits_any)
            .map_err(failed)?
            .is_empty()
    };
    if !qualifies {
        return Ok(None);
    }
    let url = box_relay::relay_url();
    let serving = crate::vault::broker::serving().is_some();
    let service_relays = serving && url.is_some() && client.relays_broker().await.unwrap_or(false);
    if let Some(message) = refusal(serving, url.as_deref(), service_relays) {
        return Err(relay_error(message));
    }
    let grant = box_relay::mint(store, lease_id, owner, MAX_TTL_SECS, &admits_any)
        .await
        .map_err(failed)?;
    let (Some(url), Some(grant)) = (url, grant) else {
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
pub(crate) async fn plan_for_box(
    lease_id: &str,
    owner: &BoxRelayOwner,
    client: &BoxSessionClient,
) -> Result<Option<BoxBrokerRelay>, ApiError> {
    let Some(store) = store() else {
        return Ok(None);
    };
    plan_relay(store, lease_id, owner, client).await
}

/// End the relay session of a deleted session Box (logged on failure; the
/// session still expires with its lifetime).
pub(crate) async fn revoke_relay(lease_id: &str) {
    let Some(store) = store() else {
        return;
    };
    if let Err(error) = box_relay::revoke(store, lease_id).await {
        tracing::warn!(
            lease = lease_id,
            "revoking a session Box's broker relay failed: {error:#}"
        );
    }
}

#[cfg(test)]
#[path = "broker_relay_tests.rs"]
mod tests;
