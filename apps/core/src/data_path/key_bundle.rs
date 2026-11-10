//! Sealing and adopting the master-key bundle an export carries.

use super::*;

/// Seals and adopts the master-key bundle. Production goes through
/// `ryu_crypto::custody`; tests inject a fake so they never touch the test
/// binary's own key custody.
pub(crate) trait KeyBundlePort {
    /// The sealed bundle for the data folder `from`, or `None` when `from` is
    /// not the folder this process holds the key of.
    fn seal_for(&self, from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>>;
    /// Adopt `sealed` as the key of the data folder `to` (Core stopped).
    fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()>;
}

/// The real key custody.
pub(super) struct CustodyKeyBundles;

fn same_folder(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Hidden `data-path` command that adopts a key bundle into the data folder
/// named by `RYU_DIR` (stdin: wrapping key base64, then the sealed bundle).
pub(super) const ADOPT_KEY_BUNDLE_CMD: &str = "adopt-key-bundle";

impl KeyBundlePort for CustodyKeyBundles {
    fn seal_for(&self, from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
        if !same_folder(from, &paths::ryu_dir()) {
            return Ok(None);
        }
        crate::crypto_host::install();
        ryu_crypto::custody::seal_key_bundle(&ryu_crypto::FieldCipher::new(wrap))
            .map(Some)
            .map_err(|error| {
                std::io::Error::other(format!(
                    "could not read the master key to include it in the export: {error:#}"
                ))
            })
    }

    fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
        if same_folder(to, &paths::ryu_dir()) {
            crate::crypto_host::install();
            return adopt_key_bundle_here(wrap, sealed);
        }
        // Another folder: resolve its custody in a child whose data dir is `to`
        // (the key ladder caches the data dir for the life of a process).
        adopt_key_bundle_in_child(to, wrap, sealed)
    }
}

pub(super) fn adopt_key_bundle_here(wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
    let outcome =
        ryu_crypto::custody::import_key_bundle(&ryu_crypto::FieldCipher::new(wrap), sealed)
            .map_err(|error| {
                std::io::Error::other(format!(
            "could not adopt the backup's master key: {error:#}. Import the backup into a new \
             profile instead"
        ))
            })?;
    match outcome.retired {
        Some(retired) => eprintln!(
            "data-path import: adopted the backup's master key ({}, {} custody); this folder's \
             previous key {retired} is retired and still opens its data",
            outcome.kcv, outcome.custody
        ),
        None => eprintln!(
            "data-path import: the backup uses this folder's master key ({})",
            outcome.kcv
        ),
    }
    Ok(())
}

/// The keychain switch the adoption child must run with.
pub(super) const ADOPT_CHILD_KEYCHAIN: &str = "off";

/// The child that adopts a key bundle into the non-active folder `to`.
///
/// The keychain slot belongs to the profile, not to a folder: it holds the
/// active folder's key. The child therefore runs with the keychain off, so the
/// archive key lands as `to`'s own `secrets/master.key` (`file` custody) and
/// the active folder's keychain entry is neither retired into `to` nor
/// overwritten.
pub(super) fn adopt_child_command(exe: &Path, to: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(exe);
    command
        .args(["data-path", ADOPT_KEY_BUNDLE_CMD])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null());
    ryu_crypto::scrub_seal_env(&mut command);
    command
        .env(paths::RYU_DIR_ENV, to)
        .env(ADOPT_CHILD_KEYCHAIN_ENV, ADOPT_CHILD_KEYCHAIN);
    command
}

/// `RYU_KEYCHAIN`: `off` keeps a process away from the profile's keychain slot.
pub(super) const ADOPT_CHILD_KEYCHAIN_ENV: &str = "RYU_KEYCHAIN";

pub(super) fn adopt_child_keychain_is_off() -> bool {
    std::env::var(ADOPT_CHILD_KEYCHAIN_ENV)
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case(ADOPT_CHILD_KEYCHAIN))
}

fn adopt_key_bundle_in_child(to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
    use base64::Engine as _;
    std::fs::create_dir_all(to)?;
    let mut command = adopt_child_command(&std::env::current_exe()?, to);
    let mut child = command.spawn()?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("no stdin for the key adoption step"))?;
        let wrap_key = base64::engine::general_purpose::STANDARD.encode(wrap);
        writeln!(stdin, "{wrap_key}")?;
        writeln!(stdin, "{sealed}")?;
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            "could not adopt the backup's master key into the target folder; import the backup \
             into a new profile instead",
        ))
    }
}
