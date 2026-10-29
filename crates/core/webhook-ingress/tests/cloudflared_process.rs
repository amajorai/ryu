use ryu_webhook_ingress::{CloudflaredOwner, CloudflaredSource, WebhookIngress};
use std::path::PathBuf;

struct EnvRestore {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvRestore {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

const BASE_URL: &str = "https://process-test.trycloudflare.com";
const WEBHOOK_URL: &str = "https://process-test.trycloudflare.com/api/composio/webhook";

#[tokio::test]
async fn managed_cloudflared_process_shares_url_until_its_last_owner_stops() {
    let _secret_env = EnvRestore::set("RYU_CLOUDFLARED_TEST_SECRET", "must-not-inherit");
    let source = CloudflaredSource::new(7980).with_binary(PathBuf::from(env!(
        "CARGO_BIN_EXE_ryu_cloudflared_test_stub"
    )));

    let forwarding_before_start = CloudflaredSource::forwarding_active();
    let started = source.start_for(CloudflaredOwner::TunnelToolkit).await;
    let forwarding_while_running = CloudflaredSource::forwarding_active();
    let webhook_url = if started.is_ok() {
        source.public_url().await.ok()
    } else {
        None
    };
    let ingress_started = if started.is_ok() {
        Some(source.start_for(CloudflaredOwner::WebhookIngress).await)
    } else {
        None
    };
    let ingress_owns_url = CloudflaredSource::owned_base_url(CloudflaredOwner::WebhookIngress);
    let stopped_toolkit = CloudflaredSource::stop_for(CloudflaredOwner::TunnelToolkit).await;
    let url_after_toolkit_stop = CloudflaredSource::active_base_url();
    let forwarding_while_ingress_owns = CloudflaredSource::forwarding_active();
    let stopped_ingress = CloudflaredSource::stop_for(CloudflaredOwner::WebhookIngress).await;
    let url_after_all_stopped = CloudflaredSource::active_base_url();
    let forwarding_after_all_stopped = CloudflaredSource::forwarding_active();

    assert!(
        started.is_ok(),
        "fake cloudflared failed to start: {started:?}"
    );
    assert_eq!(webhook_url.as_deref(), Some(WEBHOOK_URL));
    assert!(
        ingress_started.as_ref().is_some_and(Result::is_ok),
        "webhook ingress failed to share the active process: {ingress_started:?}"
    );
    assert_eq!(ingress_owns_url.as_deref(), Some(BASE_URL));
    assert!(
        stopped_toolkit.is_ok(),
        "toolkit owner failed to stop: {stopped_toolkit:?}"
    );
    assert_eq!(url_after_toolkit_stop.as_deref(), Some(BASE_URL));
    assert!(
        stopped_ingress.is_ok(),
        "final ingress owner failed to stop: {stopped_ingress:?}"
    );
    assert!(url_after_all_stopped.is_none());
    assert!(!forwarding_before_start);
    assert!(
        forwarding_while_running,
        "a running Quick Tunnel forwards public traffic over loopback"
    );
    assert!(
        forwarding_while_ingress_owns,
        "a webhook-ingress-only Quick Tunnel still forwards every Core path"
    );
    assert!(!forwarding_after_all_stopped);
}
