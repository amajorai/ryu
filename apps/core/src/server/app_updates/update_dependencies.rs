//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs: `refuse_update_breaking_dependents` through `install_new_dependencies_for_update`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The reverse gates of [`update_app_handler`] (steps 3b and 3c), run unless
/// the caller passed `force`: the refusal to answer with when moving to
/// `manifest` would break an installed dependent, else `None`.
pub(in crate::server) async fn refuse_update_breaking_dependents(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Option<axum::response::Response> {
    // 3b. REVERSE gate: would this new version break something already installed?
    //
    //     Step 4 below validates the target's FORWARD edges (target -> its own
    //     dependencies). It structurally cannot see the reverse edges, which live on
    //     OTHER manifests: moving `@ryu/spaces` 1.2.0 -> 2.0.0 while an installed
    //     `@ryu/meetings` declares `">=1.2, <2"` satisfies every forward edge and
    //     still leaves a broken dependent enabled. Refuse by default and name the
    //     blocker; `force=true` is the deliberate override, matching how `disable`
    //     treats its own `blocked_by_dependents` refusal. An explicit `version`
    //     pin only carries downgrade authority (step 3), not "break my
    //     dependents" authority — rollback gates the same way.
    let installed_now: Vec<crate::plugin_manifest::PluginManifest> =
        state.app_manifests.read().await.clone();
    if let Err(dep_err) =
        crate::plugins::graph::validate_dependents_of_update(manifest, &installed_now)
    {
        return Some(
            (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": dep_err.to_string(),
                    "dependency_error": dep_err,
                    "hint": "pass force=true to update anyway",
                })),
            )
                .into_response(),
        );
    }
    // 3c. The capability half of the reverse gate: an enabled consumer must still
    //     bind once this version's `provides` replaces the installed one.
    if let Some(response) = plugin_rollback::refuse_capability_breaking_transition(
        state,
        manifest,
        "pass force=true to update anyway",
    )
    .await
    {
        return Some(response);
    }
    None
}

