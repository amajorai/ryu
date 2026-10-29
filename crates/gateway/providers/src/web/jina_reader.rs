//! Jina Reader Markdown extraction with explicit anonymous or selected account auth.
use super::{
    invalid, optional_text, required_text, result_url, uncertain, FetchedPage, WebFetchOutput,
    WebFetchRequest, WebServiceUsage,
};
use crate::ProviderError;
use ryu_gw_credentials::web::{WebAccountConfig, WebContentFormat, WebProviderKind};
use serde_json::Value;
use std::time::Duration;

pub(super) const BASE_URL: &str = "https://r.jina.ai";
pub(super) enum JinaAuth<'a> {
    Anonymous,
    Account(&'a WebAccountConfig),
}

pub(super) fn request(
    client: &reqwest::Client,
    endpoint: &str,
    auth: JinaAuth<'_>,
    request: &WebFetchRequest,
) -> Result<reqwest::RequestBuilder, ProviderError> {
    if request.format() != WebContentFormat::Markdown {
        return Err(invalid("Jina Reader fetch format is unsupported"));
    }
    // Official Reader supports POST url body fields. No target cookies/headers,
    // scripts, uploaded files, browser sessions or ambient credentials enter here.
    let builder = client
        .post(format!("{}/", endpoint.trim_end_matches('/')))
        .form(&[("url", request.url().as_str())])
        .header("Accept", "application/json")
        .header("X-Respond-With", "markdown")
        .timeout(Duration::from_secs(60));
    match auth {
        JinaAuth::Anonymous => Ok(builder),
        JinaAuth::Account(account) => {
            account
                .validate_for(WebProviderKind::JinaReader)
                .map_err(|_| invalid("Jina Reader account context mismatch"))?;
            Ok(builder.bearer_auth(account.api_key()))
        }
    }
}

pub(super) fn parse_fetch(
    value: &Value,
    request: &WebFetchRequest,
) -> Result<WebFetchOutput, ProviderError> {
    if request.format() != WebContentFormat::Markdown || value["code"].as_u64() != Some(200) {
        return Err(uncertain("Jina Reader extraction was unavailable"));
    }
    let data = &value["data"];
    let warning = optional_text(&data["warning"])?;
    if warning
        .as_deref()
        .and_then(|warning| warning.strip_prefix("Target URL returned error "))
        .and_then(|suffix| suffix.get(..3))
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| code >= 400)
    {
        return Err(uncertain("Jina Reader target page was unavailable"));
    }
    let url = if data["url"].is_null() {
        request.url().as_str().to_owned()
    } else {
        result_url(&data["url"])?
    };
    if url != request.url().as_str() {
        return Err(uncertain("Jina Reader returned a different requested page"));
    }
    let page = FetchedPage {
        url,
        title: optional_text(&data["title"])?,
        content: required_text(&data["content"])?,
        format: WebContentFormat::Markdown,
    };
    // Reader's usage.tokens are not request credits or inference tokens. Do not
    // silently relabel them; document count remains a measured one-page unit.
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
    use serde_json::json;
    fn fetch() -> WebFetchRequest {
        WebFetchRequest::new(
            ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
            WebContentFormat::Markdown,
        )
    }

    #[tokio::test]
    async fn actual_http_anonymous_sends_no_fake_auth_and_selected_account_sends_only_its_key() {
        let server=MockServer::always(MockResponse::ok_json(r##"{"code":200,"data":{"url":"https://8.8.8.8/page","title":"Page","content":"# Page","usage":{"tokens":123}}}"##)).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        let requested = fetch();
        for auth in [JinaAuth::Anonymous, JinaAuth::Account(&account)] {
            let response = request(&client, server.base_url(), auth, &requested)
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
        }
        let recorded = server.requests();
        assert_eq!(recorded.len(), 2);
        assert!(recorded[0].header("authorization").is_none());
        assert_eq!(
            recorded[1].header("authorization").as_deref(),
            Some("Bearer synthetic-key")
        );
        for request in recorded {
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/");
            assert_eq!(
                request.header("accept").as_deref(),
                Some("application/json")
            );
            assert_eq!(
                request.header("x-respond-with").as_deref(),
                Some("markdown")
            );
            assert!(
                String::from_utf8_lossy(&request.body).contains("url=https%3A%2F%2F8.8.8.8%2Fpage")
            );
        }
    }

    #[test]
    fn empty_content_is_valid_but_target_errors_are_not_hidden_as_no_content() {
        let requested = fetch();
        assert_eq!(
            parse_fetch(
                &json!({"code":200,"data":{"content":"","warning":"cached snapshot"}}),
                &requested
            )
            .unwrap()
            .results[0]
                .content,
            ""
        );
        for value in [
            json!({"code":401,"error":"synthetic-key"}),
            json!({"code":200,"data":{"content":"not found","warning":"Target URL returned error 404"}}),
            json!({"code":200,"data":{}}),
        ] {
            let error = parse_fetch(&value, &requested).unwrap_err();
            assert!(!error.to_string().contains("synthetic-key"));
        }
    }
}
