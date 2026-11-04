//! Templated rule paths (see the parent module docs).

use super::*;

/// The caller identity templates expand against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateContext {
    values: BTreeMap<&'static str, Vec<String>>,
}

impl TemplateContext {
    /// Build from policy-binding subjects (`user:`, `machine:`, `team:`, `role:`).
    pub fn from_subjects(subjects: &[String]) -> Self {
        let mut values: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
        for subject in subjects {
            let Some((kind, id)) = subject.split_once(':') else {
                continue;
            };
            let variable = match kind {
                "user" => "identity.user.id",
                "machine" => "identity.machine.id",
                "team" => "identity.team.ids",
                "role" => "identity.roles",
                _ => continue,
            };
            let entry = values.entry(variable).or_default();
            if !entry.iter().any(|existing| existing == id) {
                entry.push(id.to_owned());
            }
        }
        Self { values }
    }

    fn safe_values(&self, variable: &str) -> Vec<&str> {
        self.values
            .get(variable)
            .map(|values| {
                values
                    .iter()
                    .map(String::as_str)
                    .filter(|value| is_safe_template_value(value))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Whether `value` may be substituted into a path segment.
pub fn is_safe_template_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEMPLATE_VALUE_LEN
        && value != "."
        && value != ".."
        && !value.chars().any(|c| {
            matches!(c, '/' | '*' | '?' | '{' | '}') || c.is_control() || c.is_whitespace()
        })
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Part<'a> {
    Literal(&'a str),
    Variable(&'a str),
}

pub(super) fn parse_template(text: &str) -> Result<Vec<Part<'_>>> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let literal = &rest[..start];
        if literal.contains('{') || literal.contains('}') {
            bail!("`{text}` has a stray brace");
        }
        if !literal.is_empty() {
            parts.push(Part::Literal(literal));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            bail!("`{text}` has an unclosed `{{{{`");
        };
        let variable = after[..end].trim();
        if !TEMPLATE_VARIABLES.contains(&variable) {
            bail!(
                "`{text}` references unknown template variable `{variable}` (known: {})",
                TEMPLATE_VARIABLES.join(", ")
            );
        }
        parts.push(Part::Variable(variable));
        rest = &after[end + 2..];
    }
    if rest.contains('{') || rest.contains('}') {
        bail!("`{text}` has a stray brace");
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest));
    }
    Ok(parts)
}

/// Whether `text` contains a template placeholder.
pub fn is_templated(text: &str) -> bool {
    text.contains("{{")
}

/// Check template syntax at policy write time.
pub fn validate_template(text: &str) -> Result<()> {
    parse_template(text).map(|_| ())
}

/// The result of expanding a template.
#[derive(Debug, PartialEq, Eq)]
pub enum Expansion {
    /// Every concrete text the template expands to (non-empty).
    Concrete(Vec<String>),
    /// Unresolvable; carries the template with each placeholder replaced by `*`.
    Unresolved(String),
}

/// Expand `text` for `context`.
pub fn expand(text: &str, context: &TemplateContext) -> Expansion {
    if !is_templated(text) {
        return Expansion::Concrete(vec![text.to_owned()]);
    }
    let Ok(parts) = parse_template(text) else {
        // Validation rejects malformed templates at write time; a stored one
        // that still fails to parse resolves to nothing (and widens denies).
        return Expansion::Unresolved(widen_raw(text));
    };
    let wildcard: String = parts
        .iter()
        .map(|part| match part {
            Part::Literal(literal) => *literal,
            Part::Variable(_) => "*",
        })
        .collect();
    let mut outputs = vec![String::new()];
    for part in &parts {
        match part {
            Part::Literal(literal) => outputs.iter_mut().for_each(|out| out.push_str(literal)),
            Part::Variable(variable) => {
                let values = context.safe_values(variable);
                if values.is_empty() || outputs.len() * values.len() > MAX_TEMPLATE_EXPANSIONS {
                    return Expansion::Unresolved(wildcard);
                }
                outputs = outputs
                    .iter()
                    .flat_map(|prefix| values.iter().map(move |value| format!("{prefix}{value}")))
                    .collect();
            }
        }
    }
    Expansion::Concrete(outputs)
}

pub(super) fn widen_raw(text: &str) -> String {
    // Replace every brace-delimited run with `*`; used only for malformed input.
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '{' => {
                if depth == 0 {
                    out.push('*');
                }
                depth += 1;
            }
            '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Whether `rule` applies to `path` for `context`. Unresolved allow rules never
/// apply; unresolved deny rules apply to their widened glob.
pub fn rule_matches(rule: &PolicyRule, path: &str, context: &TemplateContext) -> bool {
    match expand(&rule.path, context) {
        Expansion::Concrete(globs) => globs.iter().any(|glob| glob_matches(glob, path)),
        Expansion::Unresolved(widened) => rule.deny && glob_matches(&widened, path),
    }
}
