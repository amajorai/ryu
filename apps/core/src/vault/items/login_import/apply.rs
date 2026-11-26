//! Saving the records the user chose: new logins, and replacements of the
//! logins the user picked one by one.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::super::put::NewItem;
use super::super::*;
use super::formats::ParsedRow;
use super::plan::{existing_for, existing_logins, ExistingRef};
use super::{
    login_fields, ImportFolder, LoginImport, FIELD_NOTES, FIELD_PASSWORD, FIELD_TOTP, FIELD_URL,
    FIELD_USERNAME, LOGIN_KIND,
};

/// The user's choice to replace the login a duplicate matches. The id and
/// version are the ones the preview showed; if the item changed since, the
/// record is reported as a conflict and nothing is replaced.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceChoice {
    pub row: usize,
    pub expected_id: String,
    pub expected_version: i64,
}

/// What to save, with the caller's rights already resolved.
pub struct ApplyInput<'a> {
    /// Records to add as new logins and the key each one gets. The caller
    /// holds `write` on every key.
    pub create: &'a BTreeMap<usize, String>,
    /// Chosen records the caller may not write; reported as denied.
    pub denied: &'a BTreeSet<usize>,
    /// Duplicates the user chose to replace.
    pub replace: &'a [ReplaceChoice],
    /// Ids of the folder's items whose non-sensitive values the caller may see.
    pub readable: &'a BTreeSet<String>,
    /// Ids of the folder's items the caller may change.
    pub writable: &'a BTreeSet<String>,
}

/// What happened to one chosen record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowOutcome {
    /// Saved as a new login.
    Created,
    /// The password of the matching login was replaced.
    Replaced,
    /// The folder already holds this login and the user did not choose to
    /// replace it.
    SkippedDuplicate,
    /// The login to replace changed or is gone, or the new key is taken.
    Conflict,
    /// The caller may not write this login.
    Denied,
    /// The record cannot be imported.
    Invalid,
}

/// One chosen record in a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRow {
    pub row: usize,
    pub outcome: RowOutcome,
    /// The key of the item created or replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// What an import saved. It carries no value of any login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginImportResult {
    pub created: usize,
    pub replaced: usize,
    pub skipped: usize,
    pub rows: Vec<AppliedRow>,
}

/// The stored values of a new login, validated like values entered by hand.
fn new_values(fields: &[FieldDef], row: &ParsedRow) -> Result<BTreeMap<String, String>> {
    let supplied = [
        (FIELD_URL, row.site.as_deref()),
        (FIELD_USERNAME, row.username.as_deref()),
        (FIELD_PASSWORD, row.password.as_deref()),
        (FIELD_TOTP, row.totp.as_deref()),
        (FIELD_NOTES, row.notes.as_deref()),
    ];
    let mut values = BTreeMap::new();
    for (name, value) in supplied {
        if let Some(value) = value {
            let def = field_def(fields, name)?;
            values.insert(name.to_owned(), normalize_value(def, value)?);
        }
    }
    Ok(values)
}

