//! Ingress governance: the Gateway firewall check for text an app or widget
//! pushes into a model turn on the user's behalf.
//!
//! The exec scan (`gateway::check_exec_scan`) those paths already run is the
//! command-risk gate (hardline commands, deletion, supply chain); it has no
//! secret or prompt-injection detectors. [`govern_ingress`] is the content gate:
//! it asks `POST /v1/firewall/check` for the secret and prompt-injection
//! guardrails under the Gateway's resolved node/org/agent policy, and fails
//! closed when the Gateway blocks, errors, answers something unreadable, or is
//! unreachable (only `RYU_ALLOW_GATEWAY_FALLBACK=1` relaxes the outage cases,
//! matching `gateway::govern_egress`).
//!
//! PII is deliberately not requested: the check endpoint hard-blocks on any PII
//! match regardless of the operator's PII action (redact or allow), so asking
//! for it here would refuse every app send that mentions an email address. PII
//! in the turn stays governed by the Gateway's chat firewall policy.

use std::time::Duration;

/// The guardrails an app or widget send must pass before it enters a turn.
pub const INGRESS_CHECKS: &[&str] = &["secret", "prompt_injection"];

const INGRESS_TIMEOUT: Duration = Duration::from_secs(10);

/// Scan `text` with the Gateway firewall before it enters model context.
///
/// `surface` names the caller in refusal messages (`app-send`, `widget-follow-up`).
/// Returns `Err(reason)` when the text must not be sent.
pub async fn govern_ingress(surface: &str, text: &str) -> Result<(), String> {
    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|value| value == "1");
    govern_ingress_at(
        crate::sidecar::gateway::gateway_http_client(),
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token(),
        allow_fallback,
        surface,
        text,
    )
    .await
}

/// [`govern_ingress`] against an explicit Gateway base URL and credential.
pub(crate) async fn govern_ingress_at(
    client: &reqwest::Client,
    base_url: &str,
    token: Option<String>,
    allow_fallback: bool,
    surface: &str,
    text: &str,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let endpoint = format!("{}/v1/firewall/check", base_url.trim_end_matches('/'));
    let mut request = client
        .post(&endpoint)
        .timeout(INGRESS_TIMEOUT)
        .json(&serde_json::json!({ "text": text, "checks": INGRESS_CHECKS }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) if allow_fallback => {
            tracing::warn!(%error, surface, "ingress firewall unreachable; fallback allowed");
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "{surface}: gateway firewall unreachable (fail-closed): {error}"
            ));
        }
    };
    let status = response.status();
    if !status.is_success() {
        if allow_fallback && status.is_server_error() {
            return Ok(());
        }
        return Err(format!(
            "{surface}: gateway firewall returned HTTP {status}"
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("{surface}: invalid gateway firewall response: {error}"))?;
    verdict(surface, &body)
}

/// Only an explicit boolean `allowed: true` lets the text through.
fn verdict(surface: &str, body: &serde_json::Value) -> Result<(), String> {
    if body.get("allowed").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(());
    }
    let reason = body
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .filter(|reason| !reason.trim().is_empty())
        .unwrap_or("no verdict");
    Err(format!(
        "{surface}: blocked by the gateway firewall ({reason})"
    ))
}

#[cfg(test)]
#[path = "ingress_test.rs"]
mod ingress_test;
