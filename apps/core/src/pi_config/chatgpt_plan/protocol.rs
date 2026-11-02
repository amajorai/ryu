//! The OpenAI protocol half of Sign in with ChatGPT: discovery, token
//! responses, identity verification, refresh and revocation.

use super::*;

pub(super) fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

pub(super) async fn response_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T> {
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read OpenAI authorization response")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_AUTH_BYTES {
            bail!("OpenAI authorization response is too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let raw = value["error"]
            .as_str()
            .or_else(|| value["error"]["code"].as_str());
        let code = match raw {
            Some("invalid_grant") => Some("invalid_grant"),
            Some("invalid_client") => Some("invalid_client"),
            Some("invalid_refresh_token") => Some("invalid_refresh_token"),
            Some("token_expired") => Some("token_expired"),
            Some("refresh_token_expired") => Some("refresh_token_expired"),
            Some("refresh_token_invalidated") => Some("refresh_token_invalidated"),
            Some("refresh_token_reused") => Some("refresh_token_reused"),
            _ => None,
        };
        return Err(anyhow!(OAuthFailure {
            status: status.as_u16(),
            code
        }));
    }
    serde_json::from_slice(&bytes).context("OpenAI authorization response is invalid")
}

pub(super) async fn endpoints(client: &reqwest::Client) -> Result<Endpoints> {
    let endpoints: Endpoints = response_json(client.get(DISCOVERY).send().await?).await?;
    if endpoints.issuer != ISSUER {
        bail!("OpenAI discovery returned an unexpected issuer");
    }
    for endpoint in [
        &endpoints.authorization_endpoint,
        &endpoints.token_endpoint,
        &endpoints.jwks_uri,
        &endpoints.revocation_endpoint,
    ] {
        let url = reqwest::Url::parse(endpoint)?;
        if url.scheme() != "https"
            || url.host_str() != Some("auth.openai.com")
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("OpenAI discovery returned an untrusted endpoint");
        }
    }
    Ok(endpoints)
}

