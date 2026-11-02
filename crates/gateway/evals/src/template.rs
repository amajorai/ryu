//! Bounded, deterministic Promptfoo-style template rendering.

use serde_json::Value;

// ─── Assertion + variable-substitution helpers ───────────────────────────────

/// Render Promptfoo-compatible prompt expressions using typed variables.
///
/// The renderer intentionally stays deterministic and bounded. It supports the
/// editor's portable subset of Nunjucks: dotted lookup, `upper`, `lower`,
/// `default`, `join`, `length`, `if/else`, and `for` blocks. Unknown expressions
/// remain literal so a typo cannot silently erase prompt text.
pub fn render_template(template: &str, vars: &std::collections::HashMap<String, Value>) -> String {
    render_template_scope(template, vars, 0)
}

/// Backward-compatible name used by existing Gateway call sites.
pub fn substitute_vars(template: &str, vars: &std::collections::HashMap<String, Value>) -> String {
    render_template(template, vars)
}

const MAX_RENDERED_TEMPLATE_CHARS: usize = 262_144;

fn render_template_scope(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    if depth > 12 {
        return template.to_owned();
    }
    let mut body = template.to_owned();
    body = render_for_blocks(&body, vars, depth);
    body = render_if_blocks(&body, vars, depth);
    let mut rendered = String::with_capacity(body.len());
    let mut cursor = 0;
    while let Some(relative_start) = body[cursor..].find("{{") {
        let start = cursor + relative_start;
        rendered.push_str(&body[cursor..start]);
        let Some(relative_end) = body[start + 2..].find("}}") else {
            rendered.push_str(&body[start..]);
            cursor = body.len();
            break;
        };
        let end = start + 2 + relative_end;
        let expression = body[start + 2..end].trim();
        rendered.push_str(
            &render_expression(expression, vars).unwrap_or_else(|| body[start..end + 2].to_owned()),
        );
        cursor = end + 2;
        if rendered.chars().count() >= MAX_RENDERED_TEMPLATE_CHARS {
            return rendered.chars().take(MAX_RENDERED_TEMPLATE_CHARS).collect();
        }
    }
    if cursor < body.len() {
        rendered.push_str(&body[cursor..]);
    }
    rendered.chars().take(MAX_RENDERED_TEMPLATE_CHARS).collect()
}

fn render_for_blocks(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    let Some(start) = template.find("{% for ") else {
        return template.to_owned();
    };
    let Some(open_end_relative) = template[start..].find("%}") else {
        return template.to_owned();
    };
    let open_end = start + open_end_relative + 2;
    let header = template[start + 7..open_end - 2].trim();
    let Some((item, collection)) = header.split_once(" in ") else {
        return template.to_owned();
    };
    let Some(close_relative) = template[open_end..].find("{% endfor %}") else {
        return template.to_owned();
    };
    let close_start = open_end + close_relative;
    let inner = &template[open_end..close_start];
    let mut replacement = String::new();
    if let Some(Value::Array(values)) = lookup_value(vars, collection.trim()) {
        for value in values {
            let mut scoped = vars.clone();
            scoped.insert(item.trim().to_owned(), value.clone());
            replacement.push_str(&render_template_scope(inner, &scoped, depth + 1));
        }
    }
    let suffix_start = close_start + "{% endfor %}".len();
    let mut result = String::with_capacity(template.len());
    result.push_str(&template[..start]);
    result.push_str(&replacement);
    result.push_str(&render_for_blocks(&template[suffix_start..], vars, depth));
    result
}

fn render_if_blocks(
    template: &str,
    vars: &std::collections::HashMap<String, Value>,
    depth: usize,
) -> String {
    let Some(start) = template.find("{% if ") else {
        return template.to_owned();
    };
    let Some(open_end_relative) = template[start..].find("%}") else {
        return template.to_owned();
    };
    let open_end = start + open_end_relative + 2;
    let condition = template[start + 6..open_end - 2].trim();
    let Some(close_relative) = template[open_end..].find("{% endif %}") else {
        return template.to_owned();
    };
    let close_start = open_end + close_relative;
    let inner = &template[open_end..close_start];
    let (when_true, when_false) = inner
        .split_once("{% else %}")
        .map_or((inner, ""), |parts| parts);
    let chosen = if eval_condition(condition, vars) {
        when_true
    } else {
        when_false
    };
    let replacement = render_template_scope(chosen, vars, depth + 1);
    let suffix_start = close_start + "{% endif %}".len();
    let mut result = String::with_capacity(template.len());
    result.push_str(&template[..start]);
    result.push_str(&replacement);
    result.push_str(&render_if_blocks(&template[suffix_start..], vars, depth));
    result
}

fn eval_condition(expression: &str, vars: &std::collections::HashMap<String, Value>) -> bool {
    let expression = expression.trim();
    if let Some(negated) = expression.strip_prefix("not ") {
        return !eval_condition(negated, vars);
    }
    for operator in ["==", "!="] {
        if let Some((left, right)) = expression.split_once(operator) {
            let left = lookup_value(vars, left.trim());
            let right = parse_literal(right.trim()).or_else(|| lookup_value(vars, right.trim()));
            let equal = left.is_some() && left == right;
            return if operator == "==" { equal } else { !equal };
        }
    }
    lookup_value(vars, expression).is_some_and(|value| is_truthy(&value))
}

fn render_expression(
    expression: &str,
    vars: &std::collections::HashMap<String, Value>,
) -> Option<String> {
    let mut parts = expression.split('|').map(str::trim);
    let first = parts.next()?.trim();
    let mut value = lookup_value(vars, first)?;
    for filter in parts {
        let (name, argument) = filter
            .split_once('(')
            .map_or((filter, None), |(name, rest)| {
                (name.trim(), Some(rest.trim_end_matches(')').trim()))
            });
        value = match name {
            "upper" => Value::String(stringify_value(&value).to_uppercase()),
            "lower" => Value::String(stringify_value(&value).to_lowercase()),
            "default" => {
                if is_truthy(&value) {
                    value
                } else {
                    Value::String(argument.unwrap_or("").trim_matches(['\"', '\'']).to_owned())
                }
            }
            "join" => {
                let separator = argument.unwrap_or(", ").trim_matches(['\"', '\'']);
                let Value::Array(items) = value else {
                    return None;
                };
                Value::String(
                    items
                        .iter()
                        .map(stringify_value)
                        .collect::<Vec<_>>()
                        .join(separator),
                )
            }
            "length" => match value {
                Value::Array(items) => Value::Number((items.len() as u64).into()),
                Value::Object(items) => Value::Number((items.len() as u64).into()),
                Value::String(text) => Value::Number((text.chars().count() as u64).into()),
                _ => return None,
            },
            _ => return None,
        };
    }
    Some(stringify_value(&value))
}

fn lookup_value(vars: &std::collections::HashMap<String, Value>, path: &str) -> Option<Value> {
    let mut segments = path.trim().split('.');
    let mut value = vars.get(segments.next()?)?.clone();
    for segment in segments {
        value = value.get(segment)?.clone();
    }
    Some(value)
}

fn parse_literal(value: &str) -> Option<Value> {
    let value = value.trim();
    if value.starts_with(['\"', '\'']) && value.ends_with(['\"', '\'']) {
        return Some(Value::String(value[1..value.len() - 1].to_owned()));
    }
    serde_json::from_str(value).ok()
}

fn stringify_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(items) => !items.is_empty(),
    }
}

#[cfg(test)]
#[path = "template_tests.rs"]
mod tests;
