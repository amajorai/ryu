//! The password exports the import reads, told apart by their header row,
//! and the reading of one record into a login.
//!
//! | Export | Header columns used |
//! |---|---|
//! | Chrome and other Chromium browsers | `name`, `url`, `username`, `password`, `note` |
//! | Firefox | `url`, `username`, `password` (told apart by `httpRealm`, `formActionOrigin` or `guid`) |
//! | Safari and Apple Passwords | `Title`, `URL`, `Username`, `Password`, `Notes`, `OTPAuth` |
//! | Bitwarden | `type`, `name`, `notes`, `login_uri`, `login_username`, `login_password`, `login_totp` |
//! | 1Password | `Title`, `Url` or `Website`, `Username`, `Password`, `OTPAuth`, `Notes` (told apart by `Favorite`, `Archived` or `Tags`) |
//!
//! Column names are matched without regard to case, and other columns are
//! ignored. A record whose cell count differs from the header's is refused
//! whole and none of its cells is shown, so a shifted column cannot put a
//! password where a username is expected.

use serde::Serialize;

use super::super::{normalize_totp_seed, MAX_VALUE_BYTES};

/// Longest title kept as the item description.
const MAX_TITLE_CHARS: usize = 200;
/// Longest site address kept.
const MAX_SITE_CHARS: usize = 2048;
/// Longest username kept.
const MAX_USERNAME_CHARS: usize = 320;

/// Which product wrote the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum LoginCsvFormat {
    #[serde(rename = "chrome")]
    Chrome,
    #[serde(rename = "firefox")]
    Firefox,
    #[serde(rename = "safari")]
    Safari,
    #[serde(rename = "bitwarden")]
    Bitwarden,
    #[serde(rename = "1password")]
    OnePassword,
}

/// Where each value sits in a record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Columns {
    pub(super) format: LoginCsvFormat,
    width: usize,
    title: Option<usize>,
    url: usize,
    username: Option<usize>,
    password: usize,
    totp: Option<usize>,
    notes: Option<usize>,
    /// Bitwarden's `type` column: only `login` records are logins.
    kind: Option<usize>,
}

/// Recognize the export from its header row, or `None` for any other file.
pub(super) fn detect(header: &[String]) -> Option<Columns> {
    let names: Vec<String> = header
        .iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .collect();
    let find = |wanted: &[&str]| {
        names
            .iter()
            .position(|name| wanted.contains(&name.as_str()))
    };
    let columns = |format, title, url, username, password, totp, notes, kind| Columns {
        format,
        width: names.len(),
        title,
        url,
        username,
        password,
        totp,
        notes,
        kind,
    };

    if let (Some(url), Some(password)) = (find(&["login_uri"]), find(&["login_password"])) {
        return Some(columns(
            LoginCsvFormat::Bitwarden,
            find(&["name"]),
            url,
            find(&["login_username"]),
            password,
            find(&["login_totp"]),
            find(&["notes"]),
            find(&["type"]),
        ));
    }
    let password = find(&["password"])?;
    let url = find(&["url", "website"])?;
    let username = Some(find(&["username"])?);
    if find(&["httprealm", "formactionorigin", "guid"]).is_some() {
        return Some(columns(
            LoginCsvFormat::Firefox,
            None,
            url,
            username,
            password,
            None,
            None,
            None,
        ));
    }
    if let Some(title) = find(&["title"]) {
        let format = if find(&["favorite", "archived", "tags"]).is_some() {
            LoginCsvFormat::OnePassword
        } else {
            LoginCsvFormat::Safari
        };
        return Some(columns(
            format,
            Some(title),
            url,
            username,
            password,
            find(&["otpauth", "one-time password"]),
            find(&["notes"]),
            None,
        ));
    }
    let title = find(&["name"])?;
    Some(columns(
        LoginCsvFormat::Chrome,
        Some(title),
        url,
        username,
        password,
        None,
        find(&["note", "notes"]),
        None,
    ))
}

