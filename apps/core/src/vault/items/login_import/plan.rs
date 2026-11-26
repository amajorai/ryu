//! The preview of an import: what each record would do, and which records
//! match a login that is already in the vault.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use super::super::*;
use super::formats::{site_of, ParsedRow};
use super::{match_key, problem_status, ImportFolder, LoginCsvFormat, LoginImport};

/// What a record would do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    /// A login the vault does not hold yet.
    New,
    /// The folder already holds a login for this site and username.
    Duplicate,
    /// The same login appears earlier in the file.
    Repeated,
    /// The record cannot be imported (see `problem`).
    Invalid,
}

/// The item a duplicate matches. Replacing it must name `id` and `version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingRef {
    pub key: String,
    pub id: String,
    pub version: i64,
}

/// One record in a preview. It never carries a password, an authenticator
/// seed or a note, only whether the record has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRow {
    /// The record's number in the file, counting the header as 1.
    pub row: usize,
    pub status: RowStatus,
    /// Why the record cannot be imported, as a stable code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub has_totp: bool,
    /// The record had an authenticator key that cannot be used and is left out.
    pub totp_dropped: bool,
    pub has_notes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing: Option<ExistingRef>,
}

/// How many records have each status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCounts {
    pub total: usize,
    pub new: usize,
    pub duplicate: usize,
    pub repeated: usize,
    pub invalid: usize,
}

/// What an import would do. Nothing has been saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginImportPreview {
    pub format: LoginCsvFormat,
    pub environment: String,
    pub path: String,
    pub counts: PreviewCounts,
    pub rows: Vec<PreviewRow>,
}

/// Logins already in a folder, by site host and lowercase username.
pub(super) type ExistingLogins = HashMap<(String, String), ExistingRef>;

/// The name of the non-sensitive field of an item that holds its username:
/// a text field named like one, else the first text field, else an email
/// field (the rule a fill uses).
fn username_field(fields: &[FieldDef]) -> Option<&str> {
    let plain = |wanted: FieldType| {
        fields
            .iter()
            .filter(move |field| field.field_type == wanted && !field.sensitive)
            .map(|field| field.name.as_str())
    };
    let named = |name: &str| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "username" | "user" | "login" | "user_name"
        )
    };
    plain(FieldType::Text)
        .find(|name| named(name))
        .or_else(|| plain(FieldType::Text).next())
        .or_else(|| plain(FieldType::Email).next())
}

/// Index the logins of `folder` whose non-sensitive values the caller may
/// see (`readable` holds their item ids). An item the caller cannot read is
/// left out, so a preview tells a caller nothing it could not read itself.
/// Only non-sensitive values are opened.
pub(super) fn existing_logins(
    store: &PluginSecretStore,
    conn: &Connection,
    folder: &ImportFolder,
    readable: &BTreeSet<String>,
) -> Result<ExistingLogins> {
    let mut stmt = conn.prepare(
        "SELECT id, item_key, kind, fields, version FROM vault_items
         WHERE environment = ?1 AND path = ?2 ORDER BY item_key",
    )?;
    let rows = stmt.query_map(params![folder.environment, folder.path], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut out = ExistingLogins::new();
    for row in rows {
        let (id, key, kind, fields, version) = row?;
        if !readable.contains(&id) || kind == cards::CARD_KIND {
            continue;
        }
        let fields: Vec<FieldDef> =
            serde_json::from_str(&fields).context("decoding item field definitions")?;
        let Some(url_field) = fields
            .iter()
            .find(|field| field.field_type == FieldType::Url && !field.sensitive)
        else {
            continue;
        };
        let Some(address) = store.open_value(conn, &id, &url_field.name)? else {
            continue;
        };
        let Some((_, host)) = site_of(&address) else {
            continue;
        };
        let username = match username_field(&fields) {
            Some(name) => store.open_value(conn, &id, name)?,
            None => None,
        };
        out.entry(match_key(&host, username.as_deref()))
            .or_insert(ExistingRef { key, id, version });
    }
    Ok(out)
}

/// The item `row` duplicates, if any.
pub(super) fn existing_for<'a>(
    existing: &'a ExistingLogins,
    row: &ParsedRow,
) -> Option<&'a ExistingRef> {
    let host = row.host.as_deref()?;
    existing.get(&match_key(host, row.username.as_deref()))
}

/// Describe every record of `import` against the logins in `existing`.
pub(super) fn preview_of(
    folder: &ImportFolder,
    import: &LoginImport,
    existing: &ExistingLogins,
) -> LoginImportPreview {
    let mut counts = PreviewCounts {
        total: import.len(),
        ..PreviewCounts::default()
    };
    let rows = import
        .rows()
        .iter()
        .map(|row| {
            let matched = if row.problem.is_none() {
                existing_for(existing, row).cloned()
            } else {
                None
            };
            let status = match (problem_status(row.problem), &matched) {
                (Some(status), _) => status,
                (None, Some(_)) => RowStatus::Duplicate,
                (None, None) => RowStatus::New,
            };
            match status {
                RowStatus::New => counts.new += 1,
                RowStatus::Duplicate => counts.duplicate += 1,
                RowStatus::Repeated => counts.repeated += 1,
                RowStatus::Invalid => counts.invalid += 1,
            }
            PreviewRow {
                row: row.row,
                status,
                problem: row.problem,
                title: row.title.clone(),
                site: row.site.clone(),
                host: row.host.clone(),
                username: row.username.clone(),
                has_totp: row.totp.is_some(),
                totp_dropped: row.totp_dropped,
                has_notes: row.notes.is_some(),
                existing: matched,
            }
        })
        .collect();
    LoginImportPreview {
        format: import.format(),
        environment: folder.environment.clone(),
        path: folder.path.clone(),
        counts,
        rows,
    }
}

impl PluginSecretStore {
    /// What importing `import` into `folder` would do. Saves nothing.
    /// `readable` holds the ids of the folder's items whose non-sensitive
    /// values the caller may see; only those can be reported as duplicates.
    pub async fn login_import_preview(
        &self,
        folder: &ImportFolder,
        import: &LoginImport,
        readable: &BTreeSet<String>,
    ) -> Result<LoginImportPreview> {
        let existing = {
            let conn = self.conn.lock().await;
            existing_logins(self, &conn, folder, readable)?
        };
        Ok(preview_of(folder, import, &existing))
    }
}
