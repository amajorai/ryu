use regex::Regex;
use tracing::warn;

use crate::config::{CustomPatternKind, FirewallConfig, FirewallPolicy};

pub mod cmdscan;

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
}

pub struct FirewallScanner {
    config: FirewallConfig,
    pii_patterns: Vec<(String, Regex)>,
    secret_patterns: Vec<(String, Regex)>,
    injection_patterns: Vec<(String, Regex)>,
    outbound_patterns: Vec<(&'static str, Regex)>,
}

impl FirewallScanner {
    pub fn new(config: FirewallConfig) -> Self {
        let mut pii_patterns = build_pii_patterns();
        let mut secret_patterns = build_secret_patterns();
        let mut injection_patterns = build_injection_patterns();
        let outbound_patterns = build_outbound_patterns();

        // Merge user-defined patterns on top of the curated sets. A pattern that
        // fails to compile is skipped with a warning rather than dropping the
        // whole firewall config — one bad regex must never disable protection.
        for pat in &config.custom_patterns {
            let name = pat.name.trim();
            if name.is_empty() || pat.regex.trim().is_empty() {
                warn!("Firewall: skipping custom pattern with empty name or regex");
                continue;
            }
            match Regex::new(&pat.regex) {
                Ok(re) => {
                    let target = match pat.kind {
                        CustomPatternKind::Pii => &mut pii_patterns,
                        CustomPatternKind::Secret => &mut secret_patterns,
                        CustomPatternKind::PromptInjection => &mut injection_patterns,
                    };
                    target.push((name.to_string(), re));
                }
                Err(e) => {
                    warn!(pattern = %name, error = %e, "Firewall: skipping invalid custom pattern regex");
                }
            }
        }

        // Seed the process-global untrusted-content wrapping flag from config.
        // This is the single chokepoint hit at startup AND on every hot-swap
        // (`AppState::update_firewall_config`), so the tool loop always reads a
        // live value without threading config through its signature.
        crate::untrusted::set_enabled(config.wrap_untrusted_tool_results);

        Self {
            config,
            pii_patterns,
            secret_patterns,
            injection_patterns,
            outbound_patterns,
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

    /// Sanitize text by replacing matched patterns with a placeholder.
    ///
    /// Which categories are redacted is governed by `FirewallConfig.redact_pii`
    /// and `FirewallConfig.redact_secrets`. Both default to `true`, preserving
    /// the previous behaviour. Set either to `false` to suppress that category
    /// independently of the Sanitize policy decision.
    pub fn sanitize(&self, text: &str) -> String {
        let mut result = text.to_string();

        if self.config.redact_pii {
            for (name, re) in &self.pii_patterns {
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }

        if self.config.redact_secrets {
            for (name, re) in &self.secret_patterns {
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }

        result
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

    /// Apply companion egress redaction to each message body in place.
    ///
    /// Mirrors `sanitize_messages` in the pipeline module but uses the companion
    /// path (unconditional, config-ignoring) rather than the regular config-gated
    /// `sanitize()`. Handles both the string and array-of-parts content shapes.
    pub fn companion_sanitize_messages(&self, messages: &mut serde_json::Value) {
        let Some(msgs) = messages.as_array_mut() else {
            return;
        };
        for msg in msgs.iter_mut() {
            match msg.get("content") {
                Some(serde_json::Value::String(s)) => {
                    let s = s.clone();
                    let (redacted, _) = self.redact_companion_egress(&s);
                    msg["content"] = serde_json::Value::String(redacted);
                }
                Some(serde_json::Value::Array(_)) => {
                    if let Some(parts) = msg["content"].as_array_mut() {
                        for part in parts.iter_mut() {
                            if let Some(text) = part["text"].as_str().map(str::to_owned) {
                                let (redacted, _) = self.redact_companion_egress(&text);
                                part["text"] = serde_json::Value::String(redacted);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Unconditionally redact PII and secrets from companion-sourced egress text.
    ///
    /// Unlike `sanitize()`, this method ignores `config.enabled`, `config.redact_pii`,
    /// and `config.redact_secrets` — companion egress redaction is a locked guardrail
    /// that cannot be bypassed by a locally-disabled firewall config (AC3 of #199).
    /// It always redacts both PII and secrets because companion text is screen-captured
    /// content with high inherent PII risk.
    ///
    /// Returns the redacted text and the list of detected categories for audit logging.
    pub fn redact_companion_egress(&self, text: &str) -> (String, Vec<DetectionKind>) {
        let mut result = text.to_string();
        let mut detected: Vec<DetectionKind> = Vec::new();
        let mut pii_hit = false;
        let mut secret_hit = false;

        for (name, re) in &self.pii_patterns {
            if re.is_match(&result) {
                pii_hit = true;
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }
        if pii_hit {
            detected.push(DetectionKind::Pii);
        }

        for (name, re) in &self.secret_patterns {
            if re.is_match(&result) {
                secret_hit = true;
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }
        if secret_hit {
            detected.push(DetectionKind::Secret);
        }

        (result, detected)
    }

    /// Redact secret-like tokens from outbound response/log/error text.
    ///
    /// Unlike `sanitize`, this is NOT config-gated on `redact_pii`/`redact_secrets`
    /// — secret egress is always scrubbed when the firewall is enabled. Each match
    /// is replaced with a STABLE marker (e.g. `[REDACTED:gh_pat]`) so the same
    /// secret shape always produces the same placeholder. Returns the redacted text
    /// and the list of marker labels that fired (for audit).
    pub fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        let mut result = text.to_string();
        let mut hits: Vec<&'static str> = Vec::new();
        for (marker, re) in &self.outbound_patterns {
            if re.is_match(&result) {
                hits.push(*marker);
                let placeholder = format!("[REDACTED:{marker}]");
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }
        (result, hits)
    }

    fn find_match(
        &self,
        text: &str,
        patterns: &[(String, Regex)],
        kind: DetectionKind,
    ) -> Option<FirewallMatch> {
        for (name, re) in patterns {
            if re.is_match(text) {
                return Some(FirewallMatch {
                    kind,
                    pattern_name: name.clone(),
                });
            }
        }
        None
    }
}

fn build_pii_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // Email addresses
        ("email", r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"),
        // US phone numbers (various formats)
        (
            "phone_us",
            r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
        ),
        // US Social Security Numbers
        ("ssn", r"\b\d{3}-\d{2}-\d{4}\b"),
        // Credit card numbers (Visa, MC, Amex, Discover)
        (
            "credit_card",
            r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b",
        ),
        // IPv4 addresses (private ranges excluded from PII scanning in prod, but caught here)
        (
            "ipv4",
            r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b",
        ),
        // Passport numbers (generic 6-9 char alphanumeric)
        ("passport", r"\b[A-Z]{1,2}[0-9]{6,9}\b"),
        // IBAN
        (
            "iban",
            r"\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]?){0,16}\b",
        ),
    ];

    compile_patterns(&raw)
}

fn build_secret_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // OpenAI API key
        ("openai_key", r"sk-[A-Za-z0-9]{20,}"),
        // Anthropic API key
        ("anthropic_key", r"sk-ant-[A-Za-z0-9\-_]{20,}"),
        // AWS Access Key ID
        ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
        // AWS Secret Access Key
        (
            "aws_secret_key",
            r#"(?i)aws.{0,20}secret.{0,20}['"][0-9a-zA-Z/+]{40}['"]"#,
        ),
        // GitHub personal access tokens (classic)
        ("github_token_classic", r"ghp_[A-Za-z0-9]{36}"),
        // GitHub fine-grained PAT
        ("github_token_fg", r"github_pat_[A-Za-z0-9_]{82}"),
        // Generic high-entropy bearer tokens
        ("bearer_token", r"(?i)bearer\s+[A-Za-z0-9\-._~+/]{40,}"),
        // Private keys (PEM)
        (
            "pem_private_key",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        ),
        // Generic API key assignment patterns
        (
            "generic_api_key",
            r#"(?i)(?:api_key|apikey|api-key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?"#,
        ),
        // Database connection strings
        (
            "db_connection",
            r"(?i)(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s]+:[^\s]+@",
        ),
    ];

    compile_patterns(&raw)
}

/// Compiled outbound secret-egress patterns with STABLE `&'static str` markers.
///
/// Distinct from `build_secret_patterns` (which returns owned `String` names and
/// feeds the config-gated inbound/outbound scan). These markers are the stable
/// redaction labels (`[REDACTED:gh_pat]`, …) surfaced to callers, so they must
/// stay `&'static str` and not route through `compile_patterns`.
fn build_outbound_patterns() -> Vec<(&'static str, Regex)> {
    // (marker, regex). Order matters: more specific token shapes first so a
    // GitHub PAT is not partially eaten by a generic param rule.
    let raw: [(&'static str, &str); 7] = [
        // GitHub PATs: ghp_ (classic), gho_/ghu_/ghs_/ghr_ (OAuth/user/server/refresh)
        ("gh_pat", r"\bgh[pousr]_[A-Za-z0-9]{20,255}\b"),
        // GitHub fine-grained PAT
        ("gh_pat", r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"),
        // OpenAI-style sk- keys (incl. sk-proj-, sk-ant-)
        ("openai_key", r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
        // AWS access key id
        ("aws_akid", r"\bAKIA[0-9A-Z]{16}\b"),
        // Bearer <token>
        ("bearer", r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{16,}=*"),
        // token= / api_key= / apikey= / access_token= query-or-form params
        (
            "token_param",
            r"(?i)\b(?:api[_-]?key|access[_-]?token|token)=[A-Za-z0-9\-._~+/]{8,}",
        ),
        // password= / secret= / passwd= query-or-form params
        (
            "secret_param",
            r#"(?i)\b(?:password|passwd|secret)=[^&\s"']{4,}"#,
        ),
    ];
    raw.iter()
        .filter_map(|(marker, pat)| match Regex::new(pat) {
            Ok(re) => Some((*marker, re)),
            Err(e) => {
                tracing::error!("Failed to compile outbound pattern '{marker}': {e}");
                None
            }
        })
        .collect()
}

fn build_injection_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // Classic "ignore previous instructions"
        (
            "ignore_instructions",
            r"(?i)ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions",
        ),
        // "You are now / you will act as"
        (
            "persona_override",
            r"(?i)you\s+(?:are\s+now|will\s+now\s+act\s+as|must\s+act\s+as)\s+(?:an?\s+)?(?:evil|uncensored|unfiltered|jailbreak|DAN)",
        ),
        // DAN / jailbreak markers
        (
            "dan_jailbreak",
            r"(?i)\bDAN\b|\bjailbreak\b|do\s+anything\s+now",
        ),
        // Prompt leaking attempts
        (
            "prompt_leak",
            r"(?i)(?:repeat|print|output|reveal|show|display)\s+(?:your\s+)?(?:system\s+prompt|instructions|training\s+data|context)",
        ),
        // Role-play to bypass
        (
            "roleplay_bypass",
            r"(?i)(?:pretend|imagine|roleplay|act)\s+(?:you\s+are|as\s+if)\s+(?:you\s+have\s+no|without\s+any)\s+(?:restrictions|limits|guidelines|rules|ethics)",
        ),
        // Token smuggling via unicode/encoding hints
        (
            "token_smuggling",
            r"(?i)(?:base64|hex|rot13|caesar)\s+(?:decode|encode|encrypt|decrypt)\s+(?:this|the following)",
        ),
    ];

    compile_patterns(&raw)
}

fn compile_patterns(raw: &[(&str, &str)]) -> Vec<(String, Regex)> {
    raw.iter()
        .filter_map(|(name, pattern)| match Regex::new(pattern) {
            Ok(re) => Some(((*name).to_string(), re)),
            Err(e) => {
                tracing::error!("Failed to compile firewall pattern '{}': {}", name, e);
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CustomPattern, FirewallConfig, FirewallPolicy};

    fn scanner_with(redact_pii: bool, redact_secrets: bool) -> FirewallScanner {
        FirewallScanner::new(FirewallConfig {
            policy: FirewallPolicy::Sanitize,
            redact_pii,
            redact_secrets,
            ..FirewallConfig::default()
        })
    }

    #[test]
    fn sanitize_replaces_pii_and_secret_when_both_enabled() {
        let scanner = scanner_with(true, true);
        let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
        let out = scanner.sanitize(text);
        assert!(
            !out.contains("user@example.com"),
            "PII email should be redacted: {out}"
        );
        assert!(
            !out.contains("sk-abcdefghijklmnopqrstu"),
            "secret key should be redacted: {out}"
        );
        assert!(
            out.contains("[REDACTED:"),
            "output should contain placeholder: {out}"
        );
    }

    #[test]
    fn sanitize_leaves_text_untouched_when_both_disabled() {
        let scanner = scanner_with(false, false);
        let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
        let out = scanner.sanitize(text);
        assert_eq!(
            out, text,
            "no redaction should occur when both flags are false"
        );
    }

    #[test]
    fn sanitize_redacts_only_pii_when_secrets_disabled() {
        let scanner = scanner_with(true, false);
        let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
        let out = scanner.sanitize(text);
        assert!(
            !out.contains("user@example.com"),
            "PII email should be redacted: {out}"
        );
        assert!(
            out.contains("sk-abcdefghijklmnopqrstu"),
            "secret key should NOT be redacted when redact_secrets=false: {out}"
        );
    }

    #[test]
    fn sanitize_redacts_only_secrets_when_pii_disabled() {
        let scanner = scanner_with(false, true);
        let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
        let out = scanner.sanitize(text);
        assert!(
            out.contains("user@example.com"),
            "PII email should NOT be redacted when redact_pii=false: {out}"
        );
        assert!(
            !out.contains("sk-abcdefghijklmnopqrstu"),
            "secret key should be redacted: {out}"
        );
    }

    // ── Custom pattern tests ──────────────────────────────────────────────────

    #[test]
    fn custom_pii_pattern_is_scanned_and_redacted() {
        let scanner = FirewallScanner::new(FirewallConfig {
            policy: FirewallPolicy::Sanitize,
            custom_patterns: vec![CustomPattern {
                name: "employee_id".to_string(),
                regex: r"EMP-\d{6}".to_string(),
                kind: CustomPatternKind::Pii,
            }],
            ..FirewallConfig::default()
        });
        // Inbound scan should trip on the custom PII pattern.
        let hit = scanner.scan_inbound("my badge is EMP-123456 thanks");
        assert!(hit.is_some(), "custom PII pattern should match inbound");
        // Sanitize should replace it with the name-derived marker.
        let out = scanner.sanitize("my badge is EMP-123456 thanks");
        assert!(
            !out.contains("EMP-123456"),
            "custom PII should be redacted: {out}"
        );
        assert!(
            out.contains("[REDACTED:EMPLOYEE_ID]"),
            "marker should derive from the pattern name: {out}"
        );
    }

    #[test]
    fn custom_secret_pattern_is_redacted_outbound() {
        let scanner = FirewallScanner::new(FirewallConfig {
            policy: FirewallPolicy::Sanitize,
            custom_patterns: vec![CustomPattern {
                name: "internal_token".to_string(),
                regex: r"INT_[A-Z0-9]{10}".to_string(),
                kind: CustomPatternKind::Secret,
            }],
            ..FirewallConfig::default()
        });
        let hit = scanner.scan_outbound("leaked INT_ABCDE12345 value");
        assert!(hit.is_some(), "custom secret pattern should match outbound");
    }

    #[test]
    fn invalid_custom_pattern_is_skipped_not_fatal() {
        // An unclosed group is invalid regex; the scanner must still build and
        // keep the built-in patterns working.
        let scanner = FirewallScanner::new(FirewallConfig {
            policy: FirewallPolicy::Sanitize,
            custom_patterns: vec![
                CustomPattern {
                    name: "broken".to_string(),
                    regex: r"(unclosed".to_string(),
                    kind: CustomPatternKind::Pii,
                },
                CustomPattern {
                    name: "".to_string(),
                    regex: r"nonempty".to_string(),
                    kind: CustomPatternKind::Pii,
                },
            ],
            ..FirewallConfig::default()
        });
        // Built-in email PII still fires despite the invalid custom entries.
        let out = scanner.sanitize("reach me at user@example.com");
        assert!(
            !out.contains("user@example.com"),
            "built-in PII must still redact when a custom pattern is invalid: {out}"
        );
    }

    // ── Companion egress redaction tests (#199) ───────────────────────────────

    fn disabled_scanner() -> FirewallScanner {
        FirewallScanner::new(FirewallConfig {
            enabled: false,
            redact_pii: false,
            redact_secrets: false,
            ..FirewallConfig::default()
        })
    }

    /// AC1: companion-sourced text has PII and secrets masked in the output.
    #[test]
    fn redact_companion_egress_masks_pii_and_secrets() {
        // Use a scanner with firewall disabled to prove the method ignores config.
        let scanner = disabled_scanner();
        let text = "Email: user@example.com key=sk-abcdefghijklmnopqrstu";
        let (out, detected) = scanner.redact_companion_egress(text);
        assert!(
            !out.contains("user@example.com"),
            "companion egress must redact PII email regardless of config: {out}"
        );
        assert!(
            !out.contains("sk-abcdefghijklmnopqrstu"),
            "companion egress must redact secrets regardless of config: {out}"
        );
        assert!(
            out.contains("[REDACTED:"),
            "redacted text must contain placeholder: {out}"
        );
        assert!(
            detected.contains(&DetectionKind::Pii),
            "Pii must be reported in detected categories"
        );
        assert!(
            detected.contains(&DetectionKind::Secret),
            "Secret must be reported in detected categories"
        );
    }

    /// AC3 (firewall-disabled config cannot bypass companion redaction): even when
    /// the local firewall is fully disabled, companion egress redaction still fires.
    #[test]
    fn redact_companion_egress_ignores_disabled_firewall_config() {
        let scanner = disabled_scanner();
        let text = "SSN: 123-45-6789 key: sk-abcdefghijklmnopqrstu";
        let (out, detected) = scanner.redact_companion_egress(text);
        assert!(
            !out.contains("123-45-6789"),
            "companion egress must redact PII even when firewall is disabled: {out}"
        );
        assert!(
            !detected.is_empty(),
            "at least one category must be detected"
        );
    }

    /// Clean text produces no detections and is passed through unmodified.
    #[test]
    fn redact_companion_egress_clean_text_passes_through() {
        let scanner = disabled_scanner();
        let text = "The weather today is sunny and warm.";
        let (out, detected) = scanner.redact_companion_egress(text);
        assert_eq!(out, text, "clean text must pass through unchanged");
        assert!(
            detected.is_empty(),
            "no categories must be detected for clean text"
        );
    }

    /// AC4: non-companion path (regular sanitize) is unchanged by the new method.
    #[test]
    fn regular_sanitize_unchanged_by_companion_method() {
        let scanner = scanner_with(true, true);
        let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
        let regular = scanner.sanitize(text);
        // The companion method should also redact, but the regular path must be identical
        // to its pre-#199 behavior (PII + secrets redacted when both flags true).
        assert!(!regular.contains("user@example.com"));
        assert!(!regular.contains("sk-abcdefghijklmnopqrstu"));
    }

    // ── Outbound DLP redaction tests (OUTBOUND-DLP contract) ──────────────────

    /// `redact_outbound` ignores the config gates, so a default scanner suffices.
    fn default_scanner() -> FirewallScanner {
        FirewallScanner::new(FirewallConfig::default())
    }

    #[test]
    fn redact_outbound_masks_github_classic_pat() {
        let fw = default_scanner();
        let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let (out, hits) = fw.redact_outbound(&format!("token is {secret} ok"));
        assert!(!out.contains(secret), "classic PAT must be redacted: {out}");
        assert!(out.contains("[REDACTED:gh_pat]"), "got: {out}");
        assert!(hits.contains(&"gh_pat"));
    }

    #[test]
    fn redact_outbound_masks_github_oauth_pat() {
        let fw = default_scanner();
        // gho_ is caught ONLY by the outbound rule (not by sanitize's secret set).
        let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
        let (out, hits) = fw.redact_outbound(&format!("bearer {secret}"));
        assert!(!out.contains(secret), "OAuth PAT must be redacted: {out}");
        assert!(out.contains("[REDACTED:gh_pat]"));
        assert!(hits.contains(&"gh_pat"));
    }

    #[test]
    fn redact_outbound_masks_openai_key() {
        let fw = default_scanner();
        let secret = "sk-abcdefghijklmnopqrstuvwx";
        let (out, hits) = fw.redact_outbound(&format!("key={secret}"));
        assert!(!out.contains(secret), "sk- key must be redacted: {out}");
        assert!(out.contains("[REDACTED:openai_key]"));
        assert!(hits.contains(&"openai_key"));
    }

    #[test]
    fn redact_outbound_masks_aws_akid() {
        let fw = default_scanner();
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let (out, hits) = fw.redact_outbound(&format!("aws {secret} end"));
        assert!(!out.contains(secret), "AKIA id must be redacted: {out}");
        assert!(out.contains("[REDACTED:aws_akid]"));
        assert!(hits.contains(&"aws_akid"));
    }

    #[test]
    fn redact_outbound_masks_bearer_token() {
        let fw = default_scanner();
        let text = "Authorization: Bearer abcdef0123456789ABCDEF";
        let (out, hits) = fw.redact_outbound(text);
        assert!(
            !out.contains("abcdef0123456789ABCDEF"),
            "bearer token must be redacted: {out}"
        );
        assert!(out.contains("[REDACTED:bearer]"));
        assert!(hits.contains(&"bearer"));
    }

    #[test]
    fn redact_outbound_masks_token_and_password_params() {
        let fw = default_scanner();
        let (out, hits) = fw.redact_outbound("?token=abcd1234efgh&password=hunter2secret");
        assert!(
            !out.contains("abcd1234efgh"),
            "token= must be redacted: {out}"
        );
        assert!(
            !out.contains("hunter2secret"),
            "password= must be redacted: {out}"
        );
        assert!(hits.contains(&"token_param"));
        assert!(hits.contains(&"secret_param"));
    }

    #[test]
    fn redact_outbound_marker_is_stable() {
        let fw = default_scanner();
        let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let (out, _) = fw.redact_outbound(&format!("{secret} then {secret}"));
        // Same shape twice → identical placeholder both times, secret gone.
        assert!(!out.contains(secret));
        assert_eq!(out.matches("[REDACTED:gh_pat]").count(), 2, "got: {out}");
    }

    #[test]
    fn redact_outbound_clean_text_unchanged() {
        let fw = default_scanner();
        let text = "The quick brown fox jumps over the lazy dog.";
        let (out, hits) = fw.redact_outbound(text);
        assert_eq!(out, text, "clean text must pass through unchanged");
        assert!(hits.is_empty(), "no markers should fire on clean text");
    }
}
