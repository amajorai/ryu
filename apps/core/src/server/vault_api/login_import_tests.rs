//! Route tests for the login import. Every value here is made up.

use axum::http::StatusCode;

use super::*;
use crate::plugin_secrets::kv::Environment;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::items::{ItemPut, PutAccess};
use crate::vault::policy::{Policy, PolicyRule};

const CSV: &str = "name,url,username,password,note\n\
Example,https://example.com/login,ada@example.com,made-up-route-1,made-up route note\n\
Shop,https://shop.example.org/,grace,made-up-route-2,\n";

const ALL: &[Capability] = &[
    Capability::List,
    Capability::Use,
    Capability::Read,
    Capability::Write,
    Capability::Delete,
];

fn store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

fn member(store: &'static PluginSecretStore, rules: &[(&str, Vec<Capability>)]) -> Ctx {
    let policy = Policy {
        name: "imports".into(),
        description: String::new(),
        rules: rules
            .iter()
            .map(|(path, capabilities)| PolicyRule {
                path: (*path).to_owned(),
                capabilities: capabilities.clone(),
                deny: false,
                ..Default::default()
            })
            .collect(),
    };
    Ctx::test_member(store, "user-1", vec![policy])
}

async fn reply(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 8 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Save the login the first record of [`CSV`] duplicates.
async fn save_example(store: &PluginSecretStore, environment: &str) {
    let put: ItemPut = serde_json::from_value(json!({
        "environment": environment,
        "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": "username", "type": "text" },
            { "name": "password", "type": "password", "required": true }
        ],
        "values": {
            "url": "https://example.com/",
            "username": "ada@example.com",
            "password": "made-up-saved-1"
        }
    }))
    .unwrap();
    store
        .item_put(
            "example",
            put,
            &AuditActor::new("operator", None),
            PutAccess::FULL,
        )
        .await
        .unwrap();
}

async fn item_count(store: &PluginSecretStore, environment: &str) -> usize {
    store
        .item_list(Some(environment), None)
        .await
        .unwrap()
        .len()
}

