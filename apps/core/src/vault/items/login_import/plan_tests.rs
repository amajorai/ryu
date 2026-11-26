//! Reading and previewing password exports. Every value here is made up.

use std::collections::BTreeSet;

use serde_json::json;

use super::super::*;
use super::*;

pub(super) const SEED: &str = "JBSWY3DPEHPK3PXP";

pub(super) const CHROME: &str = "name,url,username,password,note\n\
Example,https://example.com/login,ada@example.com,made-up-chrome-1,first made-up note\n\
Shop,https://shop.example.org/,grace,\"made,up \"\"chrome\"\" 2\",\n";

const FIREFOX: &str = "\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\",\"timeCreated\",\"timeLastUsed\",\"timePasswordChanged\"\r\n\
\"https://example.com\",\"ada@example.com\",\"made-up-firefox-1\",,\"https://example.com\",\"{00000000-0000-4000-8000-000000000001}\",\"1700000000000\",\"1700000000000\",\"1700000000000\"\r\n";

const SAFARI: &str = "Title,URL,Username,Password,Notes,OTPAuth\n\
Example (ada),https://example.com/,ada@example.com,made-up-safari-1,,otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example\n";

const BITWARDEN: &str = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
,,login,Example,,,0,\"https://example.com/login,https://example.com/other\",ada@example.com,made-up-bitwarden-1,JBSWY3DPEHPK3PXP\n\
,,note,A secure note,made-up note body,,0,,,,\n";

const ONE_PASSWORD: &str = "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n\
Example,https://example.com/,ada@example.com,made-up-1password-1,,false,false,,made-up recovery note\n";

pub(super) fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

pub(super) fn store() -> PluginSecretStore {
    PluginSecretStore::in_memory().unwrap()
}

pub(super) fn folder() -> ImportFolder {
    ImportFolder::new(None, None).unwrap()
}

/// The ids of every item in the default folder: a caller who may read all.
pub(super) async fn all_ids(store: &PluginSecretStore) -> BTreeSet<String> {
    let folder = folder();
    store
        .item_list(Some(&folder.environment), Some(&folder.path))
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect()
}

/// Save a login by hand, the way the item routes do.
pub(super) async fn put_login(
    store: &PluginSecretStore,
    key: &str,
    url: &str,
    username: &str,
    password: &str,
) -> ItemView {
    let put: ItemPut = serde_json::from_value(json!({
        "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": "username", "type": "text" },
            { "name": "password", "type": "password", "required": true }
        ],
        "values": { "url": url, "username": username, "password": password }
    }))
    .unwrap();
    store
        .item_put(key, put, &actor(), PutAccess::FULL)
        .await
        .unwrap()
        .1
}

async fn preview(store: &PluginSecretStore, text: &str) -> LoginImportPreview {
    let import = LoginImport::parse(text).unwrap();
    let readable = all_ids(store).await;
    store
        .login_import_preview(&folder(), &import, &readable)
        .await
        .unwrap()
}

#[tokio::test]
async fn each_export_format_previews_its_logins() {
    let store = store();
    let cases = [
        (CHROME, LoginCsvFormat::Chrome, 2, 2, false),
        (FIREFOX, LoginCsvFormat::Firefox, 1, 1, false),
        (SAFARI, LoginCsvFormat::Safari, 1, 1, true),
        (BITWARDEN, LoginCsvFormat::Bitwarden, 2, 1, true),
        (ONE_PASSWORD, LoginCsvFormat::OnePassword, 1, 1, false),
    ];
    for (text, format, total, new, has_totp) in cases {
        let preview = preview(&store, text).await;
        assert_eq!(preview.format, format);
        assert_eq!(preview.counts.total, total, "{format:?}");
        assert_eq!(preview.counts.new, new, "{format:?}");
        assert_eq!(preview.counts.duplicate, 0, "{format:?}");
        let first = &preview.rows[0];
        assert_eq!(first.row, 2);
        assert_eq!(first.status, RowStatus::New);
        assert_eq!(first.host.as_deref(), Some("example.com"), "{format:?}");
        assert_eq!(first.username.as_deref(), Some("ada@example.com"));
        assert_eq!(first.has_totp, has_totp, "{format:?}");
        assert!(first.existing.is_none());
    }
    // Nothing was saved by any preview.
    assert!(all_ids(&store).await.is_empty());
}

#[tokio::test]
async fn format_details_are_read_as_documented() {
    let store = store();
    let chrome = preview(&store, CHROME).await;
    assert_eq!(chrome.rows[0].title.as_deref(), Some("Example"));
    assert_eq!(
        chrome.rows[0].site.as_deref(),
        Some("https://example.com/login")
    );
    assert!(chrome.rows[0].has_notes && !chrome.rows[1].has_notes);
    assert_eq!(chrome.rows[1].host.as_deref(), Some("shop.example.org"));

    // Firefox has no title column; Bitwarden takes the first address of a
    // cell and reports a secure note as not a login.
    assert!(preview(&store, FIREFOX).await.rows[0].title.is_none());
    let bitwarden = preview(&store, BITWARDEN).await;
    assert_eq!(
        bitwarden.rows[0].site.as_deref(),
        Some("https://example.com/login")
    );
    assert_eq!(bitwarden.rows[1].status, RowStatus::Invalid);
    assert_eq!(bitwarden.rows[1].problem, Some("not_login"));
    assert_eq!(bitwarden.counts.invalid, 1);
    assert!(preview(&store, ONE_PASSWORD).await.rows[0].has_notes);
}

