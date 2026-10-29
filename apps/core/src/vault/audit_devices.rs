//! External vault audit devices.
//!
//! The HMAC-chained `vault_audit` table stays the source of truth. After each
//! successful append, every enabled device receives the same canonical row as
//! one JSON object, including the row's chain `hmac`, so an operator can match
//! a device record to the chain:
//!
//! * `file`: JSON Lines appended to an absolute path, rotated by size
//!   (`maxBytes`, `maxFiles`). The file is reopened for every record, so an
//!   external `logrotate` move followed by SIGHUP-style reopen semantics works
//!   without signalling Core. The path must sit under `$RYU_DIR/audit/` or a
//!   directory the operator lists in `RYU_VAULT_AUDIT_DIRS`, never elsewhere in
//!   the data directory; symlinks and non-regular files are refused, and an
//!   existing file is only appended to or rotated when it already holds vault
//!   audit records.
//! * `syslog`: RFC 5424 datagrams to a unix socket (`unix:/dev/log`) or UDP
//!   (`udp:host:514`).
//! * `socket`: newline-delimited JSON over TCP (`tcp:host:port`) or a unix
//!   stream socket (`unix:/path`), delivered off the request path.
//! * `http`: HTTPS POST (http only for loopback), delivered off the request
//!   path with bounded retries. When `secretRef` is set the body is signed with
//!   the same `x-ryu-timestamp` / `x-ryu-signature` scheme as webhook dynamic
//!   credentials.
//!
//! Rows never hold values. With `hmacFields` (the default) request identifiers
//! (actor id, scope id, name, request id, and the `accessor`, `leaseId`, and
//! `names` details) are replaced with `hmac-sha256:<hex>` under a per-device
//! salt derived from the sealed audit key, and [`audit_hash`] lets an admin
//! compute the same digest to search a device's log.
//!
//! Network targets (`udp:`, `tcp:`, `http`) are resolved and screened before
//! delivery: link-local and metadata addresses are always refused, and other
//! private ranges need `RYU_VAULT_AUDIT_ALLOW_PRIVATE=1`. Loopback is allowed.
//! HTTP redirects are not followed, and URLs may not carry credentials.
//!
//! With `RYU_VAULT_AUDIT_FAIL_CLOSED` set, a row that no enabled synchronous
//! device (`file`, `syslog`) wrote makes the operation that produced it fail,
//! so value handouts return 503 instead of a value that no external device
//! recorded. Background devices (`socket`, `http`) are best-effort and never
//! satisfy fail-closed on their own.
//!
//! Devices are operator-owned local audit data, not product telemetry: they
//! are configured here (admin routes or the declarative init file) and are
//! independent of the telemetry consent in `privacy.rs`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use super::audit::AuditRow;
use super::now_millis;

/// Env flag that turns on fail-closed auditing.
pub const ENV_FAIL_CLOSED: &str = "RYU_VAULT_AUDIT_FAIL_CLOSED";
/// Extra directories (OS path-list syntax) where file devices may write, in
/// addition to `$RYU_DIR/audit/`.
pub const ENV_AUDIT_DIRS: &str = "RYU_VAULT_AUDIT_DIRS";
/// Env flag that lets network devices target private (RFC 1918, ULA, CGNAT)
/// addresses. Link-local and metadata addresses stay refused.
pub const ENV_ALLOW_PRIVATE: &str = "RYU_VAULT_AUDIT_ALLOW_PRIVATE";
/// Maximum configured devices.
pub const MAX_DEVICES: usize = 16;
const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const MIN_MAX_BYTES: u64 = 4 * 1024;
const DEFAULT_MAX_FILES: u64 = 5;
const MAX_MAX_FILES: u64 = 50;
const DEFAULT_SYSLOG_FACILITY: u64 = 10; // authpriv
const DEFAULT_TIMEOUT_MS: u64 = 2_000;
/// Upper bound on queued off-path deliveries across all devices.
const MAX_INFLIGHT: usize = 256;
const HTTP_ATTEMPTS: u32 = 3;
const HASH_PREFIX: &str = "hmac-sha256:";
/// Detail keys that carry request identifiers and are hashed per device.
const HASHED_DETAIL_KEYS: &[&str] = &["accessor", "leaseId", "names", "conversationId"];

/// Supported device types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    File,
    Syslog,
    Socket,
    Http,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Syslog => "syslog",
            Self::Socket => "socket",
            Self::Http => "http",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "file" => Self::File,
            "syslog" => Self::Syslog,
            "socket" => Self::Socket,
            "http" => Self::Http,
            _ => return None,
        })
    }
}

fn default_true() -> bool {
    true
}

fn default_source() -> String {
    "api".to_owned()
}

/// One configured audit device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditDevice {
    pub id: String,
    pub kind: DeviceKind,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub description: String,
    /// Replace request identifiers with salted HMACs (default on).
    #[serde(default = "default_true")]
    pub hmac_fields: bool,
    /// Kind-specific options; see the module docs.
    #[serde(default)]
    pub options: Value,
    /// `api` or `declarative`.
    #[serde(default = "default_source")]
    pub source: String,
}

/// Delivery health for one device, for the admin listing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHealth {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub failing: bool,
}

