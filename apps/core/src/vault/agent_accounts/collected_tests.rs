use super::super::{list, release_for_fill, FillField};
use super::*;
use crate::vault::VaultError;

const SEED: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn input(site: &str, password: &str) -> CollectedInput {
    CollectedInput {
        site: site.to_owned(),
        username: Some("ops@example.com".into()),
        password: Zeroizing::new(password.to_owned()),
        ..CollectedInput::default()
    }
}

fn code(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<VaultError>().expect("typed").code()
}

#[tokio::test]
async fn saves_the_given_password_and_seed_and_returns_only_metadata() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut details = input("https://github.com", "correct horse battery");
    details.totp = Some(Zeroizing::new(format!(" {SEED} ")));
    details.label = Some("Release bot".into());
    details.submit_urls = vec!["https://github.com/session".into()];
    let account = create_collected(&store, Some("agent-1"), details, &actor())
        .await
        .unwrap();
    assert_eq!(account.host, "github.com");
    assert!(account.has_password && account.has_totp);
    // An email address fills either field.
    assert_eq!(account.username.as_deref(), Some("ops@example.com"));
    assert_eq!(account.email.as_deref(), Some("ops@example.com"));
    assert_eq!(account.submit_urls, vec!["https://github.com/session"]);
    let view = serde_json::to_string(&account).unwrap();
    assert!(!view.contains("correct horse"), "{view}");
    assert!(!view.contains(SEED), "{view}");

    let page = "https://github.com/login";
    let password = release_for_fill(
        &store,
        Some("agent-1"),
        &account.id,
        FillField::Password,
        page,
        &actor(),
    )
    .await
    .unwrap();
    assert_eq!(password, "correct horse battery");
    let code = release_for_fill(
        &store,
        Some("agent-1"),
        &account.id,
        FillField::Totp,
        page,
        &actor(),
    )
    .await
    .unwrap();
    assert_eq!(code.len(), 6);
    // The account belongs to that agent only.
    assert!(list(&store, Some("agent-2"), None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_plain_username_is_not_an_email() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut details = input("example.com", "pw");
    details.username = Some("ops-bot".into());
    let account = create_collected(&store, None, details, &actor())
        .await
        .unwrap();
    assert_eq!(account.username.as_deref(), Some("ops-bot"));
    assert_eq!(account.email, None);
    assert!(!account.has_totp);
}

#[tokio::test]
async fn bad_details_are_refused_before_anything_is_saved() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut bad_seed = input("example.com", "pw");
    bad_seed.totp = Some(Zeroizing::new("not a seed!".into()));
    let cases = [
        input("example.com", ""),
        input("example.com", "line\nbreak"),
        input("example.com", &"x".repeat(MAX_COLLECTED_PASSWORD + 1)),
        input("http://example.com", "pw"),
        bad_seed,
    ];
    for details in cases {
        let error = create_collected(&store, Some("agent-1"), details, &actor())
            .await
            .unwrap_err();
        assert_eq!(code(&error), "vault_invalid_request", "{error}");
    }
    assert!(list(&store, Some("agent-1"), None)
        .await
        .unwrap()
        .is_empty());
}
