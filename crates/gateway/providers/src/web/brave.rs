//! Direct brave search; fixed vendor origin, no provider-default auth.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, WebSearchOutput,
    WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebProviderKind};
use serde_json::Value;
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://api.search.brave.com";
const PATH: &str = "/res/v1/web/search";

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebSearchRequest,
    _now_unix_seconds: u64,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::Brave)
        .map_err(|_| invalid("web search account context mismatch"))?;
    Ok(client
        .get(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .query(&[
            ("q", request.query().to_owned()),
            ("count", request.limit().to_string()),
        ])
        .header("X-Subscription-Token", account.api_key())
        .timeout(Duration::from_secs(60)))
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    if value.get("error").is_some() {
        return Err(uncertain("web search returned an error envelope"));
    }
    let rows = (&value["web"]["results"])
        .as_array()
        .ok_or_else(|| uncertain("brave result array is missing"))?;
    if rows.len() > usize::from(limit) {
        return Err(uncertain("brave search exceeded result limit"));
    }
    let results = rows
        .iter()
        .map(|row| {
            Ok(WebSearchResult {
                title: optional_text(&row["title"])?,
                url: result_url(&row["url"])?,
                snippet: required_text(&row["description"])?,
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
        let server=MockServer::always(MockResponse::ok_json(r#"{"web":{"results":[{"title":"Found","url":"https://example.com/page","description":"Snippet"}]}}"#)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        let query = WebSearchRequest::new("q & engine=other".into(), 3).unwrap();
        let native = request(&client, server.base_url(), &account, &query, 0)
            .unwrap()
            .build()
            .unwrap();
        let parameters = native.url().query_pairs().into_owned().collect::<Vec<_>>();
        assert!(parameters.contains(&("q".into(), "q & engine=other".into())));
        assert!(parameters.contains(&("count".into(), "3".into())));
        let response = client.execute(native).await.unwrap();
        let value = super::super::read_json(response).await.unwrap();
        let output = parse_search(&value, query.limit()).unwrap();
        assert_eq!(output.results[0].snippet, "Snippet");
        assert_eq!(output.results[0].score, None);
        let recorded = server.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "GET");
        assert!(recorded[0].path.starts_with(PATH));
        assert_eq!(
            recorded[0].header("x-subscription-token").as_deref(),
            Some("synthetic-key")
        );
    }
    #[test]
    fn empty_results_are_distinct_from_auth_or_malformed_payload() {
        assert!(parse_search(&json!({"web":{"results":[]}}), 10)
            .unwrap()
            .results
            .is_empty());
        for value in [json!({}), json!({"error":"synthetic-key raw vendor body"})] {
            let error = parse_search(&value, 10).unwrap_err();
            assert!(!error.to_string().contains("synthetic-key"));
        }
    }
}
