use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::SharedState;

pub async fn health(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    let mut body = json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    });
    if let Some(raw_key) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    {
        if crate::pipeline::authenticate(
            &state,
            crate::pipeline::AuthInputs::with_key(Some(raw_key)),
        )
        .await
        .ok()
        .is_some_and(|ctx| ctx.is_master_key)
        {
            let runtime = state.provider_runtime.snapshot();
            body["providers"] = json!(runtime.providers.available_providers());
            body["auth_required"] = json!(state.with_auth(|auth| auth.require_auth));
            // Hash of the control-plane policy + limits last applied (null when
            // unbound or on a control plane that predates the field).
            body["policy_version"] = json!(state.policy_version());
            // `ok`, or why the durable spend counters refuse metered requests
            // (`budget store key mismatch` / `budget store key unavailable`).
            body["budget_store"] = json!(state
                .spend_store
                .health()
                .err()
                .unwrap_or_else(|| "ok".to_owned()));
            // How spend subject ids reach disk: `sealed`, `no key` (a
            // never-sealed spend.db counted by raw id because no Gateway
            // sealing key is held) or `memory`.
            body["budget_store_sealing"] = json!(state.spend_store.sealing());
            // Where this Gateway runs: `fleet`, `managed_node` or `self_hosted`.
            body["custody"] = json!(state.custody);
        }
    }
    Json(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[tokio::test]
    async fn health_reports_ok_version_and_auth_flag() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = health(State(state), axum::http::HeaderMap::new()).await;
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        // Default test config requires auth and registers no providers.
        assert!(body.get("auth_required").is_none());
        assert!(body.get("providers").is_none());
        assert!(body.get("custody").is_none());
    }

    #[tokio::test]
    async fn health_reports_custody_to_the_master_key_only() {
        let mut config = crate::config::GatewayConfig::default();
        config.auth.master_key = Some("master-secret".to_owned());
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let mut state = AppState::new_for_test(
            config,
            audit,
            crate::evals::EvalsRunner::new(Default::default()),
        );
        state.custody = crate::custody::GatewayCustody::Fleet;
        let state = Arc::new(state);
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer master-secret".parse().unwrap());
        let Json(body) = health(State(Arc::clone(&state)), headers).await;
        assert_eq!(body["custody"], "fleet");
        let Json(anonymous) = health(State(state), axum::http::HeaderMap::new()).await;
        assert!(anonymous.get("custody").is_none());
    }
}

/// Credential check without invoking providers or disclosing configuration.
pub async fn auth_status(
    axum::extract::State(state): axum::extract::State<crate::state::SharedState>,
    headers: axum::http::HeaderMap,
) -> Result<axum::Json<serde_json::Value>, crate::error::GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let context =
        crate::pipeline::authenticate(&state, crate::pipeline::AuthInputs::with_key(raw_key))
            .await?;
    Ok(axum::Json(serde_json::json!({
        "authenticated": state.config.auth.require_auth,
        "admin": context.is_master_key,
        "trustedForwarder": context.key_config.is_some_and(|key| key.trusted_forwarder),
    })))
}

#[cfg(test)]
mod credential_role_tests {
    use super::*;
    use crate::{
        config::{ApiKeyConfig, GatewayConfig},
        state::AppState,
    };
    use std::sync::Arc;

    #[tokio::test]
    async fn default_gateway_rejects_anonymous_and_preserves_separate_roles() {
        let directory =
            std::env::temp_dir().join(format!("gateway-auth-status-{}", uuid::Uuid::new_v4()));
        let mut config = GatewayConfig::default();
        config.auth.bootstrap(&directory).unwrap();
        let admin = config.auth.master_key.clone().unwrap();
        let relay = config.auth.api_keys[0].key.clone();
        let mut core: ApiKeyConfig = config.auth.api_keys[0].clone();
        core.name = "local-core".to_owned();
        core.key = "gwcore_0123456789abcdef0123456789abcdef".to_owned();
        core.trusted_forwarder = true;
        let core_key = core.key.clone();
        config.auth.api_keys.push(core);
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ));
        assert!(
            auth_status(State(Arc::clone(&state)), axum::http::HeaderMap::new())
                .await
                .is_err()
        );
        for (key, admin_expected, trusted_expected) in [
            (&admin, true, false),
            (&relay, false, false),
            (&core_key, false, true),
        ] {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
            let Json(role) = auth_status(State(Arc::clone(&state)), headers)
                .await
                .unwrap();
            assert_eq!(role["authenticated"], true);
            assert_eq!(role["admin"], admin_expected);
            assert_eq!(role["trustedForwarder"], trusted_expected);
        }
        // Settings updates cannot delete a host credential or elevate the exported relay.
        let mut forged = state.config.auth.api_keys[0].clone();
        forged.trusted_forwarder = true;
        state.update_auth_config(vec![forged]);
        assert!(state.with_auth(|auth| auth
            .api_keys
            .iter()
            .any(|key| key.key == relay && !key.trusted_forwarder)));
        assert!(state.with_auth(|auth| auth
            .api_keys
            .iter()
            .any(|key| key.key == core_key && key.trusted_forwarder)));
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[derive(serde::Deserialize)]
pub struct ReadinessQuery {
    nonce: String,
}

pub async fn readiness(
    State(state): State<SharedState>,
    axum::Extension(listener): axum::Extension<std::net::SocketAddr>,
    axum::extract::Query(query): axum::extract::Query<ReadinessQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ryu_gw_credentials::ReadinessProof>, crate::error::GatewayError> {
    if query.nonce.len() != 64 || !query.nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(crate::error::GatewayError::Unauthorized(
            "invalid readiness nonce".to_owned(),
        ));
    }
    state.with_auth(|auth| {
        let admin = auth.master_key.as_deref().ok_or_else(|| {
            crate::error::GatewayError::Unauthorized(
                "Gateway has no readiness credential".to_owned(),
            )
        })?;
        let signature = headers
            .get("x-ryu-readiness-proof")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        ryu_gw_credentials::verify_readiness_request(&query.nonce, signature, admin).map_err(
            |_| {
                crate::error::GatewayError::Unauthorized(
                    "invalid readiness request proof".to_owned(),
                )
            },
        )?;
        let mut inference_keys = Vec::new();
        let mut core_keys = Vec::new();
        for key in &auth.api_keys {
            let keys = if key.trusted_forwarder {
                &mut core_keys
            } else {
                &mut inference_keys
            };
            keys.push(ryu_gw_credentials::fingerprint(&key.key));
        }
        inference_keys.sort();
        core_keys.sort();
        let readiness = ryu_gw_credentials::Readiness {
            protocol: "ryu-gateway-readiness-v1".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            nonce: query.nonce,
            listener,
            require_auth: auth.require_auth,
            inference_keys,
            core_keys,
        };
        ryu_gw_credentials::ReadinessProof::sign(readiness, admin)
            .map(Json)
            .map_err(|_| {
                crate::error::GatewayError::Unauthorized(
                    "Gateway readiness signing failed".to_owned(),
                )
            })
    })
}
