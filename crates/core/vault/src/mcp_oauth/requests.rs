//! Guarded OAuth HTTP requests and small validation helpers.

use super::*;

pub(super) async fn register_dynamic_client(
    endpoint: &str,
    redirect_uri: &str,
) -> Result<(String, Option<String>)> {
    let body = serde_json::json!({
        "application_type": "native",
        "client_name": "Ryu",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none"
    });
    let response: DynamicClientResponse = post_json(endpoint, &body).await?;
    Ok((response.client_id, response.client_secret))
}

pub(super) async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T> {
    validate_oauth_url(url, false)?;
    let response = request("GET", url, vec![], None).await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth metadata request failed");
    }
    serde_json::from_slice(&response.body).context("invalid OAuth metadata")
}
pub(super) async fn post_json<T: for<'de> Deserialize<'de>>(
    url: &str,
    body: &serde_json::Value,
) -> Result<T> {
    let response = request(
        "POST",
        url,
        vec![("content-type".into(), "application/json".into())],
        Some(serde_json::to_vec(body)?),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth registration request failed");
    }
    serde_json::from_slice(&response.body).context("invalid OAuth registration")
}
pub(super) async fn post_token_form(url: &str, form: &[(&str, String)]) -> Result<TokenResponse> {
    let response = post_form(url, form).await?;
    parse_token_response(
        reqwest::StatusCode::from_u16(response.status)?,
        &response.body,
    )
}
pub(super) async fn post_form(
    url: &str,
    form: &[(&str, String)],
) -> Result<ryu_egress::GuardedResponse> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (*k, v)))
        .finish();
    request(
        "POST",
        url,
        vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        )],
        Some(body.into_bytes()),
    )
    .await
}
pub async fn request(
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
) -> Result<ryu_egress::GuardedResponse> {
    validate_oauth_url(url, true)?;
    // Test/proof-only provider fixture seam. Normal builds always use pinned
    // public egress; the explicit proof feature is never enabled by default.
    #[cfg(any(test, feature = "proof-loopback"))]
    if is_loopback_http(&Url::parse(url)?) {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()?;
        let mut builder = client.request(reqwest::Method::from_bytes(method.as_bytes())?, url);
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = body {
            builder = builder.body(body);
        }
        let mut response = builder.send().await?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > MAX_OAUTH_BODY_BYTES {
                bail!("Fixture response too large");
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(ryu_egress::GuardedResponse {
            status,
            headers,
            body,
        });
    }
    // Direct, like `mcp_transport::stream`: tokens and MCP frames must reach only
    // the screened, pinned address, never an env proxy that resolves the host.
    ryu_egress::guarded_request_direct(
        ryu_egress::GuardedRequest {
            method: method.into(),
            url: url.into(),
            headers,
            body,
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_OAUTH_BODY_BYTES as u64,
            max_redirect_hops: 0,
            timeout: Duration::from_secs(30),
        },
    )
    .await
    .map_err(|_| anyhow::anyhow!("OAuth upstream request failed"))
}
/// Scopes to request at consent. The challenge's scopes win; otherwise the
/// protected resource's own `scopes_supported` (as MCP authorization directs).
/// The authorization server's list is server-wide and often names unrelated or
/// administrative scopes, so it is used only when the resource publishes none.
/// `offline_access` grants no resource authority; it only lets providers that
/// gate refresh tokens on it issue one, so it is kept from the server's list
/// whenever the request is not a step-up challenge.
pub(super) fn consent_scopes(
    challenge: Vec<String>,
    resource_supported: &[String],
    server_supported: &[String],
) -> Vec<String> {
    let from_challenge = !challenge.is_empty();
    let mut chosen: std::collections::BTreeSet<String> = if from_challenge {
        challenge.into_iter().collect()
    } else if !resource_supported.is_empty() {
        resource_supported.iter().cloned().collect()
    } else {
        server_supported.iter().cloned().collect()
    };
    if !from_challenge
        && server_supported
            .iter()
            .any(|scope| scope == OFFLINE_ACCESS_SCOPE)
    {
        chosen.insert(OFFLINE_ACCESS_SCOPE.to_owned());
    }
    chosen.into_iter().collect()
}
pub(super) const OFFLINE_ACCESS_SCOPE: &str = "offline_access";
pub(super) fn parse_token_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
) -> Result<TokenResponse> {
    let mut token: TokenResponse = serde_json::from_slice(bytes).unwrap_or(TokenResponse {
        access_token: String::new(),
        refresh_token: None,
        id_token: None,
        token_type: None,
        expires_in: None,
        scope: None,
        error: Some(format!("http_{status}")),
        error_description: None,
    });
    if !status.is_success() && token.error.is_none() {
        token.error = Some(format!("http_{status}"));
    }
    Ok(token)
}

pub(super) async fn post_form_empty(url: &str, form: &[(&str, String)]) -> Result<()> {
    let response = post_form(url, form).await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth revocation request failed");
    }
    Ok(())
}
pub fn connection_key(profile: &str, plugin: &str, server: &str) -> String {
    format!("{profile}:{plugin}:{server}")
}

pub(super) fn validate_oauth_url(value: &str, allow_resource_query: bool) -> Result<Url> {
    let parsed = Url::parse(value).context("invalid OAuth URL")?;
    if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some() {
        bail!("OAuth URL must not contain userinfo or a fragment");
    }
    if !allow_resource_query && parsed.query().is_some() {
        bail!("OAuth metadata endpoint URL must not contain a query");
    }
    if parsed.scheme() == "https" || is_loopback_http(&parsed) {
        return Ok(parsed);
    }
    bail!("OAuth URL must use HTTPS (HTTP is allowed only on loopback)")
}

pub(super) fn is_loopback_http(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}

pub(super) fn bearer_parameter(challenge: &str, key: &str) -> Option<String> {
    let bearer = challenge
        .split_once(' ')
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))?
        .1;
    for parameter in bearer.split(',') {
        let (name, value) = parameter.trim().split_once('=')?;
        if name.trim().eq_ignore_ascii_case(key) {
            return Some(value.trim().trim_matches('"').to_owned());
        }
    }
    None
}

pub(super) fn split_scopes(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::to_owned)
        .filter(|scope| !scope.is_empty())
        .collect()
}

pub(super) fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
}

pub(super) fn trim_trailing_slash(value: &str) -> &str {
    value.trim_end_matches('/')
}

pub(super) fn sanitize_oauth_error_code(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(64)
        .collect();
    if sanitized.is_empty() {
        "request_denied".to_owned()
    } else {
        sanitized
    }
}
