//! Payment card items.
//!
//! A `card` item is a typed item with a fixed schema ([`card_fields`]):
//! `cardholder`, the sensitive `number` and `cvc`, `expMonth`/`expYear`, and
//! optional billing fields. Values are validated on write: the number is
//! 12-19 digits after spaces and dashes are stripped and must pass the Luhn
//! check, the CVC is 3-4 digits, and the expiry must not be in the past. The
//! non-sensitive brand (from the IIN range) and last four digits are derived
//! and stored next to the item, so listings and reads show brand, last4, and
//! expiry and never the number or CVC.
//!
//! A card is **merchant-locked**: it carries an allowlist of merchant host
//! patterns (`shop.example.com` or `*.example.com`, the broker's host-pattern
//! grammar) and its fields leave the vault only through
//!
//! * the credential broker, which substitutes `__CARD_<KEY>_<FIELD>__`
//!   placeholders ([`find_placeholders`]) in headers and bodies of HTTPS
//!   requests to an allowlisted host (any other host or plain HTTP leaves the
//!   placeholder untouched and records a blocked use);
//! * `fill`, which needs an allowlisted HTTPS origin; and
//! * the item reveal, for a human holding `read`.
//!
//! Every use also needs a **spend approval** ([`CardApproval`]): the first
//! use files a pending request that a human approves once (a single use) or
//! as a grant for a session or agent subject and the merchant host, with a
//! TTL (default 15 minutes, at most 24 hours) and optional use cap. Every use
//! is audited fail-closed. Events and audit rows carry the item key, the
//! approval id and the outcome; never the number or CVC. Audit and event rows
//! written before encryption at rest phase 2 also carry brand, last4 and the
//! merchant host (the audit log is HMAC-chained, so they are left as written).
//!
//! Encryption at rest: `vault_card_meta` keeps only `brand` and `last4` in
//! plaintext (listings show them without unsealing anything); the merchant
//! allowlist and the expiry copy are one sealed `sealed_meta` value, and the
//! approval's `merchant_host`, `requester`, `agent` and `note` are sealed per
//! value, all as `encb:v1:` under the `plugin-secrets.db` content key and bound
//! to the row id and column. Lookups on those fields filter in Rust after
//! opening. Legacy plaintext is sealed when the store opens.

use std::collections::BTreeMap;

use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    append_event, find_item, normalize_value, not_found, notify_events, FieldDef, FieldType,
    ItemCoords, ItemStatus,
};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::broker::services::{host_matches, is_valid_host_pattern};
use crate::vault::{now_millis, random_token, VaultError};

/// The reserved item kind.
pub const CARD_KIND: &str = "card";
/// Longest card item key (so every placeholder fits the broker grammar).
pub const MAX_CARD_KEY_LEN: usize = 40;
/// Merchant host patterns per card.
pub const MAX_MERCHANTS: usize = 32;
/// Default lifetime of an approval's grant (15 minutes).
pub const DEFAULT_GRANT_TTL_SECS: i64 = 15 * 60;
/// Shortest grant lifetime.
pub const MIN_GRANT_TTL_SECS: i64 = 60;
/// Longest grant lifetime (24 hours).
pub const MAX_GRANT_TTL_SECS: i64 = 24 * 3600;
/// Largest use cap on a grant.
pub const MAX_GRANT_USES: i64 = 10_000;
/// How long a pending approval request waits for a decision (1 hour).
pub const PENDING_TTL_MILLIS: i64 = 3600 * 1000;
/// Pending requests per requesting subject.
pub const MAX_PENDING_PER_REQUESTER: i64 = 10;
const MAX_NOTE_LEN: usize = 1024;
const MAX_FUTURE_YEARS: i32 = 30;

pub const FIELD_CARDHOLDER: &str = "cardholder";
pub const FIELD_NUMBER: &str = "number";
pub const FIELD_EXP_MONTH: &str = "expMonth";
pub const FIELD_EXP_YEAR: &str = "expYear";
pub const FIELD_CVC: &str = "cvc";
const BILLING_FIELDS: [&str; 6] = [
    "postalCode",
    "country",
    "addressLine1",
    "addressLine2",
    "city",
    "region",
];

/// Placeholder suffixes and the field each one stands for.
const PLACEHOLDER_FIELDS: [(&str, &str); 5] = [
    ("NUMBER", FIELD_NUMBER),
    ("CVC", FIELD_CVC),
    ("EXP_MONTH", FIELD_EXP_MONTH),
    ("EXP_YEAR", FIELD_EXP_YEAR),
    ("NAME", FIELD_CARDHOLDER),
];

/// The fixed card schema.
pub fn card_fields() -> Vec<FieldDef> {
    let field = |name: &str, label: &str, field_type, required, sensitive| FieldDef {
        name: name.to_owned(),
        label: Some(label.to_owned()),
        field_type,
        required,
        sensitive,
    };
    let mut fields = vec![
        field(FIELD_CARDHOLDER, "Cardholder", FieldType::Text, true, false),
        field(FIELD_NUMBER, "Card number", FieldType::Password, true, true),
        field(
            FIELD_EXP_MONTH,
            "Expiry month",
            FieldType::Text,
            true,
            false,
        ),
        field(FIELD_EXP_YEAR, "Expiry year", FieldType::Text, true, false),
        field(FIELD_CVC, "Security code", FieldType::Password, false, true),
    ];
    let labels = [
        "Billing postal code",
        "Billing country",
        "Billing address line 1",
        "Billing address line 2",
        "Billing city",
        "Billing region",
    ];
    for (name, label) in BILLING_FIELDS.iter().zip(labels) {
        fields.push(field(name, label, FieldType::Text, false, false));
    }
    fields
}

/// Whether a stored item is a payment card: the reserved kind with the fixed
/// card schema. An item of kind `card` with other fields (created before the
/// kind was reserved) is an ordinary item.
pub fn is_card_item(kind: &str, fields: &[FieldDef]) -> bool {
    kind == CARD_KIND && fields == card_fields().as_slice()
}

/// Fields that leave the vault only through a card approval.
pub fn is_restricted_field(field: &str) -> bool {
    field == FIELD_NUMBER || field == FIELD_CVC
}

/// Card keys are 1-40 letters, digits, `_`, or `-`, with no `__` and no
/// leading or trailing `_`, so `__CARD_<KEY>_<FIELD>__` parses unambiguously.
pub fn is_valid_card_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_CARD_KEY_LEN
        && !key.starts_with('_')
        && !key.ends_with('_')
        && !key.contains("__")
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

/// Whether `digits` passes the Luhn checksum.
pub fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    for (index, byte) in digits.bytes().rev().enumerate() {
        if !byte.is_ascii_digit() {
            return false;
        }
        let mut digit = u32::from(byte - b'0');
        if index % 2 == 1 {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    !digits.is_empty() && sum % 10 == 0
}

/// Strip spaces and dashes and validate a card number: 12-19 digits that
/// pass the Luhn check. Never echoes the value.
pub fn normalize_card_number(value: &str) -> Result<String> {
    let digits: String = value.chars().filter(|c| !matches!(c, ' ' | '-')).collect();
    if !(12..=19).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("field `number` must be 12-19 digits"));
    }
    if !luhn_valid(&digits) {
        return Err(invalid("field `number` fails the card checksum"));
    }
    Ok(digits)
}

fn prefix_in(digits: &str, len: usize, low: u32, high: u32) -> bool {
    digits
        .get(..len)
        .and_then(|prefix| prefix.parse::<u32>().ok())
        .is_some_and(|prefix| (low..=high).contains(&prefix))
}

