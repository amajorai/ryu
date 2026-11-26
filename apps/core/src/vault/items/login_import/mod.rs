//! Import of saved logins from a password export (CSV).
//!
//! The file is read on this node and nowhere else. A caller sends its text
//! twice: once for a preview ([`PluginSecretStore::login_import_preview`]),
//! which saves nothing, and once to apply the rows the user chose
//! ([`PluginSecretStore::login_import_apply`]). Core keeps nothing between the
//! two and never writes the text to disk.
//!
//! * Each imported login becomes a `login` item with the fixed schema of
//!   [`login_fields`], sealed field by field like an item added by hand, with
//!   the same events and audit rows. Nothing else changes: an agent can fill
//!   an imported login only after the user attaches it to a fill set.
//! * A row whose site and username match an item the caller can read is a
//!   duplicate. It is skipped unless the user chose to replace that item, by
//!   its id and version.
//! * No preview, result, error, event or audit row carries a password, an
//!   authenticator seed or a note.

use std::collections::HashSet;

use super::*;

mod apply;
mod csv;
mod formats;
mod plan;

#[cfg(test)]
mod apply_tests;
#[cfg(test)]
mod plan_tests;

pub use apply::{AppliedRow, ApplyInput, LoginImportResult, ReplaceChoice, RowOutcome};
pub use formats::LoginCsvFormat;
pub use plan::{ExistingRef, LoginImportPreview, PreviewCounts, PreviewRow, RowStatus};

use formats::ParsedRow;

/// Most logins (records after the header) one file may hold.
pub const MAX_IMPORT_ROWS: usize = 20_000;
/// The kind of an imported item.
pub const LOGIN_KIND: &str = "login";

const FIELD_URL: &str = "url";
const FIELD_USERNAME: &str = "username";
const FIELD_PASSWORD: &str = "password";
const FIELD_TOTP: &str = "totp";
const FIELD_NOTES: &str = "notes";

/// The same login (site, username and password) appears earlier in the file.
const PROBLEM_REPEATED: &str = "repeated";
/// Longest host kept in an item key.
const MAX_KEY_HOST_LEN: usize = 80;
/// Random characters at the end of an item key.
const KEY_SUFFIX_LEN: usize = 10;

/// Why a file cannot be imported at all. No variant carries file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginImportError {
    /// No header row, or no record after it.
    Empty,
    /// The first row is not the header of a known export.
    UnknownFormat,
    /// A quoted cell never closes. `record` counts from 1.
    UnterminatedQuote { record: usize },
    /// More than [`MAX_IMPORT_ROWS`] logins.
    TooManyRows,
}

impl LoginImportError {
    /// Stable machine-readable code.
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "login_import_empty",
            Self::UnknownFormat => "login_import_unknown_format",
            Self::UnterminatedQuote { .. } => "login_import_unreadable",
            Self::TooManyRows => "login_import_too_many_rows",
        }
    }
}

impl std::fmt::Display for LoginImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = self.code();
        match self {
            Self::Empty => write!(f, "{code}: the file holds no logins"),
            Self::UnknownFormat => write!(
                f,
                "{code}: the first row is not the header of a Chrome, Firefox, Safari, \
                 Bitwarden or 1Password password export"
            ),
            Self::UnterminatedQuote { record } => {
                write!(f, "{code}: record {record} has a quote that never closes")
            }
            Self::TooManyRows => {
                write!(
                    f,
                    "{code}: the file holds more than {MAX_IMPORT_ROWS} logins"
                )
            }
        }
    }
}

impl std::error::Error for LoginImportError {}

/// The environment and folder an import writes into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFolder {
    pub environment: String,
    pub path: String,
}

impl ImportFolder {
    /// Validate and normalize, with the same defaults as an item.
    pub fn new(environment: Option<&str>, path: Option<&str>) -> Result<Self> {
        let coords = ItemCoords::new(environment, path, "import")?;
        Ok(Self {
            environment: coords.environment,
            path: coords.path,
        })
    }

    /// The coordinates of `key` in this folder.
    pub fn coords(&self, key: &str) -> Result<ItemCoords> {
        ItemCoords::new(Some(&self.environment), Some(&self.path), key)
    }
}

