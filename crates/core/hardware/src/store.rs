//! Device registry (SQLite) — paired Ryu hardware, their tokens, pending v2
//! pairings, consumed pairing nonces, and the sealed node identity.
//!
//! Persists the device records backing the REST surface in PROTOCOL.md §6 and
//! the Bearer-token auth on the WS upgrade (§2). This is the system of record for
//! "which devices are paired to this node", extending the connections/presence
//! model with durable, per-device, revocable tokens.
//!
//! Placement (Core vs Gateway): the device registry + token lifecycle decide
//! *which device is allowed to drive this node and what it runs*, so this is
//! Core. One `rusqlite` connection sits behind an `Arc<Mutex<…>>`, opened at a path
//! the host computes.
//!
//! The **raw** tokens are shown to the app exactly once (at pairing); only their
//! SHA-256 hashes are persisted here. A device authenticates the WS upgrade by
//! presenting a raw token, which is re-hashed and compared in constant time.
//!
//! ## RHP v1.1 (design §7)
//!
//! - Migrations are idempotent: `CREATE TABLE IF NOT EXISTS` plus
//!   `ALTER TABLE devices ADD COLUMN` for each column `PRAGMA table_info` shows
//!   missing. A v1 binary ignores the new columns and tables.
//! - `protocol_level = 2` is a ratchet: [`DeviceStore::insert`] is a plain INSERT,
//!   so nothing overwrites a paired row; only [`DeviceStore::revoke`] clears it.
//! - The node identity is created lazily, sealed with the host's
//!   [`NodeKeySealer`], and never regenerated silently: an unopenable key is
//!   reported unavailable until [`DeviceStore::reset_node_identity`].

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

use super::protocol::DeviceType;
use crate::identity::{IdentityError, NodeIdentity, NodeIdentityStatus, NodeKeySealer};

/// Pending v2 pairings expire after this long (design §5.4).
pub const PENDING_PAIRING_TTL_MS: i64 = 180_000;
/// At most this many pending v2 pairings exist per node.
pub const MAX_PENDING_PAIRINGS: usize = 4;
/// The protocol level of a legacy (v1) pairing.
pub const PROTOCOL_LEVEL_LEGACY: u8 = 1;
/// The protocol level of a v1.1 pairing with a pinned device key.
pub const PROTOCOL_LEVEL_SECURE: u8 = 2;

/// A paired device row. Token hashes are stored, never the raw tokens.
#[derive(Clone, Debug)]
pub struct DeviceRecord {
    pub device_id: String,
    pub device_type: DeviceType,
    pub name: String,
    /// Lowercase hex SHA-256 of the device Bearer token (raw token shown once).
    pub token_hash: String,
    /// Epoch ms of last WS activity, or `None` if never connected.
    pub last_seen: Option<i64>,
    /// Latest reported battery percent, or `None`.
    pub battery_pct: Option<i32>,
    /// Free-form per-device prefs (JSON), e.g. wake word, ambient on/off.
    pub prefs: serde_json::Value,
    /// The long-running ambient meeting this device resumes on reconnect, so a
    /// reconnecting ambient device feeds the SAME meeting rather than spawning a
    /// fresh one each `hello` (PROTOCOL.md §4.2). `None` until first opened.
    pub ambient_meeting_id: Option<String>,
    pub created_at: i64,
    /// The pinned device static key (base64url), level 2 only.
    pub noise_pubkey: Option<String>,
    /// 1 = legacy v1 pairing, 2 = v1.1 pairing v2.
    pub protocol_level: u8,
    /// `sas` (the user compared the code) or `unverified` (level 2 only).
    pub key_verification: Option<String>,
    /// `qr` or `ble` (level 2 only).
    pub key_source: Option<String>,
    /// Lowercase hex SHA-256 of the WS-only relay token (level 2 only).
    pub relay_token_hash: Option<String>,
    /// Epoch ms of the v2 pairing.
    pub paired_at: Option<i64>,
    /// The node identity was reset after this device pinned it.
    pub needs_repair: bool,
}

impl DeviceRecord {
    /// A legacy (protocol level 1) record, as `POST /api/hardware/pair` creates.
    pub fn new_legacy(
        device_id: impl Into<String>,
        device_type: DeviceType,
        name: impl Into<String>,
        token_hash: impl Into<String>,
        created_at: i64,
    ) -> Self {
        Self {
            device_id: device_id.into(),
            device_type,
            name: name.into(),
            token_hash: token_hash.into(),
            last_seen: None,
            battery_pct: None,
            prefs: serde_json::json!({}),
            ambient_meeting_id: None,
            created_at,
            noise_pubkey: None,
            protocol_level: PROTOCOL_LEVEL_LEGACY,
            key_verification: None,
            key_source: None,
            relay_token_hash: None,
            paired_at: None,
            needs_repair: false,
        }
    }

    /// Whether this row requires the secure session (level 2 with a pinned key).
    pub fn is_secure(&self) -> bool {
        self.protocol_level >= PROTOCOL_LEVEL_SECURE && self.noise_pubkey.is_some()
    }
}

/// Which token a Bearer matched in [`DeviceStore::authenticate_bearer`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    /// The device's own token (`rht_`).
    Device,
    /// The WS-only phone relay token (`rhr_`).
    Relay,
}

/// The state of a pending v2 pairing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingState {
    /// `/pair/begin` done; waiting for `/pair/reveal`.
    Begun,
    /// `/pair/reveal` done (commit verified, `T_hash` stored); waiting for confirm.
    Revealed,
}

impl PendingState {
    fn as_str(self) -> &'static str {
        match self {
            PendingState::Begun => "begun",
            PendingState::Revealed => "revealed",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "revealed" {
            PendingState::Revealed
        } else {
            PendingState::Begun
        }
    }
}

