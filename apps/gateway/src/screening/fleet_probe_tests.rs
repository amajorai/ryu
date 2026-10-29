//! Coverage probes for the hosted fleet screener deploy (screener addendum
//! 13.1 G7 and G8, decision-model primary, no GPU). Every probe builds its
//! screener from the committed `apps/gateway/fleet/screening.toml` through
//! `ScreeningRuntime::from_config`, the way the fleet gateway does at boot,
//! with the environment the fleet compose sets read through a lookup closure
//! (never the process environment). The decision model is the mock systemone
//! server; qualification records name the fleet model and digest.
//!
//! The probes also hold the fleet compose, the screener image and the public
//! docs to what the code does: the error rows, the media refusal and the
//! remote-processor rules.
//!
//! Content is the spec 00.9 sentinels only.

use axum::response::IntoResponse;

use super::*;

const FLEET_TABLE: &str = include_str!("../../fleet/screening.toml");
const FLEET_COMPOSE: &str = include_str!("../../docker-compose.fleet.yml");
const SCREENER_DOCKERFILE: &str = include_str!("../../screener.Dockerfile");
const ERRORS_PAGE: &str =
    include_str!("../../../fumadocs/content/docs/gateway/managed-data-plane.mdx");
const POLICY_PAGE: &str =
    include_str!("../../../fumadocs/content/docs/gateway/organization-policy.mdx");
const TRANSPARENCY_PAGE: &str =
    include_str!("../../../fumadocs/content/docs/surfaces/desktop/transparency.mdx");
// The hosted-Gateway media claim moved here from the transparency page.
const DATA_DESTINATIONS_PAGE: &str =
    include_str!("../../../fumadocs/content/docs/surfaces/desktop/data-destinations.mdx");
const DECISION_PAGE: &str = include_str!("../../../fumadocs/content/docs/core/decision-models.mdx");
const CLASSIFIER_PAGE: &str =
    include_str!("../../../fumadocs/content/docs/core/classifier-tier.mdx");

/// A tagged name, as the screener image build requires.
const FLEET_MODEL: &str = "fleet-screener:1";
const FLEET_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_SHA: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const PNG: &str = "iVBORw0KGgo=";

// ── fleet harness ───────────────────────────────────────────────────────────

fn fleet_table() -> crate::config::ScreeningConfig {
    let config: GatewayConfig =
        toml::from_str(FLEET_TABLE).expect("the fleet table is a valid gateway.toml");
    config.screening
}

/// The variables the fleet compose sets on the gateway, with `url` as the
/// screener endpoint and `sha` as the pinned digest.
fn fleet_lookup(url: &str, sha: &str) -> impl Fn(&str) -> Option<String> {
    let (url, sha) = (url.to_owned(), sha.to_owned());
    move |key| match key {
        "RYU_SCREENER_DECISION_URL" => Some(url.clone()),
        "RYU_SCREENER_DECISION_MODEL" => Some(FLEET_MODEL.to_owned()),
        "RYU_SCREENER_DECISION_SHA256" => Some(sha.clone()),
        _ => None,
    }
}

fn fleet_runtime_with(
    url: &str,
    sha: &str,
    config: &crate::config::ScreeningConfig,
) -> ScreeningRuntime {
    let runtime = ScreeningRuntime::from_config(config, &fleet_lookup(url, sha));
    assert!(
        runtime.build_errors().is_empty(),
        "the fleet table did not build: {:?}",
        runtime.build_errors()
    );
    runtime
}

fn fleet_runtime(url: &str) -> ScreeningRuntime {
    fleet_runtime_with(url, FLEET_SHA, &fleet_table())
}

