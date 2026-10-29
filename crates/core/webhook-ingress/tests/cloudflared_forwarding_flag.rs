//! A Quick Tunnel that never starts must not leave Core distrusting loopback.
//! Its own test binary, because the Cloudflared state is process-global.

use ryu_webhook_ingress::{CloudflaredOwner, CloudflaredSource};
use std::path::PathBuf;

#[tokio::test]
async fn failed_spawn_clears_the_forwarding_flag() {
    let source = CloudflaredSource::new(7980)
        .with_binary(PathBuf::from("/nonexistent/ryu-test/cloudflared"));

    let started = source.start_for(CloudflaredOwner::WebhookIngress).await;
    let forwarding_after_failure = CloudflaredSource::forwarding_active();
    let _ = CloudflaredSource::stop_for(CloudflaredOwner::WebhookIngress).await;

    assert!(started.is_err(), "a missing binary cannot start a tunnel");
    assert!(
        !forwarding_after_failure,
        "no process exists, so loopback peers stay trusted"
    );
}
