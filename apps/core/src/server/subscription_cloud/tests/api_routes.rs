//! Owner-only plan routes driven through their shipping handlers: routing
//! settings persist and steer [`start_or_fall_back`], cooldowns clear only what
//! was named, sign-ins are rate limited per account, and runs and sessions stay
//! scoped to their owner. Shares the parent suite's fake CLI, store and `SERIAL`.
use super::*;
use axum::extract::{Path as RoutePath, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Extension;
use serde_json::{json, Value};

async fn reply(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

async fn put_routing(auth: ResolvedAuthorization, body: &[u8]) -> (StatusCode, Value) {
    reply(api::put_routing(Extension(auth), axum::body::Bytes::copy_from_slice(body)).await).await
}

fn run_record(conversation_id: &str, owner: &str, backend: CloudTaskBackend) -> store::RunRecord {
    store::RunRecord {
        conversation_id: conversation_id.to_owned(),
        owner: owner.to_owned(),
        backend,
        environment_id: "env-1".into(),
        executor: "claude-code".into(),
        account_id: None,
        external_id: Some(SESSION.into()),
        url: Some(format!("https://claude.ai/code/{SESSION}")),
        status: "submitted".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: None,
        branch: None,
        created_at: 1,
        updated_at: 1,
        result_posted: false,
    }
}

// ── Routing settings (GET/PUT /api/cloud-task-backends/routing) ──────────────

#[tokio::test]
async fn routing_settings_are_validated_persisted_and_steer_the_next_task() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    let fake = FakeCli::install(claude_with(started_claude));

    // Refused bodies change nothing.
    let (status, body) = put_routing(node_owner(), b"{not json").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "invalid_request");
    let (status, _) =
        put_routing(node_owner(), br#"{"enabled":true,"useEveryAccount":true}"#).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unknown fields are refused"
    );
    let (status, body) = put_routing(
        node_owner(),
        br#"{"enabled":true,"defaultAccounts":{"anthropic":"not-linked"}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "invalid_request");
    let (status, _) = put_routing(
        node_owner(),
        br#"{"enabled":true,"accountFallbacks":{"openai":["not-linked"]}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = put_routing(
        node_owner(),
        br#"{"enabled":true,"defaultOrder":["ryu-box","ryu-box"]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = put_routing(other_user(), br#"{"enabled":true}"#).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&body), "subscription_backend_owner_only");
    assert_eq!(store::settings("node-owner"), RoutingSettings::default());
    assert_eq!(
        store::settings("user:someone-else"),
        RoutingSettings::default()
    );

    // A linked account is accepted; the saved settings read back verbatim.
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let settings = json!({
        "enabled": true,
        "defaultOrder": ["ryu-box"],
        "environments": {"env-1": {"claudeCheckout": dir.path().to_string_lossy()}},
        "defaultAccounts": {"anthropic": work},
    });
    let (status, saved) = put_routing(node_owner(), settings.to_string().as_bytes()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, read) = reply(api::get_routing(Extension(node_owner())).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read, saved);
    assert_eq!(read["defaultOrder"], json!(["ryu-box"]));
    assert_eq!(read["defaultAccounts"]["anthropic"], json!(work));
    let (status, _) = reply(api::get_routing(Extension(other_user())).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Box-only order: the task goes to the Box without starting any CLI run.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, RouteOutcome::UseBox { .. }),
        "{outcome:?}"
    );
    // The plan's sign-in is probed, but no task is started on the CLI.
    assert!(
        fake.calls()
            .iter()
            .all(|call| call.as_slice() == ["claude", "auth", "status"]),
        "{:?}",
        fake.calls()
    );

    // Putting the plan first makes the next task start on it.
    let mut plan_first = settings;
    plan_first["defaultOrder"] = json!(["anthropic-subscription-cli", "ryu-box"]);
    let (status, _) = put_routing(node_owner(), plan_first.to_string().as_bytes()).await;
    assert_eq!(status, StatusCode::OK);
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .unwrap();
    let RouteOutcome::Started { record, .. } = outcome else {
        panic!("expected the plan, got {outcome:?}");
    };
    assert_eq!(record.backend, CloudTaskBackend::AnthropicSubscriptionCli);
    assert_eq!(record.account(), work, "the saved default account is used");
}

// ── Backend cooldown and runs ────────────────────────────────────────────────

#[tokio::test]
async fn clearing_a_backend_cooldown_clears_only_that_providers_default_sign_in() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let now = unix_now();
    let anthropic = default_key(Provider::Anthropic);
    let openai = default_key(Provider::Openai);
    store::start_cooldown(&anthropic, now);
    store::start_cooldown(&openai, now);
    let clear = |auth: ResolvedAuthorization, backend: &str| {
        api::clear_cooldown(Extension(auth), RoutePath(backend.to_owned()))
    };

    let (status, body) = reply(clear(other_user(), "anthropic-subscription-cli").await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&body), "subscription_backend_owner_only");
    for unknown in ["ryu-box", "anthropic-subscription", ""] {
        let (status, body) = reply(clear(node_owner(), unknown).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}");
        assert_eq!(code(&body), "subscription_backend_not_found");
    }
    assert!(store::cooldown_remaining(&anthropic, now).is_some());

    let (status, body) = reply(clear(node_owner(), "anthropic-subscription-cli").await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cooldown"], Value::Null);
    assert!(store::cooldown_remaining(&anthropic, now).is_none());
    assert!(
        store::cooldown_remaining(&openai, now).is_some(),
        "the other provider keeps its cooldown"
    );
}

