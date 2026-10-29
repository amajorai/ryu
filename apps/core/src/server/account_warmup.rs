//! Single-account warmup pings for subscription provider pools.
//!
//! A provider can hold several saved logins, and each has its own rolling usage
//! window. An ordinary turn goes through the provider's pool dispatcher, which
//! picks whichever account its policy prefers. A warmup must reach the account
//! the user named, so this sends one minimal request with exactly that sealed
//! credential. Nothing here changes the active account or the pool policy.

/// Providers whose saved accounts can be pinged one at a time.
pub const SUPPORTED_PROVIDERS: [&str; 2] =
    ["claude-pro-max", crate::pi_config::CHATGPT_PROVIDER_ID];

/// Whether `provider_id` supports single-account warmup pings. This is also the
/// source of the `accountPing` capability that `crate::subscriptions` reports,
/// so clients filter warmup targets by capability instead of a copied list.
pub fn supported(provider_id: &str) -> bool {
    SUPPORTED_PROVIDERS.contains(&provider_id)
}

/// Whether `caller` may see saved subscription logins and schedule pings on
/// them: the node owner (or an org owner/admin on an org node), the same rule
/// as the `subscriptions.*` bridge calls. A ping spends that login's quota, so
/// `agent.edit` alone is not enough.
pub fn caller_may_ping_accounts(caller: &Option<crate::identity_verify::VerifiedCaller>) -> bool {
    crate::plugin_host::node_owner_or_admin(caller.as_ref())
}

/// Check that `account_id` is a saved subscription login of `provider_id`.
pub fn validate(provider_id: &str, account_id: &str, model: Option<&str>) -> Result<(), String> {
    if !supported(provider_id) {
        return Err(format!(
            "provider '{provider_id}' does not support per-account warmup pings"
        ));
    }
    if model.map(str::trim).is_none_or(str::is_empty) {
        return Err("a provider account ping must name a model".to_owned());
    }
    let known = crate::pi_config::list_provider_accounts(provider_id)
        .into_iter()
        .any(|account| {
            account.account_id == account_id
                && account.kind == crate::pi_config::accounts::KIND_OAUTH
        });
    if !known {
        return Err(format!(
            "account '{account_id}' is not a saved {provider_id} login"
        ));
    }
    Ok(())
}

/// Send one minimal turn on exactly this account.
pub async fn ping(
    provider_id: &str,
    account_id: &str,
    model: &str,
    prompt: &str,
) -> Result<(), String> {
    let prompt = if prompt.trim().is_empty() {
        "hi"
    } else {
        prompt
    };
    let result = match provider_id {
        "claude-pro-max" => super::claude_api::ping_account(account_id, model, prompt).await,
        crate::pi_config::CHATGPT_PROVIDER_ID => {
            super::chatgpt_api::ping_account(account_id, model, prompt).await
        }
        other => Err(anyhow::anyhow!(
            "provider '{other}' does not support per-account warmup pings"
        )),
    };
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_account_pool_providers_are_supported() {
        assert!(supported("claude-pro-max"));
        assert!(supported("chatgpt"));
        assert!(!supported("gateway"));
        assert!(!supported("openai"));
    }

    #[test]
    fn provider_account_target_round_trips_on_the_scheduler_wire() {
        use crate::scheduler::store::JobTarget;
        let wire = serde_json::json!({
            "type": "provider_account",
            "provider_id": "claude-pro-max",
            "account_id": "acct-work",
            "prompt": "hi",
            "model": "claude-haiku-4-5",
        });
        let target: JobTarget = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(
            &target,
            JobTarget::ProviderAccount { account_id, .. } if account_id == "acct-work"
        ));
        assert_eq!(serde_json::to_value(&target).unwrap(), wire);
    }

    #[test]
    fn validation_rejects_unsupported_providers_and_missing_models() {
        assert!(validate("openai", "a", Some("gpt-5")).is_err());
        assert!(validate("claude-pro-max", "a", None).is_err());
        assert!(validate("claude-pro-max", "a", Some("  ")).is_err());
    }
}
