//! Static provider configuration tests.

use super::*;

fn anthropic(replacement: Option<&str>, current: Option<&str>) -> StaticProvider {
    StaticProvider::Anthropic {
        admin_api_key: "sk-ant-admin01-x".into(),
        workspace_id: None,
        replacement_api_key: replacement.map(str::to_owned),
        current_api_key_id: current.map(str::to_owned),
    }
}

#[test]
fn edits_keep_the_current_key_id_and_an_unused_staged_key() {
    let stored = anthropic(Some("sk-ant-api03-staged"), Some("apikey_1"));
    let merged = anthropic(None, None).with_managed_fields_from(&stored);
    assert_eq!(merged, stored);
    // A newly staged key replaces the stored one; the id stays Core's.
    let merged =
        anthropic(Some("sk-ant-api03-new"), Some("apikey_9")).with_managed_fields_from(&stored);
    assert_eq!(
        merged,
        anthropic(Some("sk-ant-api03-new"), Some("apikey_1"))
    );
    assert!(merged.mints_keys());
    assert_eq!(stored.account(), anthropic(None, None).account());
}

#[tokio::test]
async fn key_minting_providers_never_take_a_password() {
    let error = apply_password(
        &anthropic(None, None),
        "role",
        "pw",
        TargetEgress::default(),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("anthropic roles rotate keys"));
}
