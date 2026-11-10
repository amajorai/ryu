//! Export encryption, archive contents and backup exclusions.

use super::*;
use crate::data_path::backup_exclusions::is_backup_excluded;
use crate::data_path::restore::copy_declared_backup_entry;

#[test]
fn export_then_import_roundtrips() {
    let base = std::env::temp_dir().join(format!("ryu-dp-test-{}", std::process::id()));
    let src = base.join("src");
    let nested = src.join("sub");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(src.join("a.txt"), b"hello").unwrap();
    std::fs::write(nested.join("b.txt"), b"world").unwrap();

    let zip = base.join("backup.zip");
    let bytes = test_export(&src, &zip).unwrap();
    assert_eq!(bytes, 10); // "hello" + "world"

    let dest = base.join("restored");
    // import_zip also writes the pointer; that's fine in a test (config dir).
    let mut archive = open_test_archive(&zip);
    std::fs::create_dir_all(&dest).unwrap();
    for i in 0..archive.len() {
        let mut e = archive.by_index(i).unwrap();
        if e.is_file() {
            let out = dest.join(e.enclosed_name().unwrap());
            std::fs::create_dir_all(out.parent().unwrap()).unwrap();
            let mut w = std::fs::File::create(&out).unwrap();
            std::io::copy(&mut e, &mut w).unwrap();
        }
    }
    assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"hello");
    assert_eq!(std::fs::read(dest.join("sub/b.txt")).unwrap(), b"world");

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn export_zip_of_empty_dir_writes_zero_bytes() {
    let base = std::env::temp_dir().join(format!("ryu-dp-empty-{}", uniq()));
    let src = base.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let zip = base.join("out.zip");
    let written = test_export(&src, &zip).unwrap();
    assert_eq!(written, 0);
    assert!(zip.exists(), "an empty archive is still produced");
    let _ = std::fs::remove_dir_all(&base);
}

