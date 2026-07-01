//! Local Core support-access diagnostic channel (P5 / issue #546).
//!
//! No server can reach `~/.ryu` (it lives behind the local cipher), so "support
//! access" to on-device data can only mean: **the local Core itself opens a
//! scoped, audited, time-boxed, read-only diagnostic channel the user explicitly
//! turns on.** This module is the BACKEND for that channel (the desktop UX +
//! transport is #547). It provides:
//!
//!   - the gate decision (reusing [`crate::privacy::SupportAccessLocal`] — the
//!     off-by-default `support-access-local-enabled` pref with a hard
//!     `support-access-local-expiry`), enforced both at startup
//!     ([`sweep_expired`]) and lazily at request time;
//!   - a NARROW, ALLOWLIST diagnostic projection ([`DiagnosticBundle`]) — only
//!     known-safe fields (version, active engine, sidecar names/running, *which*
//!     prefs are set by key, redacted trace spans) are ever included. It is an
//!     allowlist, never a denylist, so a newly-added secret pref/config field can
//!     never leak by accident. It NEVER touches prompt/agent content, NEVER
//!     `auth.json`/credentials (the Identity Vault "never to the consumer"
//!     invariant in `crate::identity` applies);
//!   - a LOCAL, APPEND-ONLY audit log ([`SupportAccessStore`], a SQLite store
//!     mirroring `server/trace.rs`) with the actor stamped on every entry. The
//!     *user* holds the record of what support saw (stronger than the
//!     server-held logs of Notion/Vercel).
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): this is *what runs* on the local
//! node and *what the user chose* about their own diagnostics — Core. The grant
//! is a user preference, not org policy about others.
//!
//! Actor note: the actor stamped on each row is **self-declared attribution**
//! (an `x-ryu-support-actor` header behind the shared token), consistent with the
//! local-first single-tenant model — NOT verified identity. Same posture as
//! `crate::connections`.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::privacy::SupportAccessLocal;
use crate::server::preferences::PreferencesStore;

/// Fallback actor when no `x-ryu-support-actor` header is present.
pub const UNKNOWN_ACTOR: &str = "unknown";

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Gate decision ───────────────────────────────────────────────────────────

/// Whether the local support-access channel is currently open at `now_ms`.
///
/// Pure wrapper over [`SupportAccessLocal::is_active`] so the gate decision is
/// unit-testable without a running server. Granted = enabled AND (no expiry OR
/// not past it).
pub fn is_open(state: SupportAccessLocal, now_ms: i64) -> bool {
    state.is_active(now_ms)
}

/// Startup auto-disable sweep (the AC's "survives a restart"): if the grant is
/// *enabled* but its hard expiry has passed, write the `support-access-local-
/// enabled` pref back to `false` so the grant cannot silently outlive its expiry
/// across a Core restart. Returns `Ok(true)` when a stale grant was disabled.
///
/// Request-time gating ([`is_open`]) is the always-on defense; this makes the
/// auto-disable durable (a real write), not merely a read-time check.
pub async fn sweep_expired(prefs: &PreferencesStore) -> Result<bool> {
    let state = crate::privacy::support_access_local(prefs).await;
    // Only a grant that is enabled AND has an expiry that has passed is stale.
    let expired = state.enabled && state.expiry_ms != 0 && now_millis() >= state.expiry_ms;
    if expired {
        prefs
            .set(
                crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                "false",
            )
            .await
            .context("disabling expired support-access grant")?;
        return Ok(true);
    }
    Ok(false)
}

// ── Diagnostic projection (ALLOWLIST) ────────────────────────────────────────

/// A single redacted trace span surfaced to support. Mirrors the privacy-safe
/// shape of `server/trace.rs` — an `args_hash` (SHA-256), never the raw args.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RedactedSpan {
    pub conversation_id: String,
    pub kind: String,
    /// Tool name or model id — an identifier, never user content.
    pub name: String,
    /// SHA-256 of the tool input (tool-call spans), never the raw payload.
    pub args_hash: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub error: Option<String>,
}

/// One sidecar's liveness — name + running flag only (no command line, no env).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarLiveness {
    pub name: String,
    pub running: bool,
}

