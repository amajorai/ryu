//! Turns a failed direct-pipeline run into a localized chat reply.
//!
//! The Gateway's own error text is English and can carry provider or internal
//! detail (upstream bodies, provider names), so it never reaches the chat: the
//! caller logs it, and the user gets one whole localized sentence. A few kinds
//! the user can act on (wait, ask the owner for budget, credits or a provider)
//! get their own sentence; everything else gets the generic failure.
//!
//! A host can keep the kind typed by attaching a [`PipelineFailure`] to the
//! error (`err.context(PipelineFailure::RateLimited)`). A host that flattens
//! the Gateway error into its `Display` text is still classified by the
//! Gateway's stable `GatewayError` messages.

use std::fmt;

use crate::i18n::{self, messages, Template};

/// The user-actionable kinds of a failed pipeline run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineFailure {
    /// A gateway, new-key or upstream provider rate limit refused the turn.
    RateLimited,
    /// A charged-spend budget is used up.
    BudgetExceeded,
    /// The managed credit balance is empty.
    InsufficientCredits,
    /// No configured provider serves `model`.
    NoProvider { model: String },
}

impl fmt::Display for PipelineFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RateLimited => f.write_str("Rate limit exceeded"),
            Self::BudgetExceeded => f.write_str("Budget exceeded"),
            Self::InsufficientCredits => f.write_str("Insufficient credits"),
            Self::NoProvider { model } => write!(f, "No provider available for model: {model}"),
        }
    }
}

impl std::error::Error for PipelineFailure {}

/// `GatewayError` `Display` prefix for "no provider for this model".
const NO_PROVIDER_PREFIX: &str = "No provider available for model: ";

/// Classify one error message by the Gateway's stable `GatewayError` text.
fn classify_message(message: &str) -> Option<PipelineFailure> {
    let message = message.trim();
    if let Some(model) = message.strip_prefix(NO_PROVIDER_PREFIX) {
        let model = model.trim();
        return (!model.is_empty()).then(|| PipelineFailure::NoProvider {
            model: model.to_owned(),
        });
    }
    if message == "Rate limit exceeded"
        || message == "New key rate limited"
        || message.starts_with("Provider rate limited: ")
    {
        return Some(PipelineFailure::RateLimited);
    }
    match message {
        "Budget exceeded" => Some(PipelineFailure::BudgetExceeded),
        "Insufficient credits" => Some(PipelineFailure::InsufficientCredits),
        _ => None,
    }
}

/// The actionable kind of `err`, if any: a typed [`PipelineFailure`] anywhere
/// in the chain wins, then the outermost message the Gateway text matches.
pub fn classify(err: &anyhow::Error) -> Option<PipelineFailure> {
    if let Some(kind) = err
        .chain()
        .find_map(|cause| cause.downcast_ref::<PipelineFailure>())
    {
        return Some(kind.clone());
    }
    err.chain()
        .find_map(|cause| classify_message(&cause.to_string()))
}