/// Result of fanning one row out to the enabled devices.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub enabled: usize,
    /// Devices that wrote the row or queued it for background delivery.
    pub accepted: usize,
    /// Synchronous devices (`file`, `syslog`) that wrote the row before
    /// returning. Only these satisfy fail-closed auditing.
    pub durable: usize,
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
thread_local! {
    /// Per-test override of [`fail_closed`], so tests never mutate the
    /// process environment that parallel tests share.
    static FAIL_CLOSED_OVERRIDE: std::cell::Cell<Option<bool>> =
        const { std::cell::Cell::new(None) };
    /// Per-test extra file-device roots.
    static TEST_AUDIT_ROOTS: std::cell::RefCell<Vec<PathBuf>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Force fail-closed on or off for the current test thread.
#[cfg(test)]
pub(crate) fn set_fail_closed_for_test(value: Option<bool>) {
    FAIL_CLOSED_OVERRIDE.with(|cell| cell.set(value));
}

/// Allow file devices under `dir` for the current test thread.
#[cfg(test)]
pub(crate) fn allow_audit_dir_for_test(dir: &Path) {
    TEST_AUDIT_ROOTS.with(|roots| roots.borrow_mut().push(dir.to_path_buf()));
}

/// Whether fail-closed auditing is on.
pub fn fail_closed() -> bool {
    #[cfg(test)]
    if let Some(value) = FAIL_CLOSED_OVERRIDE.with(std::cell::Cell::get) {
        return value;
    }
    env_flag(ENV_FAIL_CLOSED)
}

/// Whether an operation may proceed after its audit row was dispatched.
/// Under fail-closed only a synchronous write counts: a queued background
/// delivery has not been recorded anywhere yet.
pub fn permits(outcome: DispatchOutcome, fail_closed: bool) -> bool {
    !fail_closed || outcome.durable > 0
}

// ── Target guards ───────────────────────────────────────────────────────

/// Canonical form of `path` when it exists, else `path` itself.
fn resolve_existing(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The data directory's own audit-file directory (`<data dir>/logs/audit`).
fn own_audit_dir() -> PathBuf {
    crate::paths::logs_dir().join("audit")
}

/// Directories file devices may write under, canonicalized where they exist.
fn audit_roots() -> Vec<PathBuf> {
    let mut roots = vec![own_audit_dir()];
    if let Some(extra) = std::env::var_os(ENV_AUDIT_DIRS) {
        roots.extend(std::env::split_paths(&extra).filter(|dir| dir.is_absolute()));
    }
    #[cfg(test)]
    TEST_AUDIT_ROOTS.with(|extra| roots.extend(extra.borrow().iter().cloned()));
    roots.iter().map(|root| resolve_existing(root)).collect()
}

/// Whether `dir` (already canonicalized where possible) is an allowed file
/// device directory: under an audit root, and not elsewhere in the data dir.
fn audit_dir_allowed(dir: &Path) -> bool {
    let data = resolve_existing(&crate::paths::ryu_dir());
    let own_audit = resolve_existing(&own_audit_dir());
    if dir.starts_with(&data) && !dir.starts_with(&own_audit) {
        return false;
    }
    audit_roots().iter().any(|root| dir.starts_with(root))
}

fn validate_file_path(raw: &str) -> Result<()> {
    let path = Path::new(raw);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        bail!("options.path must be an absolute path without `.` or `..`");
    }
    let (Some(parent), Some(_)) = (path.parent(), path.file_name()) else {
        bail!("options.path must name a file");
    };
    if !audit_dir_allowed(&resolve_existing(parent)) {
        bail!(
            "options.path must be under {} or a directory listed in {ENV_AUDIT_DIRS}",
            own_audit_dir().display()
        );
    }
    Ok(())
}

fn private_targets_allowed() -> bool {
    env_flag(ENV_ALLOW_PRIVATE)
}

/// Whether a network device may deliver to `ip`.
fn target_ip_allowed(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        other => other,
    };
    if ip.is_loopback() {
        return true;
    }
    let link_local = match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    };
    if link_local || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    !ryu_egress::is_blocked_ip(ip) || private_targets_allowed()
}

fn check_targets(addrs: &[SocketAddr]) -> Result<()> {
    if addrs.is_empty() {
        bail!("the device address did not resolve");
    }
    if let Some(blocked) = addrs.iter().find(|addr| !target_ip_allowed(addr.ip())) {
        bail!(
            "audit device target {} is a link-local, metadata, or private address \
             (set {ENV_ALLOW_PRIVATE}=1 to allow private networks)",
            blocked.ip()
        );
    }
    Ok(())
}

fn validate_literal_host(host: &str) -> Result<()> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        check_targets(&[SocketAddr::new(ip, 0)])?;
    }
    Ok(())
}

/// Query parameter names that look like credentials.
fn credential_like(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "key",
        "secret",
        "password",
        "passwd",
        "pwd",
        "auth",
        "sig",
        "credential",
        "session",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

/// Option keys each device kind accepts.
fn allowed_option_keys(kind: DeviceKind) -> &'static [&'static str] {
    match kind {
        DeviceKind::File => &["path", "maxBytes", "maxFiles"],
        DeviceKind::Syslog => &["address", "facility", "tag"],
        DeviceKind::Socket => &["address", "timeoutMs"],
        DeviceKind::Http => &["url", "secretRef"],
    }
}