/// The card brand from its issuer identification number range.
pub fn card_brand(digits: &str) -> &'static str {
    let p = |len, low, high| prefix_in(digits, len, low, high);
    if p(2, 34, 34) || p(2, 37, 37) {
        "amex"
    } else if p(1, 4, 4) {
        "visa"
    } else if p(2, 51, 55) || p(4, 2221, 2720) {
        "mastercard"
    } else if p(4, 6011, 6011) || p(3, 644, 649) || p(2, 65, 65) || p(6, 622_126, 622_925) {
        "discover"
    } else if p(4, 3528, 3589) {
        "jcb"
    } else if p(3, 300, 305) || p(4, 3095, 3095) || p(2, 36, 36) || p(2, 38, 39) {
        "diners"
    } else if p(2, 62, 62) || p(2, 81, 81) {
        "unionpay"
    } else {
        "unknown"
    }
}

/// The last four digits of a normalized number.
pub fn last4(digits: &str) -> String {
    digits[digits.len().saturating_sub(4)..].to_owned()
}

/// Validate and normalize one card field value.
pub fn normalize_card_value(field: &FieldDef, value: &str) -> Result<String> {
    let trimmed = value.trim();
    match field.name.as_str() {
        FIELD_NUMBER => normalize_card_number(value),
        FIELD_CVC => {
            if (3..=4).contains(&trimmed.len()) && trimmed.bytes().all(|b| b.is_ascii_digit()) {
                Ok(trimmed.to_owned())
            } else {
                Err(invalid("field `cvc` must be 3 or 4 digits"))
            }
        }
        FIELD_EXP_MONTH => trimmed
            .parse::<u32>()
            .ok()
            .filter(|month| trimmed.len() <= 2 && (1..=12).contains(month))
            .map(|month| format!("{month:02}"))
            .ok_or_else(|| invalid("field `expMonth` must be 1-12")),
        FIELD_EXP_YEAR => {
            let year = trimmed
                .parse::<i32>()
                .ok()
                .filter(|_| trimmed.bytes().all(|b| b.is_ascii_digit()));
            match (trimmed.len(), year) {
                (2, Some(year)) => Ok(format!("{}", 2000 + year)),
                (4, Some(year)) if (2000..=2099).contains(&year) => Ok(format!("{year}")),
                _ => Err(invalid("field `expYear` must be YY or YYYY")),
            }
        }
        "country" => {
            if trimmed.len() == 2 && trimmed.bytes().all(|b| b.is_ascii_alphabetic()) {
                Ok(trimmed.to_ascii_uppercase())
            } else {
                Err(invalid(
                    "field `country` must be a two-letter ISO 3166 code",
                ))
            }
        }
        _ => {
            let normalized = normalize_value(field, trimmed)?;
            if normalized.chars().count() > 256 {
                return Err(invalid(format!(
                    "field `{}` exceeds 256 characters",
                    field.name
                )));
            }
            Ok(normalized)
        }
    }
}

/// The current UTC `(year, month)`.
fn current_year_month(now_millis: i64) -> (i32, u32) {
    use chrono::Datelike as _;
    let now = chrono::DateTime::from_timestamp_millis(now_millis).unwrap_or_default();
    (now.year(), now.month())
}

/// Whether a card with this expiry is past its last valid month.
pub fn is_expired(exp_month: &str, exp_year: &str, now_millis: i64) -> bool {
    let (Ok(month), Ok(year)) = (exp_month.parse::<u32>(), exp_year.parse::<i32>()) else {
        return false;
    };
    let (current_year, current_month) = current_year_month(now_millis);
    (year, month) < (current_year, current_month)
}

/// A new expiry must not be in the past nor implausibly far ahead.
pub fn check_new_expiry(exp_month: &str, exp_year: &str, now_millis: i64) -> Result<()> {
    if is_expired(exp_month, exp_year, now_millis) {
        return Err(invalid("the card expiry is in the past"));
    }
    let (current_year, _) = current_year_month(now_millis);
    if exp_year
        .parse::<i32>()
        .is_ok_and(|year| year > current_year + MAX_FUTURE_YEARS)
    {
        return Err(invalid("the card expiry is too far in the future"));
    }
    Ok(())
}

/// Validate and normalize a merchant allowlist (sorted, deduplicated).
pub fn normalize_merchants(merchants: &[String]) -> Result<Vec<String>> {
    if merchants.len() > MAX_MERCHANTS {
        return Err(invalid(format!(
            "a card allows at most {MAX_MERCHANTS} merchant hosts"
        )));
    }
    let mut out = Vec::with_capacity(merchants.len());
    for merchant in merchants {
        let host = merchant.trim().trim_end_matches('.').to_ascii_lowercase();
        if !is_valid_host_pattern(&host) {
            return Err(invalid(format!(
                "invalid merchant host `{merchant}` (a host name or `*.example.com`)"
            )));
        }
        out.push(host);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Whether any of `merchants` covers `host`.
pub fn merchant_allows(merchants: &[String], host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    merchants.iter().any(|pattern| host_matches(pattern, &host))
}

// ── Placeholders ─────────────────────────────────────────────────────────

/// One `__CARD_<KEY>_<FIELD>__` placeholder found in a request.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CardPlaceholder {
    /// The whole token, underscores included.
    pub token: String,
    pub key: String,
    /// The item field it stands for.
    pub field: &'static str,
}

/// Parse one placeholder token (`__CARD_visa_NUMBER__`).
pub fn parse_placeholder(token: &str) -> Option<CardPlaceholder> {
    let inner = token.strip_prefix("__")?.strip_suffix("__")?;
    let rest = inner.strip_prefix("CARD_")?;
    PLACEHOLDER_FIELDS.iter().find_map(|(suffix, field)| {
        let key = rest.strip_suffix(suffix)?.strip_suffix('_')?;
        is_valid_card_key(key).then(|| CardPlaceholder {
            token: token.to_owned(),
            key: key.to_owned(),
            field,
        })
    })
}

/// Every card placeholder in `text`, appended to `out`.
pub fn find_placeholders(text: &str, out: &mut Vec<CardPlaceholder>) {
    let mut from = 0;
    while let Some(offset) = text[from..].find("__CARD_") {
        let start = from + offset;
        let body = start + 2;
        let Some(end) = text[body..].find("__").map(|end| body + end) else {
            return;
        };
        if let Some(found) = parse_placeholder(&text[start..end + 2]) {
            if !out.contains(&found) {
                out.push(found);
            }
            from = end + 2;
        } else {
            from = start + 2;
        }
    }
}

/// The placeholder token for one card field.
pub fn placeholder_for(key: &str, field: &str) -> Option<String> {
    PLACEHOLDER_FIELDS
        .iter()
        .find(|(_, name)| *name == field)
        .map(|(suffix, _)| format!("__CARD_{key}_{suffix}__"))
}

// ── Stored card metadata ─────────────────────────────────────────────────

/// Non-sensitive card metadata shown in reads and listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_month: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_year: Option<String>,
    pub expired: bool,
    pub merchants: Vec<String>,
    /// The broker placeholders for this card.
    pub placeholders: BTreeMap<String, String>,
}

/// A card the broker can substitute in one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardBinding {
    pub coords: ItemCoords,
    pub merchants: Vec<String>,
}

impl CardBinding {
    pub fn allows(&self, host: &str) -> bool {
        merchant_allows(&self.merchants, host)
    }
}

