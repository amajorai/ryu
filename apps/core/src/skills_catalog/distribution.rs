use anyhow::{anyhow, bail, Context, Result};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions as CapOpenOptions},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub const INSTALL_TARGETS_PREF: &str = "skills.install-targets.v1";

const AGENT_TARGETS_JSON: &str = include_str!("agent_targets.json");
const LEDGER_FILE_NAME: &str = "skill-distribution.json";
const STAGE_PREFIX: &str = ".ryu-skill-stage-";
const BACKUP_PREFIX: &str = ".ryu-skill-backup-";
const MAX_PACKAGE_FILES: usize = 1_000;
const MAX_PACKAGE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PACKAGE_DIRECTORIES: usize = 1_000;
const MAX_PACKAGE_DEPTH: usize = 64;
const MAX_LEDGER_BYTES: u64 = 4 * 1024 * 1024;

static DISTRIBUTION_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DistributionTestHook {
    AfterTargetValidation,
    AfterRootHandleAcquisition,
    BeforeDestinationIsolation,
    AfterBackupRehash,
    BeforeLedgerWrite,
}

#[cfg(test)]
thread_local! {
    static DISTRIBUTION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(DistributionTestHook, &Path)>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
struct DistributionTestHookGuard;

#[cfg(test)]
impl Drop for DistributionTestHookGuard {
    fn drop(&mut self) {
        DISTRIBUTION_TEST_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

#[cfg(test)]
fn install_distribution_test_hook(
    hook: impl FnMut(DistributionTestHook, &Path) + 'static,
) -> DistributionTestHookGuard {
    DISTRIBUTION_TEST_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    DistributionTestHookGuard
}

#[cfg(test)]
fn invoke_distribution_test_hook(point: DistributionTestHook, path: &Path) {
    DISTRIBUTION_TEST_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(point, path);
        }
    });
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallPreferencesV1 {
    pub version: u8,
    pub configured: bool,
    pub target_ids: Vec<String>,
}

impl Default for SkillInstallPreferencesV1 {
    fn default() -> Self {
        Self {
            version: 1,
            configured: false,
            target_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetSelectionInput {
    #[serde(default)]
    pub prompt_for_targets: bool,
    pub target_ids: Option<Vec<String>>,
    #[serde(default)]
    pub remember_target_ids: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TargetSelectionRequired;

pub fn resolve_target_selection(
    preferences: &SkillInstallPreferencesV1,
    input: &SkillTargetSelectionInput,
) -> std::result::Result<Vec<String>, TargetSelectionRequired> {
    if let Some(target_ids) = &input.target_ids {
        return Ok(target_ids.clone());
    }
    if preferences.configured {
        return Ok(preferences.target_ids.clone());
    }
    if input.prompt_for_targets {
        return Err(TargetSelectionRequired);
    }
    Ok(Vec::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentTargetView {
    pub id: String,
    pub name: String,
    pub project_skills_dir: String,
    pub global_skills_dir: Option<String>,
    pub resolved_global_path: Option<String>,
    pub featured: bool,
    pub detected: bool,
    pub selectable: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedPreferences {
    pub preferences: SkillInstallPreferencesV1,
    pub dropped_target_ids: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DistributionStatus {
    Copied,
    Current,
    Conflict,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDistributionTargetResult {
    pub target_id: String,
    pub status: DistributionStatus,
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDistributionResult {
    pub skill_id: String,
    pub targets: Vec<SkillDistributionTargetResult>,
}

#[derive(Debug, Clone)]
pub struct DistributionContext {
    pub data_dir: PathBuf,
    pub home_dir: PathBuf,
    pub environment: HashMap<String, String>,
}

impl DistributionContext {
    pub fn current() -> Result<Self> {
        let home_dir = dirs::home_dir().context("home directory is unavailable")?;
        Ok(Self {
            data_dir: crate::paths::ryu_dir(),
            home_dir,
            environment: std::env::vars().collect(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct AgentTargetRegistry {
    targets: Vec<AgentTargetDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTargetDefinition {
    id: String,
    name: String,
    project_skills_dir: String,
    global_skills_dir: Option<String>,
    featured: bool,
}

#[derive(Debug)]
struct ResolvedGlobalTarget {
    path: PathBuf,
    trusted_anchor: PathBuf,
}

fn target_definitions() -> Result<Vec<AgentTargetDefinition>> {
    let registry: AgentTargetRegistry = serde_json::from_str(AGENT_TARGETS_JSON)
        .context("parsing the checked-in agent target registry")?;
    Ok(registry.targets)
}

pub fn list_agent_targets(
    home: &Path,
    environment: &HashMap<String, String>,
) -> Result<Vec<SkillAgentTargetView>> {
    let mut targets = target_definitions()?
        .into_iter()
        .map(|target| {
            let resolved = target
                .global_skills_dir
                .as_deref()
                .map(|template| resolve_global_template(template, home, environment))
                .transpose();
            let (resolved_global_path, detected, selectable, unavailable_reason) = match resolved {
                Ok(Some(resolved)) => {
                    let detected = resolved
                        .path
                        .parent()
                        .is_some_and(|config_parent| config_parent.is_dir());
                    (
                        Some(resolved.path.to_string_lossy().into_owned()),
                        detected,
                        true,
                        None,
                    )
                }
                Ok(None) => (
                    None,
                    false,
                    false,
                    Some("project-only target has no global skills directory".to_owned()),
                ),
                Err(error) => (None, false, false, Some(error.to_string())),
            };
            SkillAgentTargetView {
                id: target.id,
                name: target.name,
                project_skills_dir: target.project_skills_dir,
                global_skills_dir: target.global_skills_dir,
                resolved_global_path,
                featured: target.featured,
                detected,
                selectable,
                unavailable_reason,
            }
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| {
        right
            .featured
            .cmp(&left.featured)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(targets)
}

pub fn validate_target_ids(target_ids: &[String], targets: &[SkillAgentTargetView]) -> Result<()> {
    let by_id = targets
        .iter()
        .map(|target| (target.id.as_str(), target))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    for target_id in target_ids {
        if !seen.insert(target_id) {
            bail!("duplicate agent target id `{target_id}`");
        }
        let target = by_id
            .get(target_id.as_str())
            .with_context(|| format!("unknown agent target id `{target_id}`"))?;
        if !target.selectable {
            let reason = target
                .unavailable_reason
                .as_deref()
                .unwrap_or("target is unavailable");
            bail!("agent target `{target_id}` cannot be selected: {reason}");
        }
    }
    Ok(())
}

pub fn parse_preferences(raw: Option<&str>, targets: &[SkillAgentTargetView]) -> ParsedPreferences {
    let Some(raw) = raw else {
        return ParsedPreferences {
            preferences: SkillInstallPreferencesV1::default(),
            dropped_target_ids: Vec::new(),
            warning: None,
        };
    };
    let Ok(mut preferences) = serde_json::from_str::<SkillInstallPreferencesV1>(raw) else {
        return ParsedPreferences {
            preferences: SkillInstallPreferencesV1::default(),
            dropped_target_ids: Vec::new(),
            warning: Some("Saved install targets were malformed and have been reset.".to_owned()),
        };
    };
    if preferences.version != 1 {
        return ParsedPreferences {
            preferences: SkillInstallPreferencesV1::default(),
            dropped_target_ids: Vec::new(),
            warning: Some(format!(
                "Saved install targets use unsupported version {} and have been reset.",
                preferences.version
            )),
        };
    }

    let selectable = targets
        .iter()
        .filter(|target| target.selectable)
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    let mut seen = HashSet::new();
    for target_id in preferences.target_ids {
        if selectable.contains(target_id.as_str()) {
            if seen.insert(target_id.clone()) {
                kept.push(target_id);
            }
        } else if !dropped.contains(&target_id) {
            dropped.push(target_id);
        }
    }
    preferences.target_ids = kept;
    let warning = (!dropped.is_empty()).then(|| {
        format!(
            "Removed unavailable install targets: {}.",
            dropped.join(", ")
        )
    });
    ParsedPreferences {
        preferences,
        dropped_target_ids: dropped,
        warning,
    }
}

fn resolve_global_template(
    template: &str,
    home: &Path,
    environment: &HashMap<String, String>,
) -> Result<ResolvedGlobalTarget> {
    if let Some(suffix) = template.strip_prefix("~/") {
        let suffix = validate_template_suffix(suffix)?;
        return Ok(ResolvedGlobalTarget {
            path: home.join(suffix),
            trusted_anchor: home.to_path_buf(),
        });
    }

    let (variable, suffix) = if let Some(rest) = template.strip_prefix("${") {
        let (variable, suffix) = rest
            .split_once("}/")
            .with_context(|| format!("invalid global skills template `{template}`"))?;
        (variable, suffix)
    } else if let Some(rest) = template.strip_prefix('$') {
        rest.split_once('/')
            .with_context(|| format!("invalid global skills template `{template}`"))?
    } else {
        bail!("invalid global skills template `{template}`");
    };
    if variable.is_empty()
        || !variable
            .chars()
            .all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        bail!("invalid environment variable in global skills template `{template}`");
    }
    let suffix = validate_template_suffix(suffix)?;
    let base = environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("environment variable `{variable}` is not set"))?;
    let trusted_anchor = PathBuf::from(base);
    if !trusted_anchor.is_absolute() {
        bail!("environment variable `{variable}` must contain an absolute path");
    }
    Ok(ResolvedGlobalTarget {
        path: trusted_anchor.join(suffix),
        trusted_anchor,
    })
}

fn validate_template_suffix(suffix: &str) -> Result<PathBuf> {
    let suffix = Path::new(suffix);
    if suffix.as_os_str().is_empty()
        || suffix.is_absolute()
        || suffix
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("global skills template contains an unsafe path suffix");
    }
    Ok(suffix.components().collect())
}

#[derive(Debug)]
struct PackageFile {
    relative_path: String,
    bytes: Vec<u8>,
    mode: Option<u32>,
}

#[derive(Debug)]
struct SkillPackage {
    files: Vec<PackageFile>,
    generated_hash: String,
    source_root: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct DistributionLedger(BTreeMap<String, BTreeMap<String, DistributionLedgerEntry>>);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DistributionLedgerEntry {
    destination: String,
    generated_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_hash: Option<String>,
}

#[derive(Debug, Clone)]
struct RecoveryMetadata {
    path: String,
    hash: String,
}

enum RecoveryLedgerAction {
    Preserve,
    Clear,
    Set(RecoveryMetadata),
}

pub fn distribute_skill(
    context: &DistributionContext,
    skill_id: &str,
    source_skill_md: &Path,
    target_ids: &[String],
) -> Result<SkillDistributionResult> {
    validate_skill_id(skill_id)?;
    let targets = list_agent_targets(&context.home_dir, &context.environment)?;
    validate_target_ids(target_ids, &targets)?;
    let package = collect_source_package(context, skill_id, source_skill_md)?;
    let _guard = DISTRIBUTION_LOCK
        .lock()
        .map_err(|_| anyhow!("skill distribution lock is poisoned"))?;
    let ledger_path = context.data_dir.join(LEDGER_FILE_NAME);
    let mut ledger = load_ledger(&ledger_path)?;
    let definitions = target_definitions()?
        .into_iter()
        .map(|target| (target.id.clone(), target))
        .collect::<HashMap<_, _>>();
    let mut results = Vec::with_capacity(target_ids.len());
    let mut ledger_changed = false;
    let mut ledger_result_indices = Vec::new();

    for target_id in target_ids {
        let definition = definitions
            .get(target_id)
            .with_context(|| format!("agent target `{target_id}` disappeared from registry"))?;
        let template = definition
            .global_skills_dir
            .as_deref()
            .with_context(|| format!("agent target `{target_id}` is project-only"))?;
        let resolved = resolve_global_template(template, &context.home_dir, &context.environment)?;
        let destination = resolved.path.join(skill_id);
        let destination_string = destination.to_string_lossy().into_owned();

        let existing_entry = ledger
            .0
            .get(target_id)
            .and_then(|skills| skills.get(skill_id))
            .cloned();
        let recorded_recovery_paths = collect_recorded_recovery_paths(&ledger);
        let outcome = distribute_to_target(
            &package,
            &resolved,
            &destination,
            existing_entry.as_ref(),
            &recorded_recovery_paths,
        );
        let (status, message, records_generated_hash, recovery_action) = match outcome {
            Ok(outcome) => outcome,
            Err(error) => (
                DistributionStatus::Failed,
                Some(error.to_string()),
                false,
                RecoveryLedgerAction::Preserve,
            ),
        };
        let mut target_ledger_changed = false;
        if records_generated_hash {
            let recovery = match recovery_action {
                RecoveryLedgerAction::Preserve => existing_entry.as_ref().and_then(|entry| {
                    entry
                        .recovery_path
                        .as_ref()
                        .zip(entry.recovery_hash.as_ref())
                        .map(|(path, hash)| RecoveryMetadata {
                            path: path.clone(),
                            hash: hash.clone(),
                        })
                }),
                RecoveryLedgerAction::Clear => None,
                RecoveryLedgerAction::Set(recovery) => Some(recovery),
            };
            ledger.0.entry(target_id.clone()).or_default().insert(
                skill_id.to_owned(),
                DistributionLedgerEntry {
                    destination: destination_string.clone(),
                    generated_hash: package.generated_hash.clone(),
                    recovery_path: recovery.as_ref().map(|recovery| recovery.path.clone()),
                    recovery_hash: recovery.map(|recovery| recovery.hash),
                },
            );
            target_ledger_changed = true;
        } else if matches!(recovery_action, RecoveryLedgerAction::Clear) {
            if let Some(entry) = ledger
                .0
                .get_mut(target_id)
                .and_then(|skills| skills.get_mut(skill_id))
            {
                if entry.recovery_path.take().is_some() || entry.recovery_hash.take().is_some() {
                    target_ledger_changed = true;
                }
            }
        }
        if target_ledger_changed {
            ledger_changed = true;
            ledger_result_indices.push(results.len());
        }
        results.push(SkillDistributionTargetResult {
            target_id: target_id.clone(),
            status,
            path: Some(destination_string),
            message,
        });
    }

    if ledger_changed {
        #[cfg(test)]
        invoke_distribution_test_hook(DistributionTestHook::BeforeLedgerWrite, &ledger_path);
        if let Err(error) = write_ledger_atomic(&ledger_path, &ledger) {
            for index in ledger_result_indices {
                let result = &mut results[index];
                result.status = DistributionStatus::Failed;
                let ledger_error = format!(
                    "Package state changed, but the distribution ledger could not be updated: {error}"
                );
                result.message = Some(match result.message.take() {
                    Some(message) => format!("{message} {ledger_error}"),
                    None => ledger_error,
                });
            }
        }
    }
    Ok(SkillDistributionResult {
        skill_id: skill_id.to_owned(),
        targets: results,
    })
}

fn validate_skill_id(skill_id: &str) -> Result<()> {
    let mut components = Path::new(skill_id).components();
    if skill_id.is_empty()
        || skill_id.contains('\0')
        || skill_id.contains('\\')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        bail!("invalid skill id `{skill_id}`: expected one safe path component");
    }
    let normalized_id = skill_id.to_ascii_lowercase();
    if normalized_id.starts_with(STAGE_PREFIX) || normalized_id.starts_with(BACKUP_PREFIX) {
        bail!("invalid skill id `{skill_id}`: reserved distribution path");
    }
    Ok(())
}

fn collect_source_package(
    context: &DistributionContext,
    skill_id: &str,
    source_skill_md: &Path,
) -> Result<SkillPackage> {
    let metadata = fs::symlink_metadata(source_skill_md)
        .with_context(|| format!("reading source skill {}", source_skill_md.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("source SKILL.md cannot be a symlink");
    }
    if !metadata.is_file() {
        bail!("source skill is not a regular file");
    }

    let is_standard_package = source_uses_standard_layout(context, skill_id, source_skill_md)?;
    let (mut files, source_root) = if is_standard_package {
        let root = source_skill_md
            .parent()
            .context("source SKILL.md has no package directory")?;
        let mut files = Vec::new();
        let mut counters = PackageCounters::default();
        collect_directory_files(root, root, 0, &mut counters, &mut files)?;
        if !files.iter().any(|file| file.relative_path == "SKILL.md") {
            bail!("source package does not contain SKILL.md");
        }
        (files, Some(root.to_path_buf()))
    } else {
        let bytes = read_bounded_file(source_skill_md)?;
        (
            vec![PackageFile {
                relative_path: "SKILL.md".to_owned(),
                bytes,
                mode: regular_file_mode(&metadata),
            }],
            None,
        )
    };
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    ensure_unique_package_paths(&files)?;
    let generated_hash = hash_package(&files);
    Ok(SkillPackage {
        files,
        generated_hash,
        source_root,
    })
}

fn source_uses_standard_layout(
    context: &DistributionContext,
    skill_id: &str,
    source_skill_md: &Path,
) -> Result<bool> {
    let source = fs::canonicalize(source_skill_md)
        .with_context(|| format!("canonicalizing source skill {}", source_skill_md.display()))?;
    let source_parent = source
        .parent()
        .context("source skill has no parent directory")?;
    for (root, include_flat) in active_skill_scan_roots(context) {
        let Ok(root) = fs::canonicalize(&root) else {
            continue;
        };
        if source_parent == root {
            if include_flat
                && source.file_stem().and_then(OsStr::to_str) == Some(skill_id)
                && source.extension().and_then(OsStr::to_str) == Some("md")
            {
                return Ok(false);
            }
            bail!("source skill is not a valid entry in its active scan root");
        }
        let is_standard = source_parent.parent() == Some(root.as_path())
            && source_parent.file_name().and_then(OsStr::to_str) == Some(skill_id)
            && source
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"));
        if is_standard {
            return Ok(true);
        }
    }
    bail!(
        "source skill {} is outside the active skill scan roots",
        source_skill_md.display()
    )
}

fn active_skill_scan_roots(context: &DistributionContext) -> Vec<(PathBuf, bool)> {
    if let Some(root) = context.environment.get("RYU_SKILLS_DIR") {
        return vec![(PathBuf::from(root), true)];
    }
    vec![
        (context.home_dir.join(".claude/skills"), true),
        (context.home_dir.join(".agents/skills"), false),
    ]
}

#[derive(Default)]
struct PackageCounters {
    files: usize,
    directories: usize,
    total_bytes: u64,
}

fn collect_directory_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    counters: &mut PackageCounters,
    files: &mut Vec<PackageFile>,
) -> Result<()> {
    if depth > MAX_PACKAGE_DEPTH {
        bail!("source package exceeds the directory depth limit");
    }
    counters.directories += 1;
    if counters.directories > MAX_PACKAGE_DIRECTORIES {
        bail!("source package exceeds the directory count limit");
    }
    let mut entries = fs::read_dir(directory)
        .with_context(|| format!("reading source package directory {}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("reading source package entry {}", path.display()))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            bail!("source package contains symlink {}", path.display());
        }
        if file_type.is_dir() {
            collect_directory_files(root, &path, depth + 1, counters, files)?;
            continue;
        }
        if !file_type.is_file() {
            bail!("source package contains special file {}", path.display());
        }
        counters.files += 1;
        if counters.files > MAX_PACKAGE_FILES {
            bail!("source package exceeds the file count limit");
        }
        if metadata.len() > MAX_PACKAGE_FILE_BYTES {
            bail!(
                "source package file size limit exceeded by {}",
                path.display()
            );
        }
        let relative = path
            .strip_prefix(root)
            .context("source package entry escaped its root")?;
        let relative_path = normalized_relative_path(relative)?;
        let bytes = read_bounded_file(&path)?;
        counters.total_bytes = counters
            .total_bytes
            .checked_add(bytes.len() as u64)
            .context("source package total size overflow")?;
        if counters.total_bytes > MAX_PACKAGE_TOTAL_BYTES {
            bail!("source package exceeds the total size limit");
        }
        files.push(PackageFile {
            relative_path,
            bytes,
            mode: regular_file_mode(&metadata),
        });
    }
    Ok(())
}

fn normalized_relative_path(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            bail!("package contains an unsafe relative path");
        };
        let part = part.to_str().context("package path is not valid UTF-8")?;
        if part.is_empty() {
            bail!("package contains an empty path component");
        }
        parts.push(part);
    }
    if parts.is_empty() {
        bail!("package contains an empty relative path");
    }
    if parts.len() == 1 && parts[0].eq_ignore_ascii_case("SKILL.md") {
        return Ok("SKILL.md".to_owned());
    }
    Ok(parts.join("/"))
}

fn ensure_unique_package_paths(files: &[PackageFile]) -> Result<()> {
    for pair in files.windows(2) {
        if pair[0].relative_path == pair[1].relative_path {
            bail!("package contains duplicate path {}", pair[0].relative_path);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn regular_file_mode(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn regular_file_mode(_metadata: &fs::Metadata) -> Option<u32> {
    None
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_PACKAGE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() as u64 > MAX_PACKAGE_FILE_BYTES {
        bail!(
            "source package file size limit exceeded by {}",
            path.display()
        );
    }
    Ok(bytes)
}

fn hash_package(files: &[PackageFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        let path_bytes = file.relative_path.as_bytes();
        hasher.update((path_bytes.len() as u64).to_le_bytes());
        hasher.update(path_bytes);
        hasher.update((file.bytes.len() as u64).to_le_bytes());
        hasher.update(&file.bytes);
        #[cfg(unix)]
        hasher.update(file.mode.unwrap_or(0).to_le_bytes());
    }
    hex::encode(hasher.finalize())
}

fn distribute_to_target(
    package: &SkillPackage,
    target: &ResolvedGlobalTarget,
    destination: &Path,
    ledger_entry: Option<&DistributionLedgerEntry>,
    recorded_recovery_paths: &HashSet<PathBuf>,
) -> Result<(
    DistributionStatus,
    Option<String>,
    bool,
    RecoveryLedgerAction,
)> {
    let target_root = open_target_root_capability(target)?;
    #[cfg(test)]
    invoke_distribution_test_hook(
        DistributionTestHook::AfterRootHandleAcquisition,
        &target.path,
    );
    verify_target_root_capability_name(&target_root)?;
    if let Some(recovery_path) = find_unattributed_recovery(&target_root, recorded_recovery_paths)?
    {
        return Ok((
            DistributionStatus::Conflict,
            Some(format!(
                "An unrecorded recovery package is unresolved at {}; resolve or remove it before distributing this skill.",
                recovery_path.display()
            )),
            false,
            RecoveryLedgerAction::Preserve,
        ));
    }
    cleanup_interrupted_directories(&target_root)?;
    let recovery_state = inspect_recorded_recovery(&target_root, ledger_entry);
    if let RecordedRecoveryState::Invalid(message) = &recovery_state {
        return Ok((
            DistributionStatus::Conflict,
            Some(message.clone()),
            false,
            RecoveryLedgerAction::Preserve,
        ));
    }
    let recovery_action = if matches!(recovery_state, RecordedRecoveryState::Missing) {
        RecoveryLedgerAction::Clear
    } else {
        RecoveryLedgerAction::Preserve
    };
    let source_is_destination = fs::symlink_metadata(destination)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        && source_and_destination_are_equal(package, destination)?;
    let destination_name = destination
        .file_name()
        .context("skill destination has no filename")?;
    let mut authorized_destination_hash = None;
    let destination_metadata = match target_root.dir.symlink_metadata(destination_name) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("reading skill destination"),
    };
    if let Some(metadata) = destination_metadata {
        if metadata.file_type().is_symlink() {
            return Ok((
                DistributionStatus::Conflict,
                Some("Destination is a symlink; existing files were preserved.".to_owned()),
                false,
                recovery_action,
            ));
        }
        if !metadata.is_dir() {
            return Ok((
                DistributionStatus::Conflict,
                Some("Destination is not a directory; existing file was preserved.".to_owned()),
                false,
                recovery_action,
            ));
        }
        let destination_hash =
            match hash_capability_package(&target_root.dir, Path::new(destination_name)) {
                Ok(hash) => hash,
                Err(error) => {
                    return Ok((
                        DistributionStatus::Conflict,
                        Some(format!(
                            "Destination could not be validated and was preserved: {error}"
                        )),
                        false,
                        recovery_action,
                    ));
                }
            };
        if source_is_destination || destination_hash == package.generated_hash {
            let message = unresolved_recovery_message(&recovery_state, false);
            return Ok((DistributionStatus::Current, message, true, recovery_action));
        }
        if let Some(message) = unresolved_recovery_message(&recovery_state, true) {
            return Ok((
                DistributionStatus::Conflict,
                Some(message),
                false,
                RecoveryLedgerAction::Preserve,
            ));
        }
        let destination_string = destination.to_string_lossy();
        let generated_destination_is_unchanged = ledger_entry.is_some_and(|entry| {
            entry.destination == destination_string && entry.generated_hash == destination_hash
        });
        if !generated_destination_is_unchanged {
            return Ok((
                DistributionStatus::Conflict,
                Some("Destination has external changes; existing files were preserved.".to_owned()),
                false,
                recovery_action,
            ));
        }
        authorized_destination_hash = Some(destination_hash);
    } else if let Some(message) = unresolved_recovery_message(&recovery_state, true) {
        return Ok((
            DistributionStatus::Conflict,
            Some(message),
            false,
            RecoveryLedgerAction::Preserve,
        ));
    }

    match replace_with_staged_package(
        package,
        &target_root,
        destination_name,
        authorized_destination_hash.as_deref(),
    )? {
        StagedInstallOutcome::Installed(message, recovery) => Ok((
            DistributionStatus::Copied,
            message,
            true,
            recovery
                .map(RecoveryLedgerAction::Set)
                .unwrap_or(recovery_action),
        )),
        StagedInstallOutcome::Conflict(message, recovery) => {
            let records_generated_hash = recovery.is_some();
            Ok((
                DistributionStatus::Conflict,
                Some(message),
                records_generated_hash,
                recovery
                    .map(RecoveryLedgerAction::Set)
                    .unwrap_or(recovery_action),
            ))
        }
    }
}

fn collect_recorded_recovery_paths(ledger: &DistributionLedger) -> HashSet<PathBuf> {
    ledger
        .0
        .values()
        .flat_map(BTreeMap::values)
        .filter_map(|entry| match (&entry.recovery_path, &entry.recovery_hash) {
            (Some(path), Some(_)) => Some(PathBuf::from(path)),
            _ => None,
        })
        .collect()
}

fn find_unattributed_recovery(
    target: &TargetRootCapability,
    recorded_recovery_paths: &HashSet<PathBuf>,
) -> Result<Option<PathBuf>> {
    let mut entries = target.dir.entries()?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let is_valid_recovery = name
            .strip_prefix(BACKUP_PREFIX)
            .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok());
        if !is_valid_recovery {
            continue;
        }
        let recovery_path = target.display_path.join(name);
        if !recorded_recovery_paths.contains(&recovery_path) {
            return Ok(Some(recovery_path));
        }
    }
    Ok(None)
}

fn source_and_destination_are_equal(package: &SkillPackage, destination: &Path) -> Result<bool> {
    let Some(source_root) = package.source_root.as_deref() else {
        return Ok(false);
    };
    let source = fs::canonicalize(source_root)
        .with_context(|| format!("canonicalizing source package {}", source_root.display()))?;
    let destination = fs::canonicalize(destination)
        .with_context(|| format!("canonicalizing destination {}", destination.display()))?;
    Ok(source == destination)
}

struct TargetRootCapability {
    dir: Dir,
    display_path: PathBuf,
}

fn open_target_root_capability(target: &ResolvedGlobalTarget) -> Result<TargetRootCapability> {
    fs::create_dir_all(&target.trusted_anchor).with_context(|| {
        format!(
            "creating trusted target root {}",
            target.trusted_anchor.display()
        )
    })?;
    let anchor =
        Dir::open_ambient_dir(&target.trusted_anchor, ambient_authority()).with_context(|| {
            format!(
                "opening trusted target root {}",
                target.trusted_anchor.display()
            )
        })?;
    let relative = target
        .path
        .strip_prefix(&target.trusted_anchor)
        .context("target path escaped its trusted anchor")?;
    let relative = relative.components().collect::<PathBuf>();
    if relative.as_os_str().is_empty() {
        bail!("target path cannot equal its trusted anchor");
    }
    anchor.create_dir_all(&relative).with_context(|| {
        format!(
            "creating target root without following symlinks {}",
            target.path.display()
        )
    })?;
    #[cfg(test)]
    invoke_distribution_test_hook(DistributionTestHook::AfterTargetValidation, &target.path);
    let dir = anchor.open_dir(&relative).with_context(|| {
        format!(
            "opening target root handle without following escaping symlinks {}",
            target.path.display()
        )
    })?;
    let canonical = anchor
        .canonicalize(&relative)
        .with_context(|| format!("validating opened target root {}", target.path.display()))?;
    if canonical != relative {
        bail!("target root contains a symlink");
    }

    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt as CapMetadataExt;
        let path_metadata = anchor.metadata(&relative)?;
        let handle_metadata = dir.dir_metadata()?;
        if path_metadata.dev() != handle_metadata.dev()
            || path_metadata.ino() != handle_metadata.ino()
        {
            bail!("target root changed while its directory handle was opened");
        }
    }

    Ok(TargetRootCapability {
        dir,
        display_path: target.path.clone(),
    })
}

fn verify_target_root_capability_name(target: &TargetRootCapability) -> Result<()> {
    let path_metadata =
        fs::symlink_metadata(&target.display_path).context("rechecking opened target root path")?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        bail!("opened target root path changed after handle acquisition");
    }

    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt as CapMetadataExt;
        use std::os::unix::fs::MetadataExt as StdMetadataExt;
        let handle_metadata = target.dir.dir_metadata()?;
        if path_metadata.dev() != handle_metadata.dev()
            || path_metadata.ino() != handle_metadata.ino()
        {
            bail!("opened target root path changed after handle acquisition");
        }
    }

    Ok(())
}

enum RecordedRecoveryState {
    None,
    Missing,
    Unresolved(RecoveryMetadata),
    Invalid(String),
}

fn inspect_recorded_recovery(
    target: &TargetRootCapability,
    ledger_entry: Option<&DistributionLedgerEntry>,
) -> RecordedRecoveryState {
    let Some(entry) = ledger_entry else {
        return RecordedRecoveryState::None;
    };
    let (path, hash) = match (&entry.recovery_path, &entry.recovery_hash) {
        (None, None) => return RecordedRecoveryState::None,
        (Some(path), Some(hash)) => (path, hash),
        _ => {
            return RecordedRecoveryState::Invalid(
                "Distribution recovery metadata is incomplete; resolve the ledger entry before updating."
                    .to_owned(),
            );
        }
    };
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return RecordedRecoveryState::Invalid(
            "Distribution recovery metadata has an invalid hash; resolve the ledger entry before updating."
                .to_owned(),
        );
    }
    let recovery_path = Path::new(path);
    let Some(name) = recovery_path.file_name().and_then(OsStr::to_str) else {
        return RecordedRecoveryState::Invalid(
            "Distribution recovery metadata has an invalid path; resolve the ledger entry before updating."
                .to_owned(),
        );
    };
    let valid_name = name
        .strip_prefix(BACKUP_PREFIX)
        .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok());
    if !valid_name
        || recovery_path.parent() != Some(target.display_path.as_path())
        || target.display_path.join(name) != recovery_path
    {
        return RecordedRecoveryState::Invalid(format!(
            "Distribution recovery metadata points outside the registered target root: {path}. Resolve the ledger entry before updating."
        ));
    }
    match target.dir.symlink_metadata(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            RecordedRecoveryState::Missing
        }
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            if let Err(error) = hash_capability_package(&target.dir, Path::new(name)) {
                return RecordedRecoveryState::Invalid(format!(
                    "Distribution recovery metadata could not be validated at {path}: {error}"
                ));
            }
            RecordedRecoveryState::Unresolved(RecoveryMetadata {
                path: path.clone(),
                hash: hash.clone(),
            })
        }
        Ok(_) => RecordedRecoveryState::Invalid(format!(
            "Distribution recovery metadata does not name a regular package directory: {path}"
        )),
        Err(error) => RecordedRecoveryState::Invalid(format!(
            "Distribution recovery metadata could not be read at {path}: {error}"
        )),
    }
}

fn unresolved_recovery_message(
    state: &RecordedRecoveryState,
    blocks_update: bool,
) -> Option<String> {
    let RecordedRecoveryState::Unresolved(recovery) = state else {
        return None;
    };
    if blocks_update {
        Some(format!(
            "A recovery package is still unresolved at {}; resolve or remove it before updating this skill.",
            recovery.path
        ))
    } else {
        Some(format!(
            "An unresolved recovery package remains at {}. Resolve or remove it before a later update.",
            recovery.path
        ))
    }
}

fn hash_capability_package(root: &Dir, relative: &Path) -> Result<String> {
    let directory = root
        .open_dir(relative)
        .context("opening destination package through target capability")?;
    let mut files = Vec::new();
    let mut counters = PackageCounters::default();
    collect_capability_directory_files(&directory, Path::new(""), 0, &mut counters, &mut files)?;
    if !files.iter().any(|file| file.relative_path == "SKILL.md") {
        bail!("destination package does not contain SKILL.md");
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    ensure_unique_package_paths(&files)?;
    Ok(hash_package(&files))
}

fn collect_capability_directory_files(
    directory: &Dir,
    relative_directory: &Path,
    depth: usize,
    counters: &mut PackageCounters,
    files: &mut Vec<PackageFile>,
) -> Result<()> {
    if depth > MAX_PACKAGE_DEPTH {
        bail!("destination package exceeds the directory depth limit");
    }
    counters.directories += 1;
    if counters.directories > MAX_PACKAGE_DIRECTORIES {
        bail!("destination package exceeds the directory count limit");
    }
    let mut entries = directory.entries()?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type()?;
        let relative = relative_directory.join(entry.file_name());
        if file_type.is_symlink() {
            bail!("destination package contains a symlink");
        }
        if file_type.is_dir() {
            let child = entry.open_dir()?;
            collect_capability_directory_files(&child, &relative, depth + 1, counters, files)?;
            continue;
        }
        if !file_type.is_file() {
            bail!("destination package contains a special file");
        }
        counters.files += 1;
        if counters.files > MAX_PACKAGE_FILES {
            bail!("destination package exceeds the file count limit");
        }
        let mut file = entry.open()?;
        let metadata = file.metadata()?;
        if metadata.len() > MAX_PACKAGE_FILE_BYTES {
            bail!("destination package exceeds the file size limit");
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_PACKAGE_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_PACKAGE_FILE_BYTES {
            bail!("destination package exceeds the file size limit");
        }
        counters.total_bytes = counters
            .total_bytes
            .checked_add(bytes.len() as u64)
            .context("destination package total size overflow")?;
        if counters.total_bytes > MAX_PACKAGE_TOTAL_BYTES {
            bail!("destination package exceeds the total size limit");
        }
        files.push(PackageFile {
            relative_path: normalized_relative_path(&relative)?,
            bytes,
            mode: capability_file_mode(&metadata),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn capability_file_mode(metadata: &cap_std::fs::Metadata) -> Option<u32> {
    use cap_std::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn capability_file_mode(_metadata: &cap_std::fs::Metadata) -> Option<u32> {
    None
}

fn cleanup_interrupted_directories(target: &TargetRootCapability) -> Result<()> {
    for entry in target.dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let is_valid_stage = name
            .strip_prefix(STAGE_PREFIX)
            .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok());
        if is_valid_stage {
            remove_capability_path(&target.dir, Path::new(name))?;
        }
    }
    Ok(())
}

fn remove_capability_path(root: &Dir, path: &Path) -> Result<()> {
    let metadata = root.symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        root.remove_dir_all(path)?;
    } else {
        root.remove_file(path)?;
    }
    Ok(())
}

enum StagedInstallOutcome {
    Installed(Option<String>, Option<RecoveryMetadata>),
    Conflict(String, Option<RecoveryMetadata>),
}

fn replace_with_staged_package(
    package: &SkillPackage,
    target: &TargetRootCapability,
    destination_name: &OsStr,
    authorized_destination_hash: Option<&str>,
) -> Result<StagedInstallOutcome> {
    let destination = PathBuf::from(destination_name);
    let operation_id = uuid::Uuid::new_v4();
    let stage = PathBuf::from(format!("{STAGE_PREFIX}{operation_id}"));
    let backup = PathBuf::from(format!("{BACKUP_PREFIX}{operation_id}"));
    target
        .dir
        .create_dir(&stage)
        .with_context(|| format!("creating package stage {}", stage.display()))?;

    let stage_result = (|| -> Result<StagedInstallOutcome> {
        for file in package
            .files
            .iter()
            .filter(|file| file.relative_path != "SKILL.md")
            .chain(
                package
                    .files
                    .iter()
                    .filter(|file| file.relative_path == "SKILL.md"),
            )
        {
            let output = stage.join(&file.relative_path);
            let output_parent = output.parent().context("staged file has no parent")?;
            target.dir.create_dir_all(output_parent)?;
            let mut options = CapOpenOptions::new();
            options.write(true).create_new(true);
            let mut output_file = target
                .dir
                .open_with(&output, &options)
                .with_context(|| format!("creating staged package file {}", output.display()))?;
            output_file
                .write_all(&file.bytes)
                .with_context(|| format!("writing staged package file {}", output.display()))?;
            apply_capability_file_mode(&output_file, file.mode)?;
        }

        let destination_exists = match target.dir.symlink_metadata(&destination) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
            Ok(_) => {
                return Ok(StagedInstallOutcome::Conflict(
                    "Destination changed type during installation; existing path was preserved."
                        .to_owned(),
                    None,
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).context("rechecking skill destination"),
        };
        if destination_exists {
            let Some(authorized_destination_hash) = authorized_destination_hash else {
                return Ok(StagedInstallOutcome::Conflict(
                    "Destination appeared during installation; existing files were preserved."
                        .to_owned(),
                    None,
                ));
            };
            #[cfg(test)]
            invoke_distribution_test_hook(
                DistributionTestHook::BeforeDestinationIsolation,
                &target.display_path.join(&destination),
            );
            target
                .dir
                .rename(&destination, &target.dir, &backup)
                .with_context(|| {
                    format!(
                        "moving existing destination {} aside",
                        target.display_path.join(&destination).display()
                    )
                })?;
            let isolated_hash = match hash_capability_package(&target.dir, &backup) {
                Ok(hash) => hash,
                Err(error) => {
                    restore_isolated_destination(target, &backup, &destination)?;
                    return Ok(StagedInstallOutcome::Conflict(
                        format!(
                            "Destination changed while being isolated and was restored: {error}"
                        ),
                        None,
                    ));
                }
            };
            if isolated_hash != authorized_destination_hash {
                restore_isolated_destination(target, &backup, &destination)?;
                return Ok(StagedInstallOutcome::Conflict(
                    "Destination changed during installation; the external edit was restored."
                        .to_owned(),
                    None,
                ));
            }
            #[cfg(test)]
            invoke_distribution_test_hook(
                DistributionTestHook::AfterBackupRehash,
                &target.display_path.join(&backup),
            );
            if target.dir.symlink_metadata(&destination).is_ok() {
                bail!(
                    "destination reappeared during installation; previous package preserved at {}",
                    target.display_path.join(&backup).display()
                );
            }
            if let Err(error) = target.dir.rename(&stage, &target.dir, &destination) {
                let restore_result = restore_isolated_destination(target, &backup, &destination);
                return match restore_result {
                    Ok(()) => Err(error).context("installing staged skill package"),
                    Err(restore_error) => Err(anyhow!(
                        "installing staged skill package failed ({error}); restoring the previous package also failed ({restore_error})"
                    )),
                };
            }
            let final_isolated_hash = hash_capability_package(&target.dir, &backup)?;
            let recovery = RecoveryMetadata {
                path: target
                    .display_path
                    .join(&backup)
                    .to_string_lossy()
                    .into_owned(),
                hash: final_isolated_hash.clone(),
            };
            if final_isolated_hash != authorized_destination_hash {
                return Ok(StagedInstallOutcome::Conflict(
                    format!(
                        "Destination changed after isolation; generated package installed and external bytes preserved at recovery copy: {}",
                        recovery.path
                    ),
                    Some(recovery),
                ));
            }
            return Ok(StagedInstallOutcome::Installed(
                Some(format!(
                    "Previous generated version retained at recovery copy: {}",
                    recovery.path
                )),
                Some(recovery),
            ));
        } else {
            if authorized_destination_hash.is_some() {
                bail!("authorized destination disappeared during installation");
            }
            if target.dir.symlink_metadata(&destination).is_ok() {
                return Ok(StagedInstallOutcome::Conflict(
                    "Destination appeared during installation; existing files were preserved."
                        .to_owned(),
                    None,
                ));
            }
            target
                .dir
                .rename(&stage, &target.dir, &destination)
                .with_context(|| {
                    format!(
                        "installing package at {}",
                        target.display_path.join(&destination).display()
                    )
                })?;
        }
        Ok(StagedInstallOutcome::Installed(None, None))
    })();

    if !matches!(&stage_result, Ok(StagedInstallOutcome::Installed(_, _))) {
        let _ = remove_capability_path(&target.dir, &stage);
    }
    stage_result
}

fn restore_isolated_destination(
    target: &TargetRootCapability,
    backup: &Path,
    destination: &Path,
) -> Result<()> {
    match target.dir.symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => target
            .dir
            .rename(backup, &target.dir, destination)
            .context("restoring isolated destination"),
        Ok(_) => bail!(
            "destination reappeared; isolated previous package preserved at {}",
            target.display_path.join(backup).display()
        ),
        Err(error) => Err(error).context("rechecking destination before restore"),
    }
}

#[cfg(unix)]
fn apply_capability_file_mode(file: &cap_std::fs::File, mode: Option<u32>) -> Result<()> {
    use cap_std::fs::PermissionsExt;
    if let Some(mode) = mode {
        file.set_permissions(cap_std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_capability_file_mode(_file: &cap_std::fs::File, _mode: Option<u32>) -> Result<()> {
    Ok(())
}

fn load_ledger(path: &Path) -> Result<DistributionLedger> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DistributionLedger::default());
        }
        Err(error) => return Err(error).context("reading distribution ledger metadata"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("distribution ledger is not a regular file");
    }
    if metadata.len() > MAX_LEDGER_BYTES {
        bail!("distribution ledger exceeds the size limit");
    }
    let mut bytes = Vec::new();
    File::open(path)
        .context("opening distribution ledger")?
        .take(MAX_LEDGER_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("reading distribution ledger")?;
    if bytes.len() as u64 > MAX_LEDGER_BYTES {
        bail!("distribution ledger exceeds the size limit");
    }
    serde_json::from_slice(&bytes).context("parsing distribution ledger")
}

fn write_ledger_atomic(path: &Path, ledger: &DistributionLedger) -> Result<()> {
    let parent = path.parent().context("distribution ledger has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("creating distribution data directory {}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(ledger).context("serializing distribution ledger")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .context("creating temporary distribution ledger")?;
    temporary
        .write_all(&bytes)
        .context("writing temporary distribution ledger")?;
    temporary
        .as_file()
        .sync_all()
        .context("syncing temporary distribution ledger")?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .context("atomically replacing distribution ledger")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixListener,
    };
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    const SKILL_MD: &str = "---\nname: Demo\n---\nUse it.\n";

    #[test]
    fn resolve_target_selection_requires_an_unconfigured_prompt_aware_choice() {
        let preferences = SkillInstallPreferencesV1::default();
        let input = SkillTargetSelectionInput {
            prompt_for_targets: true,
            ..Default::default()
        };

        assert_eq!(
            resolve_target_selection(&preferences, &input),
            Err(TargetSelectionRequired)
        );
    }

    #[test]
    fn resolve_target_selection_keeps_legacy_unconfigured_installs_canonical_only() {
        let preferences = SkillInstallPreferencesV1::default();

        assert_eq!(
            resolve_target_selection(&preferences, &SkillTargetSelectionInput::default()),
            Ok(Vec::<String>::new())
        );
    }

    #[test]
    fn resolve_target_selection_uses_configured_defaults_without_prompting() {
        let preferences = SkillInstallPreferencesV1 {
            version: 1,
            configured: true,
            target_ids: vec!["codex".to_owned(), "claude-code".to_owned()],
        };

        assert_eq!(
            resolve_target_selection(&preferences, &SkillTargetSelectionInput::default()),
            Ok(vec!["codex".to_owned(), "claude-code".to_owned()])
        );
    }

    #[test]
    fn resolve_target_selection_treats_configured_empty_as_a_real_default() {
        let preferences = SkillInstallPreferencesV1 {
            version: 1,
            configured: true,
            target_ids: Vec::new(),
        };

        assert_eq!(
            resolve_target_selection(&preferences, &SkillTargetSelectionInput::default()),
            Ok(Vec::<String>::new())
        );
    }

    #[test]
    fn resolve_target_selection_prefers_explicit_ids_over_configured_defaults() {
        let preferences = SkillInstallPreferencesV1 {
            version: 1,
            configured: true,
            target_ids: vec!["claude-code".to_owned()],
        };
        let input = SkillTargetSelectionInput {
            prompt_for_targets: true,
            target_ids: Some(vec!["codex".to_owned()]),
            remember_target_ids: true,
        };

        assert_eq!(
            resolve_target_selection(&preferences, &input),
            Ok(vec!["codex".to_owned()])
        );
    }

    fn test_targets() -> Vec<SkillAgentTargetView> {
        let home = TempDir::new().expect("home");
        list_agent_targets(home.path(), &HashMap::new()).expect("targets")
    }

    #[test]
    fn missing_preferences_are_unconfigured() {
        let parsed = parse_preferences(None, &test_targets());

        assert_eq!(parsed.preferences, SkillInstallPreferencesV1::default());
        assert!(parsed.dropped_target_ids.is_empty());
        assert!(parsed.warning.is_none());
    }

    #[test]
    fn malformed_preferences_fall_back_with_a_warning() {
        let parsed = parse_preferences(Some("not json"), &test_targets());

        assert_eq!(parsed.preferences, SkillInstallPreferencesV1::default());
        assert!(parsed.warning.is_some());
    }

    #[test]
    fn configured_empty_is_distinct_from_missing() {
        let targets = test_targets();
        assert!(!parse_preferences(None, &targets).preferences.configured);
        let parsed = parse_preferences(
            Some(r#"{"version":1,"configured":true,"targetIds":[]}"#),
            &targets,
        );
        assert!(parsed.preferences.configured);
        assert!(parsed.preferences.target_ids.is_empty());
    }

    #[test]
    fn configured_list_preserves_known_selectable_ids_and_drops_unknown_ids() {
        let parsed = parse_preferences(
            Some(
                r#"{"version":1,"configured":true,"targetIds":["codex","missing","eve","codex"]}"#,
            ),
            &test_targets(),
        );

        assert_eq!(parsed.preferences.target_ids, ["codex"]);
        assert_eq!(parsed.dropped_target_ids, ["missing", "eve"]);
        assert!(parsed.warning.is_some());
    }

    #[test]
    fn agent_targets_put_featured_agents_first_and_resolve_only_registry_paths() {
        let home = TempDir::new().expect("home");
        fs::create_dir_all(home.path().join(".codex")).expect("config parent");

        let targets = list_agent_targets(home.path(), &HashMap::new()).expect("targets");
        let first_non_featured = targets
            .iter()
            .position(|target| !target.featured)
            .expect("non-featured target");
        assert!(targets[..first_non_featured]
            .iter()
            .all(|target| target.featured));
        let codex = targets
            .iter()
            .find(|target| target.id == "codex")
            .expect("codex");
        assert_eq!(
            codex.resolved_global_path.as_deref(),
            Some(home.path().join(".codex/skills").to_string_lossy().as_ref())
        );
        assert!(codex.detected);
        assert!(codex.selectable);
    }

    #[test]
    fn project_only_target_cannot_be_selected_globally() {
        let error = validate_target_ids(&["eve".to_owned()], &test_targets()).unwrap_err();
        assert!(error.to_string().contains("project-only"));
    }

    #[test]
    fn duplicate_target_paths_are_resolved_identically() {
        let home = TempDir::new().expect("home");
        let targets = list_agent_targets(home.path(), &HashMap::new()).expect("targets");
        let cline = targets
            .iter()
            .find(|target| target.id == "cline")
            .expect("cline");
        let dexto = targets
            .iter()
            .find(|target| target.id == "dexto")
            .expect("dexto");

        assert_eq!(cline.resolved_global_path, dexto.resolved_global_path);
        validate_target_ids(&["cline".to_owned(), "dexto".to_owned()], &targets)
            .expect("duplicate roots are valid agent aliases");
    }

    struct DistributionFixture {
        root: TempDir,
        source_dir: PathBuf,
        context: DistributionContext,
    }

    impl DistributionFixture {
        fn new() -> Self {
            let root = TempDir::new().expect("fixture root");
            let source_dir = root.path().join("source/demo");
            let environment = HashMap::from([(
                "RYU_SKILLS_DIR".to_owned(),
                root.path().join("source").to_string_lossy().into_owned(),
            )]);
            let context = DistributionContext {
                data_dir: root.path().join("data"),
                home_dir: root.path().join("home"),
                environment,
            };
            Self {
                root,
                source_dir,
                context,
            }
        }

        fn source_skill_md(&self) -> PathBuf {
            self.source_dir.join("SKILL.md")
        }

        fn write_source(&self, relative: &str, contents: &str) {
            write_file(&self.source_dir.join(relative), contents);
        }

        fn target_root(&self, target_id: &str) -> PathBuf {
            let targets = list_agent_targets(&self.context.home_dir, &self.context.environment)
                .expect("targets");
            PathBuf::from(
                targets
                    .iter()
                    .find(|target| target.id == target_id)
                    .and_then(|target| target.resolved_global_path.as_ref())
                    .expect("global target"),
            )
        }

        fn target_dir(&self, target_id: &str) -> PathBuf {
            self.target_root(target_id).join("demo")
        }

        fn write_target(&self, target_id: &str, relative: &str, contents: &str) {
            write_file(&self.target_dir(target_id).join(relative), contents);
        }

        fn read_target(&self, target_id: &str, relative: &str) -> String {
            fs::read_to_string(self.target_dir(target_id).join(relative)).expect("target file")
        }

        fn distribute(&self, target_ids: &[&str]) -> SkillDistributionResult {
            let target_ids = target_ids
                .iter()
                .map(|target| (*target).to_owned())
                .collect::<Vec<_>>();
            distribute_skill(&self.context, "demo", &self.source_skill_md(), &target_ids)
                .expect("distribution")
        }

        fn stage_dirs(&self, target_id: &str) -> Vec<PathBuf> {
            let root = self.target_root(target_id);
            fs::read_dir(root)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(".ryu-skill-stage-"))
                })
                .collect()
        }

        fn recovery_dirs(&self, target_id: &str) -> Vec<PathBuf> {
            let root = self.target_root(target_id);
            fs::read_dir(root)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(".ryu-skill-backup-"))
                })
                .collect()
        }

        fn ledger_value(&self) -> serde_json::Value {
            serde_json::from_slice(
                &fs::read(self.context.data_dir.join("skill-distribution.json")).expect("ledger"),
            )
            .expect("ledger json")
        }
    }

    fn write_file(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn copies_the_complete_package_and_preserves_external_changes() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.write_source("scripts/run.sh", "#!/bin/sh\necho ok\n");
        fixture.write_source("references/guide.md", "guide\n");

        let first = fixture.distribute(&["codex"]);
        assert_eq!(first.targets[0].status, DistributionStatus::Copied);
        assert_eq!(
            fixture.read_target("codex", "scripts/run.sh"),
            "#!/bin/sh\necho ok\n"
        );

        fixture.write_target("codex", "scripts/run.sh", "external edit\n");
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated.\n");
        let second = fixture.distribute(&["codex"]);
        assert_eq!(second.targets[0].status, DistributionStatus::Conflict);
        assert_eq!(
            fixture.read_target("codex", "scripts/run.sh"),
            "external edit\n"
        );
    }

    #[test]
    fn replaces_an_unchanged_generated_package_when_the_source_updates() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        assert_eq!(
            fixture.distribute(&["codex"]).targets[0].status,
            DistributionStatus::Copied
        );

        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated.\n");
        let updated = fixture.distribute(&["codex"]);

        assert_eq!(updated.targets[0].status, DistributionStatus::Copied);
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated."));
    }

    #[test]
    fn edit_between_authorization_and_isolation_is_restored_as_a_conflict() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated.\n");
        let _hook = install_distribution_test_hook(|point, destination| {
            if point == DistributionTestHook::BeforeDestinationIsolation {
                fs::write(destination.join("SKILL.md"), "external race edit\n").expect("race edit");
            }
        });

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Conflict);
        assert_eq!(
            fixture.read_target("codex", "SKILL.md"),
            "external race edit\n"
        );
    }

    #[test]
    fn edit_after_backup_rehash_is_preserved_in_a_recovery_backup() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated.\n");
        let mut open_writer = fs::OpenOptions::new()
            .write(true)
            .open(fixture.target_dir("codex").join("SKILL.md"))
            .expect("open destination writer");
        let _hook = install_distribution_test_hook(move |point, _backup| {
            if point == DistributionTestHook::AfterBackupRehash {
                open_writer.set_len(0).expect("truncate through held fd");
                open_writer
                    .write_all(b"late external edit\n")
                    .expect("late edit through held fd");
            }
        });

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Conflict);
        let message = result.targets[0].message.as_deref().expect("recovery path");
        let recovery_path = message
            .split("recovery copy: ")
            .nth(1)
            .expect("recovery path in message");
        assert_eq!(
            fs::read_to_string(Path::new(recovery_path).join("SKILL.md"))
                .expect("late edit recovery"),
            "late external edit\n"
        );
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated."));
    }

    #[test]
    fn first_generated_update_records_one_recovery_and_current_surfaces_it() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated once.\n");

        let updated = fixture.distribute(&["codex"]);
        let ledger = fixture.ledger_value();
        let recovery_path = ledger["codex"]["demo"]["recoveryPath"]
            .as_str()
            .expect("recorded recovery path");
        let recovery_hash = ledger["codex"]["demo"]["recoveryHash"]
            .as_str()
            .expect("recorded recovery hash");
        let current = fixture.distribute(&["codex"]);

        assert_eq!(updated.targets[0].status, DistributionStatus::Copied);
        assert_eq!(fixture.recovery_dirs("codex").len(), 1);
        assert!(Path::new(recovery_path).is_dir());
        assert_eq!(recovery_hash.len(), 64);
        assert_eq!(current.targets[0].status, DistributionStatus::Current);
        assert!(current.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains(recovery_path)));
    }

    #[test]
    fn second_generated_update_is_blocked_while_recorded_recovery_exists() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated once.\n");
        fixture.distribute(&["codex"]);
        let first_recovery = fixture.recovery_dirs("codex")[0].clone();
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated twice.\n");

        let blocked = fixture.distribute(&["codex"]);

        assert_eq!(blocked.targets[0].status, DistributionStatus::Conflict);
        assert!(blocked.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("resolve or remove")));
        assert_eq!(fixture.recovery_dirs("codex"), [first_recovery]);
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated once."));
    }

    #[test]
    fn removing_recorded_recovery_allows_one_new_recovery_on_next_update() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated once.\n");
        fixture.distribute(&["codex"]);
        let first_recovery = fixture.recovery_dirs("codex")[0].clone();
        fs::remove_dir_all(&first_recovery).expect("manual recovery resolution");
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated twice.\n");

        let updated = fixture.distribute(&["codex"]);
        let recovery_dirs = fixture.recovery_dirs("codex");
        let ledger = fixture.ledger_value();
        let next_recovery = PathBuf::from(
            ledger["codex"]["demo"]["recoveryPath"]
                .as_str()
                .expect("new recovery path"),
        );

        assert_eq!(updated.targets[0].status, DistributionStatus::Copied);
        assert_eq!(recovery_dirs, [next_recovery.clone()]);
        assert_ne!(next_recovery, first_recovery);
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated twice."));
    }

    #[test]
    fn malformed_or_out_of_root_recovery_metadata_fails_closed() {
        for (recovery_path, recovery_hash) in [
            (Some("/tmp/outside-recovery"), Some("0".repeat(64))),
            (Some("/tmp/missing-hash"), None),
        ] {
            let fixture = DistributionFixture::new();
            fixture.write_source("SKILL.md", SKILL_MD);
            fixture.distribute(&["codex"]);
            let mut ledger = fixture.ledger_value();
            let entry = &mut ledger["codex"]["demo"];
            if let Some(path) = recovery_path {
                entry["recoveryPath"] = serde_json::Value::String(path.to_owned());
            }
            if let Some(hash) = recovery_hash {
                entry["recoveryHash"] = serde_json::Value::String(hash);
            }
            fs::write(
                fixture.context.data_dir.join("skill-distribution.json"),
                serde_json::to_vec_pretty(&ledger).expect("ledger bytes"),
            )
            .expect("write injected ledger");
            fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated.\n");

            let blocked = fixture.distribute(&["codex"]);

            assert_eq!(blocked.targets[0].status, DistributionStatus::Conflict);
            assert!(blocked.targets[0]
                .message
                .as_deref()
                .is_some_and(|message| message.contains("recovery metadata")));
            assert_eq!(fixture.recovery_dirs("codex").len(), 0);
            assert_eq!(fixture.read_target("codex", "SKILL.md"), SKILL_MD);
        }
    }

    #[test]
    fn identical_generated_package_is_current_and_leaves_no_stage() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);

        let current = fixture.distribute(&["codex"]);

        assert_eq!(current.targets[0].status, DistributionStatus::Current);
        assert!(fixture.stage_dirs("codex").is_empty());
    }

    #[test]
    fn source_equal_to_canonical_claude_destination_is_current_without_staging() {
        let fixture = DistributionFixture::new();
        let mut context = fixture.context.clone();
        context.environment.remove("RYU_SKILLS_DIR");
        let source = fixture
            .context
            .home_dir
            .join(".claude/skills/demo/SKILL.md");
        write_file(&source, SKILL_MD);

        let result = distribute_skill(&context, "demo", &source, &["claude-code".to_owned()])
            .expect("source destination no-op");

        assert_eq!(result.targets[0].status, DistributionStatus::Current);
        assert!(fixture.stage_dirs("claude-code").is_empty());
        assert_eq!(fs::read_to_string(source).expect("source"), SKILL_MD);
    }

    #[test]
    fn reserved_distribution_ids_cannot_delete_their_canonical_source_packages() {
        for skill_id in [
            ".ryu-skill-stage-33333333-3333-4333-8333-333333333333",
            ".ryu-skill-backup-44444444-4444-4444-8444-444444444444",
            ".RYU-SKILL-STAGE-55555555-5555-4555-8555-555555555555",
        ] {
            let fixture = DistributionFixture::new();
            let source = fixture
                .context
                .home_dir
                .join(".claude/skills")
                .join(skill_id)
                .join("SKILL.md");
            write_file(&source, SKILL_MD);

            let error = distribute_skill(
                &fixture.context,
                skill_id,
                &source,
                &["claude-code".to_owned()],
            )
            .unwrap_err();

            assert!(error.to_string().contains("reserved"));
            assert_eq!(
                fs::read_to_string(source).expect("source preserved"),
                SKILL_MD
            );
        }
    }

    #[test]
    fn case_insensitive_standard_entry_copies_its_complete_package() {
        let fixture = DistributionFixture::new();
        let source = fixture.source_dir.join("Skill.md");
        write_file(&source, SKILL_MD);
        fixture.write_source("scripts/run.sh", "#!/bin/sh\necho ok\n");

        let result = distribute_skill(&fixture.context, "demo", &source, &["codex".to_owned()])
            .expect("case-insensitive standard package");

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(fixture.read_target("codex", "SKILL.md"), SKILL_MD);
        assert_eq!(
            fixture.read_target("codex", "scripts/run.sh"),
            "#!/bin/sh\necho ok\n"
        );
        let target_names = fs::read_dir(fixture.target_dir("codex"))
            .expect("destination")
            .map(|entry| entry.expect("destination entry").file_name())
            .collect::<Vec<_>>();
        assert!(target_names.iter().any(|name| name == "SKILL.md"));
        assert!(!target_names.iter().any(|name| name == "Skill.md"));
    }

    #[test]
    fn legacy_flat_file_named_skill_md_does_not_capture_its_parent_directory() {
        let fixture = DistributionFixture::new();
        let flat = fixture.root.path().join("source/SKILL.md");
        write_file(&flat, SKILL_MD);
        write_file(
            &fixture.root.path().join("source/unrelated-secret.txt"),
            "do not copy\n",
        );

        let result = distribute_skill(&fixture.context, "SKILL", &flat, &["codex".to_owned()])
            .expect("literal legacy flat skill");
        let destination = fixture.target_root("codex").join("SKILL");

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(
            fs::read_to_string(destination.join("SKILL.md")).expect("flat entry"),
            SKILL_MD
        );
        assert!(!destination.join("unrelated-secret.txt").exists());
        assert_eq!(fs::read_dir(destination).expect("destination").count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_escaping_source_symlink_without_touching_the_target() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let outside = fixture.root.path().join("outside.txt");
        fs::write(&outside, "outside\n").expect("outside");
        let link = fixture.source_dir.join("references/outside.txt");
        fs::create_dir_all(link.parent().expect("parent")).expect("references");
        symlink(&outside, &link).expect("symlink");

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("symlink"));
        assert!(!fixture.target_dir("codex").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_target_root_without_writing_through_it() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let external = fixture.root.path().join("external-target");
        fs::create_dir_all(&external).expect("external target");
        let config = fixture.context.home_dir.join(".codex");
        fs::create_dir_all(&config).expect("codex config");
        symlink(&external, config.join("skills")).expect("target symlink");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Failed);
        assert!(result.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("symlink")));
        assert!(!external.join("demo").exists());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_a_symlink_at_the_exact_destination() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let external = fixture.root.path().join("external-package");
        write_file(&external.join("SKILL.md"), "external\n");
        fs::create_dir_all(fixture.target_root("codex")).expect("target root");
        symlink(&external, fixture.target_dir("codex")).expect("destination symlink");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Conflict);
        assert_eq!(
            fs::read_to_string(external.join("SKILL.md")).expect("external package"),
            "external\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn target_root_symlink_swap_after_validation_cannot_escape() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let external = fixture.root.path().join("external-race-target");
        fs::create_dir_all(&external).expect("external target");
        let moved_root = fixture.root.path().join("validated-target-root");
        let external_for_hook = external.clone();
        let moved_for_hook = moved_root.clone();
        let _hook = install_distribution_test_hook(move |point, target_root| {
            if point == DistributionTestHook::AfterTargetValidation {
                fs::rename(target_root, &moved_for_hook).expect("move validated root");
                symlink(&external_for_hook, target_root).expect("swap target root");
            }
        });

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Failed);
        assert!(!external.join("demo").exists());
    }

    #[cfg(unix)]
    #[test]
    fn target_root_handle_stays_anchored_after_parent_path_swap() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let external = fixture.root.path().join("external-after-handle");
        fs::create_dir_all(&external).expect("external target");
        let moved_root = fixture.root.path().join("opened-target-root");
        let external_for_hook = external.clone();
        let moved_for_hook = moved_root.clone();
        let _hook = install_distribution_test_hook(move |point, target_root| {
            if point == DistributionTestHook::AfterRootHandleAcquisition {
                fs::rename(target_root, &moved_for_hook).expect("move opened root");
                symlink(&external_for_hook, target_root).expect("swap opened root path");
            }
        });

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Failed);
        assert!(!moved_root.join("demo").exists());
        assert!(!external.join("demo").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_special_source_files_without_touching_the_target() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fs::create_dir_all(fixture.source_dir.join("runtime")).expect("runtime");
        let socket = fixture.source_dir.join("runtime/control.sock");
        let _listener = UnixListener::bind(&socket).expect("socket");

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("special file"));
        assert!(!fixture.target_dir("codex").exists());
    }

    #[test]
    fn rejects_traversal_skill_ids_before_creating_any_target_path() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);

        let error = distribute_skill(
            &fixture.context,
            "../escape",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("skill id"));
        assert!(!fixture.context.home_dir.join(".codex/escape").exists());
    }

    #[test]
    fn cleans_interrupted_sibling_staging_before_installing() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let stale = fixture
            .target_root("codex")
            .join(".ryu-skill-stage-11111111-1111-4111-8111-111111111111");
        write_file(&stale.join("partial.txt"), "partial\n");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert!(!stale.exists());
        assert!(fixture.stage_dirs("codex").is_empty());
    }

    #[test]
    fn cleans_interrupted_sibling_staging_when_destination_is_current() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.distribute(&["codex"]);
        let stale = fixture
            .target_root("codex")
            .join(".ryu-skill-stage-22222222-2222-4222-8222-222222222222");
        write_file(&stale.join("partial.txt"), "partial\n");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Current);
        assert!(!stale.exists());
    }

    #[test]
    fn never_deletes_an_unresolved_interrupted_backup() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let backup = fixture
            .target_root("codex")
            .join(".ryu-skill-backup-abandoned");
        write_file(&backup.join("external.txt"), "preserve me\n");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(
            fs::read_to_string(backup.join("external.txt")).expect("backup"),
            "preserve me\n"
        );
    }

    #[test]
    fn never_deletes_an_unvalidated_stage_like_directory() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let unrelated = fixture
            .target_root("codex")
            .join(".ryu-skill-stage-not-a-valid-operation-id");
        write_file(&unrelated.join("external.txt"), "preserve me\n");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(
            fs::read_to_string(unrelated.join("external.txt")).expect("unrelated directory"),
            "preserve me\n"
        );
    }

    #[test]
    fn aliases_resolving_to_one_path_do_not_conflict_with_each_other() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);

        let result = fixture.distribute(&["cline", "dexto"]);

        assert_eq!(
            result
                .targets
                .iter()
                .map(|target| target.status.clone())
                .collect::<Vec<_>>(),
            [DistributionStatus::Copied, DistributionStatus::Current]
        );
        assert_eq!(fixture.read_target("cline", "SKILL.md"), SKILL_MD);
        let ledger: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.context.data_dir.join("skill-distribution.json")).expect("ledger"),
        )
        .expect("ledger json");
        assert!(ledger["cline"]["demo"]["generatedHash"].is_string());
        assert!(ledger["dexto"]["demo"]["generatedHash"].is_string());
    }

    #[test]
    fn a_legacy_flat_skill_is_distributed_as_skill_md_only() {
        let fixture = DistributionFixture::new();
        let flat = fixture.root.path().join("source/demo.md");
        write_file(&flat, SKILL_MD);

        let result = distribute_skill(&fixture.context, "demo", &flat, &["codex".to_owned()])
            .expect("legacy distribution");

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(fixture.read_target("codex", "SKILL.md"), SKILL_MD);
        assert_eq!(
            fs::read_dir(fixture.target_dir("codex"))
                .expect("destination")
                .count(),
            1
        );
    }

    #[test]
    fn configured_scan_root_named_skill_keeps_root_level_skill_md_flat() {
        let fixture = DistributionFixture::new();
        let scan_root = fixture.root.path().join("scan/SKILL");
        let flat = scan_root.join("SKILL.md");
        write_file(&flat, SKILL_MD);
        write_file(&scan_root.join("unrelated-secret.txt"), "do not copy\n");
        let mut context = fixture.context.clone();
        context.environment.insert(
            "RYU_SKILLS_DIR".to_owned(),
            scan_root.to_string_lossy().into_owned(),
        );

        let result = distribute_skill(&context, "SKILL", &flat, &["codex".to_owned()])
            .expect("configured-root flat skill");
        let destination = fixture.target_root("codex").join("SKILL");

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        assert_eq!(
            fs::read_to_string(destination.join("SKILL.md")).expect("flat entry"),
            SKILL_MD
        );
        assert!(!destination.join("unrelated-secret.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_executable_permissions_for_package_scripts() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let script = fixture.source_dir.join("scripts/run.sh");
        write_file(&script, "#!/bin/sh\necho ok\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .expect("source executable mode");

        let result = fixture.distribute(&["codex"]);

        assert_eq!(result.targets[0].status, DistributionStatus::Copied);
        let mode = fs::metadata(fixture.target_dir("codex").join("scripts/run.sh"))
            .expect("target script")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn mode_only_source_update_is_copied_then_current() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let script = fixture.source_dir.join("scripts/run.sh");
        write_file(&script, "#!/bin/sh\necho ok\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644))
            .expect("initial source mode");
        fixture.distribute(&["codex"]);

        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))
            .expect("updated source mode");
        let updated = fixture.distribute(&["codex"]);
        let current = fixture.distribute(&["codex"]);

        assert_eq!(updated.targets[0].status, DistributionStatus::Copied);
        assert_eq!(current.targets[0].status, DistributionStatus::Current);
        let target_mode = fs::metadata(fixture.target_dir("codex").join("scripts/run.sh"))
            .expect("target script")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(target_mode, 0o755);
    }

    #[test]
    fn oversized_source_file_is_rejected_before_staging() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let oversized = fixture.source_dir.join("large.bin");
        let file = fs::File::create(&oversized).expect("large file");
        file.set_len(MAX_PACKAGE_FILE_BYTES + 1)
            .expect("set sparse length");

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("file size limit"));
        assert!(fixture.stage_dirs("codex").is_empty());
    }

    #[test]
    fn excessive_source_file_count_is_rejected_before_staging() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        for index in 0..MAX_PACKAGE_FILES {
            fixture.write_source(&format!("files/{index}.txt"), "");
        }

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("file count limit"));
        assert!(fixture.stage_dirs("codex").is_empty());
    }

    #[test]
    fn malformed_ledger_aborts_before_mutating_an_existing_destination() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        fixture.write_target("codex", "SKILL.md", "external\n");
        write_file(
            &fixture.context.data_dir.join("skill-distribution.json"),
            "not json",
        );

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("distribution ledger"));
        assert_eq!(fixture.read_target("codex", "SKILL.md"), "external\n");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_ledger_is_rejected_without_following_or_mutating_it() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let external = fixture.root.path().join("external-ledger.json");
        fs::write(&external, "{}\n").expect("external ledger");
        fs::create_dir_all(&fixture.context.data_dir).expect("data dir");
        symlink(
            &external,
            fixture.context.data_dir.join("skill-distribution.json"),
        )
        .expect("ledger symlink");

        let error = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .unwrap_err();

        assert!(error.to_string().contains("distribution ledger"));
        assert_eq!(
            fs::read_to_string(external).expect("external ledger"),
            "{}\n"
        );
        assert!(!fixture.target_dir("codex").exists());
    }

    #[test]
    fn generated_update_ledger_failure_keeps_one_visible_recovery_across_retries() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        assert_eq!(
            fixture.distribute(&["codex"]).targets[0].status,
            DistributionStatus::Copied
        );
        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated once.\n");
        let ledger_path = fixture.context.data_dir.join("skill-distribution.json");
        let saved_ledger_path = fixture
            .context
            .data_dir
            .join("skill-distribution.saved.json");

        let failed_update = {
            let ledger_path_for_hook = ledger_path.clone();
            let saved_ledger_path_for_hook = saved_ledger_path.clone();
            let _hook = install_distribution_test_hook(move |point, _| {
                if point == DistributionTestHook::BeforeLedgerWrite {
                    fs::rename(&ledger_path_for_hook, &saved_ledger_path_for_hook)
                        .expect("preserve old ledger");
                    fs::create_dir(&ledger_path_for_hook).expect("block ledger persistence");
                }
            });
            fixture.distribute(&["codex"])
        };
        let recovery_dirs = fixture.recovery_dirs("codex");
        let recovery_path = recovery_dirs.first().expect("one recovery after failure");
        let recovery_path_string = recovery_path.to_string_lossy().into_owned();

        assert_eq!(failed_update.targets[0].status, DistributionStatus::Failed);
        assert_eq!(recovery_dirs.len(), 1);
        assert!(failed_update.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains(&recovery_path_string)));
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated once."));
        assert_eq!(
            fs::read_to_string(recovery_path.join("SKILL.md")).expect("recovery package"),
            SKILL_MD
        );

        fs::remove_dir(&ledger_path).expect("remove ledger blocker");
        fs::rename(&saved_ledger_path, &ledger_path).expect("restore old ledger");
        let interrupted_stage = fixture
            .target_root("codex")
            .join(".ryu-skill-stage-66666666-6666-4666-8666-666666666666");
        write_file(
            &interrupted_stage.join("partial.txt"),
            "preserve until recovery resolves\n",
        );
        let same_source_retry = fixture.distribute(&["codex"]);

        assert_eq!(
            same_source_retry.targets[0].status,
            DistributionStatus::Conflict
        );
        assert!(same_source_retry.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains(&recovery_path_string)));
        assert!(interrupted_stage.is_dir());

        fixture.write_source("SKILL.md", "---\nname: Demo\n---\nUpdated twice.\n");
        let new_source_update = fixture.distribute(&["codex"]);

        assert_eq!(
            new_source_update.targets[0].status,
            DistributionStatus::Conflict
        );
        assert!(new_source_update.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains(&recovery_path_string)));
        assert_eq!(fixture.recovery_dirs("codex"), [recovery_path.clone()]);
        assert!(fixture
            .read_target("codex", "SKILL.md")
            .contains("Updated once."));
        assert_eq!(
            fs::read_to_string(recovery_path.join("SKILL.md")).expect("recovery package"),
            SKILL_MD
        );
    }

    #[test]
    fn ledger_write_failure_is_reported_per_target_after_install() {
        let fixture = DistributionFixture::new();
        fixture.write_source("SKILL.md", SKILL_MD);
        let _hook = install_distribution_test_hook(|point, ledger_path| {
            if point == DistributionTestHook::BeforeLedgerWrite {
                fs::create_dir_all(ledger_path).expect("blocking ledger directory");
            }
        });

        let result = distribute_skill(
            &fixture.context,
            "demo",
            &fixture.source_skill_md(),
            &["codex".to_owned()],
        )
        .expect("honest target result");

        assert_eq!(result.targets[0].status, DistributionStatus::Failed);
        assert!(result.targets[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("ledger")));
        assert_eq!(fixture.read_target("codex", "SKILL.md"), SKILL_MD);
    }
}
