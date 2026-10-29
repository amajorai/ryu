//! Synchronous Firecrawl Markdown scrape. No crawl/browser-session path.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, FetchedPage, WebFetchOutput,
    WebFetchRequest, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebContentFormat, WebProviderKind};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://api.firecrawl.dev";
const PATH: &str = "/v2/scrape";

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    account: &WebAccountConfig,
    request: &WebFetchRequest,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    account
        .validate_for(WebProviderKind::Firecrawl)
        .map_err(|_| invalid("Firecrawl account context mismatch"))?;
    if request.format() != WebContentFormat::Markdown {
        return Err(invalid("Firecrawl fetch format is unsupported"));
    }
    Ok(client.post(format!("{}{PATH}",endpoint.trim_end_matches('/'))).bearer_auth(account.api_key()).json(&json!({"url":request.url().as_str(),"formats":["markdown"],"onlyMainContent":true,"timeout":55000})).timeout(Duration::from_secs(60)))
}

pub(super) fn parse_fetch(
    value: &Value,
    request: &WebFetchRequest,
) -> Result<WebFetchOutput, ProviderError> {
    if request.format() != WebContentFormat::Markdown || value["success"].as_bool() != Some(true) {
        return Err(uncertain(
            "Firecrawl did not return successful Markdown extraction",
        ));
    }
    let data = &value["data"];
    if data["metadata"]["statusCode"]
        .as_u64()
        .is_some_and(|code| !(200..=299).contains(&code))
        || data["metadata"]
            .get("error")
            .is_some_and(|error| !error.is_null())
    {
        return Err(uncertain("Firecrawl target page was unavailable"));
    }
    let url = result_url(&data["metadata"]["sourceURL"])?;
    if url != request.url().as_str() {
        return Err(uncertain("Firecrawl returned a different requested page"));
    }
    let page = FetchedPage {
        url,
        title: optional_text(&data["metadata"]["title"])?,
        content: required_text(&data["markdown"])?,
        format: WebContentFormat::Markdown,
    };
    Ok(WebFetchOutput {
        results: vec![page],
        usage: WebServiceUsage {
            requests: 1,
            documents: 1,
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use crate::web::ValidatedPublicWebUrl;
    use ryu_gw_credentials::web::WebAccountContext;
    fn fetch() -> WebFetchRequest {
        WebFetchRequest::new(
            ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
            WebContentFormat::Markdown,
        )
    }
    #[tokio::test]
    async fn actual_http_scrape_has_explicit_markdown_and_auth_with_native_metadata() {
        let server=MockServer::always(MockResponse::ok_json(r##"{"success":true,"data":{"markdown":"# Page","metadata":{"sourceURL":"https://8.8.8.8/page","title":"Page","statusCode":200}}}"##)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        let requested = fetch();
        let response = request(&client, server.base_url(), &account, &requested)
            .unwrap()
            .send()
            .await
            .unwrap();
        let output = parse_fetch(
            &super::super::read_json(response).await.unwrap(),
            &requested,
        )
        .unwrap();
        assert_eq!(output.results[0].content, "# Page");
        assert_eq!(output.usage.documents, 1);
        assert_eq!(output.usage.provider_credits, None);
        let recorded = server.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert_eq!(recorded[0].path, PATH);
        assert_eq!(
            recorded[0].header("authorization").as_deref(),
            Some("Bearer synthetic-key")
        );
        assert_eq!(recorded[0].json()["formats"], json!(["markdown"]));
        assert_eq!(recorded[0].json()["url"], "https://8.8.8.8/page");
        assert!(recorded[0].json().get("headers").is_none());
        assert!(recorded[0].json().get("actions").is_none());
    }
    #[test]
    fn failure_target_status_and_format_mismatch_are_not_successful_empty_content() {
        let requested = fetch();
        for value in [
            json!({"success":false,"error":"synthetic-key upstream"}),
            json!({"success":true,"data":{"markdown":"x","metadata":{"sourceURL":"https://8.8.8.8/page","statusCode":404}}}),
            json!({"success":true,"data":{"metadata":{"sourceURL":"https://8.8.8.8/page"}}}),
        ] {
            let error = parse_fetch(&value, &requested).unwrap_err();
            assert!(!error.to_string().contains("synthetic-key"));
        }
        let text = WebFetchRequest::new(requested.url().clone(), WebContentFormat::Text);
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        assert!(request(&reqwest::Client::new(), BASE_URL, &account, &text).is_err());
        assert_eq!(parse_fetch(&json!({"success":true,"data":{"markdown":"","metadata":{"sourceURL":"https://8.8.8.8/page"}}}),&requested).unwrap().results[0].content,"");
    }
}
