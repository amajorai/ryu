//! Gateway config write, status and control-plane proxies: `gateway_doctor` through `gateway_doctor_report`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/gateway/doctor` — proxy the Gateway's read-only doctor and append
/// Core-owned approval and agent-egress coverage findings. The browser never
/// receives the Gateway admin token.
#[utoipa::path(
    get,
    path = "/api/gateway/doctor",
    tag = "Gateway",
    summary = "Run the Gateway and Core doctor",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_doctor(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_VIEW,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: gateway.view" })),
        );
    }
    gateway_doctor_report(State(state)).await
}

pub(in crate::server) async fn gateway_doctor_report(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();
    let mut req = state
        .client
        .get(format!("{base}/v1/doctor"))
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(token) = token.as_deref() {
        req = req.bearer_auth(token);
    }

    let response = match req.send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "reachable": false,
                    "error": error.to_string(),
                })),
            );
        }
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut report = match response.json::<serde_json::Value>().await {
        Ok(report) => report,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "reachable": false,
                    "error": format!("Gateway doctor returned invalid JSON: {error}"),
                })),
            );
        }
    };
    if !status.is_success() {
        return (status, Json(report));
    }

    let Some(mut findings) = report
        .get("findings")
        .and_then(serde_json::Value::as_array)
        .cloned()
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "reachable": false,
                "error": "Gateway doctor response did not contain findings",
            })),
        );
    };

    let add_finding = |findings: &mut Vec<serde_json::Value>,
                       check_id: &str,
                       category: &str,
                       severity: &str,
                       summary: &str,
                       detail: &str,
                       setting_path: &str,
                       recommended_action: &str| {
        findings.push(json!({
            "checkId": check_id,
            "category": category,
            "severity": severity,
            "summary": summary,
            "detail": detail,
            "settingPath": setting_path,
            "recommendedAction": recommended_action,
            "canAutoFix": false,
        }));
    };

    let approval_mode = state
        .preferences
        .get(crate::approvals::policy::APPROVAL_MODE_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    if approval_mode.trim().eq_ignore_ascii_case("off") {
        add_finding(
            &mut findings,
            "core.approvals-disabled",
            "security",
            "warning",
            "Human approval prompts are disabled",
            "Core will not pause on globally risky tool actions. Per-agent policy layers may still add approvals.",
            "approval-mode",
            "Use Balanced or Guarded posture, or enable Smart approval mode in Core settings.",
        );
    }

    let exec_scan_mode = state
        .preferences
        .get(crate::exec_approval::EXEC_APPROVAL_MODE_PREF_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    if exec_scan_mode.trim().eq_ignore_ascii_case("off") {
        add_finding(
            &mut findings,
            "core.command-scan-disabled",
            "security",
            "error",
            "Native command scanning is disabled",
            "Claude, Codex, and other ACP native commands can run without the Gateway command-scan gate.",
            "exec-approval-mode",
            "Re-arm command scanning unless this is an intentional break-glass exception.",
        );
    }

    let claude_raw = state
        .preferences
        .get(crate::claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY)
        .await
        .ok()
        .flatten();
    let codex_raw = state
        .preferences
        .get(crate::codex_config::CODEX_GATEWAY_ROUTING_PREF_KEY)
        .await
        .ok()
        .flatten();
    let route_enabled = |value: Option<String>, default: bool| {
        value
            .map(|value| match value.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "on" | "yes" => true,
                "false" | "0" | "off" | "no" => false,
                _ => default,
            })
            .unwrap_or(default)
    };
    let claude_routed = route_enabled(
        claude_raw,
        crate::claude_config::DEFAULT_CLAUDE_GATEWAY_ROUTING,
    );
    let codex_routed = route_enabled(
        codex_raw,
        crate::codex_config::DEFAULT_CODEX_GATEWAY_ROUTING,
    );
    let parse_generic_route = |value: &serde_json::Value| match value {
        serde_json::Value::Bool(value) => Some(*value),
        serde_json::Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "on" | "yes" => Some(true),
            "false" | "0" | "off" | "no" => Some(false),
            _ => None,
        },
        serde_json::Value::Number(value) => value.as_i64().map(|value| value != 0),
        _ => None,
    };
    let generic_routing = state
        .preferences
        .get(crate::agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| value.as_object().cloned())
        .map(|entries| {
            let mut has_valid_entry = false;
            let mut any_enabled = false;
            for value in entries.values() {
                if let Some(enabled) = parse_generic_route(value) {
                    has_valid_entry = true;
                    any_enabled |= enabled;
                }
            }
            if has_valid_entry {
                any_enabled
            } else {
                crate::agent_routing::DEFAULT_AGENT_GATEWAY_ROUTING
            }
        });
    let generic_routing =
        generic_routing.unwrap_or(crate::agent_routing::DEFAULT_AGENT_GATEWAY_ROUTING);

    if !(claude_routed || codex_routed || generic_routing) {
        add_finding(
            &mut findings,
            "coverage.agent-egress-bypass",
            "coverage",
            "warning",
            "Agent model traffic is not routed through Gateway",
            "Claude, Codex, and generic agent egress are all explicitly opted out of Gateway governance. Native agent traffic may bypass Gateway firewall, budget, and audit controls.",
            "agent-gateway-routing",
            "Keep the governed default, or remove explicit direct-egress opt-outs for the agents that should be covered.",
        );
    }

    if let Some(posture) = state
        .preferences
        .get("gateway-posture")
        .await
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
    {
        report["posture"] = serde_json::Value::String(posture);
    }

    report["findings"] = serde_json::Value::Array(findings.clone());

    if let Some(counts) = report.get_mut("counts") {
        let mut errors = 0usize;
        let mut warnings = 0usize;
        let mut info = 0usize;
        for finding in findings.iter() {
            match finding.get("severity").and_then(serde_json::Value::as_str) {
                Some("error") => errors += 1,
                Some("warning") => warnings += 1,
                _ => info += 1,
            }
        }
        *counts = json!({ "errors": errors, "warnings": warnings, "info": info });
    }

    (StatusCode::OK, Json(report))
}