/// Create the card tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_card_meta (
             item_id     TEXT PRIMARY KEY,
             environment TEXT NOT NULL,
             path        TEXT NOT NULL,
             item_key    TEXT NOT NULL,
             brand       TEXT,
             last4       TEXT,
             sealed_meta TEXT,
             updated_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS vault_card_meta_environment
             ON vault_card_meta (environment, item_key);
         CREATE TABLE IF NOT EXISTS vault_card_approvals (
             id                 TEXT PRIMARY KEY,
             item_id            TEXT NOT NULL,
             environment        TEXT NOT NULL,
             path               TEXT NOT NULL,
             item_key           TEXT NOT NULL,
             brand              TEXT,
             last4              TEXT,
             channel            TEXT NOT NULL,
             merchant_host      TEXT NOT NULL,
             requester          TEXT NOT NULL,
             agent              TEXT NOT NULL,
             status             TEXT NOT NULL,
             mode               TEXT,
             grant_subject      TEXT,
             max_uses           INTEGER,
             uses               INTEGER NOT NULL DEFAULT 0,
             requested_at       INTEGER NOT NULL,
             request_expires_at INTEGER NOT NULL,
             decided_by         TEXT,
             decided_at         INTEGER,
             grant_expires_at   INTEGER,
             note               TEXT NOT NULL DEFAULT '',
             field              TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS vault_card_approvals_item
             ON vault_card_approvals (item_id, status);",
    )
    .context("initializing vault card schema")?;
    let has_field = conn
        .prepare("SELECT 1 FROM pragma_table_info('vault_card_approvals') WHERE name = 'field'")?
        .exists([])?;
    if !has_field {
        conn.execute_batch(
            "ALTER TABLE vault_card_approvals ADD COLUMN field TEXT NOT NULL DEFAULT '';",
        )
        .context("adding vault card approval field")?;
    }
    seal_legacy_card_rows(conn)?;
    Ok(())
}

// ── Encryption at rest ───────────────────────────────────────────────────

/// Registered content-store name (KDF input; never rename).
pub const CARD_STORE: &str = "plugin-secrets.db";
const META_PURPOSE: &str = "vault_card_meta.sealed_meta";
const SEALED_APPROVAL_COLUMNS: [&str; 4] = ["merchant_host", "requester", "agent", "note"];
/// `grant_subject` stores which of the row's own (sealed) subjects a grant
/// binds to, never the subject itself: the value is resolved from the opened
/// `requester` or `agent` column when the row is read.
const GRANT_SUBJECT_REQUESTER: &str = "requester";
const GRANT_SUBJECT_AGENT: &str = "agent";

/// The stored `grant_subject` marker for `subject` of an approval (the
/// requester wins when both are the same subject).
fn grant_subject_marker(subject: &str, requester: &str, agent: &str) -> Option<&'static str> {
    if subject == requester {
        Some(GRANT_SUBJECT_REQUESTER)
    } else if subject == agent {
        Some(GRANT_SUBJECT_AGENT)
    } else {
        None
    }
}

/// The subject a stored `grant_subject` names, given the row's opened subjects.
fn resolve_grant_subject(stored: Option<String>, requester: &str, agent: &str) -> Option<String> {
    match stored.as_deref() {
        Some(GRANT_SUBJECT_REQUESTER) => Some(requester.to_owned()),
        Some(GRANT_SUBJECT_AGENT) => Some(agent.to_owned()),
        // A row an older build approved, not yet migrated.
        _ => stored,
    }
}

/// The content cipher for card metadata, resolved once per process.
fn card_cipher() -> Result<&'static ContentCipher> {
    static CIPHER: OnceLock<ContentCipher> = OnceLock::new();
    if let Some(cipher) = CIPHER.get() {
        return Ok(cipher);
    }
    crate::crypto_host::install();
    let cipher =
        ryu_crypto::content_cipher(CARD_STORE).context("resolving the card metadata key")?;
    Ok(CIPHER.get_or_init(|| cipher))
}

fn approval_context(column: &str, id: &str) -> ContentContext {
    ContentContext::for_id(format!("vault_card_approvals.{column}"), id)
}

/// Seal one approval value (an empty string stays empty: nothing to protect).
fn seal_approval_value(column: &str, id: &str, value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    card_cipher()?.seal_text(value, &approval_context(column, id))
}

fn open_approval_value(column: &str, id: &str, stored: &str) -> Result<String> {
    Ok(card_cipher()?
        .open_text(stored, &approval_context(column, id))?
        .value)
}

/// The sealed part of a card's metadata.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SealedMeta {
    #[serde(default)]
    merchants: Vec<String>,
    #[serde(default)]
    exp_month: Option<String>,
    #[serde(default)]
    exp_year: Option<String>,
}

fn seal_meta(item_id: &str, meta: &SealedMeta) -> Result<String> {
    seal_meta_with(card_cipher()?, item_id, meta)
}

fn seal_meta_with(cipher: &ContentCipher, item_id: &str, meta: &SealedMeta) -> Result<String> {
    cipher.seal_text(
        &serde_json::to_string(meta)?,
        &ContentContext::for_id(META_PURPOSE, item_id),
    )
}

fn open_meta(item_id: &str, stored: Option<&str>) -> Result<SealedMeta> {
    let Some(stored) = stored else {
        return Ok(SealedMeta::default());
    };
    let json = card_cipher()?
        .open_text(stored, &ContentContext::for_id(META_PURPOSE, item_id))
        .context("opening card metadata")?
        .value;
    serde_json::from_str(&json).context("decoding card metadata")
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
        ))?
        .exists(params![column])?)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
        .exists(params![table])?)
}

/// Seal card metadata an older build stored in plaintext, in one transaction:
/// the merchant allowlist and expiry move into `sealed_meta` and their
/// plaintext columns are dropped; approval hosts, subjects and notes are sealed
/// in place (compare-and-swap), and a plaintext `grant_subject` becomes the
/// marker of the subject column it names. Every sealed value is walked on each
/// open, so values sealed under a retired master key are resealed under the
/// current one too. Idempotent; returns how many values it rewrote (`0` once
/// done). `secure_delete` is turned on for this connection first, so every
/// rewritten cell is zeroed. Before any rewrite (and on the first open by a
/// sealing build) the store is marked `vacuum_pending` in the same savepoint;
/// the caller scrubs freed pages and the pre-upgrade `.bak` copies while
/// [`card_scrub_owed`] reports the debt.
pub fn seal_legacy_card_rows(conn: &Connection) -> Result<u64> {
    if !has_table(conn, "vault_card_meta")? {
        return Ok(0);
    }
    seal_legacy_card_rows_with(conn, card_cipher()?)
}

/// [`seal_legacy_card_rows`] under an explicit content cipher.
fn seal_legacy_card_rows_with(conn: &Connection, cipher: &ContentCipher) -> Result<u64> {
    if !has_table(conn, "vault_card_meta")? {
        return Ok(0);
    }
    ryu_crypto::content_sqlite::enable_secure_delete(conn)?;
    // A savepoint, not a transaction: the schema migration may already hold
    // one (this runs from `init_schema` too).
    conn.execute_batch("SAVEPOINT seal_card_rows")?;
    match seal_card_rows_in(conn, cipher) {
        Ok(sealed) => {
            conn.execute_batch("RELEASE seal_card_rows")?;
            Ok(sealed)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO seal_card_rows; RELEASE seal_card_rows");
            Err(error)
        }
    }
}

/// Record that `plugin-secrets.db` owes a freelist scrub and vacuum, before any
/// cell is rewritten: the state row commits with the rewrite, so a crash after
/// the commit still leaves the debt for [`card_scrub_owed`] at the next open.
/// Keeps an existing `vacuum_pending` row (and its retry time) as it is.
fn mark_card_scrub_owed(conn: &Connection) -> Result<()> {
    use ryu_crypto::content_sqlite::{ensure_state_table, states, STATE_TABLE, STORE_ITEM};
    ensure_state_table(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {STATE_TABLE} (store, item, state, cursor, updated_at)
             VALUES (?1, ?2, ?3, NULL, strftime('%s', 'now'))
             ON CONFLICT(store, item) DO UPDATE SET state = excluded.state,
                cursor = NULL, updated_at = excluded.updated_at
             WHERE {STATE_TABLE}.state != excluded.state"
        ),
        params![CARD_STORE, STORE_ITEM, states::VACUUM_PENDING],
    )
    .context("recording the card metadata scrub")?;
    Ok(())
}

/// Whether `plugin-secrets.db` still owes the scrub [`seal_legacy_card_rows`]
/// recorded (a crash or a blocked checkpoint left it undone).
pub fn card_scrub_owed(conn: &Connection) -> Result<bool> {
    Ok(
        ryu_crypto::content_sqlite::read_store_record(conn, CARD_STORE)?.is_some_and(|record| {
            record.state == ryu_crypto::content_sqlite::states::VACUUM_PENDING
        }),
    )
}

