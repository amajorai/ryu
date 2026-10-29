//! Identity survives a rename and distinguishes a replacement at the same path.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeIdentity {
    volume: u64,
    file: u64,
    created: String,
}

impl TreeIdentity {
    pub fn read(path: &Path) -> Result<Option<Self>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            !metadata.file_type().is_symlink() && (metadata.is_file() || metadata.is_dir()),
            "cleanup tree is not a regular file or directory"
        );
        let created = match metadata.created() {
            Ok(time) => time.duration_since(UNIX_EPOCH)?.as_nanos().to_string(),
            // A filesystem without birth times cannot safely distinguish inode
            // reuse. Preserve these trees rather than guessing ownership.
            Err(error) if error.kind() == std::io::ErrorKind::Unsupported => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        #[cfg(unix)]
        let (volume, file) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(windows)]
        let (volume, file) = {
            use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT,
            };
            let handle = fs::OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
            anyhow::ensure!(
                unsafe {
                    GetFileInformationByHandle(handle.as_raw_handle() as _, info.as_mut_ptr())
                } != 0,
                "could not identify cleanup tree: {}",
                std::io::Error::last_os_error()
            );
            let info = unsafe { info.assume_init() };
            (
                u64::from(info.dwVolumeSerialNumber),
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            )
        };
        Ok(Some(Self {
            volume,
            file,
            created,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_survives_rename_but_rejects_a_replacement() {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original");
        let moved = home.path().join("moved");
        fs::create_dir(&original).unwrap();
        let identity = TreeIdentity::read(&original).unwrap();
        fs::rename(&original, &moved).unwrap();
        assert_eq!(TreeIdentity::read(&moved).unwrap(), identity);
        fs::create_dir(&original).unwrap();
        if identity.is_some() {
            assert_ne!(TreeIdentity::read(&original).unwrap(), identity);
        }
    }
}
