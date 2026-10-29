//! Cursor usage from the access token already present in Cursor's local state DB.
//!
//! This reader is deliberately read-only: it sends the current access token to
//! Cursor's usage endpoint, never uses the refresh token, and never updates the
//! database. When Cursor's own app rotates the access token, the next poll reads
//! the new value. An expired token produces `token_expired`.

use serde_json::Value;

use super::{
    credential_http_client, host, jwt_exp_unix, read_json_limited, reason_for_status,
    retry_after_seconds, UsageMeter, UsageSnapshot, UsageUnavailable, UsageValue, UsageValueKind,
    UsageWindow,
};

const USAGE_URL: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const REQUEST_USAGE_URL: &str = "https://cursor.com/api/usage";
const GROK_BOT_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";
const CREDIT_GRANTS_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance";
const STRIPE_BALANCE_URL: &str = "https://cursor.com/api/auth/stripe";
const EXPIRY_BUFFER_SECONDS: i64 = 5 * 60;
const CONNECT_REQUEST_BODY: &str = "{}";
#[cfg(test)]
const DISABLED_TEST_ENDPOINT: &str = "";

#[derive(Clone, Copy)]
struct CursorEndpoints<'a> {
    usage: &'a str,
    usage_summary: &'a str,
    request_usage: &'a str,
    grok_bot_usage: &'a str,
    credit_grants: &'a str,
    stripe_balance: &'a str,
}

impl CursorEndpoints<'static> {
    const fn production() -> Self {
        Self {
            usage: USAGE_URL,
            usage_summary: USAGE_SUMMARY_URL,
            request_usage: REQUEST_USAGE_URL,
            grok_bot_usage: GROK_BOT_USAGE_URL,
            credit_grants: CREDIT_GRANTS_URL,
            stripe_balance: STRIPE_BALANCE_URL,
        }
    }
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "cursor", reason);
    let Some(host) = host() else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };
    let token = match tokio::task::spawn_blocking(move || host.cursor_access_token()).await {
        Ok(Some(token)) => token,
        Ok(None) | Err(_) => return unavailable(UsageUnavailable::NotLoggedIn),
    };
    fetch_with_token(agent_id, &token).await
}

async fn fetch_with_token(agent_id: &str, access_token: &str) -> UsageSnapshot {
    fetch_with_endpoints(agent_id, access_token, CursorEndpoints::production()).await
}

#[cfg(test)]
async fn fetch_with_urls(
    agent_id: &str,
    access_token: &str,
    usage_url: &str,
    summary_url: &str,
) -> UsageSnapshot {
    fetch_with_endpoints(
        agent_id,
        access_token,
        CursorEndpoints {
            usage: usage_url,
            usage_summary: summary_url,
            request_usage: DISABLED_TEST_ENDPOINT,
            grok_bot_usage: DISABLED_TEST_ENDPOINT,
            credit_grants: DISABLED_TEST_ENDPOINT,
            stripe_balance: DISABLED_TEST_ENDPOINT,
        },
    )
    .await
}

