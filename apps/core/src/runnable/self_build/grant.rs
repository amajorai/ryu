use super::*;

use anyhow::{anyhow, Result};
use serde_json::json;

// ── Grant check ──────────────────────────────────────────────────────────────

/// Check that the calling agent has the `self_build:write` grant. In stub mode
/// (`RYU_STUB_SELF_BUILD_GRANTS=1`) this always succeeds (logged at WARN).
pub(super) async fn check_self_build_grant(app_id: &str) -> Result<()> {
    if is_stub_mode() {
        tracing::warn!(
            app_id,
            "self-build grant check: RYU_STUB_SELF_BUILD_GRANTS=1 — \
             bypassing Gateway grant validation (stub seam; \
             real grant: 'self_build:write' via /v1/grants/validate)"
        );
        return Ok(());
    }

    // Real grant validation: call the Gateway just like enable_app does,
    // through the same routed URL and bearer the enable path uses.
    check_self_build_grant_at(
        app_id,
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token().as_deref(),
    )
    .await
}

/// The grant self-build tools require.
const SELF_BUILD_WRITE_GRANT: &str = "self_build:write";

/// Ask the Gateway at `gateway_base_url` whether `app_id` holds
/// `self_build:write`. The Gateway answers HTTP 200 for both approval and
/// denial (the decision is in the body), so a 2xx alone authorizes nothing:
/// the body must explicitly approve the grant. Every other outcome fails closed.
pub(super) async fn check_self_build_grant_at(
    app_id: &str,
    gateway_base_url: &str,
    gateway_token: Option<&str>,
) -> Result<()> {
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!(
            "{}/v1/grants/validate",
            gateway_base_url.trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({
            "app_id": app_id,
            "grants": [SELF_BUILD_WRITE_GRANT]
        }));
    if let Some(token) = gateway_token {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| {
        anyhow!(
            "Gateway unreachable for self_build grant check (fail-closed): {e}. \
             Set RYU_STUB_SELF_BUILD_GRANTS=1 to bypass in dev."
        )
    })?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "Gateway denied self_build:write grant (HTTP {}). \
             The agent must be granted 'self_build:write' before scaffolding.",
            resp.status()
        ));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| {
        anyhow!("invalid JSON from Gateway self_build grant check (fail-closed): {e}")
    })?;
    ensure_self_build_write_approved(&body)
}

/// Accept only a well-formed body that approves exactly `self_build:write`:
/// `all_approved == true`, the grant listed in `approved`, nothing in `denied`.
pub(super) fn ensure_self_build_write_approved(body: &serde_json::Value) -> Result<()> {
    let strings = |key: &str| -> Result<Vec<String>> {
        body.get(key)
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .ok_or_else(|| {
                anyhow!(
                    "invalid self_build grant validation response: {key} must be a string array"
                )
            })
    };
    let approved = strings("approved")?;
    let denied = strings("denied")?;
    let all_approved = body
        .get("all_approved")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| {
            anyhow!("invalid self_build grant validation response: all_approved must be a boolean")
        })?;

    if all_approved
        && denied.is_empty()
        && approved.len() == 1
        && approved[0] == SELF_BUILD_WRITE_GRANT
    {
        return Ok(());
    }
    Err(anyhow!(
        "Gateway denied self_build:write grant. \
         The agent must be granted 'self_build:write' before scaffolding."
    ))
}

fn is_stub_mode() -> bool {
    // The stub is a local development seam only. A release build must never
    // allow an environment variable to turn the Gateway authorization check
    // into a no-op.
    #[cfg(not(debug_assertions))]
    {
        return false;
    }
    #[cfg(debug_assertions)]
    match std::env::var(ENV_STUB_GRANTS) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

// ── Kind parsing ──────────────────────────────────────────────────────────────

pub(super) fn parse_runnable_kind(s: &str) -> Result<crate::runnable::RunnableKind> {
    use crate::runnable::RunnableKind;
    match s {
        "agent" => Ok(RunnableKind::Agent),
        "workflow" => Ok(RunnableKind::Workflow),
        "tool" => Ok(RunnableKind::Tool),
        "skill" => Ok(RunnableKind::Skill),
        "companion" => Ok(RunnableKind::Companion),
        "channel" => Ok(RunnableKind::Channel),
        "engine" => Ok(RunnableKind::Engine),
        "policy" => Ok(RunnableKind::Policy),
        other => Err(anyhow!(
            "unknown runnable kind '{other}'; valid: agent, workflow, tool, skill, companion, channel, engine, policy"
        )),
    }
}
