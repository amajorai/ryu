//! Saving an import. Every value here is made up.

use std::collections::{BTreeMap, BTreeSet};

use super::super::*;
use super::plan_tests::{actor, all_ids, folder, put_login, store, CHROME, SEED};
use super::*;

/// Choices for an import by a caller who may read and write everything.
struct Choices {
    create: BTreeMap<usize, String>,
    denied: BTreeSet<usize>,
    replace: Vec<ReplaceChoice>,
    readable: BTreeSet<String>,
    writable: BTreeSet<String>,
}

impl Choices {
    async fn all(store: &PluginSecretStore, import: &LoginImport, rows: &[usize]) -> Self {
        let ids = all_ids(store).await;
        Self {
            create: rows
                .iter()
                .filter_map(|row| Some((*row, new_item_key(import.importable_host(*row)?))))
                .collect(),
            denied: BTreeSet::new(),
            replace: Vec::new(),
            readable: ids.clone(),
            writable: ids,
        }
    }

    async fn apply(&self, store: &PluginSecretStore, import: &LoginImport) -> LoginImportResult {
        let input = ApplyInput {
            create: &self.create,
            denied: &self.denied,
            replace: &self.replace,
            readable: &self.readable,
            writable: &self.writable,
        };
        store
            .login_import_apply(&folder(), import, &input, &actor())
            .await
            .unwrap()
    }
}

async fn reveal(store: &PluginSecretStore, key: &str, field: &str) -> String {
    store
        .item_reveal(&folder().coords(key).unwrap(), field, &actor())
        .await
        .unwrap()
}

fn outcomes(result: &LoginImportResult) -> Vec<(usize, RowOutcome)> {
    result
        .rows
        .iter()
        .map(|row| (row.row, row.outcome))
        .collect()
}

#[tokio::test]
async fn chosen_records_become_sealed_login_items() {
    let store = store();
    let text = "Title,URL,Username,Password,Notes,OTPAuth\n\
Example,https://example.com/login?token=made-up-token,ada@example.com,made-up-apply-1,made-up apply note,JBSW Y3DP EHPK 3PXP\n\
Shop,shop.example.org,grace,made-up-apply-2,,\n\
Left out,https://example.net,ada,made-up-apply-3,,\n";
    let import = LoginImport::parse(text).unwrap();
    let result = Choices::all(&store, &import, &[2, 3])
        .await
        .apply(&store, &import)
        .await;
    assert_eq!((result.created, result.replaced, result.skipped), (2, 0, 0));
    assert_eq!(
        outcomes(&result),
        vec![(2, RowOutcome::Created), (3, RowOutcome::Created)]
    );

    let key = result.rows[0].key.clone().unwrap();
    assert!(key.starts_with("example.com--"), "{key}");
    let item = store
        .item_get(&folder().coords(&key).unwrap(), true)
        .await
        .unwrap();
    assert_eq!(item.kind, "login");
    assert_eq!(item.description.as_deref(), Some("Example"));
    assert_eq!(item.status, ItemStatus::Ready);
    let value = |name: &str| {
        let field = item.fields.iter().find(|f| f.def.name == name).unwrap();
        (field.has_value, field.def.sensitive, field.value.clone())
    };
    // The address lost its query; sensitive values are not in a read.
    assert_eq!(
        value("url"),
        (true, false, Some("https://example.com/login".to_owned()))
    );
    assert_eq!(
        value("username"),
        (true, false, Some("ada@example.com".to_owned()))
    );
    assert_eq!(value("password"), (true, true, None));
    assert_eq!(value("totp"), (true, true, None));
    assert_eq!(value("notes"), (true, true, None));
    assert_eq!(reveal(&store, &key, "password").await, "made-up-apply-1");
    assert_eq!(reveal(&store, &key, "totp").await, SEED);
    assert_eq!(reveal(&store, &key, "notes").await, "made-up apply note");

    // The record that was not chosen was not saved.
    assert_eq!(all_ids(&store).await.len(), 2);
    let body = serde_json::to_string(&result).unwrap();
    assert!(!body.contains("made-up"), "a result holds a value");
}