fn seal_card_rows_in(tx: &Connection, cipher: &ContentCipher) -> Result<u64> {
    // The first open by a sealing build owes one scrub even when no live row is
    // legacy: older builds ran without secure_delete, so deleted or rewritten
    // card rows can still sit in free pages as plaintext.
    if ryu_crypto::content_sqlite::read_store_record(tx, CARD_STORE)?.is_none() {
        mark_card_scrub_owed(tx)?;
    }
    let legacy_meta = has_column(tx, "vault_card_meta", "merchants")?;
    let mut sealed = 0u64;
    if !has_column(tx, "vault_card_meta", "sealed_meta")? {
        tx.execute_batch("ALTER TABLE vault_card_meta ADD COLUMN sealed_meta TEXT")?;
    }
    if legacy_meta {
        mark_card_scrub_owed(tx)?;
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT item_id, merchants, exp_month, exp_year FROM vault_card_meta
                 WHERE sealed_meta IS NULL",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (item_id, merchants, exp_month, exp_year) in rows {
            let meta = SealedMeta {
                merchants: merchants
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default(),
                exp_month,
                exp_year,
            };
            tx.execute(
                "UPDATE vault_card_meta SET sealed_meta = ?2 WHERE item_id = ?1",
                params![item_id, seal_meta_with(cipher, &item_id, &meta)?],
            )?;
            sealed += 1;
        }
        // Every row now carries its sealed copy, so the plaintext columns go.
        tx.execute_batch(
            "ALTER TABLE vault_card_meta DROP COLUMN exp_month;
             ALTER TABLE vault_card_meta DROP COLUMN exp_year;
             ALTER TABLE vault_card_meta DROP COLUMN merchants;",
        )?;
        sealed += 1;
    }
    sealed += reseal_card_meta(tx, cipher)?;
    if !has_table(tx, "vault_card_approvals")? {
        return Ok(sealed);
    }
    Ok(sealed + seal_card_approvals(tx, cipher)?)
}

/// Reseal every `sealed_meta` value that opens only under a retired key (or is
/// not sealed at all). A value that does not open is left as it is.
fn reseal_card_meta(tx: &Connection, cipher: &ContentCipher) -> Result<u64> {
    let rows = {
        let mut stmt = tx.prepare(
            "SELECT item_id, sealed_meta FROM vault_card_meta WHERE sealed_meta IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut resealed = 0u64;
    for (item_id, stored) in rows {
        let context = ContentContext::for_id(META_PURPOSE, &item_id);
        let Ok(opened) = cipher.open_text(&stored, &context) else {
            continue;
        };
        if !opened.needs_reseal {
            continue;
        }
        if resealed == 0 {
            mark_card_scrub_owed(tx)?;
        }
        resealed += tx.execute(
            "UPDATE vault_card_meta SET sealed_meta = ?1 WHERE item_id = ?2 AND sealed_meta = ?3",
            params![cipher.seal_text(&opened.value, &context)?, item_id, stored],
        )? as u64;
    }
    Ok(resealed)
}

/// Seal (or reseal under the current key) every approval host, subject and
/// note, and replace a plaintext `grant_subject` with the marker of the
/// subject column it names (`NULL` when the row's subjects do not open: such
/// a row can never match a use). Compare-and-swap per value.
fn seal_card_approvals(tx: &Connection, cipher: &ContentCipher) -> Result<u64> {
    let rows = {
        let mut stmt = tx.prepare(
            "SELECT id, merchant_host, requester, agent, note, grant_subject
             FROM vault_card_approvals",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                [
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ],
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut rewritten = 0u64;
    let mut marked = false;
    let mut mark = |tx: &Connection| -> Result<()> {
        if !marked {
            mark_card_scrub_owed(tx)?;
            marked = true;
        }
        Ok(())
    };
    for (id, values, grant_subject) in rows {
        let mut opened_subjects: [Option<String>; 2] = [None, None];
        for (column, stored) in SEALED_APPROVAL_COLUMNS.iter().zip(values) {
            let context = approval_context(column, &id);
            let Ok(opened) = cipher.open_text(&stored, &context) else {
                continue;
            };
            match *column {
                "requester" => opened_subjects[0] = Some(opened.value.clone()),
                "agent" => opened_subjects[1] = Some(opened.value.clone()),
                _ => {}
            }
            // An empty value opens as itself and never needs a reseal.
            if !opened.needs_reseal {
                continue;
            }
            mark(tx)?;
            rewritten += tx.execute(
                &format!(
                    "UPDATE vault_card_approvals SET {column} = ?1 WHERE id = ?2 AND {column} = ?3"
                ),
                params![cipher.seal_text(&opened.value, &context)?, id, stored],
            )? as u64;
        }
        let Some(subject) = grant_subject else {
            continue;
        };
        if subject == GRANT_SUBJECT_REQUESTER || subject == GRANT_SUBJECT_AGENT {
            continue;
        }
        let marker = match &opened_subjects {
            [Some(requester), Some(agent)] => grant_subject_marker(&subject, requester, agent),
            _ => None,
        };
        mark(tx)?;
        rewritten += tx.execute(
            "UPDATE vault_card_approvals SET grant_subject = ?1
             WHERE id = ?2 AND grant_subject = ?3",
            params![marker, id, subject],
        )? as u64;
    }
    Ok(rewritten)
}

/// Delete `plugin-secrets.db.v<N>.bak` rollback copies (written before a
/// schema upgrade) that still hold plaintext card metadata, once the live
/// database has been sealed. Other backups are left alone.
pub fn remove_plaintext_card_backups(db_path: &std::path::Path) {
    let (Some(dir), Some(name)) = (db_path.parent(), db_path.file_name()) else {
        return;
    };
    let prefix = format!("{}.v", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().to_string();
        if !(file.starts_with(&prefix) && file.ends_with(".bak")) {
            continue;
        }
        let path = entry.path();
        let holds_cards = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
        .and_then(|backup| {
            backup
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM vault_card_meta)
                          + (SELECT COUNT(*) FROM vault_card_approvals)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .ok()
        })
        .is_some_and(|rows| rows > 0);
        if holds_cards {
            match std::fs::remove_file(&path) {
                Ok(()) => tracing::info!(
                    backup = %file,
                    "removed a pre-upgrade vault backup that held plaintext card metadata"
                ),
                Err(error) => {
                    tracing::warn!(backup = %file, %error, "could not remove a vault backup")
                }
            }
        }
    }
}

struct MetaRow {
    brand: Option<String>,
    last4: Option<String>,
    exp_month: Option<String>,
    exp_year: Option<String>,
    merchants: Vec<String>,
}

fn load_meta(conn: &Connection, item_id: &str) -> Result<Option<MetaRow>> {
    let row = conn
        .query_row(
            "SELECT brand, last4, sealed_meta FROM vault_card_meta WHERE item_id = ?1",
            params![item_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((brand, last4, sealed)) = row else {
        return Ok(None);
    };
    let meta = open_meta(item_id, sealed.as_deref())?;
    Ok(Some(MetaRow {
        brand,
        last4,
        exp_month: meta.exp_month,
        exp_year: meta.exp_year,
        merchants: meta.merchants,
    }))
}

impl MetaRow {
    fn expired(&self, now: i64) -> bool {
        match (&self.exp_month, &self.exp_year) {
            (Some(month), Some(year)) => is_expired(month, year, now),
            _ => false,
        }
    }

    fn summary(&self, key: &str) -> CardSummary {
        let placeholders = PLACEHOLDER_FIELDS
            .iter()
            .filter_map(|(_, field)| {
                placeholder_for(key, field).map(|token| ((*field).to_owned(), token))
            })
            .collect();
        CardSummary {
            brand: self.brand.clone(),
            last4: self.last4.clone(),
            exp_month: self.exp_month.clone(),
            exp_year: self.exp_year.clone(),
            expired: self.expired(now_millis()),
            merchants: self.merchants.clone(),
            placeholders,
        }
    }
}

/// The card summary of one item, if it is a card.
pub(super) fn summary_locked(
    conn: &Connection,
    item_id: &str,
    key: &str,
) -> Result<Option<CardSummary>> {
    Ok(load_meta(conn, item_id)?.map(|meta| meta.summary(key)))
}

/// Card summaries by item id for listings.
pub(super) fn summaries_locked(conn: &Connection) -> Result<BTreeMap<String, CardSummary>> {
    let mut stmt = conn.prepare("SELECT item_id, item_key FROM vault_card_meta")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = BTreeMap::new();
    let mut unreadable = 0u64;
    for row in rows {
        let (id, key) = row?;
        match summary_locked(conn, &id, &key) {
            Ok(Some(summary)) => {
                out.insert(id, summary);
            }
            Ok(None) => {}
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        tracing::warn!(
            store = CARD_STORE,
            unreadable,
            "card summaries skipped metadata that does not open"
        );
    }
    Ok(out)
}

/// Cards in `environment`, for the broker (a card with no merchant hosts is
/// included so a use of it is recorded as blocked).
pub fn bindings_locked(conn: &Connection, environment: &str) -> Result<Vec<CardBinding>> {
    let mut stmt = conn.prepare(
        "SELECT environment, path, item_key, item_id, sealed_meta FROM vault_card_meta
         WHERE environment = ?1 ORDER BY path, item_key",
    )?;
    let rows = stmt.query_map(params![environment], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (environment, path, key, item_id, sealed) = row?;
        // A card whose metadata does not open keeps an empty allowlist, so a
        // use of it is recorded as blocked rather than released.
        let merchants = match open_meta(&item_id, sealed.as_deref()) {
            Ok(meta) => meta.merchants,
            Err(error) => {
                tracing::warn!(store = CARD_STORE, %error, "card metadata does not open");
                Vec::new()
            }
        };
        out.push(CardBinding {
            coords: ItemCoords {
                environment,
                path,
                key,
            },
            merchants,
        });
    }
    Ok(out)
}

/// Drop a deleted card's metadata and end its pending requests and grants.
pub(super) fn forget_locked(conn: &Connection, item_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_card_meta WHERE item_id = ?1",
        params![item_id],
    )?;
    conn.execute(
        "UPDATE vault_card_approvals SET status = 'revoked', decided_at = ?2
         WHERE item_id = ?1 AND status IN ('pending', 'approved')",
        params![item_id, now_millis()],
    )?;
    Ok(())
}

// ── Approvals ────────────────────────────────────────────────────────────

/// How a card is being used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardChannel {
    /// Placeholder substitution by the credential broker.
    Broker,
    /// `POST /api/vault/items/{key}/fill` for an HTTPS origin.
    Fill,
    /// A human revealing the number or CVC.
    Reveal,
}

impl CardChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Broker => "broker",
            Self::Fill => "fill",
            Self::Reveal => "reveal",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "broker" => Self::Broker,
            "fill" => Self::Fill,
            _ => Self::Reveal,
        }
    }
}

