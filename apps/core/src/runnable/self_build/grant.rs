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

    // Real grant validation: call the Gateway just like enable_app does.
    // The grant required is "self_build:write". Until the Gateway ships
    // this endpoint, set RYU_STUB_SELF_BUILD_GRANTS=1 to bypass.
    let gateway_url =
        std::env::var("RYU_GATEWAY_URL").unwrap_or_else(|_| "http://127.0.0.1:9090".to_owned());

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{gateway_url}/v1/grants/validate"))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({
            "app_id": app_id,
            "grants": ["self_build:write"]
        }))
        .send()
        .await
        .map_err(|e| {
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

    Ok(())
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
