use super::*;

fn save(vault: &super::super::accounts::AccountVault, account: &str) {
    vault
        .upsert(
            &super::super::accounts::provider_scope("github-copilot"),
            account,
            account,
            super::super::accounts::KIND_OAUTH,
            Some(json!({
                "type": "oauth",
                "access": account,
                "refresh": "fixture-refresh",
                "expires": 4_000_000_000_000_u64
            })),
        )
        .unwrap();
}

#[test]
fn peek_creates_no_affinity_and_reads_an_existing_one() {
    let vault = super::super::accounts::AccountVault::in_memory().unwrap();
    save(&vault, "first");
    let before = vault.count(AFFINITY_SCOPE).unwrap();
    assert_eq!(
        peek_with_vault(&vault, "github-copilot", Some("chat"), "ryu").unwrap(),
        None
    );
    assert_eq!(vault.count(AFFINITY_SCOPE).unwrap(), before);

    capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        None,
    )
    .unwrap();
    let after_capture = vault.count(AFFINITY_SCOPE).unwrap();
    save(&vault, "second");
    assert_eq!(
        peek_with_vault(&vault, "github-copilot", Some("chat"), "ryu").unwrap(),
        Some("first".to_owned())
    );
    assert_eq!(
        peek_with_vault(&vault, "github-copilot", Some("other-chat"), "ryu").unwrap(),
        None
    );
    assert_eq!(
        peek_with_vault(&vault, "github-copilot", None, "ryu").unwrap(),
        None
    );
    assert_eq!(
        peek_with_vault(&vault, "claude-pro-max", Some("chat"), "ryu").unwrap(),
        None
    );
    assert_eq!(vault.count(AFFINITY_SCOPE).unwrap(), after_capture);
}
