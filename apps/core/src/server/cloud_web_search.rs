//! `POST /api/cloud/web-search` — the loopback bridge behind the built-in
//! `@ryu/cloud-search` provider of the swappable `web.search` layer.
//!
//! The hosted Gateway serves `/v1/web/search` from search accounts Ryu owns and
//! bills each successful search to the organization's credit balance. Reaching
//! it needs the node's Gateway relay credential, which never leaves Core: the
//! declarative tool calls this route with the node token, and this route alone
//! attaches the relay credential on the way out to the configured Gateway.
//!
//! Every outcome is a `200`. A node that is not connected to Ryu Cloud, or a
//! Gateway refusal (search turned off for the organization, credit exhausted, a
//! credential without web-search authority), returns `{available:false, …}` so
//! the agent's turn continues with a readable reason instead of a tool error.
//!
//! The provider ships pre-installed but spends organization credits, so this
//! route serves only while the user has explicitly selected Ryu Cloud Search for
//! `web.search`. An auto-pick (for example, after the default provider is
//! disabled) or a direct call while another provider is selected is refused
//! before any request leaves the node.

use std::time::Duration;

use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

/// The Gateway accepts 1–10 results per search.
const MAX_LIMIT: u16 = 10;
const DEFAULT_LIMIT: u16 = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
pub(super) struct CloudWebSearchBody {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<u16>,
}

/// The hosted Gateway endpoint and the relay credential to present there.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CloudSearchTarget {
    base_url: String,
    token: String,
}

/// Pick the hosted Gateway for this node. A remote-data-plane node (managed Ryu
/// Cloud node, or `RYU_GATEWAY_REMOTE`) already talks to the fleet through its
/// configured Gateway; a local node reaches it through its managed-fleet
/// coordinates. Anything else has no hosted search to offer.
fn select_target(
    remote_data_plane: bool,
    remote: impl FnOnce() -> Option<(String, String)>,
    managed_fleet: impl FnOnce() -> Option<(String, String)>,
) -> Option<CloudSearchTarget> {
    let (base_url, token) = if remote_data_plane {
        remote()?
    } else {
        managed_fleet()?
    };
    let base_url = base_url.trim().trim_end_matches('/').to_owned();
    let token = token.trim().to_owned();
    if base_url.is_empty() || token.is_empty() {
        return None;
    }
    Some(CloudSearchTarget { base_url, token })
}

fn current_target() -> Option<CloudSearchTarget> {
    use crate::sidecar::gateway;
    select_target(
        gateway::remote_data_plane(),
        || gateway::gateway_relay_token().map(|token| (gateway::gateway_url(), token)),
        gateway::managed_fleet,
    )
}

fn unavailable(reason: impl Into<String>, hint: &str) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": hint,
    })
}

fn not_selected() -> Value {
    unavailable(
        "Ryu Cloud Search is not the selected web search provider.",
        "Pick Ryu Cloud Search in Toolkits → Search to use hosted search billed to your organization's credits, or keep your current provider.",
    )
}

/// Whether the user explicitly picked Ryu Cloud Search for `web.search`.
fn selected(config: &crate::plugins::binding::BindingConfig) -> bool {
    use crate::sidecar::mcp::web_search_access::{cloud_search_provider_id, explicitly_selected};
    explicitly_selected(config, "web.search", cloud_search_provider_id())
}

fn not_connected() -> Value {
    unavailable(
        "This node is not connected to Ryu Cloud.",
        "Sign in to Ryu Cloud with managed inference, or pick another web search provider.",
    )
}

/// The Gateway's error message, or a generic one. Gateway errors are
/// `{error:{message, code}}`; the message is already safe to show.
fn gateway_message(body: &Value) -> Option<&str> {
    body.pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
}

fn hint_for_status(status: u16) -> &'static str {
    match status {
        401 => "This node's Ryu Cloud credential does not include hosted web search. An organization admin can issue a new node key in Ryu Cloud, or pick another web search provider.",
        402 => "Add credits to the organization, or pick another web search provider.",
        403 => "An organization admin can turn on Hosted web search under Organization → Features.",
        429 => "Retry after a moment.",
        _ => "Retry later, or pick another web search provider.",
    }
}

/// Map a Gateway response onto the tool result. Success passes the Gateway
/// payload through (`{results:[{title,url,snippet,score}], …}`), which the
/// provider's declarative response map turns into canonical `web.search` rows.
fn gateway_result(status: u16, body: Value) -> Value {
    if (200..300).contains(&status) {
        if body.get("results").is_some_and(Value::is_array) {
            return body;
        }
        return unavailable(
            "Ryu Cloud returned an unexpected search response.",
            hint_for_status(status),
        );
    }
    let reason = gateway_message(&body)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Ryu Cloud web search failed with HTTP {status}."));
    let mut envelope = unavailable(reason, hint_for_status(status));
    envelope["status"] = json!(status);
    envelope
}