/// The localized reply for a failed pipeline run. Never contains `err`'s text
/// beyond the model id of a [`PipelineFailure::NoProvider`].
pub fn failure_reply(locale: &str, err: &anyhow::Error) -> String {
    let (template, model): (Template, Option<String>) = match classify(err) {
        Some(PipelineFailure::RateLimited) => (messages::TURN_RATE_LIMITED_MESSAGE, None),
        Some(PipelineFailure::BudgetExceeded) => (messages::TURN_BUDGET_EXCEEDED_MESSAGE, None),
        Some(PipelineFailure::InsufficientCredits) => (messages::TURN_NO_CREDITS_MESSAGE, None),
        Some(PipelineFailure::NoProvider { model }) => {
            (messages::TURN_NO_PROVIDER_MESSAGE, Some(model))
        }
        None => (messages::TURN_FAILED_MESSAGE, None),
    };
    match model {
        Some(model) => i18n::render(locale, template, &[("model", &model)]),
        None => i18n::render(locale, template, &[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::tests::with_translation;

    fn flattened(text: &str) -> anyhow::Error {
        // What `apps/gateway`'s host does today: `anyhow!("{e}")`.
        anyhow::anyhow!("{text}")
    }

    #[test]
    fn gateway_error_texts_map_to_their_kind() {
        for text in [
            "Rate limit exceeded",
            "New key rate limited",
            "Provider rate limited: openai",
        ] {
            assert_eq!(
                classify(&flattened(text)),
                Some(PipelineFailure::RateLimited),
                "{text}"
            );
        }
        assert_eq!(
            classify(&flattened("Budget exceeded")),
            Some(PipelineFailure::BudgetExceeded)
        );
        assert_eq!(
            classify(&flattened("Insufficient credits")),
            Some(PipelineFailure::InsufficientCredits)
        );
        assert_eq!(
            classify(&flattened("No provider available for model: gpt-4o")),
            Some(PipelineFailure::NoProvider {
                model: "gpt-4o".into()
            })
        );
    }

    #[test]
    fn everything_else_is_unclassified() {
        for text in [
            "Provider error: upstream said Budget exceeded",
            "Provider rejected the request: invalid key",
            "Provider transport error: http://127.0.0.1:4100 refused",
            "Credit accounting unavailable",
            "Throttled by the abuse ladder",
            "No provider available for model: ",
            "",
        ] {
            assert_eq!(classify(&flattened(text)), None, "{text}");
        }
    }

    #[test]
    fn a_typed_kind_in_the_chain_wins_over_the_message() {
        let err = anyhow::Error::new(PipelineFailure::InsufficientCredits)
            .context("Provider error: something else");
        assert_eq!(classify(&err), Some(PipelineFailure::InsufficientCredits));
        let err = flattened("Provider error: raw").context(PipelineFailure::BudgetExceeded);
        assert_eq!(classify(&err), Some(PipelineFailure::BudgetExceeded));
    }

    #[test]
    fn each_kind_gets_its_own_english_sentence() {
        let reply = |text: &str| failure_reply("en", &flattened(text));
        assert_eq!(
            reply("Rate limit exceeded"),
            "Too many requests right now. Wait a moment, then try again."
        );
        assert!(reply("Budget exceeded").contains("spending limit"));
        assert!(reply("Insufficient credits").contains("out of credits"));
        assert_eq!(
            reply("No provider available for model: llama-3"),
            "No provider is available for the model llama-3. Ask the owner to check the Gateway's providers."
        );
        assert_eq!(
            reply("Provider error: secret upstream body"),
            "Sorry, something went wrong while running that request."
        );
    }

    #[test]
    fn a_german_reply_carries_no_english_gateway_text() {
        let cases: [(&str, Template, &str); 5] = [
            (
                "Rate limit exceeded",
                messages::TURN_RATE_LIMITED_MESSAGE,
                "Zu viele Anfragen.",
            ),
            (
                "Budget exceeded",
                messages::TURN_BUDGET_EXCEEDED_MESSAGE,
                "Ausgabenlimit erreicht.",
            ),
            (
                "Insufficient credits",
                messages::TURN_NO_CREDITS_MESSAGE,
                "Kein Guthaben mehr.",
            ),
            (
                "No provider available for model: m1",
                messages::TURN_NO_PROVIDER_MESSAGE,
                "Kein Anbieter für das Modell {model}.",
            ),
            (
                "Provider error: raw upstream text",
                messages::TURN_FAILED_MESSAGE,
                "Leider ist etwas schiefgelaufen.",
            ),
        ];
        for (_, template, translation) in &cases {
            with_translation("de", *template, translation);
        }
        for (text, _, _) in &cases {
            let reply = failure_reply("de", &flattened(text));
            assert!(!reply.contains(text), "{reply}");
            for english in [
                "Rate limit",
                "Budget",
                "credits",
                "provider",
                "Provider",
                "Sorry",
            ] {
                assert!(!reply.contains(english), "{reply}");
            }
        }
        assert_eq!(
            failure_reply("de", &flattened("No provider available for model: m1")),
            "Kein Anbieter für das Modell m1."
        );
    }

    #[test]
    fn japanese_and_arabic_replies_carry_no_gateway_text() {
        with_translation(
            "ja",
            messages::TURN_RATE_LIMITED_MESSAGE,
            "リクエストが多すぎます。少し待ってからもう一度お試しください。",
        );
        with_translation(
            "ja",
            messages::TURN_FAILED_MESSAGE,
            "申し訳ありません。リクエストの実行中に問題が発生しました。",
        );
        with_translation(
            "ar",
            messages::TURN_NO_PROVIDER_MESSAGE,
            "لا يتوفر موفّر للنموذج {model}.",
        );
        with_translation(
            "ar",
            messages::TURN_NO_CREDITS_MESSAGE,
            "نفد رصيد هذا المساعد.",
        );
        assert_eq!(
            failure_reply("ja-JP", &flattened("Provider rate limited: openai")),
            "リクエストが多すぎます。少し待ってからもう一度お試しください。"
        );
        let generic = failure_reply(
            "ja",
            &flattened("Provider transport error: http://10.0.0.5:4100 refused"),
        );
        assert_eq!(
            generic,
            "申し訳ありません。リクエストの実行中に問題が発生しました。"
        );
        assert!(!generic.contains("10.0.0.5"));
        assert_eq!(
            failure_reply("ar", &flattened("No provider available for model: m1")),
            "لا يتوفر موفّر للنموذج m1."
        );
        let credits = failure_reply("ar-EG", &flattened("Insufficient credits"));
        assert_eq!(credits, "نفد رصيد هذا المساعد.");
        assert!(!credits.is_ascii());
    }
}
