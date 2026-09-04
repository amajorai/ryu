//! Core's privileged consumer for GitHub-backed `.ryupack` releases.
//!
//! The control plane owns discovery, signatures, optional commerce, and the
//! short-lived GitHub App proxy. Core owns the last trust boundary: it fetches
//! the signed archive, verifies both digests, validates every ZIP entry, and only
//! then materialises a package on the node. Pricing never gates package bytes or
//! lifecycle; local enable/disable/uninstall continues to work.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

pub(crate) const PACKAGE_MANIFEST_FILE: &str = "ryu.package.json";
const LANGUAGE_PACK_ARTIFACT: &str = "language-pack.json";
const PACKAGE_SCHEMA_VERSION: u64 = 1;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES: u64 = 64 * 1024 * 1024;

const PACKAGE_KINDS: &[&str] = &[
    "app",
    "plugin",
    "skill",
    "agent",
    "workflow",
    "theme",
    "output_style",
    "space",
    "profile",
    "bundle",
    "language_pack",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PortablePackageSecurity {
    #[serde(default, rename = "containsSecrets")]
    pub contains_secrets: bool,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, rename = "privateContent")]
    pub private_content: bool,
    #[serde(default)]
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortablePackageManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub requires: BTreeMap<String, String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub security: PortablePackageSecurity,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct ExtractedPackage {
    pub manifest: PortablePackageManifest,
    pub manifest_value: Value,
    pub files: BTreeMap<String, Vec<u8>>,
    pub package_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPackage {
    pub id: String,
    pub kind: String,
    pub version: String,
    pub package_digest: String,
    pub enabled: bool,
    /// Host-owned ids created when this package is activated. Keeping these in
    /// the install record lets disable/uninstall remove only this package's
    /// derived records, even when the host assigns fresh ids (for example for
    /// imported agents).
    #[serde(default)]
    pub runtime_ids: Vec<String>,
    pub installed_at_unix_ms: u128,
}

fn package_root() -> PathBuf {
    crate::paths::ryu_dir().join("marketplace-packages")
}

fn package_key(id: &str) -> String {
    hex::encode(Sha256::digest(id.as_bytes()))
}

fn validate_kind(kind: &str) -> Result<()> {
    if PACKAGE_KINDS.contains(&kind) {
        Ok(())
    } else {
        bail!("unsupported portable package kind `{kind}`")
    }
}

fn package_dir(kind: &str, id: &str) -> PathBuf {
    package_root().join(kind).join(package_key(id))
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join(".ryu-install.json")
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(values) => {
            let body = values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let body = keys
                .into_iter()
                .filter_map(|key| {
                    values.get(key).map(|value| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()),
                            canonical_json(value)
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn normalized_digest(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("sha256:")
        .to_ascii_lowercase()
}

fn safe_relative_path(raw: &str) -> Result<String> {
    let path = raw.replace('\\', "/");
    if path.is_empty() || path.starts_with('/') {
        bail!("package archive contains an unsafe path `{raw}`");
    }
    let parts = path.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
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

fn validate_manifest(value: Value) -> Result<(PortablePackageManifest, Value)> {
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
        let raw_name = entry.name().to_owned();
        if entry.is_dir() || raw_name.ends_with('/') {
            continue;
        }
        let path = safe_relative_path(&raw_name)?;
        if entry.size() > MAX_FILE_BYTES {
            bail!("package archive entry `{path}` is too large");
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_TOTAL_FILE_BYTES {
            bail!("package archive expands beyond the total file limit");
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data)?;
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

/// Language packs are data-only overlays, not general portable packages. Keep
/// this gate at the shared Rust install boundary so Marketplace installs and
/// local imports cannot diverge on extra artifacts or executable grants.
fn validate_language_pack_package(extracted: &ExtractedPackage) -> Result<()> {
    if extracted.manifest.kind != "language_pack" {
        return Ok(());
    }
    if extracted.files.len() != 1
        || !extracted.files.contains_key(LANGUAGE_PACK_ARTIFACT)
        || extracted.manifest.artifacts.len() != 1
        || extracted.manifest.artifacts[0] != LANGUAGE_PACK_ARTIFACT
        || !extracted.manifest.capabilities.is_empty()
        || extracted.manifest.security.contains_secrets
        || extracted.manifest.security.private_content
        || !extracted.manifest.security.permissions.is_empty()
    {
        bail!(
            "language-pack packages must contain only language-pack.json and no capabilities or permissions"
        );
    }
    Ok(())
}

fn write_file(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

fn write_state(dir: &Path, record: &InstalledPackage) -> Result<()> {
    let temporary = dir.join(".ryu-install.json.tmp");
    let data = serde_json::to_vec_pretty(record)?;
    write_file(&temporary, &data)?;
    std::fs::rename(temporary, state_path(dir))?;
    Ok(())
}

fn read_state(dir: &Path) -> Result<InstalledPackage> {
    let data = std::fs::read(state_path(dir)).context("installed package state is missing")?;
    Ok(serde_json::from_slice(&data).context("installed package state is malformed")?)
}

pub fn install(
    kind: &str,
    id: &str,
    archive: &[u8],
    expected_package_digest: Option<&str>,
    expected_archive_digest: Option<&str>,
    expected_version: Option<&str>,
    update: bool,
) -> Result<InstalledPackage> {
    validate_kind(kind)?;
    let archive_digest = sha256_hex(archive);
    if let Some(expected) = expected_archive_digest.filter(|value| !value.trim().is_empty()) {
        if normalized_digest(expected) != archive_digest {
            bail!("GitHub release archive digest does not match the signed descriptor");
        }
    }
    let extracted = extract_archive(archive)?;
    validate_language_pack_package(&extracted)?;
    if extracted.manifest.kind != kind || extracted.manifest.id != id {
        bail!("package manifest identity does not match the marketplace listing");
    }
    if let Some(expected) = expected_version.filter(|value| !value.trim().is_empty()) {
        if expected.trim().trim_start_matches('v')
            != extracted.manifest.version.trim().trim_start_matches('v')
        {
            bail!("package version does not match the marketplace listing");
        }
    }
    if let Some(expected) = expected_package_digest.filter(|value| !value.trim().is_empty()) {
        if normalized_digest(expected) != extracted.package_digest {
            bail!("package digest does not match the signed GitHub source digest");
        }
    }

    let destination = package_dir(kind, id);
    let previous = if destination.exists() {
        if !update {
            bail!("portable package `{kind}/{id}` is already installed");
        }
        Some(destination.with_extension(format!("previous-{}", now_unix_ms())))
    } else {
        None
    };
    let root = package_root().join(kind);
    std::fs::create_dir_all(&root)?;
    let temporary = root.join(format!(".incoming-{}-{}", package_key(id), now_unix_ms()));
    if temporary.exists() {
        std::fs::remove_dir_all(&temporary)?;
    }
    std::fs::create_dir_all(&temporary)?;
    let manifest_bytes = format!("{}\n", canonical_json(&extracted.manifest_value));
    write_file(
        &temporary.join(PACKAGE_MANIFEST_FILE),
        manifest_bytes.as_bytes(),
    )?;
    for (path, data) in &extracted.files {
        write_file(&temporary.join(path), data)?;
    }
    let enabled = if destination.exists() {
        read_state(&destination)
            .map(|state| state.enabled)
            .unwrap_or(false)
    } else {
        false
    };
    let record = InstalledPackage {
        id: id.to_owned(),
        kind: kind.to_owned(),
        version: extracted.manifest.version,
        package_digest: extracted.package_digest,
        enabled,
        runtime_ids: Vec::new(),
        installed_at_unix_ms: now_unix_ms(),
    };
    write_state(&temporary, &record)?;
    if let Some(previous) = &previous {
        std::fs::rename(&destination, previous)?;
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        if let Some(previous) = &previous {
            let _ = std::fs::rename(previous, &destination);
        }
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error.into());
    }
    if let Some(previous) = previous {
        let _ = std::fs::remove_dir_all(previous);
    }
    Ok(record)
}

pub fn get(kind: &str, id: &str) -> Result<Option<InstalledPackage>> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    if !destination.exists() {
        return Ok(None);
    }
    Ok(Some(read_state(&destination)?))
}

/// Read the validated package manifest from an installed package.
pub fn manifest(kind: &str, id: &str) -> Result<Option<PortablePackageManifest>> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    if !destination.exists() {
        return Ok(None);
    }
    let data = std::fs::read(destination.join(PACKAGE_MANIFEST_FILE))
        .context("installed package manifest is missing")?;
    let value = serde_json::from_slice::<Value>(&data)
        .context("installed package manifest is not valid JSON")?;
    let (manifest, _) = validate_manifest(value)?;
    Ok(Some(manifest))
}

/// Read the validated package tree that was materialised by [`install`]. The
/// package state file is deliberately excluded; callers receive only the
/// signed artifact tree that host subsystems are allowed to activate.
pub fn artifact_files(kind: &str, id: &str) -> Result<BTreeMap<String, Vec<u8>>> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    if !destination.exists() {
        bail!("portable package `{kind}/{id}` is not installed");
    }
    let mut files = BTreeMap::new();
    let mut total_bytes = 0_u64;
    collect_artifact_files(&destination, &destination, &mut files, &mut total_bytes)?;
    Ok(files)
}

fn collect_artifact_files(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total_bytes: &mut u64,
) -> Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() {
            bail!("portable package contains a symlink: {}", path.display());
        }
        if file_type.is_dir() {
            collect_artifact_files(root, &path, files, total_bytes)?;
            continue;
        }
        if !file_type.is_file()
            || path.file_name().and_then(|name| name.to_str()) == Some(".ryu-install.json")
            || path.file_name().and_then(|name| name.to_str()) == Some(PACKAGE_MANIFEST_FILE)
        {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .context("portable package artifact escaped its root")?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let relative = safe_relative_path(&relative)?;
        let metadata = std::fs::metadata(&path)?;
        if metadata.len() > MAX_FILE_BYTES {
            bail!("portable package artifact `{relative}` is too large");
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > MAX_TOTAL_FILE_BYTES {
            bail!("portable package artifacts exceed the total file limit");
        }
        let data = std::fs::read(&path)?;
        if files.insert(relative.clone(), data).is_some() {
            bail!("portable package contains duplicate artifact `{relative}`");
        }
        if files.len() > MAX_FILES {
            bail!("portable package contains too many artifacts");
        }
    }
    Ok(())
}

/// Persist host-owned activation ids after a successful runtime registration.
pub fn set_runtime_ids(kind: &str, id: &str, runtime_ids: Vec<String>) -> Result<InstalledPackage> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    let mut record = read_state(&destination)
        .with_context(|| format!("portable package `{kind}/{id}` is not installed"))?;
    record.runtime_ids = runtime_ids;
    write_state(&destination, &record)?;
    Ok(record)
}

pub fn set_enabled(kind: &str, id: &str, enabled: bool) -> Result<InstalledPackage> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    let mut record = read_state(&destination)
        .with_context(|| format!("portable package `{kind}/{id}` is not installed"))?;
    record.enabled = enabled;
    write_state(&destination, &record)?;
    Ok(record)
}

pub fn uninstall(kind: &str, id: &str) -> Result<()> {
    validate_kind(kind)?;
    let destination = package_dir(kind, id);
    if !destination.exists() {
        bail!("portable package `{kind}/{id}` is not installed");
    }
    std::fs::remove_dir_all(destination)?;
    Ok(())
}

pub fn list() -> Result<Vec<InstalledPackage>> {
    let root = package_root();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut packages = Vec::new();
    for kind_entry in std::fs::read_dir(root)? {
        let kind_entry = kind_entry?;
        if !kind_entry.file_type()?.is_dir() {
            continue;
        }
        for package_entry in std::fs::read_dir(kind_entry.path())? {
            let package_entry = package_entry?;
            if !package_entry.file_type()?.is_dir() {
                continue;
            }
            if let Ok(record) = read_state(&package_entry.path()) {
                packages.push(record);
            }
        }
    }
    packages.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(packages)
}

#[cfg(test)]
mod tests {
    use super::{canonical_json, safe_relative_path, InstalledPackage};
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_object_keys_without_reordering_arrays() {
        let value = json!({ "z": 1, "a": { "b": true, "a": [2, 1] } });
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"a":[2,1],"b":true},"z":1}"#
        );
    }

    #[test]
    fn archive_paths_are_flat_and_traversal_safe() {
        assert_eq!(
            safe_relative_path("nested\\file.json").unwrap(),
            "nested/file.json"
        );
        assert!(safe_relative_path("../file.json").is_err());
        assert!(safe_relative_path("nested//file.json").is_err());
        assert!(safe_relative_path("/absolute").is_err());
    }

    #[test]
    fn installed_package_runtime_ids_are_backward_compatible() {
        let record: InstalledPackage = serde_json::from_value(serde_json::json!({
            "id": "demo",
            "kind": "agent",
            "version": "1.0.0",
            "package_digest": "abc",
            "enabled": false,
            "installed_at_unix_ms": 1
        }))
        .expect("legacy install state should deserialize");
        assert!(record.runtime_ids.is_empty());
    }
}
