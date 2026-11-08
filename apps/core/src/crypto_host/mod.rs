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
//! `adopt --from <source>`, `retire <kcv>`, and `rotate` / `rewrap-vault` from
//! [`rotate`]) and the data-format marker checks.

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
/// * `retire <kcv>` — move a non-current candidate into the retired set;
/// * `rotate` — replace the master key with a fresh one, retire the old one,
///   and rewrap the vault data keys under the new key (Core stopped);
/// * `rewrap-vault` — rewrap the vault data keys under the current master key
///   (finishes an interrupted `rotate`).
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
        Some("rotate") => rotate::rotate_command(&args[1..]),
        Some("rewrap-vault") => rotate::rewrap_vault_command(&args[1..]),
        Some(other) => bail!(
            "unknown keys command {other:?}; use `status`, `adopt --from <source>`, \
             `retire <kcv>`, `rotate` or `rewrap-vault`"
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

mod rotate;

#[cfg(test)]
mod tests;
