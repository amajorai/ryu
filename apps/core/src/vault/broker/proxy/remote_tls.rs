//! TLS on the remote listener ([`super::super::remote::ENV_REMOTE_TLS`]).
//!
//! The server certificate is a broker-CA leaf for the configured
//! certificate host (the advertised URL's host or the listen address), or
//! for the connection's local address on a wildcard bind. The SNI a client
//! sends is ignored, so a peer cannot make the broker mint leaves for names
//! of its choosing. Agents trust the CA returned at mint.

use super::super::remote::RemoteConfig;
use super::*;

/// Longest a peer may take to complete the TLS handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The name the server certificate is issued for on this connection.
pub(super) fn certificate_host(remote: &RemoteConfig, local: Option<SocketAddr>) -> Option<String> {
    remote
        .certificate_host()
        .or_else(|| local.map(|addr| addr.ip().to_string()))
}

impl Broker {
    /// Complete the TLS handshake of an admitted remote peer, or `None`
    /// (sealed vault, no certificate host, or a failed or slow handshake).
    pub(super) async fn accept_remote_tls(
        &self,
        stream: TcpStream,
        remote: &RemoteConfig,
    ) -> Option<tokio_rustls::server::TlsStream<TcpStream>> {
        let host = certificate_host(remote, stream.local_addr().ok())?;
        let leaves = match self.leaf_cache().await {
            Ok(leaves) => leaves,
            Err(error) => {
                tracing::warn!("remote broker TLS unavailable: {error:#}");
                return None;
            }
        };
        let leaf = match leaves.leaf(&host) {
            Ok(leaf) => leaf,
            Err(error) => {
                tracing::warn!(host, "remote broker certificate failed: {error:#}");
                return None;
            }
        };
        let mut config = rustls::ServerConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
            .ok()?
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(FixedCert(leaf)));
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
            Ok(Ok(tls)) => Some(tls),
            Ok(Err(error)) => {
                tracing::debug!("remote broker TLS handshake failed: {error}");
                None
            }
            Err(_) => {
                tracing::debug!("remote broker TLS handshake timed out");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_certificate_names_the_configured_host_or_the_local_address() {
        let named = RemoteConfig::parse(
            Some("0.0.0.0:8124"),
            Some("10.0.0.0/8"),
            Some("https://broker.internal:8124"),
            true,
        )
        .unwrap()
        .unwrap();
        let local: SocketAddr = "10.0.0.5:8124".parse().unwrap();
        assert_eq!(
            certificate_host(&named, Some(local)).as_deref(),
            Some("broker.internal")
        );
        let wildcard = RemoteConfig::parse(Some("0.0.0.0:8124"), Some("10.0.0.0/8"), None, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            certificate_host(&wildcard, Some(local)).as_deref(),
            Some("10.0.0.5")
        );
        assert_eq!(certificate_host(&wildcard, None), None);
    }
}
