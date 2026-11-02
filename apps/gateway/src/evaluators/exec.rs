//! Deterministic evaluator execution shared by the inline guardrail bridge,
//! the offline dataset runner, and the online production scorer.
//!
//! * [`builtin_detection_kind`] maps an [`super::EvaluatorImpl::Builtin`]
//!   detector name to the firewall's curated detector of the same kind, so a
//!   `builtin` evaluator runs the exact patterns the firewall enforces.
//! * [`custom_regex_match`] runs a user-authored regex evaluator's patterns
//!   with a compile-size ceiling and a small compiled-pattern cache, so custom
//!   regex evaluators execute inline instead of being skipped. Like the
//!   firewall, it also scans the Unicode-normalized view of the text.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use regex::{Regex, RegexBuilder};

use crate::config::FirewallConfig;
use crate::firewall::{DetectionKind, FirewallScanner};

/// Named builtin detectors, in documentation order.
pub const BUILTIN_DETECTORS: &[&str] = &[
    "pii",
    "secret",
    "prompt_injection",
    "code_injection",
    "toxicity",
    "bias",
];

/// Resolve a builtin detector name (case-insensitive, `-` or `_`) to the
/// firewall detection kind that implements it.
pub fn builtin_detection_kind(detector: &str) -> Option<DetectionKind> {
    match detector
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "pii" | "pii_leakage" => Some(DetectionKind::Pii),
        "secret" | "secrets" => Some(DetectionKind::Secret),
        "prompt_injection" | "injection" => Some(DetectionKind::PromptInjection),
        "code_injection" => Some(DetectionKind::CodeInjection),
        "toxicity" => Some(DetectionKind::Toxicity),
        "bias" | "bias_fairness" => Some(DetectionKind::Bias),
        _ => None,
    }
}

/// The firewall's curated detectors with default configuration. Used where no
/// per-request resolved scanner exists (offline/online scoring). Scoped, so it
/// never touches the node scanner's process-global flags.
fn default_scanner() -> &'static FirewallScanner {
    static SCANNER: OnceLock<FirewallScanner> = OnceLock::new();
    SCANNER.get_or_init(|| FirewallScanner::new_scoped(FirewallConfig::default()))
}

/// Run a builtin detector over `text` with `scanner` (or the default curated
/// scanner). `Err` when the detector name is unknown; `Ok(Some(reason))` when
/// it flagged.
pub fn run_builtin_detector(
    detector: &str,
    text: &str,
    scanner: Option<&FirewallScanner>,
) -> Result<Option<String>, String> {
    let kind = builtin_detection_kind(detector).ok_or_else(|| {
        format!(
            "unknown builtin detector '{detector}' (expected one of: {})",
            BUILTIN_DETECTORS.join(", ")
        )
    })?;
    let scanner: &FirewallScanner = match scanner {
        Some(scanner) => scanner,
        None => default_scanner(),
    };
    Ok(scanner
        .scan_kind(text, kind)
        .map(|found| format!("{}:{}", found.kind.as_str(), found.pattern_name)))
}

/// Compiled-program ceiling for a user-authored evaluator pattern (matches the
/// firewall's custom-pattern posture: no exponential compile blow-up).
const CUSTOM_PATTERN_SIZE_LIMIT: usize = 1 << 20;
const CUSTOM_PATTERN_CACHE_MAX: usize = 512;

fn compile_cached(pattern: &str) -> Option<Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(compiled) = cache.get(pattern) {
        return compiled.clone();
    }
    let compiled = RegexBuilder::new(pattern)
        .size_limit(CUSTOM_PATTERN_SIZE_LIMIT)
        .build()
        .ok();
    if cache.len() >= CUSTOM_PATTERN_CACHE_MAX {
        cache.clear();
    }
    cache.insert(pattern.to_owned(), compiled.clone());
    compiled
}