/// The data folder's top-level `tmp/` is where an export keeps its own
/// plaintext scratch zip. Walking it would read that file (a sharing
/// violation on Windows, where it stays named) and archive leftovers.
#[test]
fn export_leaves_the_data_folder_tmp_scratch_out_of_the_archive() {
    let base = tempfile::tempdir().unwrap();
    let src = base.path().join("src");
    std::fs::create_dir_all(src.join("tmp/exports")).unwrap();
    std::fs::create_dir_all(src.join("db")).unwrap();
    std::fs::write(src.join("tmp/exports/leftover"), b"stale scratch").unwrap();
    std::fs::write(src.join("tmp/notes.txt"), b"scratch").unwrap();
    std::fs::write(src.join("db/rows.txt"), b"rows").unwrap();
    // A nested `tmp` is a plugin's own data and still travels.
    std::fs::create_dir_all(src.join("plugin-data/acme/tmp")).unwrap();
    std::fs::write(src.join("plugin-data/acme/tmp/kept"), b"kept").unwrap();

    let out = base.path().join("backup.zip");
    test_export(&src, &out).unwrap();
    let mut archive = open_test_archive(&out);
    let names = (0..archive.len())
        .map(|index| {
            archive
                .by_index(index)
                .unwrap()
                .name()
                .unwrap()
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        !names.iter().any(|name| name.starts_with("tmp/")),
        "{names:?}"
    );
    assert!(names.iter().any(|name| name == "db/rows.txt"), "{names:?}");
    assert!(
        names.iter().any(|name| name == "plugin-data/acme/tmp/kept"),
        "{names:?}"
    );
}

#[test]
fn export_zip_omits_credentials_and_runtime_markers() {
    let base = std::env::temp_dir().join(format!("ryu-dp-safe-export-{}", uniq()));
    let src = base.join("src");
    std::fs::create_dir_all(src.join("nested")).unwrap();
    for name in [
        "accounts.json",
        "auth.json",
        "bootstrap-ack.token",
        "core.token",
        "delegation-ed25519.pub",
        "fleet-desired.json",
        "fleet-enforcement.json",
        "fleet-enrolled-node.json",
        "fleet-enrollment-pending.json",
        "fleet-identity.json",
        "fleet-instance-id.json",
        "fleet-skill-blocks.json",
        "fleet-status.json",
        "gateway-admin.key",
        "gateway-durable.token",
        "gateway-relay.token",
        "mcp.json",
        "models.json",
        "node-auth.token",
        "node-control.token",
        "nodes.json",
        "paired-clients.json",
        "pi-accounts.db",
        "plugin-secrets.db",
        "ryu-core.pid",
    ] {
        std::fs::write(src.join(name), b"secret").unwrap();
    }
    std::fs::create_dir_all(src.join("fleet-artifacts")).unwrap();
    std::fs::write(src.join("fleet-artifacts/private.json"), b"secret").unwrap();
    std::fs::create_dir_all(src.join("plugin-credentials")).unwrap();
    std::fs::write(src.join("plugin-credentials/private.json"), b"secret").unwrap();
    std::fs::write(src.join("nested/auth.json"), b"nested-secret").unwrap();
    std::fs::write(src.join("conversations.db"), b"customer-data").unwrap();
    std::fs::create_dir_all(src.join("secrets")).unwrap();
    std::fs::write(src.join("secrets/master.key"), b"key").unwrap();
    std::fs::write(src.join("secrets/opaque-credential"), b"secret").unwrap();

    let archive_path = base.join("backup.zip");
    test_export(&src, &archive_path).unwrap();
    let mut archive = open_test_archive(&archive_path);
    let names = (0..archive.len())
        .map(|index| {
            archive
                .by_index(index)
                .unwrap()
                .name()
                .unwrap()
                .into_owned()
        })
        .collect::<Vec<_>>();
    for name in [
        "accounts.json",
        "auth.json",
        "bootstrap-ack.token",
        "core.token",
        "delegation-ed25519.pub",
        "fleet-desired.json",
        "fleet-enforcement.json",
        "fleet-enrolled-node.json",
        "fleet-enrollment-pending.json",
        "fleet-identity.json",
        "fleet-instance-id.json",
        "fleet-skill-blocks.json",
        "fleet-status.json",
        "fleet-artifacts/private.json",
        "gateway-admin.key",
        "gateway-durable.token",
        "gateway-relay.token",
        "mcp.json",
        "models.json",
        "node-auth.token",
        "node-control.token",
        "nodes.json",
        "paired-clients.json",
        "pi-accounts.db",
        "plugin-credentials/private.json",
        "plugin-secrets.db",
        "ryu-core.pid",
        "nested/auth.json",
        "secrets/opaque-credential",
    ] {
        assert!(!names.iter().any(|entry| entry == name), "exported {name}");
    }
    assert!(names.iter().any(|entry| entry == "conversations.db"));
    assert!(
        names.iter().any(|entry| entry == "secrets/master.key"),
        "the encryption key must travel with the encrypted databases"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn export_is_encrypted_on_disk_and_needs_the_passphrase() {
    let base = tempfile::tempdir().unwrap();
    let src = base.path().join("src");
    std::fs::create_dir_all(src.join("secrets")).unwrap();
    let secret = "sk-live-export-credential-0123456789";
    std::fs::write(src.join("preferences.json"), secret).unwrap();
    std::fs::write(src.join("secrets/master.key"), "master-key-bytes-base64").unwrap();
    let out = base.path().join("backup.zip");
    test_export(&src, &out).unwrap();

    // Neither the stored secret, the key file, nor zip structure is visible.
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.starts_with(EXPORT_MAGIC));
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains(secret));
    assert!(!text.contains("master-key-bytes-base64"));
    assert!(!text.contains("preferences.json"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&out).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "export must be owner-only");
    }
    // No plaintext staging file is left next to the export.
    let siblings: Vec<_> = std::fs::read_dir(base.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(siblings.len(), 2, "{siblings:?}");

    // Round-trip with the passphrase.
    let mut archive = open_test_archive(&out);
    let mut restored = String::new();
    archive
        .by_name("preferences.json")
        .unwrap()
        .read_to_string(&mut restored)
        .unwrap();
    assert_eq!(restored, secret);

    // Missing or wrong passphrases fail closed.
    let missing = open_data_archive(&out, &src, None).unwrap_err();
    assert!(missing.to_string().contains("passphrase"));
    let wrong = open_data_archive(&out, &src, Some("wrong passphrase!!")).unwrap_err();
    assert_eq!(wrong.kind(), std::io::ErrorKind::PermissionDenied);
    // A truncated or edited file is rejected, never partially imported.
    let mut damaged = bytes.clone();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    let damaged_path = base.path().join("damaged.zip");
    std::fs::write(&damaged_path, damaged).unwrap();
    assert!(open_data_archive(&damaged_path, &src, Some(TEST_PASSPHRASE)).is_err());
}

/// The plaintext zip of an export or import lives in the data folder's
/// owner-only `tmp/<owner>`, never in the archive's folder (the backup
/// medium). Linux names an anonymous file's directory in `/proc/self/fd`,
/// whether it was made with `O_TMPFILE` or named and then unlinked.
#[cfg(target_os = "linux")]
#[test]
fn plaintext_scratch_stays_in_the_data_folder_tmp_not_the_backup_medium() {
    use std::os::unix::io::AsRawFd;
    let base = tempfile::tempdir().unwrap();
    let data = base.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let medium = base.path().join("usb");
    std::fs::create_dir_all(&medium).unwrap();
    for owner in [EXPORT_SCRATCH_OWNER, IMPORT_SCRATCH_OWNER] {
        let file = plaintext_scratch(&data, owner).unwrap();
        let link = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
        let scratch = layout::tmp_dir_for(&data, owner);
        assert!(link.starts_with(&scratch), "{link:?} not under {scratch:?}");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&scratch).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "scratch dir must be owner-only");
        // Nothing in the scratch dir is reachable by name.
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    }
    // A destination that does not exist yet falls back to the OS temp dir,
    // never the archive's folder.
    let file = plaintext_scratch(&medium.join("missing"), IMPORT_SCRATCH_OWNER).unwrap();
    let link = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
    assert!(!link.starts_with(&medium), "{link:?}");

    // A full export and import write only the final archive to the medium.
    std::fs::write(data.join("preferences.json"), "sk-medium-check").unwrap();
    let out = medium.join("backup.zip");
    test_export(&data, &out).unwrap();
    let restore = base.path().join("restore");
    std::fs::create_dir_all(&restore).unwrap();
    import_zip(&out, &restore, Some(TEST_PASSPHRASE)).unwrap();
    let on_medium: Vec<_> = std::fs::read_dir(&medium)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(on_medium, vec![std::ffi::OsString::from("backup.zip")]);
    assert_eq!(
        std::fs::read_to_string(restore.join("preferences.json")).unwrap(),
        "sk-medium-check"
    );
}

