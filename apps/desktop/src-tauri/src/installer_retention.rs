//! Conservative maintenance of signature-verified installers and completed handoffs.
use crate::update_handoff::RetainedInstaller;
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::{
    handoff::{write_json, HandoffRequest},
    recovery::RecoveryCheckpoint,
    supervision::SupervisionOutcome,
    tree_identity::TreeIdentity,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const OWNERSHIP: &str = "artifact-ownership.json";
const RETIRED: &str = ".retired-artifact-";
const INTENT: &str = ".artifact-retirement-";

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArtifactOwnership {
    schema: u32,
    profile: String,
    transaction: String,
    identity: TreeIdentity,
}

impl ArtifactOwnership {
    fn new(path: &Path, profile: &str, transaction: &str) -> Result<Option<Self>> {
        ensure!(
            safe_name(profile) && safe_name(transaction),
            "invalid artifact owner"
        );
        let Some(identity) = TreeIdentity::read(path)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            schema: 1,
            profile: profile.into(),
            transaction: transaction.into(),
            identity,
        }))
    }

    fn matches(&self, path: &Path, profile: &str) -> Result<bool> {
        ensure!(
            self.schema == 1 && safe_name(&self.profile) && safe_name(&self.transaction),
            "invalid artifact ownership"
        );
        Ok(self.profile == profile && TreeIdentity::read(path)?.as_ref() == Some(&self.identity))
    }
}

pub(crate) fn update_lease(namespace: &Path) -> Result<fs::File> {
    let path = namespace.join("update.lock");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "invalid update lock"
        );
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    fs4::FileExt::try_lock_exclusive(&file)
        .context("update preparation or guard owns this application")?;
    Ok(file)
}

fn version_name(version: &str) -> Result<()> {
    ensure!(
        semver::Version::parse(version)?.to_string() == version,
        "installer version is not canonical"
    );
    Ok(())
}

fn exact_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink() && fs::canonicalize(path)? == path,
        "artifact directory changed identity"
    );
    Ok(())
}

fn read_record<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 1024 * 1024,
        "invalid artifact record"
    );
    Ok(serde_json::from_slice(
        &ryu_runtime_install::bounded_file::read(path, 1024 * 1024)?,
    )?)
}

fn verify_installer(path: &Path, record: &RetainedInstaller, public_key: &str) -> Result<()> {
    version_name(&record.version)?;
    ensure!(
        path.file_name().and_then(|name| name.to_str()) == Some(record.version.as_str()),
        "installer version directory mismatch"
    );
    let artifact = path.join("artifact.bin");
    let metadata = fs::symlink_metadata(&artifact)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "invalid retained installer artifact"
    );
    crate::app_update::verify_minisign(&fs::read(artifact)?, &record.signature, public_key)
        .map_err(anyhow::Error::msg)
}

/// Publish a complete directory once; never overwrite a legacy or another owner's tree.
pub(crate) fn persist_installer(
    namespace: &Path,
    profile: &str,
    transaction: &str,
    record: &RetainedInstaller,
    bytes: &[u8],
    public_key: &str,
) -> Result<()> {
    version_name(&record.version)?;
    crate::app_update::verify_minisign(bytes, &record.signature, public_key)
        .map_err(anyhow::Error::msg)?;
    let installers = namespace.join("retained-installers");
    fs::create_dir_all(&installers)?;
    exact_directory(&installers)?;
    let destination = installers.join(&record.version);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            exact_directory(&destination)?;
            let existing: RetainedInstaller = read_record(&destination.join("metadata.json"))?;
            ensure!(
                existing.version == record.version && existing.signature == record.signature,
                "retained installer metadata changed"
            );
            return verify_installer(&destination, &existing, public_key);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let staging = tempfile::Builder::new()
        .prefix(".installer-preparing-")
        .tempdir_in(&installers)?;
    let mut artifact = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staging.path().join("artifact.bin"))?;
    artifact.write_all(bytes)?;
    artifact.sync_all()?;
    drop(artifact);
    let mut owned = record.clone();
    owned.ownership = ArtifactOwnership::new(staging.path(), profile, transaction)?;
    write_json(&staging.path().join("metadata.json"), &owned)?;
    fs::rename(staging.path(), &destination)?;
    #[cfg(unix)]
    fs::File::open(&installers)?.sync_all()?;
    Ok(())
}