// ── Configuration ───────────────────────────────────────────────────────

/// Create the device table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_audit_devices (
             id          TEXT PRIMARY KEY,
             kind        TEXT NOT NULL,
             enabled     INTEGER NOT NULL DEFAULT 1,
             description TEXT NOT NULL DEFAULT '',
             hmac_fields INTEGER NOT NULL DEFAULT 1,
             options     TEXT NOT NULL,
             source      TEXT NOT NULL DEFAULT 'api',
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL
         );",
    )
    .context("initializing vault audit device schema")
}

/// Whether `id` is a valid device id (`^[a-z0-9][a-z0-9_-]{0,63}$`).
pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
}

fn opt_str<'a>(options: &'a Value, key: &str) -> Option<&'a str> {
    options.get(key).and_then(Value::as_str).map(str::trim)
}

fn opt_u64(options: &Value, key: &str, default: u64) -> Result<u64> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| anyhow!("{key} must be a non-negative integer")),
    }
}

fn validate_host_port(rest: &str) -> Result<()> {
    let (host, port) = rest
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("address must be host:port"))?;
    if host.is_empty() || port.parse::<u16>().map_or(true, |port| port == 0) {
        bail!("address must be host:port with a non-zero port");
    }
    validate_literal_host(host)
}

/// Validate a `secretRef`: only `env:NAME` or `file:/absolute/path`.
pub fn validate_secret_ref(reference: &str) -> Result<()> {
    if let Some(name) = reference.strip_prefix("env:") {
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            bail!("secretRef env: name must be an upper-case env var name");
        }
        return Ok(());
    }
    if let Some(path) = reference.strip_prefix("file:") {
        if !Path::new(path).is_absolute() {
            bail!("secretRef file: path must be absolute");
        }
        return Ok(());
    }
    bail!("secretRef must be env:NAME or file:/absolute/path; inline secrets are not accepted")
}

/// Resolve a validated `secretRef` to its value.
fn resolve_secret_ref(reference: &str) -> Result<String> {
    validate_secret_ref(reference)?;
    let value = if let Some(name) = reference.strip_prefix("env:") {
        std::env::var(name).with_context(|| format!("{name} is not set"))?
    } else {
        let path = reference.trim_start_matches("file:");
        std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?
    };
    let value = value.trim().to_owned();
    if value.len() < 16 {
        bail!("the referenced signing secret must be at least 16 characters");
    }
    Ok(value)
}

/// Validate one device definition.
pub fn validate(device: &AuditDevice) -> Result<()> {
    if !is_valid_id(&device.id) {
        bail!("device id must match ^[a-z0-9][a-z0-9_-]{{0,63}}$");
    }
    if device.description.len() > 256 {
        bail!("description must be at most 256 characters");
    }
    let options = &device.options;
    if !(options.is_object() || options.is_null()) {
        bail!("options must be an object");
    }
    if options.get("secret").is_some() || options.get("signingSecret").is_some() {
        bail!("inline secrets are not accepted; use secretRef (env:NAME or file:/path)");
    }
    if let Some(map) = options.as_object() {
        let allowed = allowed_option_keys(device.kind);
        if let Some(unknown) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
            bail!(
                "unknown {} option `{unknown}` (allowed: {})",
                device.kind.as_str(),
                allowed.join(", ")
            );
        }
    }
    match device.kind {
        DeviceKind::File => {
            let path = opt_str(options, "path")
                .ok_or_else(|| anyhow!("file devices need options.path"))?;
            validate_file_path(path)?;
            if opt_u64(options, "maxBytes", DEFAULT_MAX_BYTES)? < MIN_MAX_BYTES {
                bail!("options.maxBytes must be at least {MIN_MAX_BYTES}");
            }
            if !(1..=MAX_MAX_FILES).contains(&opt_u64(options, "maxFiles", DEFAULT_MAX_FILES)?) {
                bail!("options.maxFiles must be between 1 and {MAX_MAX_FILES}");
            }
        }
        DeviceKind::Syslog => {
            let address = opt_str(options, "address").unwrap_or("unix:/dev/log");
            if let Some(path) = address.strip_prefix("unix:") {
                if !Path::new(path).is_absolute() {
                    bail!("unix syslog address must be an absolute path");
                }
            } else if let Some(rest) = address.strip_prefix("udp:") {
                validate_host_port(rest)?;
            } else {
                bail!("syslog address must be unix:/path or udp:host:port");
            }
            if opt_u64(options, "facility", DEFAULT_SYSLOG_FACILITY)? > 23 {
                bail!("options.facility must be between 0 and 23");
            }
        }
        DeviceKind::Socket => {
            let address = opt_str(options, "address")
                .ok_or_else(|| anyhow!("socket devices need options.address"))?;
            if let Some(path) = address.strip_prefix("unix:") {
                if !Path::new(path).is_absolute() {
                    bail!("unix socket address must be an absolute path");
                }
            } else if let Some(rest) = address.strip_prefix("tcp:") {
                validate_host_port(rest)?;
            } else {
                bail!("socket address must be tcp:host:port or unix:/path");
            }
            let timeout = opt_u64(options, "timeoutMs", DEFAULT_TIMEOUT_MS)?;
            if !(100..=30_000).contains(&timeout) {
                bail!("options.timeoutMs must be between 100 and 30000");
            }
        }
        DeviceKind::Http => {
            let raw =
                opt_str(options, "url").ok_or_else(|| anyhow!("http devices need options.url"))?;
            let url = url::Url::parse(raw).map_err(|_| anyhow!("options.url is not a URL"))?;
            let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                bail!("options.url must be https (http is allowed only for loopback)");
            }
            if !url.username().is_empty() || url.password().is_some() {
                bail!("options.url must not carry credentials; use secretRef for signing");
            }
            if url.query_pairs().any(|(name, _)| credential_like(&name)) {
                bail!("options.url must not carry credentials in its query; use secretRef");
            }
            let host = url
                .host_str()
                .ok_or_else(|| anyhow!("options.url needs a host"))?;
            validate_literal_host(host)?;
            if let Some(reference) = opt_str(options, "secretRef") {
                validate_secret_ref(reference)?;
            }
        }
    }
    Ok(())
}

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditDevice> {
    let kind: String = row.get(1)?;
    let options: String = row.get(5)?;
    Ok(AuditDevice {
        id: row.get(0)?,
        kind: DeviceKind::parse(&kind).unwrap_or(DeviceKind::File),
        enabled: row.get::<_, i64>(2)? != 0,
        description: row.get(3)?,
        hmac_fields: row.get::<_, i64>(4)? != 0,
        options: serde_json::from_str(&options).unwrap_or(Value::Null),
        source: row.get(6)?,
    })
}

