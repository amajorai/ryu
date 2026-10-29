//! Protected local Kiro relay. Core owns renewable credentials and durable affinity.
use crate::pi_config::accounts::{AccountVault, KIND_OAUTH, KIND_OPAQUE};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use ryu_gw_providers::{
    KiroAccount, KiroAuthMethod, KiroProvider, Provider, ProviderError, ProviderQuotas,
    STREAM_READ_TIMEOUT, STREAM_TOTAL_TIMEOUT,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Total deadline for a non-streamed Kiro completion or model listing, the
/// same bound Gateway provider clients keep for non-streamed calls.
const KIRO_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const KIRO_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const AFFINITY_SCOPE: &str = "pi:kiro-http-affinity:v1";
const AFFINITY_IDLE_MILLIS: i64 = 24 * 60 * 60 * 1000;
const MAX_SCOPE_BINDINGS: usize = 256;
static CURSOR: OnceLock<Mutex<super::oauth_pool_usage::PoolCursor>> = OnceLock::new();
static CAPTURE: Mutex<()> = Mutex::new(());

fn affinity_label(session: &str) -> String {
    // Gateway sessions contain a length-prefixed, verified caller namespace.
    // Bare ids are only available to the node owner and share the local scope.
    let scope = session
        .split_once(':')
        .and_then(|(length, rest)| {
            let length = length.parse::<usize>().ok()?;
            rest.get(..length).filter(|scope| !scope.is_empty())
        })
        .unwrap_or("local");
    format!(
        "Kiro HTTP conversation {:x}",
        Sha256::digest(scope.as_bytes())
    )
}

fn prune_idle_bindings(
    vault: &AccountVault,
    now: i64,
) -> anyhow::Result<Vec<crate::pi_config::accounts::AccountInfo>> {
    let mut live = Vec::new();
    for binding in vault.list(AFFINITY_SCOPE)? {
        if now.saturating_sub(binding.updated_at) >= AFFINITY_IDLE_MILLIS {
            vault.remove(AFFINITY_SCOPE, &binding.account_id)?;
        } else {
            live.push(binding);
        }
    }
    Ok(live)
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({"error":{"type":"kiro_error","message":message}})),
    )
        .into_response()
}

fn selected(
    vault: &AccountVault,
    session: Option<&str>,
    policy: &super::oauth_pool_policy::Policy,
) -> Result<String, Response> {
    let _capture = CAPTURE.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Kiro account selection is unavailable",
        )
    })?;
    let scope = crate::pi_config::accounts::provider_scope("kiro");
    let live_bindings =
        prune_idle_bindings(vault, chrono::Utc::now().timestamp_millis()).map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Kiro conversation storage is unavailable",
            )
        })?;
    let accounts = vault.list(&scope).map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Kiro account storage is unavailable",
        )
    })?;
    let key = session.map(|id| format!("session-{:x}", Sha256::digest(id.as_bytes())));
    let existing = key
        .as_deref()
        .map(|key| vault.credential(AFFINITY_SCOPE, key))
        .transpose()
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Kiro conversation binding is unavailable",
            )
        })?
        .flatten();
    if let Some(binding) = existing {
        let id = binding["accountId"]
            .as_str()
            .ok_or_else(|| error(StatusCode::CONFLICT, "Kiro conversation binding is invalid"))?;
        if !policy.allowed(id)
            || !accounts.iter().any(|account| {
                account.account_id == id && account.kind == KIND_OAUTH && !account.needs_reauth
            })
        {
            return Err(error(StatusCode::CONFLICT,"The Kiro account bound to this conversation is unavailable. Sign in again or start a new conversation."));
        }
        if let (Some(key), Some(session)) = (key.as_deref(), session) {
            vault
                .upsert(
                    AFFINITY_SCOPE,
                    key,
                    &affinity_label(session),
                    KIND_OPAQUE,
                    Some(json!({"accountId":id})),
                )
                .map_err(|_| {
                    error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Kiro conversation binding could not be saved",
                    )
                })?;
        }
        return Ok(id.to_owned());
    }
    let eligible: Vec<_> = accounts
        .iter()
        .filter(|account| {
            account.kind == KIND_OAUTH
                && !account.needs_reauth
                && policy.allowed(&account.account_id)
        })
        .collect();
    let revisions: Vec<_> = eligible
        .iter()
        .map(|account| {
            vault
                .credential_revision(&scope, &account.account_id)
                .ok()
                .flatten()
                .unwrap_or_default()
        })
        .collect();
    let candidates: Vec<_> = eligible
        .iter()
        .zip(&revisions)
        .map(|(account, revision)| super::oauth_pool_usage::Candidate {
            account_id: &account.account_id,
            revision,
        })
        .collect();
    let active = accounts
        .iter()
        .find(|account| account.active)
        .map_or("", |account| account.account_id.as_str());
    let index = CURSOR
        .get_or_init(|| Mutex::new(Default::default()))
        .lock()
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Kiro account selection is unavailable",
            )
        })?
        .select("kiro", &candidates, active, policy)
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "Kiro has no enabled saved login. Sign in first.",
            )
        })?;
    let id = eligible[index].account_id.clone();
    if let Some(key) = key {
        let label = affinity_label(session.expect("key requires a session"));
        if live_bindings
            .iter()
            .filter(|binding| binding.label == label)
            .count()
            >= MAX_SCOPE_BINDINGS
        {
            return Err(error(
                StatusCode::TOO_MANY_REQUESTS,
                "Kiro caller conversation binding limit reached",
            ));
        }
        if live_bindings.len() >= 10_000 {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Kiro conversation binding limit reached",
            ));
        }
        vault
            .upsert(
                AFFINITY_SCOPE,
                &key,
                &label,
                KIND_OPAQUE,
                Some(json!({"accountId":id})),
            )
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Kiro conversation binding could not be saved",
                )
            })?;
    }
    Ok(id)
}