async fn fetch_with_endpoints(
    agent_id: &str,
    access_token: &str,
    endpoints: CursorEndpoints<'_>,
) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "cursor", reason);
    if access_token.len() > 16 * 1024
        || !access_token.is_ascii()
        || access_token
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return unavailable(UsageUnavailable::Error);
    }
    if jwt_exp_unix(access_token).is_some_and(|expires| {
        expires.saturating_sub(chrono::Utc::now().timestamp()) <= EXPIRY_BUFFER_SECONDS
    }) {
        return unavailable(UsageUnavailable::TokenExpired);
    }

    let client = match credential_http_client() {
        Ok(client) => client,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let response = match client
        .post(endpoints.usage)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body(CONNECT_REQUEST_BODY)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !response.status().is_success() {
        let status = response.status();
        let retry_after = retry_after_seconds(response.headers());
        if status.is_client_error() && !matches!(status.as_u16(), 401 | 403 | 429) {
            // Team and Enterprise accounts can omit the individual plan payload;
            // try Cursor's dashboard summary and request-count endpoints with
            // the same current access token.
            if let Some(mut snapshot) =
                fetch_fallback_snapshot(&client, agent_id, access_token, None, endpoints).await
            {
                enrich_snapshot(&client, &mut snapshot, access_token, endpoints).await;
                return snapshot;
            }
        }
        let mut snapshot = unavailable(reason_for_status(status));
        snapshot.retry_after_seconds = retry_after;
        return snapshot;
    }

    let body = match read_json_limited(response).await {
        Ok(body) => body,
        Err(()) => return unavailable(UsageUnavailable::Error),
    };
    let mut snapshot = match map_current_usage(agent_id, &body) {
        Ok(snapshot) => snapshot,
        Err(UsageUnavailable::NoPlan) => {
            let plan = body
                .get("planName")
                .or_else(|| body.get("membershipType"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let Some(snapshot) =
                fetch_fallback_snapshot(&client, agent_id, access_token, plan, endpoints).await
            else {
                return unavailable(UsageUnavailable::NoPlan);
            };
            snapshot
        }
        Err(reason) => return unavailable(reason),
    };
    enrich_snapshot(&client, &mut snapshot, access_token, endpoints).await;
    snapshot
}

async fn fetch_usage_summary(
    client: &reqwest::Client,
    agent_id: &str,
    access_token: &str,
    summary_url: &str,
) -> Option<UsageSnapshot> {
    if summary_url.is_empty() {
        return None;
    }
    let cookie = cursor_session_cookie(access_token)?;
    let response = client
        .get(summary_url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = read_json_limited(response).await.ok()?;
    map_usage_summary(agent_id, &body).ok()
}

async fn fetch_fallback_snapshot(
    client: &reqwest::Client,
    agent_id: &str,
    access_token: &str,
    plan: Option<String>,
    endpoints: CursorEndpoints<'_>,
) -> Option<UsageSnapshot> {
    let (summary, requests) = tokio::join!(
        fetch_usage_summary(client, agent_id, access_token, endpoints.usage_summary,),
        fetch_request_based_usage(
            client,
            agent_id,
            access_token,
            plan,
            endpoints.request_usage,
        )
    );

    match (summary, requests) {
        (Some(mut summary), Some(requests)) => {
            summary.meters.extend(requests.meters);
            if summary.plan.is_none() {
                summary.plan = requests.plan;
            }
            Some(summary)
        }
        (Some(summary), None) | (None, Some(summary)) => Some(summary),
        (None, None) => None,
    }
}

async fn fetch_request_based_usage(
    client: &reqwest::Client,
    agent_id: &str,
    access_token: &str,
    plan: Option<String>,
    request_url: &str,
) -> Option<UsageSnapshot> {
    if request_url.is_empty() {
        return None;
    }
    let user_id = cursor_user_id(access_token)?;
    let cookie = cursor_session_cookie(access_token)?;
    let mut url = reqwest::Url::parse(request_url).ok()?;
    url.query_pairs_mut().append_pair("user", &user_id);
    let response = client
        .get(url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = read_json_limited(response).await.ok()?;
    map_request_based_usage(agent_id, plan, &body).ok()
}

async fn enrich_snapshot(
    client: &reqwest::Client,
    snapshot: &mut UsageSnapshot,
    access_token: &str,
    endpoints: CursorEndpoints<'_>,
) {
    let (grok_bot, credit_grants, stripe_balance) = tokio::join!(
        fetch_optional_connect_json(client, endpoints.grok_bot_usage, access_token),
        fetch_optional_connect_json(client, endpoints.credit_grants, access_token),
        fetch_optional_cookie_json(client, endpoints.stripe_balance, access_token),
    );
    if let Some(window) = grok_bot.as_ref().and_then(map_grok_bot_usage) {
        snapshot.windows.push(window);
    }
    if let Some(meter) = map_credits(credit_grants.as_ref(), stripe_balance.as_ref()) {
        snapshot.meters.push(meter);
    }
}

async fn fetch_optional_connect_json(
    client: &reqwest::Client,
    endpoint: &str,
    access_token: &str,
) -> Option<Value> {
    if endpoint.is_empty() {
        return None;
    }
    let response = client
        .post(endpoint)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body(CONNECT_REQUEST_BODY)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    read_json_limited(response).await.ok()
}

async fn fetch_optional_cookie_json(
    client: &reqwest::Client,
    endpoint: &str,
    access_token: &str,
) -> Option<Value> {
    if endpoint.is_empty() {
        return None;
    }
    let cookie = cursor_session_cookie(access_token)?;
    let response = client
        .get(endpoint)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    read_json_limited(response).await.ok()
}

fn cursor_session_cookie(access_token: &str) -> Option<String> {
    if !access_token.is_ascii()
        || access_token.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b';' | b',' | b'"' | b'\\')
        })
    {
        return None;
    }
    let user_id = cursor_user_id(access_token)?;
    Some(format!(
        "WorkosCursorSessionToken={user_id}%3A%3A{access_token}"
    ))
}

fn map_request_based_usage(
    agent_id: &str,
    plan: Option<String>,
    body: &Value,
) -> Result<UsageSnapshot, UsageUnavailable> {
    let usage = body
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| body.as_object())
        .ok_or(UsageUnavailable::Error)?;
    let gpt4 = usage
        .get("gpt-4")
        .and_then(Value::as_object)
        .ok_or(UsageUnavailable::NoPlan)?;
    let used = optional_number(gpt4.get("numRequests"))?
        .filter(|value| *value >= 0.0)
        .ok_or(UsageUnavailable::NoPlan)?;
    let limit = optional_number(gpt4.get("maxRequestUsage"))?
        .filter(|value| *value > 0.0)
        .ok_or(UsageUnavailable::NoPlan)?;
    let mut snapshot = UsageSnapshot::available(agent_id, "cursor", plan);
    snapshot.meters.push(UsageMeter::new(
        "Requests",
        vec![
            UsageValue::new(used, UsageValueKind::Count, Some("requests")),
            UsageValue::new(limit, UsageValueKind::Count, Some("requests")),
        ],
    ));
    Ok(snapshot)
}