pub(crate) fn record_handoff_ownership(
    directory: &Path,
    profile: &str,
    transaction: &str,
) -> Result<()> {
    if let Some(owner) = ArtifactOwnership::new(directory, profile, transaction)? {
        write_json(&directory.join(OWNERSHIP), &owner)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetirementIntent {
    schema: u32,
    name: String,
    owner: ArtifactOwnership,
}

fn protected(path: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| path.starts_with(root) || root.starts_with(path))
}

fn intent_path(parent: &Path, name: &str) -> PathBuf {
    parent.join(format!("{INTENT}{name}.json"))
}

fn remove_retired(path: &Path, profile: &str, roots: &[PathBuf]) -> Result<bool> {
    exact_directory(path)?;
    let parent = path.parent().context("retired artifact has no parent")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(RETIRED))
        .context("invalid retired artifact name")?;
    ensure!(
        !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..",
        "invalid retirement name"
    );
    let intent: RetirementIntent = read_record(&intent_path(parent, name))?;
    ensure!(
        intent.schema == 1 && intent.name == name,
        "retirement receipt mismatch"
    );
    if protected(path, roots) || !intent.owner.matches(path, profile)? {
        return Ok(false);
    }
    fs::remove_dir_all(path)?;
    fs::remove_file(intent_path(parent, name))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(true)
}

fn retire(path: &Path, owner: ArtifactOwnership, profile: &str, roots: &[PathBuf]) -> Result<bool> {
    exact_directory(path)?;
    if protected(path, roots) || !owner.matches(path, profile)? {
        return Ok(false);
    }
    let parent = path.parent().context("artifact has no parent")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid artifact name")?;
    let destination = parent.join(format!("{RETIRED}{name}"));
    ensure!(
        fs::symlink_metadata(&destination)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        "artifact retirement destination exists"
    );
    write_json(
        &intent_path(parent, name),
        &RetirementIntent {
            schema: 1,
            name: name.into(),
            owner,
        },
    )?;
    fs::rename(path, &destination)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    remove_retired(&destination, profile, roots)
}

