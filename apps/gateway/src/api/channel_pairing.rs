//! Authenticated approval of channel pairing codes.
//!
//! An unknown direct-message sender is answered with a one-time pairing code
//! and nothing else (the default `pairing` DM policy). The pending code lives
//! only in the sealed per-node pairing store and is never written to the
//! Gateway log, so this admin route is the only way to admit that sender: the
//! operator relays the code the sender received, the Gateway approves it on the
//! same store every channel adapter reads, and the sender's next message is
//! answered. The response names the platform, never the sender id or number.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{api::phone_calls::authorize, error::GatewayError, state::SharedState};

/// Longest code the route accepts. Issued codes are short; a longer value is
/// never one, so it is refused before it reaches the store.
const MAX_CODE_LEN: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovePairingRequest {
    pub code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePairingResponse {
    pub approved: bool,
    /// The channel the approved sender messaged from (`telegram`, `whatsapp`, …).
    pub platform: String,
}

fn error_response(status: StatusCode, kind: &str, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message, "type": kind, "code": code } })),
    )
        .into_response()
}

/// `POST /v1/channels/pairing/approve`: approve the pending sender that holds
/// `code`. Admin only (master key, or the loopback exception
/// [`require_local_admin`](crate::api::config::require_local_admin) allows).
pub async fn approve(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<ApprovePairingRequest>,
) -> Result<Response, GatewayError> {
    authorize(&state, &peer, &headers, "Channel pairing approval").await?;
    let code = request.code.trim();
    if code.is_empty() || code.len() > MAX_CODE_LEN {
        return Err(GatewayError::BadRequest(
            "code must be the pairing code the sender received".to_owned(),
        ));
    }
    let Some(store) = state.channel_pairing.get() else {
        return Ok(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable_error",
            "pairing_store_unavailable",
            "Channels have not started on this Gateway, so there is no pairing store to approve in.",
        ));
    };
    let Some(entry_key) = store.approve_code(code).await else {
        return Ok(error_response(
            StatusCode::NOT_FOUND,
            "not_found_error",
            "pairing_code_not_found",
            "No pending sender holds that code. It may be wrong, expired, or already approved.",
        ));
    };
    let platform = entry_key
        .split_once(':')
        .map_or(entry_key.as_str(), |(platform, _)| platform)
        .to_owned();
    tracing::info!(platform = %platform, "channel pairing code approved");
    Ok(Json(ApprovePairingResponse {
        approved: true,
        platform,
    })
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audit::AuditLogger,
        config::{AuditConfig, AuthConfig, EvalsConfig, GatewayConfig},
        evals::EvalsRunner,
        state::AppState,
    };
    use ryu_gw_channels::pairing::{Decision, PairingStore};
    use std::sync::Arc;

    fn state() -> SharedState {
        let config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_owned()),
                api_keys: vec![],
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ))
    }

    fn admin_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer sk-master".parse().unwrap());
        headers
    }

    fn peer() -> ConnectInfo<SocketAddr> {
        ConnectInfo("127.0.0.1:5".parse().unwrap())
    }

    async fn call(
        state: &SharedState,
        headers: HeaderMap,
        code: &str,
    ) -> Result<Response, GatewayError> {
        approve(
            State(Arc::clone(state)),
            peer(),
            headers,
            Json(ApprovePairingRequest {
                code: code.to_owned(),
            }),
        )
        .await
    }

    async fn body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn an_issued_code_is_approved_and_admits_the_sender() {
        let state = state();
        let store = PairingStore::ephemeral();
        assert!(state.channel_pairing.set(store.clone()).is_ok());
        let Decision::Challenge(code) = store.challenge("telegram", "424242").await else {
            panic!("an unknown sender must be challenged");
        };

        // The code is accepted in the case and spacing the sender may have typed.
        let response = call(
            &state,
            admin_headers(),
            &format!(" {} ", code.to_lowercase()),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body(response).await;
        assert_eq!(json["approved"], true);
        assert_eq!(json["platform"], "telegram");
        assert!(
            !json.to_string().contains("424242"),
            "the sender id must not leave the Gateway"
        );

        assert_eq!(
            store.challenge("telegram", "424242").await,
            Decision::Allow,
            "the approved sender is admitted"
        );

        // A code is single use.
        let again = call(&state, admin_headers(), &code).await.unwrap();
        assert_eq!(again.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_unknown_code_is_a_404_and_a_bad_code_is_a_400() {
        let state = state();
        assert!(state.channel_pairing.set(PairingStore::ephemeral()).is_ok());
        let unknown = call(&state, admin_headers(), "ZZZZZZ").await.unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(unknown).await["error"]["code"],
            "pairing_code_not_found"
        );
        let too_long = "A".repeat(MAX_CODE_LEN + 1);
        for bad in ["", "   ", too_long.as_str()] {
            let err = call(&state, admin_headers(), bad).await.unwrap_err();
            assert!(matches!(err, GatewayError::BadRequest(_)), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn approval_needs_admin_auth_and_a_started_store() {
        let state = state();
        // No credentials: refused before the store is consulted.
        let err = call(&state, HeaderMap::new(), "ABC234").await.unwrap_err();
        assert!(matches!(err, GatewayError::Unauthorized(_)));
        // Admin, but channels never started: a 503, not a silent no-op.
        let response = call(&state, admin_headers(), "ABC234").await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
