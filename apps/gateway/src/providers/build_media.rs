//! SDK (genai) accounts, native embedding/speech vendors, media generators and the classify tier.

use super::*;

pub(super) fn register(registry: &mut ProviderRegistry, build: &RegistryBuild<'_>) {
    let RegistryBuild {
        config,
        egress,
        quota,
        client,
        environment,
        ..
    } = *build;
    if let Some(c) = config.genai.as_ref() {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            let Some(account) = c.accounts.get(descriptor.kind) else {
                continue;
            };
            let resolved = match c.resolve_keys(descriptor.kind, &environment) {
                Ok(keys) => keys,
                Err(_) => {
                    registry.activation_errors.insert(
                        descriptor.provider_id.to_owned(),
                        "Invalid SDK account configuration".to_owned(),
                    );
                    continue;
                }
            };
            if let Some(diagnostic) = account.activation_diagnostic(descriptor.kind) {
                registry
                    .activation_errors
                    .insert(descriptor.provider_id.to_owned(), diagnostic);
                continue;
            }
            let keys: Vec<_> = resolved.into_iter().map(|entry| entry.key).collect();
            if keys.is_empty() && descriptor.auth_kind != ryu_gw_credentials::SdkAuthKind::NoAuth {
                continue;
            }
            match GenAiProvider::new_for_kind(
                descriptor,
                keys.clone(),
                account.context.clone(),
                client.clone(),
                egress.and_then(|pool| pool.assigned(descriptor.provider_id)),
                Arc::clone(&quota),
            ) {
                Ok(provider) => {
                    registry.account_ids.insert(
                        descriptor.account_scope.to_owned(),
                        keys.iter()
                            .map(|key| {
                                ryu_gw_credentials::provider_account_id(
                                    descriptor.account_scope,
                                    key,
                                )
                            })
                            .collect(),
                    );
                    registry.register(Arc::new(provider));
                }
                Err(_) => {
                    registry.activation_errors.insert(
                        descriptor.provider_id.to_owned(),
                        "SDK provider activation failed".to_owned(),
                    );
                }
            }
        }
    }

    if let Some(config) = config.cohere.as_ref() {
        registry.register(Arc::new(CohereProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("cohere")),
            config.all_keys(),
            config.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(config) = config.deepgram.as_ref() {
        registry.register(Arc::new(DeepgramProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("deepgram")),
            config.all_keys(),
            config.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(config) = config.assemblyai.as_ref() {
        registry.register(Arc::new(AssemblyAiProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("assemblyai")),
            config.all_keys(),
            config.base_url.clone(),
            config.poll_interval_ms,
            config.poll_timeout_secs,
            Arc::clone(&quota),
        )));
    }

    if let Some(config) = config.elevenlabs.as_ref() {
        registry.register(Arc::new(ElevenLabsProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("elevenlabs")),
            config.all_keys(),
            config.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(config) = config.inworld.as_ref() {
        registry.register(Arc::new(InworldProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("inworld")),
            config.all_keys(),
            config.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(c) = config.replicate.as_ref() {
        registry.register(Arc::new(ReplicateProvider::new_with_accounts(
            client.clone(),
            egress.and_then(|pool| pool.assigned("replicate")),
            c.all_keys(),
            c.base_url.clone(),
            c.poll_interval_ms,
            c.poll_timeout_secs,
        )));
    }

    if let Some(c) = config.bfl.as_ref() {
        registry.register(Arc::new(BflProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("bfl")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
            c.poll_interval_ms,
            c.poll_timeout_secs,
        )));
    }
    if let Some(c) = config.stability.as_ref() {
        registry.register(Arc::new(StabilityProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("stability")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
    if let Some(c) = config.runway.as_ref() {
        registry.register(Arc::new(RunwayProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("runway")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
    if let Some(c) = config.topaz.as_ref() {
        registry.register(Arc::new(TopazProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("topaz")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
    if let Some(c) = config.minimax.as_ref() {
        registry.register(Arc::new(MiniMaxProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("minimax")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
    if let Some(c) = config.recraft.as_ref() {
        registry.register(Arc::new(RecraftProvider::new(
            client.clone(),
            egress.and_then(|pool| pool.assigned("recraft")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
    if let Some(c) = config.fal.as_ref() {
        registry.register(Arc::new(FalProvider::new_with_accounts(
            client.clone(),
            egress.and_then(|pool| pool.assigned("fal")),
            c.all_keys(),
            c.base_url.clone(),
            c.poll_interval_ms,
            c.poll_timeout_secs,
        )));
    }

    // The classify tier, registered LAST on purpose: `available_providers()`
    // order drives the `/v1/models` discovery merge precedence, so appending
    // leaves every existing provider's precedence byte-identical. It speaks
    // the same OpenAI-compatible dialect as `local`, so it reuses
    // [`LocalProvider`] â€” aliased to the `"classify"` id so the two tiers
    // never share metrics, admission slots or circuit-breaker state (see
    // [`AliasedProvider`]).
    //
    // GRACEFUL DEGRADE, but read the shape carefully â€” an earlier version of
    // this comment claimed "on most nodes there is no `RYU_CLASSIFY_LLM_URL`",
    // which is backwards and misled three units:
    //
    // * The sidecar PROCESS is lazy (absent from Core's `startup_order`), but
    //   Core publishes `RYU_CLASSIFY_LLM_URL` UNCONDITIONALLY in
    //   `gateway_spawn_env` â€” it deliberately does not gate the URL on the
    //   sidecar being installed or running. So on every Core-spawned gateway
    //   this slot is `Some` and `classify` IS registered.
    // * `get("classify") == None` therefore means "standalone gateway with no
    //   published URL" â€” only there does `firewall/inspector.rs` take the
    //   absent-provider branch and `warn!` naming the provider + model.
    // * On a real node a COLD tier is `Some(slot)` + connection refused, so it
    //   surfaces as `provider.complete` â†’ `ProviderError`, NOT as an absent
    //   provider. That arm used to log the same "provider call failed" line an
    //   upstream 500 does; `firewall/inspector.rs::provider_failure_message` now
    //   branches on this id and says the local tier is not running instead. The
    //   branch lives there because that is where the routed decision is known â€”
    //   keep the two in sync through `config::CLASSIFY_PROVIDER_ID`, never a
    //   second `"classify"` literal.
    //
    // Either way the guardrail fails open, which is the deliberate posture for
    // something that must never hard-fail a turn. Do not "fix" the absent slot
    // into a startup error.
    if let Some(c) = config.classify.as_ref() {
        registry.register_as(
            crate::config::CLASSIFY_PROVIDER_ID,
            Arc::new(LocalProvider::new(client.clone(), c.base_url.clone())),
        );
    }
}
