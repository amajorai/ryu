//! Tests for the Redis/Valkey provider (fake RESP server shared with static roles).

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

/// A fake RESP server that records every command and answers `+OK`, or
/// `-ERR` for `ACL` commands while `fail_acl` is set.
pub(crate) async fn fake_server_with(
    fail_acl: Arc<AtomicBool>,
) -> (String, Arc<Mutex<Vec<Vec<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let log: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let recorded = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let recorded = recorded.clone();
            let fail_acl = fail_acl.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(socket);
                loop {
                    let Ok(Reply::Array(Some(items))) = read_reply(&mut reader).await else {
                        return;
                    };
                    let args: Vec<String> = items
                        .into_iter()
                        .filter_map(|item| match item {
                            Reply::Bulk(Some(bytes)) => String::from_utf8(bytes).ok(),
                            _ => None,
                        })
                        .collect();
                    let failing = fail_acl.load(Ordering::SeqCst)
                        && args.first().is_some_and(|name| name == "ACL");
                    recorded.lock().unwrap().push(args);
                    let answer: &[u8] = if failing {
                        b"-ERR denied\r\n"
                    } else {
                        b"+OK\r\n"
                    };
                    if reader.get_mut().write_all(answer).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (format!("redis://admin:s3cret@{address}"), log)
}

pub(crate) async fn fake_server(fail_acl: bool) -> (String, Arc<Mutex<Vec<Vec<String>>>>) {
    fake_server_with(Arc::new(AtomicBool::new(fail_acl))).await
}

#[test]
fn rules_cannot_manage_passwords_or_state() {
    let mut config = RedisConfig {
        connection_url: "rediss://admin:pw@cache.example.com:6380".into(),
        acl_rules: vec!["~app:*".into(), "+@read".into()],
        username_prefix: None,
        egress: TargetEgress::Trusted,
    };
    assert!(config.validate().is_ok());
    assert_eq!(config.redacted_target(), "cache.example.com:6380");
    for bad in [
        ">pw",
        "<pw",
        "#abc",
        "nopass",
        "on",
        "OFF",
        "reset",
        "resetpass",
        "a b",
        "",
    ] {
        config.acl_rules = vec![bad.into()];
        assert!(config.validate().is_err(), "{bad}");
    }
    config.acl_rules.clear();
    config.connection_url = "mysql://x".into();
    assert!(config.validate().is_err());
    assert!(validate_username("default").is_err());
    assert!(validate_username("app user").is_err());
    assert!(validate_username("svc-app_1").is_ok());
}

#[test]
fn commands_encode_as_resp_bulk_arrays() {
    assert_eq!(
        encode_command(&["ACL", "DELUSER", "u"]),
        b"*3\r\n$3\r\nACL\r\n$7\r\nDELUSER\r\n$1\r\nu\r\n".to_vec()
    );
}

#[tokio::test]
async fn issue_revoke_and_rotate_speak_acl() {
    let (url, log) = fake_server(false).await;
    let config = RedisConfig {
        connection_url: url.clone(),
        acl_rules: vec!["~app:*".into(), "+get".into()],
        username_prefix: Some("svc".into()),
        egress: TargetEgress::Trusted,
    };
    let issued = issue(&config, "cache-ro").await.unwrap();
    let name = issued.data["username"].clone();
    assert!(name.starts_with("svc_cachero_"));
    revoke(&config, &issued.revoke_data).await.unwrap();
    rotate_password(&url, "app", "newpass", TargetEgress::Trusted)
        .await
        .unwrap();
    let log = log.lock().unwrap().clone();
    assert_eq!(log[0], ["AUTH", "admin", "s3cret"]);
    assert_eq!(
        &log[1][..5],
        ["ACL", "SETUSER", name.as_str(), "reset", "on"]
    );
    assert_eq!(log[1][5], format!(">{}", issued.data["password"]));
    assert_eq!(&log[1][6..], ["~app:*", "+get"]);
    assert_eq!(log[3], ["ACL", "DELUSER", name.as_str()]);
    assert_eq!(log[5], ["ACL", "SETUSER", "app", "resetpass", ">newpass"]);
}

#[tokio::test]
async fn error_replies_fail_without_echoing_secrets() {
    let (url, _) = fake_server(true).await;
    let error = rotate_password(&url, "app", "hunter2hunter2", TargetEgress::Trusted)
        .await
        .unwrap_err();
    let text = error.to_string();
    assert!(text.contains("ACL SETUSER failed"));
    assert!(!text.contains("hunter2"));
}

#[tokio::test]
async fn rejected_auth_never_reports_the_admin_password() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let mut reader = BufReader::new(socket);
            if read_reply(&mut reader).await.is_ok() {
                let _ = reader
                    .get_mut()
                    .write_all(b"-WRONGPASS invalid username-password pair\r\n")
                    .await;
            }
        }
    });
    for url in [
        format!("redis://:adm1n-s3cret@{address}"),
        format!("redis://admin:adm1n-s3cret@{address}"),
    ] {
        let text = rotate_password(&url, "app", "newpass", TargetEgress::Trusted)
            .await
            .unwrap_err()
            .to_string();
        assert!(text.contains("redis AUTH failed"), "{text}");
        assert!(!text.contains("adm1n-s3cret"), "{text}");
        assert!(!text.contains("admin failed"), "{text}");
    }
}