/// A pending v2 pairing row (design §7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPairing {
    /// base64url of the 16-byte node-chosen id.
    pub pairing_id: String,
    pub device_id: String,
    pub device_type: DeviceType,
    pub pairing_nonce: String,
    /// base64url of the device static key.
    pub device_pub: String,
    /// base64url of the device commitment.
    pub device_commit: String,
    pub key_source: String,
    pub node_url: String,
    /// base64url, set by reveal.
    pub device_rand: Option<String>,
    /// base64url of `SHA256(T)`, set by reveal.
    pub transcript_hash: Option<String>,
    pub state: PendingState,
    pub created_at: i64,
    pub expires_at: i64,
}

/// Outcome of [`DeviceStore::insert_pending_pairing`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingInsert {
    Inserted,
    /// The node already holds [`MAX_PENDING_PAIRINGS`] live pending pairings.
    TooManyPending,
}

/// Outcome of [`DeviceStore::insert_paired_v2`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairedInsert {
    Inserted,
    /// The pending pairing is gone (expired, cancelled, or already confirmed).
    PendingGone,
    /// A device with this id is already paired.
    AlreadyPaired,
    /// This `(device_id, nonce)` was already consumed.
    NonceConsumed,
    /// Another device already pins this static key.
    KeyBound,
}

/// Hash a raw Bearer token to the form stored in the registry. The token is a
/// 256-bit random secret (see [`super::pairing::generate_device_token`]); a plain
/// SHA-256 is sufficient for a high-entropy secret (no need for a slow KDF, which
/// only matters for low-entropy passwords).
pub fn hash_token(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(raw.as_bytes());
    hex::encode(digest)
}

