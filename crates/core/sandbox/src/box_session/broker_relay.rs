//! Core's credential broker relayed into a disposable Box (P0-2 option A):
//! `brokerRelay` on `POST /v1/boxes`. The Box's egress sidecar pipes its
//! connections to `hosts` through Core's public relay `url`, authenticated by
//! the Box's own broker session `token`, which only the sidecar holds; the
//! Box trusts `ca_pem`, the broker CA's public certificate.

use super::*;

/// The `/health` feature of a Box service that takes `brokerRelay`.
pub const BOX_BROKER_RELAY_FEATURE: &str = "broker-relay-v1";
/// The most hosts one relay covers (the Box service's limit).
pub const MAX_BOX_RELAY_HOSTS: usize = 64;

/// What a Box's egress sidecar needs to relay Core's broker.
#[derive(Clone, PartialEq, Eq)]
pub struct BoxBrokerRelay {
    /// Core's relay endpoint: `https://<public host>/api/vault/broker/box-relay`.
    pub url: String,
    /// The Box's `rvb_` broker session token.
    pub token: SecretString,
    /// The Core lease the session was minted for.
    pub lease: String,
    /// Hosts the broker's services cover (exact or `*.` wildcard).
    pub hosts: Vec<String>,
    /// The broker CA's public certificate (PEM).
    pub ca_pem: String,
}

impl fmt::Debug for BoxBrokerRelay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoxBrokerRelay")
            .field("url", &self.url)
            .field("lease", &self.lease)
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}

impl BoxBrokerRelay {
    pub(super) fn validate(&self, network: &BoxNetwork) -> Result<(), BoxApiError> {
        if matches!(network, BoxNetwork::None) {
            return Err(invalid_request(
                "a broker relay needs network egress or an allowlist",
            ));
        }
        if !self.url.starts_with("https://")
            || !self.token.expose_secret().starts_with("rvb_")
            || self.lease.is_empty()
            || self.hosts.is_empty()
            || self.hosts.len() > MAX_BOX_RELAY_HOSTS
            || !self.ca_pem.starts_with("-----BEGIN CERTIFICATE-----")
        {
            return Err(invalid_request(
                "a broker relay needs an https url, a session token, a lease, 1 to 64 hosts and the broker CA",
            ));
        }
        Ok(())
    }

    /// The `brokerRelay` create field.
    pub(super) fn to_json(&self) -> Value {
        json!({
            "url": self.url,
            "token": self.token.expose_secret(),
            "lease": self.lease,
            "hosts": self.hosts,
            "caPem": self.ca_pem,
        })
    }
}

impl BoxSessionClient {
    /// Whether this Box service takes `brokerRelay` (it lists
    /// [`BOX_BROKER_RELAY_FEATURE`] on `/health`). An older service never
    /// does, and would create the Box without the relay, so a caller must
    /// not send one without this.
    pub async fn relays_broker(&self) -> Result<bool, BoxApiError> {
        Ok(self
            .features()
            .await?
            .iter()
            .any(|feature| feature == BOX_BROKER_RELAY_FEATURE))
    }
}
