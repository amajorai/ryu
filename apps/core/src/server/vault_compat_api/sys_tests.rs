//! `/v1/sys/*` mount discovery.

use super::fixture_test::*;

/// Only the `secret/` KV v2 mount exists: any other mount is refused like a
/// path the token cannot reach, and discovery needs a token at all.
#[tokio::test]
async fn ui_mount_reports_only_the_kv_v2_mount_and_needs_a_token() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let (status, body) = call(
        app,
        "GET",
        "/v1/sys/internal/ui/mounts/secret/app",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));

    let token = login(&fixture).await;
    let (status, body) = call(
        app,
        "GET",
        "/v1/sys/internal/ui/mounts/secret/app",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["path"], "secret/");
    assert_eq!(body["data"]["type"], "kv");

    for mount in ["transit/keys", "kv/app", "secretx/app"] {
        let uri = format!("/v1/sys/internal/ui/mounts/{mount}");
        let (status, body) = call(app, "GET", &uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{mount}: {body}");
    }
}

use super::sys::{health_codes, health_status, HealthCodes};

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn health_codes_follow_vault_query_rules() {
    let defaults = HealthCodes {
        active: StatusCode::OK,
        sealed: StatusCode::SERVICE_UNAVAILABLE,
        uninit: StatusCode::NOT_IMPLEMENTED,
    };
    assert_eq!(health_codes(None), Ok(defaults));
    assert_eq!(
        health_codes(Some(
            "standbyok=true&perfstandbyok=0&standbycode=200&drsecondarycode=472"
        )),
        Ok(defaults)
    );
    let overridden = health_codes(Some(
        "activecode=299&sealedcode=200&uninitcode=418&sealedcode=500",
    ))
    .unwrap();
    // The first value of a repeated parameter wins, as in Vault.
    assert_eq!(overridden.active.as_u16(), 299);
    assert_eq!(overridden.sealed, StatusCode::OK);
    assert_eq!(overridden.uninit.as_u16(), 418);
    for bad in [
        "activecode=abc",
        "sealedcode=99",
        "standbyok=maybe",
        "performancestandbycode=-1",
    ] {
        assert_eq!(health_codes(Some(bad)), Err(()), "{bad}");
    }
    // Uninitialized wins over sealed, sealed over active.
    assert_eq!(
        health_status(false, true, defaults),
        StatusCode::NOT_IMPLEMENTED
    );
    assert_eq!(
        health_status(true, true, defaults),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(health_status(true, false, defaults), StatusCode::OK);
}

/// `sys/health` needs no token, answers with Vault's fields and codes (query
/// overrides included), reveals nothing else, and keeps answering while sealed.
#[tokio::test]
async fn health_reports_vault_fields_and_status_codes() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let (status, body) = call(app, "GET", "/v1/sys/health", None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        keys(&body),
        [
            "enterprise",
            "initialized",
            "performance_standby",
            "replication_dr_mode",
            "replication_performance_mode",
            "sealed",
            "server_time_utc",
            "standby",
            "version"
        ]
    );
    assert_eq!(body["initialized"], true);
    assert_eq!(body["sealed"], false);
    assert_eq!(body["standby"], false);
    assert_eq!(body["replication_dr_mode"], "disabled");
    assert!(body["server_time_utc"].as_i64().unwrap() > 1_700_000_000);

    let (status, _) = call(app, "GET", "/v1/sys/health?activecode=299", None, None).await;
    assert_eq!(status.as_u16(), 299);
    let (status, body) = call(app, "GET", "/v1/sys/health?activecode=abc", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "errors": [] }));
    let (status, body) = call(app, "HEAD", "/v1/sys/health", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_null());

    seal(&fixture);
    let (status, body) = call(app, "GET", "/v1/sys/health", None, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["sealed"], true);
    assert_eq!(body["standby"], true);
    let (status, _) = call(app, "GET", "/v1/sys/health?sealedcode=200", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(app, "HEAD", "/v1/sys/health", None, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    unseal(&fixture).await;
    let (status, _) = call(app, "GET", "/v1/sys/health", None, None).await;
    assert_eq!(status, StatusCode::OK);
}

/// `sys/seal-status` needs no token, reports what the native seal status
/// reports in Vault's field names, and nothing more (no key versions).
#[tokio::test]
async fn seal_status_matches_the_native_status_in_vault_fields() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let (status, body) = call(app, "GET", "/v1/sys/seal-status", None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        keys(&body),
        [
            "initialized",
            "migration",
            "n",
            "nonce",
            "progress",
            "recovery_seal",
            "sealed",
            "t",
            "type",
            "version"
        ]
    );
    let native = fixture.store.keyring.status();
    assert_eq!(body["sealed"], native.sealed);
    assert_eq!(body["t"], native.threshold);
    assert_eq!(body["n"], native.shares);
    assert_eq!(body["progress"], native.progress);
    assert_eq!(body["type"], serde_json::to_value(native.mode).unwrap());
    assert_eq!(body["initialized"], true);

    seal(&fixture);
    let (status, body) = call(app, "GET", "/v1/sys/seal-status", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sealed"], true);
    unseal(&fixture).await;
}

#[tokio::test]
async fn leader_reports_no_ha_and_is_refused_while_sealed() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let (status, body) = call(&fixture.app, "GET", "/v1/sys/leader", None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ha_enabled"], false);
    assert_eq!(body["leader_address"], "");
    seal(&fixture);
    let (status, body) = call(&fixture.app, "GET", "/v1/sys/leader", None, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, json!({ "errors": ["Vault is sealed"] }));
    unseal(&fixture).await;
}
