//! Expo push tokens registered by mobile devices, with their owner and locale.

use anyhow::{Context, Result};
use rusqlite::params;

use super::{push_token_hash, NotifyStore};

/// Longest locale tag a device may store (BCP 47 tags are far shorter).
const MAX_LOCALE_LEN: usize = 35;

/// One registered device: its token, the member who registered it (`None` for
/// an anonymous single-user registration) and the locale it registered with
/// (`None` until the app reports one; the node's language is used instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub token: String,
    pub owner: Option<String>,
    pub locale: Option<String>,
}

/// A well-formed locale tag, or `None` (blank or not BCP 47 shaped).
fn clean_locale(locale: Option<&str>) -> Option<String> {
    let tag = locale?.trim();
    let valid = !tag.is_empty()
        && tag.len() <= MAX_LOCALE_LEN
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then(|| tag.to_owned())
}

impl NotifyStore {
    /// Register (or refresh) an Expo push token for mobile notifications.
    ///
    /// `user_id` scopes the token to the member who registered it so a workflow
    /// can push to a specific person's devices. It is optional: an anonymous /
    /// single-user node registers `None` and the token still receives the
    /// broadcast fan-out (monitor alerts).
    pub async fn register_push_token(
        &self,
        token: &str,
        platform: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let sealed = self.cipher()?.seal(token).context("sealing push token")?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "INSERT INTO push_tokens (token, token_hash, platform, user_id, created_at)
             VALUES (?1, ?5, ?2, ?3, ?4)
             ON CONFLICT(token_hash) DO UPDATE SET platform = ?2, created_at = ?4
             WHERE push_tokens.user_id IS ?3",
                params![sealed, platform, user_id, now, push_token_hash(token)],
            )
            .context("registering push token")?;
        Ok(changed > 0)
    }

    /// Record whether a device wants "agent finished" pushes. Scoped to the
    /// token's owner (`None` for an anonymous single-user node) so one member
    /// cannot change another member's device. Returns whether a row changed.
    pub async fn set_push_token_run_finished(
        &self,
        token: &str,
        user_id: Option<&str>,
        enabled: bool,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE push_tokens SET run_finished = ?1
             WHERE (token_hash = ?4 OR (token_hash IS NULL AND token = ?2)) AND user_id IS ?3",
            params![enabled, token, user_id, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Record the locale a device registered with (the app's UI language), so
    /// pushes to it are rendered in that language. Owner-scoped like
    /// [`Self::set_push_token_run_finished`]; a blank or malformed tag clears it.
    /// `POST /api/notifications/push-tokens` calls it with the app's `locale`;
    /// a device that never sent one falls back to the node's language.
    pub async fn set_push_token_locale(
        &self,
        token: &str,
        user_id: Option<&str>,
        locale: Option<&str>,
    ) -> Result<bool> {
        let locale = clean_locale(locale);
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE push_tokens SET locale = ?1
             WHERE (token_hash = ?4 OR (token_hash IS NULL AND token = ?2)) AND user_id IS ?3",
            params![locale, token, user_id, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Remove a push token (device opted out / token rotated).
    pub async fn remove_push_token(&self, token: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM push_tokens WHERE token_hash = ?2 OR (token_hash IS NULL AND token = ?1)",
            params![token, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Remove a push token only when it belongs to `user_id`.
    ///
    /// The token is the public path identifier, so callers handling an
    /// authenticated member request must use this owner-scoped variant rather
    /// than the node-level removal above.
    pub async fn remove_push_token_for_user(&self, token: &str, user_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM push_tokens
             WHERE (token_hash = ?3 OR (token_hash IS NULL AND token = ?1)) AND user_id = ?2",
            params![token, user_id, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Every registered device. For a fan-out whose content depends on what
    /// each owner may see, or on each device's language.
    pub async fn push_targets(&self) -> Result<Vec<PushTarget>> {
        self.select_targets("SELECT token, user_id, locale FROM push_tokens", None)
            .await
    }

    /// The devices a specific member registered. Used to push a user-targeted
    /// notification to just that person rather than the whole-node broadcast.
    pub async fn push_targets_for_user(&self, user_id: &str) -> Result<Vec<PushTarget>> {
        self.select_targets(
            "SELECT token, user_id, locale FROM push_tokens WHERE user_id = ?1",
            Some(user_id),
        )
        .await
    }

    /// The devices that opted in to "agent finished" pushes for a conversation
    /// owner. `None` is the owner of an anonymous single-user node, whose
    /// devices register without a member id.
    pub async fn run_finished_push_targets(&self, owner: Option<&str>) -> Result<Vec<PushTarget>> {
        self.select_targets(
            "SELECT token, user_id, locale FROM push_tokens
             WHERE run_finished = 1 AND user_id IS ?1",
            owner,
        )
        .await
    }

    /// Run a `token, user_id, locale` query (with at most one bound parameter).
    /// Tokens are sealed at rest; one that cannot be opened is skipped (logged),
    /// never returned as ciphertext or a placeholder.
    async fn select_targets(&self, sql: &str, param: Option<&str>) -> Result<Vec<PushTarget>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        };
        let stored = if sql.contains("?1") {
            stmt.query_map(params![param], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map([], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        drop(stmt);
        drop(conn);
        Ok(stored
            .into_iter()
            .filter_map(|(value, owner, locale)| match self.open_value(&value) {
                Ok(token) => Some(PushTarget {
                    token,
                    owner,
                    locale,
                }),
                Err(error) => {
                    tracing::warn!(
                        "notify store: skipping a push token that cannot be opened: {error:#}"
                    );
                    None
                }
            })
            .collect())
    }
}
