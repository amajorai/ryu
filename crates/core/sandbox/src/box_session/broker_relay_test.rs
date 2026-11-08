//! Broker relay: sent in the create body only, after a feature check.

use super::*;

const TOKEN: &str = "rvb_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

fn relay() -> BoxBrokerRelay {
    BoxBrokerRelay {
        url: "https://node.example.com/api/vault/broker/box-relay".into(),
        token: SecretString::new(TOKEN),
        lease: "lease-1".into(),
        hosts: vec!["api.github.com".into()],
        ca_pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n".into(),
    }
}

fn spec(network: BoxNetwork) -> DisposableBoxSpec {
    DisposableBoxSpec {
        name: "ryu-ct-relay".into(),
        image: None,
        network,
        ttl_seconds: 600,
        setup: Vec::new(),
        size: BoxSize::Small,
        desktop: true,
        labels: BTreeMap::new(),
    }
}

#[tokio::test]
async fn a_broker_relay_rides_only_in_the_create_body() {
    let created =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning"}}"#;
    let ready =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready"}}"#;
    let (base, captured) = fake_box(vec![(202, created), (200, ready)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let id = client
        .create_disposable_with_egress(&spec(BoxNetwork::Egress), "idem-relay", &[], Some(&relay()))
        .await
        .unwrap();
    assert_eq!(id.0, BOX_ID);
    let requests = captured.lock().unwrap().clone();
    // No secret staging: the create, then the readiness poll.
    assert_eq!(requests.len(), 2);
    assert!(requests[0].request_line().starts_with("POST /v1/boxes"));
    let body = requests[0].json();
    assert_eq!(body["brokerRelay"]["token"], TOKEN);
    assert_eq!(body["brokerRelay"]["lease"], "lease-1");
    assert_eq!(body["brokerRelay"]["hosts"], json!(["api.github.com"]));
    assert!(body["brokerRelay"]["caPem"]
        .as_str()
        .unwrap()
        .starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(body.get("networkSecrets").is_none());
    assert!(!requests[1].head.contains(TOKEN));
}

#[tokio::test]
async fn a_broker_relay_fails_closed_before_any_request() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    let bad_url = BoxBrokerRelay {
        url: "http://node.example.com/relay".into(),
        ..relay()
    };
    for (network, relay) in [
        (BoxNetwork::None, relay()),
        (BoxNetwork::Egress, bad_url),
        (
            BoxNetwork::Egress,
            BoxBrokerRelay {
                hosts: Vec::new(),
                ..relay()
            },
        ),
    ] {
        let error = client
            .create_disposable_with_egress(&spec(network), "idem", &[], Some(&relay))
            .await
            .unwrap_err();
        assert!(
            matches!(error, BoxApiError::Http { status: 400, .. }),
            "{error:?}"
        );
        assert!(!format!("{error:?}").contains(TOKEN));
    }
    assert!(!format!("{:?}", relay()).contains(TOKEN));
}

#[tokio::test]
async fn only_a_service_listing_the_feature_takes_a_relay() {
    let (base, _) = fake_box(vec![
        (
            200,
            r#"{"ok":true,"features":["desktop","broker-relay-v1"]}"#,
        ),
        (200, r#"{"ok":true,"features":["desktop"]}"#),
        (200, r#"{"ok":true}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    assert!(client.relays_broker().await.unwrap());
    assert!(!client.relays_broker().await.unwrap());
    assert!(!client.relays_broker().await.unwrap());
}