#[tokio::test]
async fn a_preview_saves_nothing_and_an_import_saves_the_chosen_records() {
    let store = store();
    let owner = member(store, &[("sys/items/default/*", ALL.to_vec())]);

    let (status, body) = reply(preview_import(&owner, json!({ "csv": CSV })).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let preview = &body["preview"];
    assert_eq!(preview["format"], "chrome");
    assert_eq!(preview["counts"]["total"], 2);
    assert_eq!(preview["counts"]["new"], 2);
    assert_eq!(preview["rows"][0]["status"], "new");
    assert_eq!(preview["rows"][0]["host"], "example.com");
    assert_eq!(preview["rows"][0]["hasNotes"], true);
    assert!(
        !body.to_string().contains("made-up"),
        "a preview holds a value"
    );
    assert_eq!(item_count(store, "default").await, 0);

    let (status, body) =
        reply(apply_import(&owner, json!({ "csv": CSV, "rows": [3] })).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["created"], 1);
    assert_eq!(body["result"]["rows"][0]["row"], 3);
    assert_eq!(body["result"]["rows"][0]["outcome"], "created");
    assert!(
        !body.to_string().contains("made-up"),
        "a result holds a value"
    );
    let items = store.item_list(Some("default"), None).await.unwrap();
    assert_eq!(items.len(), 1);
    assert!(items[0].key.starts_with("shop.example.org--"));
    assert_eq!(items[0].kind, "login");
}

#[tokio::test]
async fn a_duplicate_is_shown_only_to_a_caller_who_may_read_it_and_replaced_only_with_write() {
    let store = store();
    save_example(store, "default").await;
    let owner = member(store, &[("sys/items/default/*", ALL.to_vec())]);
    // May add logins and see that items exist, but not read or change them.
    let adder = member(
        store,
        &[
            ("sys/items/default/*", vec![Capability::List]),
            (
                "sys/items/default/shop.example.org--*",
                vec![Capability::Write],
            ),
        ],
    );

    let (_, seen) = reply(preview_import(&owner, json!({ "csv": CSV })).await).await;
    assert_eq!(seen["preview"]["rows"][0]["status"], "duplicate");
    let existing = seen["preview"]["rows"][0]["existing"].clone();
    assert_eq!(existing["key"], "example");
    let (_, blind) = reply(preview_import(&adder, json!({ "csv": CSV })).await).await;
    assert_eq!(blind["preview"]["rows"][0]["status"], "new");
    assert!(blind["preview"]["rows"][0].get("existing").is_none());

    // The adder may write only keys of the second site: the first record is
    // denied, and the choice to replace is denied too.
    let replace = json!([{
        "row": 2,
        "expectedId": existing["id"],
        "expectedVersion": existing["version"]
    }]);
    let (status, body) =
        reply(apply_import(&adder, json!({ "csv": CSV, "rows": [2, 3] })).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["rows"][0]["outcome"], "denied");
    assert_eq!(body["result"]["rows"][1]["outcome"], "created");
    let (_, body) =
        reply(apply_import(&adder, json!({ "csv": CSV, "replace": replace.clone() })).await).await;
    // The adder cannot read the saved login, so to it the record is not a
    // duplicate at all and there is nothing to replace.
    assert_eq!(body["result"]["rows"][0]["outcome"], "conflict");
    assert_eq!(body["result"]["replaced"], 0);

    let (_, body) =
        reply(apply_import(&owner, json!({ "csv": CSV, "replace": replace })).await).await;
    assert_eq!(body["result"]["rows"][0]["outcome"], "replaced");
    assert_eq!(body["result"]["rows"][0]["key"], "example");
    assert_eq!(item_count(store, "default").await, 2);
}

#[tokio::test]
async fn a_caller_without_write_saves_nothing() {
    let store = store();
    let reader = member(
        store,
        &[(
            "sys/items/default/*",
            vec![Capability::List, Capability::Read],
        )],
    );
    let (status, body) =
        reply(apply_import(&reader, json!({ "csv": CSV, "rows": [2, 3] })).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["created"], 0);
    assert_eq!(body["result"]["skipped"], 2);
    assert_eq!(body["result"]["rows"][0]["outcome"], "denied");
    assert_eq!(item_count(store, "default").await, 0);
}

#[tokio::test]
async fn a_protected_environment_needs_admin() {
    let store = store();
    store
        .put_environment(
            &Environment {
                slug: "prod".into(),
                name: "Production".into(),
                protected: true,
                required_approvals: 1,
                position: 0,
                cas_required: false,
            },
            &AuditActor::new("operator", None),
        )
        .await
        .unwrap();
    let body = json!({ "csv": CSV, "environment": "prod", "rows": [2] });
    let writer = member(store, &[("sys/items/prod/*", ALL.to_vec())]);
    let (_, denied) = reply(apply_import(&writer, body.clone()).await).await;
    assert_eq!(denied["result"]["rows"][0]["outcome"], "denied");
    assert_eq!(item_count(store, "prod").await, 0);

    let mut caps = ALL.to_vec();
    caps.push(Capability::Admin);
    let admin = member(store, &[("sys/items/prod/*", caps)]);
    let (_, saved) = reply(apply_import(&admin, body).await).await;
    assert_eq!(saved["result"]["rows"][0]["outcome"], "created");
    assert_eq!(item_count(store, "prod").await, 1);
}

#[tokio::test]
async fn a_bad_file_or_body_is_refused_without_quoting_it() {
    let store = store();
    let owner = member(store, &[("sys/items/default/*", ALL.to_vec())]);
    let cases = [
        (
            json!({ "csv": "https://example.com,ada,made-up-headerless-1\n" }),
            "login_import_unknown_format",
        ),
        (json!({ "csv": "" }), "login_import_empty"),
        (
            json!({ "csv": "name,url,username,password\nx,https://example.com,ada,\"made-up-open-1\n" }),
            "login_import_unreadable",
        ),
        // The file sent where record numbers belong, and an unknown key.
        (json!({ "csv": CSV, "rows": CSV }), "vault_invalid_request"),
        (
            json!({ "csv": CSV, "made-up-key": "made-up-value" }),
            "vault_invalid_request",
        ),
        (
            json!({ "csv": CSV, "rows": [2, 3, 2] }),
            "more records are chosen",
        ),
    ];
    for (body, code) in cases {
        for response in [
            apply_import(&owner, body.clone()).await,
            preview_import(&owner, body.clone()).await,
        ] {
            let (status, answer) = reply(response).await;
            let text = answer.to_string();
            // A preview takes no `rows`, so it refuses those bodies as well.
            assert_eq!(status, StatusCode::BAD_REQUEST, "{code}: {text}");
            assert!(!text.contains("made-up"), "{code} quotes the body");
        }
        let (_, answer) = reply(apply_import(&owner, body).await).await;
        assert!(answer.to_string().contains(code), "{code}: {answer}");
    }
    assert_eq!(item_count(store, "default").await, 0);
}