#[tokio::test]
async fn run_status_stop_and_diff_are_scoped_to_the_runs_owner() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let _fake = FakeCli::install(Box::new(|_| fail("unused")));
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mine = fresh_conversation();
    let theirs = fresh_conversation();
    store::save_run(run_record(
        &mine,
        "node-owner",
        CloudTaskBackend::AnthropicSubscriptionCli,
    ));
    store::save_run(run_record(
        &theirs,
        "user:someone-else",
        CloudTaskBackend::AnthropicSubscriptionCli,
    ));
    let status_of = |auth: ResolvedAuthorization, conversation: &str| {
        api::run_status(
            State(state.clone()),
            Extension(auth),
            RoutePath(conversation.to_owned()),
        )
    };

    // Another caller's run, and a conversation with no run, read as not found.
    for (auth, conversation) in [
        (other_user(), mine.clone()),
        (node_owner(), theirs.clone()),
        (node_owner(), fresh_conversation()),
    ] {
        let (status, body) = reply(status_of(auth.clone(), &conversation).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(code(&body), "subscription_run_not_found");
        let (status, _) =
            reply(api::stop_run(Extension(auth.clone()), RoutePath(conversation.clone())).await)
                .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) =
            reply(api::run_diff(Extension(auth), RoutePath(conversation.clone())).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (status, _) = reply(status_of(node_owner(), "../etc/passwd").await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The owner reads their run; a provider-cloud run cannot be stopped or diffed here.
    let (status, body) = reply(status_of(node_owner(), &mine).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversationId"], json!(mine));
    assert_eq!(body["externalId"], json!(SESSION));
    assert_eq!(body["status"], "submitted");
    let (status, body) =
        reply(api::stop_run(Extension(node_owner()), RoutePath(mine.clone())).await).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code(&body), "subscription_run_remote");
    let (status, body) =
        reply(api::run_diff(Extension(node_owner()), RoutePath(mine.clone())).await).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code(&body), "subscription_run_remote");
    assert_eq!(
        store::run(&theirs).unwrap().owner,
        "user:someone-else",
        "untouched"
    );
}

// ── Linked accounts (accounts_api) ───────────────────────────────────────────

#[tokio::test]
async fn account_sign_in_is_limited_to_one_per_account_per_minute() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let fake = FakeCli::install(Box::new(|_| fail("unused")));
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let personal = link("node-owner", ProviderId::Anthropic, "personal");
    let sign_in = |auth: ResolvedAuthorization, provider: &str, id: &str| {
        accounts_api::sign_in_account(
            Extension(auth),
            RoutePath((provider.to_owned(), id.to_owned())),
        )
    };
    let detached = || fake.detached.lock().unwrap().len();

    let (status, body) = reply(sign_in(node_owner(), "anthropic", &work).await).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(detached(), 1);
    let (status, body) = reply(sign_in(node_owner(), "anthropic", &work).await).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code(&body), "subscription_sign_in_pending");
    assert_eq!(detached(), 1, "no second login process");
    let (status, _) = reply(sign_in(node_owner(), "anthropic", &personal).await).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "another account has its own slot"
    );
    assert_eq!(detached(), 2);

    for (provider, id) in [
        ("anthropic", "not-linked"),
        ("openai", work.as_str()),
        ("gemini", work.as_str()),
    ] {
        let (status, body) = reply(sign_in(node_owner(), provider, id).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{provider}/{id}");
        assert_eq!(code(&body), "subscription_account_not_found");
    }
    let fresh = link("node-owner", ProviderId::Openai, "spare");
    let (status, _) = reply(sign_in(other_user(), "openai", &fresh).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(detached(), 2, "refused calls start nothing");
}

#[tokio::test]
async fn account_cooldown_clears_only_the_named_linked_account() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let now = unix_now();
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let personal = link("node-owner", ProviderId::Anthropic, "personal");
    let key = |id: &str| accounts::account_key(Provider::Anthropic, id);
    for id in [work.as_str(), personal.as_str(), "not-linked"] {
        store::start_cooldown(&key(id), now);
    }
    let clear = |auth: ResolvedAuthorization, id: &str| {
        accounts_api::clear_account_cooldown(
            Extension(auth),
            RoutePath(("anthropic".to_owned(), id.to_owned())),
        )
    };

    let (status, _) = reply(clear(other_user(), &work).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = reply(clear(node_owner(), "not-linked").await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code(&body), "subscription_account_not_found");
    assert!(store::cooldown_remaining(&key("not-linked"), now).is_some());
    assert!(store::cooldown_remaining(&key(&work), now).is_some());

    let (status, body) = reply(clear(node_owner(), &work).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], json!(work));
    assert!(store::cooldown_remaining(&key(&work), now).is_none());
    assert!(store::cooldown_remaining(&key(&personal), now).is_some());
}