/// Approval lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    /// An active grant (or an unused single-use approval).
    Approved,
    Rejected,
    /// A pending request nobody decided in time, or a grant past its TTL.
    Expired,
    /// A grant whose uses ran out.
    Consumed,
    /// A grant a human revoked, or the card was deleted.
    Revoked,
}

impl ApprovalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::Consumed => "consumed",
            Self::Revoked => "revoked",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            "consumed" => Self::Consumed,
            "revoked" => Self::Revoked,
            _ => Self::Pending,
        }
    }
}

/// How an approval is granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    /// One use by the requesting subject at the merchant host.
    #[default]
    Once,
    /// Uses by a subject at the merchant host until the TTL or use cap.
    Grant,
}

/// Who a grant covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GrantSubject {
    /// The requesting broker session (or human caller).
    #[default]
    Session,
    /// The agent behind it: the minting machine identity, or the human who
    /// minted the session.
    Agent,
}

/// A human's decision.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveInput {
    #[serde(default)]
    pub mode: ApprovalMode,
    #[serde(default)]
    pub subject: GrantSubject,
    /// Grant lifetime (60 s to 24 h, default 15 minutes).
    #[serde(default)]
    pub ttl_secs: Option<i64>,
    /// Use cap for a grant (`once` is always one use).
    #[serde(default)]
    pub max_uses: Option<i64>,
    #[serde(default)]
    pub note: Option<String>,
}

/// A stored approval request or grant. Never carries a card value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardApproval {
    pub id: String,
    pub item_id: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last4: Option<String>,
    pub channel: CardChannel,
    /// Empty for a reveal.
    pub merchant_host: String,
    /// The field a reveal asks for (`number` or `cvc`); empty otherwise.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub field: String,
    /// `broker_session:<id>`, `user:<id>`, or `operator`.
    pub requester: String,
    /// `machine:<id>`, `user:<id>`, or `operator`.
    pub agent: String,
    pub status: ApprovalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<ApprovalMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub requested_at: i64,
    pub request_expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl CardApproval {
    /// The item coordinates the approval belongs to.
    pub fn coords(&self) -> ItemCoords {
        ItemCoords {
            environment: self.environment.clone(),
            path: self.path.clone(),
            key: self.key.clone(),
        }
    }

    /// Where a human approves it.
    pub fn approve_path(&self) -> String {
        format!("/api/vault/cards/approvals/{}/approve", self.id)
    }

    /// Where an agent polls it.
    pub fn agent_status_path(&self) -> String {
        format!("/api/vault/agent/cards/approvals/{}", self.id)
    }
}

const APPROVAL_COLUMNS: &str = "id, item_id, environment, path, item_key, brand, last4, channel,
     merchant_host, requester, agent, status, mode, grant_subject, max_uses, uses, requested_at,
     request_expires_at, decided_by, decided_at, grant_expires_at, note, field";

fn row_to_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardApproval> {
    let mode: Option<String> = row.get(12)?;
    let id: String = row.get(0)?;
    let open = |index: usize, column: &str| -> rusqlite::Result<String> {
        let stored: String = row.get(index)?;
        open_approval_value(column, &id, &stored).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                format!("{error:#}").into(),
            )
        })
    };
    let merchant_host = open(8, "merchant_host")?;
    let requester = open(9, "requester")?;
    let agent = open(10, "agent")?;
    let note = open(21, "note")?;
    let grant_subject = resolve_grant_subject(row.get(13)?, &requester, &agent);
    Ok(CardApproval {
        id: id.clone(),
        item_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        key: row.get(4)?,
        brand: row.get(5)?,
        last4: row.get(6)?,
        channel: CardChannel::parse(&row.get::<_, String>(7)?),
        merchant_host,
        requester,
        agent,
        status: ApprovalStatus::parse(&row.get::<_, String>(11)?),
        mode: mode.map(|mode| {
            if mode == "grant" {
                ApprovalMode::Grant
            } else {
                ApprovalMode::Once
            }
        }),
        grant_subject,
        max_uses: row.get(14)?,
        uses: row.get(15)?,
        requested_at: row.get(16)?,
        request_expires_at: row.get(17)?,
        decided_by: row.get(18)?,
        decided_at: row.get(19)?,
        grant_expires_at: row.get(20)?,
        note,
        field: row.get(22)?,
    })
}

/// Mark undecided requests and grants past their time as expired.
pub fn expire(conn: &Connection, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE vault_card_approvals SET status = 'expired'
         WHERE (status = 'pending' AND request_expires_at <= ?1)
            OR (status = 'approved' AND grant_expires_at <= ?1)",
        params![now],
    )?;
    Ok(())
}