const COLUMNS: &str = "id, kind, enabled, description, hmac_fields, options, source";

/// Every configured device, ordered by id.
pub fn list(conn: &Connection) -> Result<Vec<AuditDevice>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM vault_audit_devices ORDER BY id"
    ))?;
    let rows = stmt.query_map([], device_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One device by id.
pub fn get(conn: &Connection, id: &str) -> Result<Option<AuditDevice>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM vault_audit_devices WHERE id = ?1"),
            params![id],
            device_from_row,
        )
        .optional()?)
}

/// Create or replace a device after validating it.
pub fn put(conn: &Connection, device: &AuditDevice) -> Result<()> {
    validate(device)?;
    let exists = get(conn, &device.id)?.is_some();
    if !exists {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM vault_audit_devices", [], |row| {
            row.get(0)
        })?;
        if count as usize >= MAX_DEVICES {
            bail!("at most {MAX_DEVICES} audit devices may be configured");
        }
    }
    let now = now_millis();
    conn.execute(
        "INSERT INTO vault_audit_devices
             (id, kind, enabled, description, hmac_fields, options, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled,
             description = excluded.description, hmac_fields = excluded.hmac_fields,
             options = excluded.options, source = excluded.source, updated_at = excluded.updated_at",
        params![
            device.id,
            device.kind.as_str(),
            device.enabled as i64,
            device.description,
            device.hmac_fields as i64,
            serde_json::to_string(&device.options)?,
            device.source,
            now
        ],
    )?;
    Ok(())
}

/// Delete a device. Returns whether it existed.
pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    health_map().lock().map(|mut map| map.remove(id)).ok();
    Ok(conn.execute("DELETE FROM vault_audit_devices WHERE id = ?1", params![id])? > 0)
}

// ── Hashing ─────────────────────────────────────────────────────────────

/// Per-device salt, derived from the sealed audit key so it never needs its
/// own storage and survives restarts.
fn device_salt(audit_key: &[u8], device_id: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(audit_key).expect("HMAC accepts any key length");
    mac.update(b"ryu-vault-audit-device-salt\0");
    mac.update(device_id.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hash_with(salt: &[u8], value: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt).expect("HMAC accepts any key length");
    mac.update(value.as_bytes());
    format!("{HASH_PREFIX}{}", hex::encode(mac.finalize().into_bytes()))
}

/// The digest `device_id` writes for `input`, so an admin can search that
/// device's log for an accessor, name, or other hashed identifier.
pub fn audit_hash(audit_key: &[u8], device_id: &str, input: &str) -> String {
    hash_with(&device_salt(audit_key, device_id), input)
}

fn hash_value(salt: &[u8], value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(hash_with(salt, text)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| hash_value(salt, item)).collect())
        }
        other => other.clone(),
    }
}

/// The JSON record one device receives for `row`.
pub fn render(row: &AuditRow, chain_hmac: &str, device: &AuditDevice, audit_key: &[u8]) -> Value {
    let mut record = serde_json::to_value(row).unwrap_or(Value::Null);
    let Value::Object(map) = &mut record else {
        return record;
    };
    map.insert("type".into(), json!("vault_audit"));
    map.insert("hmac".into(), json!(chain_hmac));
    map.insert("device".into(), json!(device.id));
    if device.hmac_fields {
        let salt = device_salt(audit_key, &device.id);
        let hash_key = |map: &mut Map<String, Value>, key: &str| {
            if let Some(value) = map.get_mut(key) {
                *value = hash_value(&salt, value);
            }
        };
        hash_key(map, "name");
        hash_key(map, "scopeId");
        hash_key(map, "requestId");
        if let Some(Value::Object(actor)) = map.get_mut("actor") {
            hash_key(actor, "id");
        }
        if let Some(Value::Object(details)) = map.get_mut("details") {
            for key in HASHED_DETAIL_KEYS {
                hash_key(details, key);
            }
        }
    }
    record
}

