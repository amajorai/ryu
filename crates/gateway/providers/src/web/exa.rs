//! Exa direct search and contents. No public MCP or ambient auth fallback.
use serde_json::{json, Value};

use super::{
    optional_text, required_text, result_url, score, uncertain, FetchedPage, WebFetchOutput,
    WebFetchRequest, WebSearchOutput, WebSearchRequest, WebSearchResult, WebServiceUsage,
};
use crate::ProviderError;

pub(super) fn search_payload(request: &WebSearchRequest) -> (&'static str, Value) {
    (
        "/search",
        json!({"query":request.query(),"numResults":request.limit(),"type":"auto","contents":{"text":true}}),
    )
}

pub(super) fn fetch_payload(request: &WebFetchRequest) -> (&'static str, Value) {
    (
        "/contents",
        json!({"urls":[request.url().as_str()],"text":true}),
    )
}

fn usage(value: &Value, documents: u64) -> Result<WebServiceUsage, ProviderError> {
    let cost = match &value["costDollars"]["total"] {
        Value::Null => None,
        Value::Number(number) => Some(decimal_micro_usd(&number.to_string())?),
        _ => return Err(uncertain("Exa cost estimate is invalid")),
    };
    Ok(WebServiceUsage {
        requests: 1,
        documents,
        reported_cost_micro_usd: cost,
        cost_is_estimate: cost.is_some(),
        ..Default::default()
    })
}

/// Checked decimal arithmetic, rounding fractional micro-USD upward. Never
/// multiply f64 dollars by a million or cast negative/overflowing money.
fn decimal_micro_usd(raw: &str) -> Result<u64, ProviderError> {
    let invalid = || uncertain("Exa cost estimate is invalid");
    if raw.starts_with('-') || raw.is_empty() {
        return Err(invalid());
    }
    let (mantissa, exponent) = match raw.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().map_err(|_| invalid())?),
        None => (raw, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid());
    }
    let mut digits = 0_u128;
    for byte in whole.bytes().chain(fraction.bytes()) {
        digits = digits
            .checked_mul(10)
            .and_then(|value| value.checked_add(u128::from(byte - b'0')))
            .ok_or_else(invalid)?;
    }
    if digits == 0 {
        return Ok(0);
    }
    let scale =
        6_i64 + i64::from(exponent) - i64::try_from(fraction.len()).map_err(|_| invalid())?;
    let micro = if scale >= 0 {
        let power = u32::try_from(scale)
            .ok()
            .filter(|value| *value <= 38)
            .ok_or_else(invalid)?;
        digits
            .checked_mul(10_u128.checked_pow(power).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
    } else if scale < -38 {
        1
    } else {
        let divisor = 10_u128.checked_pow((-scale) as u32).ok_or_else(invalid)?;
        digits / divisor + u128::from(digits % divisor != 0)
    };
    u64::try_from(micro)
        .ok()
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(invalid)
}

