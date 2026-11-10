//! Data-folder relocation, profile copy, clean, export and import tests.

use super::archive::open_data_archive;
use super::archive_key::EXPORT_MIN_ITERATIONS;
use super::cli::maintenance_lease;
use super::copy::{copy_tree, copy_tree_filtered};
use super::export::{export_zip_with, export_zip_with_iterations};
use super::import::import_zip_with;
use super::key_bundle::KeyBundlePort;
use super::*;

mod clean;
mod copy;
mod export;
mod keys;
mod validate;

const TEST_PASSPHRASE: &str = "correct horse battery";

/// Export with the minimum accepted KDF cost so the suite stays fast.
fn test_export(from: &Path, out: &Path) -> std::io::Result<u64> {
    export_zip_with_iterations(from, out, TEST_PASSPHRASE, EXPORT_MIN_ITERATIONS)
}

fn open_test_archive(path: &Path) -> zip::ZipArchive<std::fs::File> {
    // A destination that does not exist decrypts into the OS temp dir.
    let destination = path.with_extension("restore-target");
    zip::ZipArchive::new(open_data_archive(path, &destination, Some(TEST_PASSPHRASE)).unwrap())
        .unwrap()
}

fn uniq() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// A key custody stand-in: the "source" holds key A, adoption records the
/// target's key file as it was at that moment (it must not have been
/// replaced by the archive yet).
struct FakeKeys {
    current: [u8; 32],
    adopted: std::sync::Mutex<Vec<(PathBuf, String, Option<Vec<u8>>)>>,
}

impl KeyBundlePort for FakeKeys {
    fn seal_for(&self, _from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
        use base64::Engine as _;
        let body = serde_json::json!({
            "v": 1,
            "current": base64::engine::general_purpose::STANDARD.encode(self.current),
        });
        Ok(Some(
            ryu_crypto::FieldCipher::new(wrap)
                .seal(&body.to_string())
                .unwrap(),
        ))
    }

    fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
        let opened = ryu_crypto::FieldCipher::new(wrap)
            .open(sealed)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let key_file = std::fs::read(to.join("secrets/master.key")).ok();
        self.adopted
            .lock()
            .unwrap()
            .push((to.to_path_buf(), opened, key_file));
        Ok(())
    }
}

/// A custody that never holds the exported folder's key (a non-active folder).
struct ForeignFolderKeys;

impl KeyBundlePort for ForeignFolderKeys {
    fn seal_for(&self, _from: &Path, _wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
        Ok(None)
    }

    fn adopt_into(&self, _to: &Path, _wrap: &[u8; 32], _sealed: &str) -> std::io::Result<()> {
        Ok(())
    }
}

fn bundle_less_archive(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}