/// First pattern in `patterns` that matches `text` or its
/// [`ryu_gw_firewall::normalize_for_scan`] view, the same folded view the
/// firewall's curated and custom patterns scan. Zero-width splits, fullwidth
/// or lookalike characters, dash variants, native-script digits and TAG
/// characters therefore cannot hide a match; the raw text is still tried so a
/// pattern written for non-ASCII text keeps matching. Invalid or oversized
/// patterns are skipped, never fatal.
pub fn custom_regex_match<'a>(patterns: &'a [String], text: &str) -> Option<&'a str> {
    let normalized = ryu_gw_firewall::normalize_for_scan(text);
    let folded = matches!(normalized, std::borrow::Cow::Owned(_)).then_some(normalized.as_ref());
    patterns
        .iter()
        .find(|pattern| {
            compile_cached(pattern)
                .is_some_and(|re| re.is_match(text) || folded.is_some_and(|hay| re.is_match(hay)))
        })
        .map(String::as_str)
}

/// Whether every pattern compiles within the size ceiling.
pub fn validate_custom_patterns(patterns: &[String]) -> Result<(), String> {
    for pattern in patterns {
        if compile_cached(pattern).is_none() {
            return Err(format!("invalid or oversized regex pattern: {pattern}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_names_resolve_to_firewall_kinds() {
        for name in BUILTIN_DETECTORS {
            assert!(builtin_detection_kind(name).is_some(), "{name}");
        }
        assert_eq!(
            builtin_detection_kind("Secrets"),
            Some(DetectionKind::Secret)
        );
        assert_eq!(
            builtin_detection_kind("prompt-injection"),
            Some(DetectionKind::PromptInjection)
        );
        assert!(builtin_detection_kind("nope").is_none());
    }

    #[test]
    fn builtin_detector_runs_curated_patterns() {
        let flagged = run_builtin_detector("pii", "mail me at jane@example.com", None)
            .expect("known detector");
        assert!(flagged.is_some_and(|reason| reason.starts_with("pii:")));
        assert_eq!(
            run_builtin_detector("pii", "nothing personal here", None).expect("known"),
            None
        );
        let secret = run_builtin_detector("secret", "key sk-abcdefghijklmnopqrstuvwxyz0123", None)
            .expect("known");
        assert!(secret.is_some());
        assert!(run_builtin_detector("unknown", "x", None).is_err());
    }

    #[test]
    fn custom_regex_matches_and_skips_invalid_patterns() {
        let patterns = vec!["(".to_owned(), r"(?i)\bforbidden\b".to_owned()];
        assert_eq!(
            custom_regex_match(&patterns, "a FORBIDDEN word"),
            Some(r"(?i)\bforbidden\b")
        );
        assert_eq!(custom_regex_match(&patterns, "fine"), None);
        assert!(validate_custom_patterns(&patterns).is_err());
        assert!(validate_custom_patterns(&patterns[1..]).is_ok());
        assert!(validate_custom_patterns(&["a{1000}{1000}".to_owned()]).is_err());
    }

    /// Obfuscation the firewall folds cannot hide a custom-pattern match.
    #[test]
    fn custom_regex_matches_the_normalized_view() {
        let patterns = vec![r"\bPROJ-\d{4}\b".to_owned()];
        for text in [
            "PROJ\u{200B}-1234",
            "\u{FF30}\u{FF32}\u{FF2F}\u{FF2A}-\u{FF11}\u{FF12}\u{FF13}\u{FF14}",
            "PROJ\u{2011}1234",
            "PROJ-\u{0661}\u{0662}\u{0663}\u{0664}",
        ] {
            assert_eq!(
                custom_regex_match(&patterns, text),
                Some(r"\bPROJ-\d{4}\b"),
                "{text}"
            );
        }
        assert_eq!(custom_regex_match(&patterns, "PROJ-12"), None);
        // A pattern written for non-ASCII text still matches the raw text.
        let native = vec!["\u{FF30}\u{FF32}\u{FF2F}\u{FF2A}".to_owned()];
        assert!(custom_regex_match(&native, "\u{FF30}\u{FF32}\u{FF2F}\u{FF2A}").is_some());
    }
}