fn account(credential: &Value) -> Result<KiroAccount, Response> {
    let access = credential["access"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Kiro login has no access token"))?;
    let region = credential["region"].as_str().unwrap_or("us-east-1");
    let auth_method = match credential["authMethod"].as_str() {
        Some("builder-id" | "social" | "google" | "github") | None => KiroAuthMethod::OAuth,
        Some("api-key") => KiroAuthMethod::ApiKey,
        Some("external-idp") => KiroAuthMethod::ExternalIdp,
        _ => {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Unsupported Kiro authentication method",
            ))
        }
    };
    Ok(KiroAccount {
        access_token: access.to_owned(),
        region: region.to_owned(),
        profile_arn: credential["profileArn"].as_str().map(str::to_owned),
        auth_method,
        endpoint: None,
    })
}

/// Total deadline for one Kiro upstream call. A streamed completion keeps
/// going for as long as it produces output (bounded by the idle read timeout
/// and the protocol's per-chunk timeout), so it must not inherit the fixed
/// non-streamed total, which would cut a long answer off mid-stream.
fn kiro_total_timeout(stream: bool) -> Duration {
    if stream {
        STREAM_TOTAL_TIMEOUT
    } else {
        KIRO_REQUEST_TIMEOUT
    }
}

fn kiro_client(total: Duration, idle: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(KIRO_CONNECT_TIMEOUT)
        .read_timeout(idle)
        .timeout(total)
        .build()
}

async fn provider(
    session: Option<&str>,
    policy: &super::oauth_pool_policy::Policy,
    stream: bool,
) -> Result<KiroProvider, Response> {
    let vault = crate::pi_config::accounts::global().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The sealed Kiro account vault is unavailable",
        )
    })?;
    let id = selected(vault, session, policy)?;
    let credential = crate::pi_config::subscription_request_credential_for_account("kiro", &id)
        .await
        .map_err(|failure| {
            match failure.downcast_ref::<crate::pi_config::accounts::RefreshFailure>() {
                Some(crate::pi_config::accounts::RefreshFailure::Transient) => error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Kiro refresh is temporarily unavailable. Retry after the account cooldown.",
                ),
                Some(_) => error(
                    StatusCode::UNAUTHORIZED,
                    "Kiro login requires sign-in again.",
                ),
                None => error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The sealed Kiro login is unavailable.",
                ),
            }
        })?;
    let client = kiro_client(kiro_total_timeout(stream), STREAM_READ_TIMEOUT).map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Kiro transport is unavailable",
        )
    })?;
    KiroProvider::new(
        client,
        None,
        vec![account(&credential)?],
        Arc::new(ProviderQuotas::new()),
    )
    .map_err(provider_error)
}

