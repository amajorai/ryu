//! `PUT`: the idempotent item upsert.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

/// A new item to insert: where it lives, its schema and its values.
pub(super) struct NewItem<'a> {
    pub(super) coords: &'a ItemCoords,
    pub(super) kind: &'a str,
    pub(super) description: Option<&'a str>,
    pub(super) fields: &'a [FieldDef],
    pub(super) values: &'a BTreeMap<String, String>,
    /// The merchant allowlist of a `card` item; `None` for any other kind.
    pub(super) card_merchants: Option<&'a [String]>,
}

impl PluginSecretStore {
    /// Idempotent upsert. Creates the item (`Created`), or, when an item with
    /// the same kind, description, and field schema exists and every supplied
    /// value equals the stored one, returns it untouched (`Unchanged`). A
    /// different schema or description, a different supplied value, or a
    /// supplied value `access` does not allow the caller to see is a conflict:
    /// change values with [`Self::item_patch`]. The conflict never names the
    /// field, so `PUT` is not an equality oracle for values the caller could
    /// not otherwise read.
    pub async fn item_put(
        &self,
        key: &str,
        input: ItemPut,
        actor: &AuditActor,
        access: PutAccess,
    ) -> Result<(PutOutcome, ItemView)> {
        let coords = ItemCoords::new(input.environment.as_deref(), input.path.as_deref(), key)?;
        let kind = input.kind.as_deref().map(str::trim).unwrap_or("generic");
        if !is_valid_kind(kind) {
            return Err(invalid(
                "kind is a lowercase slug of at most 32 characters (e.g. `login`)",
            ));
        }
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned);
        if description
            .as_deref()
            .is_some_and(|text| text.chars().count() > MAX_DESCRIPTION_LEN)
        {
            return Err(invalid(format!(
                "description exceeds {MAX_DESCRIPTION_LEN} characters"
            )));
        }
        let is_card = kind == cards::CARD_KIND;
        let fields = if is_card {
            if !input.fields.is_empty() {
                return Err(invalid("card items have a fixed schema; omit `fields`"));
            }
            if !cards::is_valid_card_key(key) {
                return Err(invalid(
                    "card item keys are 1-40 letters, digits, `_`, or `-` (no `__`, no leading \
                     or trailing `_`)",
                ));
            }
            cards::card_fields()
        } else {
            normalize_fields(&input.fields)?
        };
        let merchants = match (&input.merchants, is_card) {
            (Some(merchants), true) => cards::normalize_merchants(merchants)?,
            (None, true) => Vec::new(),
            (Some(_), false) => return Err(invalid("merchants apply only to card items")),
            (None, false) => Vec::new(),
        };
        let mut values = BTreeMap::new();
        for (name, value) in &input.values {
            let def = field_def(&fields, name)?;
            let value = if is_card {
                cards::normalize_card_value(def, value)?
            } else {
                normalize_value(def, value)?
            };
            values.insert(name.clone(), value);
        }
        if is_card {
            if let (Some(month), Some(year)) = (
                values.get(cards::FIELD_EXP_MONTH),
                values.get(cards::FIELD_EXP_YEAR),
            ) {
                cards::check_new_expiry(month, year, now_millis())?;
            }
        }

        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        if let Some(existing) = find_item(&tx, &coords)? {
            if existing.kind != kind || existing.fields != fields {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with a different schema",
                    coords.policy_key()
                ))
                .into());
            }
            if existing.description != description {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with a different description; use PATCH",
                    coords.policy_key()
                ))
                .into());
            }
            if is_card
                && input.merchants.is_some()
                && Self::card_merchants_locked(&tx, &existing.id)? != merchants
            {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with different merchants; use PATCH",
                    coords.policy_key()
                ))
                .into());
            }
            let values_conflict = || {
                VaultError::Conflict(format!(
                    "item `{}` exists and the supplied values cannot be confirmed; use PATCH",
                    coords.policy_key()
                ))
            };
            let mut matches = true;
            for (name, value) in &values {
                let def = field_def(&existing.fields, name)?;
                // A card number or security code is never confirmed by
                // comparison: repeated PUTs would test guesses (a CVC has
                // at most 10,000) around the per-reveal approval.
                if !access.may_compare(def) || (is_card && cards::is_restricted_field(name)) {
                    return Err(values_conflict().into());
                }
                let stored = self.open_value(&tx, &existing.id, name)?;
                // Visit every supplied field and compare digests in constant
                // time, so neither the response nor its timing says which
                // value differed.
                matches &= stored
                    .as_deref()
                    .is_some_and(|stored| digest_eq(stored, value));
            }
            if !matches {
                return Err(values_conflict().into());
            }
            if !values.is_empty() {
                let confirmed: Vec<&String> = values.keys().collect();
                self.audit_locked(
                    &tx,
                    &audit_entry(
                        actor,
                        "item.put_confirm",
                        &coords,
                        json!({ "fieldsConfirmed": confirmed }),
                    ),
                );
            }
            let view = self.item_view_locked(&tx, &coords, &existing, false)?;
            tx.commit()?;
            self.flush_audit(&conn);
            return Ok((PutOutcome::Unchanged, view));
        }

        self.insert_item_locked(
            &tx,
            &NewItem {
                coords: &coords,
                kind,
                description: description.as_deref(),
                fields: &fields,
                values: &values,
                card_merchants: is_card.then_some(merchants.as_slice()),
            },
            actor,
        )?;
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        let view = self.item_view_locked(&tx, &coords, &row, false)?;
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok((PutOutcome::Created, view))
    }

    /// Insert a new item with its values, its `created` event and its audit
    /// row. The caller holds the connection, has checked that nothing lives
    /// at the coordinates, and commits.
    pub(super) fn insert_item_locked(
        &self,
        conn: &Connection,
        item: &NewItem<'_>,
        actor: &AuditActor,
    ) -> Result<()> {
        let id = random_token("itm_");
        let now = now_millis();
        let present: BTreeSet<String> = item.values.keys().cloned().collect();
        let status = status_for(item.fields, &present);
        conn.execute(
            "INSERT INTO vault_items (id, environment, path, item_key, kind, description, fields,
                 version, status, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)",
            params![
                id,
                item.coords.environment,
                item.coords.path,
                item.coords.key,
                item.kind,
                item.description,
                serde_json::to_string(item.fields)?,
                status.as_str(),
                actor.id,
                now
            ],
        )?;
        for (name, value) in item.values {
            self.put_value(conn, &id, name, value)?;
        }
        if let Some(merchants) = item.card_merchants {
            self.card_refresh_meta_locked(conn, &id, item.coords, Some(merchants))?;
        }
        let set: Vec<&String> = item.values.keys().collect();
        append_event(
            conn,
            &id,
            item.coords,
            "created",
            1,
            actor,
            &json!({ "kind": item.kind, "fieldsSet": set, "status": status.as_str() }),
        )?;
        self.audit_locked(
            conn,
            &audit_entry(
                actor,
                "item.create",
                item.coords,
                json!({ "fieldsSet": set }),
            ),
        );
        Ok(())
    }
}