/// The floor `screener` naming `decision_local` in every text role, with a
/// qualification for `model` and `sha` when given.
fn fleet_screener(qualification: Option<(&str, &str)>, extra: Value) -> Value {
    let mut screener = json!({
        "templateVersion": 1,
        "roles": {
            "textHazard": ["decision_local"],
            "promptAttack": ["decision_local"],
            "output": ["decision_local"],
        },
    });
    if let Some((model, sha)) = qualification {
        screener["qualifications"] = json!([{
            "backendId": "decision_local",
            "model": model,
            "weightsSha256": sha,
            "templateVersion": 1,
            "codes": ["hazard.S4", "hazard.S9"],
            "evalRef": "eval_fleet_sentinels",
        }]);
    }
    if let (Some(target), Some(extra)) = (screener.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    screener
}

fn fleet_qualified_floor(version: u64) -> Arc<PlatformFloor> {
    floor(
        version,
        Some(fleet_screener(Some((FLEET_MODEL, FLEET_SHA)), json!({}))),
    )
}

/// Today's shipped floor: roles, no qualification record.
fn fleet_unqualified_floor(version: u64) -> Arc<PlatformFloor> {
    floor(version, Some(fleet_screener(None, json!({}))))
}

fn fleet_gateway(url: &str, floor: Arc<PlatformFloor>, reply: &str) -> Gateway {
    gateway(
        GatewayCustody::Fleet,
        fleet_runtime(url),
        Some(floor),
        reply,
    )
}

/// A loopback URL nothing listens on: the screener container is down.
async fn dead_screener_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a port to free");
    let port = listener.local_addr().expect("address").port();
    drop(listener);
    format!("http://127.0.0.1:{port}/v1/systemone")
}

async fn status_report(g: &Gateway) -> Value {
    let (status, _, raw) = send(&g.app, Method::GET, "/v1/screening/status", None).await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    serde_json::from_str(&raw).expect("status is JSON")
}

async fn health(g: &Gateway) -> Vec<(String, StatusCode)> {
    let mut out = Vec::new();
    for uri in ["/health", "/v1/health"] {
        let (status, _, _) = send(&g.app, Method::GET, uri, None).await;
        out.push((uri.to_owned(), status));
    }
    out
}

/// Whether a response is a screening refusal of any kind.
fn screening_refusal(status: StatusCode, raw: &str) -> bool {
    raw.contains("screening_")
        || raw.contains("platform_floor_")
        || raw.contains("media_unscreenable")
}

fn image_chat() -> Value {
    json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
        { "type": "text", "text": "describe" },
        { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{PNG}") } }
    ] }] })
}

/// The body `audio_wire::transcription_body` builds from a multipart upload.
fn transcription_wire(prompt: &str) -> Value {
    json!({ "model": "fixture-model", "filename": "a.wav", "file": "UklGRg==", "prompt": prompt })
}

async fn json_of(error: GatewayError) -> (StatusCode, HeaderMap, Value) {
    let response = error.into_response();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("error body reads");
    (
        status,
        headers,
        serde_json::from_slice(&bytes).expect("error body is JSON"),
    )
}

// The table-on-the-wire and backend/shipped-state probes live in sibling
// files so each stays under the repository's file size limit.
#[path = "fleet_table_probe_tests.rs"]
mod table;

#[path = "fleet_state_probe_tests.rs"]
mod state;

// ── compose, image and docs against the code ────────────────────────────────

