use regex::Regex;
use tracing::warn;

use crate::config::{CustomPatternKind, FirewallConfig, FirewallPolicy};

// The pure regex detection engine — the curated pattern builders, the
// `DetectionKind` / `FirewallMatch` scan types, the Unicode-normalization
// pre-pass, and the Luhn / credit-card / public-IPv4 validators — plus the
// command-injection scanner were extracted to the `ryu-gw-firewall` crate
// ("engine moves, wiring stays"). `FirewallScanner`, `FirewallBackend`, and
// `FirewallRegistry` (which hold `FirewallConfig` and drive the alert/inspector/
// evaluator config cascade) stay here and consume the crate. `DetectionKind` /
// `FirewallMatch` are re-exported so existing `crate::firewall::…` paths
// (inline_eval, evaluators) resolve unchanged; the command scanner is re-exported
// as `crate::firewall::cmdscan`.
pub use ryu_gw_firewall::cmdscan;
use ryu_gw_firewall::{
    build_bias_patterns, build_code_injection_patterns, build_injection_patterns,
    build_outbound_patterns, build_pii_patterns, build_secret_patterns, build_toxicity_patterns,
    is_credit_card_number, is_protective_instruction_clause, is_public_ipv4, normalize_for_scan,
};
pub use ryu_gw_firewall::{DetectionKind, FirewallMatch};

/// The curated pattern sets, which are the same for every scanner. A scanner
/// built for a request that carries a node firewall overlay is never cached
/// (see `resolve::FirewallResolver::scanner_for_request`), so compiling these
/// per scanner recompiled every curated regex on each such request. Cloning a
/// compiled `Regex` shares its program instead of recompiling it.
struct CuratedPatterns {
    pii: Vec<(String, Regex)>,
    secret: Vec<(String, Regex)>,
    injection: Vec<(String, Regex)>,
    outbound: Vec<(&'static str, Regex)>,
    code_injection: Vec<(String, Regex)>,
    toxicity: Vec<(String, Regex)>,
    bias: Vec<(String, Regex)>,
}

fn curated_patterns() -> &'static CuratedPatterns {
    static CURATED: std::sync::OnceLock<CuratedPatterns> = std::sync::OnceLock::new();
    CURATED.get_or_init(|| CuratedPatterns {
        pii: build_pii_patterns(),
        secret: build_secret_patterns(),
        injection: build_injection_patterns(),
        outbound: build_outbound_patterns(),
        code_injection: build_code_injection_patterns(),
        toxicity: build_toxicity_patterns(),
        bias: build_bias_patterns(),
    })
}

pub mod inspector;
pub mod resolve;

/// Compiled-size ceiling for a caller-supplied custom pattern, in bytes of DFA
/// program. The `regex` crate is backtracking-free, so a custom pattern cannot
/// cause catastrophic *matching* blow-up — but bounded repetition still expands
/// at COMPILE time, and `a{1000}{1000}` compiles to a program measured in
/// gigabytes. That was harmless while patterns only ever came from node/org
/// config; it stops being harmless now that the request scope
/// (`x-ryu-node-routing`) lets a bearer supply them. 1 MiB is roughly two orders
/// of magnitude above what the curated pattern set needs, so no legitimate
/// pattern notices the bound; one over it is skipped with a warning like any
/// other invalid regex, which never disables the rest of the firewall.
const CUSTOM_PATTERN_SIZE_LIMIT: usize = 1 << 20;

/// Compile one caller-supplied pattern under [`CUSTOM_PATTERN_SIZE_LIMIT`].
fn compile_custom_pattern(pattern: &str) -> Result<Regex, regex::Error> {
    regex::RegexBuilder::new(pattern)
        .size_limit(CUSTOM_PATTERN_SIZE_LIMIT)
        .build()
}

