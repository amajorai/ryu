//! Direct OpenAI-compatible vendors, Google TTS, Polly, web providers and the
//! Vercel lane.

use super::*;

pub(super) fn register(registry: &mut ProviderRegistry, build: &RegistryBuild<'_>) {
    let RegistryBuild {
        config,
        egress,
        quota,
        client,
        custody,
        ..
    } = *build;
    for (id, _) in ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS {
        if let Some(config) = config.compatible.get(*id) {
            if *id == "qwen" {
                registry.register(Arc::new(QwenProvider::new(
                    client.clone(),
                    egress.and_then(|pool| pool.assigned("qwen")),
                    config.all_keys(),
                    config.base_url.clone(),
                    Arc::clone(&quota),
                )));
                continue;
            }
            registry.register_as(
                id,
                Arc::new(OpenAiProvider::new_named_with_egress(
                    id,
                    client.clone(),
                    egress.and_then(|pool| pool.assigned(id)),
                    config.all_keys(),
                    config.base_url.clone(),
                    Arc::clone(&quota),
                )),
            );
        }
    }

    if config
        .edge_tts
        .as_ref()
        .is_some_and(|settings| settings.anonymous_consumer_opt_in)
    {
        match ryu_gw_providers::EdgeTtsProvider::new(
            true,
            egress.and_then(|pools| pools.assigned("edge-tts")),
            Arc::clone(&quota),
        ) {
            Ok(provider) => registry.register(Arc::new(provider)),
            Err(_) => {
                registry.activation_errors.insert(
                    "edge-tts".to_owned(),
                    "Edge consumer TTS activation failed".to_owned(),
                );
            }
        }
    }

    if config
        .google_translate_tts
        .as_ref()
        .is_some_and(|settings| settings.anonymous_consumer_opt_in)
    {
        match ryu_gw_providers::GoogleTranslateTtsProvider::new(
            true,
            client.clone(),
            egress.and_then(|pools| pools.assigned("google-translate-tts")),
        ) {
            Ok(provider) => registry.register(Arc::new(provider)),
            Err(_) => {
                registry.activation_errors.insert(
                    "google-translate-tts".to_owned(),
                    "Google Translate consumer TTS activation failed".to_owned(),
                );
            }
        }
    }

    if let Some(settings) = config.google_tts.as_ref() {
        let accounts = settings
            .accounts
            .iter()
            .map(|row| {
                GoogleTtsAccount::supplied_oauth(
                    row.access_token.clone(),
                    row.quota_project.clone(),
                    row.expires_at_unix_secs,
                )
            })
            .collect::<Result<Vec<_>, _>>();
        let result = accounts.and_then(|accounts| {
            let ids = accounts
                .iter()
                .map(|row| row.account_id().to_owned())
                .collect::<Vec<_>>();
            let policies = ids
                .iter()
                .map(|id| {
                    config
                        .account_policies
                        .get("google-tts")
                        .and_then(|rows| rows.get(id))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            GoogleTtsProvider::new(
                accounts,
                &policies,
                egress.and_then(|pools| pools.assigned("google-tts")),
                Arc::clone(&quota),
            )
            .map(|provider| (provider, ids))
        });
        match result {
            Ok((provider, ids)) => {
                registry.account_ids.insert("google-tts".to_owned(), ids);
                registry.register(Arc::new(provider));
            }
            Err(_) => {
                registry.activation_errors.insert(
                    "google-tts".to_owned(),
                    "Google TTS account activation failed".to_owned(),
                );
            }
        }
    }
    if let Some(settings) = config.polly.as_ref() {
        let accounts = settings
            .accounts
            .iter()
            .map(|row| {
                PollyAccount::explicit(
                    row.access_key_id.clone(),
                    row.secret_access_key.clone(),
                    row.session_token.clone(),
                    row.expires_at_unix_secs,
                )
            })
            .collect::<Result<Vec<_>, _>>();
        let result = accounts.and_then(|accounts| {
            let ids = accounts
                .iter()
                .map(|row| row.account_id(&settings.region))
                .collect::<Result<Vec<_>, _>>()?;
            let policies = ids
                .iter()
                .map(|id| {
                    config
                        .account_policies
                        .get("polly")
                        .and_then(|rows| rows.get(id))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            PollyProvider::new(
                settings.region.clone(),
                accounts,
                &policies,
                egress.and_then(|pools| pools.assigned("polly")),
                Arc::clone(&quota),
            )
            .map(|provider| (provider, ids))
        });
        match result {
            Ok((provider, ids)) => {
                registry.account_ids.insert("polly".to_owned(), ids);
                registry.register(Arc::new(provider));
            }
            Err(_) => {
                registry.activation_errors.insert(
                    "polly".to_owned(),
                    "Polly account activation failed".to_owned(),
                );
            }
        }
    }

    for (kind, connection) in &config.web {
        let id = kind.descriptor().provider_id;
        let account_ids = connection
            .accounts()
            .iter()
            .map(|row| row.account_id(*kind))
            .collect::<Result<Vec<_>, _>>();
        let Ok(account_ids) = account_ids else {
            registry.activation_errors.insert(
                id.to_owned(),
                "Invalid web account configuration".to_owned(),
            );
            continue;
        };
        let policies = account_ids
            .iter()
            .map(|account| {
                config
                    .account_policies
                    .get(id)
                    .and_then(|policies| policies.get(account))
                    .cloned()
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        match ryu_gw_providers::web::WebServiceProvider::new(
            *kind,
            connection,
            &policies,
            egress.and_then(|pools| pools.assigned(id)),
            Arc::clone(&quota),
        ) {
            Ok(provider) => {
                registry.account_ids.insert(id.to_owned(), account_ids);
                registry.register(Arc::new(provider));
            }
            Err(_) => {
                registry
                    .activation_errors
                    .insert(id.to_owned(), "Web provider activation failed".to_owned());
            }
        }
    }

    // The Vercel AI Gateway lane spends Ryu's Vercel credit on every attempt
    // (credential origin `ryu_fallback`), so it is registered only under a
    // recorded written resale permission (spec 08.2, 08.4) and only on a
    // hosted fleet replica, the one custody that replaces every caller
    // identifier with Ryu's subject. Otherwise the id stays out of the
    // registry and the reason is kept as its activation error. Appended
    // last so no existing precedence moves.
    if let Some(c) = config.vercel.as_ref() {
        register_vercel_lane(registry, c, custody, &client, egress, &quota);
    }
}

/// Register the Vercel lane when its key and written resale permission are
/// both present and this Gateway holds fleet custody. Off the fleet a caller's
/// `safety_identifier` reaches the adapter unstripped, so the adapter's
/// subject check alone could be met by the caller; the lane is therefore
/// never built there. A refusal is recorded as the activation error.
fn register_vercel_lane(
    registry: &mut ProviderRegistry,
    config: &crate::config::VercelProviderConfig,
    custody: crate::custody::GatewayCustody,
    client: &reqwest::Client,
    egress: Option<&crate::egress::EgressPools>,
    quota: &Arc<ProviderQuotas>,
) {
    use ryu_gw_providers::vercel::{
        LaneRefusal, ResalePermission, VercelProvider, VERCEL_PROVIDER_ID,
    };
    let keys = config.all_keys();
    if keys.is_empty() {
        return;
    }
    let decision =
        ResalePermission::parse(config.resale_permission.as_deref()).and_then(|permission| {
            if custody.is_fleet() {
                Ok(permission)
            } else {
                Err(LaneRefusal::NotFleet)
            }
        });
    match decision {
        Ok(permission) => {
            tracing::info!(
                provider = VERCEL_PROVIDER_ID,
                reference = permission.reference(),
                "Vercel AI Gateway lane registered under a written resale permission"
            );
            registry.register(Arc::new(VercelProvider::new_with_egress(
                &permission,
                client.clone(),
                egress.and_then(|pool| pool.assigned(VERCEL_PROVIDER_ID)),
                keys,
                config.base_url.clone(),
                config.messages_base_url.clone(),
                Arc::clone(quota),
            )));
        }
        Err(refusal) => {
            tracing::warn!(
                provider = VERCEL_PROVIDER_ID,
                %refusal,
                "Vercel AI Gateway lane not registered"
            );
            registry
                .activation_errors
                .insert(VERCEL_PROVIDER_ID.to_owned(), refusal.to_string());
        }
    }
}
