//! Swappable cheap-LLM traffic inspector — an opt-in detection *method* that runs
//! alongside the regex firewall scanner.
//!
//! The inspector asks a cheap model whether the inbound turn is a prompt
//! injection or leaks PII/secrets, then the pipeline applies the configured
//! [`crate::config::FirewallPolicy`] action to a flagged turn (Block / Sanitize /
//! Warn). The model is resolved through the normal [`ModelRouter`] so it stays
//! swappable, and it is called via [`crate::providers::Provider::complete`]
//! through the governed nonrecursive inference client, which preserves DLP,
//! model policy, rate limits, budgets and usage accounting.
//!
//! Provider availability failures retain the lexical backstop. A disabled config, a too-short turn, an unconfigured
//! provider, a provider error, a timeout, or an unparseable reply all resolve to
//! "not flagged" (allow), logging a warning. A cheap local model (e.g. Gemma)
//! emits dirty JSON, so the verdict is parsed defensively (first `{…}` block; on
//! any failure, allow). Runs **inbound only** in v1.

use serde_json::json;
use tracing::warn;

use crate::config::{InspectorConfig, InspectorMode};
use crate::{error::GatewayError, pipeline::inference_governance::InferenceClient};

/// Cap the text sent to the inspector so a huge paste stays cheap and bounded.
const MAX_INSPECT_CHARS: usize = 4000;

/// The inspector's structured verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct InspectorVerdict {
    /// Whether the turn was flagged as an injection / data-leak.
    pub flagged: bool,
    /// Category labels the model returned (e.g. `injection`, `pii`, `secret`).
    pub categories: Vec<String>,
    /// Short human-readable reason (for audit/logging).
    pub reason: String,
    /// Whether the judge actually produced a verdict (`true`) or this is a
    /// fail-open / skipped result (`false`: disabled, no provider, timeout,
    /// provider error, unparseable reply, too-short turn). Callers use this to
    /// decide whether to run a deterministic seed backstop: when the judge did NOT
    /// answer, the lexical seed is the only floor; when it DID answer (even
    /// `flagged=false`), its context judgment is trusted over the seed.
    pub available: bool,
}

impl InspectorVerdict {
    /// The fail-open / clean verdict: allow, nothing flagged, judge NOT available.
    pub fn allow() -> Self {
        Self {
            flagged: false,
            categories: Vec::new(),
            reason: String::new(),
            available: false,
        }
    }
}

/// Stateless entry point for the LLM inspector.
pub struct InspectorClient;

impl InspectorClient {
    pub async fn inspect(
        text: &str,
        cfg: &InspectorConfig,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        if !cfg.enabled || text.chars().count() < cfg.min_chars {
            return Ok(InspectorVerdict::allow());
        }
        run_inspection(
            &system_prompt(cfg.mode),
            text,
            &cfg.model,
            cfg.timeout_ms,
            inference,
            true,
        )
        .await
    }
    pub async fn inspect_rubric(
        text: &str,
        rubric: &str,
        model: &str,
        timeout_ms: u64,
        inference: &dyn InferenceClient,
    ) -> Result<InspectorVerdict, GatewayError> {
        if text.trim().is_empty() || rubric.trim().is_empty() {
            return Ok(InspectorVerdict::allow());
        }
        run_inspection(
            &rubric_system_prompt(rubric),
            text,
            model,
            timeout_ms,
            inference,
            false,
        )
        .await
    }
}

/// Provider failures retain the lexical backstop; governance errors propagate and cannot be
/// interpreted as a clean verdict. The client enforces DLP, budgets and accounting without recursion.
async fn run_inspection(
    system_prompt: &str,
    text: &str,
    model: &str,
    timeout_ms: u64,
    inference: &dyn InferenceClient,
    restrict_categories: bool,
) -> Result<InspectorVerdict, GatewayError> {
    let body = json!({"model":model,"messages":[{"role":"system","content":system_prompt},{"role":"user","content":truncate(text,MAX_INSPECT_CHARS)}],"temperature":0,"max_tokens":200,"stream":false});
    let Some(response) = inference.complete(model, body, timeout_ms).await? else {
        return Ok(InspectorVerdict::allow());
    };
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    Ok(
        parse_verdict_with_category_policy(content, restrict_categories).unwrap_or_else(|| {
            warn!(
                reply_len = content.len(),
                "inspector: unparseable verdict; using lexical backstop"
            );
            InspectorVerdict::allow()
        }),
    )
}

// The prompts, the parser and the category check live in the screening
// crate (`ryu_gw_screening::backends::inspector`), so the node-tier stage
// here and the floor-tier screener adapter share one prompt and one parser.
use ryu_gw_screening::backends::inspector as judge;

/// System prompt for an ad-hoc rubric judge. `flagged` is true only when the
/// rubric's bad condition clearly holds, matching the inline-guardrail semantics.
fn rubric_system_prompt(rubric: &str) -> String {
    judge::rubric_system_prompt(rubric)
}

