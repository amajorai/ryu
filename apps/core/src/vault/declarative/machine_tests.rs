//! Tests for machine identities in the init file: auth drift, declared
//! disables (also across auth drift), and retrying a cut-off whose leases
//! are still live.

use serde_json::{json, Value};

use super::*;
use crate::vault::machine::AuthMethod;

fn spec(value: &Value) -> InitSpec {
    parse(&value.to_string()).unwrap()
}

#[tokio::test]
async fn machine_auth_drift_is_never_reconciled_but_settings_are() {
    let store = PluginSecretStore::in_memory().unwrap();
    let base = json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"] }] });
    apply(&store, &spec(&base)).await.unwrap();
    let issued_role_id = store.machine_get("ci").await.unwrap().auth;

    let settings = json!({ "reconcile": true, "machines": [{
        "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci", "deploy"], "disabled": true
    }] });
    let updated = apply(&store, &spec(&settings)).await.unwrap();
    assert_eq!(updated.updated, vec!["machine:ci".to_owned()]);
    let ci = store.machine_get("ci").await.unwrap();
    assert!(ci.disabled);
    assert_eq!(ci.policies.len(), 2);
    assert_eq!(ci.auth, issued_role_id, "the generated role id is kept");

    let auth = json!({ "reconcile": true, "machines": [{ "name": "ci", "auth": {
        "kind": "jwt", "issuer": "https://issuer.example",
        "jwksUrl": "https://issuer.example/jwks", "audiences": ["ryu"]
    } }] });
    let report = apply(&store, &spec(&auth)).await.unwrap();
    assert_eq!(report.drifted, vec!["machine:ci".to_owned()]);
    assert!(report.updated.is_empty());
    assert_eq!(store.machine_get("ci").await.unwrap().auth, issued_role_id);
}

/// A random dynamic role, and a lease on it requested with `token`.
async fn held_lease(store: &PluginSecretStore, token: &str) -> String {
    use crate::vault::tokens::{with_request_context, RequestContext};
    let actor = AuditActor::system();
    let role: crate::vault::dynamic::ProviderConfig = serde_json::from_value(json!({
        "kind": "random", "length": 16, "charset": "hex"
    }))
    .unwrap();
    store
        .dynamic_put_role("held", &role, Some(600), Some(600), &actor)
        .await
        .unwrap();
    with_request_context(RequestContext::new(None), async {
        store.token_lookup(token).await.unwrap().unwrap();
        store
            .dynamic_issue("held", None, None, &actor)
            .await
            .unwrap()
            .lease
            .id
    })
    .await
}

#[tokio::test]
async fn a_declared_disable_applies_even_when_the_auth_method_drifted() {
    let store = PluginSecretStore::in_memory().unwrap();
    let base = json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"] }] });
    apply(&store, &spec(&base)).await.unwrap();
    let issued = store.machine_get("ci").await.unwrap();
    let AuthMethod::AppRole { role_id } = &issued.auth else {
        panic!("approle")
    };
    let actor = AuditActor::system();
    let (secret, _) = store
        .machine_issue_secret_id("ci", None, None, &actor)
        .await
        .unwrap();
    let token = store.approle_login(role_id, &secret).await.unwrap();
    // The token holds a dynamic lease, so the test sees the revoke tree run.
    let lease = held_lease(&store, &token.token).await;
    let jwt = |reconcile: bool, disabled: bool| {
        json!({ "reconcile": reconcile, "machines": [{ "name": "ci", "policies": ["other"],
            "disabled": disabled, "auth": {
                "kind": "jwt", "issuer": "https://issuer.example",
                "jwksUrl": "https://issuer.example/jwks", "audiences": ["ryu"]
            } }] })
    };

    // Without reconcile, drift is only reported, as for any other setting.
    let report = apply(&store, &spec(&jwt(false, true))).await.unwrap();
    assert_eq!(report.drifted, vec!["machine:ci".to_owned()]);
    assert!(!store.machine_get("ci").await.unwrap().disabled);

    // On reconcile the disable is applied; the auth and the other settings
    // stay as they are, and the auth drift is still reported.
    let report = apply(&store, &spec(&jwt(true, true))).await.unwrap();
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.drifted, vec!["machine:ci".to_owned()]);
    assert_eq!(report.updated, vec!["machine:ci".to_owned()]);
    let ci = store.machine_get("ci").await.unwrap();
    assert!(ci.disabled);
    assert_eq!(ci.auth, issued.auth);
    assert_eq!(ci.policies, issued.policies);
    // The disable cut off the token it had issued and revoked its lease.
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    assert!(store.lease_get(&lease).await.unwrap().revoked_at.is_some());

    // A declared enable is never applied across auth drift.
    let report = apply(&store, &spec(&jwt(true, false))).await.unwrap();
    assert!(report.updated.is_empty(), "{report:?}");
    assert!(store.machine_get("ci").await.unwrap().disabled);
}

