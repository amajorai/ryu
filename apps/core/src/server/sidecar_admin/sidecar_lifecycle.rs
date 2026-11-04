//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `uninstall_sidecar_with_data` through `support_bundle_dlp_check`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/setup/{name}/uninstall-with-data",
    tag = "Sidecars",
    summary = "Uninstall a sidecar and its data",
    params(
        ("name" = String, Path),
        ("dryRun" = Option<bool>, Query, description = "Return the removal plan without changing files"),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn uninstall_sidecar_with_data(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    Query(query): Query<InstallSidecarQuery>,
) -> Json<serde_json::Value> {
    if query.dry_run {
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "uninstall",
            "name": name,
            "removeData": true,
            "installed": binary_installed_on_disk(&name),
            "writes": ["sidecar binary, runtime, and data files", "install status"],
        }));
    }
    // Clear install status
    state.install_status.clear(&name).await;

    // Use manager to stop and uninstall with data
    match state.manager.uninstall_sidecar(&name, true).await {
        Ok(()) => {
            // Also clear from setup manager
            let _ = state.setup.uninstall_with_data(&name).await;
            Json(json!({
                "success": true,
                "message": format!("Sidecar '{}' uninstalled with data", name)
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    get,
    path = "/api/sidecar/status",
    tag = "Sidecars",
    summary = "Status of all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn sidecar_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    // Serialize `SidecarStatus` directly so the per-engine resource fields
    // (pid/memory_bytes/cpu_percent) ride along; absent fields are skipped by
    // serde, so adopt-mode/serverless engines stay `{name, running}`.
    //
    // ADDITIVE fields (existing readers ignore unknown keys):
    // - `native_permissions`: the C1 seam — each native (unsandboxed) manifest
    //   sidecar's DECLARED permission set plus `enforced:false`, so a reader can
    //   see the recorded-but-not-OS-enforced posture that only the JS sandbox /
    //   wasmtime / Docker lanes actually enforce.
    // - `node_runtime`: which JS runtime a `SidecarProcess::Node` backend would
    //   resolve on PATH (`"bun"` preferred, else `"node"`, else `null`), so a
    //   status reader knows whether node-backed plugins can spawn at all.
    // - `missing_binaries`: every `Local`-kind manifest sidecar whose bytes could
    //   not be installed, with the exact release asset this platform wanted. An
    //   unpublished asset is a permanent 502 through the ext-proxy that is
    //   indistinguishable from "the app crashed" and from "lazily scaled to zero";
    //   this is the only surface that can tell them apart. Empty on a healthy host
    //   (each success path clears its own entry), so any entry is actionable.
    Json(json!({
        "sidecars": state.manager.statuses(),
        "native_permissions": state.manager.native_sidecar_permissions(),
        "node_runtime": resolved_node_runtime_kind(),
        "missing_binaries": crate::sidecar::manifest_sidecar::missing_sidecar_binary_reports(),
    }))
}

/// The JavaScript runtime a node-backend sidecar would use, resolved off `PATH`
/// exactly as `manifest_sidecar::resolve_node_runtime(None)` does (prefer `bun`,
/// then `node`). Returns `None` when neither is installed. Duplicated here (a bare
/// two-entry PATH probe) rather than reaching into `manifest_sidecar` so this stays
/// inside the status-handler change set. Purely informational — the spawn path
/// does its own authoritative resolution.
pub(in crate::server) fn resolved_node_runtime_kind() -> Option<&'static str> {
    let Some(path) = std::env::var_os("PATH") else {
        return None;
    };
    for candidate in ["bun", "node"] {
        for dir in std::env::split_paths(&path) {
            if dir.join(candidate).is_file() {
                return Some(candidate);
            }
            #[cfg(windows)]
            for ext in ["exe", "cmd", "bat"] {
                if dir.join(format!("{candidate}.{ext}")).is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Max redacted trace spans included in a support diagnostic bundle. Bounds the
/// bundle size; spans are content-free (`args_hash` only) by construction.
pub(in crate::server) const SUPPORT_RECENT_SPANS_LIMIT: usize = 50;

/// The canonical observability/privacy pref keys a support bundle reports as
/// "set or not" (KEY presence only, NEVER the value). An allowlist so a value
/// can never leak; mirrors the §6 keys owned by `crate::privacy`.
pub(in crate::server) const SUPPORT_REPORTED_PREF_KEYS: &[&str] = &[
    crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
    crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY,
    crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
    crate::privacy::DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
    crate::privacy::DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY,
    crate::privacy::DIAGNOSTICS_OTLP_MAX_CONTENT_BYTES_PREF_KEY,
    crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
    crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY,
];

/// `GET /api/support-access/diagnostics` — the gated, read-only local diagnostic
/// surface (#546, P5).
///
/// Refuses (403) unless the user has granted the local support channel
/// (`support-access-local-enabled`) AND the hard expiry has not passed — checked
/// live so a grant that expired since startup is also refused (and lazily swept).
/// On grant it returns ONLY the allowlist [`crate::support_access::DiagnosticBundle`]
/// (version, active engine, sidecar liveness, set-pref KEYS, redacted spans) —
/// never prompt/agent content, never credentials/`auth.json`. Every call (grant
/// or refusal) is recorded in the local append-only audit log with the actor
/// (`x-ryu-support-actor` header) stamped.
#[utoipa::path(
    get,
    path = "/api/support-access/diagnostics",
    tag = "Support",
    summary = "Collect support diagnostics (grant-gated, audited)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn support_access_diagnostics(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> (StatusCode, Json<serde_json::Value>) {
    let actor = header_str(&headers, "x-ryu-support-actor")
        .unwrap_or_else(|| crate::support_access::UNKNOWN_ACTOR.to_string());

    // Re-check the grant + expiry live, then lazily sweep a stale grant for
    // defense in depth (the startup sweep is the durable guarantee).
    let _ = crate::support_access::sweep_expired(&state.preferences).await;
    let grant = crate::privacy::support_access_local(&state.preferences).await;
    let now = chrono::Utc::now().timestamp_millis();
    if !crate::support_access::is_open(grant, now) {
        let _ = state
            .support_audit
            .append(&actor, "access_refused", Some("grant off or expired"))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support access is not granted",
                "code": "support_access_off",
            })),
        );
    }

    // Transport gate (#547): the diagnostic bundle may egress ONLY over the
    // opt-in mesh (Tailscale/Headscale). The bundle is *pulled* by a support
    // operator who dials this Core node over the tailnet; we never push it. With
    // the mesh disabled there is no governed private transport, so we refuse
    // (audited) rather than serve it over an arbitrary interface. Reachability
    // over the tailnet plus this enabled-gate is the enforceable proxy for
    // "mesh-only" (peer-IP verification is out of scope under the single-tenant
    // / connections posture; noted as a follow-up).
    if !ryu_mesh::is_enabled() {
        let _ = state
            .support_audit
            .append(&actor, "access_refused", Some("mesh disabled"))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support access requires the mesh (Tailscale) to be enabled so the diagnostic bundle egresses only over the tailnet",
                "code": "support_access_mesh_off",
            })),
        );
    }

    // Gather ONLY the known-safe primitives, then project through the pure
    // allowlist builder (no full-config serialization, no raw args).
    let active_engine = state.manager.active_local_engine().await;
    let sidecars = state
        .manager
        .statuses()
        .into_iter()
        .map(|s| crate::support_access::SidecarLiveness {
            name: s.name,
            running: s.running,
        })
        .collect::<Vec<_>>();

    // Report only WHICH observability prefs are set (key presence), never values.
    let mut preference_keys_set = Vec::new();
    for key in SUPPORT_REPORTED_PREF_KEYS {
        if matches!(state.preferences.get(key).await, Ok(Some(_))) {
            preference_keys_set.push((*key).to_string());
        }
    }

    // Recent redacted spans across the most recent conversations. The trace store
    // is keyed by conversation; reuse the conversation list to gather a bounded,
    // already-content-free window. Spans carry `args_hash` only — never raw args.
    let recent_spans = collect_recent_redacted_spans(&state).await;

    let bundle = crate::support_access::build_bundle(
        env!("CARGO_PKG_VERSION"),
        active_engine,
        sidecars,
        preference_keys_set,
        recent_spans,
        now,
    );

    // Gateway DLP pass (#547): even an allowlist bundle has one free-text field
    // (a capped span `error`) that could echo a secret or PII. Per the
    // Core-vs-Gateway rule, "what is allowed to leave" is the Gateway's job, so
    // we route the egressing bundle text through the gateway firewall
    // (`POST /v1/firewall/check`, pii + secret checks) before it leaves the box —
    // the same governance the workflow Guardrails node uses. On a block we
    // WITHHOLD (the firewall has no sanitize surface for Core to call; block-and-
    // refuse is the design, not rewrite). Fail-CLOSED when the gateway is
    // unreachable, matching `run_guardrails` (override with
    // `RYU_ALLOW_GATEWAY_FALLBACK=1`).
    if let Err(reason) = support_bundle_dlp_check(&bundle).await {
        let _ = state
            .support_audit
            .append(&actor, "access_blocked_dlp", Some(&reason))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "support diagnostic bundle withheld by the gateway firewall",
                "code": "support_access_dlp_block",
                "reason": reason,
            })),
        );
    }

    let _ = state
        .support_audit
        .append(&actor, "diagnostic_bundle_read", None)
        .await;

    (StatusCode::OK, Json(json!({ "diagnostics": bundle })))
}

