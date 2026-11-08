//! Vercel project environment variables:
//! `POST /v10/projects/{project}/env?upsert=true[&teamId=…]` with every key in
//! one array, as `encrypted` variables for the store's targets. Vercel can
//! answer that call with a success status yet list rejected entries under
//! `failed`; any such entry fails the push.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::{connect, endpoint, is_identifier, status_error, token, StoreCredentials, StoreRecord};
use crate::vault::external::net;

/// Vercel's limit for one environment variable value.
const MAX_VALUE_BYTES: usize = 64 * 1024;

fn with_team(mut url: url::Url, store: &StoreRecord) -> url::Url {
    if let Some(team) = store.options.team_id.as_deref() {
        url.query_pairs_mut().append_pair("teamId", team);
    }
    url
}

/// Whether `name` is a portable environment variable name
/// (`[A-Za-z_][A-Za-z0-9_]*`).
pub fn is_valid_env_name(name: &str) -> bool {
    is_identifier(name, &[]) && !name.as_bytes()[0].is_ascii_digit()
}

/// The rejected entries of a batch upsert reply, as `KEY (code)` labels.
///
/// Only names and error codes are kept: messages are dropped so no response
/// text (which could quote a value) reaches the destination's error.
pub fn rejected_entries(body: &Value, sent: &BTreeMap<String, String>) -> Vec<String> {
    let Some(failed) = body.get("failed").and_then(Value::as_array) else {
        return Vec::new();
    };
    failed
        .iter()
        .map(|entry| {
            let error = entry.get("error").unwrap_or(entry);
            let key = error
                .get("key")
                .or_else(|| entry.get("key"))
                .and_then(Value::as_str)
                .filter(|key| sent.contains_key(*key))
                .unwrap_or("unknown key");
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .filter(|code| code.len() <= 64 && is_identifier(code, b"-."))
                .unwrap_or("rejected");
            format!("{key} ({code})")
        })
        .collect()
}

/// Read the project (proves the token reaches it) without reading values.
pub async fn check(store: &StoreRecord, credentials: &StoreCredentials) -> Result<()> {
    let (base, http) = connect(store).await?;
    let url = with_team(
        endpoint(&base, &["v9", "projects", &store.project_id])?,
        store,
    );
    let response = http
        .get(url)
        .bearer_auth(token(credentials)?)
        .send()
        .await
        .context("Vercel project lookup")?;
    if !response.status().is_success() {
        return Err(status_error("Vercel project lookup", response.status()));
    }
    Ok(())
}

pub async fn push(
    store: &StoreRecord,
    credentials: &StoreCredentials,
    values: &BTreeMap<String, String>,
) -> Result<usize> {
    for (name, value) in values {
        if !is_valid_env_name(name) {
            bail!("`{name}` is not a valid Vercel environment variable name; push aborted");
        }
        if value.len() > MAX_VALUE_BYTES {
            bail!("`{name}` is larger than Vercel allows; push aborted");
        }
    }
    if values.is_empty() {
        return Ok(0);
    }
    let (base, http) = connect(store).await?;
    let mut url = endpoint(&base, &["v10", "projects", &store.project_id, "env"])?;
    url.query_pairs_mut().append_pair("upsert", "true");
    let url = with_team(url, store);
    let body: Vec<Value> = values
        .iter()
        .map(|(key, value)| {
            json!({
                "key": key,
                "value": value,
                "type": "encrypted",
                "target": store.options.vercel_targets,
            })
        })
        .collect();
    let response = http
        .post(url)
        .bearer_auth(token(credentials)?)
        .json(&body)
        .send()
        .await
        .context("Vercel environment write")?;
    if !response.status().is_success() {
        return Err(status_error("Vercel environment write", response.status()));
    }
    let reply = net::read_json(response).await?;
    let rejected = rejected_entries(&reply, values);
    if !rejected.is_empty() {
        bail!(
            "Vercel rejected {} of {} variables: {}",
            rejected.len(),
            values.len(),
            rejected.join(", ")
        );
    }
    Ok(values.len())
}