#[tokio::test]
async fn session_list_holds_only_the_owners_runs_each_tagged_with_its_account() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    // Codex lists cannot be read: those accounts are reported unavailable.
    let _fake = FakeCli::install(Box::new(|_| fail("not signed in")));
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let mine = fresh_conversation();
    let on_work = fresh_conversation();
    let theirs = fresh_conversation();
    store::save_run(run_record(
        &mine,
        "node-owner",
        CloudTaskBackend::AnthropicSubscriptionCli,
    ));
    let mut work_run = run_record(
        &on_work,
        "node-owner",
        CloudTaskBackend::AnthropicSubscriptionCli,
    );
    work_run.account_id = Some(work.clone());
    store::save_run(work_run);
    store::save_run(run_record(
        &theirs,
        "user:someone-else",
        CloudTaskBackend::AnthropicSubscriptionCli,
    ));

    let (status, body) = reply(accounts_api::list_sessions(Extension(node_owner())).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sessions = body["sessions"].as_array().unwrap();
    let conversations: Vec<&str> = sessions
        .iter()
        .filter_map(|session| session["conversationId"].as_str())
        .collect();
    assert_eq!(conversations.len(), 2, "{body}");
    assert!(conversations.contains(&mine.as_str()));
    assert!(conversations.contains(&on_work.as_str()));
    assert!(!conversations.contains(&theirs.as_str()), "{body}");
    let work_session = sessions
        .iter()
        .find(|session| session["conversationId"] == json!(on_work))
        .unwrap();
    assert_eq!(work_session["accountId"], json!(work));
    assert_eq!(work_session["tag"], "Claude · work");
    assert!(!body["unavailable"].as_array().unwrap().is_empty());

    let (status, body) = reply(accounts_api::list_sessions(Extension(other_user())).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&body), "subscription_backend_owner_only");
}
