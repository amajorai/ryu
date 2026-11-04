//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `enable_app_handler` through `attach_gateway_policy_notice`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/apps/:id/enable` — validate grants via Gateway, then enable.
///
/// Fails closed: if the Gateway is unreachable the app stays disabled and a
/// clear 503 error is returned. If the Gateway denies a grant a 403 is returned.
///
/// After a successful enable the manifest's Runnables are activated via
/// [`crate::runnable::RunnableRegistry`]. Per-Runnable results are included in
/// the response so the caller can see which Runnables were registered and which
/// (if any) encountered a partial failure. A partial failure does NOT roll back
/// the enable — Core-owned kinds (Agent, Workflow, Tool) are activated; kinds
/// without a built-in handler (Policy, Engine — Gateway's domain) produce an
/// observable "no handler" error.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/enable",
    tag = "Plugins",
    summary = "Enable a plugin or preview its activation plan",
    params(("id" = String, Path)),
    request_body = LifecycleDryRunBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn enable_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: axum::http::HeaderMap,
    body: Option<Json<LifecycleDryRunBody>>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{enable_app, plan_enable_app, EnableError};
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_ENABLE,
    )
    .await
    {
        return response;
    }

    if crate::fleet::is_artifact_blocked(&id) {
        return json_error(
            StatusCode::FORBIDDEN,
            format!("app '{id}' is blocked by organization policy"),
        );
    }

    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'; ensure the ryu.json is loaded"),
        );
    };

    // Local revocation, or the opt-in trust requirement for host-access lanes.
    if let Some(refusal) = plugin_host_access_refusal(&state, &manifest).await {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": format!("app '{id}' cannot be enabled: {refusal}"),
                "refusal": refusal,
            })),
        )
            .into_response();
    }

    // Paid Marketplace installs re-check their license at enable: a refund or
    // dispute after install revokes access (bounded offline grace).
    let from_marketplace = state
        .app_store
        .get_record(&id)
        .await
        .ok()
        .flatten()
        .and_then(|record| record.provenance)
        .and_then(|provenance| provenance.source_id)
        .is_some_and(|source| source == MARKETPLACE_PLUGIN_SOURCE_ID);
    if from_marketplace {
        if let Err(response) =
            require_marketplace_enable_license(&state, &headers, "plugin", &id).await
        {
            return response;
        }
    }

    let gw_url = gateway_url();
    let gw_token = gateway_token();

    // The full loaded manifest set — `enable_app` resolves the dependency graph
    // over the INSTALLED subset of these, so a plugin's `requires` edges pull in
    // (and enable, in topological order) whatever it depends on.
    let all_manifests: Vec<crate::plugin_manifest::PluginManifest> =
        state.app_manifests.read().await.clone();

    let dry_run = body.is_some_and(|body| body.0.dry_run);
    let outcome = match if dry_run {
        plan_enable_app(
            &state.app_store,
            &manifest,
            &all_manifests,
            &gw_url,
            gw_token.as_deref(),
            &state.client,
        )
        .await
    } else {
        enable_app(
            &state.app_store,
            &manifest,
            &all_manifests,
            &gw_url,
            gw_token.as_deref(),
            &state.client,
        )
        .await
    } {
        Ok(outcome) => outcome,
        Err(EnableError::GrantsDenied { plugin, denied }) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "success": false,
                    "error": "Gateway denied one or more grants",
                    // May be an auto-enabled DEPENDENCY rather than the plugin the
                    // user clicked — name it so the UI can say which.
                    "plugin": plugin,
                    "denied_grants": denied,
                })),
            )
                .into_response();
        }
        Err(EnableError::GatewayUnreachable { reason }) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "success": false,
                    "error": "Gateway unreachable; enable fails closed",
                    "reason": reason,
                })),
            )
                .into_response();
        }
        // The dependency graph could not be satisfied (missing dep, version too
        // low, cycle). Nothing was enabled — the graph resolves before any
        // enabled bit flips. 409: the request is well-formed but conflicts with
        // the current install state. The typed payload lets the desktop render
        // "install X first" without string-parsing.
        Err(EnableError::Dependency(e)) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": e.to_string(),
                    "dependency_error": e,
                })),
            )
                .into_response();
        }
        // A required capability could not be bound to a provider (none installed,
        // ambiguous with no override, or version floor unmet). Nothing was enabled.
        // 409 like a dependency conflict; the typed code lets the desktop offer the
        // right fix (install a provider / choose one).
        Err(EnableError::Binding { plugin, source }) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": source.to_string(),
                    "plugin": plugin,
                    "binding_error": source.code(),
                })),
            )
                .into_response();
        }
        Err(EnableError::Other(e)) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };

    if dry_run {
        let planned_ids: Vec<String> = outcome
            .in_enable_order()
            .map(|record| record.id.clone())
            .collect();
        let app = outcome.target.clone();
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "enable",
            "app": app,
            "wouldEnable": planned_ids,
            "enabledDependencies": outcome.dependencies.iter().map(|record| record.id.clone()).collect::<Vec<_>>(),
            "approvedGrants": outcome.target.approved_grants,
        }))
        .into_response();
    }

    // Activate EVERY plugin this call enabled, in enable order (dependencies
    // first, target last). Flipping a dependency's enabled bit without running
    // its activation side effects would leave it half-enabled — its runnables
    // unregistered, its policy flags off, its sidecars not started.
    let mut runnable_statuses: Vec<serde_json::Value> = Vec::new();
    let mut enabled_dependencies: Vec<String> = Vec::new();
    let mut policy_outcome = PolicyApplyOutcome::default();

    for record in outcome.in_enable_order() {
        let plugin_manifest = if record.id == manifest.id {
            manifest.clone()
        } else {
            match all_manifests.iter().find(|m| m.id == record.id) {
                Some(m) => m.clone(),
                None => {
                    tracing::warn!(
                        "plugin enable: no manifest for auto-enabled dependency '{}'",
                        record.id
                    );
                    continue;
                }
            }
        };

        let (statuses, outcome) = activate_plugin(&state, &plugin_manifest, record).await;
        policy_outcome = policy_outcome.merge(outcome);

        if record.id == manifest.id {
            runnable_statuses = statuses;
        } else {
            enabled_dependencies.push(record.id.clone());
        }
    }

    // Live contributions refresh: tell every desktop shell subscribed to the
    // `system:plugins` room that the enabled-plugin set changed, so it can
    // invalidate its cached `GET /api/plugins/contributions` read immediately
    // instead of waiting out the poll window. Typed named-event contract
    // (`ryu_realtime::RoomRegistry::broadcast_event`): no-op if the room is not
    // live, lossy by design — fine for cache invalidation (remote/missed clients
    // fall back to the poll). The payload carries a self-describing `type`
    // because the wire envelope drops the event NAME before reaching clients
    // (`frame_to_message` in `server/realtime_ws.rs`).
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        json!({"type": "contributions_changed"}),
    );

    let mut body = json!({
        "success": true,
        "app": outcome.target,
        "runnables": runnable_statuses,
        // Dependencies auto-enabled to satisfy this plugin's `requires`, in the
        // order they were enabled. Empty in the common no-dependency case.
        "enabled_dependencies": enabled_dependencies,
    });
    // Truth-in-advertising: if a gateway-enforced policy (firewall/routing/
    // compression) was toggled but the gateway is externally managed, the enable
    // STILL succeeded (the record is enabled) — but the running gateway was NOT
    // reconfigured, so the control is inert until a manual restart. Say so instead
    // of silently reporting a security control as ON. Only emitted when a gateway
    // policy was actually touched, to avoid noise on ordinary enables.
    attach_gateway_policy_notice(&mut body, policy_outcome);
    Json(body).into_response()
}