#[tokio::test]
async fn reconcile_retries_the_cut_off_of_a_disabled_identity_with_live_leases() {
    use crate::vault::leases::NewLease;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let base = json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"] }] });
    apply(&store, &spec(&base)).await.unwrap();
    let ci = store.machine_get("ci").await.unwrap();
    let AuthMethod::AppRole { role_id } = &ci.auth else {
        panic!("approle")
    };
    let (secret, _) = store
        .machine_issue_secret_id("ci", None, None, &actor)
        .await
        .unwrap();
    let token = store.approle_login(role_id, &secret).await.unwrap();
    // A lease whose role does not exist yet: its provider revoke fails until
    // the role is created.
    let stuck = store
        .lease_create(
            NewLease {
                role: "later",
                provider: "random",
                issued_to: None,
                ttl_secs: 600,
                max_ttl_secs: 600,
                renewable: false,
                revoke_data: &Value::Null,
            },
            &actor,
        )
        .await
        .unwrap()
        .id;
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET token_accessor = ?1 WHERE id = ?2",
            rusqlite::params![token.accessor, stuck],
        )
        .unwrap();
    }
    let disabled = json!({ "reconcile": true, "machines": [{
        "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"], "disabled": true
    }] });
    // The disable fails closed on the stuck lease but stays committed.
    let first = apply(&store, &spec(&disabled)).await.unwrap();
    assert_eq!(first.errors.len(), 1, "{first:?}");
    assert!(store.machine_get("ci").await.unwrap().disabled);

    // Nothing else differs now, but the live lease is still reported.
    let quiet = json!({ "machines": [{
        "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"], "disabled": true
    }] });
    let report = apply(&store, &spec(&quiet)).await.unwrap();
    assert_eq!(report.drifted, vec!["machine:ci:leases".to_owned()]);

    // On reconcile it is retried, and still names the lease while it fails.
    let report = apply(&store, &spec(&disabled)).await.unwrap();
    assert_eq!(report.errors.len(), 1, "{report:?}");
    assert!(
        report.errors[0].starts_with("machine:ci:leases"),
        "{report:?}"
    );
    assert!(report.errors[0].contains(&stuck), "{report:?}");

    // Once the provider can revoke it, the next reconcile does.
    let role: crate::vault::dynamic::ProviderConfig = serde_json::from_value(json!({
        "kind": "random", "length": 16, "charset": "hex"
    }))
    .unwrap();
    store
        .dynamic_put_role("later", &role, Some(600), Some(600), &actor)
        .await
        .unwrap();
    let report = apply(&store, &spec(&disabled)).await.unwrap();
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.updated, vec!["machine:ci:leases".to_owned()]);
    assert!(store.lease_get(&stuck).await.unwrap().revoked_at.is_some());
    // And afterwards there is nothing left to report.
    let report = apply(&store, &spec(&disabled)).await.unwrap();
    assert!(
        report.updated.is_empty() && report.drifted.is_empty(),
        "{report:?}"
    );
}
