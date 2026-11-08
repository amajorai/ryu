//! `ryu-core keys rotate` and `ryu-core keys rewrap-vault`.
//!
//! `rotate` replaces the master key (the vault's key-encryption key in `auto`
//! seal mode) with a fresh random key, in this order, so a failure at any step
//! leaves every store readable:
//!
//! 1. resolve the current master key and refuse when `RYU_MASTER_KEY` supplies
//!    it (an env key is never written to disk, so it cannot be replaced here)
//!    or when the retired-key set is full;
//! 2. move every vault row onto the active data key under the current master
//!    key (legacy rows sealed with the master key itself included);
//! 3. install the new key as current and retire the old one, so everything
//!    else sealed under it stays readable and is resealed lazily;
//! 4. rewrap the vault data keys and the vault audit key under the new key.
//!
//! If step 4 fails, the vault still opens through the retired key, and
//! `keys rewrap-vault` finishes the job. Run both with Core stopped.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use ryu_crypto::custody::{self, AdoptOutcome};
use ryu_crypto::FieldCipher;

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::keyring::{rewrap_wrapping, KekRewrap};

const ENV_MASTER_KEY: &str = "RYU_MASTER_KEY";

fn vault_db() -> std::path::PathBuf {
    crate::paths::secret_path("plugin-secrets.db")
}

fn current_thread_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("starting a runtime for the vault rewrap")
}

/// `keys rotate`.
pub(super) fn rotate_command(args: &[String]) -> Result<String> {
    if !args.is_empty() {
        bail!("usage: ryu-core keys rotate (with Core stopped)");
    }
    if std::env::var(ENV_MASTER_KEY).is_ok_and(|value| !value.trim().is_empty()) {
        bail!(
            "{ENV_MASTER_KEY} supplies the master key, so `keys rotate` cannot replace it; \
             rotate it where it is kept and use `keys adopt --from env`"
        );
    }
    let report = custody::master_key_report()?;
    if report.retired.len() >= custody::MAX_RETIRED_KEYS {
        bail!(
            "the retired-key set is full ({} keys); rotating would leave no room for the \
             current key",
            custody::MAX_RETIRED_KEYS
        );
    }
    let outcome = rotate_with(&vault_db(), install_new_master)?;
    Ok(format!(
        "rotated the master key to {} ({} custody){}\n{}",
        outcome.adopted.kcv,
        outcome.adopted.custody,
        outcome
            .adopted
            .retired
            .as_deref()
            .map(|kcv| format!("; retired {kcv}"))
            .unwrap_or_default(),
        describe(outcome.prepared_rows, outcome.rewrap)
    ))
}

/// `keys rewrap-vault`: rewrap the vault data keys and audit key under the
/// current master key (finishing an interrupted `keys rotate`).
pub(super) fn rewrap_vault_command(args: &[String]) -> Result<String> {
    if !args.is_empty() {
        bail!("usage: ryu-core keys rewrap-vault (with Core stopped)");
    }
    let db = vault_db();
    if !db.exists() {
        return Ok("no vault on this data folder\n".to_owned());
    }
    let rewrap = rewrap_vault_at(&db, &ryu_crypto::global_cipher()?)?;
    Ok(describe(None, Some(rewrap)))
}

/// Rewrap the vault at `db` under `master`'s current key. `master` opens the
/// existing wrapping through its retired keys when a rotation was interrupted.
pub(super) fn rewrap_vault_at(db: &Path, master: &FieldCipher) -> Result<KekRewrap> {
    let conn =
        rusqlite::Connection::open(db).with_context(|| format!("opening {}", db.display()))?;
    rewrap_wrapping(&conn, master, master)
}

fn describe(prepared_rows: Option<usize>, rewrap: Option<KekRewrap>) -> String {
    let Some(rewrap) = rewrap else {
        return "no vault on this data folder\n".to_owned();
    };
    let mut out = String::new();
    if let Some(rows) = prepared_rows {
        out.push_str(&format!(
            "vault rows moved onto the active data key: {rows}\n"
        ));
    }
    if rewrap.shamir {
        out.push_str(
            "vault data keys: wrapped by the key-share root key (rekey the shares to rotate it)\n",
        );
    } else {
        out.push_str(&format!(
            "vault data keys rewrapped: {}\n",
            rewrap.data_keys
        ));
    }
    out.push_str(&format!(
        "vault metadata rewrapped: {}\n",
        rewrap.meta_entries
    ));
    out
}

/// Install `key` as the current master key, retiring the previous one.
fn install_new_master(key: &[u8; 32]) -> Result<AdoptOutcome> {
    let carrier = FieldCipher::new(&random_key());
    let sealed = custody::seal_raw_key_bundle(&carrier, key, &[])?;
    custody::import_key_bundle(&carrier, &sealed)
}

fn random_key() -> [u8; 32] {
    let bytes = crate::vault::random_bytes(32);
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    key
}

/// What [`rotate_with`] did.
pub(super) struct RotateOutcome {
    pub adopted: AdoptOutcome,
    pub prepared_rows: Option<usize>,
    pub rewrap: Option<KekRewrap>,
}

/// Steps 2-4 against the vault at `db`, with `install` storing the new key.
pub(super) fn rotate_with(
    db: &Path,
    install: impl FnOnce(&[u8; 32]) -> Result<AdoptOutcome>,
) -> Result<RotateOutcome> {
    let old = ryu_crypto::global_cipher()?;
    let store = if db.exists() {
        Some(PluginSecretStore::open(db.to_path_buf())?)
    } else {
        None
    };
    let runtime = current_thread_runtime()?;
    let actor = AuditActor::system();
    let prepared_rows = match &store {
        // A sealed (key-share) vault already keeps every row on a data key.
        Some(store) if !store.keyring.is_sealed() => {
            Some(runtime.block_on(store.rewrap_all(&actor))?)
        }
        _ => None,
    };
    let new_key = random_key();
    let adopted = install(&new_key)?;
    let Some(store) = store else {
        return Ok(RotateOutcome {
            adopted,
            prepared_rows,
            rewrap: None,
        });
    };
    let rewrap = runtime.block_on(async {
        let conn = store.conn.lock().await;
        let rewrap =
            rewrap_wrapping(&conn, &old, &FieldCipher::new(&new_key)).map_err(|error| {
                anyhow!(
                    "the new master key {} is installed and the vault still opens through the \
                 retired key, but rewrapping the vault failed ({error:#}); run \
                 `ryu-core keys rewrap-vault`",
                    adopted.kcv
                )
            })?;
        store.audit_locked(
            &conn,
            &AuditEntry::new(&actor, "sys.kek.rotate", "ok").details(serde_json::json!({
                "kcv": adopted.kcv,
                "retiredKcv": adopted.retired,
                "dataKeys": rewrap.data_keys,
            })),
        );
        store.flush_audit(&conn);
        Ok::<_, anyhow::Error>(rewrap)
    })?;
    Ok(RotateOutcome {
        adopted,
        prepared_rows,
        rewrap: Some(rewrap),
    })
}

#[cfg(test)]
#[path = "rotate_test.rs"]
mod tests;
