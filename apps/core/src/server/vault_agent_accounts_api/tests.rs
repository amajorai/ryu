use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::agent_accounts::fill_sets::Registry;

fn operator(store: &'static PluginSecretStore) -> Ctx {
    Ctx {
        store,
        node: None,
        node_id: "local".into(),
        caller: None,
        manager: true,
        policies: Vec::new(),
        jwt: None,
    }
}

fn member(store: &'static PluginSecretStore) -> Ctx {
    Ctx {
        manager: false,
        ..operator(store)
    }
}

async fn body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn query(agent: &str) -> AccountQuery {
    AccountQuery {
        agent_id: Some(agent.into()),
        site: None,
    }
}

#[tokio::test]
async fn create_and_list_never_return_a_secret() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let ctx = operator(store);
    let (status, created) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "https://github.com", "email": "bot@example.com" }),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let account = &created["account"];
    assert_eq!(account["has_password"], true);
    assert_eq!(account["host"], "github.com");
    assert!(account.get("password").is_none(), "{created}");

    let (status, listed) = body(list_accounts(&ctx, &query("agent-1")).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["accounts"].as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains("\"value\""), "{listed}");

    let (_, other) = body(list_accounts(&ctx, &query("agent-2")).await).await;
    assert!(other["accounts"].as_array().unwrap().is_empty());

    let (status, _) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "github.com", "password": "x" }),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unknown fields are refused"
    );
}

#[tokio::test]
async fn routes_follow_folder_policy() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let ctx = member(store);
    let (status, _) = body(list_accounts(&ctx, &query("agent-1")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "github.com" }),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn identity_mode_gates_agent_accounts() {
    use crate::agents::AgentIdentityMode;

    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let ctx = operator(store);
    // A managed agent the user limited has no accounts of its own.
    let limited = AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, Some(&[]));
    let (status, _) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "github.com" }),
            Some(&limited),
        )
        .await,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a limited managed agent has no accounts"
    );
    let (_, listed) = body(list_accounts(&ctx, &query("agent-1")).await).await;
    assert!(listed["accounts"].as_array().unwrap().is_empty());
    assert_eq!(
        require_account_allowed(Some(&limited), "acc_1")
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );

    // A legacy (unlimited managed) agent keeps the accounts it could
    // already create and use before identity modes existed.
    let legacy = AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, None);
    let (status, created) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "gitlab.com" }),
            Some(&legacy),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let legacy_account = created["account"]["id"].as_str().unwrap().to_owned();
    assert!(require_account_allowed(Some(&legacy), &legacy_account).is_ok());

    let individual = AgentAccountPolicy::from_parts(AgentIdentityMode::Individual, None);
    let (status, created) = body(
        create_account(
            &ctx,
            &query("agent-1"),
            json!({ "site": "github.com" }),
            Some(&individual),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let account = created["account"]["id"].as_str().unwrap().to_owned();
    assert!(require_account_allowed(Some(&individual), &account).is_ok());
    assert!(require_account_allowed(None, &account).is_ok());

    let allowed = vec![format!("agent:{account}")];
    let mixed = AgentAccountPolicy::from_parts(AgentIdentityMode::Mixed, Some(&allowed));
    assert!(require_account_allowed(Some(&mixed), &account).is_ok());
    assert!(require_account_allowed(Some(&mixed), &legacy_account).is_err());
    let none = AgentAccountPolicy::from_parts(AgentIdentityMode::Mixed, Some(&[]));
    assert_eq!(
        require_account_allowed(Some(&none), &account)
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    // A malformed key grants nothing.
    let malformed = vec![format!("agent: {account}")];
    let malformed = AgentAccountPolicy::from_parts(AgentIdentityMode::Mixed, Some(&malformed));
    assert!(require_account_allowed(Some(&malformed), &account).is_err());

    // Listing is the user's management view: every account, whatever the
    // agent may use, so the editor can offer each one.
    let (status, listed) = body(list_accounts(&ctx, &query("agent-1")).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["accounts"].as_array().unwrap().len(), 2, "{listed}");
}

// ── Fill sets ────────────────────────────────────────────────────────────────

async fn put_login(store: &PluginSecretStore, key: &str) {
    let put: crate::vault::items::ItemPut = serde_json::from_value(json!({
        "path": "web",
        "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": "username", "type": "text" },
            { "name": "password", "type": "password" },
        ],
        "values": { "url": "https://github.com", "username": "jay", "password": "s3cret-value" },
    }))
    .unwrap();
    store
        .item_put(
            key,
            put,
            &AuditActor::new("user", Some("u1")),
            crate::vault::items::PutAccess::FULL,
        )
        .await
        .unwrap();
}

