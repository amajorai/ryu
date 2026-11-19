//! Item tables, row access, sealing and the read view.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

/// Create the item tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_items (
             id          TEXT PRIMARY KEY,
             environment TEXT NOT NULL,
             path        TEXT NOT NULL,
             item_key    TEXT NOT NULL,
             kind        TEXT NOT NULL,
             description TEXT,
             fields      TEXT NOT NULL,
             version     INTEGER NOT NULL,
             status      TEXT NOT NULL,
             created_by  TEXT,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL,
             UNIQUE (environment, path, item_key)
         );
         CREATE TABLE IF NOT EXISTS vault_item_values (
             item_id     TEXT NOT NULL,
             field       TEXT NOT NULL,
             key_version INTEGER NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             updated_at  INTEGER NOT NULL,
             PRIMARY KEY (item_id, field)
         );
         CREATE TABLE IF NOT EXISTS vault_item_events (
             seq         INTEGER PRIMARY KEY AUTOINCREMENT,
             item_id     TEXT NOT NULL,
             environment TEXT NOT NULL,
             path        TEXT NOT NULL,
             item_key    TEXT NOT NULL,
             name        TEXT NOT NULL,
             version     INTEGER NOT NULL,
             actor_kind  TEXT NOT NULL,
             actor_id    TEXT,
             data        TEXT NOT NULL,
             created_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS vault_item_events_coords
             ON vault_item_events (environment, path, item_key, seq);",
    )
    .context("initializing vault item schema")?;
    cards::init_schema(conn)
}

pub(super) struct ItemRow {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) description: Option<String>,
    pub(super) fields: Vec<FieldDef>,
    pub(super) version: i64,
    pub(super) status: ItemStatus,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