/// One approval by id.
pub fn get(conn: &Connection, id: &str) -> Result<Option<CardApproval>> {
    expire(conn, now_millis())?;
    conn.query_row(
        &format!("SELECT {APPROVAL_COLUMNS} FROM vault_card_approvals WHERE id = ?1"),
        params![id],
        row_to_approval,
    )
    .optional()
    .map_err(Into::into)
}

/// Approvals, newest first, optionally by status and environment.
pub fn list(
    conn: &Connection,
    status: Option<ApprovalStatus>,
    environment: Option<&str>,
) -> Result<Vec<CardApproval>> {
    expire(conn, now_millis())?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {APPROVAL_COLUMNS} FROM vault_card_approvals
         WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR environment = ?2)
         ORDER BY requested_at DESC LIMIT 500"
    ))?;
    let rows = stmt.query_map(
        params![status.map(ApprovalStatus::as_str), environment],
        row_to_approval,
    )?;
    let mut out = Vec::new();
    let mut unreadable = 0u64;
    for row in rows {
        match row {
            Ok(approval) => out.push(approval),
            Err(rusqlite::Error::FromSqlConversionFailure(..)) => unreadable += 1,
            Err(error) => return Err(error.into()),
        }
    }
    if unreadable > 0 {
        tracing::warn!(
            store = CARD_STORE,
            unreadable,
            "card approvals skipped rows that do not open"
        );
    }
    Ok(out)
}

/// Approvals matching `sql` (selecting [`APPROVAL_COLUMNS`]) that open; rows
/// that do not open are skipped (they cannot match a sealed-field filter).
fn approvals_where<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<CardApproval>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, row_to_approval)?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(approval) => out.push(approval),
            Err(rusqlite::Error::FromSqlConversionFailure(..)) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(out)
}

/// A live approval for this use. An approval releases only through the
/// channel (and, for a reveal, the field) it was requested for, so a fill
/// approval never covers a broker substitution and the reverse.
fn find_grant(
    conn: &Connection,
    item_id: &str,
    request: &CardUseRequest,
    host: &str,
    field: &str,
    now: i64,
) -> Result<Option<CardApproval>> {
    // `merchant_host` and the grant's subject are sealed (the stored
    // `grant_subject` only names the subject column): filter them after
    // opening (a card has few live grants), keeping the earliest-expiring match.
    Ok(approvals_where(
        conn,
        &format!(
            "SELECT {APPROVAL_COLUMNS} FROM vault_card_approvals
             WHERE item_id = ?1 AND status = 'approved'
               AND grant_subject IS NOT NULL AND grant_expires_at > ?2
               AND channel = ?3 AND field = ?4
               AND (max_uses IS NULL OR uses < max_uses)
             ORDER BY grant_expires_at"
        ),
        params![item_id, now, request.channel.as_str(), field],
    )?
    .into_iter()
    .find(|approval| {
        approval.merchant_host == host
            && approval
                .grant_subject
                .as_deref()
                .is_some_and(|subject| subject == request.requester || subject == request.agent)
    }))
}