#[tokio::test]
async fn a_preview_carries_no_password_seed_or_note() {
    let store = store();
    for text in [CHROME, FIREFOX, SAFARI, BITWARDEN, ONE_PASSWORD] {
        let body = serde_json::to_string(&preview(&store, text).await).unwrap();
        for secret in [
            "made-up-",
            "made,up",
            SEED,
            "otpauth",
            "made-up note",
            "recovery",
        ] {
            assert!(!body.contains(secret), "a preview holds `{secret}`");
        }
    }
}

#[test]
fn a_broken_file_is_refused_and_its_cells_are_not_quoted_back() {
    let cases = [
        ("", LoginImportError::Empty),
        ("\n\n", LoginImportError::Empty),
        ("name,url,username,password\n", LoginImportError::Empty),
        (
            "https://example.com,made-up-user-1,made-up-headerless-1\n",
            LoginImportError::UnknownFormat,
        ),
        (
            "name,value\nx,made-up-other-1\n",
            LoginImportError::UnknownFormat,
        ),
        (
            "name,url,username,password\nExample,https://example.com,made-up-user-1,\"made-up-open-1\n",
            LoginImportError::UnterminatedQuote { record: 2 },
        ),
    ];
    for (text, expected) in cases {
        let error = LoginImport::parse(text).err().expect("the file is refused");
        assert_eq!(error, expected);
        let message = error.to_string();
        assert!(message.starts_with(error.code()), "{message}");
        // Every cell of the broken files is marked "made-up". A short name such as "ada" cannot
        // be searched for here, because the code `login_import_unreadable` holds those letters.
        assert!(!message.contains("made-up") && !message.contains("example.com"));
    }
}

#[tokio::test]
async fn records_that_cannot_be_imported_say_why_and_show_nothing_else() {
    let text = "name,url,username,password\n\
Example,https://example.com,ada,made-up-ok-1\n\
No site,,ada,made-up-nosite-1\n\
App,android://hash@com.example.app/,ada,made-up-app-1\n\
No password,https://example.org,ada,\n\
Shifted,https://example.net,made-up-shifted-1\n\
Example again,https://www.example.com/other,ADA,made-up-ok-1\n\
Other password,https://example.com,ada,made-up-ok-2\n";
    let preview = preview(&store(), text).await;
    let seen: Vec<(RowStatus, Option<&str>)> = preview
        .rows
        .iter()
        .map(|row| (row.status, row.problem))
        .collect();
    assert_eq!(
        seen,
        vec![
            (RowStatus::New, None),
            (RowStatus::Invalid, Some("no_site")),
            (RowStatus::Invalid, Some("no_site")),
            (RowStatus::Invalid, Some("no_password")),
            (RowStatus::Invalid, Some("malformed")),
            (RowStatus::Repeated, Some("repeated")),
            (RowStatus::New, None),
        ]
    );
    assert_eq!(
        (
            preview.counts.new,
            preview.counts.repeated,
            preview.counts.invalid
        ),
        (2, 1, 4)
    );
    // A shifted record shows no cell at all: its columns cannot be trusted.
    let shifted = &preview.rows[4];
    assert!(shifted.title.is_none() && shifted.site.is_none() && shifted.username.is_none());
}

#[tokio::test]
async fn a_login_already_in_the_folder_is_a_duplicate_only_for_a_caller_who_can_read_it() {
    let store = store();
    let saved = put_login(
        &store,
        "example",
        "https://www.example.com/account",
        "Ada@Example.com",
        "made-up-saved-1",
    )
    .await;
    let import = LoginImport::parse(CHROME).unwrap();

    let readable = all_ids(&store).await;
    let seen = store
        .login_import_preview(&folder(), &import, &readable)
        .await
        .unwrap();
    assert_eq!((seen.counts.new, seen.counts.duplicate), (1, 1));
    assert_eq!(seen.rows[0].status, RowStatus::Duplicate);
    assert_eq!(
        seen.rows[0].existing,
        Some(ExistingRef {
            key: "example".into(),
            id: saved.id.clone(),
            version: saved.version,
        })
    );
    assert_eq!(seen.rows[1].status, RowStatus::New);

    // Without the right to read the saved login the record looks new, so
    // the preview is not a way to learn which logins exist.
    let blind = store
        .login_import_preview(&folder(), &import, &BTreeSet::new())
        .await
        .unwrap();
    assert_eq!((blind.counts.new, blind.counts.duplicate), (2, 0));
    assert!(blind.rows[0].existing.is_none());

    // Another folder holds no such login.
    let elsewhere = ImportFolder::new(None, Some("/team")).unwrap();
    let other = store
        .login_import_preview(&elsewhere, &import, &readable)
        .await
        .unwrap();
    assert_eq!(other.counts.duplicate, 0);
    assert_eq!(other.path, "/team");
}

#[test]
fn a_new_key_names_the_site_and_is_a_valid_item_key() {
    let long = "a".repeat(300);
    for host in [
        "example.com",
        "[::1]",
        "xn--bcher-kva.example",
        "",
        long.as_str(),
    ] {
        let key = new_item_key(host);
        assert!(is_valid_item_key(&key), "{key}");
        assert!(key.len() <= 100, "{key}");
        assert_ne!(key, new_item_key(host), "keys are random");
    }
    assert!(new_item_key("Example.com").starts_with("example.com--"));
    assert!(new_item_key("").starts_with("login--"));
}

#[test]
fn too_many_logins_are_refused() {
    let mut text = String::from("name,url,username,password\n");
    for index in 0..=MAX_IMPORT_ROWS {
        text.push_str(&format!(
            "Site {index},https://s{index}.example.com,ada,made-up-{index}\n"
        ));
    }
    assert_eq!(
        LoginImport::parse(&text).err(),
        Some(LoginImportError::TooManyRows)
    );
}