/// Whether [`FirewallScanner`] would keep `pattern` rather than skip it with a
/// warning. The platform floor uses it to reject a floor it could only apply
/// in part.
pub(crate) fn custom_pattern_compiles(pattern: &crate::config::CustomPattern) -> bool {
    !pattern.name.trim().is_empty()
        && !pattern.regex.trim().is_empty()
        && compile_custom_pattern(&pattern.regex).is_ok()
}

pub struct FirewallScanner {
    config: FirewallConfig,
    pii_patterns: Vec<(String, Regex)>,
    secret_patterns: Vec<(String, Regex)>,
    injection_patterns: Vec<(String, Regex)>,
    outbound_patterns: Vec<(&'static str, Regex)>,
    /// Code-injection payload patterns (unified-evaluator `code_injection`).
    code_injection_patterns: Vec<(String, Regex)>,
    /// Lexical toxicity seed (unified-evaluator `toxicity`; the real judgment is
    /// the LLM-judge path, this catches obvious cases deterministically).
    toxicity_patterns: Vec<(String, Regex)>,
    /// Lexical bias / identity-attack seed (unified-evaluator `bias_fairness`).
    bias_patterns: Vec<(String, Regex)>,
}

impl FirewallScanner {
    /// Build the **node-level** scanner. Besides compiling the pattern sets this
    /// seeds the process-global untrusted-content wrapping flag from
    /// `config.wrap_untrusted_tool_results` (see the note in [`Self::build`]), so
    /// it must only be used for the node base config (startup + `PUT /v1/config`).
    /// Per-agent *resolved* scanners use [`Self::new_scoped`], which skips that
    /// side effect.
    pub fn new(config: FirewallConfig) -> Self {
        // The single chokepoint that owns the process-global wrap flag: only the
        // node-base scanner may write it, so a per-agent overlay can never flip a
        // global read by the tool loop (cross-request contamination). See §3.
        crate::untrusted::set_enabled(config.wrap_untrusted_tool_results);
        Self::build(config)
    }

    /// Build a **scoped** (per-agent / per-org resolved) scanner WITHOUT touching
    /// the process-global untrusted-wrapping flag. The hierarchical resolver
    /// caches these; because the wrap flag is a node-level global, per-agent
    /// `wrap_untrusted_tool_results` overrides do not reach the tool loop in v1
    /// (the resolved inbound/locked/companion paths never consult it anyway).
    /// Since a per-scope override would thus be a silent no-op, the resolver
    /// force-strips that field (value + lock) from every org/agent overlay
    /// (`resolve::normalize_overlay`, FIX 2 / spec §10) — only the node base here
    /// ever sets it.
    pub fn new_scoped(config: FirewallConfig) -> Self {
        Self::build(config)
    }

    /// Shared constructor body: compile the curated + custom pattern sets. Does
    /// NOT touch the process-global wrap flag — only [`Self::new`] does.
    fn build(config: FirewallConfig) -> Self {
        let curated = curated_patterns();
        let mut pii_patterns = curated.pii.clone();
        let mut secret_patterns = curated.secret.clone();
        let mut injection_patterns = curated.injection.clone();
        let outbound_patterns = curated.outbound.clone();
        let mut code_injection_patterns = curated.code_injection.clone();
        let mut toxicity_patterns = curated.toxicity.clone();
        let mut bias_patterns = curated.bias.clone();

        // Merge user-defined patterns on top of the curated sets. A pattern that
        // fails to compile is skipped with a warning rather than dropping the
        // whole firewall config — one bad regex must never disable protection.
        for pat in &config.custom_patterns {
            let name = pat.name.trim();
            if name.is_empty() || pat.regex.trim().is_empty() {
                warn!("Firewall: skipping custom pattern with empty name or regex");
                continue;
            }
            match compile_custom_pattern(&pat.regex) {
                Ok(re) => {
                    let target = match pat.kind {
                        CustomPatternKind::Pii => &mut pii_patterns,
                        CustomPatternKind::Secret => &mut secret_patterns,
                        CustomPatternKind::PromptInjection => &mut injection_patterns,
                        CustomPatternKind::CodeInjection => &mut code_injection_patterns,
                        CustomPatternKind::Toxicity => &mut toxicity_patterns,
                        CustomPatternKind::Bias => &mut bias_patterns,
                    };
                    target.push((name.to_string(), re));
                }
                Err(e) => {
                    warn!(pattern = %name, error = %e, "Firewall: skipping invalid custom pattern regex");
                }
            }
        }

        Self {
            config,
            pii_patterns,
            secret_patterns,
            injection_patterns,
            outbound_patterns,
            code_injection_patterns,
            toxicity_patterns,
            bias_patterns,
        }
    }

