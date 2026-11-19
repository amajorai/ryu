//! Credential request links against a fake Ryu Cloud.

use super::super::client::tests::fake_cloud;
use super::super::tests::browser_seal;
use super::super::{collect_answer, finish_claim};
use super::*;
use crate::vault::agent_accounts::{create_collected, release_for_fill, FillField};
use std::sync::{Arc, Mutex};

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn created() -> (u16, Value) {
    (
        201,
        json!({ "id": "vc_1", "url": "https://ryu.example/secret-request/TOKEN", "expiresAt": "2026-11-10T00:00:00.000Z" }),
    )
}

#[tokio::test]
async fn a_credential_request_asks_for_a_site_and_its_answer_becomes_an_account() {
    let store = PluginSecretStore::in_memory().unwrap();
    let public_key: Arc<Mutex<Option<String>>> = Arc::default();
    let shared_key = public_key.clone();
    let answer = json!({
        "type": "credential",
        "username": "ops-bot",
        "password": "s3cret-pass",
        "totp": "JBSWY3DPEHPK3PXP",
    })
    .to_string();
    let (cloud, log) = fake_cloud(move |seen| {
        if seen.path.ends_with("/collect") {
            let key = shared_key.lock().unwrap().clone().unwrap();
            return (200, json!({ "response": browser_seal(&key, &answer) }));
        }
        *shared_key.lock().unwrap() = seen.body["publicKey"].as_str().map(str::to_owned);
        created()
    })
    .await;
    let link = request_credential(
        &store,
        &cloud,
        CredentialRequest {
            agent_id: Some("agent-1"),
            site: "www.GitHub.com/login",
            username: Some(" ops-bot "),
            totp: true,
            submit_urls: vec!["https://github.com/session".into()],
            label: "Sign-in for the release agent",
            ttl_secs: None,
        },
        &actor(),
    )
    .await
    .unwrap();
    assert_eq!(link.url, "https://ryu.example/secret-request/TOKEN");
    // The page gets the site and the prefill, never the agent or target.
    let body = log.lock().unwrap()[0].body.clone();
    assert_eq!(
        body["form"],
        json!({ "type": "credential", "site": "https://www.github.com", "totp": true, "username": "ops-bot" })
    );
    assert!(!body.to_string().contains("agent-1"));

    let (info, text) = collect_answer(&store, &cloud, "vc_1", &actor())
        .await
        .unwrap()
        .unwrap();
    let target = target_of(info.target.as_ref()).unwrap();
    assert_eq!(
        target,
        CredentialTarget {
            agent_id: Some("agent-1".into()),
            site: "https://www.github.com".into(),
            submit_urls: vec!["https://github.com/session".into()],
        }
    );
    let input = collected_input(&target, &text, info.label.as_deref()).unwrap();
    let account = create_collected(&store, target.agent_id.as_deref(), input, &actor())
        .await
        .unwrap();
    finish_claim(&store, "vc_1", &actor()).await.unwrap();
    assert!(account.has_totp);
    assert_eq!(
        account.label.as_deref(),
        Some("Sign-in for the release agent")
    );
    let password = release_for_fill(
        &store,
        Some("agent-1"),
        &account.id,
        FillField::Password,
        "https://github.com/login",
        &actor(),
    )
    .await
    .unwrap();
    assert_eq!(password, "s3cret-pass");
}

#[tokio::test]
async fn bad_sites_and_usernames_are_refused_before_a_link_exists() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (cloud, log) = fake_cloud(|_| created()).await;
    for (site, username, submit) in [
        ("http://example.com", None, vec![]),
        ("", None, vec![]),
        ("example.com", Some("two\nlines"), vec![]),
        (
            "example.com",
            None,
            vec!["https://elsewhere.test/login".to_owned()],
        ),
    ] {
        let request = CredentialRequest {
            site,
            username,
            submit_urls: submit,
            label: "Sign-in",
            ..CredentialRequest::default()
        };
        assert!(request_credential(&store, &cloud, request, &actor())
            .await
            .is_err());
    }
    assert!(log.lock().unwrap().is_empty());
}

#[test]
fn plain_requests_and_wrong_answers_are_not_credentials() {
    assert_eq!(target_of(Some(&json!({ "name": "KEY" }))), None);
    assert_eq!(target_of(None), None);
    let target = CredentialTarget {
        agent_id: None,
        site: "https://example.com".into(),
        submit_urls: vec![],
    };
    for answer in [
        "sk_live_123",
        r#"{"type":"secret","password":"x"}"#,
        r#"{"type":"credential"}"#,
        r#"{"type":"credential","password":"x","extra":1}"#,
    ] {
        assert!(collected_input(&target, answer, None).is_err(), "{answer}");
    }
}
