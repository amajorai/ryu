//! The Box credential and client, and lease persistence.

use super::*;

// ── Box credential and client ────────────────────────────────────────────────

/// The Box credential Core calls the service with: the env configuration or
/// the installed control-plane source.
pub(super) async fn box_credential() -> Result<BoxCredential> {
    #[cfg(test)]
    if let Some(credential) = tests::test_credential() {
        return Ok(credential);
    }
    ryu_sandbox::box_credential::current().await
}

/// A Box client for the node's current credential.
pub(crate) async fn box_client() -> Result<BoxSessionClient> {
    Ok(BoxSessionClient::from_credential(&box_credential().await?))
}

// ── Lease persistence ────────────────────────────────────────────────────────

/// A credential-free record of one session Box, written before its create.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionLease {
    pub(super) schema_version: u8,
    pub(super) id: String,
    pub(super) owner: String,
    pub(super) conversation_id: String,
    #[serde(default)]
    pub(super) child: Option<u32>,
    #[serde(default)]
    pub(super) box_id: Option<String>,
    pub(super) size: BoxSize,
    #[serde(default)]
    pub(super) parked: bool,
    /// The conversation was deleted; the Box is destroyed and the lease
    /// removed as soon as the Box service confirms.
    #[serde(default)]
    pub(super) deleted: bool,
    pub(super) box_expires_at: u64,
    /// The last lease epoch a `gwb1` key was signed for. Recovery continues
    /// above it, so a key signed before a restart never matches again.
    #[serde(default)]
    pub(super) lease_epoch: u64,
}

impl SessionLease {
    pub(super) fn key(&self) -> SessionBoxKey {
        SessionBoxKey {
            owner: self.owner.clone(),
            conversation_id: self.conversation_id.clone(),
            child: self.child,
        }
    }

    pub(super) fn name(&self) -> String {
        box_name(&self.id)
    }
}

pub(super) fn box_name(lease_id: &str) -> String {
    format!("{NAME_PREFIX}{lease_id}")
}

pub(super) fn lease_directory() -> std::path::PathBuf {
    crate::paths::state_path("session-box-leases")
}

pub(super) fn checked_lease_directory() -> Result<std::path::PathBuf> {
    let directory = lease_directory();
    std::fs::create_dir_all(&directory)?;
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Session Box lease directory must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory)
}

pub(super) fn write_lease(lease: &SessionLease) -> Result<()> {
    use std::io::Write;
    let directory = checked_lease_directory()?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&serde_json::to_vec(lease)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(format!("{}.json", lease.id)))
        .map_err(|_| anyhow!("Session Box lease persistence failed"))?;
    Ok(())
}

pub(super) fn remove_lease(lease_id: &str) -> Result<()> {
    match std::fs::remove_file(lease_directory().join(format!("{lease_id}.json"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn read_lease(path: &std::path::Path) -> Result<Option<SessionLease>> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Ok(None);
    }
    ensure!(
        meta.len() <= LEASE_FILE_LIMIT,
        "Session Box lease exceeded limit"
    );
    let lease: SessionLease = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        lease.schema_version == 1
            && uuid::Uuid::parse_str(&lease.id)?.to_string() == lease.id
            && path.file_name().and_then(|name| name.to_str())
                == Some(format!("{}.json", lease.id).as_str()),
        "Invalid session Box lease"
    );
    Ok(Some(lease))
}

/// Every readable lease; unreadable files are reported and skipped.
pub(super) fn leases() -> Vec<SessionLease> {
    let Ok(entries) = std::fs::read_dir(lease_directory()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.take(MAX_LEASES).flatten() {
        match read_lease(&entry.path()) {
            Ok(Some(lease)) => found.push(lease),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(error = %error, "Session Box lease is unreadable; skipping it");
            }
        }
    }
    found
}

pub(super) fn lease_of(entry: &Entry) -> SessionLease {
    SessionLease {
        schema_version: 1,
        id: entry.lease_id.clone(),
        owner: entry.key.owner.clone(),
        conversation_id: entry.key.conversation_id.clone(),
        child: entry.key.child,
        box_id: Some(entry.box_id.0.clone()),
        size: entry.size,
        parked: entry.phase == Phase::Parked,
        deleted: false,
        box_expires_at: entry.box_expires_at,
        lease_epoch: entry.lease_epoch,
    }
}
