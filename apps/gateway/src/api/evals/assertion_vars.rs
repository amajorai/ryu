//! Per-case `{{vars}}` applied to assertion values and rubrics.

use super::*;

/// Apply per-case `{{vars}}` to an assertion's value/rubric so the deterministic
/// "assertions" evaluator honors the same substitution the assertions path does.
pub(super) fn assertion_options(assertion: &Assertion) -> &AssertionOptions {
    match assertion {
        Assertion::Contains { options, .. }
        | Assertion::NotContains { options, .. }
        | Assertion::Equals { options, .. }
        | Assertion::Regex { options, .. }
        | Assertion::Icontains { options, .. }
        | Assertion::StartsWith { options, .. }
        | Assertion::ContainsAny { options, .. }
        | Assertion::ContainsAll { options, .. }
        | Assertion::IcontainsAny { options, .. }
        | Assertion::IcontainsAll { options, .. }
        | Assertion::ContainsJson { options, .. }
        | Assertion::ContainsHtml { options, .. }
        | Assertion::ContainsXml { options, .. }
        | Assertion::ContainsSql { options, .. }
        | Assertion::Levenshtein { options, .. }
        | Assertion::Latency { options, .. }
        | Assertion::Cost { options, .. }
        | Assertion::AssertSet { options, .. }
        | Assertion::IsHtml { options }
        | Assertion::IsXml { options }
        | Assertion::IsSql { options }
        | Assertion::IsRefusal { options }
        | Assertion::Moderation { options, .. }
        | Assertion::Javascript { options, .. }
        | Assertion::Python { options, .. }
        | Assertion::Ruby { options, .. }
        | Assertion::Webhook { options, .. }
        | Assertion::IsJson { options }
        | Assertion::JsonValid { options }
        | Assertion::LlmJudge { options, .. }
        | Assertion::LlmRubric { options, .. }
        | Assertion::Similar { options, .. }
        | Assertion::Factuality { options, .. }
        | Assertion::ContextFaithfulness { options, .. }
        | Assertion::AnswerRelevance { options, .. } => options,
    }
}

pub(super) fn render_assertion_vars(
    assertion: &Assertion,
    vars: &std::collections::HashMap<String, serde_json::Value>,
) -> Assertion {
    match assertion {
        Assertion::Contains { value, options } => Assertion::Contains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::NotContains { value, options } => Assertion::NotContains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Equals { value, options } => Assertion::Equals {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Regex { value, options } => Assertion::Regex {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Icontains { value, options } => Assertion::Icontains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::StartsWith { value, options } => Assertion::StartsWith {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsAny { value, options } => Assertion::ContainsAny {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsAll { value, options } => Assertion::ContainsAll {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IcontainsAny { value, options } => Assertion::IcontainsAny {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IcontainsAll { value, options } => Assertion::IcontainsAll {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsJson { value, options } => Assertion::ContainsJson {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsHtml { value, options } => Assertion::ContainsHtml {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsXml { value, options } => Assertion::ContainsXml {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsSql { value, options } => Assertion::ContainsSql {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Levenshtein { value, options } => Assertion::Levenshtein {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Latency { value, options } => Assertion::Latency {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Cost { value, options } => Assertion::Cost {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::AssertSet {
            assertions,
            options,
        } => Assertion::AssertSet {
            assertions: assertions
                .iter()
                .map(|nested| render_assertion_vars(nested, vars))
                .collect(),
            options: options.clone(),
        },
        Assertion::IsHtml { options } => Assertion::IsHtml {
            options: options.clone(),
        },
        Assertion::IsXml { options } => Assertion::IsXml {
            options: options.clone(),
        },
        Assertion::IsSql { options } => Assertion::IsSql {
            options: options.clone(),
        },
        Assertion::IsRefusal { options } => Assertion::IsRefusal {
            options: options.clone(),
        },
        Assertion::Moderation { value, options } => Assertion::Moderation {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Javascript { value, options } => Assertion::Javascript {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Python { value, options } => Assertion::Python {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Ruby { value, options } => Assertion::Ruby {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Webhook { value, options } => Assertion::Webhook {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IsJson { options } => Assertion::IsJson {
            options: options.clone(),
        },
        Assertion::JsonValid { options } => Assertion::JsonValid {
            options: options.clone(),
        },
        Assertion::LlmJudge { rubric, options } => Assertion::LlmJudge {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::LlmRubric { rubric, options } => Assertion::LlmRubric {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::Similar { value, options } => Assertion::Similar {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Factuality { rubric, options } => Assertion::Factuality {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::ContextFaithfulness { rubric, options } => Assertion::ContextFaithfulness {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::AnswerRelevance { rubric, options } => Assertion::AnswerRelevance {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_vars_render_into_values_and_rubrics() {
        let vars = HashMap::from([("who".to_owned(), json!("ada"))]);
        let options = AssertionOptions {
            weight: Some(3.0),
            ..AssertionOptions::default()
        };
        let contains = Assertion::Contains {
            value: "hi {{who}}".to_owned(),
            options: options.clone(),
        };
        let Assertion::Contains { value, .. } = render_assertion_vars(&contains, &vars) else {
            panic!("variant changed");
        };
        assert_eq!(value, "hi ada");
        let judge = Assertion::LlmJudge {
            rubric: "greets {{who}}".to_owned(),
            options,
        };
        let rendered = render_assertion_vars(&judge, &vars);
        let Assertion::LlmJudge { rubric, .. } = &rendered else {
            panic!("variant changed");
        };
        assert_eq!(rubric, "greets ada");
        assert_eq!(assertion_options(&rendered).weight, Some(3.0));
    }
}