// ── Delivery ────────────────────────────────────────────────────────────

fn health_map() -> &'static Mutex<HashMap<String, DeviceHealth>> {
    static HEALTH: OnceLock<Mutex<HashMap<String, DeviceHealth>>> = OnceLock::new();
    HEALTH.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_health(id: &str, result: &Result<()>) {
    let Ok(mut map) = health_map().lock() else {
        return;
    };
    let entry = map.entry(id.to_owned()).or_default();
    match result {
        Ok(()) => {
            entry.last_ok_at = Some(now_millis());
            entry.failing = false;
        }
        Err(error) => {
            entry.last_error_at = Some(now_millis());
            entry.last_error = Some(format!("{error:#}").chars().take(256).collect());
            entry.failing = true;
        }
    }
}

/// Delivery health for `id`.
pub fn health(id: &str) -> DeviceHealth {
    health_map()
        .lock()
        .ok()
        .and_then(|map| map.get(id).cloned())
        .unwrap_or_default()
}

static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn rotated(path: &Path, index: u64) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

fn rotate(path: &Path, max_files: u64) -> Result<()> {
    let _ = std::fs::remove_file(rotated(path, max_files));
    for index in (1..max_files).rev() {
        let from = rotated(path, index);
        if from.exists() {
            std::fs::rename(&from, rotated(path, index + 1))?;
        }
    }
    std::fs::rename(path, rotated(path, 1))?;
    Ok(())
}

/// Whether the file at `path` starts with a vault audit record, i.e. this
/// device (or a rotation of it) created it.
fn holds_audit_records(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(4096);
    if file.take(64 * 1024).read_to_end(&mut head).is_err() {
        return false;
    }
    let first = head.split(|byte| *byte == b'\n').next().unwrap_or_default();
    serde_json::from_slice::<Value>(first)
        .is_ok_and(|record| record.get("type") == Some(&json!("vault_audit")))
}

fn write_file(options: &Value, line: &str) -> Result<()> {
    let raw = opt_str(options, "path").unwrap_or_default();
    // Re-check at write time: the stored row predates any env change, and
    // the parent may have been swapped for a symlink since validation.
    validate_file_path(raw)?;
    let path = PathBuf::from(raw);
    let max_bytes = opt_u64(options, "maxBytes", DEFAULT_MAX_BYTES)?;
    let max_files = opt_u64(options, "maxFiles", DEFAULT_MAX_FILES)?;
    let _guard = file_lock()
        .lock()
        .map_err(|_| anyhow!("audit file lock poisoned"))?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("audit file path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let parent = std::fs::canonicalize(parent)?;
    if !audit_dir_allowed(&parent) {
        bail!("audit file directory resolves outside the allowed audit directories");
    }
    let path = parent.join(path.file_name().unwrap_or_default());
    let size = match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() => {
            bail!("{} is not a regular file", path.display())
        }
        Ok(meta) => meta.len(),
        Err(_) => 0,
    };
    if size > 0 && !holds_audit_records(&path) {
        bail!(
            "{} already exists and does not hold vault audit records",
            path.display()
        );
    }
    if size > 0 && size + line.len() as u64 + 1 > max_bytes {
        rotate(&path, max_files)?;
    }
    let mut open = std::fs::OpenOptions::new();
    open.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = open
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

fn syslog_message(options: &Value, row: &AuditRow, line: &str) -> Result<String> {
    let facility = opt_u64(options, "facility", DEFAULT_SYSLOG_FACILITY)?;
    // info for ok rows, warning for denied/error/other outcomes.
    let severity = if row.outcome == "ok" { 6 } else { 4 };
    let tag: String = opt_str(options, "tag")
        .unwrap_or("ryu-vault")
        .chars()
        .filter(|ch| ch.is_ascii_graphic())
        .take(48)
        .collect();
    Ok(format!(
        "<{}>1 {} - {} - vault_audit - {line}",
        facility * 8 + severity,
        row.at,
        if tag.is_empty() { "ryu-vault" } else { &tag },
    ))
}

/// Resolved UDP syslog targets, so DNS runs once per address rather than on
/// every audit row while the store lock is held.
fn udp_target(rest: &str) -> Result<SocketAddr> {
    static CACHE: OnceLock<Mutex<HashMap<String, SocketAddr>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(addr) = cache.lock().ok().and_then(|map| map.get(rest).copied()) {
        return Ok(addr);
    }
    let addrs: Vec<SocketAddr> = rest
        .to_socket_addrs()
        .with_context(|| format!("resolving {rest}"))?
        .collect();
    check_targets(&addrs)?;
    let addr = addrs[0];
    if let Ok(mut map) = cache.lock() {
        map.insert(rest.to_owned(), addr);
    }
    Ok(addr)
}

fn would_block(error: std::io::Error) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        anyhow!("syslog receiver is not accepting datagrams")
    } else {
        error.into()
    }
}

