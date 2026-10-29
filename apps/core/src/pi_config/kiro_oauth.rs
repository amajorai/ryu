//! Kiro-owned OAuth credentials. No CLI/browser credential stores are read.
//! Wire contracts: 9Router 4a57df8 Kiro registry and OAuth service.

use std::time::Duration;

use anyhow::Result;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

use super::accounts::RefreshFailure;

const DEFAULT_REGION: &str = "us-east-1";
const SOCIAL_REFRESH: &str = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const RESPONSE_LIMIT: usize = 64 * 1024;

struct Endpoints {
    oidc: String,
    social: String,
    profiles: String,
}

impl Endpoints {
    fn for_region(region: &str) -> std::result::Result<Self, RefreshFailure> {
        let parts: Vec<_> = region.split('-').collect();
        if region.len() > 32
            || parts.len() != 3
            || parts[0].len() != 2
            || !parts[0].bytes().all(|byte| byte.is_ascii_lowercase())
            || parts[1].is_empty()
            || !parts[1].bytes().all(|byte| byte.is_ascii_lowercase())
            || !(1..=2).contains(&parts[2].len())
            || !parts[2].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(RefreshFailure::Uncertain);
        }
        Ok(Self {
            oidc: format!("https://oidc.{region}.amazonaws.com"),
            social: SOCIAL_REFRESH.into(),
            profiles: format!("https://codewhisperer.{region}.amazonaws.com"),
        })
    }
}

fn client() -> std::result::Result<Client, RefreshFailure> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| RefreshFailure::Transient)
}

/// Only these two public values are authorization instructions. The AWS device
/// token, refresh client secret, and all token responses stay private.
pub struct DeviceAttempt {
    pub auth_url: String,
    pub device_code: String,
    credential: Value,
    poll_code: String,
    interval: Duration,
    deadline: tokio::time::Instant,
    client: Client,
    endpoints: Endpoints,
}

pub async fn begin() -> Result<DeviceAttempt> {
    Ok(begin_with(client()?, Endpoints::for_region(DEFAULT_REGION)?).await?)
}

async fn begin_with(
    client: Client,
    endpoints: Endpoints,
) -> std::result::Result<DeviceAttempt, RefreshFailure> {
    let registration = post(&client, &format!("{}/client/register", endpoints.oidc), json!({
        "clientName":"kiro-oauth-client", "clientType":"public",
        "scopes":["codewhisperer:completions","codewhisperer:analysis","codewhisperer:conversations"],
        "grantTypes":[DEVICE_GRANT,"refresh_token"],
        "issuerUrl":"https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6"
    })).await?;
    require_success(&registration)?;
    let client_id = required(&registration.1, "clientId")?.to_owned();
    let client_secret = required(&registration.1, "clientSecret")?.to_owned();
    let authorization = post(&client, &format!("{}/device_authorization", endpoints.oidc), json!({
        "clientId":client_id,"clientSecret":client_secret,"startUrl":"https://view.awsapps.com/start"
    })).await?;
    require_success(&authorization)?;
    let response = authorization.1;
    let auth_url = response
        .get("verificationUriComplete")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| response.get("verificationUri").and_then(Value::as_str))
        .ok_or(RefreshFailure::Uncertain)?
        .to_owned();
    let parsed = reqwest::Url::parse(&auth_url).map_err(|_| RefreshFailure::Uncertain)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(RefreshFailure::Uncertain);
    }
    let lifetime = lifetime(&response)?;
    let interval = response
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 60);
    Ok(DeviceAttempt {
        auth_url,
        device_code: required(&response, "userCode")?.to_owned(),
        poll_code: required(&response, "deviceCode")?.to_owned(),
        credential: json!({"type":"oauth","region":DEFAULT_REGION,"authMethod":"builder-id", "clientId":client_id,"clientSecret":client_secret}),
        interval: Duration::from_secs(interval),
        deadline: tokio::time::Instant::now() + Duration::from_secs(lifetime.min(900)),
        client,
        endpoints,
    })
}

