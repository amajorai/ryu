//! CIDR, client-address and token-config tests for `vault::tokens`, and the
//! AppRole helpers the other test files share.

use super::*;
use super::{cidr::*, config::*};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::machine::{AuthMethod, IssuedToken};
use std::net::IpAddr;

pub(super) fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

pub(super) async fn approle(
    store: &PluginSecretStore,
    name: &str,
    policies: &[&str],
) -> (String, String) {
    let identity = store
        .machine_create(
            name,
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            policies.iter().map(|p| (*p).to_owned()).collect(),
            Some(600),
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("approle")
    };
    (identity.id, role_id)
}

pub(super) async fn login(store: &PluginSecretStore, name: &str, role_id: &str) -> IssuedToken {
    let (secret, _) = store
        .machine_issue_secret_id(name, None, None, &AuditActor::system())
        .await
        .unwrap();
    store.approle_login(role_id, &secret).await.unwrap()
}

#[test]
fn cidrs_parse_contain_and_cover() {
    let block = Cidr::parse("10.1.2.3/16").unwrap();
    assert_eq!(block.to_string(), "10.1.0.0/16");
    assert!(block.contains(ip("10.1.200.1")));
    assert!(!block.contains(ip("10.2.0.1")));
    assert!(block.contains(ip("::ffff:10.1.0.9")));
    assert!(block.covers(&Cidr::parse("10.1.4.0/24").unwrap()));
    assert!(!block.covers(&Cidr::parse("10.0.0.0/8").unwrap()));
    let v6 = Cidr::parse("fd00::/8").unwrap();
    assert!(v6.contains(ip("fd12::1")) && !v6.contains(ip("10.1.0.1")));
    assert_eq!(
        Cidr::parse("192.168.1.7").unwrap().to_string(),
        "192.168.1.7/32"
    );
    for bad in ["", "10.0.0.0/33", "nope/8", "fd00::/129"] {
        assert!(Cidr::parse(bad).is_none(), "{bad}");
    }
    assert!(ip_allowed(&[], None));
    assert!(!ip_allowed(&["10.0.0.0/8".into()], None));
    assert!(ip_allowed(&["10.0.0.0/8".into()], Some(ip("10.9.9.9"))));
    assert!(normalize_cidrs(&["bad".into()]).is_err());
}

#[test]
fn forwarded_for_is_trusted_only_from_configured_proxies() {
    let proxies = vec![Cidr::parse("10.0.0.0/8").unwrap()];
    let peer = Some(ip("203.0.113.5"));
    // An untrusted peer cannot spoof its address.
    assert_eq!(
        resolve_client_ip(peer, Some("10.1.1.1"), &proxies, false),
        peer
    );
    // A trusted proxy's right-most untrusted hop wins.
    assert_eq!(
        resolve_client_ip(
            Some(ip("10.0.0.2")),
            Some("198.51.100.1, 203.0.113.9, 10.0.0.3"),
            &proxies,
            false
        ),
        Some(ip("203.0.113.9"))
    );
    assert_eq!(
        resolve_client_ip(Some(ip("10.0.0.2")), Some("garbage"), &proxies, false),
        None
    );
    // Tunneled loopback is a remote client of unknown address.
    assert_eq!(
        resolve_client_ip(Some(ip("127.0.0.1")), None, &[], true),
        None
    );
    assert_eq!(
        resolve_client_ip(Some(ip("127.0.0.1")), None, &[], false),
        Some(ip("127.0.0.1"))
    );
}

#[test]
fn token_configs_validate_ranges() {
    assert!(TokenConfig {
        period_secs: Some(5),
        ..TokenConfig::default()
    }
    .normalize()
    .is_err());
    let config = TokenConfig {
        num_uses: Some(0),
        bound_cidrs: vec!["10.0.0.1/8".into()],
        ..TokenConfig::default()
    }
    .normalize()
    .unwrap();
    assert_eq!(config.num_uses, None);
    assert_eq!(config.bound_cidrs, vec!["10.0.0.0/8".to_owned()]);
}
