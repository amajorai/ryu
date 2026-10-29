//! Direct Parallel search; fixed vendor origin, no provider-default auth.
//! Uses the `fast` preset at Parallel's lowest search tier. `V1SearchRequest` and
//! `AdvancedSearchSettings` are both `additionalProperties: false`, so the result
//! count travels as `advanced_settings.max_results` (a top-level `max_results`
//! is a vendor 4xx). Parallel bills per request, not per row.
use super::{
    invalid, optional_text, result_url, uncertain, WebSearchOutput, WebSearchRequest,
    WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebProviderKind};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://api.parallel.ai";
const PATH: &str = "/v1/search";
const MAX_SNIPPET_CHARS: usize = 4_000;

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebSearchRequest,
    _now_unix_seconds: u64,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::Parallel)
        .map_err(|_| invalid("web search account context mismatch"))?;
    Ok(client
        .post(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .json(&json!({
            "objective": request.query(),
            "search_queries": [request.query()],
            "mode": "fast",
            "advanced_settings": { "max_results": request.limit() },
        }))
        .header("x-api-key", account.api_key())
        .timeout(Duration::from_secs(60)))
}

/// Joins a result's `excerpts` blocks. The array is required but may be empty
/// (the schema sets no `minItems`), so an empty or all-blank list is a valid
/// empty snippet, matching `required_text` in the other adapters. Only a wrong
/// wire shape is `DeliveryUncertain`.
fn snippet(value: &Value) -> Result<String, ProviderError> {
    let excerpts = value
        .as_array()
        .ok_or_else(|| uncertain("parallel excerpts are missing"))?;
    let mut joined = String::new();
    for excerpt in excerpts {
        let text = excerpt
            .as_str()
            .ok_or_else(|| uncertain("parallel excerpt is invalid"))?
            .trim();
        if text.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push_str("\n\n");
        }
        joined.push_str(text);
        if joined.chars().count() >= MAX_SNIPPET_CHARS {
            joined = joined.chars().take(MAX_SNIPPET_CHARS).collect();
            break;
        }
    }
    Ok(joined)
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    if value.get("error").is_some() {
        return Err(uncertain("web search returned an error envelope"));
    }
    let rows = value["results"]
        .as_array()
        .ok_or_else(|| uncertain("parallel result array is missing"))?;
    // `max_results` is documented as an upper bound. Over-delivery does not
    // change the per-request cost, so it is truncated (as SearchAPI does) rather
    // than treated as an accounting failure; an absurd array is still rejected.
    if rows.len() > 100 {
        return Err(uncertain("parallel result array exceeds Gateway limit"));
    }
    let results = rows
        .iter()
        .take(usize::from(limit))
        .map(|row| {
            Ok(WebSearchResult {
                title: optional_text(&row["title"])?,
                url: result_url(&row["url"])?,
                snippet: snippet(&row["excerpts"])?,
                score: None,
            })
        })
        .collect::<Result<Vec<_>, ProviderError>>()?;
    Ok(WebSearchOutput {
        results,
        usage: WebServiceUsage {
            requests: 1,
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use ryu_gw_credentials::web::WebAccountContext;
    use serde_json::json;

    #[tokio::test]
    async fn actual_http_request_uses_native_method_auth_arguments_and_result_fields() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"search_id":"s","results":[{"url":"https://example.com/page","title":"Found","publish_date":null,"excerpts":["First","Second"]}],"usage":[{"name":"sku_search","count":1}]}"#,
        ))
        .await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        let query = WebSearchRequest::new("q & mode=advanced".into(), 3).unwrap();
        let response = request(&client, server.base_url(), &account, &query, 0)
            .unwrap()
            .send()
            .await
            .unwrap();
        let value = super::super::read_json(response).await.unwrap();
        let output = parse_search(&value, query.limit()).unwrap();
        assert_eq!(output.results[0].title.as_deref(), Some("Found"));
        assert_eq!(output.results[0].snippet, "First\n\nSecond");
        assert_eq!(output.usage.requests, 1);
        let recorded = server.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert!(recorded[0].path.starts_with(PATH));
        assert_eq!(
            recorded[0].header("x-api-key").as_deref(),
            Some("synthetic-key")
        );
        let body = recorded[0].json();
        assert_eq!(body["objective"], "q & mode=advanced");
        assert_eq!(body["search_queries"], json!(["q & mode=advanced"]));
        assert_eq!(body["mode"], "fast");
        assert_eq!(body["advanced_settings"], json!({"max_results": 3}));
        assert!(body.get("max_results").is_none());
        let allowed = [
            "objective",
            "search_queries",
            "mode",
            "max_chars_total",
            "session_id",
            "client_model",
            "advanced_settings",
        ];
        for key in body.as_object().unwrap().keys() {
            assert!(allowed.contains(&key.as_str()), "unexpected field {key}");
        }
    }

    #[test]
    fn empty_results_are_distinct_from_auth_or_malformed_payload() {
        assert!(parse_search(&json!({"results":[]}), 10)
            .unwrap()
            .results
            .is_empty());
        for value in [
            json!({}),
            json!({"error":"synthetic-key raw vendor body"}),
            json!({"results":[{"url":"https://example.com"}]}),
            json!({"results":[{"url":"https://example.com","excerpts":"not-an-array"}]}),
            json!({"results":[{"url":"https://example.com","excerpts":[7]}]}),
        ] {
            let error = parse_search(&value, 10).unwrap_err();
            assert!(!error.to_string().contains("synthetic-key"));
        }
    }

    #[test]
    fn empty_excerpts_are_a_valid_empty_snippet() {
        for excerpts in [json!([]), json!(["", "   "])] {
            let output = parse_search(
                &json!({"results":[{"url":"https://example.com/a","title":null,"excerpts":excerpts}]}),
                10,
            )
            .unwrap();
            assert_eq!(output.results.len(), 1);
            assert_eq!(output.results[0].snippet, "");
        }
    }

    #[test]
    fn over_delivery_is_truncated_to_the_requested_limit() {
        let rows = (0..10)
            .map(|index| json!({"url": format!("https://example.com/{index}"), "excerpts": ["x"]}))
            .collect::<Vec<_>>();
        let output = parse_search(&json!({ "results": rows }), 5).unwrap();
        assert_eq!(output.results.len(), 5);
        assert_eq!(output.results[4].url, "https://example.com/4");
        assert_eq!(output.usage.requests, 1);
    }

    #[test]
    fn overlong_excerpts_are_bounded() {
        let long = "x".repeat(MAX_SNIPPET_CHARS + 50);
        let output = parse_search(
            &json!({"results":[{"url":"https://example.com/a","excerpts":[long]}]}),
            10,
        )
        .unwrap();
        assert_eq!(output.results[0].snippet.chars().count(), MAX_SNIPPET_CHARS);
    }
}
