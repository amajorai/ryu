//! Item changes: patch, delete and reveal.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

impl PluginSecretStore {
    /// Optimistic partial update. `expected_id` and `expected_version` must
    /// match the stored item; omitted values are kept and `null` clears one.
    /// Clearing a required value moves the item back to `pending_collection`.
    pub async fn item_patch(
        &self,
        key: &str,
        patch: ItemPatch,
        actor: &AuditActor,
    ) -> Result<ItemView> {
        let coords = ItemCoords::new(patch.environment.as_deref(), patch.path.as_deref(), key)?;
        let description = match &patch.description {
            None => None,
            Some(None) => Some(None),
            Some(Some(text)) => {
                let text = text.trim();
                if text.chars().count() > MAX_DESCRIPTION_LEN {
                    return Err(invalid(format!(
                        "description exceeds {MAX_DESCRIPTION_LEN} characters"
                    )));
                }
                Some((!text.is_empty()).then(|| text.to_owned()))
            }
        };
        if description.is_none() && patch.values.is_empty() && patch.merchants.is_none() {
            return Err(invalid("nothing to change"));
        }

        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        if row.id != patch.expected_id || row.version != patch.expected_version {
            return Err(VaultError::Conflict(format!(
                "item `{}` is at version {} (id {}); re-read it and retry",
                coords.policy_key(),
                row.version,
                row.id
            ))
            .into());
        }
        let is_card = cards::is_card_item(&row.kind, &row.fields);
        let merchants = match (&patch.merchants, is_card) {
            (Some(merchants), true) => Some(cards::normalize_merchants(merchants)?),
            (Some(_), false) => return Err(invalid("merchants apply only to card items")),
            (None, _) => None,
        };
        if is_card {
            self.check_card_patch_expiry(&tx, &row, &patch.values)?;
        }
        let mut set = Vec::new();
        let mut cleared = Vec::new();
        for (name, value) in &patch.values {
            let def = field_def(&row.fields, name)?;
            match value {
                Some(value) => {
                    let value = if is_card {
                        cards::normalize_card_value(def, value)?
                    } else {
                        normalize_value(def, value)?
                    };
                    self.put_value(&tx, &row.id, name, &value)?;
                    set.push(name.clone());
                }
                None => {
                    tx.execute(
                        "DELETE FROM vault_item_values WHERE item_id = ?1 AND field = ?2",
                        params![row.id, name],
                    )?;
                    cleared.push(name.clone());
                }
            }
        }
        if is_card {
            self.card_refresh_meta_locked(&tx, &row.id, &coords, merchants.as_deref())?;
        }
        let present = fields_with_values(&tx, &row.id)?;
        let status = status_for(&row.fields, &present);
        let version = row.version + 1;
        let now = now_millis();
        let description = description.unwrap_or_else(|| row.description.clone());
        tx.execute(
            "UPDATE vault_items SET description = ?1, version = ?2, status = ?3, updated_at = ?4
             WHERE id = ?5",
            params![description, version, status.as_str(), now, row.id],
        )?;
        let data = json!({
            "fieldsSet": set,
            "fieldsCleared": cleared,
            "descriptionChanged": patch.description.is_some(),
            "merchantsChanged": patch.merchants.is_some(),
        });
        append_event(&tx, &row.id, &coords, "updated", version, actor, &data)?;
        if status != row.status {
            append_event(
                &tx,
                &row.id,
                &coords,
                "status_changed",
                version,
                actor,
                &json!({ "from": row.status.as_str(), "to": status.as_str() }),
            )?;
        }
        self.audit_locked(&tx, &audit_entry(actor, "item.update", &coords, data));
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        let view = self.item_view_locked(&tx, &coords, &row, false)?;
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok(view)
    }

    /// Delete an item and its values. When `expected_version` is set it must
    /// match. The event timeline is kept. Returns `false` if it did not exist.
    pub async fn item_delete(
        &self,
        coords: &ItemCoords,
        expected_version: Option<i64>,
        actor: &AuditActor,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let Some(row) = find_item(&tx, coords)? else {
            return Ok(false);
        };
        if expected_version.is_some_and(|expected| expected != row.version) {
            return Err(VaultError::Conflict(format!(
                "item `{}` is at version {}",
                coords.policy_key(),
                row.version
            ))
            .into());
        }
        tx.execute(
            "DELETE FROM vault_item_values WHERE item_id = ?1",
            params![row.id],
        )?;
        tx.execute("DELETE FROM vault_items WHERE id = ?1", params![row.id])?;
        cards::forget_locked(&tx, &row.id)?;
        append_event(
            &tx,
            &row.id,
            coords,
            "deleted",
            row.version,
            actor,
            &json!({}),
        )?;
        self.audit_locked(&tx, &audit_entry(actor, "item.delete", coords, json!({})));
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok(true)
    }

    /// Reveal one field's plaintext (sensitive or not). Audited and recorded
    /// on the timeline without the value.
    pub async fn item_reveal(
        &self,
        coords: &ItemCoords,
        field: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, coords)?.ok_or_else(|| not_found(coords))?;
        field_def(&row.fields, field)?;
        if cards::is_card_item(&row.kind, &row.fields) && cards::is_restricted_field(field) {
            return Err(VaultError::Denied(
                "a card number or security code is revealed only under a card approval".into(),
            )
            .into());
        }
        let value = self
            .open_value(&conn, &row.id, field)?
            .ok_or_else(|| VaultError::NotFound(format!("field `{field}` has no value")))?;
        let data = json!({ "field": field });
        if !self.audit_locked(
            &conn,
            &audit_entry(actor, "item.reveal", coords, data.clone()),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        append_event(
            &conn,
            &row.id,
            coords,
            "revealed",
            row.version,
            actor,
            &data,
        )?;
        drop(conn);
        notify_events();
        Ok(value)
    }
}