#[tokio::test]
async fn nothing_stored_in_the_clear_or_on_the_timeline_holds_a_value() {
    let store = store();
    let import = LoginImport::parse(CHROME).unwrap();
    let result = Choices::all(&store, &import, &[2, 3])
        .await
        .apply(&store, &import)
        .await;
    let key = result.rows[0].key.clone().unwrap();
    let events = store
        .item_events(
            &folder().coords(&key).unwrap(),
            0,
            100,
            0,
            EventScope::CurrentItem,
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].name, "created");
    let timeline = serde_json::to_string(&events).unwrap();
    assert!(!timeline.contains("made-up") && !timeline.contains("made,up"));

    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT ciphertext FROM vault_item_values")
        .unwrap();
    let sealed: Vec<Vec<u8>> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(sealed.len() >= 5);
    let needle = b"made-up-chrome-1";
    for bytes in sealed {
        assert!(!bytes.windows(needle.len()).any(|window| window == needle));
    }
}

#[tokio::test]
async fn formula_characters_and_odd_quoting_are_saved_as_typed() {
    let store = store();
    let text = "name,url,username,password,note\n\
\"=HYPERLINK(\"\"https://example.net\"\",\"\"x\"\")\",https://example.com,=cmd|' /C calc'!A0,\"=1+1,\"\"@SUM(A1)\"\"\",+made-up -note\n";
    let import = LoginImport::parse(text).unwrap();
    let result = Choices::all(&store, &import, &[2])
        .await
        .apply(&store, &import)
        .await;
    assert_eq!(result.created, 1);
    let key = result.rows[0].key.clone().unwrap();
    assert_eq!(reveal(&store, &key, "password").await, "=1+1,\"@SUM(A1)\"");
    assert_eq!(reveal(&store, &key, "username").await, "=cmd|' /C calc'!A0");
    assert_eq!(reveal(&store, &key, "notes").await, "+made-up -note");
}

#[tokio::test]
async fn a_duplicate_is_skipped_and_the_saved_login_is_untouched() {
    let store = store();
    let saved = put_login(
        &store,
        "example",
        "https://example.com/",
        "ada@example.com",
        "made-up-saved-1",
    )
    .await;
    let import = LoginImport::parse(CHROME).unwrap();
    // The caller asks to add both records as new, duplicate included.
    let result = Choices::all(&store, &import, &[2, 3])
        .await
        .apply(&store, &import)
        .await;
    assert_eq!(
        outcomes(&result),
        vec![(2, RowOutcome::SkippedDuplicate), (3, RowOutcome::Created)]
    );
    assert_eq!((result.created, result.replaced, result.skipped), (1, 0, 1));
    assert_eq!(
        reveal(&store, "example", "password").await,
        "made-up-saved-1"
    );
    let after = store
        .item_get(&folder().coords("example").unwrap(), false)
        .await
        .unwrap();
    assert_eq!((after.id, after.version), (saved.id, saved.version));
    assert_eq!(all_ids(&store).await.len(), 2);
}

