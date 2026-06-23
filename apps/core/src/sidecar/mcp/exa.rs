//! Built-in Exa search tool provider (U040).
//!
//! Exa (<https://exa.ai>) is an AI-native web search and neural search API. This
//! module surfaces Exa's search capability as a callable tool through the same
//! registry call surface the rest of the tool loop uses
//! (`McpRegistry::list_all_tools` / `call_tool`), following the Shadow pure-tool
//! pattern from `shadow.rs:124`.
//!
//! ## BYOK
//!
//! Exa is an external API that requires an API key. The key is read from the
//! `RYU_EXA_API_KEY` environment variable. When the key is absent the tool returns
//! a structured `{ available: false, reason }` result (never `Err`) so the agent's
//! turn continues — exactly mirroring `shadow.rs:137-146`.
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what tools run* is Core, so this provider lives here. The key itself
//! is a BYOK secret; wiring it through the Gateway's key vault is a Gateway concern
//! (M2/M9) and out of scope here — the env-var seam is the explicit hand-off point.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in Exa provider.
pub const SERVER_NAME: &str = "exa";

/// Exa search API base URL. Override with `RYU_EXA_BASE_URL` to point at a
/// self-hosted instance or proxy — satisfying the "nothing hardcoded" constraint.
const DEFAULT_BASE_URL: &str = "https://api.exa.ai";

/// How long to wait for the Exa API before declaring it unavailable.
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// Environment variable holding the Exa API key (BYOK).
const ENV_EXA_API_KEY: &str = "RYU_EXA_API_KEY";

/// Resolve the Exa base URL: `RYU_EXA_BASE_URL` if set, else the default.
fn base_url() -> String {
    std::env::var("RYU_EXA_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_owned())
}

/// Read the Exa API key from the environment.
fn api_key() -> Option<String> {
    std::env::var(ENV_EXA_API_KEY)
        .ok()
        .filter(|k| !k.is_empty())
}

/// A structured "Exa is unavailable" tool result. Returned (as `Ok`) instead of
/// an error so a missing key or failed request does not abort the agent's turn.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Set the RYU_EXA_API_KEY environment variable to your Exa API key to enable neural web search."
    })
}

// ── Tool schemas ─────────────────────────────────────────────────────────────

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query. Supports natural-language and keyword queries."
            },
            "num_results": {
                "type": "integer",
                "description": "Number of results to return (default 10).",
                "minimum": 1,
                "maximum": 100
            },
            "use_autoprompt": {
                "type": "boolean",
                "description": "Let Exa rephrase the query for better neural search results (default true)."
            },
            "include_text": {
                "type": "boolean",
                "description": "Include the full page text in results (default false)."
            }
        },
        "required": ["query"]
    })
}

fn find_similar_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "URL to find similar pages for."
            },
            "num_results": {
                "type": "integer",
                "description": "Number of similar results to return (default 10).",
                "minimum": 1,
                "maximum": 100
            }
        },
        "required": ["url"]
    })
}

/// The set of Exa tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}__search"),
            server: SERVER_NAME.to_owned(),
            name: "search".to_owned(),
            description: Some(
                "Neural and keyword web search via the Exa API. Returns relevant web pages with \
                 titles, URLs, published dates, and optionally full page text. Requires RYU_EXA_API_KEY."
                    .to_owned(),
            ),
            input_schema: Some(search_schema()),
        },
        RegistryTool {
            id: format!("{SERVER_NAME}__find_similar"),
            server: SERVER_NAME.to_owned(),
            name: "find_similar".to_owned(),
            description: Some(
                "Find pages similar to a given URL using Exa's neural search. Requires RYU_EXA_API_KEY."
                    .to_owned(),
            ),
            input_schema: Some(find_similar_schema()),
        },
    ]
}

