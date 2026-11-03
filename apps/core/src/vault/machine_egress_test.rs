//! Regression tests for delegate-written machine identity egress: a
//! delegated `sys/machines` admin cannot point JWKS or TokenReview calls at
//! this host's loopback or LAN, while a configuration manager's identities
//! keep the host's network.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::vault::audit::AuditActor;
use crate::vault::auth_methods::KubernetesAuthConfig;
use crate::vault::machine::JwtConfig;

/// A loopback listener that counts accepted connections and closes each one
/// (or answers it with `reply`).
async fn counting_listener(reply: Option<String>) -> (u16, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            if let Some(reply) = &reply {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer).await;
                let _ = stream.write_all(reply.as_bytes()).await;
            }
        }
    });
    (port, hits)
}

fn jwt_auth(jwks_url: &str) -> AuthMethod {
    AuthMethod::Jwt(JwtConfig {
        issuer: "https://issuer.example".into(),
        jwks_url: Some(jwks_url.to_owned()),
        public_key_pem: None,
        audiences: vec!["ryu".into()],
        bound_claims: Default::default(),
    })
}

fn k8s_auth(host: &str, ca_pem: Option<String>) -> AuthMethod {
    AuthMethod::Kubernetes(KubernetesAuthConfig {
        host: host.to_owned(),
        ca_pem,
        reviewer_jwt_env: None,
        bound_service_account_names: vec!["*".into()],
        bound_service_account_namespaces: vec!["*".into()],
        audiences: vec![],
    })
}

/// A JWT whose header names an asymmetric key; the JWKS is fetched before
/// any signature is checked.
fn unsigned_jwt() -> String {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!(
        "{}.{}.c2ln",
        b64.encode(br#"{"alg":"ES256","kid":"k1","typ":"JWT"}"#),
        b64.encode(br#"{"iss":"https://issuer.example","aud":"ryu"}"#)
    )
}

async fn create(
    store: &PluginSecretStore,
    name: &str,
    auth: AuthMethod,
    writer: RoleWriter,
) -> Result<()> {
    let actor = AuditActor::new("user", Some("someone"));
    store
        .machine_create_as(name, auth, vec![], None, writer, &actor)
        .await
        .map(|_| ())
}

/// Simulate a public-looking target whose name later resolves internally by
/// rewriting the stored configuration (create-time screening has passed).
async fn retarget(store: &PluginSecretStore, name: &str, auth: &AuthMethod) {
    let conn = store.conn.lock().await;
    conn.execute(
        "UPDATE vault_machine_identities SET auth = ?1 WHERE name = ?2",
        rusqlite::params![serde_json::to_string(auth).unwrap(), name],
    )
    .unwrap();
}

#[tokio::test]
async fn delegates_cannot_create_identities_that_reach_internal_hosts() {
    let store = PluginSecretStore::in_memory().unwrap();
    let delegate = RoleWriter::Delegate;
    for (name, auth) in [
        ("jwt-loop", jwt_auth("https://127.0.0.1:8443/jwks")),
        ("jwt-lan", jwt_auth("https://10.0.0.5/jwks")),
        ("jwt-local", jwt_auth("https://localhost/jwks")),
        ("k8s-loop", k8s_auth("https://127.0.0.1:6443", None)),
        ("k8s-lan", k8s_auth("https://10.0.0.5:8443", None)),
    ] {
        let error = create(&store, name, auth, delegate).await.unwrap_err();
        assert!(
            error.to_string().contains("public hosts"),
            "{name}: {error}"
        );
    }
    // A delegate may not supply its own trust root for the API server.
    let ca = rcgen::generate_simple_self_signed(vec!["kube.example.com".into()])
        .unwrap()
        .cert
        .pem();
    let error = create(
        &store,
        "k8s-ca",
        k8s_auth("https://kube.example.com", Some(ca.clone())),
        delegate,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("caPem"), "{error}");
    // Public targets are fine for a delegate.
    create(
        &store,
        "jwt-public",
        jwt_auth("https://issuer.example/jwks"),
        delegate,
    )
    .await
    .unwrap();
    create(
        &store,
        "k8s-public",
        k8s_auth("https://kube.example.com", None),
        delegate,
    )
    .await
    .unwrap();
    // A configuration manager keeps the host's network and its own CA.
    let manager = RoleWriter::Manager;
    create(
        &store,
        "m-jwt",
        jwt_auth("https://127.0.0.1:8443/jwks"),
        manager,
    )
    .await
    .unwrap();
    create(
        &store,
        "m-k8s",
        k8s_auth("https://10.0.0.5:8443", Some(ca)),
        manager,
    )
    .await
    .unwrap();
    assert_eq!(
        store.machine_identity_egress("jwt-public").await.unwrap(),
        TargetEgress::Screened
    );
    assert_eq!(
        store.machine_identity_egress("m-jwt").await.unwrap(),
        TargetEgress::Trusted
    );
}

#[tokio::test]
async fn delegate_identities_never_contact_internal_hosts_at_login() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (port, hits) = counting_listener(None).await;

    create(
        &store,
        "jwt-d",
        jwt_auth("https://issuer.example/jwks"),
        RoleWriter::Delegate,
    )
    .await
    .unwrap();
    retarget(
        &store,
        "jwt-d",
        &jwt_auth(&format!("https://127.0.0.1:{port}/jwks")),
    )
    .await;
    let error = store.jwt_login("jwt-d", &unsigned_jwt()).await.unwrap_err();
    assert!(error.to_string().contains("public hosts"), "{error}");

    create(
        &store,
        "k8s-d",
        k8s_auth("https://kube.example.com", None),
        RoleWriter::Delegate,
    )
    .await
    .unwrap();
    retarget(
        &store,
        "k8s-d",
        &k8s_auth(&format!("https://127.0.0.1:{port}"), None),
    )
    .await;
    let error = store
        .kubernetes_login("k8s-d", "client-jwt")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("public hosts"), "{error}");

    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "no request reached the host"
    );
}

