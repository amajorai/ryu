use super::custody_fixtures::*;
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn legacy_oauth_challenge_uses_the_pinned_get_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/sse", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move {
        for method in ["POST", "GET"] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 8192];
            let count = stream.read(&mut bytes).await.unwrap();
            let text = String::from_utf8_lossy(&bytes[..count]);
            assert!(text.starts_with(method));
            assert!(text
                .to_ascii_lowercase()
                .contains("x-workspace: synthetic-workspace-key"));
            let response = if method == "POST" {
                "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"https://fixture.example/metadata\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let headers = [("x-workspace".into(), "synthetic-workspace-key".into())].into();
    let challenge = oauth_challenge(&url, &headers).await.unwrap().unwrap();
    assert!(challenge.contains("resource_metadata"));
    assert!(checked_challenge(
        Some("Bearer scope=synthetic-workspace-key".into()),
        &headers
    )
    .is_err());
    task.await.unwrap();
}

#[tokio::test]
async fn legacy_sse_consumes_pinned_headers_and_closes_on_cancellation() {
    let (base, closed, task) = legacy_fixture().await;
    let (manager, binding, config) = configured_seed(&base, "sse").await;
    let mut session = None;
    let response = manager
        .consume_configured(
            &binding,
            vec![],
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.to_vec(),
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut session,
        )
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    let text = String::from_utf8(response.body).unwrap();
    assert!(text.contains("notifications/progress"));
    assert!(text.contains("notifications/post-accepted"));
    assert!(text.contains("\"ok\":true"));
    assert!(session.is_some());
    let response = manager
        .consume_configured(
            &binding,
            vec![],
            br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec(),
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut session,
        )
        .await
        .unwrap();
    assert_eq!(response.status, 202);
    let mut changed = config.clone();
    changed
        .static_headers
        .insert("x-workspace".into(), "other".into());
    assert!(manager
        .consume_configured(
            &binding,
            vec![],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false,
            &changed,
            &mut session
        )
        .await
        .is_err());
    assert!(manager
        .consume_configured(
            &binding,
            vec![],
            br#"{"jsonrpc":"2.0","id":2,"method":"echo"}"#.to_vec(),
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut session
        )
        .await
        .is_err());
    let timed = tokio::time::timeout(
        Duration::from_millis(50),
        manager.consume_configured(
            &binding,
            vec![],
            br#"{"jsonrpc":"2.0","id":3,"method":"stall"}"#.to_vec(),
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut session,
        ),
    )
    .await;
    assert!(timed.is_err());
    drop(session);
    tokio::time::timeout(Duration::from_secs(1), async {
        while closed.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    manager.disconnect_plugin("plugin").await.unwrap();
    task.abort();
}
#[tokio::test]
async fn legacy_sse_rejects_cross_origin_and_preserves_authentication_challenge() {
    let (base, _, task) = legacy_fixture().await;
    let (manager, binding, config) = configured_seed(&base, "cross").await;
    assert!(manager
        .consume_configured(
            &binding,
            vec![],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut None
        )
        .await
        .is_err());
    let (manager, binding, config) = configured_seed(&base, "unauthorized").await;
    let response = manager
        .consume_configured(
            &binding,
            vec![],
            vec![],
            crate::ConnectionAction::Read,
            false,
            false,
            &config,
            &mut None,
        )
        .await
        .unwrap();
    assert_eq!(response.status, 401);
    assert!(response
        .headers
        .iter()
        .any(|(k, v)| k == "www-authenticate" && v.contains("invalid_token")));
    task.abort();
}

#[test]
fn consent_requests_challenge_then_resource_scopes_before_server_scopes() {
    let owned = |values: &[&str]| values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    let resource = owned(&["mail.read"]);
    let server = owned(&["mail.read", "mail.send", "directory.admin"]);
    assert_eq!(
        consent_scopes(owned(&["mail.send"]), &resource, &server),
        ["mail.send"]
    );
    assert_eq!(consent_scopes(vec![], &resource, &server), ["mail.read"]);
    assert_eq!(
        consent_scopes(vec![], &[], &server),
        ["directory.admin", "mail.read", "mail.send"]
    );
    assert!(consent_scopes(vec![], &[], &[]).is_empty());
    // Refresh-token issuance is preserved when the server gates it on
    // offline_access, without widening resource authority.
    let server_with_refresh = owned(&["mail.read", "directory.admin", "offline_access"]);
    assert_eq!(
        consent_scopes(vec![], &resource, &server_with_refresh),
        ["mail.read", "offline_access"]
    );
    // A step-up challenge stays exactly what the resource asked for.
    assert_eq!(
        consent_scopes(owned(&["mail.send"]), &resource, &server_with_refresh),
        ["mail.send"]
    );
}
