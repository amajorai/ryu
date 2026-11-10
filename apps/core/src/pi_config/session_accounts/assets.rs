//! Managed Pi assets copied into a session directory, sanitized of other
//! accounts' credentials.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::Path;

use super::projection::{private_dir, reject_link};
use super::COPIED_PROVIDER_LISTS;

pub(super) fn materialize_assets(source: &Path, target: &Path, provider_id: &str) -> Result<()> {
    private_dir(target)?;
    // models.json and models-store.json are sanitized in memory and written
    // once, so no unsanitized copy ever lands in the session directory.
    for name in COPIED_PROVIDER_LISTS {
        let from = source.join(name);
        let destination = target.join(name);
        reject_link(&destination)?;
        if !from.exists() {
            continue;
        }
        if std::fs::symlink_metadata(&from)?.file_type().is_symlink() {
            bail!("Managed Pi assets must not contain symbolic links");
        }
        let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&from)?)?;
        if name == "models.json" {
            sanitize_selected_models(&mut value, provider_id);
        } else {
            sanitize_selected_cache(&mut value, provider_id);
        }
        super::super::write_secret_file(&destination, &serde_json::to_string_pretty(&value)?)?;
    }
    for name in ["settings.json", "extensions", "skills", "prompts", "themes"] {
        let from = source.join(name);
        if name == "extensions" {
            // Session extensions are a managed projection, not user-owned assets.
            // Remove the old projection even when the source directory vanished.
            let destination = target.join(name);
            reject_link(&destination)?;
            if destination.exists() {
                std::fs::remove_dir_all(&destination)?;
            }
        }
        if from.exists() {
            copy_asset(&from, &target.join(name))?;
        }
    }
    let path = target.join("settings.json");
    let mut settings: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    settings
        .as_object_mut()
        .context("Managed Pi settings must be an object")?
        .insert(
            "defaultProvider".into(),
            Value::String(provider_id.to_owned()),
        );
    super::super::write_secret_file(&path, &serde_json::to_string_pretty(&settings)?)?;
    Ok(())
}

pub(super) fn sanitize_selected_cache(store: &mut Value, provider_id: &str) {
    if let Some(entries) = store.as_object_mut() {
        for (id, entry) in entries.iter_mut() {
            if id == provider_id {
                continue;
            }
            strip_literal_secrets(entry);
            if let Some(models) = entry.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    strip_literal_secrets(model);
                }
            }
        }
    }
    if let Some(entry) = store.get_mut(provider_id) {
        strip_auth_override(entry);
        if let Some(models) = entry.get_mut("models").and_then(Value::as_array_mut) {
            for model in models {
                strip_auth_override(model);
            }
        }
    }
}

pub(super) fn sanitize_selected_models(models: &mut Value, provider_id: &str) {
    // Every other provider keeps only non-secret values: `${…}` references,
    // templates and proxy sentinels resolve or work as they are, but a legacy
    // literal key never reaches a per-session copy.
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        for (id, provider) in providers.iter_mut() {
            if id == provider_id {
                continue;
            }
            strip_literal_secrets(provider);
            if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    strip_literal_secrets(model);
                }
            }
        }
    }
    let Some(provider) = models
        .get_mut("providers")
        .and_then(|providers| providers.get_mut(provider_id))
    else {
        return;
    };
    strip_auth_override(provider);
    if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            strip_auth_override(model);
        }
    }
    if let Some(models) = provider
        .get_mut("modelOverrides")
        .and_then(Value::as_object_mut)
    {
        for model in models.values_mut() {
            strip_auth_override(model);
        }
    }
}

/// Drop a literal (non-template, non-sentinel) `apiKey` and literal auth
/// headers from a provider entry another session might otherwise inherit.
fn strip_literal_secrets(provider: &mut Value) {
    let Some(object) = provider.as_object_mut() else {
        return;
    };
    if object
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|key| !super::super::secret_env::is_non_secret_key(key))
    {
        object.remove("apiKey");
    }
    if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
        headers.retain(|name, value| {
            !AUTH_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                || value
                    .as_str()
                    .is_some_and(super::super::secret_env::is_non_secret_key)
        });
    }
}

const AUTH_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "api-key",
    "x-api-key",
    "x-goog-api-key",
    "x-ryu-node-token",
];

fn strip_auth_override(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.remove("apiKey");
    object.remove("authHeader");
    if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
        headers.retain(|name, _| {
            ![
                "authorization",
                "proxy-authorization",
                "api-key",
                "x-api-key",
                "x-goog-api-key",
            ]
            .contains(&name.to_ascii_lowercase().as_str())
        });
    }
}

fn copy_asset(source: &Path, target: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        bail!("Managed Pi assets must not contain symbolic links");
    }
    if metadata.is_dir() {
        private_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_asset(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        reject_link(target)?;
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(target)?.write_all(&std::fs::read(source)?)?;
    } else {
        bail!("Managed Pi asset is not a regular file");
    }
    Ok(())
}