fn provider_error(failure: ProviderError) -> Response {
    match failure {
        ProviderError::RateLimited { retry_after, .. } => {
            let mut response = error(StatusCode::TOO_MANY_REQUESTS, "Kiro reported a rate limit");
            if let Some(seconds) = retry_after {
                if let Ok(value) = seconds.to_string().parse() {
                    response.headers_mut().insert("retry-after", value);
                }
            }
            response
        }
        ProviderError::DeliveryUncertain(_) | ProviderError::Transport(_) => {
            let mut response = error(
                StatusCode::BAD_GATEWAY,
                "Kiro request delivery is uncertain; the request was not replayed",
            );
            response.headers_mut().insert(
                "x-ryu-delivery-uncertain",
                "true".parse().expect("static header"),
            );
            response
        }
        _ => error(
            StatusCode::BAD_GATEWAY,
            "Kiro rejected the request or returned an invalid response",
        ),
    }
}

pub async fn completions(
    State(state): State<super::ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(model) = body["model"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 1024)
    else {
        return error(StatusCode::BAD_REQUEST, "Choose an exact Kiro model ID");
    };
    let session = headers
        .get("x-ryu-session-id")
        .and_then(|value| value.to_str().ok());
    if session.is_some_and(|id| {
        id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) || id.starts_with('$')
    }) {
        return error(StatusCode::BAD_REQUEST, "Invalid Kiro conversation ID");
    }
    let policy = super::oauth_pool_policy::load(&state.preferences, "kiro").await;
    let stream = body["stream"].as_bool() == Some(true);
    let provider = match provider(session, &policy, stream).await {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    if stream {
        match provider
            .complete_stream_for_session(model, &body, session)
            .await
        {
            Ok(body) => (
                [
                    ("content-type", "text/event-stream"),
                    ("cache-control", "no-cache"),
                ],
                body,
            )
                .into_response(),
            Err(failure) => provider_error(failure),
        }
    } else {
        match provider.complete_for_session(model, &body, session).await {
            Ok(value) => Json(value).into_response(),
            Err(failure) => provider_error(failure),
        }
    }
}

pub async fn discover_models() -> Result<Vec<Value>, Response> {
    let provider = provider(None, &Default::default(), false).await?;
    provider.discover_models().await.ok_or_else(|| {
        error(
            StatusCode::BAD_GATEWAY,
            "Kiro model discovery is unavailable",
        )
    })
}