/// One variable feeds the image build and the gateway's pin, the URL's port
/// is the port the image serves, and the base image has no default.
#[test]
fn probe_fleet_compose_and_image_pin_the_same_build() {
    let screener = FLEET_COMPOSE
        .split("\n  screener:\n")
        .nth(1)
        .expect("a screener service");
    assert!(screener.contains("SCREENER_MODEL: ${RYU_SCREENER_DECISION_MODEL"));
    assert!(screener.contains("SCREENER_MODEL_SHA256: ${RYU_SCREENER_DECISION_SHA256"));
    let gateway = FLEET_COMPOSE
        .split("\n  gateway:\n")
        .nth(1)
        .and_then(|rest| rest.split("\n  screener:\n").next())
        .expect("a gateway service");
    assert!(gateway.contains("RYU_SCREENER_DECISION_MODEL: ${RYU_SCREENER_DECISION_MODEL"));
    assert!(gateway.contains("RYU_SCREENER_DECISION_SHA256: ${RYU_SCREENER_DECISION_SHA256"));

    let url = gateway
        .lines()
        .find_map(|line| line.trim().strip_prefix("RYU_SCREENER_DECISION_URL: "))
        .expect("the gateway's screener URL");
    let port = reqwest::Url::parse(url)
        .expect("a URL")
        .port()
        .expect("an explicit port");
    assert!(
        SCREENER_DOCKERFILE.contains(&format!("OLLAYA_HOST=0.0.0.0:{port}")),
        "the image does not serve on {port}"
    );
    assert!(SCREENER_DOCKERFILE.contains(&format!("EXPOSE {port}")));
    assert!(SCREENER_DOCKERFILE
        .lines()
        .any(|line| line.trim() == "ARG OLLAYA_IMAGE"));
    assert!(SCREENER_DOCKERFILE.contains("FROM ${OLLAYA_IMAGE}"));
    // The digest check the image enforces accepts what the gateway pins.
    assert!(
        FLEET_SHA.len() == 64
            && FLEET_SHA
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
}

/// Each fleet screener refusal is a row on the public errors page with the
/// status and `type` the gateway serializes.
#[tokio::test]
async fn probe_fleet_errors_page_matches_the_wire() {
    let rows: Vec<(&str, GatewayError)> = vec![
        (
            "screening_unavailable",
            GatewayError::ScreeningUnavailable {
                reason: "probe",
                retry_after_secs: 2,
            },
        ),
        (
            "screening_capacity_exceeded",
            GatewayError::ScreeningCapacityExceeded,
        ),
        (
            "screening_degraded_throttle",
            GatewayError::ScreeningDegradedThrottle {
                retry_after_secs: 2,
            },
        ),
        (
            "media_unscreenable",
            GatewayError::PlatformRefused {
                code: "media_unscreenable",
                message: "probe",
            },
        ),
    ];
    let mut misses = Vec::new();
    for (code, error) in rows {
        let (status, headers, body) = json_of(error).await;
        assert_eq!(body["error"]["code"], code);
        let kind = body["error"]["type"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let row = ERRORS_PAGE
            .lines()
            .find(|line| line.starts_with('|') && line.contains(&format!("`code: \"{code}\"`")))
            .unwrap_or_default();
        if row.is_empty() {
            misses.push(format!("{code}: no row"));
            continue;
        }
        if !row.contains(&format!("`{}`", status.as_u16())) {
            misses.push(format!("{code}: row does not say {}", status.as_u16()));
        }
        if row.contains("type: \"") && !row.contains(&format!("type: \"{kind}\"")) {
            misses.push(format!("{code}: row type differs from {kind}"));
        }
        if headers.get("retry-after").is_some() != row.contains("Retry-After") {
            misses.push(format!("{code}: Retry-After mismatch"));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// The public pages this deploy changed name no internal port, env name,
/// status route or internal doc.
#[test]
fn probe_fleet_public_pages_carry_no_internal_details() {
    let mut misses = Vec::new();
    for (page, text) in [
        ("managed-data-plane", ERRORS_PAGE),
        ("organization-policy", POLICY_PAGE),
        ("transparency", TRANSPARENCY_PAGE),
        ("data-destinations", DATA_DESTINATIONS_PAGE),
        ("decision-models", DECISION_PAGE),
        ("classifier-tier", CLASSIFIER_PAGE),
    ] {
        for needle in [
            "screener:11435",
            "RYU_SCREENER_",
            "/v1/screening/status",
            "docs/deploy-gateway-fleet",
            "docker-compose.fleet",
            "screener.Dockerfile",
            "GATEWAY_CONFIG",
        ] {
            if text.contains(needle) {
                misses.push(format!("{page}: {needle}"));
            }
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// G8 media claim. The errors page, the content-screening section and the
/// data-destinations page say every audio input is refused on the hosted Gateway
/// rather than sent to a provider unchecked. Probed in the target state, with
/// the committed table's decision model qualified, on the transcription
/// route's own wire body.
#[tokio::test]
async fn probe_fleet_qualified_transcription_audio_is_refused_as_documented() {
    for (page, claim) in [
        (
            "managed-data-plane",
            ERRORS_PAGE.contains("so today this is every such input"),
        ),
        (
            "data-destinations",
            DATA_DESTINATIONS_PAGE.contains("refuses image, audio and other media inputs"),
        ),
        (
            "organization-policy",
            POLICY_PAGE.contains("every image, audio or other media input is refused"),
        ),
    ] {
        assert!(
            claim,
            "{page} no longer makes the audio claim; update this probe"
        );
    }
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    let result = screen_value(
        &g.state,
        &plain_ctx(),
        &transcription_wire("meeting notes"),
        Surface::Transcription,
    )
    .await;
    let code = result.as_ref().err().map(|e| e.wire_status_and_code().1);
    assert_eq!(
        code,
        Some("media_unscreenable"),
        "with a qualified screener the transcription audio is forwarded to the provider \
         unclassified (spec D17), while the public pages say every audio input is refused"
    );
}
