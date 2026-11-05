//! Ryu Gateway firewall **scanning core** — the pure regex detection engine.
//!
//! Extracted from `apps/gateway/src/firewall/mod.rs` (decomposition: gateway
//! stage scanner). This crate holds everything with **no dependency on the
//! gateway pipeline's shared `AppState`** or the config cascade: the curated
//! PII / secret / injection / code-injection / toxicity / bias pattern
//! builders, the Unicode-obfuscation normalization pre-pass, the Luhn /
//! credit-card / public-IPv4 post-match validators, and the `DetectionKind` /
//! `FirewallMatch` scan types. The command-injection scanner lives in
//! [`cmdscan`].
//!
//! The wiring that consumes this engine — `FirewallScanner` (which holds
//! `FirewallConfig`, dragging in the alert/inspector/evaluator config cascade),
//! the `FirewallBackend` trait impl, and the `FirewallRegistry` — stays in
//! `apps/gateway/src/firewall/`. This is the same "engine moves, wiring stays"
//! cut the extracted core crates use.

pub mod cmdscan;
mod confusables;
mod leak_patterns;
mod normalize;
mod patterns;
mod protective;
pub mod taxonomy;
mod validators;

pub use leak_patterns::{
    ascii_boundaries_agree, build_outbound_patterns, build_outbound_patterns_with_twins,
    build_pii_patterns, build_pii_patterns_with_twins, build_secret_patterns, Twinned,
    EITHER_BOUNDARY,
};
pub use normalize::{fold_digit, fold_for_redaction, normalize_for_scan};
pub use patterns::{
    build_bias_patterns, build_code_injection_patterns, build_injection_patterns,
    build_toxicity_patterns,
};
pub use protective::is_protective_instruction_clause;
pub use taxonomy::TaxonomyId;
pub use validators::{is_credit_card_number, is_public_ipv4};

/// A pattern match found in text.
#[derive(Debug, Clone)]
pub struct FirewallMatch {
    pub kind: DetectionKind,
    pub pattern_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DetectionKind {
    Pii,
    Secret,
    PromptInjection,
    /// Toxic / hateful / harassing language (lexical seed; the real judgment is
    /// the `toxicity` evaluator's LLM-judge path).
    Toxicity,
    /// Unfair bias / identity-attack markers (lexical seed; real judgment is the
    /// `bias_fairness` LLM-judge path).
    Bias,
    /// Code-injection payloads (eval/exec/system/subprocess/rm -rf/`<script>`/SQLi).
    CodeInjection,
    /// Explicit imagery — a label only; image judging is not regex-based and is
    /// not enforced this phase (see the multimodal hook).
    ExplicitImage,
    /// Sensitive/graphic imagery — a label only (see `ExplicitImage`).
    SensitiveImage,
    /// A hazard code from a classifier backend (spec 02.6.1 T2), carrying the
    /// shared taxonomy id such as `hazard.S9`.
    Hazard(TaxonomyId),
    /// A prompt attack found by a classifier backend (spec 02.6.1 T1). Distinct
    /// from `PromptInjection`, which is the lexical seed.
    PromptAttack,
}

impl DetectionKind {
    /// Stable snake_case label for audit/logging and the firewall-check surface.
    pub fn as_str(&self) -> &'static str {
        match self {
            DetectionKind::Pii => "pii",
            DetectionKind::Secret => "secret",
            DetectionKind::PromptInjection => "prompt_injection",
            DetectionKind::Toxicity => "toxicity",
            DetectionKind::Bias => "bias",
            DetectionKind::CodeInjection => "code_injection",
            DetectionKind::ExplicitImage => "explicit_image",
            DetectionKind::SensitiveImage => "sensitive_image",
            DetectionKind::Hazard(id) => id.as_str(),
            DetectionKind::PromptAttack => "prompt_attack",
        }
    }
}

#[cfg(test)]
mod normalize_compat_tests;
#[cfg(test)]
mod normalize_tests;
#[cfg(test)]
mod tests;