fn write_syslog(options: &Value, message: &str) -> Result<()> {
    let address = opt_str(options, "address").unwrap_or("unix:/dev/log");
    if let Some(rest) = address.strip_prefix("udp:") {
        let target = udp_target(rest)?;
        let bind: SocketAddr = if target.is_ipv4() {
            ([0, 0, 0, 0], 0).into()
        } else {
            (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
        };
        let socket = std::net::UdpSocket::bind(bind)?;
        socket.set_nonblocking(true)?;
        socket
            .send_to(message.as_bytes(), target)
            .map_err(would_block)?;
        return Ok(());
    }
    #[cfg(unix)]
    if let Some(path) = address.strip_prefix("unix:") {
        let socket = std::os::unix::net::UnixDatagram::unbound()?;
        // A stalled syslog daemon must not stall every vault operation.
        socket.set_nonblocking(true)?;
        socket
            .send_to(message.as_bytes(), path)
            .map_err(would_block)?;
        return Ok(());
    }
    bail!("unsupported syslog address `{address}`")
}

async fn deliver_socket(options: Value, line: String) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let address = opt_str(&options, "address").unwrap_or_default().to_owned();
    let timeout = Duration::from_millis(opt_u64(&options, "timeoutMs", DEFAULT_TIMEOUT_MS)?);
    let payload = format!("{line}\n");
    let send = async {
        if let Some(rest) = address.strip_prefix("tcp:") {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host(rest).await?.collect();
            check_targets(&addrs)?;
            let mut stream = tokio::net::TcpStream::connect(addrs[0]).await?;
            stream.write_all(payload.as_bytes()).await?;
            stream.flush().await?;
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(path) = address.strip_prefix("unix:") {
            let mut stream = tokio::net::UnixStream::connect(path).await?;
            stream.write_all(payload.as_bytes()).await?;
            stream.flush().await?;
            return Ok(());
        }
        Err(anyhow!("unsupported socket address `{address}`"))
    };
    tokio::time::timeout(timeout, send)
        .await
        .map_err(|_| anyhow!("socket delivery timed out"))?
}

async fn deliver_http(options: Value, line: String) -> Result<()> {
    let url = opt_str(&options, "url").unwrap_or_default().to_owned();
    let secret = opt_str(&options, "secretRef")
        .map(resolve_secret_ref)
        .transpose()?;
    let parsed = url::Url::parse(&url).context("audit device url")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("audit device url has no host"))?
        .to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare.as_str(), port))
        .await
        .with_context(|| format!("resolving {bare}"))?
        .collect();
    check_targets(&addrs)?;
    // Pin the screened addresses (no re-resolution) and never follow a
    // redirect to a host that was not screened.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&bare, &addrs)
        .build()?;
    let mut last_error = anyhow!("no delivery attempted");
    for attempt in 0..HTTP_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(250 * 4u64.pow(attempt - 1))).await;
        }
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let mut request = client
            .post(&url)
            .timeout(Duration::from_secs(10))
            .header("content-type", "application/json")
            .header("x-ryu-timestamp", &timestamp);
        if let Some(secret) = &secret {
            request = request.header(
                "x-ryu-signature",
                super::dynamic::webhook::signature(secret, &timestamp, &line),
            );
        }
        match request.body(line.clone()).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => last_error = anyhow!("audit webhook returned {}", response.status()),
            Err(error) => last_error = error.without_url().into(),
        }
    }
    Err(last_error)
}

/// Queue an off-path delivery. Returns whether it was accepted (queued, and
/// the device is not currently failing).
fn spawn_delivery(device: &AuditDevice, line: String) -> bool {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        record_health(&device.id, &Err(anyhow!("no async runtime for delivery")));
        return false;
    };
    if INFLIGHT.fetch_add(1, Ordering::SeqCst) >= MAX_INFLIGHT {
        INFLIGHT.fetch_sub(1, Ordering::SeqCst);
        record_health(&device.id, &Err(anyhow!("delivery queue is full")));
        return false;
    }
    let healthy = !health(&device.id).failing;
    let id = device.id.clone();
    let kind = device.kind;
    let options = device.options.clone();
    handle.spawn(async move {
        let result = match kind {
            DeviceKind::Socket => deliver_socket(options, line).await,
            _ => deliver_http(options, line).await,
        };
        if let Err(error) = &result {
            tracing::warn!(device = %id, "vault audit device delivery failed: {error:#}");
        }
        record_health(&id, &result);
        INFLIGHT.fetch_sub(1, Ordering::SeqCst);
    });
    healthy
}

/// Deliver one record. Returns `(accepted, durable)`: whether the device
/// took the row, and whether it was written synchronously.
fn deliver(device: &AuditDevice, row: &AuditRow, line: String) -> (bool, bool) {
    let result = match device.kind {
        DeviceKind::File => write_file(&device.options, &line),
        DeviceKind::Syslog => syslog_message(&device.options, row, &line)
            .and_then(|message| write_syslog(&device.options, &message)),
        DeviceKind::Socket | DeviceKind::Http => return (spawn_delivery(device, line), false),
    };
    if let Err(error) = &result {
        tracing::warn!(device = %device.id, "vault audit device write failed: {error:#}");
    }
    let ok = result.is_ok();
    record_health(&device.id, &result);
    (ok, ok)
}

