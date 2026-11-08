//! Network secrets: staged as one-use tenant secrets for the create call only.

use super::*;

const PLACEHOLDER: &str = "__RYU_SECRET_0123456789abcdef0123__";

fn secret(value: &str) -> BoxNetworkSecret {
    BoxNetworkSecret {
        placeholder: PLACEHOLDER.into(),
        hosts: vec!["api.openai.com".into()],
        value: SecretString::new(value),
    }
}

fn spec(network: BoxNetwork) -> DisposableBoxSpec {
    DisposableBoxSpec {
        name: "ryu-task-ns".into(),
        image: None,
        network,
        ttl_seconds: 600,
        setup: Vec::new(),
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    }
}

#[tokio::test]
async fn box_network_secrets_are_staged_bound_by_name_and_removed_before_waiting() {
    let created =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning"}}"#;
    let ready =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready"}}"#;
    let (base, captured) = fake_box(vec![
        (200, r#"{"ok":true}"#),
        (202, created),
        (200, r#"{"ok":true}"#),
        (200, ready),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let id = client
        .create_disposable_with_network_secrets(
            &spec(BoxNetwork::Allowlist(vec!["api.openai.com".into()])),
            "idem-ns",
            &[secret("sk-live-1")],
        )
        .await
        .unwrap();
    assert_eq!(id.0, BOX_ID);
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    let put = requests[0].request_line().to_owned();
    assert!(put.starts_with("PUT /v1/secrets/RYU_NET_"), "{put}");
    let name = put
        .trim_start_matches("PUT /v1/secrets/")
        .split(' ')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(requests[0].json(), json!({ "value": "sk-live-1" }));
    let body = requests[1].json();
    assert!(requests[1].request_line().starts_with("POST /v1/boxes "));
    assert_eq!(
        body["networkSecrets"],
        json!([{ "secret": name, "placeholder": PLACEHOLDER, "hosts": ["api.openai.com"] }])
    );
    // The value travels only in the staging PUT, never in the create body.
    assert!(!requests[1].body.contains("sk-live-1"));
    assert!(requests[2]
        .request_line()
        .starts_with(&format!("DELETE /v1/secrets/{name} ")));
    assert!(requests[3].request_line().starts_with("GET /v1/boxes/"));
}

#[tokio::test]
async fn box_network_secrets_are_removed_when_the_create_is_refused() {
    let refused = r#"{"ok":false,"error":{"code":"not_supported","message":"The vm driver cannot substitute network secrets."}}"#;
    let (base, captured) = fake_box(vec![
        (200, r#"{"ok":true}"#),
        (422, refused),
        (200, r#"{"ok":true}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let error = client
        .create_disposable_with_network_secrets(
            &spec(BoxNetwork::Egress),
            "idem-ns",
            &[secret("sk-live-2")],
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("not_supported")
            || format!("{error:?}").contains("not_supported")
    );
    assert!(!format!("{error:?}").contains("sk-live-2"));
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert!(requests[2]
        .request_line()
        .starts_with("DELETE /v1/secrets/RYU_NET_"));
}

#[tokio::test]
async fn box_network_secrets_fail_closed_before_any_request() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    for (network, bad) in [
        (BoxNetwork::None, secret("v")),
        (BoxNetwork::Egress, secret("line\r\nX-Injected: 1")),
        (
            BoxNetwork::Egress,
            BoxNetworkSecret {
                placeholder: "TOKEN".into(),
                ..secret("v")
            },
        ),
    ] {
        let error = client
            .create_disposable_with_network_secrets(&spec(network), "idem", &[bad])
            .await
            .unwrap_err();
        assert!(
            matches!(error, BoxApiError::Http { status: 400, .. }),
            "{error:?}"
        );
        assert!(!format!("{error:?}").contains("X-Injected"));
    }
    assert!(is_network_secret_placeholder(PLACEHOLDER));
    assert!(!is_network_secret_placeholder("__RYU_SECRET_short__"));
    assert!(!format!("{:?}", secret("sk-live-3")).contains("sk-live-3"));
}
