//! Explicit read-only provider reports. Credentials stay in memory for one page.
use axum::http::StatusCode;
use chrono::{NaiveDate, TimeZone, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::{ImportReport, UsageHistoryStore};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountSyncInput {
    pub source_id: String,
    pub account_id: String,
    pub credential: String,
    pub start_date: String,
    pub end_date: String,
    pub cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSyncResult {
    pub report: ImportReport,
    pub next_cursor: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SyncError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}
fn invalid() -> SyncError {
    SyncError {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_account_import",
        message: "Choose a supported report, a stable account label, and valid UTC dates within one year.",
    }
}
fn provider_error() -> SyncError {
    SyncError {
        status: StatusCode::BAD_GATEWAY,
        code: "provider_history_failed",
        message: "The provider history request failed. Check authorization and retry this page.",
    }
}

fn dates(input: &AccountSyncInput) -> Result<(i64, i64), SyncError> {
    let from = NaiveDate::parse_from_str(&input.start_date, "%Y-%m-%d").map_err(|_| invalid())?;
    let to = NaiveDate::parse_from_str(&input.end_date, "%Y-%m-%d").map_err(|_| invalid())?;
    let days = to.signed_duration_since(from).num_days();
    if !(1..=366).contains(&days)
        || input.account_id.trim().is_empty()
        || input.account_id.len() > 256
        || input.credential.trim().is_empty()
        || input.credential.len() > 8192
        || input.credential.chars().any(char::is_control)
        || input.cursor.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return Err(invalid());
    }
    Ok((
        Utc.from_utc_datetime(&from.and_hms_opt(0, 0, 0).ok_or_else(invalid)?)
            .timestamp(),
        Utc.from_utc_datetime(&to.and_hms_opt(0, 0, 0).ok_or_else(invalid)?)
            .timestamp(),
    ))
}

/// Endpoints cannot be supplied by callers. Redirects are disabled so admin
/// credentials can never be forwarded to a different destination.
fn request(
    client: &reqwest::Client,
    input: &AccountSyncInput,
) -> Result<reqwest::RequestBuilder, SyncError> {
    let (from, to) = dates(input)?;
    let mut req = match input.source_id.as_str() {
        "openai-org-usage" => client
            .get("https://api.openai.com/v1/organization/usage/completions")
            .bearer_auth(&input.credential)
            .query(&[
                ("start_time", from.to_string()),
                ("end_time", to.to_string()),
                ("bucket_width", "1d".into()),
                ("group_by[]", "model".into()),
                ("group_by[]", "project_id".into()),
                ("group_by[]", "api_key_id".into()),
                ("limit", "31".into()),
            ]),
        "openai-org-costs" => client
            .get("https://api.openai.com/v1/organization/costs")
            .bearer_auth(&input.credential)
            .query(&[
                ("start_time", from.to_string()),
                ("end_time", to.to_string()),
                ("bucket_width", "1d".into()),
                ("group_by[]", "project_id".into()),
                ("group_by[]", "line_item".into()),
                ("limit", "31".into()),
            ]),
        "anthropic-org-usage" | "anthropic-org-costs" => {
            let url = if input.source_id == "anthropic-org-usage" {
                "https://api.anthropic.com/v1/organizations/usage_report/messages"
            } else {
                "https://api.anthropic.com/v1/organizations/cost_report"
            };
            let mut req = client
                .get(url)
                .header("x-api-key", &input.credential)
                .header("anthropic-version", "2023-06-01")
                .query(&[
                    ("starting_at", format!("{}T00:00:00Z", input.start_date)),
                    ("ending_at", format!("{}T00:00:00Z", input.end_date)),
                    ("bucket_width", "1d".into()),
                    ("limit", "31".into()),
                ]);
            if input.source_id == "anthropic-org-usage" {
                req = req.query(&[
                    ("group_by[]", "model"),
                    ("group_by[]", "workspace_id"),
                    ("group_by[]", "api_key_id"),
                ]);
            }
            req
        }
        "cursor-account" => {
            let page = input
                .cursor
                .as_deref()
                .unwrap_or("1")
                .parse::<u32>()
                .map_err(|_| invalid())?;
            if !(1..=100_000).contains(&page) {
                return Err(invalid());
            }
            client.post("https://api.cursor.com/teams/filtered-usage-events").basic_auth(&input.credential,Some("")).json(&serde_json::json!({"startDate":from*1000,"endDate":to*1000,"page":page,"pageSize":100}))
        }
        _ => return Err(invalid()),
    };
    if input.source_id != "cursor-account" {
        if let Some(cursor) = &input.cursor {
            req = req.query(&[("page", cursor)]);
        }
    }
    Ok(req)
}

pub(crate) async fn sync_page(
    store: &UsageHistoryStore,
    input: AccountSyncInput,
) -> Result<AccountSyncResult, SyncError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| provider_error())?;
    let response = request(&client, &input)?
        .send()
        .await
        .map_err(|_| provider_error())?;
    match response.status().as_u16() {
        401 | 403 => {
            return Err(SyncError {
                status: StatusCode::FORBIDDEN,
                code: "provider_authorization_required",
                message: "This history report requires an authorized provider admin key. Inference keys and personal subscription logins may not have access.",
            });
        }
        429 => {
            return Err(SyncError {
                status: StatusCode::TOO_MANY_REQUESTS,
                code: "provider_history_rate_limited",
                message: "The provider rate limited this report. Retry this page later.",
            });
        }
        200..=299 => {}
        _ => return Err(provider_error()),
    }
    let mut bytes = Vec::new();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| provider_error())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(provider_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| provider_error())?;
    let next_cursor = if input.source_id == "cursor-account" {
        value
            .pointer("/pagination/hasNextPage")
            .and_then(serde_json::Value::as_bool)
            .filter(|v| *v)
            .and_then(|_| {
                value
                    .pointer("/pagination/currentPage")
                    .and_then(serde_json::Value::as_u64)
            })
            .map(|n| n.saturating_add(1).to_string())
    } else {
        value
            .get("next_page")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let records = super::provider_exports::parse_scoped(
        &input.source_id,
        &value,
        "provider-api",
        &input.account_id,
    )
    .map_err(|_| provider_error())?;
    let store = store.clone();
    let has_more = next_cursor.is_some();
    let report = tokio::task::spawn_blocking(move || {
        let mut report = ImportReport {
            has_more,
            ..Default::default()
        };
        for record in records {
            if store.upsert_record(&record)? {
                report.imported_records += 1;
            } else {
                report.duplicate_records += 1;
            }
        }
        Ok::<_, anyhow::Error>(report)
    })
    .await
    .map_err(|_| provider_error())?
    .map_err(|_| provider_error())?;
    tracing::info!(
        imported_records = report.imported_records,
        duplicate_records = report.duplicate_records,
        has_more,
        "provider history page imported"
    );
    Ok(AccountSyncResult {
        report,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(source: &str) -> AccountSyncInput {
        AccountSyncInput {
            source_id: source.into(),
            account_id: "primary".into(),
            credential: "test-secret".into(),
            start_date: "2026-09-01".into(),
            end_date: "2026-10-01".into(),
            cursor: None,
        }
    }
    #[test]
    fn endpoints_are_fixed_and_credentials_stay_in_headers() {
        let client = reqwest::Client::new();
        for source in [
            "openai-org-usage",
            "openai-org-costs",
            "anthropic-org-usage",
            "anthropic-org-costs",
            "cursor-account",
        ] {
            let req = request(&client, &input(source)).unwrap().build().unwrap();
            assert_eq!(req.url().scheme(), "https");
            assert!(!req.url().as_str().contains("test-secret"));
            assert!(matches!(
                req.url().host_str(),
                Some("api.openai.com" | "api.anthropic.com" | "api.cursor.com")
            ));
        }
        assert!(request(&client, &input("https://attacker.test")).is_err());
    }
    #[test]
    fn rejects_invalid_dates_credentials_and_cursor() {
        let mut v = input("cursor-account");
        v.cursor = Some("https://attacker.test".into());
        assert!(request(&reqwest::Client::new(), &v).is_err());
        v.cursor = None;
        v.end_date = "2026-08-01".into();
        assert!(dates(&v).is_err());
        v.end_date = "2026-10-01".into();
        v.credential = "test\nsecret".into();
        assert!(dates(&v).is_err());
    }
}
