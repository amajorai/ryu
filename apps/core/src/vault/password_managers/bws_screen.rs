//! Resolve-and-screen for a Bitwarden Secrets Manager account's server URL.
//!
//! The `bws` CLI resolves `BWS_SERVER_URL` itself, so Core cannot pin the
//! addresses it connects to the way [`net::guarded_client`] does for
//! 1Password Connect. Before every `bws` run, Core therefore re-validates the
//! stored address and resolves its host, refusing loopback, link-local,
//! cloud-metadata, and (unless the operator allows them) private-network
//! answers. A hostname whose DNS answer points inside the Core host's network
//! is refused before the CLI is spawned, just like an IP literal.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};

use super::providers::{FailureKind, ProviderFailure};
use super::AccountRecord;
use crate::vault::external::net;

fn refused(message: String) -> ProviderFailure {
    ProviderFailure {
        kind: FailureKind::Unavailable,
        message,
    }
}

/// Screen `account.address` (when set) against the operator's egress
/// settings, resolving its host through the system resolver.
pub(super) async fn screen_bws_address(account: &AccountRecord) -> Result<(), ProviderFailure> {
    let Some(address) = account.address.as_deref() else {
        return Ok(());
    };
    screen_address_with(address, net::Egress::from_env(), system_resolve).await
}

async fn system_resolve(host: String, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    Ok(tokio::net::lookup_host((host.as_str(), port))
        .await?
        .collect())
}

/// Validate `address` and screen every address its host resolves to with
/// `resolve`. Literal and `localhost` hosts are screened by
/// [`net::validate_address`] and are not resolved.
async fn screen_address_with<R, Fut>(
    address: &str,
    egress: net::Egress,
    resolve: R,
) -> Result<(), ProviderFailure>
where
    R: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    let url = net::validate_address(address, egress).map_err(|error| {
        refused(format!(
            "the Bitwarden server address is refused: {error:#}"
        ))
    })?;
    let host = url
        .host_str()
        .ok_or_else(|| refused("the Bitwarden server address has no host".to_owned()))?;
    if net::is_loopback_host(host) {
        // `validate_address` already required the operator's loopback opt-in.
        return Ok(());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = resolve(bare.to_owned(), port)
        .await
        .map_err(|_| refused(format!("could not resolve Bitwarden server host `{host}`")))?;
    net::screen_resolved(host, &addrs, egress.allow_private).map_err(|error| {
        refused(format!(
            "the Bitwarden server address is refused: {error:#}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::password_managers::{providers, AccountState, ProviderKind, Secret};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const STRICT: net::Egress = net::Egress {
        allow_private: false,
        allow_loopback: false,
    };

    fn answer(ips: &[&str]) -> Vec<SocketAddr> {
        ips.iter()
            .map(|ip| SocketAddr::new(ip.parse().unwrap(), 443))
            .collect()
    }

    async fn screen_with_answer(
        address: &str,
        egress: net::Egress,
        ips: &[&str],
    ) -> Result<(), ProviderFailure> {
        let addrs = answer(ips);
        screen_address_with(address, egress, |_, _| async move { Ok(addrs) }).await
    }

    #[tokio::test]
    async fn hostnames_resolving_inside_the_network_are_refused() {
        for ip in ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1"] {
            let error = screen_with_answer("https://bw.attacker.example", STRICT, &[ip])
                .await
                .expect_err(ip);
            assert_eq!(error.kind, FailureKind::Unavailable, "{ip}");
        }
        // One internal answer among public ones refuses the host.
        assert!(screen_with_answer(
            "https://bw.attacker.example",
            STRICT,
            &["1.1.1.1", "10.0.0.5"]
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn the_operator_private_opt_in_allows_lan_but_never_loopback_or_metadata() {
        let lan = net::Egress {
            allow_private: true,
            allow_loopback: false,
        };
        screen_with_answer("https://bw.corp.example", lan, &["10.0.0.5"])
            .await
            .unwrap();
        for ip in ["127.0.0.1", "169.254.169.254"] {
            assert!(screen_with_answer("https://bw.corp.example", lan, &[ip])
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn public_answers_pass_and_unresolvable_hosts_are_refused() {
        screen_with_answer("https://vault.bitwarden.example:8443", STRICT, &["1.1.1.1"])
            .await
            .unwrap();
        assert!(screen_with_answer("https://bw.example", STRICT, &[])
            .await
            .is_err());
        let error = screen_address_with("https://bw.example", STRICT, |_, _| async {
            Err(std::io::Error::other("nxdomain"))
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind, FailureKind::Unavailable);
    }

    #[tokio::test]
    async fn literals_and_localhost_are_screened_without_resolving() {
        let calls = AtomicUsize::new(0);
        let resolve = |_: String, _: u16| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(answer(&["1.1.1.1"])) }
        };
        assert!(screen_address_with("https://10.0.0.5", STRICT, resolve)
            .await
            .is_err());
        assert!(
            screen_address_with("https://localhost:8443", STRICT, resolve)
                .await
                .is_err()
        );
        let dev = net::Egress {
            allow_private: false,
            allow_loopback: true,
        };
        screen_address_with("https://localhost:8443", dev, resolve)
            .await
            .unwrap();
        screen_address_with("https://8.8.8.8", STRICT, resolve)
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    fn stub_bws(dir: &std::path::Path) -> std::path::PathBuf {
        let marker = dir.join("spawned");
        let path = dir.join("bws");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nprintf '%s' \"$BWS_SERVER_URL\" > \"{}\"\nprintf '[]'\n",
                marker.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn account(binary: &std::path::Path, address: Option<&str>) -> AccountRecord {
        AccountRecord {
            id: "acct".to_owned(),
            name: "team".to_owned(),
            provider: ProviderKind::BitwardenSm,
            address: address.map(str::to_owned),
            binary_path: Some(binary.display().to_string()),
            state: AccountState::Connected,
            last_error: None,
            last_checked_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn check_and_fetch_refuse_an_internal_server_before_spawning_bws() {
        let dir = tempfile::tempdir().unwrap();
        let binary = stub_bws(dir.path());
        let token = Secret::new("token".to_owned());
        let internal = account(&binary, Some("https://10.0.0.5"));
        let error = providers::check(&internal, &token).await.unwrap_err();
        assert_eq!(error.kind, FailureKind::Unavailable);
        let reference = crate::vault::password_managers::PmRef::parse(&format!(
            "bws://{}",
            crate::vault::password_managers::tests::SECRET_ID
        ))
        .unwrap();
        let error = providers::fetch(&internal, &token, &reference)
            .await
            .unwrap_err();
        assert_eq!(error.kind, FailureKind::Unavailable);
        assert!(
            !dir.path().join("spawned").exists(),
            "bws must not be spawned"
        );

        // The default (cloud) server still runs the CLI.
        providers::check(&account(&binary, None), &token)
            .await
            .unwrap();
        assert!(dir.path().join("spawned").exists());
    }
}