/// One record read as a login. Holds secrets, so it has no `Debug`.
pub(super) struct ParsedRow {
    /// The record's number in the file, counting the header as 1.
    pub(super) row: usize,
    pub(super) title: Option<String>,
    /// The site address without user name, password, query or fragment.
    pub(super) site: Option<String>,
    /// The site's host, lowercase and without a leading `www.`.
    pub(super) host: Option<String>,
    pub(super) username: Option<String>,
    pub(super) password: Option<String>,
    /// A Base32 authenticator seed.
    pub(super) totp: Option<String>,
    /// The record had an authenticator key that cannot be used.
    pub(super) totp_dropped: bool,
    pub(super) notes: Option<String>,
    /// Why the record cannot be imported, as a stable code.
    pub(super) problem: Option<&'static str>,
}

/// The record's cells differ in number from the header's.
pub(super) const PROBLEM_MALFORMED: &str = "malformed";
/// A Bitwarden record that is not a login (a note, card or identity).
pub(super) const PROBLEM_NOT_LOGIN: &str = "not_login";
/// No `http` or `https` address.
pub(super) const PROBLEM_NO_SITE: &str = "no_site";
/// No password.
pub(super) const PROBLEM_NO_PASSWORD: &str = "no_password";
/// A value is too long, or a one-line value holds a line break.
pub(super) const PROBLEM_INVALID_VALUE: &str = "invalid_value";

/// Parse a site address into its stored form and its host. A bare host is
/// read as `https://host`. User name, password, query and fragment are
/// dropped: the address is not a sensitive field, and those parts can hold a
/// credential or a token.
pub(super) fn site_of(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > MAX_SITE_CHARS {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let mut parsed = url::Url::parse(&with_scheme).ok()?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    parsed.set_username("").ok()?;
    parsed.set_password(None).ok()?;
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some((parsed.to_string(), host))
}

/// A Base32 seed from a seed or an `otpauth://totp/` address with the usual
/// parameters (SHA-1, 6 digits, 30 seconds). Anything else cannot produce
/// working codes from a stored seed and is left out.
fn totp_seed(raw: &str) -> Option<String> {
    let is_uri = raw
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"));
    if is_uri {
        let parsed = url::Url::parse(raw).ok()?;
        let usual = parsed
            .query_pairs()
            .all(|(name, value)| match name.as_ref() {
                "algorithm" => value.eq_ignore_ascii_case("SHA1"),
                "digits" => value == "6",
                "period" => value == "30",
                _ => true,
            });
        if !usual {
            return None;
        }
    }
    normalize_totp_seed(raw)
}

fn one_line(value: &str) -> bool {
    !value.contains(['\n', '\r', '\0'])
}

/// A short single-line label: control characters become spaces.
fn label(raw: &str) -> Option<String> {
    let text: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(MAX_TITLE_CHARS).collect())
}

