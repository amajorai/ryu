//! A configured own-relay ingress must make Core distrust loopback peers, because
//! the operator's public reverse proxy may re-originate internet requests from
//! `127.0.0.1`. Its own test binary, because the flag is process-global.

use ryu_webhook_ingress::{Ingress, OwnRelaySource};

#[tokio::test]
async fn own_relay_arms_loopback_distrust_only_with_a_public_base() {
    assert!(
        !OwnRelaySource::forwarding_active(),
        "nothing configured, so loopback peers stay trusted"
    );

    let unconfigured = Ingress::OwnRelay(OwnRelaySource {
        base_url: "   ".to_owned(),
    });
    assert!(unconfigured.start().await.is_err());
    assert!(
        !OwnRelaySource::forwarding_active(),
        "an own-relay with no public URL exposes nothing"
    );

    let configured = Ingress::OwnRelay(OwnRelaySource {
        base_url: "https://relay.example.com".to_owned(),
    });
    configured.start().await.expect("a public base starts");
    assert!(
        OwnRelaySource::forwarding_active(),
        "a started own-relay may forward internet traffic over loopback"
    );
}