/// Constant-time equality of two stored hashes.
pub(crate) fn ct_eq_str(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The columns v1.1 adds to `devices`, with their `ADD COLUMN` definitions.
const V1_1_DEVICE_COLUMNS: [(&str, &str); 7] = [
    ("noise_pubkey", "TEXT"),
    ("protocol_level", "INTEGER NOT NULL DEFAULT 1"),
    ("key_verification", "TEXT"),
    ("key_source", "TEXT"),
    ("relay_token_hash", "TEXT"),
    ("paired_at", "INTEGER"),
    ("needs_repair", "INTEGER NOT NULL DEFAULT 0"),
];

const DEVICE_COLUMNS: &str =
    "device_id, device_type, name, token_hash, last_seen, battery_pct, prefs, \
     ambient_meeting_id, created_at, noise_pubkey, protocol_level, key_verification, key_source, \
     relay_token_hash, paired_at, needs_repair";

const PENDING_COLUMNS: &str = "pairing_id, device_id, device_type, pairing_nonce, device_pub, \
     device_commit, key_source, node_url, device_rand, transcript_hash, state, created_at, expires_at";

/// Handle to the device registry. Cheaply cloneable (wraps `Arc`s); clones share
/// the connection, the installed key sealer, and the cached node identity.
#[derive(Clone)]
pub struct DeviceStore {
    conn: Arc<Mutex<Connection>>,
    sealer: Arc<RwLock<Option<Arc<dyn NodeKeySealer>>>>,
    identity: Arc<RwLock<Option<NodeIdentity>>>,
}

impl DeviceStore {
    /// Open (or create) the store at a specific path and run migrations. The host
    /// computes the path (`~/.ryu/hardware.db`); this crate never reaches Core's
    /// `paths` module, so it has zero dependency on `apps/core`.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening hardware db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            sealer: Arc::new(RwLock::new(None)),
            identity: Arc::new(RwLock::new(None)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS devices (
                 device_id          TEXT PRIMARY KEY,
                 device_type        TEXT NOT NULL,
                 name               TEXT NOT NULL,
                 token_hash         TEXT NOT NULL,
                 last_seen          INTEGER,
                 battery_pct        INTEGER,
                 prefs              TEXT NOT NULL DEFAULT '{}',
                 ambient_meeting_id TEXT,
                 created_at         INTEGER NOT NULL
             );",
        )
        .context("initializing hardware schema")?;
        Self::migrate_v1_1(conn).context("migrating hardware schema to RHP v1.1")?;
        Ok(())
    }

    /// Idempotent v1 → v1.1 migration (design §7).
    fn migrate_v1_1(conn: &Connection) -> Result<()> {
        let existing: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(devices)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.collect::<rusqlite::Result<_>>()?
        };
        for (column, definition) in V1_1_DEVICE_COLUMNS {
            if !existing.iter().any(|c| c == column) {
                conn.execute_batch(&format!(
                    "ALTER TABLE devices ADD COLUMN {column} {definition};"
                ))?;
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
             CREATE INDEX IF NOT EXISTS idx_devices_relay_token_hash ON devices(relay_token_hash);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_noise_pubkey
                 ON devices(noise_pubkey) WHERE noise_pubkey IS NOT NULL;
             CREATE TABLE IF NOT EXISTS pending_pairings (
                 pairing_id      TEXT PRIMARY KEY,
                 device_id       TEXT NOT NULL,
                 device_type     TEXT NOT NULL,
                 pairing_nonce   TEXT NOT NULL,
                 device_pub      TEXT NOT NULL,
                 device_commit   TEXT NOT NULL,
                 key_source      TEXT NOT NULL,
                 node_url        TEXT NOT NULL,
                 device_rand     TEXT,
                 transcript_hash TEXT,
                 state           TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 expires_at      INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_pairings_device
                 ON pending_pairings(device_id);
             CREATE TABLE IF NOT EXISTS consumed_pair_nonces (
                 device_id   TEXT NOT NULL,
                 nonce       TEXT NOT NULL,
                 consumed_at INTEGER NOT NULL,
                 PRIMARY KEY (device_id, nonce)
             );
             CREATE TABLE IF NOT EXISTS node_identity (
                 id            INTEGER PRIMARY KEY CHECK (id = 1),
                 public_key    TEXT NOT NULL,
                 sealed_secret TEXT NOT NULL,
                 created_at    INTEGER NOT NULL
             );",
        )?;
        Ok(())
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRecord> {
        let device_type_str: String = row.get(1)?;
        let prefs_str: String = row.get(6)?;
        let level: i64 = row.get(10)?;
        let needs_repair: i64 = row.get(15)?;
        Ok(DeviceRecord {
            device_id: row.get(0)?,
            device_type: super::protocol::parse_device_type(&device_type_str)
                .unwrap_or(DeviceType::Necklace),
            name: row.get(2)?,
            token_hash: row.get(3)?,
            last_seen: row.get(4)?,
            battery_pct: row.get(5)?,
            prefs: serde_json::from_str(&prefs_str).unwrap_or(serde_json::Value::Null),
            ambient_meeting_id: row.get(7)?,
            created_at: row.get(8)?,
            noise_pubkey: row.get(9)?,
            protocol_level: u8::try_from(level).unwrap_or(PROTOCOL_LEVEL_SECURE),
            key_verification: row.get(11)?,
            key_source: row.get(12)?,
            relay_token_hash: row.get(13)?,
            paired_at: row.get(14)?,
            needs_repair: needs_repair != 0,
        })
    }

    fn insert_record(conn: &Connection, record: &DeviceRecord) -> Result<()> {
        let device_type = super::protocol::device_type_str(record.device_type);
        let prefs = serde_json::to_string(&record.prefs).unwrap_or_else(|_| "{}".to_string());
        conn.execute(
            &format!(
                "INSERT INTO devices ({DEVICE_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
            ),
            params![
                record.device_id,
                device_type,
                record.name,
                record.token_hash,
                record.last_seen,
                record.battery_pct,
                prefs,
                record.ambient_meeting_id,
                record.created_at,
                record.noise_pubkey,
                i64::from(record.protocol_level),
                record.key_verification,
                record.key_source,
                record.relay_token_hash,
                record.paired_at,
                i64::from(record.needs_repair),
            ],
        )
        .context("inserting device")?;
        Ok(())
    }

    /// Insert a freshly paired device. This is a plain INSERT: it fails when the
    /// id (or the pinned key) is already present, so a paired row — in particular a
    /// level-2 row — is never overwritten. Re-pairing requires a revoke first.
    pub async fn insert(&self, record: DeviceRecord) -> Result<DeviceRecord> {
        let conn = self.conn.lock().await;
        Self::insert_record(&conn, &record)?;
        Ok(record)
    }

    /// Look up a device by id.
    pub async fn get(&self, device_id: &str) -> Result<Option<DeviceRecord>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            &format!("SELECT {DEVICE_COLUMNS} FROM devices WHERE device_id = ?1"),
            params![device_id],
            Self::row_to_record,
        )
        .optional()
        .context("reading device")
    }

    /// List all paired devices, newest first (drives `GET /api/hardware/devices`).
    pub async fn list(&self) -> Result<Vec<DeviceRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {DEVICE_COLUMNS} FROM devices ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map([], Self::row_to_record)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Verify a raw **device** Bearer token against a device's stored hash, in
    /// constant time. Relay tokens never verify here, so the display routes reject
    /// them. Returns `true` only when the device exists and the hash matches.
    pub async fn verify_token(&self, device_id: &str, token: &str) -> Result<bool> {
        let Some(record) = self.get(device_id).await? else {
            return Ok(false);
        };
        Ok(ct_eq_str(&record.token_hash, &hash_token(token)))
    }

    /// Resolve a WS upgrade Bearer to its device row and token kind, before any DH
    /// (design §4.4 step 2). The token is hashed, the row found by the indexed
    /// `token_hash` / `relay_token_hash`, and the match re-checked in constant time.
    pub async fn authenticate_bearer(
        &self,
        token: &str,
    ) -> Result<Option<(DeviceRecord, TokenKind)>> {
        if token.is_empty() {
            return Ok(None);
        }
        let hashed = hash_token(token);
        let candidates = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(&format!(
                "SELECT {DEVICE_COLUMNS} FROM devices WHERE token_hash = ?1 OR relay_token_hash = ?1"
            ))?;
            let rows = stmt.query_map(params![hashed], Self::row_to_record)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for record in candidates {
            if ct_eq_str(&record.token_hash, &hashed) {
                return Ok(Some((record, TokenKind::Device)));
            }
            if record
                .relay_token_hash
                .as_deref()
                .is_some_and(|relay| ct_eq_str(relay, &hashed))
            {
                return Ok(Some((record, TokenKind::Relay)));
            }
        }
        Ok(None)
    }

    /// Update mutable fields (name/prefs) for `PATCH`. A `None` leaves the field
    /// unchanged. Returns `true` when a row was touched.
    pub async fn update(
        &self,
        device_id: &str,
        name: Option<String>,
        prefs: Option<serde_json::Value>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let mut changed = 0usize;
        if let Some(name) = name {
            changed += conn.execute(
                "UPDATE devices SET name = ?2 WHERE device_id = ?1",
                params![device_id, name],
            )?;
        }
        if let Some(prefs) = prefs {
            let json = serde_json::to_string(&prefs).unwrap_or_else(|_| "{}".to_string());
            changed += conn.execute(
                "UPDATE devices SET prefs = ?2 WHERE device_id = ?1",
                params![device_id, json],
            )?;
        }
        Ok(changed > 0)
    }

    /// Mark a device seen now and record latest battery (from telemetry). A
    /// `None` battery leaves the stored value unchanged.
    pub async fn touch(&self, device_id: &str, battery_pct: Option<i32>) -> Result<()> {
        let conn = self.conn.lock().await;
        match battery_pct {
            Some(pct) => conn.execute(
                "UPDATE devices SET last_seen = ?2, battery_pct = ?3 WHERE device_id = ?1",
                params![device_id, now_ms(), pct],
            )?,
            None => conn.execute(
                "UPDATE devices SET last_seen = ?2 WHERE device_id = ?1",
                params![device_id, now_ms()],
            )?,
        };
        Ok(())
    }

    /// Persist the long-running ambient meeting id for a device so a reconnect
    /// resumes the same meeting (PROTOCOL.md §4.2).
    pub async fn set_ambient_meeting(&self, device_id: &str, meeting_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE devices SET ambient_meeting_id = ?2 WHERE device_id = ?1",
            params![device_id, meeting_id],
        )?;
        Ok(())
    }

    /// Revoke a device (deletes it / its tokens / its pinned key, which clears the
    /// level-2 ratchet) for `DELETE`, together with that device's pending
    /// pairings. Returns `true` when a device row was removed.
    pub async fn revoke(&self, device_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM devices WHERE device_id = ?1",
            params![device_id],
        )?;
        tx.execute(
            "DELETE FROM pending_pairings WHERE device_id = ?1",
            params![device_id],
        )?;
        tx.commit()?;
        Ok(n > 0)
    }

    // ── Pairing nonces ────────────────────────────────────────────────────────

    /// Burn a `(device_id, nonce)` pair. Returns `true` when it was fresh and is
    /// now consumed, `false` when it had already been consumed (a replay).
    pub async fn consume_nonce(&self, device_id: &str, nonce: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "INSERT OR IGNORE INTO consumed_pair_nonces (device_id, nonce, consumed_at)
             VALUES (?1, ?2, ?3)",
            params![device_id, nonce, now_ms()],
        )?;
        Ok(n > 0)
    }

    /// Whether a `(device_id, nonce)` pair has been consumed.
    pub async fn nonce_consumed(&self, device_id: &str, nonce: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM consumed_pair_nonces WHERE device_id = ?1 AND nonce = ?2",
                params![device_id, nonce],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Whether some paired device already pins this static key (base64url).
    pub async fn noise_key_bound(&self, noise_pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM devices WHERE noise_pubkey = ?1",
                params![noise_pubkey],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    // ── Pending v2 pairings ───────────────────────────────────────────────────

    fn row_to_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingPairing> {
        let device_type: String = row.get(2)?;
        let state: String = row.get(10)?;
        Ok(PendingPairing {
            pairing_id: row.get(0)?,
            device_id: row.get(1)?,
            device_type: super::protocol::parse_device_type(&device_type)
                .unwrap_or(DeviceType::Necklace),
            pairing_nonce: row.get(3)?,
            device_pub: row.get(4)?,
            device_commit: row.get(5)?,
            key_source: row.get(6)?,
            node_url: row.get(7)?,
            device_rand: row.get(8)?,
            transcript_hash: row.get(9)?,
            state: PendingState::parse(&state),
            created_at: row.get(11)?,
            expires_at: row.get(12)?,
        })
    }

    /// Persist a pending pairing. Expired rows are purged first, a pending pairing
    /// for the same device_id is replaced (a newer begin wins), and at most
    /// [`MAX_PENDING_PAIRINGS`] may exist.
    pub async fn insert_pending_pairing(
        &self,
        pending: &PendingPairing,
        now_ms: i64,
    ) -> Result<PendingInsert> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM pending_pairings WHERE expires_at <= ?1 OR device_id = ?2",
            params![now_ms, pending.device_id],
        )?;
        let live: i64 = tx.query_row("SELECT COUNT(*) FROM pending_pairings", [], |row| {
            row.get(0)
        })?;
        if usize::try_from(live).unwrap_or(usize::MAX) >= MAX_PENDING_PAIRINGS {
            // Dropping the transaction rolls back the purge too; that is harmless.
            return Ok(PendingInsert::TooManyPending);
        }
        tx.execute(
            &format!(
                "INSERT INTO pending_pairings ({PENDING_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
            ),
            params![
                pending.pairing_id,
                pending.device_id,
                super::protocol::device_type_str(pending.device_type),
                pending.pairing_nonce,
                pending.device_pub,
                pending.device_commit,
                pending.key_source,
                pending.node_url,
                pending.device_rand,
                pending.transcript_hash,
                pending.state.as_str(),
                pending.created_at,
                pending.expires_at,
            ],
        )?;
        tx.commit()?;
        Ok(PendingInsert::Inserted)
    }

    /// A live (unexpired) pending pairing. An expired row is deleted and reported
    /// as absent.
    pub async fn get_pending_pairing(
        &self,
        pairing_id: &str,
        now_ms: i64,
    ) -> Result<Option<PendingPairing>> {
        let conn = self.conn.lock().await;
        let pending = conn
            .query_row(
                &format!("SELECT {PENDING_COLUMNS} FROM pending_pairings WHERE pairing_id = ?1"),
                params![pairing_id],
                Self::row_to_pending,
            )
            .optional()?;
        match pending {
            Some(p) if p.expires_at <= now_ms => {
                conn.execute(
                    "DELETE FROM pending_pairings WHERE pairing_id = ?1",
                    params![pairing_id],
                )?;
                Ok(None)
            }
            other => Ok(other),
        }
    }

    /// Record a verified reveal (single use): only a `begun` row moves to
    /// `revealed`. Returns `false` when no begun row matched.
    pub async fn mark_pending_revealed(
        &self,
        pairing_id: &str,
        device_rand: &str,
        transcript_hash: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE pending_pairings SET device_rand = ?2, transcript_hash = ?3, state = 'revealed'
             WHERE pairing_id = ?1 AND state = 'begun'",
            params![pairing_id, device_rand, transcript_hash],
        )?;
        Ok(n > 0)
    }

    /// Delete a pending pairing (idempotent). Returns `true` when a row was removed.
    pub async fn delete_pending_pairing(&self, pairing_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM pending_pairings WHERE pairing_id = ?1",
            params![pairing_id],
        )?;
        Ok(n > 0)
    }

    /// Purge expired pending pairings (lazy cleanup). Returns how many were removed.
    pub async fn purge_expired_pendings(&self, now_ms: i64) -> Result<usize> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM pending_pairings WHERE expires_at <= ?1",
            params![now_ms],
        )?)
    }

    /// Finish a v2 pairing in ONE transaction: delete the pending row (it must
    /// still exist), insert the level-2 device row, and consume the nonce. Any
    /// failure rolls everything back.
    pub async fn insert_paired_v2(
        &self,
        record: &DeviceRecord,
        pairing_nonce: &str,
        pairing_id: &str,
        now_ms: i64,
    ) -> Result<PairedInsert> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction()?;
        let removed = tx.execute(
            "DELETE FROM pending_pairings WHERE pairing_id = ?1 AND expires_at > ?2",
            params![pairing_id, now_ms],
        )?;
        if removed == 0 {
            return Ok(PairedInsert::PendingGone);
        }
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM devices WHERE device_id = ?1",
                params![record.device_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Ok(PairedInsert::AlreadyPaired);
        }
        if let Some(key) = &record.noise_pubkey {
            let bound: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM devices WHERE noise_pubkey = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .optional()?;
            if bound.is_some() {
                return Ok(PairedInsert::KeyBound);
            }
        }
        let fresh = tx.execute(
            "INSERT OR IGNORE INTO consumed_pair_nonces (device_id, nonce, consumed_at)
             VALUES (?1, ?2, ?3)",
            params![record.device_id, pairing_nonce, now_ms],
        )?;
        if fresh == 0 {
            return Ok(PairedInsert::NonceConsumed);
        }
        Self::insert_record(&tx, record)?;
        tx.commit()?;
        Ok(PairedInsert::Inserted)
    }

    // ── Node identity ─────────────────────────────────────────────────────────

    /// Install the host's at-rest sealer for the node key. Clones of this store
    /// share it.
    pub fn set_key_sealer(&self, sealer: Arc<dyn NodeKeySealer>) {
        let mut slot = self
            .sealer
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(sealer);
    }

    fn current_sealer(&self) -> Option<Arc<dyn NodeKeySealer>> {
        self.sealer
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn cached_identity(&self) -> Option<NodeIdentity> {
        self.identity
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn cache_identity(&self, identity: Option<NodeIdentity>) {
        *self
            .identity
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = identity;
    }

    /// Test hook: pin the cached node identity (e.g. the vector node key) without
    /// a sealer, so pairing tests can reproduce the golden vectors.
    #[cfg(test)]
    pub(crate) fn install_identity_for_tests(&self, identity: NodeIdentity) {
        self.cache_identity(Some(identity));
    }

    /// The node identity. Created and sealed lazily when none is stored; when a
    /// stored key cannot be opened this returns [`IdentityError::Unavailable`] and
    /// NEVER overwrites the stored row.
    pub async fn node_identity(&self) -> std::result::Result<NodeIdentity, IdentityError> {
        if let Some(identity) = self.cached_identity() {
            return Ok(identity);
        }
        let sealer = self.current_sealer().ok_or(IdentityError::NoSealer)?;
        let conn = self.conn.lock().await;
        // Re-check under the connection lock: a concurrent caller may have filled it.
        if let Some(identity) = self.cached_identity() {
            return Ok(identity);
        }
        let stored: Option<(String, String)> = conn
            .query_row(
                "SELECT public_key, sealed_secret FROM node_identity WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| IdentityError::Unavailable(format!("reading node identity: {e}")))?;
        let identity = match stored {
            Some((public_key, sealed)) => {
                let opened = sealer
                    .open(&sealed)
                    .map(zeroize::Zeroizing::new)
                    .map_err(|e| IdentityError::Unavailable(format!("opening node key: {e}")))?;
                NodeIdentity::from_opened(&opened, &public_key)?
            }
            None => {
                let identity = NodeIdentity::generate();
                let sealed = sealer
                    .seal(&identity.secret_for_sealing())
                    .map_err(|e| IdentityError::Unavailable(format!("sealing node key: {e}")))?;
                // Plain INSERT: never replaces an existing row.
                conn.execute(
                    "INSERT INTO node_identity (id, public_key, sealed_secret, created_at)
                     VALUES (1, ?1, ?2, ?3)",
                    params![identity.public_b64u(), sealed, now_ms()],
                )
                .map_err(|e| IdentityError::Unavailable(format!("storing node identity: {e}")))?;
                identity
            }
        };
        self.cache_identity(Some(identity.clone()));
        Ok(identity)
    }

    /// The identity health for `GET /api/hardware/devices`. Does not create a key.
    pub async fn node_identity_status(&self) -> NodeIdentityStatus {
        if let Some(identity) = self.cached_identity() {
            return NodeIdentityStatus::Ok {
                fingerprint: identity.fingerprint(),
            };
        }
        let stored = {
            let conn = self.conn.lock().await;
            conn.query_row("SELECT 1 FROM node_identity WHERE id = 1", [], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
        };
        match stored {
            Ok(None) => NodeIdentityStatus::Uninitialized,
            Ok(Some(_)) => match self.node_identity().await {
                Ok(identity) => NodeIdentityStatus::Ok {
                    fingerprint: identity.fingerprint(),
                },
                Err(_) => NodeIdentityStatus::Unavailable,
            },
            Err(_) => NodeIdentityStatus::Unavailable,
        }
    }

    /// Explicitly regenerate the node identity (`POST /api/hardware/identity/reset`).
    /// Marks every level-2 row `needs_repair`, drops every pending pairing (they
    /// are bound to the old key), and returns the new identity plus the affected
    /// device ids. The caller ends those devices' live sessions as superseded.
    pub async fn reset_node_identity(
        &self,
    ) -> std::result::Result<(NodeIdentity, Vec<String>), IdentityError> {
        let sealer = self.current_sealer().ok_or(IdentityError::NoSealer)?;
        let identity = NodeIdentity::generate();
        let sealed = sealer
            .seal(&identity.secret_for_sealing())
            .map_err(|e| IdentityError::Unavailable(format!("sealing node key: {e}")))?;
        let storage = |e: rusqlite::Error| {
            IdentityError::Unavailable(format!("resetting node identity: {e}"))
        };
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().map_err(storage)?;
        let affected: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT device_id FROM devices WHERE protocol_level >= 2 ORDER BY device_id",
                )
                .map_err(storage)?;
            let rows = stmt.query_map([], |row| row.get(0)).map_err(storage)?;
            rows.collect::<rusqlite::Result<_>>().map_err(storage)?
        };
        tx.execute(
            "UPDATE devices SET needs_repair = 1 WHERE protocol_level >= 2",
            [],
        )
        .map_err(storage)?;
        tx.execute("DELETE FROM pending_pairings", [])
            .map_err(storage)?;
        tx.execute(
            "INSERT OR REPLACE INTO node_identity (id, public_key, sealed_secret, created_at)
             VALUES (1, ?1, ?2, ?3)",
            params![identity.public_b64u(), sealed, now_ms()],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        self.cache_identity(Some(identity.clone()));
        Ok((identity, affected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::PlaintextSealerForTests;

    fn temp_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("ryu-hw-test-{}", uuid::Uuid::new_v4()))
            .join("hardware.db")
    }

    fn temp_store() -> DeviceStore {
        DeviceStore::open(temp_path()).expect("open")
    }

    fn sample(id: &str, token: &str) -> DeviceRecord {
        DeviceRecord::new_legacy(
            id,
            DeviceType::Watch,
            "Test Watch",
            hash_token(token),
            now_ms(),
        )
    }

    fn secure_sample(id: &str, token: &str, relay: &str, key: &str) -> DeviceRecord {
        DeviceRecord {
            noise_pubkey: Some(key.into()),
            protocol_level: PROTOCOL_LEVEL_SECURE,
            key_verification: Some("sas".into()),
            key_source: Some("qr".into()),
            relay_token_hash: Some(hash_token(relay)),
            paired_at: Some(now_ms()),
            ..sample(id, token)
        }
    }

    fn pending(pairing_id: &str, device_id: &str, now: i64) -> PendingPairing {
        PendingPairing {
            pairing_id: pairing_id.into(),
            device_id: device_id.into(),
            device_type: DeviceType::Watch,
            pairing_nonce: "00112233445566778899aabbccddeeff".into(),
            device_pub: format!("pub-{device_id}"),
            device_commit: "commit".into(),
            key_source: "qr".into(),
            node_url: "wss://n/api/hardware/ws".into(),
            device_rand: None,
            transcript_hash: None,
            state: PendingState::Begun,
            created_at: now,
            expires_at: now + PENDING_PAIRING_TTL_MS,
        }
    }

    #[tokio::test]
    async fn insert_get_and_verify_token() {
        let store = temp_store();
        store.insert(sample("rhw_1", "secret-token")).await.unwrap();

        let got = store.get("rhw_1").await.unwrap().expect("present");
        assert_eq!(got.device_id, "rhw_1");
        assert_eq!(got.device_type, DeviceType::Watch);
        assert_eq!(got.protocol_level, PROTOCOL_LEVEL_LEGACY);
        assert!(!got.is_secure());

        assert!(store.verify_token("rhw_1", "secret-token").await.unwrap());
        assert!(!store.verify_token("rhw_1", "wrong").await.unwrap());
        assert!(!store.verify_token("nope", "secret-token").await.unwrap());
    }

    #[tokio::test]
    async fn insert_is_plain_and_never_overwrites() {
        let store = temp_store();
        store.insert(sample("rhw_dup", "a")).await.unwrap();
        assert!(store.insert(sample("rhw_dup", "b")).await.is_err());
        assert!(store.verify_token("rhw_dup", "a").await.unwrap());
        assert!(!store.verify_token("rhw_dup", "b").await.unwrap());
    }

    #[tokio::test]
    async fn touch_updates_last_seen_and_battery() {
        let store = temp_store();
        store.insert(sample("rhw_2", "t")).await.unwrap();
        store.touch("rhw_2", Some(81)).await.unwrap();
        let got = store.get("rhw_2").await.unwrap().unwrap();
        assert!(got.last_seen.is_some());
        assert_eq!(got.battery_pct, Some(81));
        // A None battery keeps the previous value.
        store.touch("rhw_2", None).await.unwrap();
        let got = store.get("rhw_2").await.unwrap().unwrap();
        assert_eq!(got.battery_pct, Some(81));
    }

    #[tokio::test]
    async fn update_revoke_and_ambient() {
        let store = temp_store();
        store.insert(sample("rhw_3", "t")).await.unwrap();
        assert!(store
            .update("rhw_3", Some("Kitchen".into()), None)
            .await
            .unwrap());
        store.set_ambient_meeting("rhw_3", "mtg_x").await.unwrap();
        let got = store.get("rhw_3").await.unwrap().unwrap();
        assert_eq!(got.name, "Kitchen");
        assert_eq!(got.ambient_meeting_id.as_deref(), Some("mtg_x"));
        assert!(store.revoke("rhw_3").await.unwrap());
        assert!(store.get("rhw_3").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn authenticate_bearer_distinguishes_device_and_relay() {
        let store = temp_store();
        store
            .insert(secure_sample("rhw_s", "rht_dev", "rhr_rel", "key-s"))
            .await
            .unwrap();
        store.insert(sample("rhw_l", "rht_legacy")).await.unwrap();

        let (record, kind) = store.authenticate_bearer("rht_dev").await.unwrap().unwrap();
        assert_eq!(
            (record.device_id.as_str(), kind),
            ("rhw_s", TokenKind::Device)
        );
        assert!(record.is_secure());
        let (record, kind) = store.authenticate_bearer("rhr_rel").await.unwrap().unwrap();
        assert_eq!(
            (record.device_id.as_str(), kind),
            ("rhw_s", TokenKind::Relay)
        );
        let (_, kind) = store
            .authenticate_bearer("rht_legacy")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kind, TokenKind::Device);
        assert!(store.authenticate_bearer("nope").await.unwrap().is_none());
        assert!(store.authenticate_bearer("").await.unwrap().is_none());
        // verify_token accepts the device token only.
        assert!(store.verify_token("rhw_s", "rht_dev").await.unwrap());
        assert!(!store.verify_token("rhw_s", "rhr_rel").await.unwrap());
        // The pinned key is unique.
        assert!(store.noise_key_bound("key-s").await.unwrap());
        assert!(store
            .insert(secure_sample("rhw_other", "x", "y", "key-s"))
            .await
            .is_err());
    }

    /// The exact v1 DDL of the previous release (ryu-hardware 0.4.0).
    const V1_DDL: &str = "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS devices (
             device_id          TEXT PRIMARY KEY,
             device_type        TEXT NOT NULL,
             name               TEXT NOT NULL,
             token_hash         TEXT NOT NULL,
             last_seen          INTEGER,
             battery_pct        INTEGER,
             prefs              TEXT NOT NULL DEFAULT '{}',
             ambient_meeting_id TEXT,
             created_at         INTEGER NOT NULL
         );";

    #[tokio::test]
    async fn migrates_a_v1_database_and_is_idempotent() {
        let path = temp_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V1_DDL).unwrap();
            conn.execute(
                "INSERT INTO devices (device_id, device_type, name, token_hash, last_seen, battery_pct, prefs, ambient_meeting_id, created_at)
                 VALUES ('rhw_old', 'desk', 'Old Desk', ?1, 5, 40, '{\"a\":1}', 'mtg_1', 7)",
                params![hash_token("old-token")],
            )
            .unwrap();
        }
        let store = DeviceStore::open(path.clone()).unwrap();
        let old = store.get("rhw_old").await.unwrap().unwrap();
        assert_eq!(old.device_type, DeviceType::Desk);
        assert_eq!(old.name, "Old Desk");
        assert_eq!(old.battery_pct, Some(40));
        assert_eq!(old.prefs, serde_json::json!({"a": 1}));
        assert_eq!(old.ambient_meeting_id.as_deref(), Some("mtg_1"));
        assert_eq!(old.protocol_level, PROTOCOL_LEVEL_LEGACY);
        assert!(!old.needs_repair && old.noise_pubkey.is_none());
        assert!(store.verify_token("rhw_old", "old-token").await.unwrap());
        drop(store);

        // Re-running the migration (a second open) changes nothing.
        let store = DeviceStore::open(path.clone()).unwrap();
        let again = store.get("rhw_old").await.unwrap().unwrap();
        assert_eq!(again.name, "Old Desk");
        let conn = store.conn.lock().await;
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(devices)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(columns.len(), 9 + V1_1_DEVICE_COLUMNS.len());
        let indexes: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            indexes,
            [
                "idx_devices_noise_pubkey",
                "idx_devices_relay_token_hash",
                "idx_devices_token_hash",
                "idx_pending_pairings_device"
            ]
        );
        drop(conn);
        DeviceStore::migrate_v1_1(&*store.conn.lock().await).unwrap();
    }

    #[tokio::test]
    async fn level_two_ratchet_only_revoke_clears() {
        let store = temp_store();
        store
            .insert(secure_sample("rhw_r", "rht_a", "rhr_a", "key-r"))
            .await
            .unwrap();
        // A legacy insert for the same id cannot downgrade it.
        assert!(store.insert(sample("rhw_r", "legacy")).await.is_err());
        let row = store.get("rhw_r").await.unwrap().unwrap();
        assert_eq!(row.protocol_level, PROTOCOL_LEVEL_SECURE);
        assert!(row.is_secure());
        // PATCH-style updates do not touch the level.
        store
            .update("rhw_r", Some("n".into()), Some(serde_json::json!({})))
            .await
            .unwrap();
        assert_eq!(
            store.get("rhw_r").await.unwrap().unwrap().protocol_level,
            PROTOCOL_LEVEL_SECURE
        );
        assert!(store.revoke("rhw_r").await.unwrap());
        store.insert(sample("rhw_r", "legacy")).await.unwrap();
        assert_eq!(
            store.get("rhw_r").await.unwrap().unwrap().protocol_level,
            PROTOCOL_LEVEL_LEGACY
        );
    }

    #[tokio::test]
    async fn nonces_are_single_use_and_persist() {
        let path = temp_path();
        let store = DeviceStore::open(path.clone()).unwrap();
        assert!(!store.nonce_consumed("d", "n").await.unwrap());
        assert!(store.consume_nonce("d", "n").await.unwrap());
        assert!(!store.consume_nonce("d", "n").await.unwrap());
        drop(store);
        let reopened = DeviceStore::open(path).unwrap();
        assert!(reopened.nonce_consumed("d", "n").await.unwrap());
        assert!(!reopened.consume_nonce("d", "n").await.unwrap());
    }

    #[tokio::test]
    async fn pending_pairings_ttl_limit_and_replacement() {
        let store = temp_store();
        let now = 1_000_000;
        for i in 0..MAX_PENDING_PAIRINGS {
            let p = pending(&format!("p{i}"), &format!("d{i}"), now);
            assert_eq!(
                store.insert_pending_pairing(&p, now).await.unwrap(),
                PendingInsert::Inserted
            );
        }
        let fifth = pending("p4", "d4", now);
        assert_eq!(
            store.insert_pending_pairing(&fifth, now).await.unwrap(),
            PendingInsert::TooManyPending
        );
        // A newer begin for the same device replaces the old row.
        let replacement = pending("p0b", "d0", now);
        assert_eq!(
            store
                .insert_pending_pairing(&replacement, now)
                .await
                .unwrap(),
            PendingInsert::Inserted
        );
        assert!(store
            .get_pending_pairing("p0", now)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_pending_pairing("p0b", now)
            .await
            .unwrap()
            .is_some());
        // Expired rows are purged before the limit is applied.
        let later = now + PENDING_PAIRING_TTL_MS;
        assert!(store
            .get_pending_pairing("p1", later)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .insert_pending_pairing(&pending("p5", "d5", later), later)
                .await
                .unwrap(),
            PendingInsert::Inserted
        );
        assert_eq!(store.purge_expired_pendings(later).await.unwrap(), 0);
        // Reveal is single use.
        assert!(store.mark_pending_revealed("p5", "r", "h").await.unwrap());
        assert!(!store.mark_pending_revealed("p5", "r", "h").await.unwrap());
        let revealed = store
            .get_pending_pairing("p5", later)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revealed.state, PendingState::Revealed);
        assert_eq!(revealed.transcript_hash.as_deref(), Some("h"));
        assert!(store.delete_pending_pairing("p5").await.unwrap());
        assert!(!store.delete_pending_pairing("p5").await.unwrap());
    }

    #[tokio::test]
    async fn insert_paired_v2_is_one_transaction() {
        let store = temp_store();
        let now = 5_000;
        store
            .insert_pending_pairing(&pending("pp", "rhw_v2", now), now)
            .await
            .unwrap();
        let record = secure_sample("rhw_v2", "rht_x", "rhr_x", "key-v2");
        assert_eq!(
            store
                .insert_paired_v2(&record, "nonce", "pp", now)
                .await
                .unwrap(),
            PairedInsert::Inserted
        );
        assert!(store
            .get_pending_pairing("pp", now)
            .await
            .unwrap()
            .is_none());
        assert!(store.nonce_consumed("rhw_v2", "nonce").await.unwrap());
        assert!(store.get("rhw_v2").await.unwrap().unwrap().is_secure());
        // A replay finds no pending row.
        assert_eq!(
            store
                .insert_paired_v2(&record, "nonce", "pp", now)
                .await
                .unwrap(),
            PairedInsert::PendingGone
        );
        // A consumed nonce rolls the whole transaction back (pending row kept).
        store.revoke("rhw_v2").await.unwrap();
        store
            .insert_pending_pairing(&pending("pq", "rhw_v2", now), now)
            .await
            .unwrap();
        assert_eq!(
            store
                .insert_paired_v2(&record, "nonce", "pq", now)
                .await
                .unwrap(),
            PairedInsert::NonceConsumed
        );
        assert!(store
            .get_pending_pairing("pq", now)
            .await
            .unwrap()
            .is_some());
        assert!(store.get("rhw_v2").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn revoke_deletes_pending_pairings() {
        let store = temp_store();
        let now = now_ms();
        store.insert(sample("rhw_p", "t")).await.unwrap();
        store
            .insert_pending_pairing(&pending("px", "rhw_p", now), now)
            .await
            .unwrap();
        assert!(store.revoke("rhw_p").await.unwrap());
        assert!(store
            .get_pending_pairing("px", now)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn node_identity_create_reload_and_reset() {
        let path = temp_path();
        let store = DeviceStore::open(path.clone()).unwrap();
        assert_eq!(
            store.node_identity().await.unwrap_err(),
            IdentityError::NoSealer
        );
        assert_eq!(
            store.node_identity_status().await,
            NodeIdentityStatus::Uninitialized
        );
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        let clone = store.clone();
        let first = clone.node_identity().await.unwrap();
        assert_eq!(
            store.node_identity().await.unwrap().public(),
            first.public()
        );
        assert_eq!(
            store.node_identity_status().await,
            NodeIdentityStatus::Ok {
                fingerprint: first.fingerprint()
            }
        );
        drop((store, clone));

        // Reload from disk: same key.
        let store = DeviceStore::open(path.clone()).unwrap();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        assert_eq!(
            store.node_identity().await.unwrap().public(),
            first.public()
        );

        // Reset marks level-2 rows and drops pending pairings.
        store
            .insert(secure_sample("rhw_a", "t1", "r1", "key-a"))
            .await
            .unwrap();
        store.insert(sample("rhw_b", "t2")).await.unwrap();
        let now = now_ms();
        store
            .insert_pending_pairing(&pending("pz", "rhw_c", now), now)
            .await
            .unwrap();
        let (fresh, affected) = store.reset_node_identity().await.unwrap();
        assert_ne!(fresh.public(), first.public());
        assert_eq!(affected, ["rhw_a"]);
        assert!(store.get("rhw_a").await.unwrap().unwrap().needs_repair);
        assert!(!store.get("rhw_b").await.unwrap().unwrap().needs_repair);
        assert!(store
            .get_pending_pairing("pz", now)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.node_identity().await.unwrap().public(),
            fresh.public()
        );
        drop(store);
        let reopened = DeviceStore::open(path).unwrap();
        reopened.set_key_sealer(Arc::new(PlaintextSealerForTests));
        assert_eq!(
            reopened.node_identity().await.unwrap().public(),
            fresh.public()
        );
    }

    struct BrokenSealer;

    impl NodeKeySealer for BrokenSealer {
        fn seal(&self, _: &str) -> anyhow::Result<String> {
            anyhow::bail!("no master key")
        }
        fn open(&self, _: &str) -> anyhow::Result<String> {
            anyhow::bail!("no master key")
        }
    }

    #[tokio::test]
    async fn corrupt_sealed_identity_is_unavailable_and_never_overwritten() {
        let path = temp_path();
        let store = DeviceStore::open(path.clone()).unwrap();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        let original = store.node_identity().await.unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE node_identity SET sealed_secret = 'garbage' WHERE id = 1",
                [],
            )
            .unwrap();
        }
        drop(store);

        let store = DeviceStore::open(path.clone()).unwrap();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        assert!(matches!(
            store.node_identity().await,
            Err(IdentityError::Unavailable(_))
        ));
        assert_eq!(
            store.node_identity_status().await,
            NodeIdentityStatus::Unavailable
        );
        // The stored row is untouched (still the corrupt value and the old public key).
        let (public_key, sealed): (String, String) = store
            .conn
            .lock()
            .await
            .query_row(
                "SELECT public_key, sealed_secret FROM node_identity WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(public_key, original.public_b64u());
        assert_eq!(sealed, "garbage");

        // A sealer that cannot open anything is also Unavailable, not a regeneration.
        let other = DeviceStore::open(path).unwrap();
        other.set_key_sealer(Arc::new(BrokenSealer));
        assert!(matches!(
            other.node_identity().await,
            Err(IdentityError::Unavailable(_))
        ));
    }
}
