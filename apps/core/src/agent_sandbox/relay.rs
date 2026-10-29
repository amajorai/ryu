use super::*;

/// Path of the relay socket Core serves for a loopback port.
pub(super) fn relay_socket(relay_dir: &Path, port: u16) -> PathBuf {
    relay_dir.join(format!("{port}.sock"))
}

/// Directory holding the per-port relay sockets: private to this user, short
/// enough for `sockaddr_un`, and outside every masked path.
#[cfg(unix)]
pub fn relay_dir() -> Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let dir = PathBuf::from("/tmp").join(format!("ryu-agent-net-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("creating the agent relay directory"),
    }
    let metadata = std::fs::symlink_metadata(&dir).context("inspecting the relay directory")?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_dir() || metadata.uid() != uid {
        bail!("{} is not a directory owned by this user", dir.display());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .context("restricting the relay directory")?;
    }
    Ok(dir)
}

/// Serve `relay_dir/<port>.sock`, connecting each accepted stream to
/// `127.0.0.1:<port>` on the host. Idempotent per port for the process.
#[cfg(unix)]
pub async fn ensure_loopback_relay(relay_dir: &Path, port: u16) -> Result<()> {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static SERVED: Mutex<Option<HashSet<(PathBuf, u16)>>> = Mutex::new(None);
    let key = (relay_dir.to_path_buf(), port);
    {
        let mut served = SERVED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if served.get_or_insert_with(HashSet::new).contains(&key) {
            return Ok(());
        }
    }
    let socket = relay_socket(relay_dir, port);
    let _ = std::fs::remove_file(&socket);
    let listener = tokio::net::UnixListener::bind(&socket)
        .with_context(|| format!("binding agent relay {}", socket.display()))?;
    SERVED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_or_insert_with(HashSet::new)
        .insert(key);
    tokio::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                    Ok(mut outbound) => {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                    Err(error) => {
                        tracing::debug!(port, %error, "agent relay could not reach loopback port");
                    }
                }
            });
        }
    });
    Ok(())
}