#[tokio::test]
async fn manager_identities_still_reach_the_hosts_network() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (jwks_port, jwks_hits) = counting_listener(None).await;
    let (kube_port, kube_hits) = counting_listener(None).await;
    let jwks_url = format!("https://127.0.0.1:{jwks_port}/jwks");
    store
        .machine_create(
            "jwt-m",
            jwt_auth(&jwks_url),
            vec![],
            None,
            &AuditActor::new("user", Some("admin")),
        )
        .await
        .unwrap();
    create(
        &store,
        "k8s-m",
        k8s_auth(&format!("https://127.0.0.1:{kube_port}"), None),
        RoleWriter::Manager,
    )
    .await
    .unwrap();
    // The fixtures close the connection, so both logins fail, but only after
    // Core connected to the loopback host.
    assert!(store.jwt_login("jwt-m", &unsigned_jwt()).await.is_err());
    assert!(store.kubernetes_login("k8s-m", "client-jwt").await.is_err());
    assert!(jwks_hits.load(Ordering::SeqCst) >= 1);
    assert!(kube_hits.load(Ordering::SeqCst) >= 1);
}

#[tokio::test]
async fn jwks_fetches_never_follow_redirects() {
    let (inner_port, inner_hits) = counting_listener(None).await;
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{inner_port}/jwks\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (outer_port, outer_hits) = counting_listener(Some(redirect)).await;
    let url = format!("http://127.0.0.1:{outer_port}/jwks");
    assert!(fetch_jwks(&url, TargetEgress::Trusted).await.is_err());
    assert_eq!(outer_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        inner_hits.load(Ordering::SeqCst),
        0,
        "redirect was followed"
    );
    // A screened fetch refuses plain http and loopback before connecting.
    assert!(fetch_jwks(&url, TargetEgress::Screened).await.is_err());
    assert_eq!(outer_hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn screened_token_reviews_refuse_a_stored_ca() {
    let config = KubernetesAuthConfig {
        host: "https://kube.example.com".into(),
        ca_pem: Some("-----BEGIN CERTIFICATE-----".into()),
        reviewer_jwt_env: None,
        bound_service_account_names: vec!["*".into()],
        bound_service_account_namespaces: vec!["*".into()],
        audiences: vec![],
    };
    let error = token_review_screened(&config, "client-jwt")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("caPem"), "{error}");
}
