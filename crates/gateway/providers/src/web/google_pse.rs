//! Google Custom Search JSON API for acknowledged existing customers only.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, WebSearchOutput,
    WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebAccountContext, WebProviderKind};
use serde_json::Value;
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://customsearch.googleapis.com";
const PATH: &str = "/customsearch/v1";

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebSearchRequest,
    now_unix_seconds: u64,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::GooglePse)
        .map_err(|_| invalid("Google search account context mismatch"))?;
    if account.eligibility_diagnostic(now_unix_seconds).is_some() {
        return Err(invalid(
            "Google search account is inactive under legacy eligibility policy",
        ));
    }
    let WebAccountContext::GooglePse { engine_id, .. } = account.context() else {
        return Err(invalid("Google search engine context is required"));
    };
    // Secret query values are never included in a surfaced reqwest error/URL log.
    Ok(client
        .get(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .query(&[
            ("key", account.api_key().to_owned()),
            ("cx", engine_id.clone()),
            ("q", request.query().to_owned()),
            ("num", request.limit().to_string()),
        ])
        .timeout(Duration::from_secs(60)))
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    if value.get("error").is_some() {
        return Err(uncertain("Google search returned an error envelope"));
    }
    let results = match value.get("items") {
        Some(Value::Array(rows)) => {
            if rows.len() > usize::from(limit) {
                return Err(uncertain("Google search exceeded result limit"));
            }
            rows.iter()
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
        None if value["searchInformation"]["totalResults"].as_str() == Some("0") => vec![],
        _ => return Err(uncertain("Google search result envelope is invalid")),
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
    use ryu_gw_credentials::web::GOOGLE_PSE_SUNSET_UNIX_SECONDS;
    use serde_json::json;
    fn account(engine: &str, ack: bool) -> WebAccountConfig {
        WebAccountConfig::new(
            "synthetic-key".into(),
            WebAccountContext::GooglePse {
                engine_id: engine.into(),
                existing_customer_acknowledged: ack,
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn selected_account_engine_and_key_travel_together_as_encoded_get_parameters() {
        let server=MockServer::always(MockResponse::ok_json(r#"{"items":[{"title":"Found","link":"https://example.com/page","snippet":"Snippet"}]}"#)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let query = WebSearchRequest::new("q & cx=forged".into(), 3).unwrap();
        for engine in ["123:one", "123:two"] {
            let native = request(
                &client,
                server.base_url(),
                &account(engine, true),
                &query,
                GOOGLE_PSE_SUNSET_UNIX_SECONDS - 1,
            )
            .unwrap()
            .build()
            .unwrap();
            let parameters = native.url().query_pairs().into_owned().collect::<Vec<_>>();
            assert_eq!(parameters.iter().filter(|(key, _)| key == "cx").count(), 1);
            assert!(parameters.contains(&("cx".into(), engine.into())));
            assert!(parameters.contains(&("key".into(), "synthetic-key".into())));
            assert!(parameters.contains(&("q".into(), "q & cx=forged".into())));
            let response = client.execute(native).await.unwrap();
            assert_eq!(
                parse_search(&super::super::read_json(response).await.unwrap(), 3)
                    .unwrap()
                    .results[0]
                    .snippet,
                "Snippet"
            );
        }
        let recorded = server.requests();
        assert_eq!(recorded.len(), 2);
        for request in recorded {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, PATH);
        }
    }

    #[tokio::test]
    async fn acknowledgment_and_sunset_are_inactive_before_io_not_invalid_auth_fallback() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let client = reqwest::Client::new();
        let query = WebSearchRequest::new("q".into(), 10).unwrap();
        assert!(request(
            &client,
            server.base_url(),
            &account("engine", false),
            &query,
            0
        )
        .is_err());
        assert!(request(
            &client,
            server.base_url(),
            &account("engine", true),
            &query,
            GOOGLE_PSE_SUNSET_UNIX_SECONDS
        )
        .is_err());
        assert!(server.requests().is_empty());
        assert!(
            parse_search(&json!({"searchInformation":{"totalResults":"0"}}), 10)
                .unwrap()
                .results
                .is_empty()
        );
        assert!(parse_search(&json!({}), 10).is_err());
        assert!(
            parse_search(&json!({"items":[],"error":{"message":"synthetic-key"}}), 10).is_err()
        );
    }
}