pub(super) fn find_item(conn: &Connection, coords: &ItemCoords) -> Result<Option<ItemRow>> {
    let row = conn
        .query_row(
            "SELECT id, kind, description, fields, version, status, created_at, updated_at
             FROM vault_items WHERE environment = ?1 AND path = ?2 AND item_key = ?3",
            params![coords.environment, coords.path, coords.key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((id, kind, description, fields, version, status, created_at, updated_at)) = row else {
        return Ok(None);
    };
    Ok(Some(ItemRow {
        id,
        kind,
        description,
        fields: serde_json::from_str(&fields).context("decoding item field definitions")?,
        version,
        status: ItemStatus::parse(&status),
        created_at,
        updated_at,
    }))
}

pub(super) fn not_found(coords: &ItemCoords) -> anyhow::Error {
    VaultError::NotFound(format!("item `{}`", coords.policy_key())).into()
}

/// Names of fields that currently hold a value.
pub(super) fn fields_with_values(conn: &Connection, item_id: &str) -> Result<BTreeSet<String>> {
    let mut stmt = conn.prepare("SELECT field FROM vault_item_values WHERE item_id = ?1")?;
    let rows = stmt.query_map(params![item_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn status_for(fields: &[FieldDef], present: &BTreeSet<String>) -> ItemStatus {
    if fields
        .iter()
        .filter(|field| field.required)
        .all(|field| present.contains(&field.name))
    {
        ItemStatus::Ready
    } else {
        ItemStatus::PendingCollection
    }
}

pub(super) fn field_def<'a>(fields: &'a [FieldDef], name: &str) -> Result<&'a FieldDef> {
    fields
        .iter()
        .find(|field| field.name == name)
        .ok_or_else(|| invalid(format!("unknown field `{name}`")))
}

pub(super) fn append_event(
    conn: &Connection,
    item_id: &str,
    coords: &ItemCoords,
    name: &str,
    version: i64,
    actor: &AuditActor,
    data: &Value,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vault_item_events
             (item_id, environment, path, item_key, name, version, actor_kind, actor_id, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            item_id,
            coords.environment,
            coords.path,
            coords.key,
            name,
            version,
            actor.kind,
            actor.id,
            data.to_string(),
            now_millis()
        ],
    )?;
    Ok(())
}

pub(super) fn audit_entry(
    actor: &AuditActor,
    action: &str,
    coords: &ItemCoords,
    details: Value,
) -> AuditEntry {
    AuditEntry::new(actor, action, "ok").details(json!({
        "item": coords.key,
        "environment": coords.environment,
        "path": coords.path,
        "details": details,
    }))
}

pub(super) fn notify_events() {
    EVENT_NOTIFY.notify_waiters();
}

impl PluginSecretStore {
    pub(super) fn seal_value(&self, value: &str) -> Result<(u32, Vec<u8>, Vec<u8>)> {
        self.seal_row(value.as_bytes())
    }

    pub(super) fn open_value(
        &self,
        conn: &Connection,
        item_id: &str,
        field: &str,
    ) -> Result<Option<String>> {
        let row: Option<(u32, Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT key_version, nonce, ciphertext FROM vault_item_values
                 WHERE item_id = ?1 AND field = ?2",
                params![item_id, field],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((key_version, nonce, ciphertext)) = row else {
            return Ok(None);
        };
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("item value is not UTF-8"))
    }

    pub(super) fn put_value(
        &self,
        conn: &Connection,
        item_id: &str,
        field: &str,
        value: &str,
    ) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_value(value)?;
        conn.execute(
            "INSERT INTO vault_item_values (item_id, field, key_version, nonce, ciphertext, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(item_id, field) DO UPDATE SET key_version = excluded.key_version,
                 nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                 updated_at = excluded.updated_at",
            params![item_id, field, key_version, nonce, ciphertext, now_millis()],
        )?;
        Ok(())
    }

    /// Build the read view. Non-sensitive values are opened only when
    /// `include_values` is set; sensitive values never are.
    pub(super) fn item_view_locked(
        &self,
        conn: &Connection,
        coords: &ItemCoords,
        row: &ItemRow,
        include_values: bool,
    ) -> Result<ItemView> {
        let present = fields_with_values(conn, &row.id)?;
        let mut fields = Vec::with_capacity(row.fields.len());
        for def in &row.fields {
            let has_value = present.contains(&def.name);
            let value = if include_values && has_value && !def.sensitive {
                self.open_value(conn, &row.id, &def.name)?
            } else {
                None
            };
            fields.push(FieldView {
                def: def.clone(),
                has_value,
                value,
            });
        }
        let mut operations = Vec::new();
        if row.status == ItemStatus::PendingCollection {
            operations.push("collect");
        }
        if !present.is_empty() {
            operations.push("reveal");
        }
        let card = if cards::is_card_item(&row.kind, &row.fields) {
            cards::summary_locked(conn, &row.id, &coords.key)?
        } else {
            None
        };
        Ok(ItemView {
            id: row.id.clone(),
            environment: coords.environment.clone(),
            path: coords.path.clone(),
            key: coords.key.clone(),
            kind: row.kind.clone(),
            description: row.description.clone(),
            version: row.version,
            status: row.status,
            fields,
            available_operations: operations,
            card,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    /// A card patch that sets either expiry field must leave a valid,
    /// unexpired expiry.
    pub(super) fn check_card_patch_expiry(
        &self,
        conn: &Connection,
        row: &ItemRow,
        values: &BTreeMap<String, Option<String>>,
    ) -> Result<()> {
        let touched = [cards::FIELD_EXP_MONTH, cards::FIELD_EXP_YEAR];
        if !touched.iter().any(|name| values.contains_key(*name)) {
            return Ok(());
        }
        let mut current = Vec::with_capacity(2);
        for name in touched {
            let value = match values.get(name) {
                Some(Some(value)) => Some(cards::normalize_card_value(
                    field_def(&row.fields, name)?,
                    value,
                )?),
                Some(None) => None,
                None => self.open_value(conn, &row.id, name)?,
            };
            current.push(value);
        }
        if let [Some(month), Some(year)] = current.as_slice() {
            cards::check_new_expiry(month, year, now_millis())?;
        }
        Ok(())
    }
}