/// Attach the `externally_managed` truth to an enable/disable/uninstall response
/// body when a gateway-enforced policy was toggled. Emits the SAME `externally_managed`
/// + `notice` keys `gateway_config_write` uses for the identical condition
/// (`refresh() == Ok(false)`), so any surface that already understands that shape
/// handles this too.
///
/// Only emitted when `gateway_touched` is set: an enable/disable that changed no
/// firewall/routing/compression policy never went near the gateway, so the fields
/// would be meaningless noise. `externally_managed` is only ever `true` for the
/// respawn-only compression policy; firewall/routing hot-swap live via PUT
/// /v1/config and report `externally_managed: false` even against a remote gateway.
pub(in crate::server) fn attach_gateway_policy_notice(
    body: &mut serde_json::Value,
    outcome: PolicyApplyOutcome,
) {
    if !outcome.gateway_touched {
        return;
    }
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    obj.insert(
        "externally_managed".to_owned(),
        json!(outcome.gateway_externally_managed),
    );
    if outcome.gateway_externally_managed {
        obj.insert(
            "notice".to_owned(),
            json!(
                "a respawn-only gateway policy (compression) was toggled, but the gateway is \
                 externally managed (RYU_GATEWAY_MANAGED=0); the running gateway was NOT \
                 reconfigured. Restart the gateway process for this change to take effect. \
                 (firewall/routing toggles hot-swap live via PUT /v1/config and are unaffected.)"
            ),
        );
    }
}
