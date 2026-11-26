//! Custom account pools: the stored model, the preferences record and the
//! route handlers.
use axum::{http::StatusCode, response::Response};
use serde_json::{json, Value};

use super::model::{Catalog, PoolAccount, PoolError, MAX_POOLS};
use super::{routes, store};
use crate::server::preferences::PreferencesStore;

pub(super) fn preferences() -> (tempfile::TempDir, PreferencesStore) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = PreferencesStore::open(directory.path().join("preferences.db"))
        .expect("temporary preferences store");
    (directory, store)
}

pub(super) fn account(provider_id: &str, account_id: &str) -> PoolAccount {
    PoolAccount {
        provider_id: provider_id.to_owned(),
        account_id: account_id.to_owned(),
    }
}

async fn body(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

#[test]
fn pools_are_created_renamed_and_capped() {
    let mut catalog = Catalog::default();
    let mythos = catalog
        .create(
            "  Mythos  ",
            vec![
                account("claude-pro-max", "b"),
                account("claude-pro-max", "a"),
                account("claude-pro-max", "b"),
            ],
        )
        .unwrap();
    assert_eq!(mythos.name, "Mythos");
    assert_eq!(
        mythos.accounts,
        [
            account("claude-pro-max", "a"),
            account("claude-pro-max", "b")
        ]
    );
    assert_eq!(
        catalog.create("mythos", Vec::new()),
        Err(PoolError::Invalid("a pool with this name already exists"))
    );
    assert!(matches!(
        catalog.create("   ", Vec::new()),
        Err(PoolError::Invalid(_))
    ));
    assert!(matches!(
        catalog.create(&"n".repeat(65), Vec::new()),
        Err(PoolError::Invalid(_))
    ));
    assert!(matches!(
        catalog.create("Bad", vec![account("", "a")]),
        Err(PoolError::Invalid(_))
    ));
    let renamed = catalog.update(&mythos.id, Some("General"), None).unwrap();
    assert_eq!(renamed.name, "General");
    assert_eq!(renamed.accounts.len(), 2, "a rename keeps the accounts");
    let emptied = catalog.update(&mythos.id, None, Some(Vec::new())).unwrap();
    assert_eq!(emptied.name, "General", "new accounts keep the name");
    assert!(emptied.accounts.is_empty());
    assert_eq!(
        catalog.update("missing", Some("X"), None),
        Err(PoolError::NotFound)
    );
    for index in catalog.pools.len()..MAX_POOLS {
        catalog
            .create(&format!("Pool {index}"), Vec::new())
            .unwrap();
    }
    assert_eq!(
        catalog.create("One too many", Vec::new()),
        Err(PoolError::LimitReached)
    );
}

#[test]
fn one_account_may_sit_in_several_pools_and_each_agent_has_one_pool_or_none() {
    let mut catalog = Catalog::default();
    let shared = vec![account("claude-pro-max", "a")];
    let first = catalog.create("First", shared.clone()).unwrap();
    let second = catalog.create("Second", shared).unwrap();
    assert_eq!(
        catalog.assign("security", Some("missing")),
        Err(PoolError::NotFound)
    );
    catalog.assign("security", Some(&first.id)).unwrap();
    catalog.assign("security", Some(&second.id)).unwrap();
    assert_eq!(catalog.pool_of("security").unwrap().id, second.id);
    assert!(catalog.pool_of("writer").is_none());
    catalog.assign("security", None).unwrap();
    assert!(catalog.pool_of("security").is_none());
    assert!(matches!(
        catalog.assign("", Some(&first.id)),
        Err(PoolError::Invalid(_))
    ));
}

#[test]
fn deleting_a_pool_clears_it_from_every_agent() {
    let mut catalog = Catalog::default();
    let doomed = catalog.create("Doomed", Vec::new()).unwrap();
    let kept = catalog.create("Kept", Vec::new()).unwrap();
    catalog.assign("security", Some(&doomed.id)).unwrap();
    catalog.assign("research", Some(&doomed.id)).unwrap();
    catalog.assign("writer", Some(&kept.id)).unwrap();
    catalog.delete(&doomed.id).unwrap();
    assert_eq!(catalog.pools.len(), 1);
    assert_eq!(
        catalog.agents.keys().collect::<Vec<_>>(),
        ["writer"],
        "only the agent of the surviving pool keeps an assignment"
    );
    assert_eq!(catalog.delete(&doomed.id), Err(PoolError::NotFound));
}

#[test]
fn removing_an_account_removes_it_from_every_pool_of_that_provider_only() {
    let mut catalog = Catalog::default();
    for name in ["First", "Second"] {
        catalog
            .create(
                name,
                vec![
                    account("claude-pro-max", "a"),
                    account("claude-pro-max", "b"),
                    account("chatgpt", "a"),
                ],
            )
            .unwrap();
    }
    assert!(catalog.forget_account("a", |provider| provider == "claude-pro-max"));
    for pool in &catalog.pools {
        assert_eq!(
            pool.accounts,
            [account("chatgpt", "a"), account("claude-pro-max", "b")]
        );
    }
    assert!(!catalog.forget_account("a", |provider| provider == "claude-pro-max"));
}

#[test]
fn an_agent_is_limited_only_for_providers_its_pool_holds_an_account_of() {
    let mut catalog = Catalog::default();
    let pool = catalog
        .create(
            "Mythos",
            vec![
                account("claude-pro-max", "b"),
                account("claude-pro-max", "d"),
            ],
        )
        .unwrap();
    catalog.assign("security", Some(&pool.id)).unwrap();
    let claude = catalog
        .accounts_of("security", |provider| provider == "claude-pro-max")
        .unwrap();
    assert_eq!(claude.into_iter().collect::<Vec<_>>(), ["b", "d"]);
    assert!(catalog
        .accounts_of("security", |provider| provider == "chatgpt")
        .is_none());
    assert!(catalog
        .accounts_of("writer", |provider| provider == "claude-pro-max")
        .is_none());
}

#[test]
fn a_hand_edited_record_cannot_leave_a_dangling_assignment_or_bad_ids() {
    let catalog: Catalog = serde_json::from_value(json!({
        "pools": [
            {"id": "p1", "name": "Kept", "accounts": [
                {"providerId": "kiro", "accountId": "k"},
                {"providerId": "", "accountId": "nameless"}
            ]},
            {"id": "", "name": "No id"}
        ],
        "agents": {"security": "p1", "ghost": "deleted-pool", "": "p1"}
    }))
    .unwrap();
    let catalog = catalog.sanitized();
    assert_eq!(catalog.pools.len(), 1);
    assert_eq!(catalog.pools[0].accounts, [account("kiro", "k")]);
    assert_eq!(catalog.agents.keys().collect::<Vec<_>>(), ["security"]);
}

#[tokio::test]
async fn the_record_holds_ids_only_and_an_unreadable_one_reads_as_no_pools() {
    let (_directory, preferences) = preferences();
    assert_eq!(store::load(&preferences).await.unwrap(), Catalog::default());
    let (pool, saved) = store::edit(&preferences, |catalog| {
        let pool = catalog.create("Mythos", vec![account("claude-pro-max", "a")])?;
        catalog.assign("security", Some(&pool.id))?;
        Ok(pool)
    })
    .await
    .unwrap();
    assert_eq!(store::load(&preferences).await.unwrap(), saved);
    let raw = preferences.get(store::PREF_KEY).await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap(),
        json!({
            "pools": [{
                "id": pool.id,
                "name": "Mythos",
                "accounts": [{"providerId": "claude-pro-max", "accountId": "a"}]
            }],
            "agents": {"security": pool.id}
        })
    );
    // A refused change saves nothing.
    let refused = store::edit(&preferences, |catalog| catalog.delete("missing")).await;
    assert_eq!(
        refused.unwrap_err(),
        store::EditError::Pool(PoolError::NotFound)
    );
    assert_eq!(store::load(&preferences).await.unwrap(), saved);
    preferences.set(store::PREF_KEY, "not json").await.unwrap();
    assert_eq!(store::load(&preferences).await.unwrap(), Catalog::default());
}