impl DeviceAttempt {
    pub async fn complete(mut self) -> std::result::Result<Value, RefreshFailure> {
        loop {
            if tokio::time::Instant::now() + self.interval >= self.deadline {
                return Err(RefreshFailure::Revoked);
            }
            tokio::time::sleep(self.interval).await;
            let result = post(&self.client,&format!("{}/token",self.endpoints.oidc),json!({
                "clientId":self.credential["clientId"],"clientSecret":self.credential["clientSecret"],
                "deviceCode":self.poll_code,"grantType":DEVICE_GRANT
            })).await?;
            match result.1.get("error").and_then(Value::as_str) {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    self.interval =
                        (self.interval + Duration::from_secs(5)).min(Duration::from_secs(60));
                    continue;
                }
                _ => {}
            }
            require_success(&result)?;
            let mut credential = merge_tokens(self.credential, &result.1)?;
            required(&credential, "refresh")?;
            if credential.get("profileArn").is_none() {
                let profiles = read_response(
                    self.client
                        .post(&self.endpoints.profiles)
                        .header("Content-Type", "application/x-amz-json-1.0")
                        .header(
                            "x-amz-target",
                            "AmazonCodeWhispererService.ListAvailableProfiles",
                        )
                        .bearer_auth(required(&credential, "access")?)
                        .json(&json!({"maxResults":10})),
                )
                .await?;
                require_success(&profiles)?;
                if let Some(profile) = selected_profile(&profiles.1, DEFAULT_REGION) {
                    credential["profileArn"] = json!(profile);
                }
            }
            return Ok(credential);
        }
    }
}

fn selected_profile(response: &Value, region: &str) -> Option<String> {
    let profiles = response.get("profiles")?.as_array()?;
    let valid = |value: &Value| {
        value
            .get("arn")
            .or_else(|| value.get("profileArn"))
            .and_then(Value::as_str)
            .filter(|arn| {
                arn.starts_with("arn:") && arn.len() <= 2048 && !arn.chars().any(char::is_control)
            })
            .map(str::to_owned)
    };
    profiles
        .iter()
        .filter_map(valid)
        .find(|arn| arn.split(':').nth(3) == Some(region))
        .or_else(|| profiles.iter().find_map(valid))
}

/// A single refresh exchange. Ambiguous delivery never retries a rotating token.
pub async fn refresh(credential: Value) -> std::result::Result<Value, RefreshFailure> {
    let region = credential
        .get("region")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_REGION);
    let endpoints = Endpoints::for_region(region)?;
    refresh_with(&client()?, &endpoints, credential).await
}

async fn refresh_with(
    client: &Client,
    endpoints: &Endpoints,
    credential: Value,
) -> std::result::Result<Value, RefreshFailure> {
    if credential.get("type").and_then(Value::as_str) != Some("oauth") {
        return Err(RefreshFailure::Uncertain);
    }
    let token = required(&credential, "refresh")?;
    let method = required(&credential, "authMethod")?;
    let (url, body) = match method {
        "builder-id" | "idc" => (
            format!("{}/token", endpoints.oidc),
            json!({
                "clientId":required(&credential,"clientId")?,"clientSecret":required(&credential,"clientSecret")?,
                "refreshToken":token,"grantType":"refresh_token"
            }),
        ),
        "google" | "github" | "social" | "import" | "imported" => {
            if credential.get("clientId").is_some() || credential.get("clientSecret").is_some() {
                return Err(RefreshFailure::Uncertain);
            }
            (endpoints.social.clone(), json!({"refreshToken":token}))
        }
        _ => return Err(RefreshFailure::Uncertain),
    };
    let response = post(client, &url, body).await?;
    require_success(&response)?;
    merge_tokens(credential, &response.1)
}

fn required<'a>(value: &'a Value, field: &str) -> std::result::Result<&'a str, RefreshFailure> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| {
            !text.is_empty() && text.len() <= 16 * 1024 && !text.chars().any(char::is_control)
        })
        .ok_or(RefreshFailure::Uncertain)
}

fn lifetime(value: &Value) -> std::result::Result<u64, RefreshFailure> {
    value
        .get("expiresIn")
        .and_then(Value::as_u64)
        .filter(|seconds| (1..=31_536_000).contains(seconds))
        .ok_or(RefreshFailure::Uncertain)
}

fn merge_tokens(
    mut credential: Value,
    response: &Value,
) -> std::result::Result<Value, RefreshFailure> {
    let access = required(response, "accessToken")?;
    let expiry = super::now_unix()
        .checked_add(lifetime(response)?)
        .and_then(|expiry| expiry.checked_mul(1000))
        .ok_or(RefreshFailure::Uncertain)?;
    let object = credential
        .as_object_mut()
        .ok_or(RefreshFailure::Uncertain)?;
    object.insert("access".into(), json!(access));
    object.insert("expires".into(), json!(expiry));
    if response.get("refreshToken").is_some() {
        object.insert("refresh".into(), json!(required(response, "refreshToken")?));
    }
    if response
        .get("profileArn")
        .is_some_and(|value| !value.is_null())
    {
        object.insert(
            "profileArn".into(),
            json!(required(response, "profileArn")?),
        );
    }
    Ok(credential)
}

