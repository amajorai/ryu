//! The plan's per-provider account limit on linked plan accounts
//! ([`crate::server::plan_limits`]): the add route links up to the limit, refuses the next
//! account, and a node that already holds more keeps every account. Shares the
//! parent suite's fake CLI, store and `SERIAL`.
use super::*;
use crate::server::plan_limits::{account_limit, ACCOUNT_LIMIT_MESSAGE};

const OWNER: &str = "node-owner";

fn linked_count(provider: ProviderId) -> usize {
    store::accounts(OWNER)
        .iter()
        .filter(|account| account.provider == provider)
        .count()
}

async fn add(provider: &str) -> (StatusCode, Value) {
    let body = format!(r#"{{"provider":"{provider}","label":"one more"}}"#);
    reply(accounts_api::add_account(Extension(node_owner()), axum::body::Bytes::from(body)).await)
        .await
}

/// The refusal names the provider, the limit and how many accounts it holds.
fn assert_refused(status: StatusCode, body: &Value, count: usize) {
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code(body), "provider_account_limit");
    assert_eq!(body["error"]["message"], ACCOUNT_LIMIT_MESSAGE);
    assert_eq!(body["error"]["provider"], "anthropic");
    assert_eq!(body["error"]["limit"], account_limit());
    assert_eq!(body["error"]["count"], count);
}

#[tokio::test]
async fn the_add_route_fills_the_last_place_and_refuses_the_account_after_it() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    accounts::set_root_for_test(Some(root.path().to_path_buf()));
    let _fake = FakeCli::install(Box::new(|_| ok(CLAUDE_SUBSCRIPTION)));
    let limit = account_limit();
    for index in 0..limit - 1 {
        link(OWNER, ProviderId::Anthropic, &format!("account {index}"));
    }

    // One below the limit: the add is accepted and takes the last place.
    let (status, _) = add("anthropic").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(linked_count(ProviderId::Anthropic), limit);

    // At the limit: refused, nothing is stored and its folder is removed again.
    let (status, body) = add("anthropic").await;
    assert_refused(status, &body, limit);
    assert_eq!(linked_count(ProviderId::Anthropic), limit);
    let folders = std::fs::read_dir(root.path().join("plan-accounts"))
        .unwrap()
        .count();
    assert_eq!(folders, 1, "only the accepted account keeps a folder");

    // The limit is per provider: the other provider still has room.
    let (status, _) = add("openai").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(linked_count(ProviderId::Openai), 1);

    accounts::set_root_for_test(None);
    store::reset_for_test();
}

#[tokio::test]
async fn a_node_above_the_limit_keeps_every_account_and_refuses_only_new_ones() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    accounts::set_root_for_test(Some(root.path().to_path_buf()));
    let _fake = FakeCli::install(Box::new(|_| ok(CLAUDE_SUBSCRIPTION)));
    let limit = account_limit();
    // A saved state from before the limit applied: two accounts more than it allows.
    let saved: Vec<Value> = (0..limit + 2)
        .map(|index| {
            json!({
                "id": format!("{index:012x}"),
                "provider": "anthropic",
                "label": format!("account {index}"),
                "createdAt": 0
            })
        })
        .collect();
    let file = root.path().join("subscription-cloud.json");
    let state = json!({ "accounts": { "node-owner": saved } });
    store::load_for_test(&file, state.to_string().as_bytes());

    assert_eq!(linked_count(ProviderId::Anthropic), limit + 2);
    let (status, body) = add("anthropic").await;
    assert_refused(status, &body, limit + 2);
    assert_eq!(
        linked_count(ProviderId::Anthropic),
        limit + 2,
        "a refused add removes nothing"
    );

    // Removing down to the limit is not enough; one below it makes room again.
    for index in 0..2 {
        store::remove_account(OWNER, ProviderId::Anthropic, &format!("{index:012x}"));
    }
    let (status, body) = add("anthropic").await;
    assert_refused(status, &body, limit);
    store::remove_account(OWNER, ProviderId::Anthropic, &format!("{:012x}", 2));
    let (status, _) = add("anthropic").await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(linked_count(ProviderId::Anthropic), limit);

    accounts::set_root_for_test(None);
    store::reset_for_test();
}
