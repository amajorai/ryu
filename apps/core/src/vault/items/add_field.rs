//! The one schema change an existing item allows: appending an optional
//! field. Existing field definitions never change and are never removed, so
//! every stored value keeps its meaning; an added field starts without a value
//! and, being optional, never moves the item back to `pending_collection`.
//! Card items keep their fixed schema.

use super::*;

impl PluginSecretStore {
    /// Append the optional field `field` to the item at `coords`. Optimistic
    /// like [`Self::item_patch`]: `expected_id` and `expected_version` must
    /// match. A field whose name the item already has (any case) is a
    /// conflict. Bumps the version, records a `field_added` event and audits
    /// `item.add_field`.
    pub async fn item_add_field(
        &self,
        coords: &ItemCoords,
        expected_id: &str,
        expected_version: i64,
        field: &FieldDefInput,
        actor: &AuditActor,
    ) -> Result<ItemView> {
        if field.required {
            return Err(invalid("an added field must be optional"));
        }
        let def = normalize_fields(std::slice::from_ref(field))?.remove(0);
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let row = find_item(&tx, coords)?.ok_or_else(|| not_found(coords))?;
        if row.id != expected_id || row.version != expected_version {
            return Err(VaultError::Conflict(format!(
                "item `{}` is at version {} (id {}); re-read it and retry",
                coords.policy_key(),
                row.version,
                row.id
            ))
            .into());
        }
        if cards::is_card_item(&row.kind, &row.fields) {
            return Err(invalid("card items have a fixed schema"));
        }
        if row
            .fields
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&def.name))
        {
            return Err(VaultError::Conflict(format!(
                "item `{}` already has a field `{}`",
                coords.policy_key(),
                def.name
            ))
            .into());
        }
        if row.fields.len() >= MAX_FIELDS {
            return Err(invalid(format!("an item has 1 to {MAX_FIELDS} fields")));
        }
        let mut fields = row.fields.clone();
        fields.push(def.clone());
        let version = row.version + 1;
        tx.execute(
            "UPDATE vault_items SET fields = ?1, version = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                serde_json::to_string(&fields)?,
                version,
                now_millis(),
                row.id
            ],
        )?;
        let data = json!({ "field": def.name, "type": def.field_type });
        append_event(&tx, &row.id, coords, "field_added", version, actor, &data)?;
        self.audit_locked(&tx, &audit_entry(actor, "item.add_field", coords, data));
        let row = find_item(&tx, coords)?.ok_or_else(|| not_found(coords))?;
        let view = self.item_view_locked(&tx, coords, &row, false)?;
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok(view)
    }
}

#[cfg(test)]
#[path = "add_field_tests.rs"]
mod tests;
