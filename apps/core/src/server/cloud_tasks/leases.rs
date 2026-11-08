//! Durable task leases: write, read and recover them after a restart.

use super::*;

pub(super) fn lease_directory() -> std::path::PathBuf {
    crate::paths::state_path("cloud-task-leases")
}
pub(super) fn remove_lease(lease_id: &str) -> Result<()> {
    let path = lease_directory().join(format!("{lease_id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
pub(super) fn persist_lease(task: &LiveTask) -> Result<()> {
    let (backend, handle) = match &task.workspace {
        TaskWorkspace::Docker(_) => ("docker", json!(task.lease_id)),
        TaskWorkspace::Governed(handle) => ("governed", serde_json::to_value(handle)?),
        TaskWorkspace::Vpn(handle) => ("vpn", serde_json::to_value(handle)?),
        TaskWorkspace::Box(id) => ("box", box_arm::lease_handle(&task.lease_id, Some(id))),
    };
    let lease = TaskLease {
        schema_version: 1,
        id: task.lease_id.clone(),
        owner: task.profile.owner.clone(),
        conversation_id: task.conversation_id.clone(),
        expires_at: task.expires_at,
        backend: backend.into(),
        handle,
    };
    if backend == "box" {
        persist_record_replace(&lease)
    } else {
        persist_record(&lease)
    }
}
pub(super) fn persist_record(lease: &TaskLease) -> Result<()> {
    write_record(lease, false)
}
/// Like [`persist_record`], but overwrites the lease (the Box arm records its
/// box id after the name-only lease written before create).
pub(super) fn persist_record_replace(lease: &TaskLease) -> Result<()> {
    write_record(lease, true)
}
pub(super) fn write_record(lease: &TaskLease, overwrite: bool) -> Result<()> {
    use std::io::Write;
    let directory = lease_directory();
    std::fs::create_dir_all(&directory)?;
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Cloud task lease directory must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&serde_json::to_vec(&lease)?)?;
    file.as_file().sync_all()?;
    let path = directory.join(format!("{}.json", lease.id));
    if overwrite {
        file.persist(path)
            .map_err(|_| anyhow!("Cloud task lease persistence failed"))?;
    } else {
        file.persist_noclobber(path)
            .map_err(|_| anyhow!("Cloud task lease persistence failed"))?;
    }
    Ok(())
}
/// Read and validate one lease file. `Ok(None)` skips an entry that is not a
/// lease file or lies outside `scope`.
pub(super) fn read_lease(
    entry: std::io::Result<std::fs::DirEntry>,
    scope: Option<(&str, &str)>,
) -> Result<Option<(TaskLease, std::path::PathBuf)>> {
    let entry = entry?;
    let meta = std::fs::symlink_metadata(entry.path())?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Ok(None);
    }
    ensure!(meta.len() <= 16384, "Cloud task lease exceeded limit");
    let lease: TaskLease = serde_json::from_slice(&std::fs::read(entry.path())?)?;
    if scope.is_some_and(|(owner, conversation)| {
        lease.owner != owner || lease.conversation_id != conversation
    }) {
        return Ok(None);
    }
    ensure!(
        lease.schema_version == 1
            && uuid::Uuid::parse_str(&lease.id)?.to_string() == lease.id
            && entry.file_name().to_str() == Some(&format!("{}.json", lease.id)),
        "Invalid cloud task resource lease"
    );
    Ok(Some((lease, entry.path())))
}
pub(super) async fn recover_leases() -> Result<()> {
    recover_leases_matching(None).await
}
pub(super) async fn recover_leases_matching(scope: Option<(&str, &str)>) -> Result<()> {
    let directory = lease_directory();
    if !directory.exists() {
        return Ok(());
    }
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Cloud task lease directory must not be a symlink"
    );
    let mut failure: Option<anyhow::Error> = None;
    for (index, entry) in std::fs::read_dir(directory)?.enumerate() {
        ensure!(index < 1000, "Cloud task lease inventory exceeded limit");
        // A malformed lease file is reported and skipped, like a failed cleanup,
        // so it cannot strand every other lease in the sweep.
        let (lease, path) = match read_lease(entry, scope) {
            Ok(Some(found)) => found,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(error = %error, "Cloud task lease is unreadable; skipping it");
                failure.get_or_insert(error);
                continue;
            }
        };
        // Runtime state is process-local. Any lease absent from that registry
        // belongs to an interrupted prior process and is cleaned, never resumed
        // with missing policy/credential custody.
        let slots: Vec<_> = tasks().lock().await.values().cloned().collect();
        let mut live = false;
        for slot in slots {
            if let TaskState::Ready(task) = &*slot.lock().await {
                if task.lease_id == lease.id {
                    live = true;
                    break;
                }
            }
        }
        if live {
            continue;
        }
        // One lease's failure (a Box API outage, a removed Box token) must not
        // strand every other backend's leases: record it and keep cleaning.
        let cleaned: Result<()> = async {
            match lease.backend.as_str() {
                "docker" => {
                    ensure!(
                        lease.handle.as_str() == Some(&lease.id),
                        "Invalid cloud Docker lease identity"
                    );
                    ryu_sandbox::docker::DockerSandbox::new()
                        .destroy_leased_workspace(&lease.id, lease.expires_at)
                        .await?;
                }
                "governed" => {
                    let handle: ryu_sandbox::governed::GovernedWorkspace =
                        serde_json::from_value(lease.handle)?;
                    ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                        .destroy(&handle)
                        .await?;
                }
                "vpn" => {
                    let handle: ryu_sandbox::governed_vpn::GovernedVpnWorkspace =
                        serde_json::from_value(lease.handle)?;
                    environments::vpn_runtime()?
                        .destroy_workspace(&handle)
                        .await?;
                }
                "box" if scope.is_none() && lease.expires_at > now()? => {
                    // A Core restart parks the Box instead of destroying it
                    // (design §7.3): its work is saved, and the lease stays
                    // until the task's lifetime ends or its conversation is
                    // stopped or deleted (scoped sweeps destroy).
                    if !box_arm::lease_is_parked(&lease.handle) {
                        let handle = box_arm::park_lease(&lease.id, &lease.handle).await?;
                        persist_record_replace(&TaskLease {
                            schema_version: lease.schema_version,
                            id: lease.id.clone(),
                            owner: lease.owner.clone(),
                            conversation_id: lease.conversation_id.clone(),
                            expires_at: lease.expires_at,
                            backend: lease.backend.clone(),
                            handle,
                        })?;
                    }
                    return Ok(());
                }
                "box" => box_arm::recover_lease(&lease.id, &lease.handle).await?,
                _ => bail!("Unknown cloud task lease backend"),
            }
            std::fs::remove_file(&path)?;
            Ok(())
        }
        .await;
        if let Err(error) = cleaned {
            tracing::warn!(lease = %lease.id, error = %error, "Cloud task lease cleanup failed; retrying later");
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}
