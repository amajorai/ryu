//! Auto and backup models: the stored shape and the agent routes.
use axum::{http::StatusCode, response::Response};
use serde_json::{json, Value};

use super::model::{Catalog, PoolError};
use super::modes::{Backup, Mode, MAX_BACKUPS};
use super::tests::{account, preferences};
use super::{routes, store};

fn backup(provider_id: &str, model: &str) -> Backup {
    Backup {
        provider_id: provider_id.to_owned(),
        model: model.to_owned(),
    }
}

async fn body(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

#[test]
fn an_agent_is_on_auto_or_on_one_pool_or_on_neither() {
    let mut catalog = Catalog::default();
    let pool = catalog
        .create("Mythos", vec![account("claude-pro-max", "a")])
        .unwrap();
    assert_eq!(catalog.mode_of("bot"), Mode::None);
    catalog.set_mode("bot", Mode::Auto, None).unwrap();
    assert_eq!(catalog.mode_of("bot"), Mode::Auto);
    catalog.set_mode("bot", Mode::Pool, Some(&pool.id)).unwrap();
    assert_eq!(catalog.mode_of("bot"), Mode::Pool);
    assert!(!catalog.auto.contains("bot"));
    catalog.set_mode("bot", Mode::Auto, None).unwrap();
    assert!(!catalog.agents.contains_key("bot"), "Auto clears the pool");
    catalog.set_mode("bot", Mode::None, None).unwrap();
    assert_eq!(catalog.mode_of("bot"), Mode::None);
    assert_eq!(
        catalog.set_mode("bot", Mode::Pool, None),
        Err(PoolError::Invalid("poolId is required for a pool"))
    );
    assert_eq!(
        catalog.set_mode("", Mode::Auto, None),
        Err(PoolError::Invalid("agent id is invalid"))
    );
}

#[test]
fn backups_keep_their_order_and_refuse_bad_entries() {
    let mut catalog = Catalog::default();
    let list = vec![
        backup("claude-pro-max", "claude-sonnet-4-5"),
        backup("chatgpt", " gpt-5 "),
    ];
    catalog.set_backups("bot", list).unwrap();
    assert_eq!(
        catalog.backups_of("bot"),
        [
            backup("claude-pro-max", "claude-sonnet-4-5"),
            backup("chatgpt", "gpt-5")
        ]
    );
    for bad in [
        vec![backup("", "m")],
        vec![backup("chatgpt", "  ")],
        vec![backup("chatgpt", &"m".repeat(201))],
        vec![backup("chatgpt", "m"), backup("chatgpt", "m")],
        (0..=MAX_BACKUPS)
            .map(|n| backup("chatgpt", &format!("m{n}")))
            .collect(),
    ] {
        assert!(catalog.set_backups("bot", bad).is_err());
    }
    assert_eq!(
        catalog.backups_of("bot").len(),
        2,
        "a refused list changes nothing"
    );
    catalog.set_backups("bot", Vec::new()).unwrap();
    assert!(catalog.backups_of("bot").is_empty());
}

#[test]
fn a_stored_record_is_cleaned_and_a_deleted_agent_is_forgotten() {
    let mut catalog = Catalog::default();
    let pool = catalog
        .create("Mythos", vec![account("claude-pro-max", "a")])
        .unwrap();
    catalog.agents.insert("both".into(), pool.id.clone());
    catalog.auto.insert("both".into());
    catalog.auto.insert(String::new());
    catalog.auto.insert("bot".into());
    catalog.backups.insert(
        "bot".into(),
        vec![
            backup("chatgpt", "gpt-5"),
            backup("chatgpt", "gpt-5"),
            backup("", "x"),
        ],
    );
    let raw = serde_json::to_string(&catalog).unwrap();
    let cleaned = serde_json::from_str::<Catalog>(&raw).unwrap().sanitized();
    assert_eq!(
        cleaned.mode_of("both"),
        Mode::Pool,
        "the narrower setting wins"
    );
    assert_eq!(cleaned.auto.iter().collect::<Vec<_>>(), ["bot"]);
    assert_eq!(cleaned.backups_of("bot"), [backup("chatgpt", "gpt-5")]);

    // An older record without the new fields still reads.
    let old = json!({"pools": [], "agents": {}});
    let old = serde_json::from_value::<Catalog>(old).unwrap();
    assert!(old.auto.is_empty() && old.backups.is_empty());

    let mut cleaned = cleaned;
    assert!(cleaned.forget_agent("bot"));
    assert_eq!(cleaned.mode_of("bot"), Mode::None);
    assert!(cleaned.backups_of("bot").is_empty());
    assert!(!cleaned.forget_agent("bot"));
}

#[tokio::test]
async fn the_agent_route_sets_auto_and_backups_and_older_clients_keep_working() {
    let (_directory, preferences) = preferences();
    let put = |value: Value| serde_json::from_value::<routes::AgentPool>(value).unwrap();
    let saved = routes::assign(
        &preferences,
        "bot",
        put(json!({"mode": "auto", "backups": [
            {"providerId": "claude-pro-max", "model": "claude-sonnet-4-5"},
            {"providerId": "chatgpt", "model": "gpt-5"}
        ]})),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let expected = json!({
        "agentId": "bot",
        "mode": "auto",
        "poolId": null,
        "backups": [
            {"providerId": "claude-pro-max", "model": "claude-sonnet-4-5"},
            {"providerId": "chatgpt", "model": "gpt-5"}
        ]
    });
    assert_eq!(body(saved).await, expected);
    assert_eq!(
        body(routes::agent_pool(&preferences, "bot").await).await,
        expected
    );
    let listed = body(routes::list(&preferences).await).await;
    assert_eq!(listed["auto"], json!(["bot"]));
    assert_eq!(listed["maxBackups"], MAX_BACKUPS);

    // The desktop client of the pools PR sends only poolId.
    let (_, catalog) = store::edit(&preferences, |catalog| {
        catalog.create("Mythos", vec![account("claude-pro-max", "a")])
    })
    .await
    .unwrap();
    let pool_id = catalog.pools[0].id.clone();
    let saved = routes::assign(&preferences, "bot", put(json!({"poolId": pool_id}))).await;
    let saved = body(saved).await;
    assert_eq!(saved["mode"], "pool");
    assert_eq!(saved["backups"].as_array().unwrap().len(), 2, "kept");
    let cleared = routes::assign(&preferences, "bot", put(json!({"poolId": null}))).await;
    assert_eq!(body(cleared).await["mode"], "none");

    let bad = routes::assign(&preferences, "bot", put(json!({"mode": "pool"}))).await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let bad = routes::assign(
        &preferences,
        "bot",
        put(json!({"mode": "auto", "backups": [{"providerId": "x", "model": ""}]})),
    )
    .await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    assert!(serde_json::from_value::<routes::AgentPool>(json!({"mode": "fast"})).is_err());
}
