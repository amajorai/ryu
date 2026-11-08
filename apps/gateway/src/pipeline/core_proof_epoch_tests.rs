//! The per-org Core proof key is accepted only at the org's current node-root
//! epoch, so a removed admin who copied it from a node loses Core's
//! trusted-forwarder role and agent route proofs for the org.

use super::*;
use crate::pipeline::core_proof::{
    resolved_dynamic_agent_id, BoxBudgetSource, BOX_BUDGET_SOURCE_OVERRIDE,
};

const MASTER: &str = "gwproof_master_epoch_tests_0123456789";
const BEARER: &str = "rgw_epoch-test-bearer";

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
    async fn answering(status: u16, body: String) -> Self {
        let url = fake_plane(status, body).await;
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| {
            *cell.borrow_mut() = Some(BoxBudgetSource {
                url,
                header: "x-ryu-internal-secret",
                secret: "fleet-credits-secret".to_owned(),
            });
        });
        Self
    }

    async fn at_epoch(epoch: u64) -> Self {
        Self::answering(
            200,
            format!(r#"{{"managedInference":true,"boxProofKeyEpoch":{epoch}}}"#),
        )
        .await
    }
}

impl Drop for PlaneOverride {
    fn drop(&mut self) {
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| *cell.borrow_mut() = None);
    }
}

fn master_env() -> CoreProofEnv {
    CoreProofEnv {
        master: Some(MASTER.to_owned()),
        ..CoreProofEnv::default()
    }
}

fn unique_org(label: &str) -> String {
    format!("org-{label}-{}", uuid::Uuid::new_v4().simple())
}

fn headers_with(key: &str) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-ryu-core-key", key.parse().unwrap());
    headers
}

async fn proves(env: &CoreProofEnv, key: &str, org: &str) -> Result<bool, GatewayError> {
    has_core_proof_key_with(
        &reqwest::Client::new(),
        &CreditsConfig::default(),
        env,
        &headers_with(key),
        Some(org),
    )
    .await
}

#[test]
fn epoch_zero_keeps_the_v1_key_and_later_epochs_are_independent() {
    let env = master_env();
    let v1 = ryu_gw_credentials::derive_org_core_proof_key(MASTER, "org_123").unwrap();
    assert_eq!(
        core_proof_keys_at_epoch(&env, Some("org_123"), 0),
        [v1.clone()]
    );
    let at_one = core_proof_keys_at_epoch(&env, Some("org_123"), 1);
    assert_eq!(at_one.len(), 1);
    assert_ne!(at_one[0], v1);
    // Same vector the control plane hands nodes (`deriveOrgBoxProofKey`).
    let vector_master = "gwproof_master_cross_language_vector";
    let vector = CoreProofEnv {
        master: Some(vector_master.to_owned()),
        ..CoreProofEnv::default()
    };
    assert_eq!(
        core_proof_keys_at_epoch(&vector, Some("org_123"), 1),
        ["gwproof_box_11ccd7bbedfd757b2188d73c9110423683ddc295e7d4d8138c93831d3e899757"]
    );
}

#[test]
fn the_shared_direct_key_is_retired_past_epoch_zero_on_a_multi_org_fleet() {
    let fleet = CoreProofEnv {
        direct: Some("gwproof_shared".to_owned()),
        ..CoreProofEnv::default()
    };
    assert_eq!(
        core_proof_keys_at_epoch(&fleet, Some("org-a"), 0),
        ["gwproof_shared"]
    );
    assert!(core_proof_keys_at_epoch(&fleet, Some("org-a"), 1).is_empty());
    // A single-org Gateway's own key is not shared with other orgs' nodes.
    let single = CoreProofEnv {
        direct_org: Some("org-a".to_owned()),
        ..fleet
    };
    assert_eq!(
        core_proof_keys_at_epoch(&single, Some("org-a"), 1),
        ["gwproof_shared"]
    );
    assert!(core_proof_keys_at_epoch(&single, Some("org-b"), 1).is_empty());
}

#[tokio::test]
async fn a_retired_epoch_proof_key_no_longer_proves_core() {
    let _plane = PlaneOverride::at_epoch(1).await;
    let org = unique_org("retired");
    let retired = ryu_gw_credentials::derive_org_core_proof_key(MASTER, &org).unwrap();
    let current = ryu_gw_credentials::derive_org_box_proof_key(MASTER, &org, 1).unwrap();
    assert!(!proves(&master_env(), &retired, &org).await.unwrap());
    assert!(proves(&master_env(), &current, &org).await.unwrap());
}

#[tokio::test]
async fn an_unreadable_epoch_fails_closed() {
    let key_for = |org: &str| ryu_gw_credentials::derive_org_core_proof_key(MASTER, org).unwrap();
    {
        let _plane = PlaneOverride::answering(500, "{}".to_owned()).await;
        let org = unique_org("outage");
        assert!(matches!(
            proves(&master_env(), &key_for(&org), &org).await,
            Err(GatewayError::StandingUnavailable)
        ));
    }
    let _plane = PlaneOverride::answering(404, "{}".to_owned()).await;
    let org = unique_org("unknown");
    assert!(!proves(&master_env(), &key_for(&org), &org).await.unwrap());
}

#[tokio::test]
async fn agent_route_proofs_verify_only_under_the_current_epoch_key() {
    let _plane = PlaneOverride::at_epoch(1).await;
    let org = unique_org("agent");
    let keys = current_core_proof_keys(
        &reqwest::Client::new(),
        &CreditsConfig::default(),
        &master_env(),
        Some(&org),
    )
    .await
    .unwrap();
    let bearer = format!("Bearer {BEARER}");
    let sign =
        |key: &str| ryu_gw_credentials::sign_agent_route_proof(key, BEARER, "victim").unwrap();
    let retired = sign(&ryu_gw_credentials::derive_org_core_proof_key(MASTER, &org).unwrap());
    assert!(matches!(
        resolved_dynamic_agent_id(Some(&bearer), Some("victim"), Some(&retired), &keys),
        Err(GatewayError::Unauthorized(_))
    ));
    let current = sign(&ryu_gw_credentials::derive_org_box_proof_key(MASTER, &org, 1).unwrap());
    assert_eq!(
        resolved_dynamic_agent_id(Some(&bearer), Some("victim"), Some(&current), &keys).unwrap(),
        Some("victim".to_owned())
    );
}
