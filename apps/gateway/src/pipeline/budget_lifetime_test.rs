//! The shared (coordinator) budget verdict and a key's lifetime token cap gate
//! streamed chat and media requests, not only buffered chat. Both checks run
//! inside the top-level `enforce_budget` admission every pipeline calls.
use super::*;
use crate::config::{
    AuditConfig, FirewallConfig, GatewayConfig, ModalityMapping, ProviderId, ProviderKind,
};
use crate::providers::Provider;
use std::pin::Pin;
use std::sync::Mutex;

type ProviderFuture<'a, T> = Pin<
    Box<dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>,
>;

/// Records the model of every upstream call it receives.
#[derive(Default)]
struct CountingProvider {
    models: Mutex<Vec<String>>,
}

impl CountingProvider {
    fn models(&self) -> Vec<String> {
        self.models.lock().unwrap().clone()
    }
}

impl Provider for CountingProvider {
    fn name(&self) -> &'static str {
        "openai"
    }
    fn complete<'a>(&'a self, model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        Box::pin(async move {
            self.models.lock().unwrap().push(model.to_owned());
            Ok(json!({
                "choices": [{ "message": { "content": "hi" } }],
                "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
            }))
        })
    }
    fn complete_stream<'a>(&'a self, model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Body> {
        Box::pin(async move {
            self.models.lock().unwrap().push(model.to_owned());
            Ok(Body::from(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
            ))
        })
    }
    fn generate_image<'a>(&'a self, model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        Box::pin(async move {
            self.models.lock().unwrap().push(model.to_owned());
            Ok(json!({ "data": [{ "url": "https://example.invalid/cat.png" }] }))
        })
    }
}

fn fixture() -> (Arc<AppState>, Arc<CountingProvider>) {
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("openai");
    config.routing.fallback_chain = vec![ProviderId::from("openai")];
    config.routing.modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: ProviderKind::OpenAi.into(),
            model: Some("test-image".to_owned()),
        },
    );
    config.providers.openai = Some(
        serde_json::from_value(json!({"api_key":"test-key","base_url":"http://127.0.0.1:1/v1"}))
            .unwrap(),
    );
    config.firewall = FirewallConfig {
        enabled: false,
        ..FirewallConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    let provider = Arc::new(CountingProvider::default());
    state.provider_runtime.register_for_test(provider.clone());
    (Arc::new(state), provider)
}

/// A request context for a key with a 100-token lifetime cap.
fn capped_ctx(downgrade_to: Option<&str>) -> RequestContext {
    let mut ctx = super::super::test_support::plain_request_context();
    ctx.key_config = Some(ApiKeyConfig {
        key: ctx.api_key.clone(),
        name: "capped".to_owned(),
        allowed_operations: vec![ApiKeyOperation::Inference],
        org_id: None,
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: Some(100),
        downgrade_to: downgrade_to.map(str::to_owned),
        trusted_forwarder: false,
    });
    ctx
}

fn chat() -> Value {
    json!({ "model": "premium", "messages": [{ "role": "user", "content": "hi" }] })
}

fn image() -> Value {
    json!({ "model": "test-image", "prompt": "a cat" })
}

#[tokio::test]
async fn a_stream_is_refused_once_the_coordinator_reports_the_shared_budget_spent() {
    let (state, provider) = fixture();
    run_stream(Arc::clone(&state), capped_ctx(None), chat())
        .await
        .expect("an under-budget stream dispatches");
    assert_eq!(provider.models().len(), 1);

    state.shared_budget.set_shared_exceeded(true);
    let result = run_stream(Arc::clone(&state), capped_ctx(None), chat()).await;
    assert!(matches!(result, Err(GatewayError::BudgetExceeded(None))));
    assert_eq!(
        provider.models().len(),
        1,
        "no upstream call after the verdict"
    );
}

#[tokio::test]
async fn a_stream_is_refused_once_the_keys_lifetime_tokens_are_spent() {
    let (state, provider) = fixture();
    let ctx = capped_ctx(None);
    state.audit.add_tokens(&ctx.api_key, 100);
    let result = run_stream(Arc::clone(&state), ctx, chat()).await;
    assert!(matches!(result, Err(GatewayError::BudgetExceeded(None))));
    assert!(provider.models().is_empty());
}

#[tokio::test]
async fn a_stream_over_its_lifetime_cap_is_downgraded_when_the_key_names_a_model() {
    let (state, provider) = fixture();
    let ctx = capped_ctx(Some("cheap"));
    state.audit.add_tokens(&ctx.api_key, 100);
    run_stream(Arc::clone(&state), ctx, chat())
        .await
        .expect("a downgraded stream still dispatches");
    assert_eq!(provider.models(), vec!["cheap".to_owned()]);
}

#[tokio::test]
async fn media_is_refused_by_the_shared_budget_and_the_lifetime_cap() {
    let (state, provider) = fixture();
    let _ = run_multimodal(
        Arc::clone(&state),
        capped_ctx(None),
        image(),
        Modality::Image,
    )
    .await;
    assert_eq!(
        provider.models().len(),
        1,
        "an under-budget image dispatches"
    );

    state.shared_budget.set_shared_exceeded(true);
    let shared = run_multimodal(
        Arc::clone(&state),
        capped_ctx(None),
        image(),
        Modality::Image,
    )
    .await;
    assert!(matches!(shared, Err(GatewayError::BudgetExceeded(None))));
    state.shared_budget.set_shared_exceeded(false);

    let ctx = capped_ctx(None);
    state.audit.add_tokens(&ctx.api_key, 100);
    let lifetime = run_multimodal(Arc::clone(&state), ctx, image(), Modality::Image).await;
    assert!(matches!(lifetime, Err(GatewayError::BudgetExceeded(None))));
    assert_eq!(provider.models().len(), 1, "no upstream call once refused");
}

#[tokio::test]
async fn media_over_its_lifetime_cap_is_refused_not_downgraded_to_a_chat_model() {
    let (state, provider) = fixture();
    let ctx = capped_ctx(Some("cheap"));
    state.audit.add_tokens(&ctx.api_key, 100);
    let result = run_multimodal(Arc::clone(&state), ctx, image(), Modality::Image).await;
    assert!(matches!(result, Err(GatewayError::BudgetExceeded(None))));
    assert!(
        provider.models().is_empty(),
        "no upstream call once refused"
    );
}

#[test]
fn a_sub_call_is_not_refused_again_by_the_lifetime_cap() {
    let (state, _provider) = fixture();
    let ctx = capped_ctx(None);
    state.audit.add_tokens(&ctx.api_key, 100);
    let mut decision = RouteDecision {
        provider: ProviderId::from("openai"),
        model: "premium".to_owned(),
    };
    let mut body = chat();
    let top = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    );
    assert!(matches!(top, Err(GatewayError::BudgetExceeded(None))));
    enforce_sub_call_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )
    .expect("the parent request owns the lifetime check");
}