fn consume(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE vault_card_approvals SET uses = uses + 1,
             status = CASE WHEN max_uses IS NOT NULL AND uses + 1 >= max_uses
                           THEN 'consumed' ELSE status END
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// What one use asks for.
#[derive(Debug, Clone)]
pub struct CardUseRequest {
    pub coords: ItemCoords,
    pub channel: CardChannel,
    /// The merchant host (lowercase); empty for a reveal.
    pub merchant_host: String,
    /// The subject a single-use approval and a `session` grant bind to.
    pub requester: String,
    /// The subject an `agent` grant binds to.
    pub agent: String,
    pub actor: AuditActor,
}

/// The result of one use.
#[derive(Debug)]
pub enum CardUseOutcome {
    /// Values by field name, released under an approval.
    Granted {
        values: BTreeMap<String, String>,
        approval_id: String,
        brand: Option<String>,
        last4: Option<String>,
    },
    /// No grant covers this use; a human must decide this request.
    Pending(CardApproval),
    /// The merchant host is not on the card's allowlist (nothing released).
    Blocked(&'static str),
}

fn card_audit(
    actor: &AuditActor,
    action: &str,
    outcome: &str,
    coords: &ItemCoords,
    details: Value,
) -> AuditEntry {
    AuditEntry::new(actor, action, outcome).details(json!({
        "item": coords.key,
        "environment": coords.environment,
        "path": coords.path,
        "details": details,
    }))
}

/// Audit and event details of a card use. Card details (brand, last4, the
/// merchant host) are left out: `vault_audit` and `vault_item_events` are
/// plaintext (the audit log is HMAC-chained, not encrypted), and the approval
/// id links to the sealed approval row that holds them.
fn use_details(_meta: &MetaRow, channel: CardChannel, _host: &str, extra: Value) -> Value {
    let mut details = json!({
        "channel": channel.as_str(),
    });
    if let (Value::Object(map), Value::Object(extra)) = (&mut details, extra) {
        map.extend(extra);
    }
    details
}

/// Whether `decided_by` is approving its own fill or reveal. The unbound
/// local operator (`operator`, the root equivalent that control groups never
/// gate) may confirm its own requests. A broker request comes from an agent
/// session, so the human who minted that session may approve it.
fn is_self_approval(approval: &CardApproval, decided_by: &str) -> bool {
    approval.channel != CardChannel::Broker
        && decided_by != "operator"
        && (decided_by == approval.requester || decided_by == approval.agent)
}

impl PluginSecretStore {
    /// Recompute a card's stored brand, last4, expiry, and (when given)
    /// merchant allowlist from its current values.
    pub(super) fn card_refresh_meta_locked(
        &self,
        conn: &Connection,
        item_id: &str,
        coords: &ItemCoords,
        merchants: Option<&[String]>,
    ) -> Result<()> {
        let number = self.open_value(conn, item_id, FIELD_NUMBER)?;
        let exp_month = self.open_value(conn, item_id, FIELD_EXP_MONTH)?;
        let exp_year = self.open_value(conn, item_id, FIELD_EXP_YEAR)?;
        let merchants = match merchants {
            Some(merchants) => merchants.to_vec(),
            None => load_meta(conn, item_id)?
                .map(|meta| meta.merchants)
                .unwrap_or_default(),
        };
        let sealed = seal_meta(
            item_id,
            &SealedMeta {
                merchants,
                exp_month,
                exp_year,
            },
        )?;
        conn.execute(
            "INSERT INTO vault_card_meta (item_id, environment, path, item_key, brand, last4,
                 sealed_meta, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(item_id) DO UPDATE SET brand = excluded.brand,
                 last4 = excluded.last4, sealed_meta = excluded.sealed_meta,
                 updated_at = excluded.updated_at",
            params![
                item_id,
                coords.environment,
                coords.path,
                coords.key,
                number.as_deref().map(card_brand),
                number.as_deref().map(last4),
                sealed,
                now_millis()
            ],
        )?;
        Ok(())
    }

    /// The stored merchant allowlist of a card item.
    pub(super) fn card_merchants_locked(conn: &Connection, item_id: &str) -> Result<Vec<String>> {
        Ok(load_meta(conn, item_id)?
            .map(|meta| meta.merchants)
            .unwrap_or_default())
    }

    /// Record a refused use (wrong host, plain HTTP, or a denied subject).
    /// Nothing is released, so the audit row is best effort.
    pub async fn card_use_blocked(&self, request: &CardUseRequest, reason: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, &request.coords)?.ok_or_else(|| not_found(&request.coords))?;
        let meta = load_meta(&conn, &row.id)?.ok_or_else(|| not_found(&request.coords))?;
        let details = use_details(
            &meta,
            request.channel,
            &request.merchant_host,
            json!({ "reason": reason }),
        );
        self.audit_locked(
            &conn,
            &card_audit(
                &request.actor,
                "card.use_blocked",
                "denied",
                &request.coords,
                details.clone(),
            ),
        );
        append_event(
            &conn,
            &row.id,
            &request.coords,
            "card_use_blocked",
            row.version,
            &request.actor,
            &details,
        )?;
        drop(conn);
        notify_events();
        Ok(())
    }

    /// Use a card: release its values under a live grant (audited
    /// fail-closed and counted against the grant), or file (or return the
    /// existing) pending approval request. A merchant host outside the
    /// allowlist is [`CardUseOutcome::Blocked`]. `only` limits the released
    /// values to one field.
    pub async fn card_use(
        &self,
        request: &CardUseRequest,
        only: Option<&str>,
    ) -> Result<CardUseOutcome> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let row = find_item(&conn, &request.coords)?.ok_or_else(|| not_found(&request.coords))?;
        if !is_card_item(&row.kind, &row.fields) {
            return Err(invalid(format!(
                "item `{}` is not a card",
                request.coords.policy_key()
            )));
        }
        let meta = load_meta(&conn, &row.id)?.ok_or_else(|| not_found(&request.coords))?;
        let host = request.merchant_host.to_ascii_lowercase();
        // A reveal approval is bound to the field it releases.
        let field = match (request.channel, only) {
            (CardChannel::Reveal, Some(field)) => field.to_owned(),
            (CardChannel::Reveal, None) => {
                return Err(invalid("a card reveal names one field"));
            }
            _ => String::new(),
        };
        if request.channel != CardChannel::Reveal && !merchant_allows(&meta.merchants, &host) {
            drop(conn);
            self.card_use_blocked(request, "merchant_not_allowed")
                .await?;
            return Ok(CardUseOutcome::Blocked("merchant_not_allowed"));
        }
        if row.status != ItemStatus::Ready {
            return Err(VaultError::Conflict(format!(
                "card `{}` is missing required values",
                request.coords.policy_key()
            ))
            .into());
        }
        if meta.expired(now) {
            return Err(VaultError::Conflict(format!(
                "card `{}` is expired",
                request.coords.policy_key()
            ))
            .into());
        }
        expire(&conn, now)?;
        if let Some(grant) = find_grant(&conn, &row.id, request, &host, &field, now)? {
            let details = use_details(
                &meta,
                request.channel,
                &host,
                json!({ "approval": grant.id }),
            );
            if !self.audit_locked(
                &conn,
                &card_audit(
                    &request.actor,
                    "card.use",
                    "ok",
                    &request.coords,
                    details.clone(),
                ),
            ) {
                return Err(VaultError::AuditUnavailable.into());
            }
            consume(&conn, &grant.id)?;
            append_event(
                &conn,
                &row.id,
                &request.coords,
                "card_used",
                row.version,
                &request.actor,
                &details,
            )?;
            let mut values = BTreeMap::new();
            for def in &row.fields {
                if only.is_some_and(|only| only != def.name) {
                    continue;
                }
                if let Some(value) = self.open_value(&conn, &row.id, &def.name)? {
                    values.insert(def.name.clone(), value);
                }
            }
            drop(conn);
            notify_events();
            return Ok(CardUseOutcome::Granted {
                values,
                approval_id: grant.id,
                brand: meta.brand,
                last4: meta.last4,
            });
        }
        let existing = approvals_where(
            &conn,
            &format!(
                "SELECT {APPROVAL_COLUMNS} FROM vault_card_approvals
                 WHERE item_id = ?1 AND channel = ?2 AND field = ?3 AND status = 'pending'
                 ORDER BY requested_at DESC"
            ),
            params![row.id, request.channel.as_str(), field],
        )?
        .into_iter()
        .find(|approval| approval.merchant_host == host && approval.requester == request.requester);
        if let Some(existing) = existing {
            return Ok(CardUseOutcome::Pending(existing));
        }
        let pending = {
            let mut stmt = conn.prepare(
                "SELECT id, requester FROM vault_card_approvals WHERE status = 'pending'",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut count = 0i64;
            for row in rows {
                let (id, stored) = row?;
                // A requester that does not open counts against the cap, so
                // an unreadable row never lifts the limit.
                if open_approval_value("requester", &id, &stored)
                    .map_or(true, |requester| requester == request.requester)
                {
                    count += 1;
                }
            }
            count
        };
        if pending >= MAX_PENDING_PER_REQUESTER {
            return Err(VaultError::Conflict(format!(
                "at most {MAX_PENDING_PER_REQUESTER} pending card approvals per requester"
            ))
            .into());
        }
        let approval = CardApproval {
            id: random_token("cap_"),
            item_id: row.id.clone(),
            environment: request.coords.environment.clone(),
            path: request.coords.path.clone(),
            key: request.coords.key.clone(),
            brand: meta.brand.clone(),
            last4: meta.last4.clone(),
            channel: request.channel,
            merchant_host: host.clone(),
            field: field.clone(),
            requester: request.requester.clone(),
            agent: request.agent.clone(),
            status: ApprovalStatus::Pending,
            mode: None,
            grant_subject: None,
            max_uses: None,
            uses: 0,
            requested_at: now,
            request_expires_at: now + PENDING_TTL_MILLIS,
            decided_by: None,
            decided_at: None,
            grant_expires_at: None,
            note: String::new(),
        };
        conn.execute(
            "INSERT INTO vault_card_approvals (id, item_id, environment, path, item_key, brand,
                 last4, channel, merchant_host, requester, agent, status, requested_at,
                 request_expires_at, field)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14)",
            params![
                approval.id,
                approval.item_id,
                approval.environment,
                approval.path,
                approval.key,
                approval.brand,
                approval.last4,
                approval.channel.as_str(),
                seal_approval_value("merchant_host", &approval.id, &approval.merchant_host)?,
                seal_approval_value("requester", &approval.id, &approval.requester)?,
                seal_approval_value("agent", &approval.id, &approval.agent)?,
                approval.requested_at,
                approval.request_expires_at,
                approval.field
            ],
        )?;
        // The audit and event details carry only the approval id, but their
        // plaintext actor columns (part of the HMAC-chained record) name the
        // requester (and, for reveal and fill, the agent); see the card row
        // in docs/encryption-at-rest.md.
        let mut extra = json!({ "approval": approval.id });
        if !field.is_empty() {
            extra["field"] = json!(field);
        }
        let details = use_details(&meta, request.channel, &host, extra);
        self.audit_locked(
            &conn,
            &card_audit(
                &request.actor,
                "card.approval_request",
                "ok",
                &request.coords,
                details.clone(),
            ),
        );
        append_event(
            &conn,
            &row.id,
            &request.coords,
            "card_approval_requested",
            row.version,
            &request.actor,
            &details,
        )?;
        drop(conn);
        notify_events();
        Ok(CardUseOutcome::Pending(approval))
    }

    /// Give a broker use back to its approval when the request never
    /// reached the merchant (the upstream connection failed), so a
    /// single-use approval or a capped grant is not spent on nothing. The
    /// refund is audited fail-closed before it is stored: without an
    /// accepted audit row the use stays spent. Returns whether a use was
    /// returned.
    pub async fn card_use_refund(
        &self,
        request: &CardUseRequest,
        approval_id: &str,
        reason: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, &request.coords)?.ok_or_else(|| not_found(&request.coords))?;
        let meta = load_meta(&conn, &row.id)?.ok_or_else(|| not_found(&request.coords))?;
        let refundable = conn
            .query_row(
                "SELECT 1 FROM vault_card_approvals
                 WHERE id = ?1 AND item_id = ?2 AND uses > 0
                   AND status IN ('approved', 'consumed')",
                params![approval_id, row.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !refundable {
            return Ok(false);
        }
        let details = use_details(
            &meta,
            request.channel,
            &request.merchant_host.to_ascii_lowercase(),
            json!({ "approval": approval_id, "reason": reason }),
        );
        if !self.audit_locked(
            &conn,
            &card_audit(
                &request.actor,
                "card.use_refund",
                "ok",
                &request.coords,
                details.clone(),
            ),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        conn.execute(
            "UPDATE vault_card_approvals SET uses = uses - 1,
                 status = CASE WHEN status = 'consumed' THEN 'approved' ELSE status END
             WHERE id = ?1 AND uses > 0 AND status IN ('approved', 'consumed')",
            params![approval_id],
        )?;
        append_event(
            &conn,
            &row.id,
            &request.coords,
            "card_use_refunded",
            row.version,
            &request.actor,
            &details,
        )?;
        drop(conn);
        notify_events();
        Ok(true)
    }

    /// Approve a pending request as a single use or a grant.
    pub async fn card_approve(
        &self,
        id: &str,
        input: &ApproveInput,
        actor: &AuditActor,
        decided_by: &str,
    ) -> Result<CardApproval> {
        let ttl = input.ttl_secs.unwrap_or(DEFAULT_GRANT_TTL_SECS);
        if !(MIN_GRANT_TTL_SECS..=MAX_GRANT_TTL_SECS).contains(&ttl) {
            return Err(invalid("ttlSecs must be between 60 and 86400"));
        }
        let note = input.note.as_deref().unwrap_or_default().trim().to_owned();
        if note.len() > MAX_NOTE_LEN {
            return Err(invalid("note is too long"));
        }
        let conn = self.conn.lock().await;
        let approval =
            get(&conn, id)?.ok_or_else(|| VaultError::NotFound(format!("card approval `{id}`")))?;
        if approval.status != ApprovalStatus::Pending {
            return Err(VaultError::Conflict(format!(
                "card approval `{id}` is {}",
                approval.status.as_str()
            ))
            .into());
        }
        if is_self_approval(&approval, decided_by) {
            return Err(VaultError::Denied(
                "requesters cannot approve their own card fill or reveal".into(),
            )
            .into());
        }
        let (grant_subject, max_uses) = match input.mode {
            ApprovalMode::Once => {
                if input.max_uses.is_some_and(|uses| uses != 1) {
                    return Err(invalid("a `once` approval is exactly one use"));
                }
                (GRANT_SUBJECT_REQUESTER, Some(1))
            }
            ApprovalMode::Grant => {
                if approval.channel == CardChannel::Reveal {
                    return Err(invalid("card reveals are approved one at a time (`once`)"));
                }
                if input
                    .max_uses
                    .is_some_and(|uses| !(1..=MAX_GRANT_USES).contains(&uses))
                {
                    return Err(invalid(format!("maxUses must be 1 to {MAX_GRANT_USES}")));
                }
                let subject = match input.subject {
                    GrantSubject::Session => GRANT_SUBJECT_REQUESTER,
                    GrantSubject::Agent => GRANT_SUBJECT_AGENT,
                };
                (subject, input.max_uses)
            }
        };
        let now = now_millis();
        let mode = match input.mode {
            ApprovalMode::Once => "once",
            ApprovalMode::Grant => "grant",
        };
        let coords = approval.coords();
        // Card details (merchant host, brand, last4) and the grant's subject
        // stay in the sealed approval row; the plaintext audit and event rows
        // carry its id and which subject column the grant binds to.
        let details = json!({
            "approval": id,
            "mode": mode,
            "grantSubjectKind": grant_subject,
            "ttlSecs": ttl,
            "maxUses": max_uses,
            "field": approval.field,
        });
        // An approval authorizes spending, so it is audited fail-closed like
        // a use: on the autocommit connection, before the decision is stored
        // (an in-transaction audit cannot report a refusing device).
        if !self.audit_locked(
            &conn,
            &card_audit(
                actor,
                "card.approval_approve",
                "ok",
                &coords,
                details.clone(),
            ),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        let changed = conn.execute(
            "UPDATE vault_card_approvals SET status = 'approved', mode = ?2, grant_subject = ?3,
                 max_uses = ?4, decided_by = ?5, decided_at = ?6, grant_expires_at = ?7, note = ?8
             WHERE id = ?1 AND status = 'pending'",
            params![
                id,
                mode,
                grant_subject,
                max_uses,
                decided_by,
                now,
                now + ttl * 1000,
                seal_approval_value("note", id, &note)?
            ],
        )?;
        if changed == 0 {
            return Err(
                VaultError::Conflict(format!("card approval `{id}` is not pending")).into(),
            );
        }
        if let Some(row) = find_item(&conn, &coords)?.filter(|row| row.id == approval.item_id) {
            append_event(
                &conn,
                &row.id,
                &coords,
                "card_approval_approved",
                row.version,
                actor,
                &details,
            )?;
        }
        let updated =
            get(&conn, id)?.ok_or_else(|| VaultError::NotFound(format!("card approval `{id}`")))?;
        drop(conn);
        notify_events();
        Ok(updated)
    }

    /// Reject a pending request, or revoke an active grant.
    pub async fn card_decline(
        &self,
        id: &str,
        revoke: bool,
        note: Option<&str>,
        actor: &AuditActor,
        decided_by: &str,
    ) -> Result<CardApproval> {
        let note = note.unwrap_or_default().trim().to_owned();
        if note.len() > MAX_NOTE_LEN {
            return Err(invalid("note is too long"));
        }
        let (from, to, action) = if revoke {
            ("approved", "revoked", "card.approval_revoke")
        } else {
            ("pending", "rejected", "card.approval_reject")
        };
        let conn = self.conn.lock().await;
        let approval =
            get(&conn, id)?.ok_or_else(|| VaultError::NotFound(format!("card approval `{id}`")))?;
        let sealed_note = seal_approval_value("note", id, &note)?;
        let changed = conn.execute(
            "UPDATE vault_card_approvals SET status = ?2, decided_by = ?3, decided_at = ?4,
                 note = CASE WHEN ?5 = '' THEN note ELSE ?5 END
             WHERE id = ?1 AND status = ?6",
            params![id, to, decided_by, now_millis(), sealed_note, from],
        )?;
        if changed == 0 {
            return Err(VaultError::Conflict(format!(
                "card approval `{id}` is {}, not {from}",
                approval.status.as_str()
            ))
            .into());
        }
        let coords = approval.coords();
        let details = json!({ "approval": id });
        // A reject or revoke only removes authority, so an audit outage never
        // blocks it; the row is best effort.
        self.audit_locked(
            &conn,
            &card_audit(actor, action, "ok", &coords, details.clone()),
        );
        if let Some(row) = find_item(&conn, &coords)?.filter(|row| row.id == approval.item_id) {
            let name = if revoke {
                "card_approval_revoked"
            } else {
                "card_approval_rejected"
            };
            append_event(&conn, &row.id, &coords, name, row.version, actor, &details)?;
        }
        let updated =
            get(&conn, id)?.ok_or_else(|| VaultError::NotFound(format!("card approval `{id}`")))?;
        drop(conn);
        notify_events();
        Ok(updated)
    }

    /// Card approvals, optionally filtered.
    pub async fn card_approvals(
        &self,
        status: Option<ApprovalStatus>,
        environment: Option<&str>,
    ) -> Result<Vec<CardApproval>> {
        let conn = self.conn.lock().await;
        list(&conn, status, environment)
    }

    /// One card approval.
    pub async fn card_approval(&self, id: &str) -> Result<Option<CardApproval>> {
        let conn = self.conn.lock().await;
        get(&conn, id)
    }

    /// Whether the item at `coords` exists and is a payment card.
    pub async fn item_is_card(&self, coords: &ItemCoords) -> Result<bool> {
        let conn = self.conn.lock().await;
        Ok(find_item(&conn, coords)?.is_some_and(|row| is_card_item(&row.kind, &row.fields)))
    }

    /// Cards the broker may substitute in `environment`.
    pub async fn card_bindings(&self, environment: &str) -> Result<Vec<CardBinding>> {
        let conn = self.conn.lock().await;
        bindings_locked(&conn, environment)
    }
}

#[cfg(test)]
#[path = "cards_tests.rs"]
mod tests;
