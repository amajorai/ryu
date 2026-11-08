//! Box credential fills that reach the commit: the request bodies, the
//! outcome audit, echo attribution, fill-set revoke, the metadata listing,
//! and that no value appears in a result or an error.

use super::*;
use ryu_sandbox::box_session::BrowserFillEchoed;

fn body_of(fake: &FakeFillBox, method: &str, suffix: &str) -> Value {
    fake.seen(method)
        .into_iter()
        .find(|seen| seen.1.ends_with(suffix))
        .map(|seen| seen.2)
        .unwrap_or_else(|| panic!("no {method} …{suffix}"))
}

#[tokio::test]
async fn a_password_commits_as_a_login_url_bound_placeholder() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    let fake = FakeFillBox::start().await;
    let id = box_id();
    let result = execute(
        &env(vault, &registry, &fake),
        &id,
        &agent(),
        &args(&account, FillField::Password),
    )
    .await
    .unwrap();
    assert_eq!(result["verb"], "fill_credential");
    assert_eq!(result["result"]["protected"], true);
    assert_eq!(result["result"]["field"], "password");
    let prepare = body_of(&fake, "POST", "/browser-fills");
    assert_eq!(
        prepare["pageHosts"],
        json!(["github.com", "www.github.com"])
    );
    assert_eq!(
        prepare["bindHosts"],
        json!(["github.com", "www.github.com"])
    );
    assert_eq!(prepare["submitUrls"], json!(["https://github.com/session"]));
    assert_eq!(prepare["field"], "password");
    let commit = body_of(&fake, "POST", "/browser-fills/fill_1");
    assert_eq!(commit["mode"], "placeholder");
    assert_eq!(commit["submitUrls"], json!(["https://github.com/session"]));
    assert_eq!(commit["unbound"], false);
    assert_eq!(commit["ttlSeconds"], 45);
    assert_eq!(reveals(vault).await, 1);
    // The value went only to the Box's commit, never into the result.
    assert!(!result.to_string().contains(SECRET));
    let live = fill_ledger::known(&id.0, "fill_1").expect("tracked");
    assert_eq!(live.account, account);
}

#[tokio::test]
async fn username_and_codes_commit_as_text_and_attached_sets_pin_on_success() {
    let vault = vault();
    let registry = Registry::default();
    let set_id = attached(vault, &registry, &["https://github.com/session"], false).await;
    let fake = FakeFillBox::start().await;
    let env = env(vault, &registry, &fake);
    let id = box_id();
    execute(
        &env,
        &id,
        &agent(),
        &args("attached:1", FillField::Username),
    )
    .await
    .unwrap();
    let commit = body_of(&fake, "POST", "/browser-fills/fill_1");
    assert_eq!(
        commit,
        json!({ "mode": "text", "value": "jay", "submit": false })
    );
    assert!(
        registry
            .get(&set_id, crate::vault::now_millis())
            .unwrap()
            .claimed
    );
    // Pinned to this Box: another Box is refused before anything is prepared.
    let other = FakeFillBox::start().await;
    let error = execute(
        &self::env(vault, &registry, &other),
        &box_id(),
        &agent(),
        &args("attached:1", FillField::Password),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("another browser session"),
        "{error:#}"
    );
    assert!(other.fill_calls().is_empty());
}

#[tokio::test]
async fn an_unbound_item_commits_unbound_and_a_failed_commit_cancels() {
    let vault = vault();
    let registry = Registry::default();
    attached(vault, &registry, &[], true).await;
    let fake = FakeFillBox::start().await;
    let id = box_id();
    execute(
        &env(vault, &registry, &fake),
        &id,
        &agent(),
        &args("attached:1", FillField::Password),
    )
    .await
    .unwrap();
    let commit = body_of(&fake, "POST", "/browser-fills/fill_1");
    assert_eq!(commit["unbound"], true);
    assert_eq!(commit["submitUrls"], json!([]));

    let refusing = FakeFillBox::start().await;
    refusing.state.lock().unwrap().commit = Some((
        409,
        json!({ "error": { "code": "conflict", "message": "insert refused" } }),
    ));
    let error = execute(
        &env(vault, &registry, &refusing),
        &id,
        &agent(),
        &args("attached:1", FillField::Password),
    )
    .await
    .unwrap_err();
    let text = format!("{error:#}");
    assert!(
        text.contains("conflict") && !text.contains("start a new session Box"),
        "{text}"
    );
    assert!(!text.contains(SECRET));
    assert_eq!(
        refusing.seen("DELETE").len(),
        1,
        "the failed commit was cancelled"
    );
}

