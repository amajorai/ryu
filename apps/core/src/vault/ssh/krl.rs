//! SSH certificate revocation and the CA's key revocation list (KRL).
//!
//! Every signed certificate's serial is recorded against its CA. Revoking by
//! serial, or by key ID (every recorded certificate with that ID), marks
//! them; the KRL is OpenSSH's binary format (`PROTOCOL.krl`): a header and one
//! certificates section bound to the CA's public key, listing the revoked
//! serials whose certificates have not yet expired. Servers load it with
//! `RevokedKeys` in `sshd_config`, and `ssh-keygen -Q -f <krl>` checks a
//! certificate against it. The KRL is unsigned; it is served over the
//! authenticated API like the PKI CRL.

use super::*;

const KRL_MAGIC: &[u8; 8] = b"SSHKRL\n\0";
const KRL_FORMAT_VERSION: u32 = 1;
const KRL_SECTION_CERTIFICATES: u8 = 1;
const KRL_SECTION_CERT_SERIAL_LIST: u8 = 0x20;

/// A recorded SSH certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCertRecord {
    pub ca: String,
    /// The serial as a decimal string (it can exceed JSON's safe integers).
    pub serial: String,
    pub key_id: String,
    pub valid_before: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
}

/// What to revoke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshRevocation {
    Serial(u64),
    KeyId(String),
}

pub(super) fn init_krl_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_ssh_certs (
             ca           TEXT NOT NULL,
             serial       INTEGER NOT NULL,
             key_id       TEXT NOT NULL,
             valid_before INTEGER NOT NULL,
             revoked_at   INTEGER,
             created_at   INTEGER NOT NULL,
             PRIMARY KEY (ca, serial)
         );",
    )
    .context("initializing ssh certificate schema")
}

/// Record a signed certificate so it can be revoked.
pub(super) fn record_certificate(
    conn: &Connection,
    ca: &str,
    serial: u64,
    key_id: &str,
    valid_before: u64,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO vault_ssh_certs (ca, serial, key_id, valid_before, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ca, serial as i64, key_id, valid_before as i64, now_millis()],
    )?;
    Ok(())
}

/// Encode a KRL revoking `serials` of certificates signed by the CA whose
/// public key blob is `ca_key`.
pub(super) fn build_krl(
    ca_key: &[u8],
    serials: &[u64],
    krl_version: u64,
    generated_secs: u64,
    comment: &str,
) -> Vec<u8> {
    let mut out = KRL_MAGIC.to_vec();
    out.extend_from_slice(&KRL_FORMAT_VERSION.to_be_bytes());
    out.extend_from_slice(&krl_version.to_be_bytes());
    out.extend_from_slice(&generated_secs.to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes()); // flags
    put_string(&mut out, &[]); // reserved
    put_string(&mut out, comment.as_bytes());
    if !serials.is_empty() {
        let mut sorted = serials.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        let list: Vec<u8> = sorted
            .iter()
            .flat_map(|serial| serial.to_be_bytes())
            .collect();
        let mut section = Vec::new();
        put_string(&mut section, ca_key);
        put_string(&mut section, &[]); // reserved
        section.push(KRL_SECTION_CERT_SERIAL_LIST);
        put_string(&mut section, &list);
        out.push(KRL_SECTION_CERTIFICATES);
        put_string(&mut out, &section);
    }
    out
}

impl PluginSecretStore {
    /// Revoke certificates of `ca` by serial or key ID. Returns the records
    /// revoked (already revoked ones keep their first revocation time).
    pub async fn ssh_revoke(
        &self,
        ca: &str,
        what: &SshRevocation,
        actor: &AuditActor,
    ) -> Result<Vec<SshCertRecord>> {
        let conn = self.conn.lock().await;
        let known: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_ssh_cas WHERE name = ?1",
            params![ca],
            |row| row.get(0),
        )?;
        if known == 0 {
            return Err(VaultError::NotFound(format!("SSH CA `{ca}`")).into());
        }
        let now = now_millis();
        let (column, value): (&str, rusqlite::types::Value) = match what {
            SshRevocation::Serial(serial) => ("serial", (*serial as i64).into()),
            SshRevocation::KeyId(key_id) => {
                if key_id.is_empty() || key_id.len() > 256 {
                    return Err(VaultError::Invalid("invalid key id".into()).into());
                }
                ("key_id", key_id.clone().into())
            }
        };
        conn.execute(
            &format!(
                "UPDATE vault_ssh_certs SET revoked_at = COALESCE(revoked_at, ?1)
                 WHERE ca = ?2 AND {column} = ?3"
            ),
            params![now, ca, value],
        )?;
        let records = Self::ssh_cert_records(&conn, ca, Some((column, &value)))?;
        if records.is_empty() {
            return Err(VaultError::NotFound("no matching certificate".into()).into());
        }
        let serials: Vec<&str> = records
            .iter()
            .map(|record| record.serial.as_str())
            .collect();
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.revoke", "ok")
                .details(serde_json::json!({ "ca": ca, "serials": serials })),
        );
        Ok(records)
    }

    /// Certificates `ca` signed, newest first (bounded).
    pub async fn ssh_list_certs(&self, ca: &str) -> Result<Vec<SshCertRecord>> {
        let conn = self.conn.lock().await;
        Self::ssh_cert_records(&conn, ca, None)
    }

    fn ssh_cert_records(
        conn: &Connection,
        ca: &str,
        filter: Option<(&str, &rusqlite::types::Value)>,
    ) -> Result<Vec<SshCertRecord>> {
        let clause = filter.map_or(String::new(), |(column, _)| format!(" AND {column} = ?2"));
        let mut stmt = conn.prepare(&format!(
            "SELECT ca, serial, key_id, valid_before, revoked_at FROM vault_ssh_certs
             WHERE ca = ?1{clause} ORDER BY created_at DESC LIMIT 500"
        ))?;
        let record = |row: &rusqlite::Row<'_>| {
            Ok(SshCertRecord {
                ca: row.get(0)?,
                serial: (row.get::<_, i64>(1)? as u64).to_string(),
                key_id: row.get(2)?,
                valid_before: row.get(3)?,
                revoked_at: row.get(4)?,
            })
        };
        let rows = match filter {
            Some((_, value)) => stmt.query_map(params![ca, value], record)?,
            None => stmt.query_map(params![ca], record)?,
        };
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The CA's current KRL: revoked serials of unexpired certificates.
    pub async fn ssh_krl(&self, ca: &str) -> Result<Vec<u8>> {
        let conn = self.conn.lock().await;
        let public: String = conn
            .query_row(
                "SELECT public_key FROM vault_ssh_cas WHERE name = ?1",
                params![ca],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("SSH CA `{ca}`")))?;
        let (_, ca_key) = parse_public_key(&public)?;
        let now_secs = now_millis() / 1000;
        let mut stmt = conn.prepare(
            "SELECT serial, revoked_at FROM vault_ssh_certs
             WHERE ca = ?1 AND revoked_at IS NOT NULL AND valid_before > ?2",
        )?;
        let rows = stmt
            .query_map(params![ca, now_secs], |row| {
                Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let version = rows.iter().map(|(_, at)| *at).max().unwrap_or(0).max(0) as u64;
        let serials: Vec<u64> = rows.into_iter().map(|(serial, _)| serial).collect();
        Ok(build_krl(
            &ca_key,
            &serials,
            version,
            now_secs.max(0) as u64,
            &format!("ryu-ssh-ca-{ca}"),
        ))
    }
}
