//! Chat built-ins: OpenAI, Anthropic, local, OpenRouter, LiteLLM, Core and Modal.

use super::*;

pub(super) fn register(registry: &mut ProviderRegistry, build: &RegistryBuild<'_>) {
    let RegistryBuild {
        config,
        egress,
        quota,
        client,
        ..
    } = *build;
    // Register built-ins in the same deterministic order as before so
    // `available_providers()` iteration (and the /v1/models discovery merge
    // that depends on it) is byte-for-byte identical. A provider whose config
    // is absent is not constructed, so its id never enters the map.
    if let Some(c) = config.openai.as_ref() {
        registry.register(Arc::new(OpenAiProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("openai")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(c) = config.anthropic.as_ref() {
        registry.register(Arc::new(AnthropicProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("anthropic")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }

    if let Some(c) = config.local.as_ref() {
        registry.register(Arc::new(
            LocalProvider::new(client.clone(), c.base_url.clone())
                .with_model_routes(c.model_routes.clone()),
        ));
    }

    if let Some(c) = config.openrouter.as_ref() {
        let options = OpenRouterOptions {
            data_collection: (!c.data_collection.is_empty()).then(|| c.data_collection.clone()),
            zdr: c.zdr.then_some(true),
            sort: (!c.sort.is_empty()).then(|| c.sort.clone()),
            response_healing: c.response_healing,
            usage_accounting: c.usage_accounting,
        };
        let provider = Arc::new(OpenRouterProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("openrouter")),
            c.all_keys(),
            c.base_url.clone(),
            c.site_url.clone(),
            c.site_name.clone(),
            options,
            Arc::clone(&quota),
        ));
        registry.register_batch_provider("openrouter", provider.clone());
        registry.register(provider);
    }

    if let Some(c) = config.litellm.as_ref() {
        // A LiteLLM proxy speaks the OpenAI dialect and holds its own upstream
        // credentials, so the OpenAI adapter under the `litellm` id is the
        // whole integration. Routing to it is the routing layer's job
        // (`backends.router = "litellm"`) or an explicit `model_map` entry.
        registry.register_as(
            "litellm",
            Arc::new(OpenAiProvider::new_named_with_egress(
                "litellm",
                client.clone(),
                egress.and_then(|pool| pool.assigned("litellm")),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.core.as_ref() {
        registry.register(Arc::new(CoreProvider::new(
            client.clone(),
            c.base_url.clone(),
            c.token.clone(),
        )));
        // OAuth remains sealed in Core. Gateway holds only its existing local relay token.
        match CoreProvider::kiro_proxy(
            client.clone(),
            format!("{}/api/pi-config/kiro/v1", c.base_url.trim_end_matches('/')),
            c.token.clone(),
        ) {
            Ok(provider) => registry.register(Arc::new(provider)),
            Err(_) => {
                registry.activation_errors.insert(
                    "kiro".to_owned(),
                    "Kiro requires an authenticated local Core relay".to_owned(),
                );
            }
        }
    }

    if let Some(c) = config
        .modal
        .as_ref()
        .filter(|config| !config.all_keys().is_empty())
    {
        registry.register(Arc::new(ModalProvider::new_with_egress(
            client.clone(),
            egress.and_then(|pool| pool.assigned("modal")),
            c.all_keys(),
            c.base_url.clone(),
            Arc::clone(&quota),
        )));
    }
}