fn directories(parent: &Path) -> Result<Vec<PathBuf>> {
    match fs::read_dir(parent) {
        Ok(entries) => {
            let mut paths = Vec::new();
            for entry in entries {
                let entry = entry?;
                let kind = entry.file_type()?;
                ensure!(!kind.is_symlink(), "linked artifact namespace entry");
                if kind.is_dir() {
                    paths.push(entry.path());
                }
            }
            Ok(paths)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn add_versions(keep: &mut BTreeSet<String>, previous: String, expected: String) -> Result<()> {
    version_name(&previous)?;
    version_name(&expected)?;
    keep.extend([previous, expected]);
    Ok(())
}

/// Call after checkpoint retention. Only its proved retired IDs authorize handoff disposal.
/// Unknown references abort the pass before deleting an artifact.
pub(crate) fn prune(
    namespace: &Path,
    profile: &str,
    current_version: &str,
    prepared_cache: &Path,
    protected_roots: &[PathBuf],
    public_key: &str,
    retired_transactions: &[String],
) -> Result<usize> {
    let expected = fs::canonicalize(namespace.parent().context("namespace parent missing")?)?
        .join(namespace.file_name().context("namespace name missing")?);
    let namespace = fs::canonicalize(namespace)?;
    ensure!(namespace == expected, "artifact namespace changed identity");
    let namespace = namespace.as_path();
    exact_directory(namespace)?;
    ensure!(safe_name(profile), "invalid artifact retention profile");
    let _update = update_lease(namespace)?;
    let roots = protected_roots
        .iter()
        .map(|root| {
            ensure!(
                root.is_absolute(),
                "artifact protection requires absolute paths"
            );
            Ok(if root.exists() {
                fs::canonicalize(root)?
            } else {
                root.clone()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut keep = BTreeSet::new();
    version_name(current_version)?;
    keep.insert(current_version.to_owned());
    let mut checkpoint_leases = Vec::new();
    for path in directories(&namespace.join("transactions"))? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(".retired-"))
            .is_some_and(|name| {
                retired_transactions
                    .iter()
                    .any(|transaction| transaction == name)
            })
        {
            continue;
        }
        exact_directory(&path)?;
        let checkpoint = RecoveryCheckpoint::open(path)?;
        let journal = checkpoint.read()?;
        add_versions(
            &mut keep,
            journal.previous_version,
            journal.expected_version,
        )?;
        checkpoint_leases.push(checkpoint);
    }
    for pending in fs::read_dir(namespace)? {
        let pending = pending?;
        if pending
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("pending-") && name.ends_with(".json"))
        {
            return Ok(0);
        }
    }
    for path in directories(prepared_cache)? {
        exact_directory(&path)?;
        let manifest = path.join("manifest.json");
        match fs::symlink_metadata(&manifest) {
            Ok(_) => {
                let prepared: crate::app_update::PreparedAppUpdate = read_record(&manifest)?;
                ensure!(
                    prepared.schema_version == 1,
                    "unknown prepared update schema"
                );
                version_name(&prepared.version)?;
                keep.insert(prepared.version);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    let mut handoffs = Vec::new();
    let mut handoff_leases = Vec::new();
    let mut replay = Vec::new();
    for parent in [
        namespace.join("handoffs"),
        namespace.join("retained-installers"),
    ] {
        // Intents are sibling files, not unknown artifact directories.
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        exact_directory(&parent)?;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().context("unknown artifact entry name")?;
            if name.starts_with(INTENT) && name.ends_with(".json") {
                continue;
            }
            ensure!(
                entry.file_type()?.is_dir(),
                "unknown artifact namespace entry"
            );
            let path = entry.path();
            exact_directory(&path)?;
            if name.starts_with(RETIRED) {
                let original = name
                    .strip_prefix(RETIRED)
                    .context("retirement name missing")?;
                let intent: RetirementIntent = read_record(&intent_path(&parent, original))?;
                ensure!(
                    intent.schema == 1 && intent.name == original,
                    "retirement receipt mismatch"
                );
                if intent.owner.matches(&path, profile)? {
                    replay.push(path);
                } else if parent.file_name().and_then(|name| name.to_str()) == Some("handoffs") {
                    // Another profile's partially retired handoff can still be
                    // its only source of rollback installer references.
                    let request: HandoffRequest = read_record(&path.join("request.json"))?;
                    add_versions(
                        &mut keep,
                        request.previous_version,
                        request.expected_version,
                    )?;
                } else {
                    version_name(original)?;
                    keep.insert(original.to_owned());
                }
                continue;
            }
            if parent.file_name().and_then(|name| name.to_str()) != Some("handoffs") {
                continue;
            }
            let request: HandoffRequest = read_record(&path.join("request.json"))?;
            ensure!(
                request.schema == 1
                    && request.namespace == namespace
                    && request.pending.transaction == name
                    && safe_name(name)
                    && request.pending.nonce == request.plan.nonce
                    && !request.plan.nonce.is_empty(),
                "handoff reference identity mismatch"
            );
            let terminal = read_record::<SupervisionOutcome>(&path.join("outcome.json"));
            let eligible = request.target_profile == profile
                && retired_transactions
                    .iter()
                    .any(|transaction| transaction == name)
                && terminal.is_ok()
                && !namespace.join("transactions").join(name).exists();
            if eligible {
                let owner: ArtifactOwnership = read_record(&path.join(OWNERSHIP))?;
                ensure!(
                    owner.transaction == name,
                    "handoff owner transaction mismatch"
                );
                if owner.matches(&path, profile)? {
                    let lease = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(path.join("handoff.lock"))?;
                    fs4::FileExt::try_lock_exclusive(&lease)
                        .context("handoff still has a live guard")?;
                    handoff_leases.push(lease);
                    handoffs.push((path, owner));
                    continue;
                }
            }
            add_versions(
                &mut keep,
                request.previous_version,
                request.expected_version,
            )?;
        }
    }
    let mut installers = Vec::new();
    let parent = namespace.join("retained-installers");
    if parent.exists() {
        for entry in fs::read_dir(&parent)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            let Some(version) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if version.starts_with('.') || keep.contains(version) {
                continue;
            }
            exact_directory(&path)?;
            let record: RetainedInstaller = read_record(&path.join("metadata.json"))?;
            let Some(owner) = record.ownership.clone() else {
                continue;
            };
            if !owner.matches(&path, profile)? {
                continue;
            }
            verify_installer(&path, &record, public_key)?;
            ensure!(
                fs::read_dir(&path)?.all(|entry| entry.is_ok_and(|entry| matches!(
                    entry.file_name().to_str(),
                    Some("artifact.bin" | "metadata.json")
                ))),
                "unknown retained installer contents"
            );
            installers.push((path, owner));
        }
    }
    // Acquire physical data leases for the complete batch before modifying anything.
    let mut paths: Vec<_> = handoffs
        .iter()
        .chain(installers.iter())
        .map(|(path, _)| path.clone())
        .chain(replay.iter().cloned())
        .collect();
    for path in paths.clone() {
        let name = path.file_name().context("artifact name missing")?;
        paths.push(
            path.parent()
                .context("artifact parent missing")?
                .join(format!("{RETIRED}{}", name.to_string_lossy())),
        );
    }
    if paths.is_empty() {
        return Ok(0);
    }
    let _data = ryu_runtime_install::data_lease::DataLease::recovery(
        namespace.parent().context("namespace parent missing")?,
        &paths,
    )?;
    // Windows directory renames require releasing lock handles; update.lock still
    // excludes guard starts throughout this publication and deletion batch.
    drop(handoff_leases);
    let mut removed = 0;
    for path in replay {
        removed += usize::from(remove_retired(&path, profile, &roots)?);
    }
    for (path, owner) in handoffs.into_iter().chain(installers) {
        removed += usize::from(retire(&path, owner, profile, &roots)?);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn signed_record(version: &str) -> (RetainedInstaller, String) {
        let encode = |value: &str| base64::engine::general_purpose::STANDARD.encode(value);
        let key = encode("untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
        let signature = encode("untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==");
        (
            RetainedInstaller {
                version: version.into(),
                signature,
                raw_feed: serde_json::json!({}),
                format: "exe".into(),
                ownership: None,
            },
            key,
        )
    }

    #[test]
    fn publishing_preserves_verified_legacy_records_and_rejects_tampering() {
        let home = tempfile::tempdir().unwrap();
        let namespace = fs::canonicalize(home.path()).unwrap();
        let (record, key) = signed_record("1.0.0");
        assert!(
            persist_installer(&namespace, "dev", "update-one", &record, b"Test", &key).is_err()
        );
        persist_installer(&namespace, "dev", "update-one", &record, b"test", &key).unwrap();
        let metadata = namespace.join("retained-installers/1.0.0/metadata.json");
        write_json(&metadata, &record).unwrap();
        persist_installer(&namespace, "beta", "update-two", &record, b"test", &key).unwrap();
        assert!(read_record::<RetainedInstaller>(&metadata)
            .unwrap()
            .ownership
            .is_none());
    }

    #[test]
    fn pruning_preserves_checkpoint_versions_preparation_and_other_profile() {
        let home = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(home.path()).unwrap();
        let namespace = base.join("app");
        fs::create_dir_all(namespace.join("transactions")).unwrap();
        let (record, key) = signed_record("1.0.0");
        for (version, profile) in [
            ("1.0.0", "dev"),
            ("2.0.0", "dev"),
            ("3.0.0", "dev"),
            ("4.0.0", "dev"),
            ("5.0.0", "beta"),
            ("6.0.0", "dev"),
        ] {
            let mut installer = record.clone();
            installer.version = version.into();
            persist_installer(
                &namespace,
                profile,
                "update-test",
                &installer,
                b"test",
                &key,
            )
            .unwrap();
        }
        let checkpoint = RecoveryCheckpoint::create(
            namespace.join("transactions/update-test"),
            &[base.join("data")],
            "1.0.0".into(),
            "2.0.0".into(),
            "dev".into(),
        )
        .unwrap();
        drop(checkpoint);
        let prepared = base.join("prepared/dev");
        fs::create_dir_all(&prepared).unwrap();
        write_json(
            &prepared.join("manifest.json"),
            &crate::app_update::PreparedAppUpdate {
                schema_version: 1,
                version: "6.0.0".into(),
                source: crate::app_update::AppUpdateSource::Stable,
                signature: record.signature,
                artifact_size: 4,
                artifact_file: "ryu-update-6.0.0.bin".into(),
            },
        )
        .unwrap();
        let removable = namespace.join("retained-installers/4.0.0");
        let identity_available = TreeIdentity::read(&removable).unwrap().is_some();
        assert_eq!(
            prune(
                &namespace,
                "dev",
                "3.0.0",
                &base.join("prepared"),
                &[],
                &key,
                &[]
            )
            .unwrap(),
            usize::from(identity_available)
        );
        for version in ["1.0.0", "2.0.0", "3.0.0", "5.0.0", "6.0.0"] {
            assert!(namespace.join("retained-installers").join(version).exists());
        }
        assert_eq!(removable.exists(), !identity_available);
    }

    #[test]
    fn legacy_ownership_cannot_authorize_cleanup() {
        let json =
            serde_json::json!({"version":"1.0.0","signature":"x","raw_feed":{},"format":"exe"});
        let record: RetainedInstaller = serde_json::from_value(json).unwrap();
        assert!(record.ownership.is_none());
    }

    #[test]
    fn retirement_replays_without_internal_records_and_preserves_replacements() {
        let home = tempfile::tempdir().unwrap();
        let parent = fs::canonicalize(home.path()).unwrap();
        let original = parent.join("update-test");
        fs::create_dir(&original).unwrap();
        fs::write(original.join("artifact.bin"), "bytes").unwrap();
        let Some(owner) = ArtifactOwnership::new(&original, "dev", "update-test").unwrap() else {
            return;
        };
        let retired = parent.join(format!("{RETIRED}update-test"));
        write_json(
            &intent_path(&parent, "update-test"),
            &RetirementIntent {
                schema: 1,
                name: "update-test".into(),
                owner: owner.clone(),
            },
        )
        .unwrap();
        fs::rename(&original, &retired).unwrap();
        assert!(!remove_retired(&retired, "beta", &[]).unwrap());
        assert!(!remove_retired(&retired, "dev", &[retired.clone()]).unwrap());
        assert!(remove_retired(&retired, "dev", &[]).unwrap());
        fs::create_dir(&original).unwrap();
        assert!(!owner.matches(&original, "dev").unwrap());
    }

    #[test]
    fn update_preparation_excludes_artifact_maintenance() {
        let home = tempfile::tempdir().unwrap();
        let lease = update_lease(home.path()).unwrap();
        assert!(update_lease(home.path()).is_err());
        drop(lease);
        assert!(update_lease(home.path()).is_ok());
    }

    #[test]
    fn terminal_handoff_requires_explicit_checkpoint_retirement_proof() {
        use ryu_runtime_install::{
            startup::PendingRecovery,
            supervision::{ProcessCommand, ProcessIdentity, SupervisionPlan},
        };
        let home = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(home.path()).unwrap();
        let namespace = base.join("app");
        let directory = namespace.join("handoffs/update-test");
        fs::create_dir_all(&directory).unwrap();
        if TreeIdentity::read(&directory).unwrap().is_none() {
            return;
        }
        let executable = directory.join("ryu-update-guard.exe");
        let command = ProcessCommand {
            executable: executable.clone(),
            arguments: Vec::new(),
            environment: Default::default(),
        };
        let pending = PendingRecovery {
            schema: 1,
            transaction: "update-test".into(),
            nonce: "nonce".into(),
            runtime_required: false,
            application: executable.clone(),
        };
        let request = HandoffRequest {
            schema: 1,
            namespace: namespace.clone(),
            profiles: vec!["dev".into()],
            parent: ProcessIdentity {
                pid: 1,
                start_time: 1,
                executable,
            },
            targets: vec![base.join("data")],
            previous_version: "1.0.0".into(),
            expected_version: "2.0.0".into(),
            target_profile: "dev".into(),
            pending,
            plan: SupervisionPlan {
                data_lease_cache: Some(base.clone()),
                installer: command.clone(),
                rollback_installer: Some(command.clone()),
                application: command.clone(),
                previous_application: command,
                nonce: "nonce".into(),
                startup_timeout_seconds: 180,
                installer_timeout_seconds: 900,
            },
        };
        write_json(&directory.join("request.json"), &request).unwrap();
        write_json(
            &directory.join("outcome.json"),
            &SupervisionOutcome::Committed,
        )
        .unwrap();
        record_handoff_ownership(&directory, "dev", "update-test").unwrap();
        fs::File::create(directory.join("handoff.lock")).unwrap();
        let (record, key) = signed_record("1.0.0");
        persist_installer(&namespace, "dev", "update-test", &record, b"test", &key).unwrap();
        let mut candidate = record;
        candidate.version = "2.0.0".into();
        persist_installer(&namespace, "dev", "update-test", &candidate, b"test", &key).unwrap();
        assert_eq!(
            prune(
                &namespace,
                "dev",
                "3.0.0",
                &base.join("prepared"),
                &[],
                &key,
                &[]
            )
            .unwrap(),
            0
        );
        assert!(directory.exists());
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join("handoff.lock"))
            .unwrap();
        fs4::FileExt::try_lock_exclusive(&lease).unwrap();
        assert!(prune(
            &namespace,
            "dev",
            "3.0.0",
            &base.join("prepared"),
            &[],
            &key,
            &["update-test".into()]
        )
        .is_err());
        assert!(directory.exists());
        drop(lease);
        assert_eq!(
            prune(
                &namespace,
                "dev",
                "3.0.0",
                &base.join("prepared"),
                &[],
                &key,
                &["update-test".into()]
            )
            .unwrap(),
            3
        );
        assert!(!directory.exists());
    }
}
