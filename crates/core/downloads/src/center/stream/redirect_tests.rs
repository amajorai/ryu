//! Transport-security regressions for the DownloadCenter's hop handling: no
//! cleartext downloads in production, and no redirect that leaves HTTPS.

use super::{download_policy, next_redirect_url, require_https_hop, StreamErr};

fn refused(current: &str, location: &str) -> String {
    match next_redirect_url(current, location) {
        Err(StreamErr::Io(message)) => message,
        Err(StreamErr::Network(message)) => {
            panic!("a refused redirect must be terminal, not retried: {message}")
        }
        Ok(next) => panic!("redirect {current} -> {location} was followed to {next}"),
    }
}

#[test]
fn an_https_hop_may_not_redirect_to_cleartext() {
    let message = refused(
        "https://huggingface.co/org/model/resolve/main/model.gguf",
        "http://huggingface.co/org/model/resolve/main/model.gguf",
    );
    assert!(message.contains("from https to http"), "{message}");
    // A scheme-relative or upper-case Location cannot sneak the downgrade past.
    refused("https://example.com/a", "HTTP://cdn.example.com/b");
}

#[test]
fn a_redirect_may_not_leave_the_web_schemes() {
    refused("https://example.com/a", "file:///etc/passwd");
    refused("https://example.com/a", "ftp://example.com/a");
    refused("http://127.0.0.1:9/a", "file:///etc/passwd");
}

#[test]
fn https_redirects_to_https_are_followed() {
    assert_eq!(
        next_redirect_url(
            "https://github.com/amajorai/ryu/releases/download/v1/a.zip",
            "https://objects.githubusercontent.com/a.zip?sig=1",
        )
        .ok()
        .as_deref(),
        Some("https://objects.githubusercontent.com/a.zip?sig=1")
    );
    // A relative or scheme-relative Location inherits the hop's HTTPS.
    assert_eq!(
        next_redirect_url("https://example.com/dir/a", "../b")
            .ok()
            .as_deref(),
        Some("https://example.com/b")
    );
    assert_eq!(
        next_redirect_url("https://example.com/a", "//cdn.example.com/b")
            .ok()
            .as_deref(),
        Some("https://cdn.example.com/b")
    );
}

#[test]
fn an_unparseable_location_is_a_terminal_error() {
    assert!(matches!(
        next_redirect_url("https://example.com/a", "https://[::1"),
        Err(StreamErr::Io(_))
    ));
}

#[tokio::test]
async fn production_hops_refuse_plain_http_before_any_connection() {
    let policy = download_policy();
    assert!(!policy.allow_http);
    // The scheme screen runs before DNS, so this needs no network.
    let error = ryu_egress::resolve_guarded_url("http://huggingface.co/org/model.gguf", policy)
        .await
        .expect_err("an http download URL must be refused");
    assert!(error.contains("'http'"), "{error}");
}

#[test]
fn every_production_hop_must_be_https_whatever_the_egress_defaults() {
    assert!(require_https_hop("https://huggingface.co/org/model.gguf").is_ok());
    assert!(require_https_hop(" HTTPS://huggingface.co/a ").is_ok());
    for url in [
        "http://huggingface.co/a",
        "HTTP://cdn.example.com/b",
        "ftp://x/a",
        "file:///a",
    ] {
        match require_https_hop(url) {
            Err(StreamErr::Io(message)) => assert!(message.contains("must use https"), "{message}"),
            Err(StreamErr::Network(message)) => panic!("{url} refusal was retryable: {message}"),
            Ok(()) => panic!("{url} was accepted as a production download hop"),
        }
    }
    assert!(matches!(
        require_https_hop("not a url"),
        Err(StreamErr::Io(_))
    ));
}
