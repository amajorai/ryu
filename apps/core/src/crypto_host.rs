//! Core's implementation of the extracted [`ryu_crypto::CryptoHost`] seam.
//!
//! The `ryu-crypto` crate owns the encryption-at-rest primitives and the
//! master-key custody ladder (env → OS keychain → file fallback, with legacy
//! `memory.key` migration, key check values, retired keys and recovery). What it
//! cannot own — because they are kernel utilities — are the couplings the key
//! resolver needs: the profile-scoped keychain-account suffix
//! ([`crate::profile::suffix`]), the active data dir ([`crate::paths::ryu_dir`]),
//! and the probe that tells a wrong key from the right one by opening a few
//! sealed message bodies in `conversations.db`. This shim implements those, and
//! Core installs it once at boot via [`ryu_crypto::set_global_host`], BEFORE the
//! first store opens (`ConversationStore::open_default`), so `global_cipher()`
//! never races the install.
//!
//! It also carries the `ryu-core keys` recovery CLI ([`run_keys_cli`]: `status`,
//! `adopt --from <source>`, `retire <kcv>`) and the data-format marker checks.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use ryu_crypto::custody::{self, AdoptFrom, KeySourceKind};
use ryu_crypto::{CryptoHost, FieldCipher, KeyProbe};

/// Install [`CoreCryptoHost`] as the process-global crypto host. Idempotent (a
/// second call is a no-op). Called once from `main` at boot, before the first
/// store opens; also from the `#[cfg(test)]` in-memory store constructors, since
/// unit tests never run `main` yet still seal/open at-rest state through the real
/// `global_cipher()` (the host resolves profile + `~/.ryu`, which work fine in a
/// test binary — behaviour identical to before the crypto extraction).
pub fn install() {
    ryu_crypto::set_global_host(std::sync::Arc::new(CoreCryptoHost));
}

/// Every ryu-core test gets the host before any test body runs, so a test that
/// builds a sealing store without calling [`install`] still seals under the
/// (test-dir) master key instead of failing closed.
///
/// When `RYU_DIR` is unset, the test binary first gets a fresh per-process data
/// folder (removed at exit), before `paths::ryu_dir()` is cached, so unit tests
/// never read or write the developer's real profile (`~/.ryu-dev`). Under test
/// the host does not record a key check value either (see
/// [`CoreCryptoHost::records_kcv`]), so a run never pins a key into a shared
/// `RYU_DIR`.
#[cfg(test)]
#[ctor::ctor]
fn install_for_tests() {
    if std::env::var_os("RYU_DIR").is_none() {
        let dir = test_data_dir();
        let _ = std::fs::remove_dir_all(&dir);
        if std::fs::create_dir_all(&dir).is_ok() {
            std::env::set_var("RYU_DIR", &dir);
        }
    }
    install();
}

#[cfg(test)]
fn test_data_dir() -> PathBuf {
    std::env::temp_dir().join(format!("ryu-core-test-{}", std::process::id()))
}

#[cfg(test)]
#[ctor::dtor]
fn remove_test_data_dir() {
    let dir = test_data_dir();
    if std::env::var_os("RYU_DIR").is_some_and(|value| PathBuf::from(value) == dir) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Core's `CryptoHost` — the kernel side of the crypto seam.
pub struct CoreCryptoHost;

impl CryptoHost for CoreCryptoHost {
    fn keyring_account_suffix(&self) -> String {
        crate::profile::suffix()
    }

    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }

    /// Core owns the data folder's key record and data-format marker. Not under
    /// `cfg(test)`: tests resolve keys from whatever `RYU_MASTER_KEY` a sibling
    /// test set, so a recorded value would depend on test order and could lock
    /// a shared `RYU_DIR`. Custody transitions are tested with injected inputs
    /// in `ryu_crypto::custody`.
    fn records_kcv(&self) -> bool {
        !cfg!(test)
    }

    fn probe_master_key(&self, cipher: &FieldCipher) -> KeyProbe {
        probe_conversations(&conversations_db(), cipher)
    }

    fn sealed_data_evidence(&self) -> Option<String> {
        if sealed_sample(&conversations_db()).is_empty() {
            None
        } else {
            Some("conversations.db holds sealed message bodies".to_owned())
        }
    }
}

