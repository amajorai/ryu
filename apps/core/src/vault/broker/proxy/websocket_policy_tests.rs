//! WebSocket messages resolve their credentials under the policies and
//! values current when each is sent. Nothing here reaches the network.

use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use super::tests::{
    add_service, config, handshake, intercepted, leak_store, next_message, put_secret, start,
    tls_echo_upstream, ws_service, AUTH_VALUE,
};
use super::*;
use crate::vault::broker::sessions::{MintRequest, MinterScope};

#[tokio::test]
async fn each_message_resolves_under_the_current_policies_and_values() {
    use crate::vault::policy::{bind, put_policy, Capability, Policy, PolicyRule};
    let store = leak_store();
    put_secret(store, "WS_AUTH", AUTH_VALUE).await;
    put_secret(store, "WS_KEY", "first-key").await;
    let (upstream, upstream_ca, mut seen) = tls_echo_upstream().await;
    add_service(store, ws_service(upstream, "secret:WS_KEY")).await;
    let (token, _) = {
        let conn = store.conn.lock().await;
        sessions::mint(
            &conn,
            MintRequest {
                environment: "default".into(),
                services: vec!["ws".into()],
                label: "test".into(),
                ttl_secs: None,
                minted_by: "user:u1".into(),
                not_after: None,
                minted_token: None,
                minter_scope: Some(MinterScope {
                    subjects: vec!["user:u1".into(), "role:contractor".into()],
                    manager: false,
                }),
            },
        )
        .unwrap()
    };
    let port = start(store, config(vec![upstream_ca])).await;
    let tls = intercepted(store, port, upstream, &token).await;
    let url = format!("wss://localhost:{upstream}/stream");
    let (mut socket, _) = tokio_tungstenite::client_async(url, tls).await.unwrap();
    handshake(&mut seen).await;

    let key = || Message::Text("key __WS_KEY__".into());
    socket.send(key()).await.unwrap();
    assert_eq!(
        next_message(&mut seen).await.into_text().unwrap(),
        "key first-key"
    );
    socket.next().await.unwrap().unwrap();

    // A rotated value is used by the next message.
    put_secret(store, "WS_KEY", "second-key").await;
    socket.send(key()).await.unwrap();
    assert_eq!(
        next_message(&mut seen).await.into_text().unwrap(),
        "key second-key"
    );
    socket.next().await.unwrap().unwrap();

    // A deny added mid-connection refuses the next message.
    {
        let conn = store.conn.lock().await;
        let deny = Policy {
            name: "contractor".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "default/WS_KEY".into(),
                capabilities: vec![Capability::Use, Capability::Read],
                deny: true,
                ..Default::default()
            }],
        };
        put_policy(&conn, &deny).unwrap();
        bind(&conn, "contractor", "role:contractor", None, None).unwrap();
    }
    socket.send(key()).await.unwrap();
    match socket.next().await {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(frame.code, CloseCode::Policy),
        other => panic!("expected a policy close, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), next_message(&mut seen))
            .await
            .is_err(),
        "the denied message never reaches upstream"
    );
}
