//! Installing the Needle native library out of its platform wheel, and the
//! wheel platform tag for this build target.

use std::io::{Cursor, Read};
use std::path::Path;

pub(super) fn extract_library(
    label: &str,
    name: &str,
    wheel_path: &Path,
    library_path: &Path,
    member: &str,
) -> Result<(), String> {
    let wheel = std::fs::read(wheel_path)
        .map_err(|error| format!("read {label} wheel {}: {error}", wheel_path.display()))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(wheel))
        .map_err(|error| format!("open {label} wheel: {error}"))?;
    let mut library = Vec::new();
    archive
        .by_name(member)
        .map_err(|error| format!("find {member} in {label} wheel: {error}"))?
        .read_to_end(&mut library)
        .map_err(|error| format!("read {member} from {label} wheel: {error}"))?;

    let parent = library_path
        .parent()
        .ok_or_else(|| format!("{label} library path has no parent"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {label} library dir: {error}"))?;
    let temporary = parent.join(format!(".{name}-library-{}.tmp", std::process::id()));
    std::fs::write(&temporary, library)
        .map_err(|error| format!("write temporary {label} library: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, library_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("install {label} library: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(library_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("set {label} library permissions: {error}"))?;
    }
    Ok(())
}

pub(super) fn library_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "libneedle.dylib"
    } else if cfg!(target_os = "windows") {
        "libneedle.dll"
    } else {
        "libneedle.so"
    }
}

#[allow(unreachable_code)]
pub(crate) fn platform_tag() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("macosx_11_0_arm64");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("macosx_11_0_x86_64");
    }
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "aarch64"))]
    {
        return Some("manylinux2014_aarch64");
    }
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
    {
        return Some("manylinux2014_x86_64");
    }
    #[cfg(all(target_os = "linux", target_env = "musl", target_arch = "aarch64"))]
    {
        return Some("musllinux_1_2_aarch64");
    }
    #[cfg(all(target_os = "linux", target_env = "musl", target_arch = "x86_64"))]
    {
        return Some("musllinux_1_2_x86_64");
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("win_amd64");
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some("win_arm64");
    }
    None
}