/// The schema of every imported login. Only the password is required. A note
/// is sensitive: people keep recovery codes in them.
pub fn login_fields() -> Vec<FieldDef> {
    let field = |name: &str, field_type, required, sensitive| FieldDef {
        name: name.to_owned(),
        label: None,
        field_type,
        required,
        sensitive,
    };
    vec![
        field(FIELD_URL, FieldType::Url, false, false),
        field(FIELD_USERNAME, FieldType::Text, false, false),
        field(FIELD_PASSWORD, FieldType::Password, true, true),
        field(FIELD_TOTP, FieldType::Totp, false, true),
        field(FIELD_NOTES, FieldType::Note, false, true),
    ]
}

/// A new item key for a login on a host, made of the host and random characters.
/// It names the site only, so a caller who may list items but not read them
/// learns no username from it.
pub fn new_item_key(host: &str) -> String {
    let host: String = host
        .chars()
        .take(MAX_KEY_HOST_LEN)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let host = host.trim_matches(|c| c == '.' || c == '-');
    let host = if host.is_empty() { "login" } else { host };
    let mut suffix = String::with_capacity(KEY_SUFFIX_LEN);
    while suffix.len() < KEY_SUFFIX_LEN {
        suffix.extend(
            random_token("")
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .take(KEY_SUFFIX_LEN - suffix.len()),
        );
    }
    format!("{host}--{suffix}")
}

/// The site and username two logins must share to be the same login.
/// Usernames are compared without regard to case.
fn match_key(host: &str, username: Option<&str>) -> (String, String) {
    (
        host.to_owned(),
        username.map(str::trim).unwrap_or("").to_lowercase(),
    )
}

/// A parsed export. It holds passwords, so it has no `Debug` and is never
/// serialized.
pub struct LoginImport {
    format: LoginCsvFormat,
    rows: Vec<ParsedRow>,
}

impl LoginImport {
    /// Read a password export. Cells are data: nothing in them is evaluated.
    pub fn parse(text: &str) -> std::result::Result<Self, LoginImportError> {
        // One more than the limit for the header row.
        let mut records = csv::parse(text, MAX_IMPORT_ROWS + 1).map_err(|error| match error {
            csv::CsvError::UnterminatedQuote { record } => {
                LoginImportError::UnterminatedQuote { record }
            }
            csv::CsvError::TooManyRecords => LoginImportError::TooManyRows,
        })?;
        if records.is_empty() {
            return Err(LoginImportError::Empty);
        }
        let header = records.remove(0);
        let columns = formats::detect(&header).ok_or(LoginImportError::UnknownFormat)?;
        if records.is_empty() {
            return Err(LoginImportError::Empty);
        }
        let mut rows: Vec<ParsedRow> = records
            .iter()
            .enumerate()
            .map(|(index, cells)| formats::read_row(&columns, index + 2, cells))
            .collect();
        for index in repeated_rows(&rows) {
            rows[index].problem = Some(PROBLEM_REPEATED);
        }
        Ok(Self {
            format: columns.format,
            rows,
        })
    }

    /// Which product wrote the file.
    pub fn format(&self) -> LoginCsvFormat {
        self.format
    }

    /// Number of records after the header.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether the file holds no record. A parsed file always holds one.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    fn rows(&self) -> &[ParsedRow] {
        &self.rows
    }

    /// The row numbered `row` (the header is row 1) when it can be imported.
    fn importable(&self, row: usize) -> Option<&ParsedRow> {
        row.checked_sub(2)
            .and_then(|index| self.rows.get(index))
            .filter(|row| row.problem.is_none())
    }

    /// The host of the site of row `row` when the row can be imported. A
    /// caller builds the new item's key from it ([`new_item_key`]) to check
    /// its right to write there.
    pub fn importable_host(&self, row: usize) -> Option<&str> {
        self.importable(row).and_then(|row| row.host.as_deref())
    }
}

/// Indexes of importable rows that repeat an earlier importable row exactly.
fn repeated_rows(rows: &[ParsedRow]) -> Vec<usize> {
    let mut seen: HashSet<(&str, String, &str)> = HashSet::new();
    let mut repeated = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let (Some(host), Some(password), None) = (&row.host, &row.password, row.problem) else {
            continue;
        };
        let username = row.username.as_deref().unwrap_or("").trim().to_lowercase();
        if !seen.insert((host.as_str(), username, password.as_str())) {
            repeated.push(index);
        }
    }
    repeated
}

/// A status code for a row, for the preview.
fn problem_status(problem: Option<&'static str>) -> Option<RowStatus> {
    match problem {
        None => None,
        Some(PROBLEM_REPEATED) => Some(RowStatus::Repeated),
        Some(_) => Some(RowStatus::Invalid),
    }
}
