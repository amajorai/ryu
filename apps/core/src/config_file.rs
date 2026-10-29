//! Structured, non-secret Core configuration.
//!
//! Core historically exposed almost every default as an environment variable.
//! Keep those variables as a compatibility and deployment override, but give
//! local nodes one structured file for the non-secret `RYU_*` values that are
//! otherwise painful to maintain in a shell environment.
//!
//! The file is deliberately loaded into the existing process environment at the
//! bootstrap boundary. That keeps the many existing readers compatible while
//! making the migration reversible: an explicitly supplied environment value
//! always wins over the file, and removing the file restores today's behavior.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const CONFIG_FILE_NAME: &str = "node-config.json";
const CONFIG_VERSION: u64 = 1;
const MAX_CONFIG_BYTES: u64 = 256 * 1024;

/// The parsed on-disk shape. Friendly grouped settings are converted to the
/// compatibility env names at load time, so the transition does not require
/// changing hundreds of readers at once. Exact `overrides` remain available for
/// names that have not received a friendly path yet.
#[derive(Debug, Deserialize)]
struct NodeConfigFile {
    #[serde(default = "default_config_version")]
    version: u64,
    /// Friendly nested settings. Leaves are converted to the existing RYU_*
    /// compatibility names, so the editable file can be grouped by ownership.
    #[serde(default)]
    settings: BTreeMap<String, Value>,
    /// Escape hatch for a setting whose legacy name does not fit the friendly
    /// path convention. It is still restricted to non-secret RYU_* values.
    #[serde(default)]
    overrides: BTreeMap<String, Value>,
}

/// What happened while loading the optional node config.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LoadReport {
    pub applied: usize,
    pub ignored_environment: usize,
    pub ignored_reserved: usize,
    pub path: PathBuf,
}

fn default_config_version() -> u64 {
    CONFIG_VERSION
}

/// The default structured config path for the active profile.
pub fn path() -> PathBuf {
    crate::paths::config_dir().join(CONFIG_FILE_NAME)
}

/// Load the optional structured config into the process environment.
///
/// Missing config is a successful no-op. Malformed or unsupported config fails
/// boot with a path-bearing error so an operator cannot believe a file was
/// applied when it was silently ignored.
pub fn load() -> Result<LoadReport> {
    let config_path = path();
    if !config_path.exists() {
        return Ok(LoadReport {
            path: config_path,
            ..LoadReport::default()
        });
    }

    load_from_path(&config_path)
}

fn load_from_path(config_path: &Path) -> Result<LoadReport> {
    let overrides = read_overrides(config_path)?;
    apply_overrides(config_path, overrides)
}

/// Resolve the managed Pi state root without mutating environment or stores.
pub(crate) fn pi_agent_override_at(config_dir: &Path) -> Result<Option<String>> {
    if std::env::var_os("RYU_PI_AGENT_DIR").is_some() {
        return Ok(std::env::var("RYU_PI_AGENT_DIR").ok());
    }
    let path = config_dir.join(CONFIG_FILE_NAME);
    if !path.exists() {
        return Ok(None);
    }
    let overrides = read_overrides(&path)?;
    overrides
        .get("RYU_PI_AGENT_DIR")
        .map(value_to_env)
        .transpose()
        .map(Option::flatten)
}

fn read_overrides(config_path: &Path) -> Result<BTreeMap<String, Value>> {
    let metadata = std::fs::metadata(config_path)
        .with_context(|| format!("reading metadata for {}", config_path.display()))?;
    if metadata.len() > MAX_CONFIG_BYTES {
        bail!(
            "{} is larger than the {} KiB limit",
            config_path.display(),
            MAX_CONFIG_BYTES / 1024
        );
    }

    let raw =
        std::fs::read(config_path).with_context(|| format!("reading {}", config_path.display()))?;
    let config: NodeConfigFile = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing {} as node config JSON", config_path.display()))?;
    if config.version != CONFIG_VERSION {
        bail!(
            "{} uses config version {}, but Core supports version {}",
            config_path.display(),
            config.version,
            CONFIG_VERSION
        );
    }

    let mut overrides = BTreeMap::new();
    for (section, value) in config.settings {
        flatten_settings(&[section], &value, &mut overrides)?;
    }
    // Exact compatibility overrides win over the friendly path convention.
    for (name, value) in config.overrides {
        overrides.insert(name, value);
    }
    Ok(overrides)
}

fn apply_overrides(config_path: &Path, overrides: BTreeMap<String, Value>) -> Result<LoadReport> {
    let mut report = LoadReport {
        path: config_path.to_path_buf(),
        ..LoadReport::default()
    };
    // Validate the complete document before changing process state. A malformed
    // later entry must not leave earlier settings applied after a failed load.
    let mut normalized = Vec::new();
    for (name, value) in overrides {
        if !is_valid_override_name(&name) {
            bail!(
				"{} contains unsupported override {name}; only non-secret RYU_* settings are allowed",
				config_path.display()
			);
        }
        if is_reserved_or_secret(&name) {
            report.ignored_reserved += 1;
            continue;
        }
        let Some(value) = value_to_env(&value)
            .with_context(|| format!("normalizing override {name} in {}", config_path.display()))?
        else {
            continue;
        };

        normalized.push((name, value));
    }

    for (name, value) in normalized {
        // Environment is the explicit deployment escape hatch and therefore wins
        // over the local file, including an intentionally empty value.
        if std::env::var_os(&name).is_some() {
            report.ignored_environment += 1;
            continue;
        }
        std::env::set_var(&name, value);
        report.applied += 1;
    }

    crate::log_rotation::write_diagnostic(format!(
		"ryu config: loaded {} non-secret override(s) from {} ({} reserved/secret skipped, {} explicit env value(s) kept)",
		report.applied,
		report.path.display(),
		report.ignored_reserved,
		report.ignored_environment
	));

    Ok(report)
}