fn require_success(response: &(StatusCode, Value)) -> std::result::Result<(), RefreshFailure> {
    if response.0.is_success() && response.1.get("error").is_none() {
        return Ok(());
    }
    match response.1.get("error").and_then(Value::as_str) {
        Some("invalid_grant" | "invalid_token" | "expired_token" | "access_denied") => {
            Err(RefreshFailure::Revoked)
        }
        _ if response.0 == StatusCode::TOO_MANY_REQUESTS
            || response.0 == StatusCode::SERVICE_UNAVAILABLE =>
        {
            Err(RefreshFailure::Transient)
        }
        _ => Err(RefreshFailure::Uncertain),
    }
}

async fn post(
    client: &Client,
    url: &str,
    body: Value,
) -> std::result::Result<(StatusCode, Value), RefreshFailure> {
    read_response(client.post(url).json(&body)).await
}

async fn read_response(
    request: reqwest::RequestBuilder,
) -> std::result::Result<(StatusCode, Value), RefreshFailure> {
    let response = request.send().await.map_err(|error| {
        if error.is_connect() {
            RefreshFailure::Transient
        } else {
            RefreshFailure::Uncertain
        }
    })?;
    let status = response.status();
    let mut chunks = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| RefreshFailure::Uncertain)?;
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(RefreshFailure::Uncertain);
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| {
        if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
            RefreshFailure::Transient
        } else {
            RefreshFailure::Uncertain
        }
    })?;
    Ok((status, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{HeaderMap, Uri},
        response::IntoResponse,
        Router,
    };
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    async fn fixture(
        replies: Vec<(StatusCode, String)>,
    ) -> (
        Endpoints,
        Arc<Mutex<Vec<Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&captured);
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let redirect = format!("{base}/redirected");
        let app=Router::new().fallback(move |uri:Uri,headers:HeaderMap,body:Bytes| {
            let seen=Arc::clone(&seen);
            let replies=Arc::clone(&replies);
            let redirect=redirect.clone();
            async move {
                let body: Value = serde_json::from_slice(&body).expect("actual request is valid JSON under its native content type");
                seen.lock().unwrap().push(json!({"path":uri.path(),"body":body,
                    "contentType":headers.get("content-type").and_then(|value|value.to_str().ok()),
                    "authorization":headers.get("authorization").and_then(|value|value.to_str().ok()),
                    "target":headers.get("x-amz-target").and_then(|value|value.to_str().ok())}));
                let (status,body)=replies.lock().unwrap().pop_front().expect("expected one upstream request");
                (status,[("location",redirect)],body).into_response()
            }
        });
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            Endpoints {
                oidc: base.clone(),
                social: format!("{base}/refreshToken"),
                profiles: format!("{base}/profiles"),
            },
            captured,
            server,
        )
    }

    fn reply(status: StatusCode, value: Value) -> (StatusCode, String) {
        (status, value.to_string())
    }

    fn builder_credential() -> Value {
        json!({"type":"oauth","access":"old-access","refresh":"old-refresh","expires":1,
            "region":"us-east-1","authMethod":"builder-id","clientId":"fixture-client","clientSecret":"fixture-secret",
            "profileArn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture"})
    }

    fn begin_replies() -> Vec<(StatusCode, String)> {
        vec![
            reply(
                StatusCode::OK,
                json!({"clientId":"fixture-client","clientSecret":"fixture-secret"}),
            ),
            reply(
                StatusCode::OK,
                json!({"deviceCode":"private-device-token","userCode":"DISPLAY-CODE",
                "verificationUriComplete":"https://view.awsapps.com/start#device","expiresIn":600,"interval":1}),
            ),
        ]
    }

    #[tokio::test]
    async fn kiro_device_flow_handles_pending_slowdown_and_discovers_only_returned_profile() {
        let mut replies = begin_replies();
        replies.extend([
            reply(StatusCode::BAD_REQUEST,json!({"error":"authorization_pending"})),
            reply(StatusCode::BAD_REQUEST,json!({"error":"slow_down"})),
            reply(StatusCode::OK,json!({"accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600})),
            reply(StatusCode::OK,json!({"profiles":[{"arn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/actual"}]})),
        ]);
        let (endpoints, captured, server) = fixture(replies).await;
        let mut attempt = begin_with(client().unwrap(), endpoints).await.unwrap();
        assert_eq!(attempt.device_code, "DISPLAY-CODE");
        assert!(!attempt.auth_url.contains("private-device-token"));
        attempt.interval = Duration::ZERO;
        let credential = tokio::time::timeout(Duration::from_secs(20), attempt.complete())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(credential["access"], "new-access");
        assert_eq!(credential["refresh"], "new-refresh");
        assert_eq!(credential["clientSecret"], "fixture-secret");
        assert!(credential["expires"].as_u64().unwrap() > super::super::now_unix() * 1000);
        assert_eq!(
            credential["profileArn"],
            "arn:aws:codewhisperer:us-east-1:123456789012:profile/actual"
        );
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert_eq!(requests[0]["body"]["clientType"], "public");
        assert_eq!(
            requests[1]["body"]["startUrl"],
            "https://view.awsapps.com/start"
        );
        assert_eq!(requests[2]["body"]["deviceCode"], "private-device-token");
        assert_eq!(requests[5]["authorization"], "Bearer new-access");
        assert_eq!(requests[5]["contentType"], "application/x-amz-json-1.0");
        assert_eq!(
            requests[5]["target"],
            "AmazonCodeWhispererService.ListAvailableProfiles"
        );
        server.abort();
    }

    #[tokio::test]
    async fn kiro_device_flow_never_invents_a_missing_profile() {
        let mut replies = begin_replies();
        replies.extend([
            reply(
                StatusCode::OK,
                json!({"accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600}),
            ),
            reply(StatusCode::OK, json!({"profiles":[]})),
        ]);
        let (endpoints, _, server) = fixture(replies).await;
        let mut attempt = begin_with(client().unwrap(), endpoints).await.unwrap();
        attempt.interval = Duration::ZERO;
        let credential = attempt.complete().await.unwrap();
        assert!(credential.get("profileArn").is_none());
        server.abort();
    }

    #[tokio::test]
    async fn kiro_refresh_uses_captured_auth_method_and_preserves_rotation_metadata() {
        for method in ["builder-id", "google"] {
            let (endpoints, captured, server) = fixture(vec![reply(
                StatusCode::OK,
                json!({"accessToken":"rotated-access","expiresIn":3600}),
            )])
            .await;
            let mut credential = builder_credential();
            credential["authMethod"] = json!(method);
            if method == "google" {
                credential.as_object_mut().unwrap().remove("clientId");
                credential.as_object_mut().unwrap().remove("clientSecret");
            }
            let renewed = refresh_with(&client().unwrap(), &endpoints, credential.clone())
                .await
                .unwrap();
            assert_eq!(renewed["access"], "rotated-access");
            assert_eq!(renewed["refresh"], credential["refresh"]);
            assert_eq!(renewed["profileArn"], credential["profileArn"]);
            assert_eq!(renewed["authMethod"], credential["authMethod"]);
            let requests = captured.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0]["path"],
                if method == "google" {
                    "/refreshToken"
                } else {
                    "/token"
                }
            );
            assert_eq!(requests[0]["body"]["refreshToken"], "old-refresh");
            assert_eq!(
                requests[0]["body"].get("clientSecret").is_some(),
                method == "builder-id"
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn kiro_refresh_failures_are_redacted_and_never_replayed_or_redirected() {
        for (status, body, expected) in [
            (
                StatusCode::BAD_REQUEST,
                json!({"error":"invalid_grant","error_description":"fixture-secret"}).to_string(),
                RefreshFailure::Revoked,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "fixture-secret".into(),
                RefreshFailure::Transient,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "fixture-secret".into(),
                RefreshFailure::Transient,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error":"unknown_failure","error_description":"fixture-secret"}).to_string(),
                RefreshFailure::Uncertain,
            ),
            (
                StatusCode::BAD_GATEWAY,
                "fixture-secret".into(),
                RefreshFailure::Uncertain,
            ),
            (
                StatusCode::OK,
                "fixture-secret invalid json".into(),
                RefreshFailure::Uncertain,
            ),
            (StatusCode::FOUND, "{}".into(), RefreshFailure::Uncertain),
            (
                StatusCode::OK,
                "x".repeat(RESPONSE_LIMIT + 1),
                RefreshFailure::Uncertain,
            ),
        ] {
            let (endpoints, captured, server) = fixture(vec![(status, body)]).await;
            let failure = refresh_with(&client().unwrap(), &endpoints, builder_credential())
                .await
                .unwrap_err();
            assert_eq!(failure, expected);
            assert!(!failure.to_string().contains("fixture-secret"));
            assert_eq!(captured.lock().unwrap().len(), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn kiro_invalid_credential_and_region_are_rejected_before_egress() {
        for region in [
            "us-east-1.attacker.test",
            "https://127.0.0.1",
            "US-east-1",
            "us-east-1/path",
        ] {
            assert_eq!(
                Endpoints::for_region(region).err(),
                Some(RefreshFailure::Uncertain)
            );
        }
        let (endpoints, captured, server) = fixture(vec![]).await;
        let mut credential = builder_credential();
        credential.as_object_mut().unwrap().remove("clientSecret");
        assert_eq!(
            refresh_with(&client().unwrap(), &endpoints, credential)
                .await
                .unwrap_err(),
            RefreshFailure::Uncertain
        );
        assert!(captured.lock().unwrap().is_empty());
        server.abort();
    }
}