#[tokio::test]
async fn routes_create_list_rename_assign_and_delete() {
    let (_directory, preferences) = preferences();
    let create = |name: &str| {
        serde_json::from_value::<routes::CreatePool>(json!({
            "name": name,
            "accounts": [{"providerId": "claude-pro-max", "accountId": "a"}]
        }))
        .unwrap()
    };
    let created = routes::create(&preferences, create("Mythos")).await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let pool_id = body(created).await["id"].as_str().unwrap().to_owned();
    let duplicate = routes::create(&preferences, create("MYTHOS")).await;
    assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
    assert!(body(duplicate).await["error"].is_string());

    let rename =
        |name: &str| serde_json::from_value::<routes::UpdatePool>(json!({ "name": name })).unwrap();
    let renamed = routes::update(&preferences, &pool_id, rename("Security")).await;
    assert_eq!(renamed.status(), StatusCode::OK);
    let renamed = body(renamed).await;
    assert_eq!(renamed["name"], "Security");
    assert_eq!(renamed["accounts"][0]["accountId"], "a");
    let missing = routes::update(&preferences, "missing", rename("X")).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let assign = |pool: Value| {
        serde_json::from_value::<routes::AgentPool>(json!({ "poolId": pool })).unwrap()
    };
    let unknown = routes::assign(&preferences, "security", assign(json!("missing"))).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let assigned = routes::assign(&preferences, "security", assign(json!(pool_id))).await;
    assert_eq!(assigned.status(), StatusCode::OK);
    assert_eq!(
        body(routes::agent_pool(&preferences, "security").await).await,
        json!({"agentId": "security", "mode": "pool", "poolId": pool_id, "backups": []})
    );

    let listed = body(routes::list(&preferences).await).await;
    assert_eq!(listed["pools"][0]["name"], "Security");
    assert_eq!(listed["agents"]["security"], pool_id.as_str());
    assert_eq!(listed["maxPools"], 50);
    assert_eq!(listed["maxPoolAccounts"], 200);

    // Removing the account from its provider removes it from the pool.
    super::forget_account(&preferences, "chatgpt", "a").await;
    let listed = body(routes::list(&preferences).await).await;
    assert_eq!(listed["pools"][0]["accounts"].as_array().unwrap().len(), 1);
    super::forget_account(&preferences, "claude-pro-max", "a").await;
    let listed = body(routes::list(&preferences).await).await;
    assert_eq!(listed["pools"][0]["accounts"], json!([]));

    let deleted = routes::delete(&preferences, &pool_id).await;
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        body(routes::agent_pool(&preferences, "security").await).await["poolId"],
        Value::Null,
        "deleting a pool clears it from its agents"
    );
    let cleared = routes::assign(&preferences, "security", assign(Value::Null)).await;
    assert_eq!(cleared.status(), StatusCode::OK);
    assert_eq!(
        routes::delete(&preferences, &pool_id).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn request_bodies_refuse_unknown_fields() {
    assert!(serde_json::from_value::<routes::CreatePool>(
        json!({"name": "Mythos", "credential": "secret"})
    )
    .is_err());
    assert!(
        serde_json::from_value::<routes::UpdatePool>(json!({"accounts": [
            {"providerId": "kiro", "accountId": "k", "token": "secret"}
        ]}))
        .is_err()
    );
    assert!(serde_json::from_value::<routes::AgentPool>(json!({})).is_ok());
}
