//! Mapping canonical arguments to a provider's own (renames, templates,
//! `pref:` defaults, clamps) and its response back to the canonical shape.

use super::*;

/// Rename the canonical arguments into the provider's own argument names and merge
/// the provider's constant defaults.
///
/// Rules, in order:
/// * A canonical argument with a mapping to a **non-empty** name is renamed.
/// * A mapping to the **empty string** drops the argument — the provider cannot
///   express it, and forwarding it verbatim would be a silent schema violation.
/// * A mapping ending in `[]` renames *and* wraps the value in a single-element
///   array (`"url" -> "urls[]"`). This is the one shape mismatch common enough to
///   be worth expressing declaratively: several extract/scrape APIs take a batch
///   array where the canonical verb passes one item. An already-array value is
///   passed through unwrapped rather than double-wrapped.
/// * An unmapped argument passes through under its own name, so a provider whose
///   argument names already match the canonical ones needs no `args` table at all.
/// * `arg_defaults` are merged first, so an explicit caller argument always wins.
pub fn map_args(binding: &CapabilityToolBinding, arguments: Value) -> Value {
    map_args_with_defaults(binding, binding.arg_defaults.clone(), arguments)
}

/// [`map_args`] with the provider defaults supplied — the form dispatch uses, so
/// `pref:` tokens can be resolved against the preferences store first.
pub fn map_args_with_defaults(
    binding: &CapabilityToolBinding,
    defaults: Map<String, Value>,
    arguments: Value,
) -> Value {
    let arguments = clamp_args(binding, arguments);
    // The TEMPLATE is expanded from the canonical arguments BEFORE renaming, and the
    // arguments it consumes are withheld from the rename pass so they cannot also
    // appear flat under a second name.
    let (templated, consumed) = expand_arg_template(binding, &arguments);
    let mut out: Map<String, Value> = defaults;
    out.extend(templated);
    let Value::Object(incoming) = arguments else {
        // A non-object argument payload has no names to rename; forward verbatim so
        // a provider taking a bare scalar still works.
        return if out.is_empty() {
            arguments
        } else {
            Value::Object(out)
        };
    };
    for (key, value) in incoming {
        if consumed.contains(&key) {
            continue;
        }
        match binding.args.get(&key).map(String::as_str) {
            Some("") => {}
            Some(renamed) => match renamed.strip_suffix("[]") {
                Some(name) if !name.is_empty() => {
                    let wrapped = match value {
                        already @ Value::Array(_) => already,
                        single => Value::Array(vec![single]),
                    };
                    out.insert(name.to_owned(), wrapped);
                }
                // `"[]"` alone names no field — treat as a drop rather than
                // inventing an empty key.
                Some(_) => {}
                None => {
                    out.insert(renamed.to_owned(), value);
                }
            },
            None => {
                out.insert(key, value);
            }
        }
    }
    Value::Object(out)
}

/// Expand a provider's `arg_template`, returning the produced fields and the set of
/// canonical arguments it consumed.
///
/// Substitution rules, kept deliberately small — this is a shape adapter, not a
/// language, and a manifest that can run logic is a far larger trust surface:
/// * a string that is EXACTLY `"{arg}"` becomes that argument's value, TYPE PRESERVED
///   (so a numeric argument stays a number rather than becoming `"5"`);
/// * a string merely CONTAINING `{arg}` interpolates it as text;
/// * a placeholder whose argument is absent drops the field containing it, rather
///   than emitting a literal `"{arg}"` the provider would treat as real content.
pub(super) fn expand_arg_template(
    binding: &CapabilityToolBinding,
    arguments: &Value,
) -> (Map<String, Value>, std::collections::HashSet<String>) {
    let mut consumed = std::collections::HashSet::new();
    if binding.arg_template.is_empty() {
        return (Map::new(), consumed);
    }
    let Some(args) = arguments.as_object() else {
        return (Map::new(), consumed);
    };

    fn subst(
        value: &Value,
        args: &Map<String, Value>,
        consumed: &mut std::collections::HashSet<String>,
    ) -> Option<Value> {
        match value {
            Value::String(s) => {
                // Whole-string placeholder: keep the argument's own JSON type.
                if let Some(name) = s
                    .strip_prefix('{')
                    .and_then(|r| r.strip_suffix('}'))
                    .filter(|n| !n.contains('{') && !n.is_empty())
                {
                    consumed.insert(name.to_owned());
                    return args.get(name).cloned();
                }
                // Interpolated placeholders inside a larger string.
                let mut out = s.clone();
                let mut missing = false;
                for (name, v) in args {
                    let token = format!("{{{name}}}");
                    if out.contains(&token) {
                        consumed.insert(name.clone());
                        let text = match v {
                            Value::String(t) => t.clone(),
                            other => other.to_string(),
                        };
                        out = out.replace(&token, &text);
                    }
                }
                // Any placeholder left unresolved means the field is incomplete.
                if out.contains('{') && out.contains('}') {
                    missing = true;
                }
                if missing {
                    None
                } else {
                    Some(Value::String(out))
                }
            }
            Value::Array(items) => Some(Value::Array(
                items
                    .iter()
                    .filter_map(|v| subst(v, args, consumed))
                    .collect(),
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (k, v) in map {
                    // A missing placeholder drops its FIELD, not the whole object, so
                    // an optional templated field stays optional.
                    if let Some(resolved) = subst(v, args, consumed) {
                        out.insert(k.clone(), resolved);
                    }
                }
                Some(Value::Object(out))
            }
            other => Some(other.clone()),
        }
    }

    let mut produced = Map::new();
    for (field, shape) in &binding.arg_template {
        if let Some(resolved) = subst(shape, args, &mut consumed) {
            produced.insert(field.clone(), resolved);
        }
    }
    (produced, consumed)
}

/// Clamp numeric arguments to what the bound provider can actually honour, BEFORE
/// the rename (so the manifest keys its bounds by canonical name).
///
/// Clamping rather than erroring: the caller asked for "up to N" results, and getting
/// fewer is a normal outcome — a failed search is not. Without this, swapping to a
/// provider with a lower ceiling turns a valid request into an upstream 4xx, and the
/// swap stops being transparent.
pub(super) fn clamp_args(binding: &CapabilityToolBinding, arguments: Value) -> Value {
    if binding.arg_clamp.is_empty() {
        return arguments;
    }
    let Value::Object(mut obj) = arguments else {
        return arguments;
    };
    for (arg, bounds) in &binding.arg_clamp {
        let Some(slot) = obj.get_mut(arg) else {
            continue;
        };
        // Only whole numbers are clamped; a provider bound on a non-integer argument
        // is a manifest mistake, and silently coercing one would be worse than
        // leaving it for the provider to reject.
        let Some(n) = slot.as_i64() else {
            continue;
        };
        let mut clamped = n;
        if let Some(min) = bounds.min {
            clamped = clamped.max(min);
        }
        if let Some(max) = bounds.max {
            clamped = clamped.min(max);
        }
        if clamped != n {
            *slot = Value::from(clamped);
        }
    }
    Value::Object(obj)
}

/// Read a dotted path (`"data.items"`) out of a JSON value. A path segment that is
/// missing yields `None` rather than an error — a provider that omits an optional
/// field must not fail the whole call.
pub(super) fn dotted<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        cur = cur.get(segment)?;
    }
    Some(cur)
}

