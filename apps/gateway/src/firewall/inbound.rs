//! Inbound screening for the built-in [`FirewallScanner`]: the prompt scan and
//! the locked-guardrail scan.
//!
//! Both fold the text once and reuse the hays for every category. A clean
//! prompt is the common case, and the per-pattern loop only returns early on a
//! hit, so a clean prompt used to pay one regex pass per pattern (24 for the
//! curated lists) and one fold per category. The curated sets answer "can any
//! pattern of this category match" in one pass. A set member matches exactly
//! where its `Regex` does, and the validators in `find_match_in` only ever
//! reject matches, so a set miss on every hay means the category's loop
//! returns `None`. On a set hit the ordered per-pattern loop runs as before,
//! so priority order, the protective-clause check and the card and IPv4
//! validators are unchanged. A scanner with a custom pattern in a category has
//! no set for it and always runs the loop.

use regex::{Regex, RegexSet};
use ryu_gw_firewall::normalize_for_scan;
use tracing::warn;

use super::scanner::hays_of;
use super::{DetectionKind, FirewallMatch, FirewallScanner};

/// Whether `set` exists and matches none of `hays`.
fn misses(set: Option<&RegexSet>, hays: &[&str]) -> bool {
    set.is_some_and(|set| hays.iter().all(|hay| !set.is_match(hay)))
}

impl FirewallScanner {
    /// One category: the ordered per-pattern loop, skipped when the category's
    /// set proves the loop would find nothing.
    fn scan_category(
        &self,
        hays: &[&str],
        patterns: &[(String, Regex)],
        kind: DetectionKind,
        set: Option<&RegexSet>,
    ) -> Option<FirewallMatch> {
        if misses(set, hays) {
            debug_assert!(self.find_match_in(hays, patterns, kind).is_none());
            return None;
        }
        self.find_match_in(hays, patterns, kind)
    }

    /// Whether the secrets plus PII set proves both loops would find nothing.
    fn no_leak(&self, hays: &[&str]) -> bool {
        let none = misses(self.scan_set, hays);
        debug_assert!(
            !none
                || (self
                    .find_match_in(hays, &self.secret_patterns, DetectionKind::Secret)
                    .is_none()
                    && self
                        .find_match_in(hays, &self.pii_patterns, DetectionKind::Pii)
                        .is_none())
        );
        none
    }

    /// Scan inbound prompt text. Returns the first violation found (if any).
    pub fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        if !self.config.enabled || !self.config.scan_inbound {
            return None;
        }
        // Fold trivial Unicode obfuscation once; every category reads the
        // same hays (see `find_match`).
        let normalized = normalize_for_scan(text);
        let (hays, count) = hays_of(text, &normalized);
        let hays = &hays[..count];

        // Check injection first (highest priority)
        if let Some(m) = self.scan_category(
            hays,
            &self.injection_patterns,
            DetectionKind::PromptInjection,
            self.injection_set,
        ) {
            if self.config.log_detections {
                warn!(kind = "prompt_injection", pattern = %m.pattern_name, "Firewall: prompt injection detected in inbound request");
            }
            return Some(m);
        }

        if self.no_leak(hays) {
            return None;
        }

        // Then secrets (credentials/keys). Scanned inbound so a request carrying a
        // bare secret is caught by the policy: under the default `Block` it is a
        // 403, under `Sanitize` it is redacted before egress (leak closed).
        // Higher severity than PII, so checked first.
        if let Some(m) = self.scan_category(
            hays,
            &self.secret_patterns,
            DetectionKind::Secret,
            self.secret_set,
        ) {
            if self.config.log_detections {
                warn!(kind = "secret", pattern = %m.pattern_name, "Firewall: secret/credential detected in inbound request");
            }
            return Some(m);
        }

        // Then PII
        if let Some(m) = self.find_match_in(hays, &self.pii_patterns, DetectionKind::Pii) {
            if self.config.log_detections {
                warn!(kind = "pii", pattern = %m.pattern_name, "Firewall: PII detected in inbound request");
            }
            return Some(m);
        }

        None
    }

    /// Scan inbound text for a specific set of locked guardrails, ignoring the
    /// local `enabled`/`scan_inbound` config. Used to honour control-plane
    /// locked guardrails (U28): the org can require "pii"/"secrets"/
    /// "prompt_injection" scanning even when local config disabled the firewall,
    /// so a lower level cannot bypass an admin-locked guardrail.
    pub fn scan_locked_guardrails(
        &self,
        text: &str,
        guardrails: &[String],
    ) -> Option<FirewallMatch> {
        let wants = |name: &str| guardrails.iter().any(|g| g.eq_ignore_ascii_case(name));
        let normalized = normalize_for_scan(text);
        let (hays, count) = hays_of(text, &normalized);
        let hays = &hays[..count];

        if wants("prompt_injection") || wants("injection") {
            if let Some(m) = self.scan_category(
                hays,
                &self.injection_patterns,
                DetectionKind::PromptInjection,
                self.injection_set,
            ) {
                return Some(m);
            }
        }
        let wants_pii = wants("pii");
        let wants_secret = wants("secret") || wants("secrets");
        if (wants_pii || wants_secret) && !self.no_leak(hays) {
            if wants_pii {
                if let Some(m) = self.find_match_in(hays, &self.pii_patterns, DetectionKind::Pii) {
                    return Some(m);
                }
            }
            if wants_secret {
                if let Some(m) = self.scan_category(
                    hays,
                    &self.secret_patterns,
                    DetectionKind::Secret,
                    self.secret_set,
                ) {
                    return Some(m);
                }
            }
        }
        if wants("toxicity") || wants("moderation") {
            if let Some(m) =
                self.find_match_in(hays, &self.toxicity_patterns, DetectionKind::Toxicity)
            {
                return Some(m);
            }
        }
        if wants("bias") || wants("bias_fairness") {
            if let Some(m) = self.find_match_in(hays, &self.bias_patterns, DetectionKind::Bias) {
                return Some(m);
            }
        }
        if wants("code_injection") {
            if let Some(m) = self.find_match_in(
                hays,
                &self.code_injection_patterns,
                DetectionKind::CodeInjection,
            ) {
                return Some(m);
            }
        }
        None
    }
}

#[cfg(test)]
#[path = "inbound_test.rs"]
mod tests;
