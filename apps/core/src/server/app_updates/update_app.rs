//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs: `update_app_handler` through `update_app_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/apps/:id/update` — update an installed plugin by **re-installing the
/// target version from the catalog**, not by trusting the already-loaded manifest.
///
/// # Security (the gap this closes)
///
/// The old handler bumped the store version off `find_manifest` (the in-memory,
/// already-loaded manifest) and called `set_version` — it never re-fetched the
/// target version, never re-ran the ed25519 signature verify, and never re-checked the
/// `ui_code_sha256` integrity gate. An update
/// could therefore swap in UNVERIFIED code. This handler treats an update as a
/// re-install of the new version:
///
/// 1. **Installed?** else 404.
/// 2. **Re-verify by re-resolving** the target from the catalog via
///    [`resolve_plugin_from_catalog`] — the SAME path `install` uses, which runs
///    `verify_manifest_signature` (ed25519) + the fail-closed `ui_code_sha256` gate
///    (inside `install_descriptor`). A tampered bundle, a bad signature, or an
///    unreachable verify gateway all fail HERE — before any mutation,
///    so the OLD version stays fully intact.
/// 3. **Downgrade / no-op gate** ([`plan_update`]) before any mutation.
/// 4. **Resolve + install any NEW dependencies** the new version declares, reusing
///    the exact closure machinery `install_plugin_from_catalog` uses (rollback on
///    partial failure), so an update that adds a dependency never leaves the plugin
///    un-enableable.
/// 5. **Persist**: write the new manifest to disk, then commit the version, the
///    reconciled grants and the `ui_code` in one store write ([`update_app`]). The
///    store transition preserves the `enabled` bit, so a disabled app stays
///    disabled. A store failure restores the previous on-disk manifest, keeping the
///    target transition all-or-nothing.
///
/// Behaviour change (intended): a plugin with no resolvable catalog entry (e.g. one
/// side-loaded via `install-bundle` with no marketplace listing) can no longer be
/// updated through this endpoint — the catalog re-pull is the trust boundary and is
/// mandatory.
///
/// # Release channels
///
/// The re-resolve in step 2 runs on the record's PINNED channel, so an install that
/// followed `beta` keeps getting betas instead of being pulled back to stable the
/// first time it checks for an update.
///
/// A body `channel` switches trains. That is deliberately a different operation
/// from an update, because semver ranks every prerelease BELOW its stable release
/// (`1.2.0-beta.1 < 1.2.0`): moving a stable install onto `beta` is a downgrade by
/// precedence and step 3 would refuse it. An explicit switch therefore carries its
/// own authority — it does not need `force`, the request already said what to do —
/// and the response reports `channel_switch` plus the version delta so the client
/// can show that the new train is behind the old one. The pin is persisted whether
/// or not the version actually moved, so a switch onto a train that happens to be
/// at the same version still changes what the NEXT update follows.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/update",
    tag = "Plugins",
    summary = "Update a plugin",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_app_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<UpdateAppBody>>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{plan_update, update_app, UpdateError, UpdatePlan};

    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }

    let body = body.map(|b| b.0).unwrap_or_default();
    let id = id.trim().to_string();

    // 1. Installed? Capture the record (for the downgrade gate) and the OLD manifest
    //    bytes (to restore disk on a late store failure).
    let record = match state.app_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("app '{id}' is not installed"),
            );
        }
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let old_manifest = find_manifest(&state, &id).await;

    // Which train to re-resolve on: the body's explicit switch, else the pin the
    // record already carries. Normalized the same way the store normalizes it, so
    // `Beta` and `beta` can never read as a switch.
    let requested_channel: Option<String> = body
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_ascii_lowercase);
    let requested_version = body
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_owned);
    if requested_version.as_ref().is_some_and(|value| {
        value.len() > 128
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-+vV".contains(character))
    }) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "`version` must be a semver release tag".to_owned(),
        );
    }
    if requested_channel.is_some() && requested_version.is_some() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "choose either `channel` or an exact `version`, not both".to_owned(),
        );
    }
    let target_channel = requested_channel
        .clone()
        .unwrap_or_else(|| record.channel.clone());
    let switching_channel = requested_version.is_none() && target_channel != record.channel;

    // 2. RE-VERIFY: re-resolve the target from the catalog. This runs the ed25519
    //    signature verify + the fail-closed ui_code integrity gate + optional
    //    account-aware Marketplace behavior (buyer bearer forwarded), all inside
    //    `install_descriptor`.
    //    Nothing is mutated yet — a verify failure leaves the OLD version intact.
    //    Resolution is channel-scoped: a train with no build errors out here (the
    //    resolve reports which channel was asked for) rather than falling back.
    let buyer_token = buyer_bearer_from_headers(&headers);
    let (manifest, ui_code, resolved_provenance) = match resolve_plugin_from_catalog(
        &state,
        &id,
        buyer_token.clone(),
        requested_version
            .is_none()
            .then_some(target_channel.as_str()),
        requested_version.as_deref(),
    )
    .await
    {
        Ok(pair) => pair,
        Err((status, msg)) => return json_error(status, msg),
    };
    if manifest.id != id {
        return json_error(
            StatusCode::BAD_GATEWAY,
            format!("catalog returned manifest `{}` for `{id}`", manifest.id),
        );
    }
    let channel_to_persist = requested_version
        .as_ref()
        .map(|_| crate::update::channel_of(&manifest.version))
        .or_else(|| switching_channel.then(|| target_channel.clone()));

    // 3. Downgrade / no-op gate BEFORE any mutation (one definition: `plan_update`).
    //    An explicit channel switch carries its own authority: every prerelease
    //    ranks below its stable release, so `stable 1.2.0` → `beta 1.2.0-beta.3` is
    //    a semver downgrade and would otherwise 409 asking for a `force` the request
    //    already implied. The delta is reported in the response instead of hidden.
    match plan_update(
        &record.version,
        &manifest.version,
        body.force || switching_channel || requested_version.is_some(),
    ) {
        Ok(UpdatePlan::NoOp) => {
            if body.dry_run {
                return Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "update",
                    "app": record,
                    "fromVersion": record.version,
                    "toVersion": manifest.version,
                    "channel": target_channel,
                    "channelSwitch": switching_channel,
                    "installedDependencies": Vec::<String>::new(),
                }))
                .into_response();
            }
            // The version did not move, but the pin still may have: a switch onto a
            // train that currently sits at the same build is a real change to what
            // the NEXT update follows, so persist it before answering.
            let mut app = record.clone();
            if let Some(channel) = channel_to_persist.as_deref() {
                match state.app_store.set_channel(&id, Some(channel)).await {
                    Ok(Some(updated)) => app = updated,
                    Ok(None) => {}
                    Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                }
            }
            return Json(json!({
                "success": true,
                "app": app,
                "channel": channel_to_persist.as_deref().unwrap_or(target_channel.as_str()),
                "installed_dependencies": Vec::<String>::new(),
            }))
            .into_response();
        }
        Ok(UpdatePlan::Proceed) => {}
        Err(UpdateError::Downgrade {
            installed,
            requested,
        }) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": "downgrade refused",
                    "installed_version": installed,
                    "requested_version": requested,
                    "hint": "pass force=true to override",
                })),
            )
                .into_response();
        }
        Err(UpdateError::Other(e)) => {
            return json_error(StatusCode::UNPROCESSABLE_ENTITY, e.to_string());
        }
    }

    // 3b + 3c. The reverse gates: would this version break an installed dependent?
    if !body.force {
        if let Some(response) = refuse_update_breaking_dependents(&state, &manifest).await {
            return response;
        }
    }

    // 4. Resolve + install any NEW dependencies the new version declares.
    let installed_dependencies =
        match install_new_dependencies_for_update(&state, &manifest, buyer_token, body.dry_run)
            .await
        {
            Ok(deps) => deps,
            Err(response) => return response,
        };

    if body.dry_run {
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "update",
            "app": record,
            "fromVersion": record.version,
            "toVersion": manifest.version,
            "channel": channel_to_persist.as_deref().unwrap_or(target_channel.as_str()),
            "channelSwitch": switching_channel,
            "installedDependencies": installed_dependencies,
        }))
        .into_response();
    }

    // 5a. Keep the version being replaced restorable through
    //     `POST /api/plugins/:id/rollback` (see `plugin_rollback`). Nothing has
    //     been mutated yet, so a snapshot failure refuses the update cleanly.
    if let Err((status, msg)) =
        plugin_rollback::snapshot_before_update(&state, &record, old_manifest.as_ref()).await
    {
        return json_error(status, msg);
    }

    // 5. Persist: write the new manifest to disk, then the store transition
    //    (version + ui_code, enabled preserved). On a store failure restore the
    //    previous on-disk manifest so the target transition is all-or-nothing.
    if let Err((status, msg)) = write_plugin_manifest_to_disk(&manifest).await {
        return json_error(status, msg);
    }
    match update_app(
        &state.app_store,
        &manifest,
        ui_code.as_deref(),
        body.force || switching_channel || requested_version.is_some(),
    )
    .await
    {
        Ok(updated) => {
            // Persist the pin BEFORE reporting success: the record now carries a
            // version off the new train, and leaving the old pin would send the very
            // next update back to the train the user just left.
            let updated = if let Some(channel) = channel_to_persist.as_deref() {
                match state.app_store.set_channel(&id, Some(channel)).await {
                    Ok(Some(record)) => record,
                    Ok(None) | Err(_) => updated,
                }
            } else {
                updated
            };
            // Re-observe the publisher on every update. This is the ONE moment a
            // revoked org verification stops counting: provenance is captured, not
            // fetched at spawn (see `plugins::isolation`), so a capture only
            // refreshes when the plugin is re-resolved from a source. A failure
            // here leaves the previous capture in place rather than clearing it to
            // untrusted — the install did succeed, and the stale-but-real capture
            // is a better record than none.
            let captured_provenance =
                crate::plugins::lifecycle::capture_provenance(&manifest, &resolved_provenance);
            let updated = match state
                .app_store
                .set_provenance(&id, Some(&captured_provenance))
                .await
            {
                Ok(Some(record)) => record,
                Ok(None) | Err(_) => updated,
            };
            reload_manifests_inner(&state).await;
            // Derived ext-API tools go STALE across an update and nothing else here
            // would notice: this handler reloads manifests but never re-runs
            // `activate_plugin`, so the rows lowered from the OLD spec would keep
            // being served against the NEW manifest's declared routes — tools whose
            // paths the update may have renamed or withdrawn, i.e. tools that pass
            // search and describe and then 404 at the proxy.
            //
            // CLEAR, not clear-and-re-lower. Re-arming in place is not available from
            // here: the `OpenApiImport` is built in `apply_sidecars`, which this path
            // does not run, so re-lowering would mean duplicating that arming block
            // and its trust gate — a second door onto the same plane. Clearing instead
            // re-arms the per-sidecar latch, and the NEXT Healthy edge re-lowers:
            // immediately when the update restarts the process, otherwise within one
            // 30s health poll. Serving zero derived tools for that window is strictly
            // better than serving tools built from a spec the app no longer implements.
            //
            // What the re-lowering reads is BOTH halves new, and that took work to be
            // true. The *document* comes from the sidecar that is actually running, but
            // the mount and declared routes it is intersected against are manifest
            // facts, and the armed `OpenApiImport` snapshotted the OLD ones — so a
            // re-lowering used to pair the new spec with the withdrawn manifest. It no
            // longer does: `OpenApiImport` holds `state.app_manifests` and re-reads
            // them at import time, and `reload_manifests_inner` above has already
            // replaced their contents by the time this clear runs. That ordering
            // (reload, THEN clear) is load-bearing — reversed, a Healthy edge landing
            // in between would re-lower against the pre-update manifest and latch it.
            //
            // The clear is plugin-scoped while the store is sidecar-keyed, which is
            // what makes it sweep every one of the app's sidecars rather than the
            // arbitrary one whose key happens to equal the plugin id.
            state.mcp.clear_ext_api_routes(&id);
            // An enabled target must not run on top of disabled dependencies: the
            // new version's new deps were installed disabled above.
            let dependency_enable = plugin_update_deps::enable_dependencies_after_update(
                &state,
                &manifest,
                updated.enabled,
            )
            .await;
            // The app's agents are kept across this update (it never deactivates
            // them), so the new version's identity modes are reconciled here:
            // narrowed when the user never changed the mode, otherwise reported
            // as pending for the user to accept.
            let agent_identity =
                reconcile_app_agent_identities(&state.agent_store, &manifest).await;
            // Live contributions refresh — same lossy `system:plugins` nudge as
            // the enable/disable handlers, so an updated plugin's new contributions
            // reach subscribed shells immediately.
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
            // Storage migration seam: the NEW version's own `plugin_update`
            // hooks run with the from/to versions. Fail-open.
            crate::plugin_host::dispatch_plugin_update(
                &state,
                &id,
                &record.version,
                &manifest.version,
                "update",
            )
            .await;
            let mut payload = json!({
                "success": true,
                "app": updated,
                "channel": channel_to_persist.as_deref().unwrap_or(target_channel.as_str()),
                "installed_dependencies": installed_dependencies,
            });
            dependency_enable.attach(&mut payload);
            if !agent_identity.is_empty() {
                payload["agent_identity"] = json!(agent_identity);
            }
            if switching_channel {
                // Named explicitly so a client can say "moved to beta, which is
                // currently 1.2.0-beta.3 — older than the 1.2.0 you had" instead of
                // rendering a version that silently went backwards.
                payload["channel_switch"] = json!({
                    "from": record.channel,
                    "to": target_channel,
                    "from_version": record.version,
                    "to_version": manifest.version,
                });
            }
            Json(payload).into_response()
        }
        Err(e) => {
            if let Some(old) = &old_manifest {
                let _ = write_plugin_manifest_to_disk(old).await;
            }
            reload_manifests_inner(&state).await;
            let msg = e.to_string();
            let status = if msg.contains("not installed") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}