impl PluginSecretStore {
    /// Save the chosen records of `import` into `folder` in one transaction:
    /// every chosen record is saved, or none is when the vault fails.
    ///
    /// A record in `create` that matches a login already in the folder is
    /// skipped, never merged or replaced. A login is replaced only through a
    /// [`ReplaceChoice`] that names its current id and version, and only its
    /// password (and its authenticator seed, when the record has one and the
    /// item has such a field) is written.
    pub async fn login_import_apply(
        &self,
        folder: &ImportFolder,
        import: &LoginImport,
        input: &ApplyInput<'_>,
        actor: &AuditActor,
    ) -> Result<LoginImportResult> {
        let fields = login_fields();
        let replacing: BTreeSet<usize> = input.replace.iter().map(|choice| choice.row).collect();

        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let existing = existing_logins(self, &tx, folder, input.readable)?;
        let mut rows: Vec<AppliedRow> = Vec::new();
        let mut done = |row: usize, outcome: RowOutcome, key: Option<&str>| {
            rows.push(AppliedRow {
                row,
                outcome,
                key: key.map(str::to_owned),
            });
        };

        for (&number, key) in input.create {
            if replacing.contains(&number) || input.denied.contains(&number) {
                continue;
            }
            let Some(row) = import.importable(number) else {
                done(number, RowOutcome::Invalid, None);
                continue;
            };
            if existing_for(&existing, row).is_some() {
                done(number, RowOutcome::SkippedDuplicate, None);
                continue;
            }
            let coords = folder.coords(key)?;
            if find_item(&tx, &coords)?.is_some() {
                done(number, RowOutcome::Conflict, None);
                continue;
            }
            let Ok(values) = new_values(&fields, row) else {
                done(number, RowOutcome::Invalid, None);
                continue;
            };
            self.insert_item_locked(
                &tx,
                &NewItem {
                    coords: &coords,
                    kind: LOGIN_KIND,
                    description: row.title.as_deref(),
                    fields: &fields,
                    values: &values,
                    card_merchants: None,
                },
                actor,
            )?;
            done(number, RowOutcome::Created, Some(key.as_str()));
        }
        for &number in input.denied {
            done(number, RowOutcome::Denied, None);
        }

        let mut replaced_rows: BTreeSet<usize> = BTreeSet::new();
        let mut replaced_items: BTreeSet<&str> = BTreeSet::new();
        for choice in input.replace {
            let number = choice.row;
            if input.denied.contains(&number) || !replaced_rows.insert(number) {
                continue;
            }
            let Some(row) = import.importable(number) else {
                done(number, RowOutcome::Invalid, None);
                continue;
            };
            let Some(target) = existing_for(&existing, row) else {
                done(number, RowOutcome::Conflict, None);
                continue;
            };
            if target.id != choice.expected_id
                || target.version != choice.expected_version
                || replaced_items.contains(target.id.as_str())
            {
                done(number, RowOutcome::Conflict, None);
                continue;
            }
            if !input.writable.contains(&target.id) {
                done(number, RowOutcome::Denied, None);
                continue;
            }
            let outcome = self.replace_login_locked(&tx, folder, target, row, actor)?;
            if outcome == RowOutcome::Replaced {
                replaced_items.insert(target.id.as_str());
            }
            done(number, outcome, Some(target.key.as_str()));
        }

        rows.sort_by_key(|row| row.row);
        let count = |wanted: RowOutcome| rows.iter().filter(|row| row.outcome == wanted).count();
        let (created, replaced) = (count(RowOutcome::Created), count(RowOutcome::Replaced));
        let skipped = rows.len() - created - replaced;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "item.login_import", "ok").details(json!({
                "environment": folder.environment,
                "path": folder.path,
                "format": import.format(),
                "created": created,
                "replaced": replaced,
                "skipped": skipped,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        drop(conn);
        if created + replaced > 0 {
            notify_events();
        }
        Ok(LoginImportResult {
            created,
            replaced,
            skipped,
            rows,
        })
    }

    /// Write the password of `row` (and its authenticator seed, when the item
    /// has a field for one) into the item `target` names. The item is read
    /// again inside the transaction, so a stale `target` is a conflict.
    fn replace_login_locked(
        &self,
        conn: &Connection,
        folder: &ImportFolder,
        target: &ExistingRef,
        row: &ParsedRow,
        actor: &AuditActor,
    ) -> Result<RowOutcome> {
        let coords = folder.coords(&target.key)?;
        let Some(item) = find_item(conn, &coords)? else {
            return Ok(RowOutcome::Conflict);
        };
        if item.id != target.id || item.version != target.version {
            return Ok(RowOutcome::Conflict);
        }
        if cards::is_card_item(&item.kind, &item.fields) {
            return Ok(RowOutcome::Invalid);
        }
        let typed = |wanted: FieldType| item.fields.iter().find(|def| def.field_type == wanted);
        let (Some(password_field), Some(password)) = (typed(FieldType::Password), &row.password)
        else {
            return Ok(RowOutcome::Invalid);
        };
        let Ok(password) = normalize_value(password_field, password) else {
            return Ok(RowOutcome::Invalid);
        };
        self.put_value(conn, &item.id, &password_field.name, &password)?;
        let mut set = vec![password_field.name.clone()];
        if let (Some(totp_field), Some(seed)) = (typed(FieldType::Totp), &row.totp) {
            if let Ok(seed) = normalize_value(totp_field, seed) {
                self.put_value(conn, &item.id, &totp_field.name, &seed)?;
                set.push(totp_field.name.clone());
            }
        }
        let present = fields_with_values(conn, &item.id)?;
        let status = status_for(&item.fields, &present);
        let version = item.version + 1;
        conn.execute(
            "UPDATE vault_items SET version = ?1, status = ?2, updated_at = ?3 WHERE id = ?4",
            params![version, status.as_str(), now_millis(), item.id],
        )?;
        let data = json!({
            "fieldsSet": set,
            "fieldsCleared": [],
            "descriptionChanged": false,
            "merchantsChanged": false,
            "source": "login_import",
        });
        append_event(conn, &item.id, &coords, "updated", version, actor, &data)?;
        if status != item.status {
            append_event(
                conn,
                &item.id,
                &coords,
                "status_changed",
                version,
                actor,
                &json!({ "from": item.status.as_str(), "to": status.as_str() }),
            )?;
        }
        self.audit_locked(conn, &audit_entry(actor, "item.update", &coords, data));
        Ok(RowOutcome::Replaced)
    }
}
