//! Item reads: one item, listings and the event timeline.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

impl PluginSecretStore {
    /// Read one item. Non-sensitive values are included when
    /// `include_values` is set.
    pub async fn item_get(&self, coords: &ItemCoords, include_values: bool) -> Result<ItemView> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, coords)?.ok_or_else(|| not_found(coords))?;
        self.item_view_locked(&conn, coords, &row, include_values)
    }

    /// Every item, optionally narrowed to one environment and folder.
    pub async fn item_list(
        &self,
        environment: Option<&str>,
        path: Option<&str>,
    ) -> Result<Vec<ItemSummary>> {
        let path = match path {
            Some(path) => Some(normalize_path(path).ok_or_else(|| invalid("invalid folder path"))?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, environment, path, item_key, kind, version, status, fields, updated_at
             FROM vault_items
             WHERE (?1 IS NULL OR environment = ?1) AND (?2 IS NULL OR path = ?2)
             ORDER BY environment, path, item_key",
        )?;
        let card_summaries = cards::summaries_locked(&conn)?;
        let rows = stmt.query_map(params![environment, path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, environment, path, key, kind, version, status, fields, updated_at) = row?;
            let fields: Vec<FieldDef> = serde_json::from_str(&fields)?;
            out.push(ItemSummary {
                card: card_summaries.get(&id).cloned(),
                id,
                environment,
                path,
                key,
                kind,
                version,
                status: ItemStatus::parse(&status),
                field_count: fields.len(),
                updated_at,
            });
        }
        Ok(out)
    }

    fn item_events_locked(
        conn: &Connection,
        coords: &ItemCoords,
        after: i64,
        limit: usize,
        scope: EventScope,
    ) -> Result<Vec<ItemEvent>> {
        let item_id = match scope {
            EventScope::History => None,
            EventScope::CurrentItem => match find_item(conn, coords)? {
                Some(row) => Some(row.id),
                None => return Ok(Vec::new()),
            },
        };
        let mut stmt = conn.prepare(
            "SELECT seq, item_id, name, version, actor_kind, actor_id, data, created_at
             FROM vault_item_events
             WHERE environment = ?1 AND path = ?2 AND item_key = ?3 AND seq > ?4
               AND (?6 IS NULL OR item_id = ?6)
             ORDER BY seq LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            params![
                coords.environment,
                coords.path,
                coords.key,
                after,
                limit as i64,
                item_id
            ],
            |row| {
                Ok(ItemEvent {
                    seq: row.get(0)?,
                    item_id: row.get(1)?,
                    name: row.get(2)?,
                    version: row.get(3)?,
                    actor_kind: row.get(4)?,
                    actor_id: row.get(5)?,
                    data: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                    created_at: row.get(7)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Events at `coords` with `seq > after`: only the current item's under
    /// [`EventScope::CurrentItem`], or every item's across deletes and
    /// re-creates under [`EventScope::History`]. With `wait_secs > 0` and
    /// nothing new, waits up to that long (at most [`MAX_EVENT_WAIT_SECS`])
    /// for the next event.
    pub async fn item_events(
        &self,
        coords: &ItemCoords,
        after: i64,
        limit: usize,
        wait_secs: u64,
        scope: EventScope,
    ) -> Result<Vec<ItemEvent>> {
        let limit = limit.clamp(1, MAX_EVENT_PAGE);
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(wait_secs.min(MAX_EVENT_WAIT_SECS));
        loop {
            // Register before reading so an event committed in between wakes us.
            let notified = EVENT_NOTIFY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let events = {
                let conn = self.conn.lock().await;
                Self::item_events_locked(&conn, coords, after, limit, scope)?
            };
            if !events.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(events);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let conn = self.conn.lock().await;
                return Self::item_events_locked(&conn, coords, after, limit, scope);
            }
        }
    }
}
