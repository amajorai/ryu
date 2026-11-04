//! Redaction paths of [`FirewallScanner`]: the config-gated `sanitize`, the
//! unconditional companion egress redaction, and the outbound secret scrub.

use ryu_gw_firewall::fold_for_redaction;

use super::{is_credit_card_number, is_public_ipv4, DetectionKind, FirewallScanner};

/// Replaces companion text whose PII or secret survives both redaction passes.
pub(crate) const COMPANION_MASK: &str = "[REDACTED:COMPANION_TEXT]";

impl FirewallScanner {
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
                // The separator-tolerant / range-based kinds redact only genuine
                // matches (Luhn-valid cards, public IPs) so Sanitize does not
                // scrub arbitrary long digit runs or benign private/subnet IPs.
                result = match name.as_str() {
                    "credit_card" => re
                        .replace_all(&result, |caps: &regex::Captures| {
                            if is_credit_card_number(&caps[0]) {
                                placeholder.clone()
                            } else {
                                caps[0].to_string()
                            }
                        })
                        .to_string(),
                    "ipv4" => re
                        .replace_all(&result, |caps: &regex::Captures| {
                            if is_public_ipv4(&caps[0]) {
                                placeholder.clone()
                            } else {
                                caps[0].to_string()
                            }
                        })
                        .to_string(),
                    _ => re.replace_all(&result, placeholder.as_str()).to_string(),
                };
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
    /// The first pass rewrites the raw text. Detection scans the
    /// `normalize_for_scan` view, so PII or a secret obfuscated with zero-width,
    /// fullwidth, lookalike or TAG characters survives that pass while the
    /// scanner still sees it. When a match survives, the text is folded with
    /// `fold_for_redaction` and redacted again; if the match still survives, or
    /// the folded pass finds nothing to rewrite, the whole text is replaced with
    /// [`COMPANION_MASK`] rather than forwarded.
    ///
    /// Returns the redacted text and the list of detected categories for audit logging.
    pub fn redact_companion_egress(&self, text: &str) -> (String, Vec<DetectionKind>) {
        let (mut result, mut pii_hit, mut secret_hit) = self.companion_redact_pass(text);
        let (pii_left, secret_left) = self.companion_survivors(&result);
        if pii_left || secret_left {
            let folded = fold_for_redaction(&result).into_owned();
            let (refolded, pii, secret) = self.companion_redact_pass(&folded);
            let (pii_still, secret_still) = self.companion_survivors(&refolded);
            pii_hit |= pii || pii_left;
            secret_hit |= secret || secret_left;
            result = if pii_still || secret_still || !(pii || secret) {
                COMPANION_MASK.to_owned()
            } else {
                refolded
            };
        }
        let mut detected: Vec<DetectionKind> = Vec::new();
        if pii_hit {
            detected.push(DetectionKind::Pii);
        }
        if secret_hit {
            detected.push(DetectionKind::Secret);
        }
        (result, detected)
    }

    /// One raw redaction pass over every PII and secret pattern.
    fn companion_redact_pass(&self, text: &str) -> (String, bool, bool) {
        let mut result = text.to_string();
        let mut pii_hit = false;
        let mut secret_hit = false;
        for (name, re) in &self.pii_patterns {
            if re.is_match(&result) {
                pii_hit = true;
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }
        for (name, re) in &self.secret_patterns {
            if re.is_match(&result) {
                secret_hit = true;
                let placeholder = format!("[REDACTED:{}]", name.to_uppercase());
                result = re.replace_all(&result, placeholder.as_str()).to_string();
            }
        }
        (result, pii_hit, secret_hit)
    }

    /// Whether the normalized scan still finds PII / a secret in `text`.
    pub(super) fn companion_survivors(&self, text: &str) -> (bool, bool) {
        (
            self.find_match(text, &self.pii_patterns, DetectionKind::Pii)
                .is_some(),
            self.find_match(text, &self.secret_patterns, DetectionKind::Secret)
                .is_some(),
        )
    }

    /// Redact a stored violation excerpt regardless of `redact_pii` /
    /// `redact_secrets`: the unconditional companion PII + secret redaction
    /// (which folds Unicode obfuscation and masks survivors), then the outbound
    /// secret scrub. Returns an empty string, which drops the excerpt, if the
    /// normalized scan still finds PII or a secret.
    pub fn redact_excerpt(&self, text: &str) -> String {
        let (companion, _) = self.redact_companion_egress(text);
        let (clean, _) = self.redact_outbound(&companion);
        let (pii_left, secret_left) = self.companion_survivors(&clean);
        if pii_left || secret_left {
            String::new()
        } else {
            clean
        }
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
}
