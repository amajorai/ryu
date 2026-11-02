//! Authorization-server discovery and the MCP authentication challenge.

use super::*;

pub(super) fn scrub_flow_secrets(flow: &mut PendingFlow) {
    flow.verifier.clear();
    flow.state.clear();
    flow.client_secret = None;
}

pub(super) async fn open_bundle(
    store: &crate::IdentityStore,
    connection: &McpOAuthConnectionRecord,
) -> Result<TokenBundle> {
    let secret = store
        .open_mcp_oauth_state(&connection.id)
        .await?
        .context("MCP OAuth connection has no token state")?;
    serde_json::from_str(secret.expose()).context("opening MCP OAuth token bundle")
}

pub(super) async fn oauth_challenge(
    resource: &Url,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>> {
    let response = request("POST", resource.as_str(), headers.iter().map(|(k,v)|(k.clone(),v.clone())).chain([
        ("content-type".into(),"application/json".into()), ("accept".into(),"application/json, text/event-stream".into())
    ]).collect(), Some(br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Ryu","version":"1"}}}"#.to_vec())).await?;
    if matches!(response.status, 400 | 404 | 405 | 501) {
        let mut get_headers: Vec<_> = headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        get_headers.push(("accept".into(), "text/event-stream".into()));
        let response = crate::mcp_transport::stream(resource.as_str(), &get_headers).await?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            bail!("MCP server did not request OAuth authentication");
        }
        let challenge = response
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        return checked_challenge(challenge, headers);
    }
    if response.status != 401 {
        bail!("MCP server did not request OAuth authentication");
    }
    checked_challenge(
        response
            .headers
            .into_iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("www-authenticate"))
            .map(|(_, v)| v),
        headers,
    )
}

pub(super) fn checked_challenge(
    challenge: Option<String>,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>> {
    if let Some(value) = &challenge {
        for secret in headers.values().filter(|v| !v.is_empty()) {
            let escaped = serde_json::to_string(secret)?;
            if value.contains(secret) || value.contains(escaped.trim_matches('"')) {
                bail!("MCP challenge reflected a configured header value");
            }
        }
    }
    Ok(challenge)
}

pub(super) async fn discover_authorization_server(
    issuer: &Url,
) -> Result<AuthorizationServerMetadata> {
    let oauth_url = authorization_server_metadata_url(issuer, "oauth-authorization-server");
    if let Ok(metadata) = get_json::<AuthorizationServerMetadata>(oauth_url.as_str()).await {
        return Ok(metadata);
    }
    let oidc_url = authorization_server_metadata_url(issuer, "openid-configuration");
    if let Ok(metadata) = get_json::<AuthorizationServerMetadata>(oidc_url.as_str()).await {
        return Ok(metadata);
    }
    let mut appended = issuer.clone();
    let path = issuer.path().trim_end_matches('/');
    appended.set_path(&format!("{path}/.well-known/openid-configuration"));
    appended.set_query(None);
    appended.set_fragment(None);
    get_json(appended.as_str()).await
}

pub(super) fn authorization_server_metadata_url(issuer: &Url, suffix: &str) -> Url {
    let mut url = issuer.clone();
    let issuer_path = issuer.path().trim_matches('/');
    url.set_path(&format!(
        "/.well-known/{suffix}{}",
        if issuer_path.is_empty() {
            String::new()
        } else {
            format!("/{issuer_path}")
        }
    ));
    url.set_query(None);
    url.set_fragment(None);
    url
}

pub(super) fn validate_server_metadata_endpoints(
    issuer: &Url,
    metadata: &AuthorizationServerMetadata,
) -> Result<()> {
    let endpoints = [
        Some(metadata.authorization_endpoint.as_str()),
        Some(metadata.token_endpoint.as_str()),
        metadata.registration_endpoint.as_deref(),
        metadata.revocation_endpoint.as_deref(),
    ];
    for endpoint in endpoints.into_iter().flatten() {
        let endpoint = validate_oauth_url(endpoint, false)?;
        if endpoint.origin() != issuer.origin() {
            bail!("authorization-server endpoint origin does not match its issuer");
        }
    }
    Ok(())
}

pub(super) fn protected_resource_metadata_url(resource: &Url) -> Url {
    let mut url = resource.clone();
    let path = resource.path().trim_matches('/');
    url.set_path(&format!(
        "/.well-known/oauth-protected-resource{}",
        if path.is_empty() {
            String::new()
        } else {
            format!("/{path}")
        }
    ));
    url.set_query(None);
    url.set_fragment(None);
    url
}