fn map_grok_bot_usage(body: &Value) -> Option<UsageWindow> {
    let usage = body
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| body.as_object())?;
    if usage
        .get("usesPooledEnterpriseAllowance")
        .and_then(Value::as_bool)
        == Some(true)
        || usage
            .get("hasNonZeroIncludedLimit")
            .and_then(Value::as_bool)
            == Some(false)
        || usage.get("includedLimitZero").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let percent = optional_number(usage.get("usagePercent")).ok()??;
    if percent < 0.0 {
        return None;
    }
    let resets_at = usage
        .get("nextResetTimestampUtc")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc));
    let period_start = usage
        .get("currentPeriodStart")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    let window_seconds = period_start
        .zip(resets_at)
        .and_then(|(start, end)| (end > start).then_some(end.timestamp() - start.timestamp()))
        .filter(|seconds| *seconds > 0)
        .or(Some(7 * 24 * 60 * 60));
    Some(UsageWindow {
        label: "Grok Bot usage".to_owned(),
        used_percent: super::clamp_percent(percent),
        resets_at: resets_at.map(|value| value.to_rfc3339()),
        window_seconds,
        model: None,
    })
}

fn map_credits(
    credit_grants: Option<&Value>,
    stripe_balance: Option<&Value>,
) -> Option<UsageMeter> {
    let (grant_total, grant_used) = match credit_grants
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("hasCreditGrants").and_then(Value::as_bool))
    {
        Some(true) => {
            let grants = credit_grants?.as_object()?;
            let total = optional_number(grants.get("totalCents")).ok()??;
            let used = optional_number(grants.get("usedCents")).ok()??;
            if total <= 0.0 || used < 0.0 {
                return None;
            }
            (total, used)
        }
        Some(false) | None => (0.0, 0.0),
    };
    let prepaid_cents = stripe_balance
        .and_then(Value::as_object)
        .and_then(|value| optional_number(value.get("customerBalance")).ok().flatten())
        .map(|balance| (-balance).max(0.0))
        .unwrap_or(0.0);
    let total = grant_total + prepaid_cents;
    if !total.is_finite() {
        return None;
    }
    (total > 0.0).then(|| {
        UsageMeter::new(
            "Credits",
            vec![UsageValue::new(
                cents_to_dollars((total - grant_used).max(0.0)),
                UsageValueKind::Dollars,
                None,
            )],
        )
    })
}