#[test]
fn export_refuses_a_short_passphrase_and_writes_nothing() {
    let base = tempfile::tempdir().unwrap();
    let src = base.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    let out = base.path().join("backup.zip");
    for passphrase in ["", "short"] {
        let error = export_zip(&src, &out, passphrase).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
    assert!(!out.exists());
}

#[test]
fn legacy_plain_zip_exports_still_open_without_a_passphrase() {
    let base = tempfile::tempdir().unwrap();
    let legacy = base.path().join("legacy.zip");
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&legacy).unwrap());
        zip.start_file("a.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();
    }
    for passphrase in [None, Some(TEST_PASSPHRASE)] {
        let mut archive =
            zip::ZipArchive::new(open_data_archive(&legacy, base.path(), passphrase).unwrap())
                .unwrap();
        let mut text = String::new();
        archive
            .by_name("a.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "hello");
    }
}

#[test]
fn export_zip_rejects_a_destination_inside_the_data_folder() {
    let base = std::env::temp_dir().join(format!("ryu-dp-overlap-{}", uniq()));
    let src = base.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let result = test_export(&src, &src.join("backup.zip"));
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("inside the data folder"));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn backup_exclusion_applies_to_nested_credentials_and_runtime_state() {
    assert!(is_backup_excluded(Path::new("nested/node-auth.token")));
    assert!(is_backup_excluded(Path::new("nested/NODE-AUTH.TOKEN")));
    assert!(is_backup_excluded(Path::new("Core.Token")));
    assert!(is_backup_excluded(Path::new("plugin-credentials")));
    assert!(is_backup_excluded(Path::new(
        "plugin-credentials/service.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "nested/PLUGIN-CREDENTIALS/service.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "fleet-artifacts/nested/private.json"
    )));
    assert!(!is_backup_excluded(Path::new(
        "plugin-credentials-copy/notes.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "state/fleet-enrolled-node.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "runtimes/codex-home/auth.json.ryu-safety-backup"
    )));
    assert!(!is_backup_excluded(Path::new("db/conversations.db")));
}

#[test]
fn backup_excludes_linked_plan_account_sign_ins() {
    assert!(is_backup_excluded(Path::new(
        "state/plan-accounts/anthropic-0a1b2c3d4e5f/.credentials.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "state/plan-accounts/anthropic-0a1b2c3d4e5f/.claude.json"
    )));
    assert!(is_backup_excluded(Path::new(
        "state/plan-accounts/openai-0a1b2c3d4e5f/auth.json"
    )));
    assert!(is_backup_excluded(Path::new("state/plan-accounts")));
    // The same files are left out wherever a CLI keeps them under the data dir.
    assert!(is_backup_excluded(Path::new(
        "runtimes/claude-home/.credentials.json"
    )));
}

#[test]
fn backup_keeps_only_the_key_custody_files_from_secrets() {
    assert!(!is_backup_excluded(Path::new("secrets")));
    assert!(!is_backup_excluded(Path::new("secrets/master.key")));
    assert!(!is_backup_excluded(Path::new("secrets/memory.key")));
    assert!(is_backup_excluded(Path::new("secrets/core.token")));
    assert!(is_backup_excluded(Path::new("secrets/some-new-credential")));
    assert!(is_backup_excluded(Path::new(
        "secrets/native-accounts/a.json"
    )));
    assert!(is_backup_excluded(Path::new("secrets/plugin-credentials")));
    assert!(!is_backup_excluded(Path::new("state/secrets-notes.json")));
}

#[test]
fn backup_copy_stops_at_declared_expansion_limit() {
    let mut source = std::io::Cursor::new(b"forged-expanded-payload".to_vec());
    let mut output = Vec::new();
    let error = copy_declared_backup_entry(&mut source, &mut output, 4, 100)
        .expect_err("understated ZIP size must fail");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(output.len(), 5);
}