/// Resolve + install any dependencies the UPDATED manifest declares that are not
/// already installed, reusing the exact closure machinery
/// [`install_plugin_from_catalog`] uses (one resolver, one signature/ui_code gate
/// per dependency, rollback on partial failure). The target itself is NOT installed
/// here — it is an update, persisted separately by [`update_app`]. Returns the ids
/// of the plugins newly installed as dependencies (empty when the new version adds
/// none).
pub(in crate::server) async fn install_new_dependencies_for_update(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    buyer_token: Option<String>,
    dry_run: bool,
) -> Result<Vec<String>, axum::response::Response> {
    use crate::plugin_manifest::PluginManifest;

    let installed: Vec<PluginManifest> = state.app_manifests.read().await.clone();

    // ── Discovery: BFS over the NEW manifest's declared edges; fetch what is not
    //    installed (installed deps are already satisfied). Each fetch goes through
    //    the SAME verify seam as the target. The visited-set (seeded with the target
    //    so it is never fetched as its own dependency) terminates cyclic data.
    let mut fetched: Vec<PluginManifest> = Vec::new();
    let mut ui_codes: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Captured per resolved id so the install sink can persist WHO served each
    // manifest — including dependencies, which are installed on the user's behalf
    // and would otherwise land with no provenance at all (i.e. untrusted).
    let mut provenances: std::collections::HashMap<
        String,
        crate::plugins::isolation::PluginProvenance,
    > = std::collections::HashMap::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();

    visited.insert(manifest.id.clone());
    for dep in manifest.dependencies() {
        queue.push_back(dep.id.clone());
    }

    while let Some(next) = queue.pop_front() {
        if !visited.insert(next.clone()) {
            continue;
        }
        if visited.len() > crate::plugins::catalog::MAX_INSTALL_CLOSURE {
            return Err(json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "`{}` pulls in more than {} plugins; refusing the update",
                    manifest.id,
                    crate::plugins::catalog::MAX_INSTALL_CLOSURE
                ),
            ));
        }

        if let Some(m) = installed.iter().find(|m| m.id == next) {
            // Already installed: still walk its edges so a NEW dep behind an
            // installed one is discovered.
            for dep in m.dependencies() {
                if !visited.contains(&dep.id) {
                    queue.push_back(dep.id.clone());
                }
            }
            continue;
        }

        // A dependency resolves on its own default train, never the target's — see
        // the note on `resolve_plugin_from_catalog`.
        match resolve_plugin_from_catalog(state, &next, buyer_token.clone(), None, None).await {
            Ok((m, ui_code, provenance)) => {
                provenances.insert(next.clone(), provenance);
                if m.id != next {
                    return Err(json_error(
                        StatusCode::BAD_GATEWAY,
                        format!("catalog returned manifest `{}` for `{next}`", m.id),
                    ));
                }
                if let Some(code) = ui_code {
                    ui_codes.insert(next.clone(), code);
                }
                for dep in m.dependencies() {
                    if !visited.contains(&dep.id) {
                        queue.push_back(dep.id.clone());
                    }
                }
                fetched.push(m);
            }
            // A dependency no source can serve is left OUT; the planner reports it as
            // a typed MissingDependency below (naming who needs it + the version).
            Err((_, msg)) => {
                tracing::warn!(plugin = %next, "update dependency could not be resolved: {msg}");
                continue;
            }
        }
    }

    // NOTE: deliberately NO `if fetched.is_empty() { return }` short-circuit here.
    // An empty `fetched` does NOT mean "nothing to check": the commonest breaking
    // update declares no NEW dependency and merely RAISES the `min_version` floor on
    // one already installed. `plan_update_dep_closure` documents that exact case as
    // surfacing a typed `VersionMismatch` — a short-circuit on `fetched.is_empty()`
    // returned Ok before the planner ever ran, so the documented guarantee never
    // fired and the update proceeded onto an under-version dependency. The planner
    // is pure and in-memory, so always running it costs nothing; with nothing new to
    // install it validates the forward edges and returns an empty order.

    // ── Plan: the pure update-closure planner (target excluded, installed
    //    subtracted, NEW edges seen). One resolver, tested in `plugins::lifecycle`.
    let dep_order =
        match crate::plugins::lifecycle::plan_update_dep_closure(manifest, &installed, &fetched) {
            Ok(order) => order,
            // Typed, like the reverse gate: clients render `dependency_error`
            // (code + ids) instead of string-parsing the message.
            Err(e) => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(json!({
                        "success": false,
                        "error": format!("dependency resolution failed for `{}`: {e}", manifest.id),
                        "dependency_error": e,
                    })),
                )
                    .into_response());
            }
        };
    if dep_order.is_empty() {
        return Ok(vec![]);
    }

    if dry_run {
        return Ok(dep_order.into_iter().map(|plugin| plugin.id).collect());
    }

    // ── Install the new-dep closure with rollback (reuses install_closure +
    //    persist_installed_plugin + rollback_plugin_install — the same sinks
    //    `install_plugin_from_catalog` uses).
    let outcome = crate::plugins::catalog::install_closure(
        dep_order,
        |m| {
            let state = state.clone();
            let ui_code = ui_codes.get(&m.id).cloned();
            let provenance = provenances.get(&m.id).cloned();
            async move { persist_installed_plugin(&state, m, ui_code, provenance).await }
        },
        |plugin_id| {
            let state = state.clone();
            async move { rollback_plugin_install(&state, &plugin_id).await }
        },
    )
    .await;

    match outcome {
        Ok(installed_plugins) => Ok(installed_plugins.into_iter().map(|(pid, _)| pid).collect()),
        Err(failure) => {
            let (status, msg) = failure.error;
            if status != StatusCode::CONFLICT {
                rollback_plugin_install(state, &failure.failed).await;
            }
            Err(json_error(
                status,
                format!(
                    "dependency `{}` of `{}` failed to install: {msg}",
                    failure.failed, manifest.id
                ),
            ))
        }
    }
}