/// Fan one appended row out to every enabled device.
pub fn dispatch(
    conn: &Connection,
    audit_key: &[u8],
    row: &AuditRow,
    chain_hmac: &str,
) -> DispatchOutcome {
    let devices = match list(conn) {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!("loading vault audit devices failed: {error:#}");
            return DispatchOutcome::default();
        }
    };
    let mut outcome = DispatchOutcome::default();
    for device in devices.iter().filter(|device| device.enabled) {
        outcome.enabled += 1;
        let line = render(row, chain_hmac, device, audit_key).to_string();
        let (accepted, durable) = deliver(device, row, line);
        outcome.accepted += usize::from(accepted);
        outcome.durable += usize::from(durable);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::audit::AuditActor;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn row() -> AuditRow {
        AuditRow {
            seq: 1,
            at: "2026-01-01T00:00:00+00:00".into(),
            actor: AuditActor::new("machine", Some("mi_1")),
            action: "secret.read".into(),
            outcome: "ok".into(),
            scope: Some("node".into()),
            scope_id: Some("node-1".into()),
            environment: Some("prod".into()),
            path: Some("/".into()),
            name: Some("DB_URL".into()),
            details: json!({ "version": 2, "accessor": "rva_abc" }),
            request_id: None,
        }
    }

    fn file_device(dir: &Path, max_bytes: u64) -> AuditDevice {
        allow_audit_dir_for_test(dir);
        AuditDevice {
            id: "local-file".into(),
            kind: DeviceKind::File,
            enabled: true,
            description: String::new(),
            hmac_fields: true,
            options: json!({
                "path": dir.join("audit.jsonl").to_string_lossy(),
                "maxBytes": max_bytes,
                "maxFiles": 2,
            }),
            source: "api".into(),
        }
    }

    #[test]
    fn validation_rejects_inline_secrets_and_relative_paths() {
        let mut device = file_device(Path::new("/tmp"), DEFAULT_MAX_BYTES);
        device.options = json!({ "path": "relative.jsonl" });
        assert!(validate(&device).is_err());
        let http = AuditDevice {
            id: "siem".into(),
            kind: DeviceKind::Http,
            enabled: true,
            description: String::new(),
            hmac_fields: true,
            options: json!({ "url": "https://siem.example/ingest", "secret": "inline-secret-value" }),
            source: "api".into(),
        };
        assert!(validate(&http).is_err());
        let mut http_ok = http.clone();
        http_ok.options =
            json!({ "url": "https://siem.example/ingest", "secretRef": "env:SIEM_KEY" });
        assert!(validate(&http_ok).is_ok());
        http_ok.options = json!({ "url": "http://siem.example/ingest" });
        assert!(validate(&http_ok).is_err());
        assert!(validate_secret_ref("plain-text-secret").is_err());
    }

    #[test]
    fn rendering_hashes_identifiers_with_a_per_device_salt() {
        let key = [7u8; 32];
        let device = file_device(Path::new("/tmp"), DEFAULT_MAX_BYTES);
        let record = render(&row(), "chain", &device, &key);
        assert_eq!(record["hmac"], "chain");
        assert_eq!(record["environment"], "prod");
        assert_eq!(record["name"], audit_hash(&key, "local-file", "DB_URL"));
        assert_eq!(
            record["actor"]["id"],
            audit_hash(&key, "local-file", "mi_1")
        );
        assert_eq!(
            record["details"]["accessor"],
            audit_hash(&key, "local-file", "rva_abc")
        );
        assert_eq!(record["details"]["version"], 2);
        assert_ne!(
            audit_hash(&key, "local-file", "DB_URL"),
            audit_hash(&key, "other", "DB_URL")
        );
        let mut plain = device.clone();
        plain.hmac_fields = false;
        assert_eq!(render(&row(), "chain", &plain, &key)["name"], "DB_URL");
    }

    #[test]
    fn file_devices_append_jsonl_and_rotate_by_size() {
        let dir = tempfile::tempdir().unwrap();
        let conn = conn();
        put(&conn, &file_device(dir.path(), MIN_MAX_BYTES)).unwrap();
        let key = [1u8; 32];
        for _ in 0..40 {
            let outcome = dispatch(&conn, &key, &row(), "chain");
            assert_eq!(
                outcome,
                DispatchOutcome {
                    enabled: 1,
                    accepted: 1,
                    durable: 1,
                }
            );
        }
        let current = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
        let first: Value = serde_json::from_str(current.lines().next().unwrap()).unwrap();
        assert_eq!(first["type"], "vault_audit");
        assert!(dir.path().join("audit.jsonl.1").exists());
        assert!(!dir.path().join("audit.jsonl.3").exists());
    }

    #[test]
    fn fail_closed_requires_an_accepting_device() {
        let conn = conn();
        let outcome = dispatch(&conn, &[1u8; 32], &row(), "chain");
        assert_eq!(outcome, DispatchOutcome::default());
        assert!(permits(outcome, false));
        assert!(!permits(outcome, true));
        // The parent "directory" is a regular file, so the write fails.
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let mut broken = file_device(dir.path(), DEFAULT_MAX_BYTES);
        broken.id = "broken".into();
        broken.options["path"] = json!(blocker.join("audit.jsonl").to_string_lossy());
        put(&conn, &broken).unwrap();
        let outcome = dispatch(&conn, &[1u8; 32], &row(), "chain");
        assert_eq!(
            outcome,
            DispatchOutcome {
                enabled: 1,
                accepted: 0,
                durable: 0,
            }
        );
        assert!(!permits(outcome, true));
        assert!(health("broken").failing);
    }

    #[tokio::test]
    async fn background_devices_never_satisfy_fail_closed() {
        let conn = conn();
        put(
            &conn,
            &AuditDevice {
                id: "siem-down".into(),
                kind: DeviceKind::Http,
                enabled: true,
                description: String::new(),
                hmac_fields: true,
                options: json!({ "url": "http://127.0.0.1:9/ingest" }),
                source: "api".into(),
            },
        )
        .unwrap();
        let outcome = dispatch(&conn, &[1u8; 32], &row(), "chain");
        assert_eq!(outcome.enabled, 1);
        assert_eq!(outcome.durable, 0);
        assert!(!permits(outcome, true));
        assert!(permits(outcome, false));
    }

    #[test]
    fn file_devices_are_confined_to_audit_directories() {
        let dir = tempfile::tempdir().unwrap();
        let mut device = file_device(dir.path(), DEFAULT_MAX_BYTES);
        assert!(validate(&device).is_ok());
        for path in [
            "/etc/ryu-audit.jsonl".to_owned(),
            crate::paths::ryu_dir()
                .join("plugin-secrets.db")
                .to_string_lossy()
                .into_owned(),
            format!("{}/sub/../audit.jsonl", dir.path().display()),
        ] {
            device.options["path"] = json!(path);
            assert!(validate(&device).is_err(), "{path}");
        }
        // An existing file that is not an audit log is never appended to or
        // rotated, and a symlink is never followed.
        let foreign = dir.path().join("config.json");
        std::fs::write(&foreign, b"{\"keep\":true}\n").unwrap();
        device.options["path"] = json!(foreign.to_string_lossy());
        assert!(write_file(&device.options, "{}").is_err());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"{\"keep\":true}\n");
        #[cfg(unix)]
        {
            let link = dir.path().join("link.jsonl");
            std::os::unix::fs::symlink(&foreign, &link).unwrap();
            device.options["path"] = json!(link.to_string_lossy());
            assert!(write_file(&device.options, "{}").is_err());
        }
    }

    #[test]
    fn network_targets_reject_credentials_unknown_options_and_metadata() {
        let mut http = AuditDevice {
            id: "siem".into(),
            kind: DeviceKind::Http,
            enabled: true,
            description: String::new(),
            hmac_fields: true,
            options: json!({ "url": "https://user:pass@siem.example/ingest" }),
            source: "api".into(),
        };
        assert!(validate(&http).is_err());
        http.options = json!({ "url": "https://siem.example/ingest?api_key=abc" });
        assert!(validate(&http).is_err());
        http.options = json!({ "url": "https://siem.example/ingest?stream=vault" });
        assert!(validate(&http).is_ok());
        http.options = json!({ "url": "https://siem.example/ingest", "token": "abc" });
        assert!(validate(&http).is_err());
        http.options = json!({ "url": "https://169.254.169.254/latest" });
        assert!(validate(&http).is_err());
        let socket = AuditDevice {
            id: "tcp".into(),
            kind: DeviceKind::Socket,
            enabled: true,
            description: String::new(),
            hmac_fields: true,
            options: json!({ "address": "tcp:169.254.169.254:80" }),
            source: "api".into(),
        };
        assert!(validate(&socket).is_err());
        assert!(target_ip_allowed("127.0.0.1".parse().unwrap()));
        assert!(target_ip_allowed("93.184.216.34".parse().unwrap()));
        assert!(!target_ip_allowed("169.254.169.254".parse().unwrap()));
        assert!(!target_ip_allowed("fe80::1".parse().unwrap()));
    }

    #[test]
    fn disabled_devices_are_skipped_and_deletes_report_existence() {
        let dir = tempfile::tempdir().unwrap();
        let conn = conn();
        let mut device = file_device(dir.path(), DEFAULT_MAX_BYTES);
        device.enabled = false;
        put(&conn, &device).unwrap();
        assert_eq!(dispatch(&conn, &[1u8; 32], &row(), "c").enabled, 0);
        assert!(delete(&conn, "local-file").unwrap());
        assert!(!delete(&conn, "local-file").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn syslog_devices_send_rfc5424_datagrams() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("log.sock");
        let server = std::os::unix::net::UnixDatagram::bind(&socket_path).unwrap();
        let conn = conn();
        put(
            &conn,
            &AuditDevice {
                id: "syslog".into(),
                kind: DeviceKind::Syslog,
                enabled: true,
                description: String::new(),
                hmac_fields: true,
                options: json!({ "address": format!("unix:{}", socket_path.display()) }),
                source: "api".into(),
            },
        )
        .unwrap();
        assert_eq!(dispatch(&conn, &[1u8; 32], &row(), "c").accepted, 1);
        let mut buf = [0u8; 8192];
        let len = server.recv(&mut buf).unwrap();
        let message = std::str::from_utf8(&buf[..len]).unwrap();
        assert!(message.starts_with("<86>1 "), "{message}");
        assert!(message.contains("\"type\":\"vault_audit\""));
    }
}