/// The scoped, read-only diagnostic bundle handed to support.
///
/// Built ONLY from the explicit allowlist below. There is deliberately no
/// free-form value field and no full-config serialization — adding a new secret
/// elsewhere can never leak here because nothing is included unless it is named
/// in [`build_bundle`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiagnosticBundle {
    /// Core version string.
    pub core_version: String,
    /// The active local chat engine id, if one is resident.
    pub active_engine: Option<String>,
    /// Sidecar liveness (name + running only).
    pub sidecars: Vec<SidecarLiveness>,
    /// The set of preference KEYS that are currently set — names only, NEVER the
    /// values (a value could be an endpoint/token). Lets support see "is the OTLP
    /// endpoint configured" without seeing what it is. Sorted for stable output.
    pub preference_keys_set: Vec<String>,
    /// Recent redacted trace spans (already content-free by construction).
    pub recent_spans: Vec<RedactedSpan>,
    /// Unix-ms when the bundle was produced.
    pub generated_at: i64,
}

/// Max length of a span `error` string surfaced to support. A span error is the
/// one free-text field that could echo a file path, a tool argument, or a
/// provider error containing prompt text. We cannot fully redact arbitrary error
/// text without losing diagnostic value, so we BOUND it: long errors are
/// truncated with an explicit marker, capping any accidental content leak to a
/// short prefix. (The `args_hash`/name fields are content-free by construction.)
pub const MAX_ERROR_LEN: usize = 200;

/// Truncate a span error to [`MAX_ERROR_LEN`] on a char boundary, appending a
/// `… [truncated]` marker when clipped. Returns `None` for an empty/absent error.
pub fn cap_error(error: Option<String>) -> Option<String> {
    let e = error?;
    let e = e.trim();
    if e.is_empty() {
        return None;
    }
    if e.chars().count() <= MAX_ERROR_LEN {
        return Some(e.to_string());
    }
    let prefix: String = e.chars().take(MAX_ERROR_LEN).collect();
    Some(format!("{prefix}… [truncated]"))
}

/// Build the diagnostic bundle from already-fetched, known-safe inputs.
///
/// Pure (no IO) so the redaction guarantee is unit-testable: callers gather the
/// safe primitives (version, active engine, sidecar liveness, the *names* of set
/// prefs, redacted spans) and pass them here. There is no path by which a raw
/// arg, a credential, or a prompt can enter the bundle; the one free-text field
/// (a span `error`) is length-bounded via [`cap_error`] so an accidental leak is
/// capped to a short prefix.
pub fn build_bundle(
    core_version: impl Into<String>,
    active_engine: Option<String>,
    sidecars: Vec<SidecarLiveness>,
    mut preference_keys_set: Vec<String>,
    recent_spans: Vec<RedactedSpan>,
    now_ms: i64,
) -> DiagnosticBundle {
    preference_keys_set.sort();
    preference_keys_set.dedup();
    let recent_spans = recent_spans
        .into_iter()
        .map(|mut s| {
            s.error = cap_error(s.error);
            s
        })
        .collect();
    DiagnosticBundle {
        core_version: core_version.into(),
        active_engine,
        sidecars,
        preference_keys_set,
        recent_spans,
        generated_at: now_ms,
    }
}

// ── Append-only audit store ───────────────────────────────────────────────────

/// A single support-access audit entry. Append-only; the actor is stamped on
/// every row (delegation, not impersonation — the actor stays visible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub seq: i64,
    /// Self-declared support actor (header), `"unknown"` when absent.
    pub actor: String,
    /// What happened, e.g. `"diagnostic_bundle_read"` or `"access_refused"`.
    pub action: String,
    /// Optional human-readable detail (a reason, a refusal cause). Never content.
    pub detail: Option<String>,
    /// Unix milliseconds.
    pub at: i64,
}

/// SQLite-backed APPEND-ONLY audit log (`~/.ryu/support-access-audit.db`).
///
/// Mirrors `server/trace.rs`: cheap to clone (wraps `Arc<Mutex<Connection>>`).
/// There are deliberately NO update or delete methods — the log is the user's
/// tamper-resistant record of what support saw.
#[derive(Clone)]
pub struct SupportAccessStore {
    conn: Arc<Mutex<Connection>>,
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("support-access-audit.db")
}

