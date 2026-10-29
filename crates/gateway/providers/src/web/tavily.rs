//! Tavily basic search and single-page extraction; no implicit alternate service.
use serde_json::{json, Value};

use super::{
    optional_text, required_text, result_url, score, uncertain, FetchedPage, WebFetchOutput,
    WebFetchRequest, WebSearchOutput, WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::WebContentFormat;

pub(super) fn search_payload(request: &WebSearchRequest) -> (&'static str, Value) {
    (
        "/search",
        json!({"query":request.query(),"max_results":request.limit(),"search_depth":"basic","include_answer":false,"include_raw_content":false,"include_usage":true}),
    )
}

pub(super) fn fetch_payload(request: &WebFetchRequest) -> (&'static str, Value) {
    let format = match request.format() {
        WebContentFormat::Markdown => "markdown",
        WebContentFormat::Text => "text",
    };
    (
        "/extract",
        json!({"urls":[request.url().as_str()],"format":format,"extract_depth":"basic","include_usage":true}),
    )
}

fn usage(value: &Value, documents: u64) -> Result<WebServiceUsage, ProviderError> {
    let credits = match &value["usage"]["credits"] {
        Value::Null => None,
        value => Some(
            value
                .as_u64()
                .ok_or_else(|| uncertain("Tavily credit usage is invalid"))?,
        ),
    };
    Ok(WebServiceUsage {
        requests: 1,
        documents,
        provider_credits: credits,
        ..Default::default()
    })
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    let rows = value["results"]
        .as_array()
        .ok_or_else(|| uncertain("Tavily search result array is missing"))?;
    if rows.len() > usize::from(limit) {
        return Err(uncertain("Tavily search exceeded result limit"));
    }
    let results = rows
        .iter()
        .map(|row| {
            Ok(WebSearchResult {
                title: optional_text(&row["title"])?,
                url: result_url(&row["url"])?,
                snippet: required_text(&row["content"])?,
                score: score(&row["score"])?,
            })
        })
        .collect::<Result<Vec<_>, ProviderError>>()?;
    Ok(WebSearchOutput {
        results,
        usage: usage(value, 0)?,
    })
}

pub(super) fn parse_fetch(
    value: &Value,
    request: &WebFetchRequest,
) -> Result<WebFetchOutput, ProviderError> {
    let rows = value["results"]
        .as_array()
        .ok_or_else(|| uncertain("Tavily fetch result array is missing"))?;
    // HTTP 200 can contain only failed_results. It is not successful empty fetch.
    if rows.len() != 1
        || value
            .get("failed_results")
            .is_some_and(|failed| !failed.as_array().is_some_and(Vec::is_empty))
    {
        return Err(uncertain("Tavily could not extract the requested page"));
    }
    let row = &rows[0];
    let url = result_url(&row["url"])?;
    if url != request.url().as_str() {
        return Err(uncertain("Tavily returned a different requested page"));
    }
    let page = FetchedPage {
        url,
        title: optional_text(&row["title"])?,
        content: required_text(&row["raw_content"])?,
        format: request.format(),
    };
    Ok(WebFetchOutput {
        results: vec![page],
        usage: usage(value, 1)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use crate::web::{tests::fixture, ValidatedPublicWebUrl};
    use crate::ProviderAccountPolicy;
    use ryu_gw_credentials::web::WebProviderKind;

    #[tokio::test]
    async fn actual_http_search_and_extract_use_official_wire_and_explicit_auth() {
        let server = MockServer::start(vec![MockResponse::ok_json(r#"{"results":[{"title":"Found","url":"https://example.com/page","content":"snippet","score":0.5}],"usage":{"credits":1}}"#),MockResponse::ok_json(r##"{"results":[{"url":"https://8.8.8.8/page","raw_content":"# Page"}],"failed_results":[],"usage":{"credits":0}}"##)]).await;
        let provider = fixture(
            WebProviderKind::Tavily,
            server.base_url(),
            &["synthetic-key"],
            vec![ProviderAccountPolicy::default()],
        );
        let backend: &dyn crate::Provider = &provider;
        let output = backend
            .web_search_for_session(
                &WebSearchRequest::new(" query ".into(), 3).unwrap(),
                Some("tenant:session"),
            )
            .await
            .unwrap();
        assert_eq!(output.results[0].snippet, "snippet");
        assert_eq!(output.usage.provider_credits, Some(1));
        let request = WebFetchRequest::new(
            ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
            WebContentFormat::Markdown,
        );
        let output = backend
            .web_fetch_for_session(&request, Some("tenant:session"))
            .await
            .unwrap();
        assert_eq!(output.results[0].content, "# Page");
        assert_eq!(output.usage.documents, 1);
        assert_eq!(output.usage.provider_credits, Some(0));
        let requests = server.requests();
        assert!(requests[0].path.ends_with("/search"));
        assert!(requests[1].path.ends_with("/extract"));
        assert_eq!(requests[0].json()["max_results"], 3);
        assert_eq!(requests[0].json()["search_depth"], "basic");
        assert_eq!(requests[1].json()["urls"], json!(["https://8.8.8.8/page"]));
        assert_eq!(requests[1].json()["format"], "markdown");
        for request in requests {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer synthetic-key")
            );
        }
    }

    #[test]
    fn empty_search_is_valid_but_missing_results_and_failed_extraction_are_not() {
        assert!(parse_search(&json!({"results":[]}), 10)
            .unwrap()
            .results
            .is_empty());
        for value in [
            json!({}),
            json!({"results":null}),
            json!({"results":[{"url":"file:///secret","content":"x"}]}),
        ] {
            assert!(parse_search(&value, 10).is_err());
        }
        let request = WebFetchRequest::new(
            ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
            WebContentFormat::Text,
        );
        assert!(parse_fetch(&json!({"results":[],"failed_results":[{"url":"https://8.8.8.8/page","error":"private upstream detail"}]}),&request).is_err());
        assert_eq!(
            parse_fetch(
                &json!({"results":[{"url":"https://8.8.8.8/page","raw_content":""}]}),
                &request
            )
            .unwrap()
            .results[0]
                .content,
            ""
        );
        assert!(parse_fetch(&json!({"results":[{"url":"https://8.8.8.8/page","raw_content":"x".repeat(super::super::MAX_PAGE_BYTES+1)}]}),&request).is_err());
    }
}