fn conversations_db() -> PathBuf {
    crate::paths::db_path("conversations.db")
}

/// Sealed message bodies the probe tries: the newest first (sealed under the
/// key the folder uses now), then the oldest (see
/// [`ryu_crypto::content_sqlite::sealed_message_sample`]).
fn sealed_sample(db: &Path) -> Vec<String> {
    ryu_crypto::content_sqlite::sealed_message_sample(db)
}

/// Probe a candidate master key: [`KeyProbe::Passed`] when any sampled sealed
/// body opens, [`KeyProbe::Failed`] when bodies exist and none opens.
fn probe_conversations(db: &Path, cipher: &FieldCipher) -> KeyProbe {
    ryu_crypto::content_sqlite::probe_sealed_messages(db, cipher)
}

/// Refuse a data folder written by a newer Ryu. Master-key resolution already
/// runs this check before any store opens; this is the explicit entry point for
/// a boot-time check that wants to fail before resolving the key.
#[allow(dead_code)]
pub fn check_data_format() -> Result<()> {
    custody::check_data_format(&crate::paths::ryu_dir())
}

/// Record that this data folder holds phase-2 data. Content-cipher
/// construction also does this once per process before the first migration.
#[allow(dead_code)]
pub fn mark_data_format() -> Result<()> {
    custody::write_data_format(&crate::paths::ryu_dir())
}

/// The `ryu-core keys` subcommand. `args` are the words after `keys`.
///
/// * `status` — custody, the recorded key check value, every candidate's KCV
///   (never key material), the retired set, and which databases match;
/// * `adopt --from file|keychain|env|retired:<kcv> [--accept-unreadable]` —
///   make a candidate the current key after a KCV/probe check, retiring the
///   previous one (run with Core stopped). `--accept-unreadable` adopts a key
///   the probe rejects (messages it cannot open stay unreadable);
/// * `retire <kcv>` — move a non-current candidate into the retired set.
pub fn run_keys_cli(args: &[String]) -> Result<()> {
    install();
    let output = keys_command(args)?;
    print!("{output}");
    Ok(())
}

fn keys_command(args: &[String]) -> Result<String> {
    match args.first().map(String::as_str) {
        None | Some("status") => keys_status(),
        Some("adopt") => {
            let (from, accept_unreadable) = parse_adopt_args(&args[1..])?;
            let outcome = custody::adopt_master_key(&from, accept_unreadable)?;
            Ok(format!(
                "adopted key {} ({} custody){}\n",
                outcome.kcv,
                outcome.custody,
                outcome
                    .retired
                    .map(|kcv| format!("; retired {kcv}"))
                    .unwrap_or_default()
            ))
        }
        Some("retire") => {
            let Some(kcv) = args.get(1) else {
                bail!("usage: ryu-core keys retire <kcv>");
            };
            let entry = custody::retire_master_key(kcv)?;
            Ok(format!(
                "retired key {} ({} custody)\n",
                entry.kcv, entry.custody
            ))
        }
        Some(other) => bail!(
            "unknown keys command {other:?}; use `status`, `adopt --from <source>` or \
             `retire <kcv>`"
        ),
    }
}

/// `adopt` arguments: the source, and whether `--accept-unreadable` asks to
/// adopt a key the probe rejects.
fn parse_adopt_args(args: &[String]) -> Result<(AdoptFrom, bool)> {
    let accept_unreadable = args.iter().any(|arg| arg == ACCEPT_UNREADABLE);
    let rest: Vec<String> = args
        .iter()
        .filter(|arg| *arg != ACCEPT_UNREADABLE)
        .cloned()
        .collect();
    Ok((parse_adopt_from(&rest)?, accept_unreadable))
}

const ACCEPT_UNREADABLE: &str = "--accept-unreadable";