    /// Return the current firewall config (used by GET /v1/config to report live state).
    pub fn config(&self) -> &FirewallConfig {
        &self.config
    }

    /// Scan inbound prompt text. Returns the first violation found (if any).
    pub fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        if !self.config.enabled || !self.config.scan_inbound {
            return None;
        }

        // Check injection first (highest priority)
        if let Some(m) = self.find_match(
            text,
            &self.injection_patterns,
            DetectionKind::PromptInjection,
        ) {
            if self.config.log_detections {
                warn!(kind = "prompt_injection", pattern = %m.pattern_name, "Firewall: prompt injection detected in inbound request");
            }
            return Some(m);
        }

        // Then secrets (credentials/keys). Scanned inbound so a request carrying a
        // bare secret is caught by the policy: under the default `Block` it is a
        // 403, under `Sanitize` it is redacted before egress (leak closed).
        // Higher severity than PII, so checked first.
        if let Some(m) = self.find_match(text, &self.secret_patterns, DetectionKind::Secret) {
            if self.config.log_detections {
                warn!(kind = "secret", pattern = %m.pattern_name, "Firewall: secret/credential detected in inbound request");
            }
            return Some(m);
        }

        // Then PII
        if let Some(m) = self.find_match(text, &self.pii_patterns, DetectionKind::Pii) {
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

        if wants("prompt_injection") || wants("injection") {
            if let Some(m) = self.find_match(
                text,
                &self.injection_patterns,
                DetectionKind::PromptInjection,
            ) {
                return Some(m);
            }
        }
        if wants("pii") {
            if let Some(m) = self.find_match(text, &self.pii_patterns, DetectionKind::Pii) {
                return Some(m);
            }
        }
        if wants("secret") || wants("secrets") {
            if let Some(m) = self.find_match(text, &self.secret_patterns, DetectionKind::Secret) {
                return Some(m);
            }
        }
        if wants("toxicity") || wants("moderation") {
            if let Some(m) = self.find_match(text, &self.toxicity_patterns, DetectionKind::Toxicity)
            {
                return Some(m);
            }
        }
        if wants("bias") || wants("bias_fairness") {
            if let Some(m) = self.find_match(text, &self.bias_patterns, DetectionKind::Bias) {
                return Some(m);
            }
        }
        if wants("code_injection") {
            if let Some(m) = self.find_match(
                text,
                &self.code_injection_patterns,
                DetectionKind::CodeInjection,
            ) {
                return Some(m);
            }
        }
        None
    }

    /// Scan outbound response text. Returns the first violation found (if any).
    pub fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        if !self.config.enabled || !self.config.scan_outbound {
            return None;
        }

        // Secrets in responses (leaked credentials, keys, etc.)
        if let Some(m) = self.find_match(text, &self.secret_patterns, DetectionKind::Secret) {
            if self.config.log_detections {
                warn!(kind = "secret", pattern = %m.pattern_name, "Firewall: secret/credential detected in outbound response");
            }
            return Some(m);
        }

        // PII in responses
        if let Some(m) = self.find_match(text, &self.pii_patterns, DetectionKind::Pii) {
            if self.config.log_detections {
                warn!(kind = "pii", pattern = %m.pattern_name, "Firewall: PII detected in outbound response");
            }
            return Some(m);
        }

        None
    }

