// Recipe engine: {{param}} substitution and step preparation.
// Actual step execution is handled by apps/ghost which dispatches to tool handlers.

use anyhow::Result;
use regex::Regex;
use std::collections::HashMap;

use super::types::{Recipe, RecipeStep};

/// Substitute {{param}} placeholders in a string using provided values.
pub fn substitute(template: &str, params: &HashMap<String, String>) -> String {
    // Lazily compiled regex for {{param_name}}
    let re = Regex::new(r"\{\{(\w+)\}\}").expect("valid regex");
    re.replace_all(template, |caps: &regex::Captures| {
        let key = &caps[1];
        params
            .get(key)
            .cloned()
            .unwrap_or_else(|| format!("{{{{{key}}}}}"))
    })
    .to_string()
}

/// Substitute all string fields in a RecipeStep using the given params.
pub fn substitute_step(step: &RecipeStep, params: &HashMap<String, String>) -> RecipeStep {
    RecipeStep {
        id: step.id,
        action: substitute(&step.action, params),
        target: step.target.as_ref().map(|t| super::types::Locator {
            query: t.query.as_deref().map(|s| substitute(s, params)),
            role: t.role.as_deref().map(|s| substitute(s, params)),
            dom_id: t.dom_id.as_deref().map(|s| substitute(s, params)),
            dom_class: t.dom_class.as_deref().map(|s| substitute(s, params)),
            identifier: t.identifier.as_deref().map(|s| substitute(s, params)),
            app: t.app.as_deref().map(|s| substitute(s, params)),
        }),
        params: step.params.as_ref().map(|p| {
            p.iter()
                .map(|(k, v)| (k.clone(), substitute(v, params)))
                .collect()
        }),
        wait_after: step.wait_after.clone(),
        note: step.note.clone(),
        on_failure: step.on_failure.clone(),
    }
}

/// Validate that all required params are provided.
pub fn validate_params(recipe: &Recipe, provided: &HashMap<String, String>) -> Result<()> {
    let Some(param_defs) = &recipe.params else {
        return Ok(());
    };
    let mut missing = vec![];
    for (name, def) in param_defs {
        if def.required.unwrap_or(false) && !provided.contains_key(name.as_str()) {
            missing.push(name.as_str());
        }
    }
    if !missing.is_empty() {
        anyhow::bail!("Missing required params: {}", missing.join(", "));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_substitute_basic() {
        let mut params = HashMap::new();
        params.insert("recipient".to_string(), "alice@example.com".to_string());
        params.insert("subject".to_string(), "Hello".to_string());
        let s = substitute(
            "Send email to {{recipient}} with subject {{subject}}",
            &params,
        );
        assert_eq!(s, "Send email to alice@example.com with subject Hello");
    }

    #[test]
    fn test_substitute_missing_key() {
        let params = HashMap::new();
        let s = substitute("Hello {{name}}", &params);
        assert_eq!(s, "Hello {{name}}");
    }
}
