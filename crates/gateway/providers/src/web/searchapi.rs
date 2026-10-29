//! SearchAPI Google engine; bearer auth keeps credentials out of query strings.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, WebSearchOutput,
    WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{
    SearchApiEngine, WebAccountConfig, WebAccountContext, WebProviderKind,
};
use serde_json::Value;
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://www.searchapi.io";
const PATH: &str = "/api/v1/search";

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebSearchRequest,
    _now_unix_seconds: u64,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::SearchApi)
        .map_err(|_| invalid("SearchAPI account context mismatch"))?;
    let WebAccountContext::SearchApi {
        engine: SearchApiEngine::Google,
    } = account.context()
    else {
        return Err(invalid("SearchAPI engine context is required"));
    };
    // Google num is fixed10 since September2025; limit is applied after parsing.
    Ok(client
        .get(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .bearer_auth(account.api_key())
        .query(&[("engine", "google"), ("q", request.query())])
        .timeout(Duration::from_secs(60)))
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    if value.get("error").is_some() {
        return Err(uncertain("SearchAPI returned an error envelope"));
    }
    let results = match value.get("organic_results") {
        Some(Value::Array(rows)) => {
            if rows.len() > 100 {
                return Err(uncertain("SearchAPI result array exceeds Gateway limit"));
            }
            rows.iter()
                .take(usize::from(limit))
                .map(|row| {
                    Ok(WebSearchResult {
                        title: optional_text(&row["title"])?,
                        url: result_url(&row["link"])?,
                        snippet: required_text(&row["snippet"])?,
                        score: None,
                    })
                })
                .collect::<Result<Vec<_>, ProviderError>>()?
        }
        None if value["search_information"]["total_results"].as_u64() == Some(0) => vec![],
        _ => return Err(uncertain("SearchAPI result envelope is invalid")),
    };
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
    use serde_json::json;
    #[tokio::test]
    async fn actual_http_uses_selected_engine_and_bearer_without_secret_or_obsolete_num_query() {
        let server=MockServer::always(MockResponse::ok_json(r#"{"organic_results":[{"title":"One","link":"https://example.com/one","snippet":"One"},{"title":"Two","link":"https://example.com/two","snippet":"Two"}]}"#)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let account = WebAccountConfig::new(
            "synthetic-key".into(),
            WebAccountContext::SearchApi {
                engine: SearchApiEngine::Google,
            },
        )
        .unwrap();
        let query = WebSearchRequest::new("q & api_key=forged".into(), 1).unwrap();
        let native = request(&client, server.base_url(), &account, &query, 0)
            .unwrap()
            .build()
            .unwrap();
        let parameters = native.url().query_pairs().into_owned().collect::<Vec<_>>();
        assert_eq!(parameters.len(), 2);
        assert!(parameters.contains(&("engine".into(), "google".into())));
        assert!(parameters.contains(&("q".into(), "q & api_key=forged".into())));
        assert!(!parameters
            .iter()
            .any(|(key, _)| key == "api_key" || key == "num"));
        let response = client.execute(native).await.unwrap();
        assert_eq!(
            parse_search(&super::super::read_json(response).await.unwrap(), 1)
                .unwrap()
                .results
                .len(),
            1
        );
        let recorded = server.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "GET");
        assert_eq!(
            recorded[0].header("authorization").as_deref(),
            Some("Bearer synthetic-key")
        );
    }
    #[test]
    fn zero_results_require_explicit_success_shape() {
        assert!(parse_search(&json!({"organic_results":[]}), 10)
            .unwrap()
            .results
            .is_empty());
        assert!(
            parse_search(&json!({"search_information":{"total_results":0}}), 10)
                .unwrap()
                .results
                .is_empty()
        );
        assert!(parse_search(&json!({}), 10).is_err());
        assert!(parse_search(&json!({"organic_results":[],"error":"synthetic-key"}), 10).is_err());
    }
}
