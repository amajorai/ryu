//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `set_active_model` through `set_active_model`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/models/active { id }` — switch the GGUF the local chat engine
/// serves to an already-installed model.
///
/// `id` is resolved to the local stem of a file present on disk; switching to a
/// model the user never downloaded is refused (400). The choice is persisted in
/// preferences, then the resident local engine (if any) is restarted so it
/// reloads with the new `--model`, and the gateway's `local` provider is
/// refreshed. When no local engine is currently resident the choice still
/// persists and takes effect on next start.
#[utoipa::path(
    post,
    path = "/api/models/active",
    tag = "Models",
    summary = "Switch the active served local chat model or preview the switch",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_active_model(
    State(state): State<ServerState>,
    Json(body): Json<SetActiveModelBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::model_catalog::installed;

    // 1. Resolve to a structured selection for an install present on disk.
    let Some(mut selection) = installed::resolve_active(body.id.trim()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("'{}' is not installed — install it before switching", body.id),
            })),
        );
    };

    // 1b. Diffusion GGUFs are not chat models — route them to sd-server instead
    //     of the LOCAL_ENGINES chat-engine swap.
    if selection.format == crate::model_format::ModelFormat::Gguf
        && crate::model_catalog::capabilities::detect_local_is_diffusion(&selection.r#ref)
    {
        if let Some(reason) = crate::sidecar::providers::sdcpp::activation_refusal(&selection.r#ref)
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": reason, "diffusion": true })),
            );
        }
        if body.dry_run {
            let current = state
                .preferences
                .get(installed::ACTIVE_DIFFUSION_MODEL_PREF)
                .await
                .ok()
                .flatten();
            return (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "switch",
                    "active": selection.r#ref,
                    "engine": "sdcpp",
                    "format": selection.format.as_str(),
                    "diffusion": true,
                    "current": current,
                    "alreadyActive": current.as_deref() == Some(selection.r#ref.as_str()),
                    "wouldPersist": true,
                    "wouldRestart": true,
                    "wouldRefreshGateway": false,
                    "writes": ["active diffusion model preference", "sdcpp sidecar restart"]
                })),
            );
        }
        if let Err(e) = state
            .preferences
            .set(installed::ACTIVE_DIFFUSION_MODEL_PREF, &selection.r#ref)
            .await
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("could not persist diffusion model: {e}") }),
                ),
            );
        }
        // Best-effort restart so sd-server reloads with the new model weights.
        if let Err(e) = state.manager.restart_sidecar("sdcpp").await {
            tracing::warn!("could not restart sdcpp after diffusion model switch: {e}");
        }
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "engine": "sdcpp",
                "ref": selection.r#ref,
                "diffusion": true,
            })),
        );
    }

    // 2. Derive the engine: an explicit override wins; otherwise pick the best
    //    node-supported engine for the model's format (preferring the resident
    //    one). No supported engine ⇒ 400 (annotate-only on this node).
    let resident = state.manager.active_local_engine().await;
    let picked = match body.engine.as_deref().filter(|e| !e.is_empty()) {
        Some(explicit) => explicit.to_string(),
        None => match crate::model_format::pick_engine(
            selection.format,
            resident.as_deref(),
            crate::catalog::registry::supported_on_node,
        ) {
            Some(e) => e.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "success": false,
                        "error": format!(
                            "no installed engine serves {} on this node",
                            selection.format.as_str()
                        ),
                    })),
                );
            }
        },
    };
    selection.engine = picked.clone();

    if body.dry_run {
        let current = state
            .preferences
            .get(installed::ACTIVE_MODEL_PREF)
            .await
            .ok()
            .flatten()
            .and_then(|raw| installed::parse_active_pref(&raw));
        let already_active = current.as_ref().is_some_and(|active| {
            active.r#ref == selection.r#ref && active.engine == picked.as_str()
        });
        let would_swap = resident.as_deref() != Some(picked.as_str());
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "switch",
                "active": selection.r#ref,
                "engine": picked,
                "format": selection.format.as_str(),
                "current": current.as_ref().map(|active| active.r#ref.clone()),
                "alreadyActive": already_active,
                "residentEngine": resident,
                "wouldPersist": true,
                "wouldSwap": would_swap,
                "wouldRestart": !would_swap,
                "wouldRefreshGateway": true,
                "writes": [
                    "active model preference",
                    "local engine selection",
                    "local gateway provider refresh"
                ]
            })),
        );
    }

    // 3. Persist the structured selection FIRST, so the engine we start in the
    //    next step boots already pointed at the right model (the provider's
    //    `start()` reads this pref and matches on `engine`, so it MUST be written
    //    before the swap — decision 9). `engine` is the value we hand to
    //    `set_active_local_engine` below and which it makes resident, so the two
    //    records agree on success. To avoid drift when the swap FAILS (decision
    //    11), snapshot the prior pref and restore it if activation errors.
    let prior_pref = state
        .preferences
        .get(installed::ACTIVE_MODEL_PREF)
        .await
        .ok()
        .flatten();
    if let Err(e) = state
        .preferences
        .set(
            installed::ACTIVE_MODEL_PREF,
            &installed::encode_active_pref(&selection),
        )
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": format!("could not persist selection: {e}") })),
        );
    }

    // 4. Make the picked engine resident. A swap starts it fresh (already reading
    //    the pref we just wrote); an idempotent no-op means it was already
    //    resident and must be restarted to reload the new weights.
    let mut restarted = false;
    let swap = match state.manager.set_active_local_engine(&picked).await {
        Ok(swap) => swap,
        Err(e) => {
            // Activation failed — restore the prior pref so the persisted
            // selection never claims an engine that isn't actually resident
            // (no drift from the authoritative active-engine store). An empty
            // string clears it (`parse_active_pref` treats empty as unset).
            let restore = prior_pref.unwrap_or_default();
            let _ = state
                .preferences
                .set(installed::ACTIVE_MODEL_PREF, &restore)
                .await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("could not activate engine '{picked}': {e}") }),
                ),
            );
        }
    };
    if swap.unchanged {
        // 5. No swap happened (engine already resident) — restart it so it picks
        //    up the new model. Restart the PICKED engine, not the prior resident.
        match state.manager.restart_sidecar(&picked).await {
            Ok(()) => restarted = true,
            Err(e) => {
                tracing::warn!("could not restart engine '{picked}' after model switch: {e}")
            }
        }
    }

    // 6. Re-point the gateway's `local` provider at the now-active engine.
    let mut gateway_refreshed = true;
    if let Err(e) = state.gateway.refresh().await {
        tracing::warn!("gateway: refresh after model switch failed: {e}");
        gateway_refreshed = false;
    }

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "active": selection.r#ref,
            "engine": picked,
            "format": selection.format.as_str(),
            "swapped": !swap.unchanged,
            "restarted": restarted,
            "gateway_refreshed": gateway_refreshed,
        })),
    )
}
