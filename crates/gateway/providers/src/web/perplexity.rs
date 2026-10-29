//! Direct perplexity search; fixed vendor origin, no provider-default auth.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, WebSearchOutput,
    WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebProviderKind};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://api.perplexity.ai";
const PATH: &str = "/search";

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebSearchRequest,
    _now_unix_seconds: u64,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::PerplexitySearch)
        .map_err(|_| invalid("web search account context mismatch"))?;
    Ok(client
        .post(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .json(&json!({"query":request.query(),"max_results":request.limit(),"search_type":"web"}))
        .header("Authorization", format!("Bearer {}", account.api_key()))
        .timeout(Duration::from_secs(60)))
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    if value.get("error").is_some() {
        return Err(uncertain("web search returned an error envelope"));
    }
    let rows = (&value["results"])
        .as_array()
        .ok_or_else(|| uncertain("perplexity result array is missing"))?;
    if rows.len() > usize::from(limit) {
        return Err(uncertain("perplexity search exceeded result limit"));
    }
    let results = rows
        .iter()
        .map(|row| {
            Ok(WebSearchResult {
                title: optional_text(&row["title"])?,
                url: result_url(&row["url"])?,
                snippet: required_text(&row["snippet"])?,
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
        let server=MockServer::always(MockResponse::ok_json(r#"{"results":[{"title":"Found","url":"https://example.com/page","snippet":"Snippet"}],"id":"fixture"}"#)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        let query = WebSearchRequest::new("q & engine=other".into(), 3).unwrap();
        let response = request(&client, server.base_url(), &account, &query, 0)
            .unwrap()
            .send()
            .await
            .unwrap();
        let value = super::super::read_json(response).await.unwrap();
        let output = parse_search(&value, query.limit()).unwrap();
        assert_eq!(output.results[0].snippet, "Snippet");
        assert_eq!(output.results[0].score, None);
        let recorded = server.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert!(recorded[0].path.starts_with(PATH));
        assert_eq!(
            recorded[0].header("authorization").as_deref(),
            Some("Bearer synthetic-key")
        );
        let body = recorded[0].json();
        assert_eq!(body["query"], "q & engine=other");
        assert_eq!(body["max_results"], 3);
    }
    #[test]
    fn empty_results_are_distinct_from_auth_or_malformed_payload() {
        assert!(parse_search(&json!({"results":[],"id":"fixture"}), 10)
            .unwrap()
            .results
            .is_empty());
        for value in [json!({}), json!({"error":"synthetic-key raw vendor body"})] {
            let error = parse_search(&value, 10).unwrap_err();
            assert!(!error.to_string().contains("synthetic-key"));
        }
    }
}