/// Dispatch an Exa tool call over HTTP. `tool` is the bare tool name (already
/// stripped of the `exa__` prefix by the registry). Never returns `Err` for a
/// missing key or unreachable API — that becomes an `available: false` result so
/// the tool loop continues. `Err` is reserved for genuinely malformed calls
/// (unknown tool, bad arguments).
pub async fn dispatch(client: &reqwest::Client, tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "search" => exa_search(client, arguments).await,
        "find_similar" => exa_find_similar(client, arguments).await,
        other => Err(anyhow::anyhow!("unknown Exa tool '{other}'")),
    }
}

/// POST to `Exa /search` and return results.
async fn exa_search(client: &reqwest::Client, arguments: Value) -> Result<Value> {
    let query = require_string(&arguments, "query")?;

    let key = match api_key() {
        Some(k) => k,
        None => {
            return Ok(unavailable(
                "RYU_EXA_API_KEY is not set. Add your Exa API key to use neural web search.",
            ));
        }
    };

    let num_results = arguments
        .get("num_results")
        .and_then(Value::as_u64)
        .unwrap_or(10);
    let use_autoprompt = arguments
        .get("use_autoprompt")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_text = arguments
        .get("include_text")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let body = json!({
        "query": query,
        "num_results": num_results,
        "use_autoprompt": use_autoprompt,
        "contents": {
            "text": include_text
        }
    });

    let url = format!("{}/search", base_url());
    post_json(client, &url, &key, body).await
}

/// POST to `Exa /findSimilar` and return results.
async fn exa_find_similar(client: &reqwest::Client, arguments: Value) -> Result<Value> {
    let url_param = require_string(&arguments, "url")?;

    let key = match api_key() {
        Some(k) => k,
        None => {
            return Ok(unavailable(
                "RYU_EXA_API_KEY is not set. Add your Exa API key to use Exa find-similar.",
            ));
        }
    };

    let num_results = arguments
        .get("num_results")
        .and_then(Value::as_u64)
        .unwrap_or(10);

    let body = json!({
        "url": url_param,
        "num_results": num_results
    });

    let api_url = format!("{}/findSimilar", base_url());
    post_json(client, &api_url, &key, body).await
}

/// POST a JSON body to an Exa endpoint with the Bearer token. A transport failure
/// (Exa unreachable) is mapped to an `available: false` result, not an error.
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: Value,
) -> Result<Value> {
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Ok(unavailable(format!("Exa API is not reachable: {e}"))),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Ok(unavailable(format!(
            "Exa API returned HTTP {status}: {body_text}"
        )));
    }

    match resp.json::<Value>().await {
        Ok(body) => Ok(body),
        Err(e) => Ok(unavailable(format!(
            "Exa API returned an invalid response: {e}"
        ))),
    }
}

fn require_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_exa_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 2);
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"exa__search"));
        assert!(ids.contains(&"exa__find_similar"));
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.input_schema.is_some());
            assert!(t.description.is_some());
        }
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let client = reqwest::Client::new();
        let err = dispatch(&client, "does_not_exist", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_required_argument_is_an_error() {
        let client = reqwest::Client::new();
        // search requires "query"
        let err = dispatch(&client, "search", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn unset_api_key_yields_unavailable_not_error() {
        // Ensure the key is definitely unset.
        let prev = std::env::var(ENV_EXA_API_KEY).ok();
        unsafe {
            std::env::remove_var(ENV_EXA_API_KEY);
        }

        let client = reqwest::Client::new();
        let result = dispatch(&client, "search", json!({ "query": "Ryu AI agents" }))
            .await
            .expect("missing Exa key must not be an error");
        assert_eq!(
            result.get("available").and_then(Value::as_bool),
            Some(false)
        );
        assert!(result.get("reason").is_some());

        if let Some(v) = prev {
            unsafe {
                std::env::set_var(ENV_EXA_API_KEY, v);
            }
        }
    }

    #[test]
    fn unavailable_result_shape() {
        let v = unavailable("no key");
        assert_eq!(v["available"], json!(false));
        assert_eq!(v["reason"], json!("no key"));
        assert!(v["hint"].is_string());
    }
}
