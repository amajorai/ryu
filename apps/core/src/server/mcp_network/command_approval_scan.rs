//! Command-approval scan for agents Core cannot gate at the ACP seam.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Command-approval scan for agents Core cannot gate at the ACP seam ────────

/// The `backend` tag sent to the gateway scanner for this route.
///
/// It is **deliberately the same literal** the ACP `request_permission` handler
/// uses (`sidecar/adapters/acp.rs`, `acp_exec_scan_verdict`). The whole point of
/// this endpoint is to give the flagship Pi agent — which never sends
/// `request_permission`, so it never reaches that seam — the *identical* posture
/// every other ACP agent already gets. Today the gateway scanner ignores the
/// backend entirely (`crates/gateway/firewall/src/cmdscan.rs`: `_backend`), so
/// this only matters the day it starts branching on it; on that day Pi must land
/// in the same branch as Claude Code and Codex, not in an unknown one.
pub(in crate::server) const EXEC_SCAN_BACKEND: &str = "acp";

/// Body of `POST /api/exec/scan`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ExecScanBody {
    /// The shell command that is about to run, verbatim.
    pub(in crate::server) command: String,
    /// Attribution only — it tags the gateway's audit row and nothing else.
    ///
    /// Unlike [`CallToolBody::agent_id`] this is **not** validated against the
    /// agent registry, and that asymmetry is load-bearing rather than an
    /// oversight. There, an unknown agent means "no allowlist" ⇒ every tool
    /// permitted, so a 4xx is the fail-*closed* answer. Here the field grants
    /// nothing, and a 4xx would be read by the caller as a transport failure —
    /// which makes it fall back to its own local denylist, i.e. it would fail
    /// **open**. Accepting any label (or none) is the safer behaviour.
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
}

/// Render an [`ExecScanOutcome`] as this route's wire shape.
///
/// `reason` is present on every non-allow verdict and absent on `allow`; the
/// decision strings are the gateway's own (`allow` / `approval_required` /
/// `deny`), round-tripped rather than renamed so the caller can be written
/// against one vocabulary.
pub(in crate::server) fn exec_scan_reply(
    outcome: crate::sidecar::gateway::ExecScanOutcome,
) -> serde_json::Value {
    use crate::sidecar::gateway::ExecScanOutcome;
    match outcome {
        ExecScanOutcome::Allow => json!({ "decision": "allow" }),
        ExecScanOutcome::ApprovalRequired(reason) => {
            json!({ "decision": "approval_required", "reason": reason })
        }
        ExecScanOutcome::Deny(reason) => json!({ "decision": "deny", "reason": reason }),
    }
}

/// `POST /api/exec/scan` — scan a command through gateway policy before it runs.
///
/// ## Why this route exists
///
/// Core's exec/write scan runs **only** inside the ACP `request_permission`
/// handler (`sidecar/adapters/acp.rs`). Pi — the flagship `ryu` agent — never
/// sends `request_permission`, so its built-in `bash` reached the shell with no
/// gateway governance at all while every other ACP agent was covered. This is
/// the seam that closes that gap: `apps/core/assets/pi-extensions/ryu-plan.ts`
/// POSTs here from its `tool_call` hook, blocks the call on `deny`, and raises
/// its user confirmation on `approval_required`.
///
/// How far that goes, stated so nobody reads it as total coverage: the caller
/// treats a failure to REACH this route, or any answer without a valid verdict,
/// as a refusal and blocks the command, so an unreachable Core stops the shell
/// rather than degrading to a weaker gate. Everything here is fail-closed too.
///
/// It is a thin proxy. The policy lives in
/// [`crate::sidecar::gateway::check_exec_scan`] and is **not** reimplemented
/// here — including its fail-closed semantics (an unreachable, non-2xx or
/// unparseable gateway is a `deny` unless `RYU_ALLOW_GATEWAY_FALLBACK=1`, and an
/// explicit `RYU_EXEC_APPROVAL_MODE=off` short-circuits to `allow` without
/// touching the network).
///
/// ## EVERY verdict is HTTP 200, INCLUDING `deny`
///
/// The verdict is the answer, not an error. The caller — a Pi extension that
/// must never hang a turn on the scanner — treats any non-2xx as a transport
/// failure and blocks the command with a generic policy-unavailable reason.
/// So answering `deny` with a 403 would hide the policy's own reason behind an
/// outage message (and an older extension that fell back to its local denylist
/// would run the command). Note that
/// `widgets::widget_follow_up` deliberately DOES return 403 on `Deny` — it has
/// no fallback path, so there the status code is the enforcement. Do not
/// "align" the two.
///
/// An empty `command` is answered `deny` for exactly the same reason: a 400
/// would be indistinguishable from an unreachable Core at the caller.
#[utoipa::path(
    post,
    path = "/api/exec/scan",
    tag = "Tools",
    summary = "Scan a command against gateway exec policy",
    request_body = serde_json::Value,
    responses((status = 200, description = "Verdict", body = serde_json::Value))
)]
pub(in crate::server) async fn exec_scan(
    Json(body): Json<ExecScanBody>,
) -> axum::response::Response {
    let command = body.command.trim();
    if command.is_empty() {
        return Json(json!({
            "decision": "deny",
            "reason": "no command to scan",
        }))
        .into_response();
    }
    let outcome = crate::sidecar::gateway::check_exec_scan(
        EXEC_SCAN_BACKEND,
        command,
        // No session correlation on this path: the extension knows its Pi
        // session id, not Core's conversation id, and the gateway scanner does
        // not consult the field (`ExecScanBody::session_id` is `_`-ignored).
        None,
        body.agent_id.as_deref().filter(|s| !s.is_empty()),
    )
    .await;
    Json(exec_scan_reply(outcome)).into_response()
}