/// The fixed system prompt asking for a strict JSON verdict, shaped by the mode.
fn system_prompt(mode: InspectorMode) -> String {
    judge::system_prompt(match mode {
        InspectorMode::Injection => judge::InspectorFocus::Injection,
        InspectorMode::Dlp => judge::InspectorFocus::Dlp,
        InspectorMode::Both => judge::InspectorFocus::Both,
    })
}

/// Parse the model's reply into a verdict (see [`judge::parse_verdict`]).
/// Returns `None` when no JSON object is present, so the caller fails open.
#[cfg_attr(not(test), allow(dead_code))]
fn parse_verdict(text: &str) -> Option<InspectorVerdict> {
    parse_verdict_with_category_policy(text, true)
}

/// A `flagged: true` verdict must name at least one of the categories the
/// system prompt declares. Gemma 3 270M, the shipped classify tier default,
/// returns topic words (`["party","birthday"]`) for benign turns, so a flagged
/// verdict with only out-of-vocabulary categories is treated as unparseable:
/// `available` stays false and the lexical seed remains the floor. A judge
/// that flags without naming any category is still trusted.
fn parse_verdict_with_category_policy(
    text: &str,
    restrict_categories: bool,
) -> Option<InspectorVerdict> {
    judge::parse_verdict(text, restrict_categories).map(|verdict| InspectorVerdict {
        flagged: verdict.flagged,
        categories: verdict.categories,
        reason: verdict.reason,
        // A parsed verdict means the judge answered: trust its context
        // judgment instead of the deterministic seed.
        available: true,
    })
}

/// The substring from the first `{` to the last `}` (inclusive).
#[cfg_attr(not(test), allow(dead_code))]
fn extract_json_object(s: &str) -> Option<&str> {
    judge::extract_json_object(s)
}

