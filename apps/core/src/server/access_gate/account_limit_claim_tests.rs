//! A paid plan or the desktop license raises the per-provider account limit
//! through the signed `ryu_limits.accountsPerProvider` claim, and only through
//! a token that verifies: the production verifier runs here against a test key.

use crate::pi_config::accounts::{provider_scope, AccountVault, KIND_API_KEY};
use crate::server::cloud_environments::tests::signed_user_jwt_with_claims;
use crate::server::plan_limits::{self, AccountLimitReached, FREE_ACCOUNTS_PER_PROVIDER};
use crate::server::verified_caller_from_token;
use serde_json::json;

const LICENSED: usize = 50;

async fn user_token(accounts_per_provider: usize, exp_offset: i64) -> String {
    let limits = json!({ "boxConcurrency": 1, "accountsPerProvider": accounts_per_provider });
    signed_user_jwt_with_claims(json!({ "ryu_limits": limits }), exp_offset).await
}

/// Add one API key account to the provider, as every add path of the vault does.
fn add(vault: &AccountVault, index: usize) -> anyhow::Result<()> {
    let key = json!({ "type": "api_key", "key": format!("sk-{index}") });
    vault.upsert(
        &provider_scope("anthropic"),
        &format!("acct-{index}"),
        "Key",
        KIND_API_KEY,
        Some(key),
    )
}

#[tokio::test]
async fn only_a_verified_token_raises_the_account_limit() {
    plan_limits::forget_claims_for_test();
    let free = FREE_ACCOUNTS_PER_PROVIDER;
    let vault = AccountVault::in_memory().unwrap();
    for index in 0..free {
        add(&vault, index).unwrap();
    }
    // Signed out or offline: the 11th account is refused.
    let refused = add(&vault, free).unwrap_err();
    assert_eq!(
        AccountLimitReached::from_error(&refused).map(|refusal| refusal.limit),
        Some(free)
    );

    // An expired token and a token whose payload was edited after signing are
    // not verified, so the higher number in them is never read.
    let expired = user_token(LICENSED, -3600).await;
    assert!(verified_caller_from_token(&expired).await.is_none());
    let free_token = user_token(free, 600).await;
    let licensed_token = user_token(LICENSED, 600).await;
    let forged = {
        let signed: Vec<&str> = free_token.split('.').collect();
        let edited: Vec<&str> = licensed_token.split('.').collect();
        format!("{}.{}.{}", signed[0], edited[1], signed[2])
    };
    assert!(verified_caller_from_token(&forged).await.is_none());
    assert_eq!(plan_limits::account_limit(), free);
    assert!(add(&vault, free).is_err());

    // A free user's verified token keeps the free limit.
    assert!(verified_caller_from_token(&free_token).await.is_some());
    assert_eq!(plan_limits::account_limit(), free);

    // A licensed user's verified token: the 11th account now fits, up to 50.
    assert!(verified_caller_from_token(&licensed_token).await.is_some());
    assert_eq!(plan_limits::account_limit(), LICENSED);
    for index in free..LICENSED {
        add(&vault, index).unwrap();
    }
    let refused = add(&vault, LICENSED).unwrap_err();
    let refusal = AccountLimitReached::from_error(&refused).unwrap();
    assert_eq!((refusal.limit, refusal.count), (LICENSED, LICENSED));

    // The license lapses or the user signs out: nothing is removed, and only
    // new accounts are refused again.
    plan_limits::age_claims_for_test(24 * 60 * 60);
    assert_eq!(plan_limits::account_limit(), free);
    let scope = provider_scope("anthropic");
    assert_eq!(vault.count(&scope).unwrap(), LICENSED);
    assert!(add(&vault, LICENSED).is_err());
    add(&vault, 0).expect("an existing account is still replaced");
    plan_limits::forget_claims_for_test();
}
