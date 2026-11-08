//! [`AliasedProvider`]: one provider impl re-exposed under a second registry id.

use super::*;

/// A provider re-exposed under a registry id that differs from its own
/// [`Provider::name`].
///
/// Needed because one impl can back two registry slots: the classify tier speaks
/// the same OpenAI-compatible dialect as the resident local engine and so reuses
/// [`LocalProvider`], whose `name()` is the hardcoded `"local"`. Registering that
/// instance by name would *replace* the chat engine outright â€” and even keyed
/// correctly, the pipeline attributes metrics, admission slots and circuit-breaker
/// state by `provider.name()` (`pipeline/mod.rs`), so a bare alias would book a
/// classify-sidecar failure against `local` and trip the breaker on the user's
/// chat model. Overriding `name()` keeps the two tiers isolated end to end.
///
/// Every other trait method forwards verbatim, including the ones with default
/// bodies: those defaults are phrased in terms of `self.name()`, so forwarding
/// (rather than inheriting) keeps the inner provider's real capabilities and its
/// own error wording intact.
pub(super) struct AliasedProvider {
    pub(super) id: &'static str,
    pub(super) inner: Arc<dyn Provider>,
}

impl Provider for AliasedProvider {
    fn configure_account_policies(&self, policies: &[ryu_gw_providers::ProviderAccountPolicy]) {
        self.inner.configure_account_policies(policies);
    }

    fn configure_account_strategy(&self, strategy: ryu_gw_providers::AccountSelectionStrategy) {
        self.inner.configure_account_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.inner.configure_fill_first_drain_percent(percent);
    }

    fn name(&self) -> &'static str {
        self.id
    }

    fn has_rotating_accounts(&self) -> bool {
        self.inner.has_rotating_accounts()
    }

    fn discover_models<'a>(
        &'a self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Option<Vec<serde_json::Value>>> + Send + 'a>,
    > {
        self.inner.discover_models()
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete(model, body)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_for_session(model, body, session)
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_stream(model, body)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.complete_stream_for_session(model, body, session)
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.embed(model, body)
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.rerank(model, body)
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.generate_image(model, body)
    }

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.synthesize_speech(model, body)
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        self.inner.transcribe_audio(model, body)
    }

    fn submit_video_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        ryu_gw_providers::AcceptedVideo,
                        ryu_gw_providers::ProviderError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        self.inner.submit_video_bound(model, body)
    }

    fn submit_media_job_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a serde_json::Value,
        kind: ryu_gw_providers::MediaJobKind,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        ryu_gw_providers::AcceptedMediaJob,
                        ryu_gw_providers::ProviderError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        // Forward explicitly: the trait default would answer audio with a
        // refusal on behalf of this wrapper instead of asking the provider.
        self.inner.submit_media_job_bound(model, body, kind)
    }
}