    pub fn policy(&self) -> &FirewallPolicy {
        &self.config.policy
    }

    /// Whether outbound scanning is active (master switch plus the outbound
    /// toggle). Used by the streaming pipeline to decide whether to wrap the
    /// response body at all.
    pub fn outbound_enabled(&self) -> bool {
        self.config.enabled && self.config.scan_outbound
    }

    fn find_match(
        &self,
        text: &str,
        patterns: &[(String, Regex)],
        kind: DetectionKind,
    ) -> Option<FirewallMatch> {
        // Fold Unicode obfuscation (invisible splits, fullwidth, lookalikes,
        // dash and digit variants, TAG characters) once so the ASCII pattern
        // sets can't be evaded by `еval(` / `i\u{200c}gnore` / fullwidth text.
        // The raw text is scanned as well when the fold changed it, so a
        // custom pattern written for non-ASCII text (Cyrillic words, an en
        // dash, native digits) still matches what the fold rewrote.
        let normalized = normalize_for_scan(text);
        let folded = matches!(normalized, std::borrow::Cow::Owned(_));
        patterns
            .iter()
            .find(|(name, re)| {
                pattern_hits(name, re, normalized.as_ref())
                    || (folded && pattern_hits(name, re, text))
            })
            .map(|(name, _)| FirewallMatch {
                kind,
                pattern_name: name.clone(),
            })
    }

    /// The compiled pattern set backing a [`DetectionKind`], or `None` for the
    /// image kinds and the classifier kinds (which have no regex representation).
    fn patterns_for(&self, kind: &DetectionKind) -> Option<&[(String, Regex)]> {
        match kind {
            DetectionKind::Pii => Some(&self.pii_patterns),
            DetectionKind::Secret => Some(&self.secret_patterns),
            DetectionKind::PromptInjection => Some(&self.injection_patterns),
            DetectionKind::CodeInjection => Some(&self.code_injection_patterns),
            DetectionKind::Toxicity => Some(&self.toxicity_patterns),
            DetectionKind::Bias => Some(&self.bias_patterns),
            DetectionKind::ExplicitImage
            | DetectionKind::SensitiveImage
            | DetectionKind::Hazard(_)
            | DetectionKind::PromptAttack => None,
        }
    }

    /// Scan `text` for a SPECIFIC detection kind, ignoring the global
    /// `enabled`/`scan_*` config gates. This is the entry the unified-evaluator
    /// inline bridge uses: an enabled per-agent evaluator binding fires even when
    /// the node firewall is off (mirroring [`Self::scan_locked_guardrails`]).
    /// Returns the first match, or `None` for a clean scan or an image kind.
    pub fn scan_kind(&self, text: &str, kind: DetectionKind) -> Option<FirewallMatch> {
        let patterns = self.patterns_for(&kind)?;
        self.find_match(text, patterns, kind)
    }
}

/// Whether `re` matches `hay`. A few PII kinds are separator-tolerant or
/// range-based and need a post-match validator to keep precision (Luhn for
/// cards, public range for IPv4), and an instruction override inside a
/// protective clause does not count; the rest are a plain presence check.
fn pattern_hits(name: &str, re: &Regex, hay: &str) -> bool {
    match name {
        "instruction_override" => re
            .find_iter(hay)
            .any(|matched| !is_protective_instruction_clause(hay, matched.start())),
        "credit_card" => re.find_iter(hay).any(|m| is_credit_card_number(m.as_str())),
        "ipv4" => re.find_iter(hay).any(|m| is_public_ipv4(m.as_str())),
        _ => re.is_match(hay),
    }
}

mod backend;
mod redact;
pub use backend::{FirewallBackend, FirewallRegistry};

#[cfg(test)]
mod backend_tests;
#[cfg(test)]
mod companion_tests;
#[cfg(test)]
mod custom_unicode_tests;
#[cfg(test)]
mod detection_tests;
#[cfg(test)]
mod tests;