#[tokio::test]
async fn a_login_is_replaced_only_by_its_current_id_and_version_and_with_write() {
    let store = store();
    let saved = put_login(
        &store,
        "example",
        "https://example.com/",
        "ada@example.com",
        "made-up-saved-1",
    )
    .await;
    let import = LoginImport::parse(CHROME).unwrap();
    let choice = |id: &str, version: i64| ReplaceChoice {
        row: 2,
        expected_id: id.to_owned(),
        expected_version: version,
    };

    let mut choices = Choices::all(&store, &import, &[]).await;
    for stale in [
        choice(&saved.id, saved.version + 1),
        choice("itm_other", saved.version),
    ] {
        choices.replace = vec![stale];
        let result = choices.apply(&store, &import).await;
        assert_eq!(outcomes(&result), vec![(2, RowOutcome::Conflict)]);
    }

    choices.replace = vec![choice(&saved.id, saved.version)];
    choices.writable = BTreeSet::new();
    let result = choices.apply(&store, &import).await;
    assert_eq!(outcomes(&result), vec![(2, RowOutcome::Denied)]);
    assert_eq!(
        reveal(&store, "example", "password").await,
        "made-up-saved-1"
    );

    choices.writable = choices.readable.clone();
    // Naming the same record twice replaces once.
    choices.replace = vec![
        choice(&saved.id, saved.version),
        choice(&saved.id, saved.version),
    ];
    let result = choices.apply(&store, &import).await;
    assert_eq!(outcomes(&result), vec![(2, RowOutcome::Replaced)]);
    assert_eq!(result.rows[0].key.as_deref(), Some("example"));
    assert_eq!((result.created, result.replaced, result.skipped), (0, 1, 0));
    assert_eq!(
        reveal(&store, "example", "password").await,
        "made-up-chrome-1"
    );
    let after = store
        .item_get(&folder().coords("example").unwrap(), true)
        .await
        .unwrap();
    assert_eq!(
        (after.id.as_str(), after.version),
        (saved.id.as_str(), saved.version + 1)
    );
    assert_eq!(all_ids(&store).await.len(), 1, "no second item was made");

    // The old choice is stale now.
    let result = choices.apply(&store, &import).await;
    assert_eq!(outcomes(&result), vec![(2, RowOutcome::Conflict)]);
}

#[tokio::test]
async fn records_the_caller_may_not_write_or_that_cannot_be_imported_are_reported() {
    let store = store();
    let text = "name,url,username,password\n\
Example,https://example.com,ada,made-up-ok-1\n\
No password,https://example.org,ada,\n\
Shop,https://shop.example.org,grace,made-up-ok-2\n";
    let import = LoginImport::parse(text).unwrap();
    assert!(import.importable_host(3).is_none());
    assert!(import.importable_host(1).is_none() && import.importable_host(9).is_none());
    let mut choices = Choices::all(&store, &import, &[2, 4]).await;
    choices.create.insert(3, "made-up-key".to_owned());
    choices.create.insert(9, "made-up-key-2".to_owned());
    choices.create.remove(&4);
    choices.denied.insert(4);
    let result = choices.apply(&store, &import).await;
    assert_eq!(
        outcomes(&result),
        vec![
            (2, RowOutcome::Created),
            (3, RowOutcome::Invalid),
            (4, RowOutcome::Denied),
            (9, RowOutcome::Invalid),
        ]
    );
    assert_eq!((result.created, result.skipped), (1, 3));
    assert_eq!(all_ids(&store).await.len(), 1);
}

#[tokio::test]
async fn ten_thousand_logins_are_previewed_and_saved() {
    const COUNT: usize = 10_000;
    let store = store();
    let mut text = String::from("name,url,username,password,note\n");
    for index in 0..COUNT {
        text.push_str(&format!(
            "Site {index},https://s{index}.example.com/login,user{index}@example.com,made-up-{index},\n"
        ));
    }
    let import = LoginImport::parse(&text).unwrap();
    assert_eq!(import.len(), COUNT);
    let preview = store
        .login_import_preview(&folder(), &import, &BTreeSet::new())
        .await
        .unwrap();
    assert_eq!((preview.counts.total, preview.counts.new), (COUNT, COUNT));

    let rows: Vec<usize> = (2..COUNT + 2).collect();
    let choices = Choices::all(&store, &import, &rows).await;
    let result = choices.apply(&store, &import).await;
    assert_eq!((result.created, result.skipped), (COUNT, 0));
    assert_eq!(all_ids(&store).await.len(), COUNT);

    // A second run of the same file adds nothing: every record is a duplicate.
    let again = Choices::all(&store, &import, &rows).await;
    let preview = store
        .login_import_preview(&folder(), &import, &again.readable)
        .await
        .unwrap();
    assert_eq!((preview.counts.new, preview.counts.duplicate), (0, COUNT));
    let result = again.apply(&store, &import).await;
    assert_eq!((result.created, result.skipped), (0, COUNT));
    assert_eq!(all_ids(&store).await.len(), COUNT);
}
