use serde_json::Value;

use super::*;

/// Project configured session defaults onto an `acp-config` probe answer, so a
/// composer that seeds its pickers from `currentModelId` / `currentModeId` /
/// `currentValue` starts from the saved default rather than the agent's own.
/// A default the agent does not advertise (or the allowlist excludes) is left
/// alone.
pub fn project_defaults(config: &mut Value, settings: &AcpAgentSettings) {
    if let Some(model) = settings
        .default_model
        .as_deref()
        .filter(|model| settings.allows_model(model))
    {
        if let Some(models) = config.get_mut("models").and_then(Value::as_object_mut) {
            let advertised = models
                .get("availableModels")
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter()
                        .any(|entry| entry.get("modelId").and_then(Value::as_str) == Some(model))
                });
            if advertised {
                models.insert("currentModelId".to_owned(), Value::String(model.to_owned()));
            }
        }
    }
    if let Some(mode) = settings.default_mode.as_deref() {
        if let Some(modes) = config.get_mut("modes").and_then(Value::as_object_mut) {
            let advertised = modes
                .get("availableModes")
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter()
                        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(mode))
                });
            if advertised {
                modes.insert("currentModeId".to_owned(), Value::String(mode.to_owned()));
            }
        }
    }
    let Some(options) = config
        .get_mut("configOptions")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for option in options {
        let Some(id) = option.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(value) = settings.default_config_options.get(id).map(String::as_str) else {
            continue;
        };
        let is_model = option.get("category").and_then(Value::as_str) == Some("model");
        if is_model && !settings.allows_model(value) {
            continue;
        }
        let advertised = option
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                entries.iter().any(
                    |entry| match entry.get("options").and_then(Value::as_array) {
                        Some(grouped) => grouped
                            .iter()
                            .any(|inner| inner.get("value").and_then(Value::as_str) == Some(value)),
                        None => entry.get("value").and_then(Value::as_str) == Some(value),
                    },
                )
            });
        if advertised {
            if let Some(object) = option.as_object_mut() {
                object.insert("currentValue".to_owned(), Value::String(value.to_owned()));
            }
        }
    }
}

/// Narrow an `acp-config` probe answer to `allowed` model ids: the unstable
/// `models.availableModels` list and every `model`-category select option
/// (flat or grouped). The current model is kept so the picker can still show it.
pub fn filter_models(config: &mut Value, allowed: &[String]) {
    if allowed.is_empty() {
        return;
    }
    let keep = |id: Option<&str>| id.is_some_and(|id| allowed.iter().any(|m| m == id));

    if let Some(models) = config.get_mut("models").and_then(Value::as_object_mut) {
        let current = models
            .get("currentModelId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(list) = models
            .get_mut("availableModels")
            .and_then(Value::as_array_mut)
        {
            list.retain(|model| {
                let id = model.get("modelId").and_then(Value::as_str);
                keep(id) || id == current.as_deref()
            });
        }
    }

    let Some(options) = config
        .get_mut("configOptions")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for option in options {
        if option.get("category").and_then(Value::as_str) != Some("model") {
            continue;
        }
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let keep_value = |value: &Value| {
            let id = value.get("value").and_then(Value::as_str);
            keep(id) || id == current.as_deref()
        };
        let Some(values) = option.get_mut("options").and_then(Value::as_array_mut) else {
            continue;
        };
        for entry in values.iter_mut() {
            if let Some(grouped) = entry.get_mut("options").and_then(Value::as_array_mut) {
                grouped.retain(keep_value);
            }
        }
        values.retain(
            |entry| match entry.get("options").and_then(Value::as_array) {
                Some(grouped) => !grouped.is_empty(),
                None => keep_value(entry),
            },
        );
    }
}
