//! Tag entities: a name, color and description for a tag that values carry.
//!
//! Values keep their tags as plain labels in `metadata.tags`; an entity only
//! describes one. Deleting an entity leaves the label on the values that
//! carry it. Entities are metadata, not secrets, so the table is not sealed.

use super::*;

/// Longest entity display name.
pub const MAX_TAG_NAME_LEN: usize = 64;
/// At most this many entities.
pub const MAX_TAG_ENTITIES: usize = 512;

/// One tag entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTag {
    /// The label values carry (`metadata.tags`).
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: String,
    /// `#rrggbb`, or empty.
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Whether `tag` is a label a value may carry (trimmed, non-empty, at most
/// [`MAX_TAG_LEN`] characters, no control characters).
pub fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag == tag.trim()
        && tag.len() <= MAX_TAG_LEN
        && !tag.chars().any(char::is_control)
}

fn is_color(color: &str) -> bool {
    color.is_empty()
        || (color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

fn validated(tag: &VaultTag) -> Result<VaultTag> {
    if !is_valid_tag(&tag.slug) {
        return Err(VaultError::Invalid(format!(
            "a tag is 1 to {MAX_TAG_LEN} printable characters without surrounding spaces"
        ))
        .into());
    }
    let name = tag.name.trim();
    let description = tag.description.trim();
    let color = tag.color.trim().to_ascii_lowercase();
    if name.len() > MAX_TAG_NAME_LEN || name.chars().any(char::is_control) {
        return Err(VaultError::Invalid(format!(
            "a tag name is at most {MAX_TAG_NAME_LEN} printable characters"
        ))
        .into());
    }
    if description.len() > MAX_DESCRIPTION_LEN {
        return Err(VaultError::Invalid(format!(
            "a tag description is at most {MAX_DESCRIPTION_LEN} characters"
        ))
        .into());
    }
    if !is_color(&color) {
        return Err(VaultError::Invalid("color must be `#rrggbb`".into()).into());
    }
    Ok(VaultTag {
        slug: tag.slug.clone(),
        name: name.to_owned(),
        color,
        description: description.to_owned(),
        created_at: 0,
        updated_at: 0,
    })
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_tags (
             slug        TEXT PRIMARY KEY,
             name        TEXT NOT NULL DEFAULT '',
             color       TEXT NOT NULL DEFAULT '',
             description TEXT NOT NULL DEFAULT '',
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL
         );",
    )
    .context("initializing vault tag schema")
}

fn list_locked(conn: &Connection) -> Result<Vec<VaultTag>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT slug, name, color, description, created_at, updated_at
         FROM vault_tags ORDER BY slug",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(VaultTag {
            slug: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            description: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("reading vault tags")
}

impl PluginSecretStore {
    /// Every tag entity, by slug.
    pub async fn tag_entities(&self) -> Result<Vec<VaultTag>> {
        let conn = self.conn.lock().await;
        list_locked(&conn)
    }

    /// Create or update a tag entity (keeps `createdAt`).
    pub async fn put_tag_entity(&self, tag: &VaultTag, actor: &AuditActor) -> Result<VaultTag> {
        let tag = validated(tag)?;
        let conn = self.conn.lock().await;
        let existing = list_locked(&conn)?;
        let previous = existing.iter().find(|held| held.slug == tag.slug);
        if previous.is_none() && existing.len() >= MAX_TAG_ENTITIES {
            return Err(VaultError::Conflict(format!(
                "at most {MAX_TAG_ENTITIES} tag entities"
            ))
            .into());
        }
        let now = now_millis();
        let stored = VaultTag {
            created_at: previous.map_or(now, |held| held.created_at),
            updated_at: now,
            ..tag
        };
        conn.execute(
            "INSERT INTO vault_tags (slug, name, color, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(slug) DO UPDATE SET name = ?2, color = ?3, description = ?4,
                 updated_at = ?6",
            params![
                stored.slug,
                stored.name,
                stored.color,
                stored.description,
                stored.created_at,
                stored.updated_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "tag.put", "ok").details(json!({ "slug": stored.slug })),
        );
        Ok(stored)
    }

    /// Delete a tag entity; values keep the label. `Ok(false)` when absent.
    pub async fn delete_tag_entity(&self, slug: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        ensure_schema(&conn)?;
        let removed = conn.execute("DELETE FROM vault_tags WHERE slug = ?1", params![slug])? > 0;
        if removed {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "tag.delete", "ok").details(json!({ "slug": slug })),
            );
        }
        Ok(removed)
    }
}

#[cfg(test)]
#[path = "tags_tests.rs"]
mod tests;
