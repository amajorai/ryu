//! Value rules on `write` rules: length bounds and character classes a
//! written value must meet (`valueRules` on a policy rule).
//!
//! Every matching allow rule that grants `write` applies its rules, so the
//! strictest bounds win. Length counts Unicode characters of the whole stored
//! value (a JSON-object value is checked as its text).

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::vault::policy::{Capability, Policy, PolicyRule};
use crate::vault::policy_ext::{rule_matches, TemplateContext};

/// Longest `maxLength` a rule may set (characters).
pub const MAX_VALUE_RULE_LENGTH: u32 = 1024 * 1024;

/// A class of characters a rule can require or forbid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CharClass {
    /// ASCII `a`-`z`.
    Lower,
    /// ASCII `A`-`Z`.
    Upper,
    /// ASCII `0`-`9`.
    Digit,
    /// ASCII punctuation.
    Symbol,
    /// Any Unicode whitespace.
    Whitespace,
    /// Control characters (including newlines).
    Control,
    /// Anything outside ASCII.
    NonAscii,
}

impl CharClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lower => "lower",
            Self::Upper => "upper",
            Self::Digit => "digit",
            Self::Symbol => "symbol",
            Self::Whitespace => "whitespace",
            Self::Control => "control",
            Self::NonAscii => "non_ascii",
        }
    }

    pub fn contains(self, c: char) -> bool {
        match self {
            Self::Lower => c.is_ascii_lowercase(),
            Self::Upper => c.is_ascii_uppercase(),
            Self::Digit => c.is_ascii_digit(),
            Self::Symbol => c.is_ascii_punctuation(),
            Self::Whitespace => c.is_whitespace(),
            Self::Control => c.is_control(),
            Self::NonAscii => !c.is_ascii(),
        }
    }
}

/// Length and character-class rules for a written value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueRules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// Classes the value must contain at least one character of.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub require: Vec<CharClass>,
    /// Classes the value must not contain any character of.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbid: Vec<CharClass>,
}

impl ValueRules {
    /// Check the rules themselves when a policy is written.
    pub fn validate(&self) -> Result<()> {
        if self.min_length.is_none()
            && self.max_length.is_none()
            && self.require.is_empty()
            && self.forbid.is_empty()
        {
            bail!("valueRules sets no rule");
        }
        if self.max_length == Some(0) {
            bail!("valueRules.maxLength must be at least 1");
        }
        if self
            .min_length
            .into_iter()
            .chain(self.max_length)
            .any(|length| length > MAX_VALUE_RULE_LENGTH)
        {
            bail!("valueRules lengths must be at most {MAX_VALUE_RULE_LENGTH}");
        }
        if let (Some(min), Some(max)) = (self.min_length, self.max_length) {
            if min > max {
                bail!("valueRules.minLength is greater than maxLength");
            }
        }
        if let Some(class) = self
            .require
            .iter()
            .find(|class| self.forbid.contains(class))
        {
            bail!("valueRules both requires and forbids `{}`", class.as_str());
        }
        Ok(())
    }

    /// The first rule `value` breaks, as a message.
    pub fn violation(&self, value: &str) -> Option<String> {
        let length = value.chars().count();
        if let Some(min) = self.min_length {
            if length < min as usize {
                return Some(format!("needs at least {min} characters"));
            }
        }
        if let Some(max) = self.max_length {
            if length > max as usize {
                return Some(format!("allows at most {max} characters"));
            }
        }
        if let Some(class) = self
            .require
            .iter()
            .find(|class| !value.chars().any(|c| class.contains(c)))
        {
            return Some(format!("requires a `{}` character", class.as_str()));
        }
        if let Some(class) = self
            .forbid
            .iter()
            .find(|class| value.chars().any(|c| class.contains(c)))
        {
            return Some(format!("forbids `{}` characters", class.as_str()));
        }
        None
    }
}

/// Validate a rule's `valueRules` at policy write time.
pub(super) fn validate_value_rules(rule: &PolicyRule) -> Result<()> {
    let Some(rules) = &rule.value_rules else {
        return Ok(());
    };
    if rule.deny {
        bail!(
            "rule `{}`: valueRules cannot be set on a deny rule",
            rule.path
        );
    }
    if !rule.capabilities.contains(&Capability::Write) {
        bail!(
            "rule `{}`: valueRules need the `write` capability",
            rule.path
        );
    }
    rules.validate()
}

/// Check a written `value` against every matching rule granting `write` on
/// `path`. Returns the first violation as a message.
pub fn check_value_rules<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    context: &TemplateContext,
    value: &str,
) -> std::result::Result<(), String> {
    for policy in policies {
        for rule in &policy.rules {
            let Some(rules) = &rule.value_rules else {
                continue;
            };
            if rule.deny
                || !rule.capabilities.contains(&Capability::Write)
                || !rule_matches(rule, path, context)
            {
                continue;
            }
            if let Some(message) = rules.violation(value) {
                return Err(format!("policy `{}` {message}", policy.name));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "value_rules_tests.rs"]
mod tests;