pub(super) fn parse_search(value: &Value, limit: u16) -> Result<WebSearchOutput, ProviderError> {
    let rows = value["results"]
        .as_array()
        .ok_or_else(|| uncertain("Exa search result array is missing"))?;
    if rows.len() > usize::from(limit) {
        return Err(uncertain("Exa search exceeded result limit"));
    }
    let results = rows
        .iter()
        .map(|row| {
            Ok(WebSearchResult {
                title: optional_text(&row["title"])?,
                url: result_url(&row["url"])?,
                snippet: required_text(&row["text"])?,
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
        .ok_or_else(|| uncertain("Exa contents result array is missing"))?;
    let statuses = value["statuses"]
        .as_array()
        .ok_or_else(|| uncertain("Exa contents status array is missing"))?;
    if rows.len() != 1 || statuses.len() != 1 || statuses[0]["status"].as_str() != Some("success") {
        return Err(uncertain("Exa could not fetch the requested page"));
    }
    let row = &rows[0];
    let expected_status_id = row["id"].as_str().unwrap_or(request.url().as_str());
    if statuses[0]["id"].as_str() != Some(expected_status_id) {
        return Err(uncertain("Exa returned a different contents status"));
    }
    let url = result_url(&row["url"])?;
    // Redirected resource URLs may differ, but origin authorization cannot turn
    // a one-page request into unrelated or multiple content without disclosure.
    if url != request.url().as_str() {
        return Err(uncertain("Exa returned a different requested page"));
    }
    let page = FetchedPage {
        url,
        title: optional_text(&row["title"])?,
        content: required_text(&row["text"])?,
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
    use ryu_gw_credentials::web::{WebContentFormat, WebProviderKind};

    #[tokio::test]
    async fn actual_http_search_and_contents_use_camelcase_limits_and_selected_key() {
        let server=MockServer::start(vec![MockResponse::ok_json(r#"{"results":[{"title":"Found","url":"https://example.com/page","text":"snippet"}],"costDollars":{"total":0.003}}"#),MockResponse::ok_json(r#"{"results":[{"url":"https://8.8.8.8/page","text":"Page"}],"statuses":[{"id":"https://8.8.8.8/page","status":"success","source":"cached"}],"costDollars":{"total":0.0000011}}"#)]).await;
        let provider = fixture(
            WebProviderKind::Exa,
            server.base_url(),
            &["synthetic-key"],
            vec![ProviderAccountPolicy::default()],
        );
        let search = provider
            .search(&WebSearchRequest::new("query".into(), 3).unwrap(), None)
            .await
            .unwrap();
        assert_eq!(search.usage.reported_cost_micro_usd, Some(3000));
        assert!(search.usage.cost_is_estimate);
        assert_eq!(search.results[0].score, None);
        let request = WebFetchRequest::new(
            ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
            WebContentFormat::Text,
        );
        let fetch = provider.fetch(&request, None).await.unwrap();
        assert_eq!(fetch.results[0].content, "Page");
        assert_eq!(fetch.usage.reported_cost_micro_usd, Some(2));
        let requests = server.requests();
        assert!(requests[0].path.ends_with("/search"));
        assert!(requests[1].path.ends_with("/contents"));
        assert_eq!(requests[0].json()["numResults"], 3);
        assert!(requests[0].json().get("num_results").is_none());
        assert_eq!(requests[1].json()["urls"], json!(["https://8.8.8.8/page"]));
        for request in requests {
            assert_eq!(
                request.header("x-api-key").as_deref(),
                Some("synthetic-key")
            );
            assert!(request.header("authorization").is_none());
        }
    }

    #[test]
    fn decimal_cost_conversion_is_checked_and_preserves_zero_and_estimate_provenance() {
        for (raw, expected) in [
            ("0", 0),
            ("0.003", 3000),
            ("0.000001", 1),
            ("0.0000011", 2),
            ("1e-7", 1),
            ("1e2", 100_000_000),
            ("0e308", 0),
            ("1e-40", 1),
        ] {
            assert_eq!(decimal_micro_usd(raw).unwrap(), expected, "{raw}");
        }
        for raw in ["-1", "NaN", "inf", "1e40", "9223372036854775808", "1.2.3"] {
            assert!(decimal_micro_usd(raw).is_err(), "{raw}");
        }
        let usage = usage(&json!({"costDollars":{"total":0}}), 0).unwrap();
        assert_eq!(usage.reported_cost_micro_usd, Some(0));
        assert!(usage.cost_is_estimate);
        assert!(parse_search(&json!({"results":[]}), 10)
            .unwrap()
            .results
            .is_empty());
        assert!(parse_search(&json!({"error":"synthetic-key secret"}), 10).is_err());
    }

    #[tokio::test]
    async fn malformed_cost_after_http_success_is_uncertain_and_never_replayed() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"results":[],"costDollars":{"total":"private-cost-material"}}"#,
        ))
        .await;
        let provider = fixture(
            WebProviderKind::Exa,
            server.base_url(),
            &["synthetic-primary", "synthetic-backup"],
            vec![
                ProviderAccountPolicy::default(),
                ProviderAccountPolicy::default(),
            ],
        );
        let error = provider
            .search(&WebSearchRequest::new("query".into(), 1).unwrap(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        assert!(!error.to_string().contains("private-cost-material"));
        assert!(!error.to_string().contains("synthetic-primary"));
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn contents_format_mismatch_rejects_before_spend_and_failures_are_not_empty_success() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let provider = fixture(
            WebProviderKind::Exa,
            server.base_url(),
            &["synthetic-key"],
            vec![ProviderAccountPolicy::default()],
        );
        let url = ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap();
        assert!(provider
            .fetch(
                &WebFetchRequest::new(url.clone(), WebContentFormat::Markdown),
                None
            )
            .await
            .is_err());
        assert!(server.requests().is_empty());
        let request = WebFetchRequest::new(url, WebContentFormat::Text);
        assert!(parse_fetch(
            &json!({"results":[],"statuses":[{"status":"error","error":"upstream secret"}]}),
            &request
        )
        .is_err());
        assert!(parse_fetch(&json!({"results":[{"url":"https://8.8.8.8/page","text":"x"}],"statuses":[{"status":"error"}]}),&request).is_err());
    }
}