/// Truncate `s` to at most `max` chars on a char boundary.
fn truncate(s: &str, max: usize) -> &str {
    judge::truncate(s, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MissingInference;
    #[async_trait::async_trait]
    impl InferenceClient for MissingInference {
        fn scope(&self) -> String {
            "test".into()
        }
        async fn complete(
            &self,
            _model: &str,
            _body: serde_json::Value,
            _timeout: u64,
        ) -> Result<Option<serde_json::Value>, GatewayError> {
            Ok(None)
        }
        async fn embed(
            &self,
            _model: &str,
            _text: &str,
            _timeout: u64,
        ) -> Result<Option<Vec<f32>>, GatewayError> {
            Ok(None)
        }
    }
    fn empty_providers() -> MissingInference {
        MissingInference
    }

    #[test]
    fn disabled_config_allows() {
        let cfg = InspectorConfig::default(); // enabled = false
        let providers = empty_providers();
        let v = tokio_block(InspectorClient::inspect(
            "some long enough text to exceed the min_chars threshold easily here",
            &cfg,
            &providers,
        ));
        assert_eq!(v, InspectorVerdict::allow(), "disabled ⇒ allow");
    }

    #[test]
    fn short_turn_is_skipped() {
        let cfg = InspectorConfig {
            enabled: true,
            min_chars: 40,
            ..InspectorConfig::default()
        };
        let providers = empty_providers();
        let v = tokio_block(InspectorClient::inspect("hi", &cfg, &providers));
        assert!(!v.flagged, "sub-min_chars turn is skipped (allow)");
    }

    #[test]
    fn provider_missing_fails_open() {
        // enabled + long enough, but no provider is configured ⇒ allow.
        let cfg = InspectorConfig {
            enabled: true,
            model: "gpt-4o-mini".into(),
            min_chars: 5,
            ..InspectorConfig::default()
        };
        let providers = empty_providers();
        let v = tokio_block(InspectorClient::inspect(
            "this is a sufficiently long message to pass the min_chars gate",
            &cfg,
            &providers,
        ));
        assert!(!v.flagged, "no provider ⇒ fail open (allow)");
    }

    #[test]
    fn inspect_rubric_fails_open_without_provider() {
        // An enabled inline toxicity binding drives this path; with no provider
        // configured it must fail open (allow / not flagged), never hard-fail.
        let providers = empty_providers();
        let v = tokio_block(InspectorClient::inspect_rubric(
            "you are a worthless piece of garbage and everyone hates you",
            "Rate whether the response contains toxic, hateful, or harassing language.",
            "gpt-4o-mini",
            1500,
            &providers,
        ));
        assert!(!v.flagged, "no provider ⇒ fail open (allow)");
    }

    #[test]
    fn inspect_rubric_empty_inputs_allow() {
        let providers = empty_providers();
        assert!(
            !tokio_block(InspectorClient::inspect_rubric(
                "", "rubric", "m", 1500, &providers
            ))
            .flagged
        );
        assert!(
            !tokio_block(InspectorClient::inspect_rubric(
                "text", "", "m", 1500, &providers
            ))
            .flagged
        );
    }

    #[test]
    fn parse_verdict_reads_clean_json() {
        let v = parse_verdict(
            r#"{"flagged": true, "categories": ["injection"], "reason": "ignore prior"}"#,
        )
        .expect("clean json parses");
        assert!(v.flagged);
        assert_eq!(v.categories, vec!["injection"]);
    }

    /// The deny-all regression. These four replies are verbatim from Gemma 3
    /// 270M (the shipped classify-tier default) answering benign turns; each
    /// previously produced a 403 under the default `action: Block`.
    #[test]
    fn flagged_with_only_topic_categories_is_not_a_verdict() {
        for reply in [
            r#"{"flagged": true, "categories": ["party","birthday"]}"#,
            r#"{"flagged": true, "categories": ["chocolate chip cookies"]}"#,
            r#"{"flagged": true, "categories": ["roadmap"]}"#,
            r#"{"flagged": true, "categories": ["weather","holiday"]}"#,
        ] {
            assert!(
                parse_verdict(reply).is_none(),
                "topic-word categories must not block: {reply}"
            );
        }
    }

    /// The other half: real attacks still parse and still block. Verbatim
    /// replies from the same model on hostile turns.
    #[test]
    fn flagged_with_in_enum_categories_still_blocks() {
        for reply in [
            r#"{"flagged": true, "categories": ["injection","pii","secret"]}"#,
            r#"{"flagged": true, "categories": ["PII"], "reason": "ssn"}"#,
            r#"{"flagged": true, "categories": ["prompt-injection"]}"#,
            r#"{"flagged": true, "categories": ["pii_leakage"]}"#,
        ] {
            let v = parse_verdict(reply).expect("in-enum verdict parses");
            assert!(v.flagged && v.available, "must still flag: {reply}");
        }
    }

    #[test]
    fn rubric_verdicts_accept_rubric_owned_categories() {
        let reply = r#"{"flagged": true, "categories": ["toxicity"], "reason": "harassment"}"#;
        assert!(
            parse_verdict_with_category_policy(reply, false)
                .expect("rubric verdict parses")
                .flagged
        );
        assert!(
            parse_verdict_with_category_policy(reply, true).is_none(),
            "the built-in inspector vocabulary must remain strict"
        );
    }

    /// `flagged: false` needs no categories — only a *positive* claim made with
    /// a supplied-but-foreign vocabulary is rejected.
    #[test]
    fn clean_verdict_needs_no_categories() {
        let v = parse_verdict(r#"{"flagged": false, "categories": []}"#).expect("parses");
        assert!(!v.flagged);
        assert!(
            v.available,
            "the judge did answer; the seed must not override"
        );
        // A clean verdict may even carry topic words without being discarded —
        // the in-enum rule gates blocking, not allowing.
        let v = parse_verdict(r#"{"flagged": false, "categories": ["weather"]}"#).expect("parses");
        assert!(!v.flagged && v.available);
    }

    /// A terse judge that flags without categories is still trusted — the
    /// narrowing that keeps this fix from weakening well-behaved models.
    #[test]
    fn flagged_without_categories_is_still_a_block() {
        let v = parse_verdict(r#"{"flagged": true, "reason": "override attempt"}"#)
            .expect("terse verdict parses");
        assert!(v.flagged && v.available);
    }

    #[test]
    fn parse_verdict_extracts_from_dirty_reply() {
        // A cheap local model wraps JSON in a code fence + prose.
        let dirty = "Sure! Here is the result:\n```json\n{\"flagged\": false, \"reason\": \"clean\"}\n```\nHope that helps.";
        let v = parse_verdict(dirty).expect("dirty reply still parses");
        assert!(!v.flagged);
        assert_eq!(v.reason, "clean");
    }

    #[test]
    fn verdict_available_distinguishes_judge_answer_from_fail_open() {
        // A parsed verdict (the judge answered) is marked available…
        let answered =
            parse_verdict(r#"{"flagged": false, "reason": "clean"}"#).expect("clean json parses");
        assert!(
            answered.available,
            "a parsed verdict means the judge answered"
        );
        // …while every fail-open/allow path is NOT available, so the caller runs
        // its deterministic seed backstop only when the judge did not answer.
        assert!(!InspectorVerdict::allow().available);
    }

    #[test]
    fn parse_verdict_partial_object_defaults() {
        let v = parse_verdict(r#"{"flagged": true}"#).expect("partial parses via defaults");
        assert!(v.flagged);
        assert!(v.categories.is_empty());
        assert_eq!(v.reason, "");
    }

    #[test]
    fn parse_verdict_none_on_no_json() {
        assert!(parse_verdict("no json here at all").is_none());
        assert!(parse_verdict("").is_none());
    }

    #[test]
    fn extract_json_object_handles_fences_and_prose() {
        assert_eq!(extract_json_object("x {\"a\":1} y"), Some("{\"a\":1}"));
        assert_eq!(extract_json_object("no braces"), None);
        assert_eq!(extract_json_object("}{"), None); // mis-ordered
    }

    /// Minimal current-thread executor so the fail-open paths (which never
    /// actually await a provider) can be exercised without a full runtime.
    fn tokio_block<F, T>(fut: F) -> T
    where
        F: std::future::Future<Output = Result<T, GatewayError>>,
    {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
            .block_on(fut)
            .expect("inspection succeeds")
    }
}