fn parse_adopt_from(args: &[String]) -> Result<AdoptFrom> {
    let value = match args {
        [flag, value] if flag == "--from" => value.as_str(),
        [single] => single
            .strip_prefix("--from=")
            .context("usage: ryu-core keys adopt --from file|keychain|env|retired:<kcv> [--accept-unreadable]")?,
        _ => bail!("usage: ryu-core keys adopt --from file|keychain|env|retired:<kcv> [--accept-unreadable]"),
    };
    Ok(match value {
        "file" => AdoptFrom::File,
        "keychain" => AdoptFrom::Keychain,
        "env" => AdoptFrom::Env,
        other => match other.strip_prefix("retired:") {
            Some(kcv) if !kcv.is_empty() => AdoptFrom::Retired(kcv.to_owned()),
            _ => bail!("unknown key source {other:?}"),
        },
    })
}

fn keys_status() -> Result<String> {
    let report = custody::master_key_report()?;
    Ok(format_status(
        &report,
        &ryu_crypto::content_sqlite::recorded_store_kcvs(&crate::paths::db_dir()),
    ))
}

/// Render `keys status` from a report and the sealed stores' recorded KCVs.
fn format_status(report: &custody::MasterKeyReport, stores: &[(String, String)]) -> String {
    let mut out = String::new();
    out.push_str(&format!("data folder: {}\n", report.data_dir.display()));
    out.push_str(&format!(
        "keychain: {}\n",
        if report.keychain_enabled {
            "enabled"
        } else {
            "disabled or unavailable in this build"
        }
    ));
    match &report.recorded {
        Some(record) => out.push_str(&format!(
            "recorded key: {} (custody {} when recorded)\n",
            record.kcv, record.custody
        )),
        None => out.push_str("recorded key: none yet\n"),
    }
    if let Some(format) = report.data_format {
        out.push_str(&format!(
            "data format: {} (min reader {})\n",
            format.format, format.min_reader
        ));
    }
    out.push_str("candidates:\n");
    if report.candidates.is_empty() {
        out.push_str("  (none)\n");
    }
    for candidate in &report.candidates {
        out.push_str(&format!(
            "  {:<12} {}{}\n",
            candidate_name(&candidate.source),
            candidate.kcv,
            if candidate.matches_recorded {
                "  <- matches the recorded key"
            } else {
                ""
            }
        ));
    }
    let in_keychain = |kcv: &str| {
        report
            .candidates
            .iter()
            .any(|candidate| candidate.source == KeySourceKind::Keychain && candidate.kcv == kcv)
    };
    for candidate in &report.candidates {
        if matches!(
            candidate.source,
            KeySourceKind::File | KeySourceKind::LegacyMemory
        ) && in_keychain(&candidate.kcv)
        {
            out.push_str(&format!(
                "note: the keychain and the {} key file hold the same key {}; while the file \
                 remains, custody is reported as file. Remove the file to rely on the keychain \
                 alone (keep a backup of the key if the keychain is not backed up).\n",
                candidate_name(&candidate.source),
                candidate.kcv
            ));
        }
    }
    out.push_str(&format!(
        "retired keys: {}/{}\n",
        report.retired.len(),
        custody::MAX_RETIRED_KEYS
    ));
    let known: Vec<&str> = report
        .candidates
        .iter()
        .map(|candidate| candidate.kcv.as_str())
        .collect();
    if !stores.is_empty() {
        out.push_str("sealed stores:\n");
        for (store, kcv) in stores {
            let state = if report.recorded.as_ref().is_some_and(|r| r.kcv == *kcv) {
                "current key"
            } else if known.contains(&kcv.as_str()) {
                "a candidate key"
            } else {
                "NO available key"
            };
            out.push_str(&format!("  {store:<28} {kcv}  ({state})\n"));
        }
    }
    out
}