/// Normalize a provider response into the canonical shape.
///
/// With no [`CapabilityResponseMap`] the provider's output is returned verbatim under
/// `raw`, so a verb whose result is inherently provider-shaped (a screenshot, a tab
/// list) still works without inventing a normalization that would lose information.
/// With one, the result array is located and each item's fields are renamed, and the
/// provider's original item is kept under `raw` so nothing is destroyed by the
/// mapping.
pub fn map_response(binding: &CapabilityToolBinding, provider_id: &str, raw: Value) -> Value {
    let Some(map) = binding.response.as_ref() else {
        return json!({ "provider": provider_id, "raw": raw });
    };
    let located = match map.results.as_deref() {
        Some(path) => match dotted(&raw, path) {
            Some(found) => found.clone(),
            // The declared results path is ABSENT. That is not "the provider found
            // nothing" — a provider that found nothing still returns its envelope
            // with an empty array. It means the payload is not a result set at all,
            // which is exactly what `tool_exec` returns on the failure paths:
            // `{available:false, reason, hint}` when `fail_open` swallows a 401/403
            // (a bad or missing API key), and `{status, body}` for any other
            // non-2xx. Mapping those to `results: []` would report a broken key as
            // "no search results" — an invisible, plausible-looking lie. Pass the
            // payload straight through instead so the caller sees what happened.
            None => return json!({ "provider": provider_id, "raw": raw }),
        },
        // No `results` path: the whole body is the single result (Serper's scrape).
        // That makes the path-absence check above unusable, so detect the same two
        // `tool_exec` failure envelopes directly — otherwise a rejected key maps to
        // one content-less "result" instead of surfacing the failure.
        None if is_failure_envelope(&raw) => {
            return json!({ "provider": provider_id, "raw": raw });
        }
        None => raw.clone(),
    };
    let items: Vec<Value> = match located {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        single => vec![single],
    };
    let results: Vec<Value> = items.iter().map(|item| map_item(map, item)).collect();
    json!({ "provider": provider_id, "results": results })
}

/// `tool_exec`'s `fail_open` `{available:false,…}` envelope, or its wrapped
/// non-2xx `{status, body}` envelope.
pub(super) fn is_failure_envelope(raw: &Value) -> bool {
    let Some(obj) = raw.as_object() else {
        return false;
    };
    if obj.get("available") == Some(&Value::Bool(false)) {
        return true;
    }
    obj.len() == 2
        && obj.contains_key("body")
        && obj
            .get("status")
            .and_then(Value::as_u64)
            .is_some_and(|status| !(200..300).contains(&status))
}

pub(super) fn map_item(map: &CapabilityResponseMap, item: &Value) -> Value {
    let mut out = Map::new();
    for (canonical, source) in &map.fields {
        if let Some(found) = dotted(item, source) {
            out.insert(canonical.clone(), found.clone());
        }
    }
    out.insert("raw".to_owned(), item.clone());
    Value::Object(out)
}
