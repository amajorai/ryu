use super::*;

pub(super) fn private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot")
            .ok_or_else(|| anyhow!("Windows system directory unavailable"))?;
        let username = std::env::var("USERNAME").context("Windows account name unavailable")?;
        let domain = std::env::var("USERDOMAIN").context("Windows account domain unavailable")?;
        if username.is_empty() || domain.is_empty() {
            bail!("Windows account identity unavailable");
        }
        let grant = format!("{domain}\\{username}:(OI)(CI)F");
        let output = std::process::Command::new(PathBuf::from(system).join("System32/icacls.exe"))
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &grant])
            .creation_flags(0x08000000)
            .output()
            .context("Restricting native credential directory permissions")?;
        if !output.status.success() {
            bail!("Unable to restrict native credential directory permissions");
        }
    }
    Ok(())
}

pub(super) fn private_namespace_home(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .context("Restricting native account home permissions")?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub(super) fn valid_namespace(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn reject_links(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    bail!("Custody directories cannot be redirected");
                }
            }
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("Custody directories cannot be redirected");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(super) fn reject_descendant_links(home: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(home)?;
    let mut current = home.to_owned();
    for part in relative.components() {
        current.push(part);
        reject_links(&current)?;
    }
    Ok(())
}