fn is_valid_override_name(name: &str) -> bool {
    name.starts_with("RYU_")
        && name.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn flatten_settings(
    prefix: &[String],
    value: &Value,
    output: &mut BTreeMap<String, Value>,
) -> Result<()> {
    if let Value::Object(entries) = value {
        for (key, value) in entries {
            let mut child_prefix = prefix.to_vec();
            child_prefix.push(key.clone());
            flatten_settings(&child_prefix, value, output)?;
        }
        return Ok(());
    }

    let name = friendly_path_to_env_name(prefix);
    if !is_valid_override_name(&name) {
        bail!("friendly node config path cannot become a RYU_* setting");
    }
    output.insert(name, value.clone());
    Ok(())
}

fn friendly_path_to_env_name(path: &[String]) -> String {
    let mut segments = path.to_vec();
    match segments.first().map(String::as_str) {
        Some("models") | Some("features") | Some("integrations") => {
            segments.remove(0);
        }
        Some("voice") => {
            segments.remove(0);
        }
        // Recall tuning is grouped under `rag` in the file, but its readers
        // predate the group and use `RYU_AUTO_RECALL_*` and
        // `RYU_CONTEXT_MAX_TOKENS`. Other `rag` keys keep their `RYU_RAG_` prefix.
        Some("rag")
            if matches!(
                segments.get(1).map(String::as_str),
                Some("autoRecall" | "contextMaxTokens")
            ) =>
        {
            segments.remove(0);
        }
        Some("node") => {
            let node_key = segments.get(1).map(String::as_str);
            match node_key {
                Some("corsOrigins") => {
                    segments = vec!["corsOrigins".to_owned()];
                }
                Some("backendUrl") => {
                    segments = vec!["backendUrl".to_owned()];
                }
                Some("serverUrl") => {
                    segments = vec!["serverUrl".to_owned()];
                }
                Some("controlPlaneUrl") => {
                    segments = vec!["controlPlaneUrl".to_owned()];
                }
                Some("authBaseUrl") => {
                    segments = vec!["authBaseUrl".to_owned()];
                }
                _ => {}
            }
        }
        _ => {}
    }

    let suffix = segments
        .iter()
        .map(|segment| {
            let alias = match segment.as_str() {
                "embedding" => "embed",
                "localEmbedding" => "localEmbed",
                _ => segment,
            };
            camel_to_upper(alias)
        })
        .collect::<Vec<_>>()
        .join("_");
    format!("RYU_{suffix}")
}

fn camel_to_upper(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 4);
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() && index > 0 {
            output.push('_');
        }
        if character == '-' || character == ' ' {
            output.push('_');
        } else {
            output.push(character.to_ascii_uppercase());
        }
    }
    output
}

fn is_reserved_or_secret(name: &str) -> bool {
    if matches!(
        name,
        "RYU_PROFILE"
            | "RYU_DIR"
            | "RYU_BIND"
            | "RYU_TOKEN"
            | "RYU_MASTER_KEY"
            | "RYU_EXT_TOKEN"
            | "RYU_MESH_AUTHKEY"
    ) {
        return true;
    }

    // Sidecar ports and generated process bridges belong to manifest/runtime
    // wiring, not a hand-authored node config.
    if name.ends_with("_PORT") {
        return true;
    }

    name.ends_with("_API_KEY")
        || name.ends_with("_TOKEN")
        || name.ends_with("_SECRET")
        || name.ends_with("_PASSWORD")
        || name.ends_with("_PRIVATE_KEY")
        || name.ends_with("_AUTHKEY")
        || name.ends_with("_KEY")
}

fn value_to_env(value: &Value) -> Result<Option<String>> {
    let normalized = match value {
        Value::Null => return Ok(None),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => {
            let mut normalized = Vec::with_capacity(values.len());
            for value in values {
                if let Some(value) = value_to_scalar(value)? {
                    normalized.push(value);
                }
            }
            normalized.join(",")
        }
        Value::Object(_) => bail!("expected a string, boolean, number, or scalar array"),
    };
    Ok(Some(normalized))
}

fn value_to_scalar(value: &Value) -> Result<Option<String>> {
    match value {
        Value::Bool(value) => Ok(Some(value.to_string())),
        Value::Number(value) => Ok(Some(value.to_string())),
        Value::String(value) => Ok(Some(value.clone())),
        Value::Null => Ok(None),
        Value::Array(_) | Value::Object(_) => {
            bail!("array entries must be scalar JSON values")
        }
    }
}

#[cfg(test)]
mod tests;