pub(super) fn verify_identity(
    token: &str,
    keys: &JwkSet,
    client_id: &str,
    nonce: Option<&str>,
    subject: Option<&str>,
) -> Result<IdentityClaims> {
    if token.len() > 64 * 1024 {
        bail!("OpenAI ID token is too large");
    }
    let header = decode_header(token).context("OpenAI ID token header is invalid")?;
    if header.alg != Algorithm::RS256 {
        bail!("OpenAI ID token uses an unsupported algorithm");
    }
    let kid = header
        .kid
        .as_deref()
        .filter(|kid| !kid.is_empty() && kid.len() <= 256)
        .context("OpenAI ID token has no signing key ID")?;
    let jwk = keys
        .find(kid)
        .context("OpenAI ID token signing key is unavailable")?;
    let key = DecodingKey::from_jwk(jwk).context("OpenAI signing key is invalid")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.required_spec_claims = ["exp", "iss", "aud", "sub"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.leeway = 5;
    validation.validate_nbf = true;
    let claims: IdentityClaims = decode(token, &key, &validation)
        .context("OpenAI ID token verification failed")?
        .claims;
    if claims.sub.is_empty()
        || claims.sub.len() > 1024
        || claims.iat > now_seconds()?.saturating_add(5)
        || claims.exp <= claims.iat
        || nonce.is_some_and(|expected| claims.nonce.as_deref() != Some(expected))
        || subject.is_some_and(|expected| claims.sub != expected)
    {
        bail!("OpenAI account identity could not be verified");
    }
    Ok(claims)
}

pub(super) async fn signing_keys(
    client: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<JwkSet> {
    let keys: JwkSet = response_json(client.get(&endpoints.jwks_uri).send().await?).await?;
    if keys.keys.is_empty() || keys.keys.len() > 64 {
        bail!("OpenAI signing key set is invalid");
    }
    Ok(keys)
}

pub(super) fn credential(
    tokens: TokenResponse,
    identity: IdentityClaims,
    client_id: String,
    host_id: String,
    retained_id_token: Option<String>,
    retained_scopes: Option<Vec<String>>,
) -> Result<StoredAccount> {
    let scopes = match tokens.scope {
        Some(scope) if scope.len() <= 4096 => scope.split_whitespace().map(str::to_owned).collect(),
        Some(_) => bail!("OpenAI returned an invalid scope list"),
        None => retained_scopes.unwrap_or_default(),
    };
    let id_token = tokens
        .id_token
        .or(retained_id_token)
        .context("OpenAI did not return an ID token")?;
    let email = identity.email.filter(|email| {
        identity.email_verified == Some(true)
            && email.len() <= 320
            && !email.chars().any(char::is_control)
    });
    if tokens
        .refresh_token
        .as_deref()
        .is_some_and(|value| value.is_empty() || value.len() > 64 * 1024)
    {
        bail!("OpenAI returned an invalid refresh token");
    }
    let plan_authorized = ["resource.invoke", "chatgpt.tokens.use.direct"]
        .iter()
        .all(|required| scopes.iter().any(|scope| scope == required));
    if !plan_authorized {
        return Ok(StoredAccount::IdentityOnly(IdentityConnection {
            registration: Registration {
                kind: "oauth".to_owned(),
                flow: "chatgpt-plan".to_owned(),
                client_id,
                host_id,
                issuer: ISSUER.to_owned(),
                subject: identity.sub,
                email,
            },
            id_token,
            refresh: tokens.refresh_token,
            scopes,
        }));
    }
    let access = tokens
        .access_token
        .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
        .context("OpenAI returned no usable access token")?;
    if !tokens
        .token_type
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
        || scopes.iter().any(|scope| scope == "offline_access") && tokens.refresh_token.is_none()
    {
        bail!("OpenAI returned an invalid renewable token set");
    }
    let expires_in = tokens
        .expires_in
        .filter(|seconds| *seconds > 0 && *seconds <= 86_400)
        .context("OpenAI token expiry is invalid")?;
    let expires = now_seconds()?
        .checked_add(expires_in)
        .and_then(|value| value.checked_mul(1000))
        .context("OpenAI token expiry is invalid")?;
    Ok(StoredAccount::Connected(Credential {
        kind: "oauth".to_owned(),
        flow: "chatgpt-plan".to_owned(),
        access,
        refresh: tokens.refresh_token,
        expires,
        client_id,
        host_id,
        issuer: ISSUER.to_owned(),
        subject: identity.sub,
        id_token,
        email,
        scopes,
    }))
}

pub async fn refresh(existing: Credential) -> Result<StoredAccount> {
    let client = http_client()?;
    let endpoints = endpoints(&client).await?;
    let tokens: TokenResponse = response_json(
        client
            .post(&endpoints.token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", existing.client_id.as_str()),
                (
                    "refresh_token",
                    existing
                        .refresh
                        .as_deref()
                        .context("Reconnect this non-renewable ChatGPT session")?,
                ),
                ("resource", RESOURCE),
            ])
            .send()
            .await?,
    )
    .await?;
    let identity = if let Some(token) = &tokens.id_token {
        let keys = signing_keys(&client, &endpoints).await?;
        verify_identity(
            token,
            &keys,
            &existing.client_id,
            None,
            Some(&existing.subject),
        )?
    } else {
        IdentityClaims {
            sub: existing.subject.clone(),
            exp: u64::MAX,
            iat: 0,
            nonce: None,
            email: existing.email.clone(),
            email_verified: Some(true),
        }
    };
    credential(
        tokens,
        identity,
        existing.client_id,
        existing.host_id,
        Some(existing.id_token),
        Some(existing.scopes),
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RevocationStatus {
    Confirmed,
    NotRequired,
    Unconfirmed,
}

/// Revocation ends a renewable session; it does not delete the registered app.
pub async fn revoke(existing: &StoredAccount) -> Result<RevocationStatus> {
    let refresh = match existing {
        StoredAccount::Connected(credential) => credential.refresh.as_deref(),
        StoredAccount::IdentityOnly(identity) => identity.refresh.as_deref(),
        StoredAccount::Disconnected(_) => None,
    };
    let Some(refresh) = refresh else {
        return Ok(RevocationStatus::NotRequired);
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let endpoints = endpoints(&client).await?;
    for attempt in 0..3 {
        let response = client
            .post(&endpoints.revocation_endpoint)
            .form(&[
                ("token", refresh),
                ("token_type_hint", "refresh_token"),
                ("client_id", existing.client_id()),
            ])
            .send()
            .await;
        match response {
            Ok(response) if response.status() == StatusCode::OK => {
                return Ok(RevocationStatus::Confirmed)
            }
            Ok(response) if !response.status().is_server_error() => {
                return Ok(RevocationStatus::Unconfirmed)
            }
            _ => {}
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
        }
    }
    Ok(RevocationStatus::Unconfirmed)
}