impl SupportAccessStore {
    /// Open (or create) the audit store at the default on-disk path.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the audit store at a specific path.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("creating support-access audit dir {}", parent.display())
            })?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening support-access audit db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an in-memory store (tests only).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory audit db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS support_access_audit (
                 seq    INTEGER PRIMARY KEY AUTOINCREMENT,
                 actor  TEXT NOT NULL,
                 action TEXT NOT NULL,
                 detail TEXT,
                 at     INTEGER NOT NULL
             );",
        )
        .context("initializing support-access audit schema")?;
        Ok(())
    }

    /// Append one audit entry. The only mutating operation on this store.
    pub async fn append(&self, actor: &str, action: &str, detail: Option<&str>) -> Result<()> {
        let at = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO support_access_audit (actor, action, detail, at)
             VALUES (?1, ?2, ?3, ?4)",
            params![actor, action, detail, at],
        )
        .context("appending support-access audit entry")?;
        Ok(())
    }

    /// Return all audit entries in ascending `seq` order (oldest first).
    pub async fn list(&self) -> Result<Vec<AuditEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT seq, actor, action, detail, at
             FROM support_access_audit
             ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AuditEntry {
                seq: row.get(0)?,
                actor: row.get(1)?,
                action: row.get(2)?,
                detail: row.get(3)?,
                at: row.get(4)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading support-access audit entries")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Gate / expiry ─────────────────────────────────────────────────────────

    #[test]
    fn refuse_when_off() {
        // Default (off) grant is never open, regardless of expiry/time.
        let off = SupportAccessLocal {
            enabled: false,
            expiry_ms: 0,
        };
        assert!(!is_open(off, 0));
        assert!(!is_open(off, 9_999_999_999));
        // Enabled but expired is also closed.
        let expired = SupportAccessLocal {
            enabled: true,
            expiry_ms: 1_000,
        };
        assert!(!is_open(expired, 2_000));
        // Enabled + not yet expired is open.
        let live = SupportAccessLocal {
            enabled: true,
            expiry_ms: 5_000,
        };
        assert!(is_open(live, 2_000));
        // Enabled + no expiry is open.
        let no_expiry = SupportAccessLocal {
            enabled: true,
            expiry_ms: 0,
        };
        assert!(is_open(no_expiry, 2_000));
    }

    fn temp_prefs() -> PreferencesStore {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.push(format!("ryu-support-prefs-{nanos}.db"));
        PreferencesStore::open(path).expect("open temp prefs")
    }

    #[tokio::test]
    async fn sweep_disables_expired_grant_and_survives_restart() {
        let prefs = temp_prefs();
        // Grant enabled with an expiry already in the past.
        prefs
            .set(
                crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                "true",
            )
            .await
            .unwrap();
        prefs
            .set(crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY, "1000")
            .await
            .unwrap();
        // Before the sweep the stored flag still reads true.
        assert!(crate::privacy::support_access_local(&prefs).await.enabled);

        // The startup sweep (the "restart" moment) auto-disables it via a WRITE.
        let disabled = sweep_expired(&prefs).await.unwrap();
        assert!(disabled, "expired grant should be swept");

        // The persisted pref now reads false — so it stays off across a restart
        // (a subsequent fresh read sees the written value).
        let after = crate::privacy::support_access_local(&prefs).await;
        assert!(!after.enabled, "grant must be persistently disabled");
        assert!(!is_open(after, 2_000));

        // Sweeping again is a no-op (nothing left to disable).
        assert!(!sweep_expired(&prefs).await.unwrap());
    }

    #[tokio::test]
    async fn sweep_keeps_live_and_unexpiring_grants() {
        let prefs = temp_prefs();
        prefs
            .set(
                crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                "true",
            )
            .await
            .unwrap();
        // A far-future expiry must NOT be swept.
        let far_future = now_millis() + 60_000_000;
        prefs
            .set(
                crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY,
                &far_future.to_string(),
            )
            .await
            .unwrap();
        assert!(!sweep_expired(&prefs).await.unwrap());
        assert!(crate::privacy::support_access_local(&prefs).await.enabled);
    }

    // ── Redaction / allowlist ──────────────────────────────────────────────────

    #[test]
    fn bundle_is_allowlist_only_no_content() {
        // An oversized error simulating an accidental content echo — must be
        // capped to MAX_ERROR_LEN + a marker.
        let leaky_error = "secret-prompt-text ".repeat(50);
        let spans = vec![
            RedactedSpan {
                conversation_id: "conv-1".into(),
                kind: "tool-call".into(),
                name: "read_file".into(),
                args_hash: Some("abc123".into()),
                started_at: 10,
                ended_at: Some(20),
                error: None,
            },
            RedactedSpan {
                conversation_id: "conv-1".into(),
                kind: "model-call".into(),
                name: "gemma".into(),
                args_hash: None,
                started_at: 30,
                ended_at: Some(40),
                error: Some(leaky_error.clone()),
            },
        ];
        let bundle = build_bundle(
            "1.2.3",
            Some("llamacpp".into()),
            vec![SidecarLiveness {
                name: "gateway".into(),
                running: true,
            }],
            // Out-of-order + duplicate keys to exercise sort/dedup. Only KEYS,
            // never values — so a token-bearing pref name is fine, its value
            // never appears.
            vec![
                "diagnostics-otlp-endpoint".into(),
                "product-analytics-enabled".into(),
                "diagnostics-otlp-endpoint".into(),
            ],
            spans,
            42,
        );

        assert_eq!(bundle.core_version, "1.2.3");
        assert_eq!(bundle.active_engine.as_deref(), Some("llamacpp"));
        assert_eq!(bundle.generated_at, 42);
        // Keys are sorted + deduped.
        assert_eq!(
            bundle.preference_keys_set,
            vec![
                "diagnostics-otlp-endpoint".to_string(),
                "product-analytics-enabled".to_string(),
            ]
        );

        // Serialize and assert no raw-content fields exist anywhere — only the
        // hash leaks for a tool call, never the args.
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(json.contains("abc123"), "the args hash is retained");
        assert!(!json.contains("\"args\""), "raw args must never appear");
        assert!(
            !json.contains("\"prompt\"") && !json.contains("\"messages\""),
            "no prompt/agent content fields"
        );
        // The span carries an identifier name + a hash, nothing more.
        assert_eq!(bundle.recent_spans[0].args_hash.as_deref(), Some("abc123"));

        // The oversized error is bounded: capped length + truncation marker, so
        // an accidental content echo can only leak a short prefix.
        let capped = bundle.recent_spans[1].error.as_ref().unwrap();
        assert!(
            capped.chars().count() <= MAX_ERROR_LEN + "… [truncated]".chars().count(),
            "error must be capped: {capped}"
        );
        assert!(capped.ends_with("… [truncated]"));
        assert!(
            capped.chars().count() < leaky_error.chars().count(),
            "oversized error must be shortened"
        );
    }

    #[test]
    fn cap_error_passes_short_drops_empty() {
        assert_eq!(cap_error(None), None);
        assert_eq!(cap_error(Some("   ".into())), None);
        assert_eq!(
            cap_error(Some("permission denied".into())).as_deref(),
            Some("permission denied")
        );
    }

    // ── Append-only audit, actor stamped ───────────────────────────────────────

    #[tokio::test]
    async fn audit_is_append_only_with_actor_stamped() {
        let store = SupportAccessStore::open_in_memory().unwrap();
        store
            .append("support@ryu", "diagnostic_bundle_read", Some("ticket-7"))
            .await
            .unwrap();
        store
            .append(UNKNOWN_ACTOR, "access_refused", Some("grant off"))
            .await
            .unwrap();

        let entries = store.list().await.unwrap();
        assert_eq!(entries.len(), 2);
        // Append-only ⇒ ascending seq, actor stamped on each row.
        assert!(entries[0].seq < entries[1].seq);
        assert_eq!(entries[0].actor, "support@ryu");
        assert_eq!(entries[0].action, "diagnostic_bundle_read");
        assert_eq!(entries[0].detail.as_deref(), Some("ticket-7"));
        assert_eq!(entries[1].actor, UNKNOWN_ACTOR);
        assert_eq!(entries[1].action, "access_refused");
    }
}
