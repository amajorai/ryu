//! Tests for the Box credential sources.

use super::control_plane::{
    credential_from_response, normalize_control_plane_url, NodeCredentialResponse,
};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct EnvGuard(Vec<(&'static str, Option<String>)>);

impl EnvGuard {
    fn set(values: &[(&'static str, Option<&str>)]) -> Self {
        let saved = values
            .iter()
            .map(|(name, _)| (*name, std::env::var(name).ok()))
            .collect();
        for (name, value) in values {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        Self(saved)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        clear_source();
    }
}

struct FixedSource {
    calls: AtomicUsize,
}

impl BoxCredentialSource for FixedSource {
    fn current(&self) -> CredentialFuture<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(BoxCredential {
                base: Url::parse("https://box.ryu.dev/v1").unwrap(),
                token: SecretString::new("rbx1.payload.sig"),
                public_base: Some(Url::parse("wss://box.ryu.dev").unwrap()),
                billing_owner: BillingOwner::CoreTick,
                expires_at: Some(4_000_000_000),
            })
        })
    }
}

/// Env and the installed source are process-wide; these tests share the
/// crate-wide Box env lock with every other `RYU_SANDBOX_BOX_*` writer.
async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    crate::box_backend::test_env::lock_box_env().await
}

#[tokio::test]
async fn box_credential_env_source_reads_the_box_env() {
    let _lock = lock().await;
    let _env = EnvGuard::set(&[
        (box_backend::ENV_BOX_URL, Some("https://box.example/v1/")),
        (box_backend::ENV_BOX_TOKEN, Some("  tenant-token ")),
        (box_backend::ENV_BOX_SUBSCRIPTION_PASSTHROUGH, None),
    ]);
    let credential = EnvCredentialSource.current().await.unwrap();
    assert_eq!(credential.base.as_str(), "https://box.example/v1");
    assert_eq!(credential.token.expose_secret(), "tenant-token");
    assert_eq!(credential.public_base, None);
    assert_eq!(credential.billing_owner, BillingOwner::None);
    assert_eq!(credential.expires_at, None);
    let debug = format!("{credential:?}");
    assert!(!debug.contains("tenant-token"), "{debug}");

    let _passthrough =
        EnvGuard::set(&[(box_backend::ENV_BOX_SUBSCRIPTION_PASSTHROUGH, Some("true"))]);
    assert_eq!(
        EnvCredentialSource::resolve().unwrap().billing_owner,
        BillingOwner::Subscription
    );
}

#[tokio::test]
async fn box_credential_env_source_requires_a_token_and_a_valid_url() {
    let _lock = lock().await;
    let _env = EnvGuard::set(&[
        (box_backend::ENV_BOX_URL, None),
        (box_backend::ENV_BOX_TOKEN, None),
    ]);
    let error = current().await.unwrap_err().to_string();
    assert!(error.contains(box_backend::ENV_BOX_TOKEN), "{error}");

    let _bad = EnvGuard::set(&[
        (box_backend::ENV_BOX_URL, Some("ftp://box.example/v1")),
        (box_backend::ENV_BOX_TOKEN, Some("t")),
    ]);
    assert!(EnvCredentialSource::resolve().is_err());
}

#[tokio::test]
async fn box_credential_installed_source_answers_without_an_env_token() {
    let _lock = lock().await;
    let _env = EnvGuard::set(&[(box_backend::ENV_BOX_TOKEN, None)]);
    let source = Arc::new(FixedSource {
        calls: AtomicUsize::new(0),
    });
    install_source(source.clone());
    let credential = current().await.unwrap();
    assert_eq!(credential.billing_owner, BillingOwner::CoreTick);
    assert_eq!(
        credential.public_base.unwrap().as_str(),
        "wss://box.ryu.dev/"
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn box_credential_env_token_wins_over_the_installed_source() {
    let _lock = lock().await;
    let _env = EnvGuard::set(&[
        (box_backend::ENV_BOX_URL, Some("http://127.0.0.1:8090/v1")),
        (box_backend::ENV_BOX_TOKEN, Some("self-hosted")),
    ]);
    let source = Arc::new(FixedSource {
        calls: AtomicUsize::new(0),
    });
    install_source(source.clone());
    let credential = current().await.unwrap();
    assert_eq!(credential.token.expose_secret(), "self-hosted");
    assert_eq!(credential.base.as_str(), "http://127.0.0.1:8090/v1");
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);

    clear_source();
    assert_eq!(
        current().await.unwrap().token.expose_secret(),
        "self-hosted"
    );
}

#[test]
fn box_credential_billing_owner_wire_names() {
    for owner in [
        BillingOwner::CoreTick,
        BillingOwner::Settlement,
        BillingOwner::Subscription,
        BillingOwner::None,
    ] {
        assert_eq!(BillingOwner::from_wire(owner.as_str()).unwrap(), owner);
        assert_eq!(
            serde_json::to_value(owner).unwrap(),
            serde_json::json!(owner.as_str())
        );
    }
    assert!(BillingOwner::from_wire("core").is_err());
    let credential = BoxCredential {
        base: Url::parse("https://box.ryu.dev/v1").unwrap(),
        token: SecretString::new("t"),
        public_base: None,
        billing_owner: BillingOwner::Settlement,
        expires_at: Some(100),
    };
    assert!(credential.is_expired_at(100));
    assert!(!credential.is_expired_at(99));
}

use crate::test_http::{json_response, request_header, request_line, ScriptedServer};
use std::sync::atomic::AtomicU64;

const NOW: u64 = 1_792_382_400;

fn node_credential(token: &str, expires_at: u64) -> String {
    format!(
        r#"{{"baseUrl":"https://box.ryu.dev/v1","publicBase":"wss://box.ryu.dev","token":"{token}","billingOwner":"core_tick","streamIngress":"direct","expiresAt":{expires_at}}}"#
    )
}

fn manual_clock(start: u64) -> (Arc<AtomicU64>, UnixClock) {
    let time = Arc::new(AtomicU64::new(start));
    let reader = Arc::clone(&time);
    (time, Arc::new(move || reader.load(Ordering::SeqCst)))
}

fn source_for(server: &ScriptedServer, clock: UnixClock) -> ControlPlaneCredentialSource {
    ControlPlaneCredentialSource::new(
        format!("{}/api/", server.base_url),
        Arc::new(|| Some("node-control-key".to_owned())),
    )
    .with_clock(clock)
}

#[tokio::test]
async fn box_credential_control_plane_source_caches_and_refreshes_at_half_life() {
    let server = ScriptedServer::start(|index, _request| {
        Some(match index {
            0 => json_response(200, &node_credential("rbx1.first.sig", NOW + 1000)),
            _ => json_response(200, &node_credential("rbx1.second.sig", NOW + 1500)),
        })
    });
    let (time, clock) = manual_clock(NOW);
    let source = source_for(&server, clock);
    let first = source.current().await.unwrap();
    assert_eq!(first.token.expose_secret(), "rbx1.first.sig");
    assert_eq!(first.base.as_str(), "https://box.ryu.dev/v1");
    assert_eq!(first.billing_owner, BillingOwner::CoreTick);
    assert_eq!(first.expires_at, Some(NOW + 1000));
    assert_eq!(
        first.public_base.as_ref().map(Url::as_str),
        Some("wss://box.ryu.dev/")
    );
    time.store(NOW + 499, Ordering::SeqCst);
    assert_eq!(
        source.current().await.unwrap().token.expose_secret(),
        "rbx1.first.sig"
    );
    time.store(NOW + 500, Ordering::SeqCst);
    assert_eq!(
        source.current().await.unwrap().token.expose_secret(),
        "rbx1.second.sig"
    );
    let requests = server.finish();
    assert_eq!(requests.len(), 2, "the cache answers before half-life");
    assert_eq!(
        request_line(&requests[0]),
        "POST /api/box/node-credential HTTP/1.1"
    );
    assert_eq!(
        request_header(&requests[0], "x-gateway-key"),
        Some("node-control-key")
    );
}

#[tokio::test]
async fn box_credential_control_plane_source_keeps_the_old_credential_on_a_transient_failure() {
    let server = ScriptedServer::start(|index, _request| {
        Some(match index {
            0 => json_response(200, &node_credential("rbx1.kept.sig", NOW + 100)),
            _ => json_response(503, r#"{"error":"unavailable"}"#),
        })
    });
    let (time, clock) = manual_clock(NOW);
    let source = source_for(&server, clock);
    source.current().await.unwrap();
    time.store(NOW + 60, Ordering::SeqCst);
    let kept = source.current().await.unwrap();
    assert_eq!(kept.token.expose_secret(), "rbx1.kept.sig");
    time.store(NOW + 65, Ordering::SeqCst);
    assert_eq!(
        source.current().await.unwrap().token.expose_secret(),
        "rbx1.kept.sig",
        "a failed refresh backs off instead of asking on every call"
    );
    time.store(NOW + 100, Ordering::SeqCst);
    let error = source.current().await.unwrap_err().to_string();
    assert!(error.contains("503"), "{error}");
    assert!(!error.contains("node-control-key"));
    assert_eq!(server.finish().len(), 3);
}

#[tokio::test]
async fn box_credential_control_plane_refusals_are_explained() {
    let server = ScriptedServer::start(|index, _request| {
        Some(match index {
            0 => json_response(404, "{}"),
            1 => json_response(402, "{}"),
            2 => json_response(403, "{}"),
            _ => json_response(
                200,
                r#"{"baseUrl":"http://box.ryu.dev/v1","token":"t","billingOwner":"core_tick","expiresAt":"2026-10-19T05:00:00.000Z"}"#,
            ),
        })
    });
    let (_time, clock) = manual_clock(NOW);
    let source = source_for(&server, clock);
    let messages = [
        "not enabled for this organization",
        "no credit",
        "products",
        "must be https",
    ];
    for expected in messages {
        let error = source.current().await.unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
    }
    let keyless = ControlPlaneCredentialSource::new(&server.base_url, Arc::new(|| None));
    assert!(keyless
        .current()
        .await
        .unwrap_err()
        .to_string()
        .contains(ENV_NODE_KEY));
    assert_eq!(server.finish().len(), 4, "a keyless node sends nothing");
}

#[test]
fn box_credential_node_response_parsing() {
    let relay: NodeCredentialResponse = serde_json::from_value(serde_json::json!({
        "baseUrl": "http://127.0.0.1:8090/v1/",
        "publicBase": "wss://box.ryu.dev",
        "token": "rbx1.p.s",
        "billingOwner": "settlement",
        "streamIngress": "relay",
        "expiresAt": "2026-10-19T06:00:00+02:00",
    }))
    .unwrap();
    let credential = credential_from_response(relay, NOW - 10).unwrap();
    assert_eq!(
        credential.public_base, None,
        "relay ingress has no public base"
    );
    assert_eq!(credential.base.as_str(), "http://127.0.0.1:8090/v1");
    assert_eq!(credential.expires_at, Some(NOW));
    assert_eq!(credential.billing_owner, BillingOwner::Settlement);

    let expired: NodeCredentialResponse = serde_json::from_value(serde_json::json!({
        "baseUrl": "https://box.ryu.dev/v1",
        "token": "rbx1.p.s",
        "billingOwner": "core_tick",
        "expiresAt": NOW,
    }))
    .unwrap();
    assert!(credential_from_response(expired, NOW).is_err());
    let spaced: NodeCredentialResponse = serde_json::from_value(serde_json::json!({
        "baseUrl": "https://box.ryu.dev/v1",
        "token": "rbx1 p",
        "billingOwner": "core_tick",
        "expiresAt": NOW + 10,
    }))
    .unwrap();
    assert!(credential_from_response(spaced, NOW).is_err());
    assert_eq!(
        normalize_control_plane_url(" https://cp.ryu.dev/api/ "),
        "https://cp.ryu.dev"
    );
}

#[test]
fn box_credential_rfc3339_parsing() {
    assert_eq!(parse_rfc3339_unix("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_rfc3339_unix("2026-10-19T04:00:00.000Z"), Some(NOW));
    assert_eq!(parse_rfc3339_unix("2026-10-19T06:00:00+02:00"), Some(NOW));
    assert_eq!(parse_rfc3339_unix("2026-10-19T03:30:00-00:30"), Some(NOW));
    assert_eq!(
        parse_rfc3339_unix("2000-02-29T23:59:59Z"),
        Some(951_868_799)
    );
    for bad in [
        "",
        "2026-10-19",
        "2026-13-19T04:00:00Z",
        "2026-10-19T04:00:00",
        "2026-10-19T04:00:00.Z",
        "2026-10-19T04:00:00+0200",
        "1969-12-31T23:59:59Z",
    ] {
        assert_eq!(parse_rfc3339_unix(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn box_credential_env_wins_over_an_installed_control_plane_source() {
    let _lock = lock().await;
    let server = ScriptedServer::start(|_index, _request| {
        Some(json_response(
            200,
            &node_credential("rbx1.cp.sig", NOW + 1000),
        ))
    });
    let (_time, clock) = manual_clock(NOW);
    install_source(Arc::new(source_for(&server, clock)));
    {
        let _env = EnvGuard::set(&[
            (box_backend::ENV_BOX_URL, Some("http://127.0.0.1:8090/v1")),
            (box_backend::ENV_BOX_TOKEN, Some("operator-override")),
        ]);
        install_source(Arc::new(source_for(&server, manual_clock(NOW).1)));
        assert_eq!(
            current().await.unwrap().token.expose_secret(),
            "operator-override"
        );
    }
    let _env = EnvGuard::set(&[(box_backend::ENV_BOX_TOKEN, None)]);
    install_source(Arc::new(source_for(&server, manual_clock(NOW).1)));
    assert_eq!(
        current().await.unwrap().token.expose_secret(),
        "rbx1.cp.sig"
    );
    assert_eq!(server.finish().len(), 1);
}
