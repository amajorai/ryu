//! Per-account policy, strategy and drain settings applied to every registered
//! provider once registration is complete.

use super::*;

pub(super) fn register(registry: &mut ProviderRegistry, build: &RegistryBuild<'_>) {
    let RegistryBuild { config, .. } = *build;
    for (id, provider) in &registry.providers {
        let descriptor = ryu_gw_credentials::sdk_provider_by_id(id);
        let account_provider =
            descriptor.map_or(id.as_str(), |descriptor| descriptor.account_scope);
        let policies = if descriptor.is_some() {
            registry
                .account_ids
                .get(account_provider)
                .into_iter()
                .flatten()
                .map(|id| {
                    config
                        .account_policies
                        .get(account_provider)
                        .and_then(|policies| policies.get(id))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect()
        } else {
            config.policies_for(account_provider)
        };
        if !policies.is_empty() {
            provider.configure_account_policies(&policies);
            registry
                .account_ids
                .entry(account_provider.to_owned())
                .or_insert_with(|| {
                    config
                        .account_keys(account_provider)
                        .iter()
                        .map(|key| ryu_gw_credentials::provider_account_id(account_provider, key))
                        .collect()
                });
        }
        if let Some(strategy) = config.account_strategies.get(account_provider) {
            provider.configure_account_strategy(*strategy);
        }
        if let Some(percent) = config.account_drain_thresholds.get(account_provider) {
            provider.configure_fill_first_drain_percent(*percent);
        }
    }
}
