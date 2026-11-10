//! Sealing an export and opening an archive through owner-only plaintext scratch.

use super::*;

/// Encrypt the plaintext zip in `zip` (any position) into `output`.
pub(super) fn seal_export(
    zip: &mut std::fs::File,
    output: &mut impl Write,
    archive: &ExportKey,
) -> std::io::Result<()> {
    use std::io::Seek;
    let ExportKey {
        salt,
        iterations,
        key,
    } = archive;
    output.write_all(EXPORT_MAGIC)?;
    output.write_all(&iterations.to_be_bytes())?;
    output.write_all(salt)?;
    zip.rewind()?;
    let length = zip.metadata()?.len();
    ryu_backup::encryption::encrypt(&mut *zip, &mut *output, length, key)
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// `tmp/<owner>` scratch for the plaintext zip of an export or import.
pub(super) const EXPORT_SCRATCH_OWNER: &str = "exports";
pub(super) const IMPORT_SCRATCH_OWNER: &str = "imports";

/// An anonymous (already unlinked) file for a plaintext data zip. It lives in
/// the owner-only `tmp/<owner>` of the local data folder `root`, never next to
/// the archive: the archive's folder is the backup medium (USB stick, network
/// share, sync folder) the passphrase protects, and filesystems without
/// `O_TMPFILE` briefly name the file (or keep a silly-renamed copy on NFS/SMB).
/// When `root` is not an existing real directory, the OS temp dir is used.
pub(super) fn plaintext_scratch(root: &Path, owner: &str) -> std::io::Result<std::fs::File> {
    let usable_root = std::fs::symlink_metadata(root)
        .is_ok_and(|metadata| metadata.file_type().is_dir() && !metadata.file_type().is_symlink());
    if usable_root {
        let scratch = layout::tmp_dir_for(root, owner);
        if ryu_backup::archive::private_directory(&scratch).is_ok() {
            if let Ok(file) = tempfile::tempfile_in(&scratch) {
                return Ok(file);
            }
        }
    }
    tempfile::tempfile()
}

/// Open a data backup for import into `destination`. An encrypted export is
/// decrypted into an anonymous temporary file (see [`plaintext_scratch`]); a
/// legacy plain zip is returned as is.
pub(super) fn open_data_archive(
    archive: &Path,
    destination: &Path,
    passphrase: Option<&str>,
) -> std::io::Result<std::fs::File> {
    open_data_archive_keyed(archive, destination, passphrase).map(|(file, _)| file)
}

/// [`open_data_archive`] plus the archive key (`None` for a legacy plain zip),
/// which unwraps the key bundle.
pub(super) fn open_data_archive_keyed(
    archive: &Path,
    destination: &Path,
    passphrase: Option<&str>,
) -> std::io::Result<(std::fs::File, Option<[u8; 32]>)> {
    use std::io::Seek;
    let mut file = std::fs::File::open(archive)?;
    let mut magic = [0u8; 8];
    let read = file.read(&mut magic)?;
    file.rewind()?;
    if read < magic.len() || &magic != EXPORT_MAGIC {
        // A pre-encryption export: an ordinary zip, validated by the caller.
        return Ok((file, None));
    }
    let passphrase = passphrase
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid_input("this data backup is encrypted; supply its passphrase to restore it")
        })?;
    let mut header = [0u8; 8 + 4 + EXPORT_SALT_LEN];
    file.read_exact(&mut header)?;
    let iterations = u32::from_be_bytes(header[8..12].try_into().expect("4 bytes"));
    if !(EXPORT_MIN_ITERATIONS..=EXPORT_MAX_ITERATIONS).contains(&iterations) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup has an unsupported key-derivation setting",
        ));
    }
    let key = export_key(passphrase, &header[12..], iterations);
    let mut plain = plaintext_scratch(destination, IMPORT_SCRATCH_OWNER)?;
    ryu_backup::encryption::decrypt(&mut file, &mut plain, &key).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "could not decrypt the data backup: wrong passphrase or damaged file",
        )
    })?;
    plain.rewind()?;
    Ok((plain, Some(key)))
}
