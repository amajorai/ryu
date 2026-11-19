//! Transit key metadata: rows, version windows, option checks, and key info.

use super::*;

pub(super) struct Meta {
    pub(super) key_type: TransitKeyType,
    pub(super) latest: u32,
    pub(super) min_decrypt: u32,
    pub(super) min_encrypt: u32,
    pub(super) min_available: u32,
    pub(super) deletion_allowed: bool,
    pub(super) derived: bool,
    pub(super) convergent: bool,
    pub(super) exportable: bool,
    pub(super) allow_plaintext_backup: bool,
    pub(super) auto_rotate_period_secs: i64,
    pub(super) imported: bool,
    pub(super) created_at: i64,
    pub(super) deleted_at: Option<i64>,
}

impl Meta {
    /// Lowest version that may decrypt or verify.
    pub(super) fn decrypt_floor(&self) -> u32 {
        self.min_decrypt.max(self.min_available)
    }

    /// The version to encrypt, sign, or HMAC with.
    pub(super) fn select_version(&self, requested: Option<u32>) -> Result<u32> {
        // Never encrypt below the decryption floor: that output could not be
        // decrypted, verified, or HMAC-verified.
        let floor = self.min_encrypt.max(self.decrypt_floor()).max(1);
        match requested {
            None | Some(0) => Ok(self.latest),
            Some(version) if (floor..=self.latest).contains(&version) => Ok(version),
            Some(version) => Err(denied(format!(
                "key version {version} is outside the usable range {floor}..={}",
                self.latest
            ))),
        }
    }

    pub(super) fn check_decryptable(&self, version: u32) -> Result<()> {
        if version < self.decrypt_floor() || version > self.latest {
            return Err(denied(format!(
                "key version {version} is outside the decryptable range"
            )));
        }
        Ok(())
    }
}

pub(super) const META_COLUMNS: &str = "key_type, latest_version, min_decryption_version,
     min_encryption_version, min_available_version, deletion_allowed, derived, convergent,
     exportable, allow_plaintext_backup, auto_rotate_period_secs, imported, created_at, deleted_at";

pub(super) fn read_meta(conn: &Connection, name: &str) -> Result<Option<Meta>> {
    let row = conn
        .query_row(
            &format!("SELECT {META_COLUMNS} FROM vault_transit_meta WHERE name = ?1"),
            params![name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    [
                        row.get::<_, u32>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                    ],
                    [
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(11)?,
                    ],
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                ))
            },
        )
        .optional()?;
    let Some((key_type, versions, flags, auto_rotate, created_at, deleted_at)) = row else {
        return Ok(None);
    };
    Ok(Some(Meta {
        key_type: TransitKeyType::parse(&key_type).ok_or_else(|| anyhow!("unknown key type"))?,
        latest: versions[0],
        min_decrypt: versions[1],
        min_encrypt: versions[2],
        min_available: versions[3].max(1),
        deletion_allowed: flags[0] != 0,
        derived: flags[1] != 0,
        convergent: flags[2] != 0,
        exportable: flags[3] != 0,
        allow_plaintext_backup: flags[4] != 0,
        imported: flags[5] != 0,
        auto_rotate_period_secs: auto_rotate,
        created_at,
        deleted_at,
    }))
}

/// A live (not soft-deleted) key's metadata.
pub(super) fn meta(conn: &Connection, name: &str) -> Result<Meta> {
    match read_meta(conn, name)? {
        Some(meta) if meta.deleted_at.is_none() => Ok(meta),
        _ => Err(VaultError::NotFound(format!("transit key `{name}`")).into()),
    }
}

pub(super) fn validate_key_options(
    key_type: TransitKeyType,
    options: &TransitKeyOptions,
) -> Result<()> {
    if (options.derived || options.convergent) && !key_type.is_symmetric() {
        return Err(invalid(
            "derived and convergent keys must be aes256-gcm96, aes128-gcm96, or chacha20-poly1305",
        ));
    }
    if options.convergent && !options.derived {
        return Err(invalid("convergent encryption requires a derived key"));
    }
    validate_auto_rotate(options.auto_rotate_period_secs)
}

pub(super) fn validate_auto_rotate(period: i64) -> Result<()> {
    if period != 0 && period < MIN_AUTO_ROTATE_SECS {
        return Err(invalid(format!(
            "autoRotatePeriodSecs must be 0 (off) or at least {MIN_AUTO_ROTATE_SECS}"
        )));
    }
    Ok(())
}

// ── Key material ──────────────────────────────────────────────────────────

pub(super) fn purge_locked(conn: &Connection, name: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_transit_keys WHERE name = ?1",
        params![name],
    )?;
    conn.execute(
        "DELETE FROM vault_transit_meta WHERE name = ?1",
        params![name],
    )?;
    Ok(())
}

pub(super) fn transit_public_key_opt(
    conn: &Connection,
    name: &str,
    version: u32,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT public_key FROM vault_transit_keys WHERE name = ?1 AND version = ?2",
            params![name, version],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

pub(super) fn transit_public_key(conn: &Connection, name: &str, version: u32) -> Result<String> {
    transit_public_key_opt(conn, name, version)?.ok_or_else(|| {
        VaultError::NotFound(format!("public key for `{name}` version {version}")).into()
    })
}

pub(super) fn transit_info_locked(conn: &Connection, name: &str) -> Result<TransitKeyInfo> {
    let meta = read_meta(conn, name)?
        .ok_or_else(|| VaultError::NotFound(format!("transit key `{name}`")))?;
    let mut stmt = conn.prepare(
        "SELECT version, public_key FROM vault_transit_keys
         WHERE name = ?1 AND public_key IS NOT NULL ORDER BY version",
    )?;
    let public_keys = stmt
        .query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(u32, String)>>>()?;
    Ok(TransitKeyInfo {
        name: name.to_owned(),
        key_type: meta.key_type,
        latest_version: meta.latest,
        min_decryption_version: meta.min_decrypt,
        min_encryption_version: meta.min_encrypt,
        min_available_version: meta.min_available,
        deletion_allowed: meta.deletion_allowed,
        derived: meta.derived,
        convergent: meta.convergent,
        exportable: meta.exportable,
        allow_plaintext_backup: meta.allow_plaintext_backup,
        auto_rotate_period_secs: meta.auto_rotate_period_secs,
        imported: meta.imported,
        created_at: meta.created_at,
        deleted_at: meta.deleted_at,
        public_keys,
    })
}
