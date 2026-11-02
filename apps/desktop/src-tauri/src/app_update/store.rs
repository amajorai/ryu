//! The prepared-update cache: a signature-verified artifact plus its manifest
//! under the app-update cache directory, and the version/signature checks
//! that decide whether a prepared download is still the one on offer.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use tempfile::NamedTempFile;

use super::{
    parse_version, AppUpdateSource, PreparedAppUpdate, CACHE_SCHEMA_VERSION, MANIFEST_FILE,
};

#[derive(Debug, Clone)]
pub(super) struct PreparedUpdateCandidate {
    pub(super) version: String,
    pub(super) source: AppUpdateSource,
    pub(super) signature: String,
}

pub(super) struct PreparedUpdateStore {
    root: PathBuf,
}

impl PreparedUpdateStore {
    pub(super) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(super) fn manifest_path(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    pub(super) fn read(&self) -> Result<Option<PreparedAppUpdate>, String> {
        let bytes = match fs::read(self.manifest_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let prepared: PreparedAppUpdate =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        self.validate_manifest(&prepared)?;
        Ok(Some(prepared))
    }

    pub(super) fn validate_manifest(&self, prepared: &PreparedAppUpdate) -> Result<(), String> {
        if prepared.schema_version != CACHE_SCHEMA_VERSION {
            return Err(format!(
                "unsupported prepared update schema: {}",
                prepared.schema_version
            ));
        }
        let expected_file = artifact_file(&prepared.version)?;
        if prepared.artifact_file != expected_file {
            return Err("prepared update artifact path is invalid".to_string());
        }
        prepared.source.endpoint()?;
        let metadata = fs::metadata(self.root.join(&prepared.artifact_file))
            .map_err(|error| error.to_string())?;
        if metadata.len() != prepared.artifact_size {
            return Err("prepared update artifact size changed".to_string());
        }
        Ok(())
    }

    pub(super) fn artifact_bytes(&self, prepared: &PreparedAppUpdate) -> Result<Vec<u8>, String> {
        self.validate_manifest(prepared)?;
        fs::read(self.root.join(&prepared.artifact_file)).map_err(|error| error.to_string())
    }

    pub(super) fn verified_artifact(
        &self,
        prepared: &PreparedAppUpdate,
        public_key: &str,
    ) -> Result<Vec<u8>, String> {
        let bytes = self.artifact_bytes(prepared)?;
        verify_minisign(&bytes, &prepared.signature, public_key)?;
        Ok(bytes)
    }

    pub(super) fn commit(
        &self,
        candidate: PreparedUpdateCandidate,
        bytes: &[u8],
    ) -> Result<PreparedAppUpdate, String> {
        self.commit_with_manifest_writer(candidate, bytes, atomic_write_manifest)
    }

    pub(super) fn commit_with_manifest_writer<F>(
        &self,
        candidate: PreparedUpdateCandidate,
        bytes: &[u8],
        manifest_writer: F,
    ) -> Result<PreparedAppUpdate, String>
    where
        F: FnOnce(&Path, &[u8]) -> io::Result<()>,
    {
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let artifact_file = artifact_file(&candidate.version)?;
        let artifact_path = self.root.join(&artifact_file);

        let mut temporary_artifact =
            NamedTempFile::new_in(&self.root).map_err(|error| error.to_string())?;
        temporary_artifact
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        temporary_artifact
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary_artifact
            .persist(&artifact_path)
            .map_err(|error| error.error.to_string())?;

        let prepared = PreparedAppUpdate {
            schema_version: CACHE_SCHEMA_VERSION,
            version: candidate.version,
            source: candidate.source,
            signature: candidate.signature,
            artifact_size: bytes.len() as u64,
            artifact_file,
        };
        let manifest = serde_json::to_vec_pretty(&prepared).map_err(|error| error.to_string())?;
        manifest_writer(&self.root, &manifest).map_err(|error| error.to_string())?;
        self.remove_superseded_artifacts(&prepared)?;
        Ok(prepared)
    }

    pub(super) fn remove_superseded_artifacts(
        &self,
        prepared: &PreparedAppUpdate,
    ) -> Result<(), String> {
        let entries = fs::read_dir(&self.root).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name == MANIFEST_FILE || name == prepared.artifact_file.as_str() {
                continue;
            }
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub(super) fn clear(&self) -> Result<(), String> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

pub(super) fn artifact_file(version: &str) -> Result<String, String> {
    let parsed = Version::parse(version.trim_start_matches('v'))
        .map_err(|error| format!("invalid update version: {error}"))?;
    Ok(format!("ryu-update-{parsed}.bin"))
}

pub(super) fn atomic_write_manifest(directory: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut temporary_manifest = NamedTempFile::new_in(directory)?;
    temporary_manifest.write_all(bytes)?;
    temporary_manifest.as_file().sync_all()?;
    temporary_manifest
        .persist(directory.join(MANIFEST_FILE))
        .map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn decode_base64_text(value: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| error.to_string())?;
    String::from_utf8(decoded).map_err(|error| error.to_string())
}

pub(crate) fn verify_minisign(
    data: &[u8],
    signature: &str,
    public_key: &str,
) -> Result<(), String> {
    let key_text = decode_base64_text(public_key)?;
    let signature_text = decode_base64_text(signature)?;
    let key = PublicKey::decode(&key_text).map_err(|error| error.to_string())?;
    let signature = Signature::decode(&signature_text).map_err(|error| error.to_string())?;
    key.verify(data, &signature, true)
        .map_err(|error| error.to_string())
}

pub(super) fn download_preference(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_bool) != Some(false)
}

pub(super) fn is_prepared_newer(prepared: &str, running: &str) -> bool {
    let Ok(prepared) = Version::parse(prepared.trim_start_matches('v')) else {
        return false;
    };
    let Ok(running) = Version::parse(running.trim_start_matches('v')) else {
        return false;
    };
    prepared > running
}

pub(super) fn prepared_metadata_matches_feed(
    prepared_version: &str,
    prepared_signature: &str,
    offered_version: &str,
    offered_signature: &str,
) -> bool {
    let Ok(prepared_version) = parse_version(prepared_version) else {
        return false;
    };
    let Ok(offered_version) = parse_version(offered_version) else {
        return false;
    };
    prepared_version == offered_version && prepared_signature == offered_signature
}

/// Install first, then remove the prepared bytes. A transient installer failure
/// must leave the already-downloaded, signature-verified artifact available for
/// retry instead of charging the user another full download.
#[cfg(test)]
pub(super) fn install_then_clear(
    store: &PreparedUpdateStore,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    install()?;
    if let Err(error) = store.clear() {
        tracing::warn!(%error, "installed app update cache cleanup failed");
    }
    Ok(())
}