fn candidate_name(source: &KeySourceKind) -> String {
    match source {
        KeySourceKind::Retired(_) => "retired".to_owned(),
        other => other.name(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversations_with(path: &Path, bodies: &[String]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT,
                                    content TEXT NOT NULL, created_at INTEGER)",
        )
        .unwrap();
        for (i, body) in bodies.iter().enumerate() {
            conn.execute(
                "INSERT INTO messages (id, content) VALUES (?1, ?2)",
                rusqlite::params![format!("m{i}"), body],
            )
            .unwrap();
        }
    }

    #[test]
    fn crypto_host_probe_tells_the_right_key_from_a_wrong_one() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conversations.db");
        assert_eq!(
            probe_conversations(&db, &FieldCipher::new(&[1; 32])),
            KeyProbe::NoSealedData
        );
        let right = FieldCipher::new(&[1; 32]);
        conversations_with(
            &db,
            &[
                "plaintext legacy body".to_owned(),
                right.seal("hello").unwrap(),
                right.seal("again").unwrap(),
            ],
        );
        assert_eq!(probe_conversations(&db, &right), KeyProbe::Passed);
        assert_eq!(
            probe_conversations(&db, &FieldCipher::new(&[2; 32])),
            KeyProbe::Failed
        );
        assert_eq!(sealed_sample(&db).len(), 2);
    }

    #[test]
    fn crypto_host_probe_reads_the_newest_sealed_messages() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conversations.db");
        let lost = FieldCipher::new(&[3; 32]);
        let current = FieldCipher::new(&[4; 32]);
        let mut bodies: Vec<String> = (0..6)
            .map(|i| lost.seal(&format!("old {i}")).unwrap())
            .collect();
        bodies.push(current.seal("newest").unwrap());
        conversations_with(&db, &bodies);
        assert_eq!(probe_conversations(&db, &current), KeyProbe::Passed);
        assert_eq!(probe_conversations(&db, &lost), KeyProbe::Passed);
        assert_eq!(
            probe_conversations(&db, &FieldCipher::new(&[5; 32])),
            KeyProbe::Failed
        );
        // Newest and oldest ends, without duplicates.
        let sample = sealed_sample(&db);
        assert_eq!(sample.len(), 6);
        assert_eq!(sample[0], bodies[6]);
    }

    #[test]
    fn crypto_host_probe_tolerates_missing_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conversations.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE other (x TEXT)")
            .unwrap();
        assert_eq!(
            probe_conversations(&db, &FieldCipher::new(&[1; 32])),
            KeyProbe::NoSealedData
        );
    }

    #[test]
    fn crypto_host_keys_cli_parses_sources() {
        let words = |s: &str| s.split(' ').map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(
            parse_adopt_from(&words("--from file")).unwrap(),
            AdoptFrom::File
        );
        assert_eq!(
            parse_adopt_from(&words("--from=keychain")).unwrap(),
            AdoptFrom::Keychain
        );
        assert_eq!(
            parse_adopt_from(&words("--from retired:abcd")).unwrap(),
            AdoptFrom::Retired("abcd".to_owned())
        );
        assert!(parse_adopt_from(&words("--from retired:")).is_err());
        assert!(parse_adopt_from(&words("--from cloud")).is_err());
        assert!(parse_adopt_from(&[]).is_err());
        assert_eq!(
            parse_adopt_args(&words("--from keychain --accept-unreadable")).unwrap(),
            (AdoptFrom::Keychain, true)
        );
        assert_eq!(
            parse_adopt_args(&words("--accept-unreadable --from=file")).unwrap(),
            (AdoptFrom::File, true)
        );
        assert_eq!(
            parse_adopt_args(&words("--from file")).unwrap(),
            (AdoptFrom::File, false)
        );
        assert!(keys_command(&words("explode")).is_err());
        assert!(keys_command(&words("retire")).is_err());
    }

    /// A host bound to an explicit data folder, so the status test never
    /// touches the process data dir.
    struct DirHost(PathBuf);

    impl CryptoHost for DirHost {
        fn keyring_account_suffix(&self) -> String {
            "-ryu-core-status-test".to_owned()
        }

        fn ryu_dir(&self) -> PathBuf {
            self.0.clone()
        }
    }

    #[test]
    fn crypto_host_status_reports_kcvs_and_never_key_material() {
        use base64::Engine as _;
        use ryu_sidecar_runtime::layout;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let key = [5u8; 32];
        let kcv = ryu_crypto::content::key_check_value(&key);
        let encoded = base64::engine::general_purpose::STANDARD.encode(key);
        let key_path = layout::secret_path(root, "master.key");
        std::fs::create_dir_all(key_path.parent().unwrap()).unwrap();
        std::fs::write(&key_path, &encoded).unwrap();
        let record = custody::KcvRecord {
            v: 1,
            kcv: kcv.clone(),
            custody: "file".to_owned(),
            written_at: 0,
        };
        let record_path = layout::state_path(root, "master-key.kcv");
        std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        std::fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();
        let db_dir = layout::db_dir(root);
        std::fs::create_dir_all(&db_dir).unwrap();
        for (name, store_kcv) in [("notes.db", kcv.as_str()), ("other.db", "00ff00ff")] {
            let conn = rusqlite::Connection::open(db_dir.join(name)).unwrap();
            ryu_crypto::content_sqlite::record_store_kcv(&conn, name, store_kcv).unwrap();
        }

        let report = custody::master_key_report_for(&DirHost(root.to_path_buf())).unwrap();
        assert_eq!(
            report.recorded.as_ref().map(|r| r.kcv.as_str()),
            Some(kcv.as_str())
        );
        let status = format_status(
            &report,
            &ryu_crypto::content_sqlite::recorded_store_kcvs(&db_dir),
        );
        assert!(status.contains(&format!("recorded key: {kcv}")), "{status}");
        assert!(
            status.lines().any(|line| line.contains("file")
                && line.contains(&kcv)
                && line.contains("matches the recorded key")),
            "{status}"
        );
        assert!(
            status
                .lines()
                .any(|line| line.contains("notes.db") && line.contains("(current key)")),
            "{status}"
        );
        assert!(
            status
                .lines()
                .any(|line| line.contains("other.db") && line.contains("(NO available key)")),
            "{status}"
        );
        assert!(!status.contains(&encoded), "key material leaked: {status}");
        assert!(!status
            .split_whitespace()
            .any(|word| word.len() == 44 && word.ends_with('=')));
    }

    #[test]
    fn crypto_host_tests_run_in_an_isolated_data_dir_and_record_no_kcv() {
        assert!(!CoreCryptoHost.records_kcv());
        let cipher = ryu_crypto::global_cipher().unwrap();
        let sealed = cipher.seal("x").unwrap();
        assert_eq!(cipher.open(&sealed).unwrap(), "x");
        if crate::paths::ryu_dir() == test_data_dir() {
            assert_eq!(
                custody::read_kcv_record(&crate::paths::ryu_dir()).unwrap(),
                None,
                "a test run never records a key check value"
            );
        } else {
            // A caller-provided RYU_DIR is honoured as-is.
            assert!(std::env::var_os("RYU_DIR").is_some());
        }
        assert_ne!(
            crate::paths::ryu_dir(),
            crate::paths::default_ryu_dir(),
            "ryu-core unit tests never use the real profile data folder"
        );
    }

    #[test]
    fn crypto_host_data_format_marker_is_written_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        custody::write_data_format(dir.path()).unwrap();
        custody::check_data_format(dir.path()).unwrap();
        let marker = custody::read_data_format(dir.path()).unwrap().unwrap();
        assert_eq!(marker.min_reader, custody::SUPPORTED_MIN_READER);
    }

    #[test]
    fn crypto_host_content_ciphers_resolve_under_the_test_host() {
        let cipher = ryu_crypto::content_cipher("crypto-host-test.db").unwrap();
        let context = ryu_crypto::ContentContext::for_id("t.c", "1");
        let sealed = cipher.seal_text("body", &context).unwrap();
        assert_eq!(cipher.open_text(&sealed, &context).unwrap().value, "body");
        let plugin = ryu_crypto::plugin_content_cipher("@ryu/notes", "notes.db").unwrap();
        let delivered = ryu_crypto::plugin_cipher_for_process("@ryu/notes")
            .unwrap()
            .content_cipher("notes.db");
        let sealed = plugin.seal_text("shared", &context).unwrap();
        assert_eq!(
            delivered.open_text(&sealed, &context).unwrap().value,
            "shared"
        );
    }
}