/// Read one record. `row` counts the header as 1.
pub(super) fn read_row(columns: &Columns, row: usize, cells: &[String]) -> ParsedRow {
    let mut out = ParsedRow {
        row,
        title: None,
        site: None,
        host: None,
        username: None,
        password: None,
        totp: None,
        totp_dropped: false,
        notes: None,
        problem: None,
    };
    if cells.len() != columns.width {
        out.problem = Some(PROBLEM_MALFORMED);
        return out;
    }
    let cell = |index: Option<usize>| index.map(|index| cells[index].as_str()).unwrap_or("");
    out.title = label(cell(columns.title));
    if columns.kind.is_some() && !cell(columns.kind).trim().eq_ignore_ascii_case("login") {
        out.problem = Some(PROBLEM_NOT_LOGIN);
        return out;
    }
    // Bitwarden writes several addresses into one cell, separated by commas.
    let address = cell(Some(columns.url));
    let site = if columns.format == LoginCsvFormat::Bitwarden {
        address.split(',').find_map(site_of)
    } else {
        site_of(address)
    };
    if let Some((site, host)) = site {
        out.site = Some(site);
        out.host = Some(host);
    }
    let username = cell(columns.username).trim();
    let username_ok = one_line(username) && username.chars().count() <= MAX_USERNAME_CHARS;
    if username_ok && !username.is_empty() {
        out.username = Some(username.to_owned());
    }
    // A password is kept exactly as written, spaces included.
    let password = cell(Some(columns.password));
    let password_ok = one_line(password) && password.len() <= MAX_VALUE_BYTES;
    let notes = cell(columns.notes);
    let notes_ok = notes.len() <= MAX_VALUE_BYTES;

    out.problem = if out.site.is_none() {
        Some(PROBLEM_NO_SITE)
    } else if password.is_empty() {
        Some(PROBLEM_NO_PASSWORD)
    } else if !(username_ok && password_ok && notes_ok) {
        Some(PROBLEM_INVALID_VALUE)
    } else {
        None
    };
    if out.problem.is_some() {
        return out;
    }
    out.password = Some(password.to_owned());
    if !notes.trim().is_empty() {
        out.notes = Some(notes.to_owned());
    }
    let totp = cell(columns.totp).trim();
    if !totp.is_empty() {
        out.totp = totp_seed(totp);
        out.totp_dropped = out.totp.is_none();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(text: &str) -> Vec<String> {
        text.split(',').map(str::to_owned).collect()
    }

    #[test]
    fn each_export_is_recognized_by_its_header() {
        let cases = [
            ("name,url,username,password,note", LoginCsvFormat::Chrome),
            ("name,url,username,password", LoginCsvFormat::Chrome),
            (
                "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged",
                LoginCsvFormat::Firefox,
            ),
            ("Title,URL,Username,Password,Notes,OTPAuth", LoginCsvFormat::Safari),
            (
                "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
                LoginCsvFormat::Bitwarden,
            ),
            (
                "collections,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
                LoginCsvFormat::Bitwarden,
            ),
            (
                "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
                LoginCsvFormat::OnePassword,
            ),
        ];
        for (text, format) in cases {
            assert_eq!(
                detect(&header(text)).map(|c| c.format),
                Some(format),
                "{text}"
            );
        }
    }

    #[test]
    fn other_headers_are_not_recognized() {
        for text in [
            "name,value",
            "https://example.com,ada,made-up-password",
            "url,password",
            "title,username,password",
            "",
        ] {
            assert!(detect(&header(text)).is_none(), "{text}");
        }
    }

    #[test]
    fn a_site_loses_credentials_query_and_fragment_and_keeps_its_path() {
        assert_eq!(
            site_of("https://ada:made-up@www.Example.com/login?token=abc#top"),
            Some(("https://www.example.com/login".into(), "example.com".into()))
        );
        assert_eq!(
            site_of("example.com"),
            Some(("https://example.com/".into(), "example.com".into()))
        );
        for raw in [
            "",
            "android://hash@com.example.app/",
            "ftp://example.com",
            "not a url",
        ] {
            assert_eq!(site_of(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_shifted_record_shows_no_cell() {
        let columns = detect(&header("name,url,username,password")).unwrap();
        let cells = header("Example,https://example.com,made-up-password");
        let row = read_row(&columns, 2, &cells);
        assert_eq!(row.problem, Some(PROBLEM_MALFORMED));
        assert!(row.title.is_none() && row.site.is_none() && row.username.is_none());
        assert!(row.password.is_none());
    }

    #[test]
    fn an_authenticator_key_with_other_parameters_is_left_out() {
        let columns = detect(&header("Title,URL,Username,Password,Notes,OTPAuth")).unwrap();
        let read = |otp: &str| {
            let cells: Vec<String> = ["Example", "https://example.com", "ada", "made-up", "", otp]
                .iter()
                .map(|cell| (*cell).to_owned())
                .collect();
            read_row(&columns, 2, &cells)
        };
        let usual = read("otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example");
        assert_eq!(usual.totp.as_deref(), Some("JBSWY3DPEHPK3PXP"));
        assert!(!usual.totp_dropped);
        let other = read("otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&digits=8");
        assert!(other.totp.is_none() && other.totp_dropped);
        assert!(other.problem.is_none(), "the login is still imported");
        let none = read("");
        assert!(none.totp.is_none() && !none.totp_dropped);
    }
}