fn fill_body(agent: &str, session: Option<&str>, field: FillField) -> FillBody {
    FillBody {
        agent_id: Some(agent.into()),
        account: "attached:1".into(),
        field,
        page_url: "https://github.com/login".into(),
        browser_session: session.map(str::to_owned),
    }
}

#[tokio::test]
async fn fill_sets_attach_list_fill_and_revoke() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    put_login(store, "github").await;
    let registry = Registry::default();
    let request = json!({ "agent_id": "agent-1", "items": [{ "path": "web", "key": "github" }] });

    // A caller without `use` on the item cannot attach it.
    let (status, _) =
        body(fill_sets::create(&member(store), &registry, request.clone(), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An agent limited to its own accounts gets none of the user's.
    let own_only =
        AgentAccountPolicy::from_parts(crate::agents::AgentIdentityMode::Individual, None);
    let (status, _) = body(
        fill_sets::create(
            &operator(store),
            &registry,
            request.clone(),
            Some(&own_only),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, created) =
        body(fill_sets::create(&operator(store), &registry, request.clone(), None).await).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert!(!created.to_string().contains("s3cret"), "{created}");
    let id = created["fillSet"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["fillSet"]["items"][0]["handle"], "attached:1");
    // Immutable: a second set for the same agent is refused.
    let (status, _) =
        body(fill_sets::create(&operator(store), &registry, request, None).await).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let attached = attached_items(&registry, Some("agent-1"));
    assert_eq!(attached.len(), 1);
    assert!(attached_items(&registry, Some("agent-2")).is_empty());
    let (_, listed) = body(fill_sets::list(&operator(store), &registry, None)).await;
    assert_eq!(listed["fillSets"].as_array().unwrap().len(), 1);
    let (_, hidden) = body(fill_sets::list(&member(store), &registry, None)).await;
    assert!(hidden["fillSets"].as_array().unwrap().is_empty());

    // The fill needs the sidecar's browser session and pins the set to it.
    let refused = release_attached(
        store,
        &registry,
        &fill_body("agent-1", None, FillField::Password),
        None,
    )
    .await;
    assert_eq!(refused.unwrap_err().status(), StatusCode::FORBIDDEN);
    let value = release_attached(
        store,
        &registry,
        &fill_body("agent-1", Some("lane-1"), FillField::Password),
        None,
    )
    .await
    .unwrap();
    assert_eq!(value, "s3cret-value");
    let other = release_attached(
        store,
        &registry,
        &fill_body("agent-1", Some("lane-2"), FillField::Password),
        None,
    )
    .await;
    assert_eq!(other.unwrap_err().status(), StatusCode::FORBIDDEN);
    let limited =
        AgentAccountPolicy::from_parts(crate::agents::AgentIdentityMode::Individual, None);
    let refused = release_attached(
        store,
        &registry,
        &fill_body("agent-1", Some("lane-1"), FillField::Password),
        Some(&limited),
    )
    .await;
    assert_eq!(refused.unwrap_err().status(), StatusCode::FORBIDDEN);

    let (status, _) = body(fill_sets::revoke(&member(store), &registry, &id).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, revoked) = body(fill_sets::revoke(&operator(store), &registry, &id).await).await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["box_fills_cancelled"], 0);
    assert_eq!(revoked["box_fills_pending"], 0);
    let gone = release_attached(
        store,
        &registry,
        &fill_body("agent-1", Some("lane-1"), FillField::Password),
        None,
    )
    .await;
    assert_eq!(gone.unwrap_err().status(), StatusCode::NOT_FOUND);

    // Login URLs and the Box opt-in are accepted, reported and audited.
    let bound = json!({ "agent_id": "agent-9", "items": [{ "path": "web", "key": "github",
        "submit_urls": ["https://github.com/session"], "box_unbound": false }] });
    let (status, created) =
        body(fill_sets::create(&operator(store), &registry, bound, None).await).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let item = &created["fillSet"]["items"][0];
    assert_eq!(item["submit_urls"], json!(["https://github.com/session"]));
    assert_eq!(item["login_url_bound"], true);
    let conn = store.conn.lock().await;
    let filter = crate::vault::audit::AuditFilter {
        limit: 50,
        ..Default::default()
    };
    let rows = crate::vault::audit::list(&conn, &filter).unwrap();
    let audited = serde_json::to_string(&rows).unwrap();
    assert!(audited.contains("https://github.com/session") && audited.contains("boxUnbound"));
}

fn member_with(store: &'static PluginSecretStore, caps: &[Capability]) -> Ctx {
    let policy: crate::vault::policy::Policy = serde_json::from_value(json!({
        "name": "items",
        "rules": [{ "path": "sys/items/**", "capabilities": caps }],
    }))
    .unwrap();
    Ctx::test_member(store, "user-1", vec![policy])
}

#[tokio::test]
async fn attaching_an_item_needs_an_ungated_read() {
    use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    put_login(store, "github").await;
    let registry = Registry::default();
    // A foreign site would let a use-only caller fill the value into a page
    // it controls and read it back, so `use` alone never attaches.
    let foreign = json!({
        "agent_id": "agent-1",
        "items": [{ "path": "web", "key": "github", "site": "https://attacker.example" }],
    });
    let use_only = member_with(store, &[Capability::List, Capability::Use]);
    let (status, refused) =
        body(fill_sets::create(&use_only, &registry, foreign.clone(), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    let plain = json!({ "agent_id": "agent-1", "items": [{ "path": "web", "key": "github" }] });
    let (status, _) =
        body(fill_sets::create(&use_only, &registry, plain.clone(), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A read gated by a control group is not released through a fill either.
    let mut gated = member_with(store, &[Capability::Use, Capability::Read]);
    gated.policies[0].rules[0].control_group = Some(ControlGroupSpec {
        ttl_secs: None,
        factors: vec![ControlGroupFactor {
            name: "security".into(),
            approvers: vec!["user:bob".into()],
            approvals: 1,
        }],
    });
    let (status, refused) =
        body(fill_sets::create(&gated, &registry, plain.clone(), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        refused.to_string().contains("vault_control_group_required"),
        "{refused}"
    );
    assert!(registry.list(None, crate::vault::now_millis()).is_empty());

    let reader = member_with(store, &[Capability::Use, Capability::Read]);
    let (status, created) = body(fill_sets::create(&reader, &registry, plain, None).await).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
}

#[test]
fn a_credential_fill_body_may_carry_the_browser_session() {
    let fill: FillBody = serde_json::from_value(json!({
        "account": "attached:1",
        "agent_id": "agent-1",
        "browser_session": "bs_1",
        "field": "password",
        "page_url": "https://github.com/login",
    }))
    .unwrap();
    assert_eq!(fill.browser_session.as_deref(), Some("bs_1"));
    // An own-account fill from an older sidecar has no session and still parses.
    let own: FillBody = serde_json::from_value(json!({
        "account": "acc_1",
        "field": "password",
        "page_url": "https://github.com/login",
    }))
    .unwrap();
    assert!(own.browser_session.is_none());
}

#[tokio::test]
async fn the_revoke_route_matches_a_fill_set_id() {
    use axum::extract::Path;
    use axum::routing::delete;
    use tower::ServiceExt;

    // Route a real request through axum on the production path, so a path
    // syntax the router treats as a literal segment fails here.
    let router = axum::Router::new().route(
        fill_sets::REVOKE_PATH,
        delete(|Path(id): Path<String>| async move { id }),
    );
    let request = axum::http::Request::builder()
        .method("DELETE")
        .uri("/api/vault/fill-sets/fs-123")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 10)
        .await
        .unwrap();
    assert_eq!(&bytes[..], b"fs-123");
}

#[test]
fn core_routes_use_axum_07_path_parameters() {
    // Core is on axum 0.7: `{param}` in a route path is a literal segment, not
    // a parameter, so such a route can never match a real id.
    fn scan(dir: &std::path::Path, hits: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan(&path, hits);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                for (line_no, line) in text.lines().enumerate() {
                    let Some(start) = line.find(".route(\"") else {
                        continue;
                    };
                    let rest = &line[start + ".route(\"".len()..];
                    let route = rest.split('"').next().unwrap_or_default();
                    // Only a path literal is a route; `.route(` also appears
                    // inside other tests' string literals.
                    if route.starts_with('/') && route.contains('{') {
                        hits.push(format!("{}:{}: {route}", path.display(), line_no + 1));
                    }
                }
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    scan(&root, &mut hits);
    assert!(
        hits.is_empty(),
        "use `:param`, not `{{param}}`:\n{}",
        hits.join("\n")
    );
}
