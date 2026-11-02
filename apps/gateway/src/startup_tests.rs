use super::{
    auth_disabled_startup_rejected, config_file_notice, cors_allowed_origins, cors_layer,
    hosted_web_origin_allowed, HOSTED_WEB_ORIGIN,
};

#[tokio::test]
async fn cors_exposes_the_request_id_and_rate_limit_headers() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let origin = "http://localhost:1420";
    let app = axum::Router::new()
        .route("/v1/models", axum::routing::get(|| async { "ok" }))
        .layer(cors_layer(vec![axum::http::HeaderValue::from_static(
            origin,
        )]));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/models")
                .header("origin", origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        origin
    );
    let exposed = response
        .headers()
        .get("access-control-expose-headers")
        .expect("expose list")
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    for name in [
        "x-request-id",
        "retry-after",
        "ratelimit",
        "ratelimit-policy",
        "x-provider",
        "x-routed-model",
    ] {
        assert!(
            exposed.split(',').any(|item| item.trim() == name),
            "{name} in {exposed}"
        );
    }
}

#[test]
fn a_missing_config_file_is_reported_not_silently_defaulted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.toml");
    let warning = config_file_notice(Some(&path)).unwrap_err();
    assert!(warning.contains(&path.display().to_string()), "{warning}");
    assert!(warning.contains("GATEWAY_CONFIG"), "{warning}");
    assert!(config_file_notice(None)
        .unwrap_err()
        .contains("GATEWAY_CONFIG"));

    std::fs::write(&path, "").unwrap();
    let notice = config_file_notice(Some(&path)).unwrap();
    assert!(notice.contains(&path.display().to_string()), "{notice}");
}

#[test]
fn hosted_web_origin_is_only_trusted_by_a_ryu_paired_gateway() {
    // A plain self-hosted gateway does not admit the Ryu-hosted page.
    assert!(!hosted_web_origin_allowed(None, false, false));
    // Core-managed (trusted relay) and fleet gateways keep it.
    assert!(hosted_web_origin_allowed(None, true, false));
    assert!(hosted_web_origin_allowed(None, false, true));
    // An explicit operator choice wins either way.
    assert!(hosted_web_origin_allowed(Some(" On "), false, false));
    assert!(!hosted_web_origin_allowed(Some("0"), true, true));
    // Unrecognised values fall back to the pairing rule.
    assert!(!hosted_web_origin_allowed(Some("maybe"), false, false));
}

#[test]
fn cors_allowlist_adds_hosted_origin_and_extras_only_on_request() {
    let has = |origins: &[axum::http::HeaderValue], origin: &str| {
        origins.iter().any(|value| value == origin)
    };
    let standalone = cors_allowed_origins(false, None);
    assert!(has(&standalone, "tauri://localhost"));
    assert!(!has(&standalone, HOSTED_WEB_ORIGIN));

    let paired = cors_allowed_origins(true, Some(" https://a.example , ,https://b.example"));
    assert!(has(&paired, HOSTED_WEB_ORIGIN));
    assert!(has(&paired, "https://a.example"));
    assert!(has(&paired, "https://b.example"));
}

#[test]
fn fleet_mode_rejects_auth_disabled_even_on_loopback() {
    assert!(auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        true,
        false
    ));
    assert!(auth_disabled_startup_rejected("0.0.0.0:8981", false, false));
    assert!(!auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        false,
        false
    ));
    assert!(!auth_disabled_startup_rejected("0.0.0.0:8981", true, true));
}

#[test]
fn env_detected_fleet_custody_rejects_auth_disabled_on_loopback() {
    use crate::custody::{exposure_hardened, GatewayCustody};
    let vault_pair = GatewayCustody::from_lookup(|name| match name {
        "CONTROL_PLANE_URL" => Some("https://control.invalid".to_owned()),
        "RYU_VAULT_INTERNAL_SECRET" => Some("test-only".to_owned()),
        _ => None,
    });
    assert!(auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        exposure_hardened(false, vault_pair),
        false
    ));
    let vault_required = GatewayCustody::from_lookup(|name| {
        (name == "RYU_PROVIDER_VAULT_REQUIRED").then(|| "true".to_owned())
    });
    assert!(auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        exposure_hardened(false, vault_required),
        false
    ));
    let self_hosted = GatewayCustody::from_lookup(|_| None);
    assert!(!auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        exposure_hardened(false, self_hosted),
        false
    ));
}

/// The self-host compose stack sets `RYU_GATEWAY_FLEET=1` with no vault
/// signal: custody stays SelfHosted, yet the fleet flag alone still refuses
/// an auth-disabled start on a loopback listener.
#[test]
fn fleet_flag_without_vault_is_self_hosted_but_still_rejects_auth_disabled() {
    use crate::custody::{exposure_hardened, GatewayCustody};
    let custody =
        GatewayCustody::from_lookup(|name| (name == "RYU_GATEWAY_FLEET").then(|| "1".to_owned()));
    assert_eq!(custody, GatewayCustody::SelfHosted);
    assert!(auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        exposure_hardened(true, custody),
        false
    ));
    // Fleet flag on, auth on: starts.
    assert!(!auth_disabled_startup_rejected(
        "127.0.0.1:8981",
        exposure_hardened(true, custody),
        true
    ));
    // The hosted web origin follows custody, not the flag.
    assert!(!hosted_web_origin_allowed(None, false, custody.is_fleet()));
}
