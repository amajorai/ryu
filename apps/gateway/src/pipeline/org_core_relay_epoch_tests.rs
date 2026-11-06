//! A per-org Core relay key is refused once the org's node-root epoch moves
//! past the epoch it was derived at, so a removed admin who copied it from a
//! node loses trusted-forwarder authority for the org.

use super::super::epoch::relay_epoch_admits;
use super::*;
use crate::pipeline::core_proof::{BoxBudgetSource, BOX_BUDGET_SOURCE_OVERRIDE};

/// A fake control plane answering the org budget route with `status` and
/// `body`.
async fn fake_plane(status: u16, body: String) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 {status} Canned\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}/api")
}

struct PlaneOverride;

impl PlaneOverride {
    fn set(url: &str) -> Self {
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| {
            *cell.borrow_mut() = Some(BoxBudgetSource {
                url: url.to_owned(),
                header: "x-ryu-internal-secret",
                secret: "fleet-credits-secret".to_owned(),
            });
        });
        Self
    }
}

impl Drop for PlaneOverride {
    fn drop(&mut self) {
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| *cell.borrow_mut() = None);
    }
}

/// The relay key at `epoch`, derived independently of the credentials crate
/// from the documented scheme (epoch 0 is the original v1 key).
fn org_key_at(org: &str, epoch: u64) -> String {
    use hmac::Mac;
    if epoch == 0 {
        return ryu_gw_credentials::derive_org_core_relay_key(MASTER, org).unwrap();
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(MASTER.as_bytes()).unwrap();
    mac.update(format!("ryu-core-relay-org-v2\0{org}\0{epoch}").as_bytes());
    let digest = hex::encode(mac.finalize().into_bytes());
    format!(
        "{}{digest}_{org}.{epoch}",
        ryu_gw_credentials::ORG_CORE_RELAY_PREFIX
    )
}

fn unique_org(label: &str) -> String {
    format!("org-{label}-{}", uuid::Uuid::new_v4().simple())
}

async fn plane_at_epoch(epoch: u64) -> PlaneOverride {
    let body = format!(r#"{{"managedInference":true,"boxProofKeyEpoch":{epoch}}}"#);
    PlaneOverride::set(&fake_plane(200, body).await)
}

#[test]
fn only_the_current_epoch_is_admitted() {
    assert!(relay_epoch_admits(1, Some(1)));
    assert!(!relay_epoch_admits(0, Some(1)));
    assert!(!relay_epoch_admits(2, Some(1)));
    // No control plane: nothing can have been retired, so only epoch 0.
    assert!(relay_epoch_admits(0, None));
    assert!(!relay_epoch_admits(1, None));
}

#[tokio::test]
async fn a_relay_key_at_a_retired_epoch_is_refused_on_every_route() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let _plane = plane_at_epoch(1).await;
    let org = unique_org("retired");
    let retired = org_key_at(&org, 0);

    // The copied epoch-0 key no longer authenticates, whoever it names.
    let refused = authenticate(
        &state,
        AuthInputs {
            raw_api_key: Some(&retired),
            user_id: Some("member-a".to_owned()),
            ..Default::default()
        },
    )
    .await;
    assert!(matches!(refused, Err(GatewayError::Unauthorized(_))));

    // Nor can it debit the org wallet.
    let charge: crate::api::budget::ToolChargeBody = serde_json::from_value(serde_json::json!({
        "tool_calls": 1,
        "org_id": org,
        "provider": "composio",
        "cost_micro_usd": 1_000_000,
    }))
    .unwrap();
    assert!(matches!(
        crate::api::budget::charge_tool(State(Arc::clone(&state)), bearer(&retired), Json(charge))
            .await,
        Err(GatewayError::Unauthorized(_))
    ));

    // A node provisioned at the new epoch keeps working.
    let ctx = authenticate(&state, AuthInputs::with_key(Some(&org_key_at(&org, 1))))
        .await
        .unwrap();
    assert_eq!(bound_forwarder_org(&ctx), Some(org.as_str()));
}

#[tokio::test]
async fn a_relay_key_ahead_of_the_org_epoch_is_refused() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let _plane = plane_at_epoch(0).await;
    let org = unique_org("current");
    assert!(
        authenticate(&state, AuthInputs::with_key(Some(&org_key_at(&org, 0))))
            .await
            .is_ok()
    );
    assert!(matches!(
        authenticate(&state, AuthInputs::with_key(Some(&org_key_at(&org, 1)))).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn an_unreachable_or_unknown_plane_fails_closed() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let key = org_key_at(&unique_org("down"), 0);
    {
        let _plane = PlaneOverride::set(&fake_plane(500, String::new()).await);
        assert!(matches!(
            authenticate(&state, AuthInputs::with_key(Some(&key))).await,
            Err(GatewayError::StandingUnavailable)
        ));
    }
    let _plane = PlaneOverride::set(&fake_plane(404, String::new()).await);
    let key = org_key_at(&unique_org("unknown"), 0);
    assert!(matches!(
        authenticate(&state, AuthInputs::with_key(Some(&key))).await,
        Err(GatewayError::Unauthorized(_))
    ));
}
