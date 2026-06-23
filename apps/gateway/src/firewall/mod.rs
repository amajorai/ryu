use regex::Regex;
use tracing::warn;

use crate::config::{FirewallConfig, FirewallPolicy};

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
}

impl FirewallScanner {
    pub fn new(config: FirewallConfig) -> Self {
        let pii_patterns = build_pii_patterns();
        let secret_patterns = build_secret_patterns();
        let injection_patterns = build_injection_patterns();

        Self {
            config,
            pii_patterns,
            secret_patterns,
            injection_patterns,
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
    use crate::config::{FirewallConfig, FirewallPolicy};

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
}
