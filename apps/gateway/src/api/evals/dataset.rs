//! Dataset expansion, replay fixtures and the built-in prompt/output transforms.

use super::*;

pub(super) fn expanded_dataset(cases: &[EvalCase], repeat: Option<usize>) -> Vec<EvalCase> {
    let count = repeat.unwrap_or(1).clamp(1, MAX_EVAL_REPEAT);
    if count == 1 {
        return cases.to_vec();
    }
    let mut expanded = Vec::with_capacity(cases.len().saturating_mul(count));
    for repetition in 0..count {
        for (index, case) in cases.iter().enumerate() {
            let mut copy = case.clone();
            copy.id = Some(format!(
                "{}:repeat-{}",
                case.id.as_deref().unwrap_or(&format!("case-{}", index + 1)),
                repetition + 1
            ));
            expanded.push(copy);
        }
    }
    expanded
}

pub(super) fn precomputed_response(value: &Value) -> Value {
    if value.get("choices").and_then(Value::as_array).is_some() {
        return value.clone();
    }
    let output = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            value
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| value.to_string());
    json!({
        "choices": [{"message": {"content": output}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    })
}

pub(super) fn response_cost_micro_usd(response: &Value) -> Option<u64> {
    if let Some(value) = response["usage"]["cost_micro_usd"].as_u64() {
        return Some(value);
    }
    ["cost_usd", "cost"]
        .iter()
        .filter_map(|key| response["usage"][*key].as_f64())
        .find(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value * 1_000_000.0).round() as u64)
}

pub(super) fn apply_builtin_output_transform(
    response: &mut Value,
    transform: Option<&str>,
) -> Result<(), String> {
    let Some(transform) = transform.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let text = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let transformed = match transform {
        "trim" => text.trim().to_owned(),
        "lower" | "lowercase" => text.to_lowercase(),
        "upper" | "uppercase" => text.to_uppercase(),
        "json" => serde_json::from_str::<Value>(&text)
            .map(|value| serde_json::to_string(&value).unwrap_or(text.clone()))
            .map_err(|error| format!("json transform failed: {error}"))?,
        other => return Err(format!("unsupported output transform '{other}'")),
    };
    response["choices"][0]["message"]["content"] = Value::String(transformed);
    Ok(())
}

pub(super) fn apply_builtin_vars_transform(
    vars: &mut HashMap<String, Value>,
    transform: Option<&str>,
) -> Result<(), String> {
    let Some(transform) = transform.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    match transform {
        "identity" => Ok(()),
        "json" => {
            for value in vars.values_mut() {
                if let Value::String(text) = value {
                    *value = serde_json::from_str(text)
                        .map_err(|error| format!("json variable transform failed: {error}"))?;
                }
            }
            Ok(())
        }
        other => Err(format!("unsupported variable transform '{other}'")),
    }
}

pub(super) fn render_case_prompt(
    case: &EvalCase,
    request_prefix: Option<&str>,
    request_suffix: Option<&str>,
) -> String {
    let mut rendered = render_template(&case.prompt, &case.vars);
    if let Some(prefix) = request_prefix {
        rendered = format!("{prefix}{rendered}");
    }
    if let Some(prefix) = case.options.prefix.as_deref() {
        rendered = format!("{prefix}{rendered}");
    }
    if let Some(suffix) = case.options.suffix.as_deref() {
        rendered.push_str(suffix);
    }
    if let Some(suffix) = request_suffix {
        rendered.push_str(suffix);
    }
    rendered
}

pub(super) fn case_model(case: &EvalCase, fallback: &str) -> String {
    case.provider
        .as_deref()
        .or_else(|| {
            case.providers
                .iter()
                .map(String::as_str)
                .find(|value| !value.trim().is_empty())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_fixtures_and_transforms() {
        let case = EvalCase {
            prompt: "hi {{name}}".to_owned(),
            vars: HashMap::from([("name".to_owned(), json!("ada"))]),
            providers: vec![" ".to_owned(), "m2".to_owned()],
            ..EvalCase::default()
        };
        assert_eq!(
            expanded_dataset(std::slice::from_ref(&case), Some(3)).len(),
            3
        );
        assert_eq!(render_case_prompt(&case, Some("> "), None), "> hi ada");
        assert_eq!(case_model(&case, "m1"), "m2");

        let mut response = precomputed_response(&json!("Plain Text"));
        assert_eq!(response["choices"][0]["message"]["content"], "Plain Text");
        apply_builtin_output_transform(&mut response, Some("upper")).expect("upper");
        assert_eq!(response["choices"][0]["message"]["content"], "PLAIN TEXT");
        assert!(apply_builtin_output_transform(&mut response, Some("eval(x)")).is_err());
        assert_eq!(
            response_cost_micro_usd(&json!({ "usage": { "cost_usd": 0.0025 } })),
            Some(2_500)
        );
    }
}
