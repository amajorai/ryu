use super::*;

const SEED: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

fn agent() -> AuditActor {
    AuditActor::new("agent", Some("agent-1"))
}

fn store() -> PluginSecretStore {
    PluginSecretStore::in_memory().unwrap()
}

fn create_input(site: &str) -> CreateInput {
    CreateInput {
        site: site.to_owned(),
        username: Some("ryu-bot".into()),
        email: Some("bot@example.com".into()),
        ..CreateInput::default()
    }
}

fn code(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<VaultError>().expect("typed").code()
}

#[test]
fn folders_are_per_agent_and_never_collide() {
    assert_eq!(agent_folder(None), UNASSIGNED_FOLDER);
    assert_eq!(agent_folder(Some("  ")), UNASSIGNED_FOLDER);
    assert_eq!(agent_folder(Some("research_bot-2")), "research_bot-2");
    let hashed = agent_folder(Some("agent:with/odd chars"));
    assert!(hashed.starts_with("h-"), "{hashed}");
    assert_ne!(hashed, agent_folder(Some("agent:with/odd chars!")));
    // Ids that look like reserved folders are hashed, not reused.
    assert_ne!(agent_folder(Some(UNASSIGNED_FOLDER)), UNASSIGNED_FOLDER);
    assert_ne!(agent_folder(Some(&hashed)), hashed);
    assert!(crate::vault::normalize_path(&agent_folder(Some(&"x".repeat(300)))).is_some());
}

#[test]
fn sites_and_page_binding() {
    assert_eq!(
        parse_site("github.com").unwrap(),
        ("https://github.com".into(), "github.com".into())
    );
    assert_eq!(
        parse_site("https://www.Example.com/signup?x=1").unwrap().1,
        "example.com"
    );
    assert!(parse_site("http://example.com").is_err());
    assert!(parse_site("http://localhost:3000").is_ok());
    assert!(parse_site("ftp://example.com").is_err());
    assert!(parse_site("").is_err());

    assert!(page_matches_host("https://github.com/login", "github.com"));
    assert!(page_matches_host(
        "https://www.github.com/login",
        "github.com"
    ));
    // A subdomain is another site: its pages may be user content.
    assert!(!page_matches_host(
        "https://accounts.github.com/",
        "github.com"
    ));
    assert!(!page_matches_host(
        "https://someone.github.io/login",
        "github.io"
    ));
    assert!(!page_matches_host("http://github.com/login", "github.com"));
    assert!(!page_matches_host("https://evilgithub.com/", "github.com"));
    assert!(!page_matches_host(
        "https://github.com.evil.io/",
        "github.com"
    ));
    assert!(!page_matches_host("not a url", "github.com"));
    assert!(page_matches_host("http://localhost:3000/x", "localhost"));
}

#[test]
fn generated_passwords_mix_every_class() {
    for _ in 0..50 {
        let password = generate_password(DEFAULT_PASSWORD_LENGTH).unwrap();
        assert_eq!(password.len(), usize::from(DEFAULT_PASSWORD_LENGTH));
        assert!(password.bytes().any(|b| b.is_ascii_lowercase()));
        assert!(password.bytes().any(|b| b.is_ascii_uppercase()));
        assert!(password.bytes().any(|b| b.is_ascii_digit()));
        assert!(password.chars().any(|c| PASSWORD_SYMBOLS.contains(c)));
    }
    assert!(generate_password(8).is_err());
    assert!(generate_password(129).is_err());
}

#[test]
fn enrollment_secrets_normalize() {
    // Enrollment lives in its own module; the root re-exports it.
    assert_eq!(enroll::normalize_enrollment_secret(SEED).unwrap(), SEED);
    assert_eq!(
        normalize_enrollment_secret("jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp").unwrap(),
        SEED
    );
    let uri = format!("otpauth://totp/GitHub:bot?secret={SEED}&issuer=GitHub");
    assert_eq!(normalize_enrollment_secret(&uri).unwrap(), SEED);
    let eight = format!("otpauth://totp/GitHub:bot?secret={SEED}&digits=8");
    assert!(normalize_enrollment_secret(&eight).is_err());
    assert!(normalize_enrollment_secret("not a secret").is_err());
}

#[tokio::test]
async fn create_returns_no_secret_and_lists_per_agent() {
    let store = store();
    let account = create(
        &store,
        Some("agent-1"),
        create_input("github.com"),
        &agent(),
    )
    .await
    .unwrap();
    assert!(account.id.starts_with("github.com--"), "{}", account.id);
    assert_eq!(account.site, "https://github.com");
    assert!(account.has_password);
    assert!(!account.has_totp);
    let serialized = serde_json::to_string(&account).unwrap();
    assert!(!serialized.contains("password\":\""), "{serialized}");

    let mine = list(&store, Some("agent-1"), None).await.unwrap();
    assert_eq!(mine, vec![account.clone()]);
    assert_eq!(
        list(
            &store,
            Some("agent-1"),
            Some("https://accounts.github.com/x")
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert!(list(&store, Some("agent-1"), Some("gitlab.com"))
        .await
        .unwrap()
        .is_empty());
    assert!(list(&store, Some("agent-2"), None)
        .await
        .unwrap()
        .is_empty());
    assert!(list(&store, None, None).await.unwrap().is_empty());
}

#[tokio::test]
async fn fills_are_origin_bound_and_agent_scoped() {
    let store = store();
    let account = create(
        &store,
        Some("agent-1"),
        create_input("github.com"),
        &agent(),
    )
    .await
    .unwrap();
    let id = account.id.as_str();
    let page = "https://github.com/login";

    let password = release_for_fill(
        &store,
        Some("agent-1"),
        id,
        FillField::Password,
        page,
        &agent(),
    )
    .await
    .unwrap();
    assert_eq!(password.len(), usize::from(DEFAULT_PASSWORD_LENGTH));
    let username = release_for_fill(
        &store,
        Some("agent-1"),
        id,
        FillField::Username,
        page,
        &agent(),
    )
    .await
    .unwrap();
    assert_eq!(username, "ryu-bot");

    let error = release_for_fill(
        &store,
        Some("agent-1"),
        id,
        FillField::Password,
        "https://github.com.evil.io/login",
        &agent(),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_denied");

    let error = release_for_fill(
        &store,
        Some("agent-2"),
        id,
        FillField::Password,
        page,
        &agent(),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");

    let error = release_for_fill(&store, Some("agent-1"), id, FillField::Totp, page, &agent())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
}

#[tokio::test]
async fn totp_enrollment_yields_codes_never_seeds() {
    let store = store();
    let account = create(
        &store,
        Some("agent-1"),
        create_input("github.com"),
        &agent(),
    )
    .await
    .unwrap();
    let id = account.id.as_str();
    let error = enroll_totp(
        &store,
        Some("agent-1"),
        id,
        SEED,
        "https://evil.example/setup",
        &agent(),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_denied");

    let enrolled = enroll_totp(
        &store,
        Some("agent-1"),
        id,
        &format!("otpauth://totp/GitHub:bot?secret={SEED}"),
        "https://github.com/settings/2fa",
        &agent(),
    )
    .await
    .unwrap();
    assert!(enrolled.has_totp);

    let code = release_for_fill(
        &store,
        Some("agent-1"),
        id,
        FillField::Totp,
        "https://github.com/sessions/two-factor",
        &agent(),
    )
    .await
    .unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|b| b.is_ascii_digit()));
    assert_ne!(code, SEED);
}