fn map_current_usage(agent_id: &str, body: &Value) -> Result<UsageSnapshot, UsageUnavailable> {
    let usage = body
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| body.as_object())
        .ok_or(UsageUnavailable::Error)?;
    if usage.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(UsageUnavailable::NoPlan);
    }
    let Some(plan_usage) = usage.get("planUsage").and_then(Value::as_object) else {
        return Err(UsageUnavailable::NoPlan);
    };

    let billing_start = optional_timestamp(usage.get("billingCycleStart"))?;
    let billing_end = optional_timestamp(usage.get("billingCycleEnd"))?;
    let window_seconds = billing_start.zip(billing_end).and_then(|(start, end)| {
        (end > start).then_some((end.timestamp() - start.timestamp()).max(0))
    });
    let resets_at = billing_end.map(|value| value.to_rfc3339());
    let plan_name = usage
        .get("planName")
        .or_else(|| usage.get("membershipType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let spend_limit = usage.get("spendLimitUsage").and_then(Value::as_object);
    let pooled_spend_limit =
        optional_number(spend_limit.and_then(|limits| limits.get("pooledLimit")))?.unwrap_or(0.0);
    let is_team = plan_name
        .as_deref()
        .is_some_and(|name| matches!(name.to_ascii_lowercase().as_str(), "team" | "enterprise"))
        || spend_limit
            .and_then(|limits| limits.get("limitType"))
            .and_then(Value::as_str)
            .is_some_and(|limit_type| limit_type.eq_ignore_ascii_case("team"))
        || pooled_spend_limit > 0.0;

    let limit = optional_number(plan_usage.get("limit"))?;
    let total_spend = optional_number(plan_usage.get("totalSpend"))?;
    let remaining = optional_number(plan_usage.get("remaining"))?;
    let total_percent = optional_number(plan_usage.get("totalPercentUsed"))?.or_else(|| {
        let limit = limit.filter(|limit| *limit > 0.0)?;
        let spend = total_spend.or_else(|| remaining.map(|remaining| limit - remaining))?;
        Some(spend / limit * 100.0)
    });
    if is_team && (limit.is_none() || (total_spend.is_none() && remaining.is_none())) {
        return Err(UsageUnavailable::NoPlan);
    }

    let mut snapshot = UsageSnapshot::available(agent_id, "cursor", plan_name);
    if is_team {
        if let (Some(spend), Some(limit)) = (total_spend, limit) {
            snapshot
                .meters
                .push(amount_meter("Total usage", spend, limit));
        }
    } else if let Some(percent) = total_percent {
        snapshot.windows.push(percent_window(
            "Total usage",
            percent,
            resets_at.clone(),
            window_seconds,
        ));
    }

    for (field, label) in [
        ("autoPercentUsed", "Cursor Models"),
        ("apiPercentUsed", "Other Models"),
    ] {
        if let Some(percent) = optional_number(plan_usage.get(field))? {
            snapshot.windows.push(percent_window(
                label,
                percent,
                resets_at.clone(),
                window_seconds,
            ));
        }
    }

    if let Some(spend_limit) = spend_limit {
        let limit = optional_number(spend_limit.get("individualLimit"))?
            .or(optional_number(spend_limit.get("pooledLimit"))?)
            .unwrap_or(0.0);
        let remaining = optional_number(spend_limit.get("individualRemaining"))?
            .or(optional_number(spend_limit.get("pooledRemaining"))?)
            .unwrap_or(0.0);
        let spent = optional_number(spend_limit.get("individualUsed"))?
            .or(optional_number(spend_limit.get("pooledUsed"))?)
            .or(optional_number(spend_limit.get("totalSpend"))?)
            .unwrap_or_else(|| (limit - remaining).max(0.0));
        if limit > 0.0 {
            snapshot
                .meters
                .push(amount_meter("On-demand", spent, limit));
        } else if spent > 0.0 {
            snapshot.meters.push(UsageMeter::new(
                "On-demand",
                vec![UsageValue::new(
                    cents_to_dollars(spent),
                    UsageValueKind::Dollars,
                    None,
                )],
            ));
        }
    }

    if snapshot.windows.is_empty() && snapshot.meters.is_empty() {
        return Err(UsageUnavailable::NoPlan);
    }
    Ok(snapshot)
}

fn map_usage_summary(agent_id: &str, body: &Value) -> Result<UsageSnapshot, UsageUnavailable> {
    let membership = body
        .get("membershipType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let resets_at =
        optional_timestamp(body.get("billingCycleEnd"))?.map(|value| value.to_rfc3339());
    let mut snapshot = UsageSnapshot::available(agent_id, "cursor", membership);

    for (scope, field, label) in [
        ("teamUsage", "pooled", "Total usage"),
        ("teamUsage", "onDemand", "On-demand"),
    ] {
        let Some(bucket) = body
            .get(scope)
            .and_then(Value::as_object)
            .and_then(|usage| usage.get(field))
            .and_then(Value::as_object)
        else {
            continue;
        };
        if bucket.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if let (Some(used), Some(limit)) = (
            optional_number(bucket.get("used"))?,
            optional_number(bucket.get("limit"))?,
        ) {
            snapshot.meters.push(amount_meter(label, used, limit));
        }
    }

    if snapshot.windows.is_empty() && snapshot.meters.is_empty() {
        return Err(UsageUnavailable::NoPlan);
    }
    for window in &mut snapshot.windows {
        window.resets_at = resets_at.clone();
    }
    Ok(snapshot)
}

fn amount_meter(label: &str, used_cents: f64, limit_cents: f64) -> UsageMeter {
    UsageMeter::new(
        label,
        vec![
            UsageValue::new(cents_to_dollars(used_cents), UsageValueKind::Dollars, None),
            UsageValue::new(cents_to_dollars(limit_cents), UsageValueKind::Dollars, None),
        ],
    )
}

fn cents_to_dollars(cents: f64) -> f64 {
    (cents / 100.0).max(0.0)
}

fn percent_window(
    label: &str,
    percent: f64,
    resets_at: Option<String>,
    window_seconds: Option<i64>,
) -> UsageWindow {
    UsageWindow {
        label: label.to_owned(),
        used_percent: super::clamp_percent(percent),
        resets_at,
        window_seconds,
        model: None,
    }
}

fn cursor_user_id(access_token: &str) -> Option<String> {
    let payload = super::jwt_payload(access_token)?;
    let subject = payload.get("sub")?.as_str()?.trim();
    let id = subject
        .split_once('|')
        .map(|(_, id)| id)
        .unwrap_or(subject)
        .trim();
    (!id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
    .then(|| id.to_owned())
}

fn optional_number(value: Option<&Value>) -> Result<Option<f64>, UsageUnavailable> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or(UsageUnavailable::Error),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or(UsageUnavailable::Error),
        Some(_) => Err(UsageUnavailable::Error),
    }
}

fn optional_timestamp(
    value: Option<&Value>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, UsageUnavailable> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(timestamp) = super::timestamp_to_rfc3339(Some(value)) {
        return chrono::DateTime::parse_from_rfc3339(&timestamp)
            .ok()
            .map(|value| Some(value.with_timezone(&chrono::Utc)))
            .ok_or(UsageUnavailable::Error);
    }
    if let Some(text) = value.as_str() {
        let millis = text
            .trim()
            .parse::<i64>()
            .map_err(|_| UsageUnavailable::Error)?;
        return chrono::DateTime::from_timestamp_millis(millis)
            .map(Some)
            .ok_or(UsageUnavailable::Error);
    }
    Err(UsageUnavailable::Error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::spawn_loopback;

    #[tokio::test]
    async fn current_period_usage_maps_cursor_windows_read_only() {
        let token = test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user_123");
        let server = spawn_loopback(
            "200 OK",
            r#"{"billingCycleStart":"2026-09-01T00:00:00Z","billingCycleEnd":"2026-10-01T00:00:00Z","planUsage":{"enabled":true,"totalSpend":2000,"limit":10000,"remaining":8000,"totalPercentUsed":20,"autoPercentUsed":8,"apiPercentUsed":12},"spendLimitUsage":{"individualLimit":1000,"individualRemaining":600}}"#,
        );
        let snapshot = fetch_from_url("acp:cursor", &token, &server).await;
        assert!(snapshot.available);
        assert_eq!(snapshot.engine, "cursor");
        assert_eq!(snapshot.windows[0].label, "Total usage");
        assert_eq!(snapshot.windows[0].used_percent, 20.0);
        assert_eq!(snapshot.windows[1].label, "Cursor Models");
        assert_eq!(snapshot.windows[2].label, "Other Models");
        assert_eq!(snapshot.meters[0].label, "On-demand");
        assert_eq!(cursor_user_id(&token).as_deref(), Some("user_123"));
    }

    #[tokio::test]
    async fn expired_cursor_access_token_is_never_refreshed() {
        let token = test_access_token(chrono::Utc::now().timestamp() - 10, "auth0|user_123");
        let snapshot = fetch_from_url("acp:cursor", &token, "http://127.0.0.1:1/usage").await;
        assert!(!snapshot.available);
        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::TokenExpired)
        ));
    }

    #[tokio::test]
    async fn team_cursor_usage_falls_back_to_dashboard_summary() {
        let token = test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user_123");
        let current_usage = spawn_loopback("200 OK", r#"{"enabled":true}"#);
        let usage_summary = spawn_loopback(
            "200 OK",
            r#"{"membershipType":"enterprise","billingCycleEnd":"2026-10-01T00:00:00Z","teamUsage":{"pooled":{"enabled":true,"used":3479810,"limit":60000000},"onDemand":{"enabled":true,"used":0,"limit":5000000}}}"#,
        );

        let snapshot = fetch_with_urls("acp:cursor", &token, &current_usage, &usage_summary).await;

        assert!(snapshot.available);
        assert_eq!(snapshot.meters.len(), 2);
        assert_eq!(snapshot.meters[0].label, "Total usage");
        assert_eq!(snapshot.meters[0].values[0].number, 34_798.1);
        assert_eq!(snapshot.meters[1].label, "On-demand");
        assert_eq!(snapshot.meters[1].values[0].number, 0.0);
    }

    #[tokio::test]
    async fn cursor_enriches_usage_with_credits_and_grok_bot_quota() {
        let token = test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user_123");
        let usage = spawn_loopback(
            "200 OK",
            r#"{"planName":"Ultra","planUsage":{"enabled":true,"totalPercentUsed":18,"limit":10000,"totalSpend":1800}}"#,
        );
        let grok_bot = spawn_loopback(
            "200 OK",
            r#"{"usagePercent":42,"hasNonZeroIncludedLimit":true,"nextResetTimestampUtc":"2026-10-01T00:00:00Z","currentPeriodStart":"2026-09-24T00:00:00Z"}"#,
        );
        let credit_grants = spawn_loopback(
            "200 OK",
            r#"{"hasCreditGrants":true,"totalCents":5000,"usedCents":1200}"#,
        );
        let stripe_balance = spawn_loopback("200 OK", r#"{"customerBalance":-2500}"#);
        let snapshot = fetch_with_endpoints(
            "acp:cursor",
            &token,
            CursorEndpoints {
                usage: &usage,
                usage_summary: DISABLED_TEST_ENDPOINT,
                request_usage: DISABLED_TEST_ENDPOINT,
                grok_bot_usage: &grok_bot,
                credit_grants: &credit_grants,
                stripe_balance: &stripe_balance,
            },
        )
        .await;

        assert!(snapshot.available);
        assert!(snapshot.windows.iter().any(|window| {
            window.label == "Grok Bot usage"
                && window.used_percent == 42.0
                && window.window_seconds == Some(7 * 24 * 60 * 60)
        }));
        let credits = snapshot
            .meters
            .iter()
            .find(|meter| meter.label == "Credits")
            .unwrap();
        assert_eq!(credits.values[0].number, 63.0);
        assert!(!serde_json::to_string(&snapshot).unwrap().contains(&token));
    }

    #[test]
    fn credit_totals_reject_non_finite_sum() {
        let credit_grants = serde_json::json!({
            "hasCreditGrants": true,
            "totalCents": f64::MAX,
            "usedCents": 0.0
        });
        let stripe_balance = serde_json::json!({
            "customerBalance": -f64::MAX
        });

        assert!(map_credits(Some(&credit_grants), Some(&stripe_balance)).is_none());
    }

    #[tokio::test]
    async fn request_based_cursor_usage_is_used_when_dashboard_limits_are_missing() {
        let token = test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user_123");
        let current_usage = spawn_loopback("200 OK", r#"{"enabled":true}"#);
        let usage_summary = spawn_loopback("200 OK", r#"{"membershipType":"enterprise"}"#);
        let request_usage = spawn_loopback(
            "200 OK",
            r#"{"gpt-4":{"numRequests":39,"maxRequestUsage":500},"startOfMonth":"2026-09-01T00:00:00Z"}"#,
        );
        let snapshot = fetch_with_endpoints(
            "acp:cursor",
            &token,
            CursorEndpoints {
                usage: &current_usage,
                usage_summary: &usage_summary,
                request_usage: &request_usage,
                grok_bot_usage: DISABLED_TEST_ENDPOINT,
                credit_grants: DISABLED_TEST_ENDPOINT,
                stripe_balance: DISABLED_TEST_ENDPOINT,
            },
        )
        .await;

        assert!(snapshot.available);
        let requests = snapshot
            .meters
            .iter()
            .find(|meter| meter.label == "Requests")
            .unwrap();
        assert_eq!(requests.values[0].number, 39.0);
        assert_eq!(requests.values[0].unit.as_deref(), Some("requests"));
        assert_eq!(requests.values[1].number, 500.0);
    }

    #[test]
    fn team_usage_summary_maps_cents_to_dollars() {
        let body = serde_json::json!({
            "membershipType": "enterprise",
            "billingCycleEnd": "2026-10-01T00:00:00Z",
            "teamUsage": {
                "pooled": {"enabled": true, "used": 3479810, "limit": 60000000},
                "onDemand": {"enabled": true, "used": 0, "limit": 5000000}
            }
        });
        let snapshot = map_usage_summary("acp:cursor", &body).unwrap();
        assert_eq!(snapshot.meters.len(), 2);
        assert_eq!(snapshot.meters[0].values[0].number, 34_798.1);
        assert_eq!(snapshot.meters[0].values[1].number, 600_000.0);
        assert_eq!(snapshot.meters[1].values[0].number, 0.0);
    }

    #[test]
    fn numeric_timestamp_strings_follow_seconds_and_milliseconds_heuristic() {
        let seconds = Value::String("1790150400".to_owned());
        let milliseconds = Value::String("1790150400000".to_owned());

        assert_eq!(
            optional_timestamp(Some(&seconds))
                .unwrap()
                .unwrap()
                .timestamp(),
            1_790_150_400
        );
        assert_eq!(
            optional_timestamp(Some(&milliseconds))
                .unwrap()
                .unwrap()
                .timestamp(),
            1_790_150_400
        );
    }

    #[test]
    fn grok_bot_usage_ignores_accounts_without_a_personal_allowance() {
        let body = serde_json::json!({
            "usagePercent": 42,
            "hasNonZeroIncludedLimit": true,
            "usesPooledEnterpriseAllowance": true
        });
        assert!(map_grok_bot_usage(&body).is_none());
    }

    #[test]
    fn session_cookie_user_id_rejects_header_delimiters() {
        let token = test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user;evil");
        assert_eq!(cursor_user_id(&token), None);
    }

    #[test]
    fn session_cookie_rejects_cookie_delimiters_in_access_token() {
        let token = format!(
            "{};Injected=1",
            test_access_token(chrono::Utc::now().timestamp() + 3600, "auth0|user_123")
        );
        assert_eq!(cursor_session_cookie(&token), None);
    }

    fn test_access_token(expires_at: i64, subject: &str) -> String {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::json!({"exp": expires_at, "sub": subject}).to_string());
        format!("header.{payload}.signature")
    }

    #[cfg(test)]
    async fn fetch_from_url(agent_id: &str, token: &str, url: &str) -> UsageSnapshot {
        fetch_with_urls(agent_id, token, url, "http://127.0.0.1:1/summary").await
    }
}
