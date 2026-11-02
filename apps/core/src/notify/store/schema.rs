//! `notify.db` schema, additive migrations and the one-time credential reseal.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{FieldCipher, SecretSealer};

use super::{push_token_hash, NotifyStore, NOTIFY_STORE};

impl NotifyStore {
    /// Record that `notify.db` owes a freelist scrub and vacuum, before any
    /// cell is rewritten: the state row commits with the rewrite, so a crash
    /// after the commit still leaves the debt for the next start. Keeps an
    /// existing `vacuum_pending` row as it is.
    fn mark_scrub_owed(conn: &Connection) -> Result<()> {
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
            params![NOTIFY_STORE, STORE_ITEM, states::VACUUM_PENDING],
        )
        .context("recording the notify credential scrub")?;
        Ok(())
    }

    /// Seal, once, the alert-delivery JSON and every push token still stored as
    /// legacy plaintext, in one transaction that first records the scrub debt.
    /// Returns how many values it rewrote; the caller scrubs the freed pages.
    pub(super) fn reseal_plaintext_credentials(
        conn: &Connection,
        cipher: &FieldCipher,
    ) -> Result<usize> {
        let delivery: Option<String> = conn
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()
            .context("reading alert delivery targets for reseal")?;
        let sealed_delivery = match delivery
            .as_deref()
            .map(|json| cipher.reseal_if_plaintext(json))
            .transpose()
        {
            Ok(Some(Some(sealed))) => Some(sealed),
            Ok(_) => None,
            // Leave the row as it is; reads report the error instead of
            // pretending there are no targets.
            Err(error) => {
                tracing::warn!("notify store: alert delivery targets not resealed: {error:#}");
                None
            }
        };
        let legacy_tokens = {
            let mut stmt = conn
                .prepare("SELECT token FROM push_tokens WHERE token_hash IS NULL")
                .context("listing push tokens for reseal")?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .context("listing push tokens for reseal")?
                .collect::<rusqlite::Result<Vec<_>>>()
                .context("listing push tokens for reseal")?;
            rows
        };
        let mut sealed_tokens = Vec::new();
        for stored in legacy_tokens {
            let token = match SecretSealer::open(cipher, &stored) {
                Ok(token) => token,
                Err(error) => {
                    tracing::warn!("notify store: push token not resealed: {error:#}");
                    continue;
                }
            };
            let sealed = if cipher.is_sealed(&stored) {
                stored.clone()
            } else {
                cipher.seal(&token).context("sealing a push token")?
            };
            sealed_tokens.push((sealed, push_token_hash(&token), stored));
        }
        let resealed = usize::from(sealed_delivery.is_some()) + sealed_tokens.len();
        if resealed == 0 {
            return Ok(0);
        }
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
                .context("starting the notify credential reseal")?;
        Self::mark_scrub_owed(&tx)?;
        if let Some(sealed) = sealed_delivery {
            tx.execute(
                "UPDATE alert_delivery SET json = ?1 WHERE id = 1",
                params![sealed],
            )
            .context("resealing alert delivery targets")?;
        }
        for (sealed, hash, stored) in sealed_tokens {
            tx.execute(
                "UPDATE push_tokens SET token = ?1, token_hash = ?2 WHERE token = ?3",
                params![sealed, hash, stored],
            )
            .context("resealing a push token")?;
        }
        tx.commit()
            .context("committing the notify credential reseal")?;
        tracing::info!(
            count = resealed,
            "notify store: sealed legacy plaintext credentials"
        );
        Ok(resealed)
    }

    pub(super) fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS push_tokens (
                 token       TEXT PRIMARY KEY,
                 platform    TEXT,
                 user_id     TEXT,
                 created_at  TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_push_tokens_user
                 ON push_tokens(user_id);
             CREATE TABLE IF NOT EXISTS notifications (
                 id              TEXT PRIMARY KEY,
                 user_id         TEXT,
                 title           TEXT NOT NULL,
                 body            TEXT,
                 level           TEXT NOT NULL DEFAULT 'info',
                 workflow_run_id TEXT,
                 node_id         TEXT,
                 ack_required    INTEGER NOT NULL DEFAULT 0,
                 acked           INTEGER NOT NULL DEFAULT 0,
                 read_at         TEXT,
                 created_at      TEXT NOT NULL,
                 source_app_id   TEXT,
                 archived_at     TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_notifications_user
                 ON notifications(user_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS policy_alert_dedupe (
                 dedupe_key TEXT PRIMARY KEY,
                 fired_at   TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS alert_delivery (
                 id   INTEGER PRIMARY KEY CHECK (id = 1),
                 json TEXT NOT NULL
             );",
        )
        .context("initializing notify schema")?;
        // Idempotent additive migration for DBs created before the app-inbox feed
        // recorded who sent a row (`source_app_id`) or whether the user archived it
        // (`archived_at`). `CREATE TABLE IF NOT EXISTS` above already shapes a fresh
        // DB; an existing one gains the two columns here, one ALTER per missing one.
        for (column, decl) in [
            (
                "source_app_id",
                "ALTER TABLE notifications ADD COLUMN source_app_id TEXT",
            ),
            (
                "archived_at",
                "ALTER TABLE notifications ADD COLUMN archived_at TEXT",
            ),
        ] {
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('notifications') WHERE name = ?1",
                    params![column],
                    |r| r.get(0),
                )
                .context("reading notifications columns")?;
            if has == 0 {
                conn.execute(decl, [])
                    .with_context(|| format!("adding notifications.{column}"))?;
            }
        }
        // A device opts in to "agent finished" pushes when it registers (the
        // mobile Finished alerts setting). Older rows and older app builds stay
        // opted out, so they keep relying on their own local alert.
        let has_run_finished: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('push_tokens') WHERE name = 'run_finished'",
                [],
                |r| r.get(0),
            )
            .context("reading push_tokens columns")?;
        if has_run_finished == 0 {
            conn.execute(
                "ALTER TABLE push_tokens ADD COLUMN run_finished INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .context("adding push_tokens.run_finished")?;
        }
        // Push tokens are sealed with a fresh nonce, so lookups go through a
        // deterministic digest column. Legacy rows get theirs when the store
        // reseals them on open.
        let has_token_hash: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('push_tokens') WHERE name = 'token_hash'",
                [],
                |r| r.get(0),
            )
            .context("reading push_tokens columns")?;
        if has_token_hash == 0 {
            conn.execute("ALTER TABLE push_tokens ADD COLUMN token_hash TEXT", [])
                .context("adding push_tokens.token_hash")?;
        }
        // The locale a device registered (BCP 47, e.g. `ja`, `pt-BR`), so a push
        // is rendered in the phone's language. Older rows have none and get
        // the node's `ui-language` instead.
        let has_locale: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('push_tokens') WHERE name = 'locale'",
                [],
                |r| r.get(0),
            )
            .context("reading push_tokens columns")?;
        if has_locale == 0 {
            conn.execute("ALTER TABLE push_tokens ADD COLUMN locale TEXT", [])
                .context("adding push_tokens.locale")?;
        }
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_hash ON push_tokens(token_hash)",
            [],
        )
        .context("indexing push_tokens.token_hash")?;
        Ok(())
    }
}
