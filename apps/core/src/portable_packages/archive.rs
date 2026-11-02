//! ZIP extraction and manifest validation for portable packages.
//!
//! Every archive entry name passes through [`safe_relative_path`] before it is
//! used as a key, hashed, or joined under the install directory. The check is
//! host-independent: a name that would be a drive prefix, root, alternate data
//! stream, or device on Windows is refused on every platform so a package that
//! installs on one node installs (or fails) identically on all of them.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path};

use anyhow::{bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::{
    canonical_json, ExtractedPackage, PortablePackageManifest, PortablePackageSecurity,
    MAX_ARCHIVE_BYTES, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_FILE_BYTES, PACKAGE_KINDS,
    PACKAGE_MANIFEST_FILE, PACKAGE_SCHEMA_VERSION,
};

/// Characters Windows refuses in a file name (besides `/` and `\`, which are
/// separators here). `:` matters most: it introduces a drive prefix (`C:`) or
/// an NTFS alternate data stream (`file:stream`).
const WINDOWS_FORBIDDEN_CHARS: &[char] = &[':', '<', '>', '"', '|', '?', '*'];

/// Windows device names, reserved with or without an extension.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn portable_component(part: &str) -> bool {
    if part.is_empty() || part == "." || part == ".." {
        return false;
    }
    if part
        .chars()
        .any(|value| value.is_control() || WINDOWS_FORBIDDEN_CHARS.contains(&value))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or(part).trim_end();
    !WINDOWS_RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Normalises an archive entry name to a `/`-separated relative path that is
/// guaranteed to stay under whatever directory it is later joined onto.
pub(super) fn safe_relative_path(raw: &str) -> Result<String> {
    let path = raw.replace('\\', "/");
    if path.is_empty() || path.starts_with('/') || !path.split('/').all(portable_component) {
        bail!("package archive contains an unsafe path `{raw}`");
    }
    // Belt and braces: the host's own path parser must agree that every
    // component is a plain name (no prefix, root, `.` or `..`).
    if !Path::new(&path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        bail!("package archive contains an unsafe path `{raw}`");
    }
    Ok(path)
}

fn string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>> {
    let Some(value) = value else {
        bail!("package manifest field `{field}` must be an array of strings");
    };
    let Some(values) = value.as_array() else {
        bail!("package manifest field `{field}` must be an array of strings");
    };
    values
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "package manifest field `{field}` must contain only non-empty strings"
                    )
                })
        })
        .collect()
}

pub(super) fn validate_manifest(value: Value) -> Result<(PortablePackageManifest, Value)> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("package manifest must be a JSON object"))?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(PACKAGE_SCHEMA_VERSION) {
        bail!("package manifest schemaVersion must be {PACKAGE_SCHEMA_VERSION}");
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| PACKAGE_KINDS.contains(value))
        .ok_or_else(|| anyhow::anyhow!("package manifest kind is unsupported"))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("package manifest id is required"))?;
    if !id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || "@._/-".contains(value))
        || id
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("package manifest id contains unsupported characters");
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("package manifest name is required"))?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("package manifest version is required"))?;
    let version_pattern = regex::Regex::new(r"^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")?;
    if !version_pattern.is_match(version) {
        bail!("package manifest version must be semver-like");
    }
    let artifacts = string_array(object.get("artifacts"), "artifacts")?;
    let targets = string_array(object.get("targets"), "targets")?;
    let scopes = string_array(object.get("scopes"), "scopes")?;
    for artifact in &artifacts {
        safe_relative_path(artifact)?;
    }
    let security = object
        .get("security")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let security: PortablePackageSecurity =
        serde_json::from_value(security).context("package manifest security is malformed")?;
    if security.contains_secrets || security.private_content {
        bail!("secret-bearing or private-content packages cannot be installed");
    }
    let manifest: PortablePackageManifest = serde_json::from_value(value.clone())
        .context("package manifest has an invalid field shape")?;
    if manifest.kind != kind
        || manifest.id != id
        || manifest.name != name
        || manifest.version != version
    {
        bail!("package manifest identity fields are malformed");
    }
    if manifest.artifacts != artifacts || manifest.targets != targets || manifest.scopes != scopes {
        bail!("package manifest array fields are malformed");
    }
    Ok((manifest, value))
}

pub fn extract_archive(bytes: &[u8]) -> Result<ExtractedPackage> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        bail!(
            "package archive exceeds the {} MiB limit",
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        );
    }
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).context("package archive is not a ZIP")?;
    if archive.len() > MAX_FILES + 1 {
        bail!("package archive contains too many files");
    }
    let mut manifest_value = None;
    let mut files = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .with_context(|| format!("reading package archive entry {index}"))?;
        let raw_name = entry
            .name()
            .with_context(|| format!("package archive entry {index} has an invalid name"))?
            .into_owned();
        if entry.is_dir() || raw_name.ends_with('/') {
            continue;
        }
        let path = safe_relative_path(&raw_name)?;
        if entry.size() > MAX_FILE_BYTES {
            bail!("package archive entry `{path}` is too large");
        }
        let remaining_total = MAX_TOTAL_FILE_BYTES.saturating_sub(total_bytes);
        let data = read_archive_file(&mut entry, &path, remaining_total)?;
        total_bytes = total_bytes.saturating_add(data.len() as u64);
        if total_bytes > MAX_TOTAL_FILE_BYTES {
            bail!("package archive expands beyond the total file limit");
        }
        if path == PACKAGE_MANIFEST_FILE {
            if manifest_value.is_some() {
                bail!("package archive contains duplicate {PACKAGE_MANIFEST_FILE}");
            }
            manifest_value = Some(
                serde_json::from_slice::<Value>(&data)
                    .context("package manifest is not valid JSON")?,
            );
        } else if files.insert(path.clone(), data).is_some() {
            bail!("package archive contains duplicate file `{path}`");
        }
    }
    let manifest_value = manifest_value
        .ok_or_else(|| anyhow::anyhow!("package archive is missing {PACKAGE_MANIFEST_FILE}"))?;
    let (manifest, manifest_value) = validate_manifest(manifest_value)?;
    for artifact in &manifest.artifacts {
        if !files.contains_key(artifact) {
            bail!("package artifact `{artifact}` is missing from the archive");
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{}\n", canonical_json(&manifest_value)).as_bytes());
    for (path, data) in &files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(data.len().to_string().as_bytes());
        hasher.update([0]);
        hasher.update(data);
    }
    Ok(ExtractedPackage {
        manifest,
        manifest_value,
        files,
        package_digest: hex::encode(hasher.finalize()),
    })
}

pub(super) fn read_archive_file(
    reader: &mut impl Read,
    path: &str,
    remaining_total: u64,
) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    reader
        .take(MAX_FILE_BYTES.min(remaining_total) + 1)
        .read_to_end(&mut data)?;
    if data.len() as u64 > MAX_FILE_BYTES {
        bail!("package archive entry `{path}` is too large");
    }
    if data.len() as u64 > remaining_total {
        bail!("package archive expands beyond the total file limit");
    }
    Ok(data)
}