#[tokio::test]
async fn the_outcome_is_audited_and_an_echo_blocks_the_account() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    let fake = FakeFillBox::start().await;
    let id = box_id();
    let env = env(vault, &registry, &fake);
    execute(&env, &id, &agent(), &args(&account, FillField::Password))
        .await
        .unwrap();
    let live = fill_ledger::known(&id.0, "fill_1").unwrap();
    fake.state.lock().unwrap().status =
        Some(json!({ "state": "consumed", "consumed": { "method": "POST", "path": "/session" } }));
    fill_ledger::audit_outcome(&fake.client, vault, &live).await;
    assert!(audit_actions(vault)
        .await
        .contains(&"box_fill.consumed".to_owned()));

    fake.state.lock().unwrap().status =
        Some(json!({ "state": "echoed", "echoed": { "host": "github.com", "path": "/me" } }));
    fill_ledger::audit_outcome(&fake.client, vault, &live).await;
    assert!(audit_actions(vault)
        .await
        .contains(&"box_fill.echoed".to_owned()));
    let error = execute(&env, &id, &agent(), &args(&account, FillField::Password))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("echoed"), "{error}");
}

#[tokio::test]
async fn an_echo_reported_at_prepare_is_attributed_and_audited() {
    let vault = vault();
    let registry = Registry::default();
    let account = own_account(vault, true).await;
    let fake = FakeFillBox::start().await;
    let id = box_id();
    let env = env(vault, &registry, &fake);
    execute(&env, &id, &agent(), &args(&account, FillField::Password))
        .await
        .unwrap();
    // The same service fill id in another Box is another fill.
    fill_ledger::track(LiveFill {
        box_id: box_id().0,
        fill_id: "fill_1".into(),
        set_id: None,
        account: "someone-else".into(),
        agent_id: None,
        field: "password",
        host: "example.com".into(),
    });
    assert_eq!(
        fill_ledger::known(&id.0, "fill_1").unwrap().account,
        account
    );
    fake.state.lock().unwrap().prepare = Some((
        409,
        json!({ "error": { "code": "browser_fill_echoed", "message": "echoed",
            "details": { "hosts": ["github.com"], "fillIds": ["fill_1"] } } }),
    ));
    let error = execute(&env, &id, &agent(), &args(&account, FillField::Username))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), ECHO_REFUSAL);
    assert!(audit_actions(vault)
        .await
        .contains(&"box_fill.echoed".to_owned()));
    let echoed = BrowserFillEchoed::default();
    fill_ledger::note_echo(vault, &id.0, &echoed, "other").await;
    assert!(fill_ledger::check(&id.0, "other", false).is_err());
}

#[tokio::test]
async fn a_fill_set_revoke_cancels_its_live_box_fills() {
    let vault = vault();
    let registry = Registry::default();
    let set_id = attached(vault, &registry, &["https://github.com/session"], false).await;
    let fake = FakeFillBox::start().await;
    let id = box_id();
    execute(
        &env(vault, &registry, &fake),
        &id,
        &agent(),
        &args("attached:1", FillField::Password),
    )
    .await
    .unwrap();
    assert_eq!(fill_ledger::live_for_set(&set_id).len(), 1);
    let revoked = revoke_with(&fake.client, &set_id).await;
    assert_eq!(
        revoked,
        RevokedFills {
            cancelled: 1,
            pending: 0
        }
    );
    assert_eq!(fake.seen("DELETE").len(), 1);
    assert!(fill_ledger::live_for_set(&set_id).is_empty());
    assert_eq!(revoke_set("fs_none").await, RevokedFills::default());
}

#[tokio::test]
async fn listing_returns_metadata_only() {
    let vault = vault();
    let registry = Registry::default();
    own_account(vault, true).await;
    attached(vault, &registry, &["https://github.com/session"], false).await;
    let listed = list_for(vault, &registry, None, &agent()).await.unwrap();
    let result = &listed["result"];
    assert_eq!(
        result["accounts"][0]["submit_urls"],
        json!(["https://github.com/session"])
    );
    assert_eq!(result["accounts"][0]["has_password"], true);
    assert_eq!(result["attached"][0]["handle"], "attached:1");
    assert_eq!(result["attached"][0]["login_url_bound"], true);
    let text = listed.to_string();
    assert!(!text.contains(SECRET), "{text}");
    assert!(!text.contains("\"password\":\""), "{text}");
    // Nobody (no agent) sees no attached items.
    let nobody = list_for(vault, &registry, None, &Caller::Unassigned)
        .await
        .unwrap();
    assert_eq!(nobody["result"]["attached"], json!([]));
    assert_eq!(reveals(vault).await, 0);
}

#[tokio::test]
async fn revoke_set_cancels_through_the_nodes_box_client() {
    let harness = crate::server::session_box::tests::Harness::new().await;
    let id = box_id();
    let set_id = format!("fs_{}", uuid::Uuid::new_v4().simple());
    fill_ledger::track(LiveFill {
        box_id: id.0.clone(),
        fill_id: "fill_h".into(),
        set_id: Some(set_id.clone()),
        account: "attached:1".into(),
        agent_id: Some("agent-1".into()),
        field: "password",
        host: "github.com".into(),
    });
    let revoked = revoke_set(&set_id).await;
    // The harness's Box answers 404 for an unknown fill: nothing left to cancel.
    assert_eq!(
        revoked,
        RevokedFills {
            cancelled: 1,
            pending: 0
        }
    );
    let path = format!("/v1/boxes/{}/browser-fills/fill_h", id.0);
    assert!(harness.fake.find("DELETE", &path).is_some());
    assert!(fill_ledger::live_for_set(&set_id).is_empty());
}