async fn search(
    client: &reqwest::Client,
    target: &CloudSearchTarget,
    query: &str,
    limit: u16,
) -> Value {
    let response = client
        .post(format!("{}/v1/web/search", target.base_url))
        .bearer_auth(&target.token)
        .timeout(REQUEST_TIMEOUT)
        .json(&json!({ "query": query, "limit": limit }))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(error = %error.without_url(), "Ryu Cloud web search is unreachable");
            return unavailable("Ryu Cloud web search is unreachable.", hint_for_status(503));
        }
    };
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    gateway_result(status, body)
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// `POST /api/cloud/web-search` — search the web through Ryu Cloud's hosted
/// search, billed to the organization's credit balance.
#[utoipa::path(
    post,
    path = "/api/cloud/web-search",
    tag = "Chat",
    summary = "Search the web through Ryu Cloud hosted search",
    request_body = serde_json::Value,
    responses((status = 200, description = "Search results, or an `available: false` envelope", body = serde_json::Value))
)]
pub(super) async fn cloud_web_search_handler(
    Json(body): Json<CloudWebSearchBody>,
) -> axum::response::Response {
    let query = body.query.trim();
    if query.is_empty() {
        return Json(unavailable(
            "missing required field 'query'",
            "Pass a search query.",
        ))
        .into_response();
    }
    if !selected(&crate::plugins::binding::active_config()) {
        return Json(not_selected()).into_response();
    }
    let limit = body.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let Some(target) = current_target() else {
        return Json(not_connected()).into_response();
    };
    Json(search(http_client(), &target, query, limit).await).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(url: &str, token: &str) -> Option<(String, String)> {
        Some((url.to_owned(), token.to_owned()))
    }

    #[test]
    fn remote_nodes_use_their_gateway_and_local_nodes_use_the_managed_fleet() {
        let remote = select_target(
            true,
            || pair("https://gw.example/ ", "rgw_remote"),
            || panic!("a remote node never reads managed-fleet coordinates"),
        )
        .unwrap();
        assert_eq!(remote.base_url, "https://gw.example");
        assert_eq!(remote.token, "rgw_remote");

        let local = select_target(
            false,
            || panic!("a local node never presents its local relay credential"),
            || pair("https://fleet.example", "rgw_fleet"),
        )
        .unwrap();
        assert_eq!(local.base_url, "https://fleet.example");
        assert_eq!(local.token, "rgw_fleet");
    }

    #[test]
    fn serves_only_an_explicit_ryu_cloud_search_selection() {
        use crate::plugins::binding::BindingConfig;
        assert!(!selected(&BindingConfig::default()));
        let exa = BindingConfig {
            overrides: [("web.search".to_owned(), "@ryu/exa".to_owned())].into(),
        };
        assert!(!selected(&exa));
        let cloud = BindingConfig {
            overrides: [("web.search".to_owned(), "@ryu/cloud-search".to_owned())].into(),
        };
        assert!(selected(&cloud));
        let refusal = not_selected();
        assert_eq!(refusal["available"], false);
        assert!(refusal["reason"]
            .as_str()
            .unwrap()
            .contains("not the selected web search provider"));
    }

    #[test]
    fn missing_or_blank_coordinates_mean_not_connected() {
        assert!(select_target(false, || None, || None).is_none());
        assert!(select_target(true, || None, || None).is_none());
        assert!(select_target(false, || None, || pair("https://fleet.example", " ")).is_none());
        assert!(select_target(false, || None, || pair(" ", "rgw_fleet")).is_none());
    }

    #[test]
    fn success_passes_results_through_and_refusals_carry_the_gateway_reason() {
        let ok = json!({"results":[{"title":"T","url":"https://example.com","snippet":"S","score":null}],"usage":{"requests":1}});
        assert_eq!(gateway_result(200, ok.clone()), ok);

        let malformed = gateway_result(200, json!({"oops":true}));
        assert_eq!(malformed["available"], false);

        let disabled = gateway_result(
            403,
            json!({"error":{"message":"Hosted web search is disabled for this organization","code":"policy_violation"}}),
        );
        assert_eq!(disabled["available"], false);
        assert_eq!(disabled["status"], 403);
        assert_eq!(
            disabled["reason"],
            "Hosted web search is disabled for this organization"
        );
        assert!(disabled["hint"]
            .as_str()
            .unwrap()
            .contains("Hosted web search"));

        let exhausted = gateway_result(402, Value::Null);
        assert_eq!(exhausted["status"], 402);
        assert!(exhausted["reason"].as_str().unwrap().contains("HTTP 402"));
    }

    #[tokio::test]
    async fn forwards_query_with_relay_credential_to_hosted_gateway() {
        use axum::{http::HeaderMap, routing::post, Router};
        let seen = std::sync::Arc::new(tokio::sync::Mutex::new(None));
        let observed = std::sync::Arc::clone(&seen);
        let app = Router::new().route(
            "/v1/web/search",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let observed = std::sync::Arc::clone(&observed);
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    *observed.lock().await = Some((auth, body));
                    Json(json!({"results":[{"title":"Found","url":"https://example.com/a","snippet":"Snippet","score":0.5}]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let target = CloudSearchTarget {
            base_url,
            token: "rgw_relay".into(),
        };
        let result = search(&client, &target, "ryu gateway", 3).await;
        assert_eq!(result["results"][0]["url"], "https://example.com/a");
        let (auth, body) = seen.lock().await.clone().unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer rgw_relay"));
        assert_eq!(body, json!({"query":"ryu gateway","limit":3}));
        server.abort();
    }

    #[tokio::test]
    async fn unreachable_gateway_is_a_soft_failure() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let target = CloudSearchTarget {
            base_url: "http://127.0.0.1:1".into(),
            token: "rgw_relay".into(),
        };
        let result = search(&client, &target, "q", 1).await;
        assert_eq!(result["available"], false);
        assert!(!result.to_string().contains("rgw_relay"));
    }
}