pub async fn models(State(state): State<super::ServerState>) -> Response {
    let policy = super::oauth_pool_policy::load(&state.preferences, "kiro").await;
    let provider = match provider(None, &policy, false).await {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    match provider.discover_models().await {
        Some(models) => Json(json!({"object":"list","data":models})).into_response(),
        None => error(
            StatusCode::BAD_GATEWAY,
            "Kiro model discovery is unavailable",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiro_streams_do_not_inherit_the_non_streamed_total() {
        assert_eq!(kiro_total_timeout(true), STREAM_TOTAL_TIMEOUT);
        assert_eq!(kiro_total_timeout(false), KIRO_REQUEST_TIMEOUT);
        assert!(STREAM_TOTAL_TIMEOUT > KIRO_REQUEST_TIMEOUT);
    }

    /// The client applies `total` to the whole response, body included, and
    /// the idle bound only between reads: a body that keeps arriving outlives
    /// the idle bound, while the same body is cut off by a shorter total.
    #[tokio::test]
    async fn kiro_client_total_covers_the_body_and_idle_does_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/",
            axum::routing::get(|| async {
                let chunks = futures_util::stream::unfold(0_u8, |step| async move {
                    if step == 8 {
                        return None;
                    }
                    if step > 0 {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"frame\n")),
                        step + 1,
                    ))
                });
                axum::body::Body::from_stream(chunks)
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let url = format!("http://{address}/");
        let idle = Duration::from_millis(500);

        let streamed = kiro_client(Duration::from_secs(5), idle).unwrap();
        let body = streamed
            .get(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .expect("a body that keeps arriving outlives the idle bound");
        assert_eq!(body.len(), 8 * "frame\n".len());

        let bounded = kiro_client(Duration::from_millis(250), idle).unwrap();
        let cut = async { bounded.get(&url).send().await?.bytes().await }.await;
        assert!(cut.is_err_and(|error| error.is_timeout()));
        server.abort();
    }

    #[test]
    fn caller_binding_quota_is_isolated_and_idle_entries_expire() {
        let vault = AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope("kiro");
        vault
            .upsert(
                &scope,
                "first",
                "first",
                KIND_OAUTH,
                Some(json!({"type":"oauth","access":"fixture"})),
            )
            .unwrap();
        vault.set_active(&scope, "first").unwrap();
        let label = affinity_label("5:aliceconversation");
        for index in 0..MAX_SCOPE_BINDINGS {
            vault
                .upsert(
                    AFFINITY_SCOPE,
                    &format!("fixture-{index}"),
                    &label,
                    KIND_OPAQUE,
                    Some(json!({"accountId":"first"})),
                )
                .unwrap();
        }
        let policy = super::super::oauth_pool_policy::Policy::default();
        assert_eq!(
            selected(&vault, Some("5:alicenew"), &policy)
                .unwrap_err()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            selected(&vault, Some("3:bobnew"), &policy).unwrap(),
            "first"
        );
        let oldest = vault
            .list(AFFINITY_SCOPE)
            .unwrap()
            .iter()
            .map(|binding| binding.updated_at)
            .max()
            .unwrap();
        assert!(prune_idle_bindings(&vault, oldest + AFFINITY_IDLE_MILLIS)
            .unwrap()
            .is_empty());
        assert_eq!(vault.count(AFFINITY_SCOPE).unwrap(), 0);
        assert_eq!(vault.count(&scope).unwrap(), 1);
        assert_eq!(
            selected(&vault, Some("5:alicenew"), &policy).unwrap(),
            "first"
        );
        assert_ne!(affinity_label("3:abcde"), affinity_label("4:abcde"));
    }
    #[test]
    fn kiro_durable_affinity_survives_selection_changes_and_fails_removed_or_disabled() {
        let vault = AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope("kiro");
        for id in ["first", "second"] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    KIND_OAUTH,
                    Some(json!({"type":"oauth","access":format!("fixture-{id}")})),
                )
                .unwrap();
        }
        vault.set_active(&scope, "first").unwrap();
        let mut policy = super::super::oauth_pool_policy::Policy::default();
        assert_eq!(
            selected(&vault, Some("conversation"), &policy).unwrap(),
            "first"
        );
        vault.set_active(&scope, "second").unwrap();
        assert_eq!(
            selected(&vault, Some("conversation"), &policy).unwrap(),
            "first"
        );
        assert_eq!(
            selected(&vault, Some("new-conversation"), &policy).unwrap(),
            "second"
        );
        policy.accounts.insert(
            "first".into(),
            super::super::oauth_pool_policy::AccountRule {
                enabled: false,
                priority: 0,
                drain_threshold_percent: None,
            },
        );
        assert_eq!(
            selected(&vault, Some("conversation"), &policy)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        policy.accounts.clear();
        vault.remove(&scope, "first").unwrap();
        assert_eq!(
            selected(&vault, Some("conversation"), &policy)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
    }
    #[test]
    fn kiro_projection_keeps_real_region_profile_and_auth_method() {
        let credential = json!({"access":"synthetic-token","region":"eu-west-1","profileArn":"arn:aws:codewhisperer:eu-west-1:123456789012:profile/fixture","authMethod":"builder-id"});
        let projected = account(&credential).unwrap();
        assert_eq!(projected.region, "eu-west-1");
        assert_eq!(
            projected.profile_arn.as_deref(),
            credential["profileArn"].as_str()
        );
        assert_eq!(projected.auth_method, KiroAuthMethod::OAuth);
        assert!(!format!("{projected:?}").contains("synthetic-token"));
        assert!(account(&json!({"access":"fixture","authMethod":"unknown"})).is_err());
    }
    #[test]
    fn kiro_uncertain_transport_is_marked_for_gateway_no_replay() {
        let response = provider_error(ProviderError::DeliveryUncertain(
            "secret vendor echo".into(),
        ));
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(response.headers()["x-ryu-delivery-uncertain"], "true");
    }
}