/// Run the egressing support bundle through the Gateway firewall before it
/// leaves the box (#547). Returns `Ok(())` when the gateway allows it (or no
/// enforceable content is present), and `Err(reason)` when a guardrail trips OR
/// the gateway is unreachable (fail-closed). Mirrors the workflow `run_guardrails`
/// posture, including the `RYU_ALLOW_GATEWAY_FALLBACK=1` escape hatch, so the two
/// egress gates agree. Only the `pii`/`secret` checks are requested — the
/// `jailbreak`/`injection` patterns target inbound prompts, not outbound diagnostics.
pub(in crate::server) async fn support_bundle_dlp_check(
    bundle: &crate::support_access::DiagnosticBundle,
) -> Result<(), String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // Scan ONLY the free-text span `error` strings, not the whole serialized
    // bundle. Every other field is content-free BY CONSTRUCTION (version,
    // sidecar names, pref KEYS, the SHA-256 `args_hash`, the `conversation_id`);
    // feeding those high-entropy identifiers to a secret/PII scanner would risk
    // false-positives that, under fail-closed, would withhold every bundle. The
    // span `error` is the one place a secret/PII could leak (which is exactly why
    // #546 bounds it via `cap_error`), so it is the only thing worth scanning.
    let text = bundle
        .recent_spans
        .iter()
        .filter_map(|s| s.error.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    // Nothing free-text to scan → nothing can leak; allow without a gateway hop.
    if text.trim().is_empty() {
        return Ok(());
    }

    let payload = serde_json::json!({
        "text": text,
        "checks": ["pii", "secret"],
    });

    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|v| v == "1");

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/firewall/check", gateway_url().trim_end_matches('/'));
    // Bounded so a wedged gateway fails closed promptly instead of hanging the
    // caller indefinitely.
    let mut builder = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(15))
        .json(&payload);
    if let Some(token) = gateway_token() {
        builder = builder.bearer_auth(token);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if allow_fallback {
                return Ok(());
            }
            return Err(format!("gateway firewall unreachable (fail-closed): {e}"));
        }
    };
    if !resp.status().is_success() {
        if allow_fallback {
            return Ok(());
        }
        return Err(format!("gateway firewall returned HTTP {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid gateway firewall response: {e}"))?;
    let allowed = body
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        let reason = body
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("firewall guardrail tripped")
            .to_string();
        Err(reason)
    }
}
