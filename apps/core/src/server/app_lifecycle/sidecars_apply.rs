//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `apply_sidecars` through `SetGrantsBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Register + start (on enable) or stop + deregister (on disable) every
/// manifest-declared **managed sidecar** for a plugin — the live call path for the
/// app ⇄ sidecar bridge ([`crate::sidecar::manifest_sidecar`]).
///
/// On enable each spec is gated by
/// [`crate::sidecar::manifest_sidecar::may_run_sidecar`] (Core-tier auto; Community
/// needs the approved `sidecar:process` grant, read from `approved_grants` — never
/// the manifest's unvalidated declarations). Enable work is **spawned** and
/// best-effort so a slow binary download / venv build never blocks the enable
/// response. Each spawned start carries the activation generation and holds a
/// work lease, so disable waits for it or rejects it as stale. Stop is ungated,
/// awaited under the deactivation lease, and ignores `approved_grants`.
pub(in crate::server) async fn apply_sidecars(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    approved_grants: &[String],
    enabled: bool,
    runtime_binding: Option<crate::plugins::runtime::RuntimeGenerationBinding>,
) {
    if manifest.sidecars.is_empty() {
        return;
    }
    let tier = crate::plugins::builtins::tier_for_manifest(manifest);
    // The managed-bin ready notifier: a plugin that declares BOTH a sidecar and
    // `mcp_servers` gets its registration re-run once the sidecar's binary is actually
    // on disk. The registration below (in `activate_plugin`) runs while this download is
    // still in flight, so without this the declared server stays skipped until the next
    // boot. Built once per apply and shared by every spec (`Arc`: a manifest can carry
    // inline `ui_code`). `None` for a manifest with no `mcp_servers` — nothing to re-run.
    let mcp_registration = (enabled && !manifest.mcp_servers.is_empty()).then(|| {
        crate::sidecar::manifest_sidecar::McpRegistration {
            registry: state.mcp.clone(),
            manifest: std::sync::Arc::new(manifest.clone()),
            tier,
            approved_grants: approved_grants.to_vec(),
            runtime: runtime_binding.clone(),
        }
    });
    for spec in &manifest.sidecars {
        let manager = state.manager.clone();
        if enabled {
            if !crate::sidecar::manifest_sidecar::may_run_sidecar(tier, approved_grants) {
                tracing::info!(
                    "plugin '{}' declares sidecar '{}' but is Community-tier without an \
                     approved '{}' grant; start skipped (fail-closed)",
                    manifest.id,
                    spec.name,
                    crate::sidecar::manifest_sidecar::GRANT_SIDECAR_PROCESS
                );
                continue;
            }
            let mut built = crate::sidecar::manifest_sidecar::ManifestSidecar::new(
                manifest.id.clone(),
                spec.clone(),
                state.downloads.clone(),
            );
            if let Some(binding) = runtime_binding.clone() {
                built = built.with_runtime_binding(binding);
            }
            if let Some(registration) = mcp_registration.clone() {
                built = built.with_mcp_registration(registration);
            }
            // The ext-API fetch hook: derive searchable agent tools from THIS
            // sidecar's own OpenAPI document once it reports healthy
            // (`import_openapi_once` explains why the Healthy edge and not here).
            //
            // Armed here because this is the one place already holding the manifest,
            // the tier, the grants and `state.mcp` at the same time — and armed
            // per-SPEC, not per-manifest, because `ext_api::lower` pairs one sidecar's
            // mount with that same sidecar's declared routes (see `OpenApiImport`).
            //
            // TRUST GATE, v1: compiled-in (first-party) apps only. A third-party spec
            // is attacker-controlled text that would land in front of the model with
            // no human in the loop; and `may_read_env_secret` gates `env:` reads by
            // provenance, so a disk-installed app's `env:RYU_TOKEN` resolves Absent
            // and its auth header is dropped SILENTLY — derived tools that look real
            // and 401 forever. Widening this is a product decision with a review step,
            // not a config flag.
            if crate::plugins::builtins::is_exact_compiled_manifest(manifest) {
                if let Some(http) = spec.http.as_ref() {
                    built = built.with_openapi_import(
                        crate::sidecar::manifest_sidecar::OpenApiImport {
                            registry: state.mcp.clone(),
                            plugin_id: manifest.id.clone(),
                            sidecar_name: spec.name.clone(),
                            // The registry key and the re-wake latch. The SIDECAR, not
                            // the plugin: a manifest with two `http` sidecars would
                            // otherwise have the second lowering overwrite the first's
                            // rows, with the winner decided by health-poll order.
                            sidecar_key: crate::sidecar::manifest_sidecar::namespaced_name(
                                &manifest.id,
                                &spec.name,
                            ),
                            // The live manifest store, so a re-lowering after an
                            // in-place update reads the NEW mount + declared routes
                            // (this handler is not re-run by the update path — see
                            // `OpenApiImport::manifests`). The two fields below stay as
                            // the fallback for contexts with no store.
                            manifests: Some(state.app_manifests.clone()),
                            // Normalised the same way the proxy normalises it, so the
                            // prefix stripped at lowering is byte-identical to the one
                            // the proxy re-adds at the hop.
                            upstream_mount: http
                                .mount
                                .as_deref()
                                .map(|m| m.trim_end_matches('/').to_owned())
                                .unwrap_or_default(),
                            declared_routes: http.routes.clone(),
                            client: state.client.clone(),
                            runtime: runtime_binding.clone(),
                        },
                    );
                }
            }
            let sidecar = std::sync::Arc::new(built);
            // Per-app idle-stop timeout (scale-to-zero) declared on the spec, applied
            // BEFORE start so the reaper knows the window as soon as the sidecar is up.
            // A provider-declaring sidecar opts out for the same reason it cannot be
            // lazy — see `may_idle_stop`.
            if let Some(secs) = spec.idle_stop_secs {
                let name =
                    crate::sidecar::manifest_sidecar::namespaced_name(&manifest.id, &spec.name);
                if crate::sidecar::manifest_sidecar::may_idle_stop(spec) {
                    manager.set_idle_override(&name, secs);
                } else {
                    tracing::info!(
                        "plugin '{}': sidecar '{}' declares both 'idle_stop_secs' and \
                         'provides_provider'; ignoring the idle timeout — Pi dials the \
                         provider's baseUrl directly and can never wake it, so a \
                         scale-to-zero would drop the model out of the picker for good",
                        manifest.id,
                        spec.name
                    );
                }
            }
            // Lazy sidecars are REGISTER-ONLY here (claim port + appear in status as
            // stopped); the first proxy/broker hit wakes the process on demand. Eager
            // sidecars start now, as before. The grant gate above still ran, so wake
            // never re-runs the tier/grant check — no bypass.
            //
            // `starts_eagerly` and not `!spec.lazy`: a spec that declares
            // `provides_provider` is coerced to eager whatever it asked for, because
            // nothing can ever wake it (Pi bypasses the proxy) and the boot purge would
            // then leave the provider permanently dead. The coercion is logged rather
            // than rejected — refusing the manifest would break existing ones.
            if !crate::sidecar::manifest_sidecar::starts_eagerly(spec) {
                if let Err(e) = manager.register(sidecar) {
                    tracing::warn!(
                        "plugin '{}': lazy manifest sidecar '{}' failed to register: {e}",
                        manifest.id,
                        spec.name
                    );
                }
                continue;
            }
            if spec.lazy {
                tracing::info!(
                    "plugin '{}': sidecar '{}' declares 'lazy' together with \
                     'provides_provider'; starting it eagerly instead — Pi dials the \
                     provider's baseUrl directly, so no proxy hit can ever wake it and \
                     the boot purge would leave the provider dead until a restart",
                    manifest.id,
                    spec.name
                );
            }
            let plugin_id = manifest.id.clone();
            let spec_name = spec.name.clone();
            let runtime_binding = runtime_binding.clone();
            tokio::spawn(async move {
                let _runtime_lease = match runtime_binding {
                    Some(binding) => match binding.acquire().await {
                        Some(lease) => Some(lease),
                        None => {
                            tracing::debug!(
                                plugin = %plugin_id,
                                sidecar = %spec_name,
                                generation = binding.generation().number(),
                                "manifest sidecar start skipped because its runtime generation is stale"
                            );
                            return;
                        }
                    },
                    None => None,
                };
                if let Err(e) = manager.register_and_start(sidecar).await {
                    tracing::warn!(
                        "plugin '{plugin_id}': manifest sidecar '{spec_name}' failed to start \
                         (best-effort): {e}"
                    );
                }
            });
        } else {
            let name = crate::sidecar::manifest_sidecar::namespaced_name(&manifest.id, &spec.name);
            if let Err(e) = manager.stop_and_deregister(&name).await {
                tracing::warn!("manifest sidecar '{name}' failed to stop: {e}");
            }
        }
    }
}

/// Re-register + start every enabled plugin's declared managed sidecars on Core
/// boot. Manifest sidecars are NOT in the manager's `startup_order`, so nothing
/// else restarts them after a Core restart — without this pass an enabled plugin's
/// sidecar stays dead while the plugin still reads as enabled (a half-built flow
/// that doesn't survive restart). Spawned from `main.rs` once `ServerState` exists,
/// alongside the `onStartup` activation fire. Idempotent via
/// [`crate::sidecar::SidecarManager::register_and_start`].
pub async fn reconcile_plugin_sidecars(state: &ServerState) {
    let records = match state.app_store.list().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("reconcile_plugin_sidecars: listing plugins failed: {e}");
            return;
        }
    };
    let manifests = state.app_manifests.read().await.clone();
    for rec in records.into_iter().filter(|r| r.enabled) {
        let Some(manifest) = manifests.iter().find(|m| m.id == rec.id) else {
            continue;
        };
        if manifest.sidecars.is_empty() {
            continue;
        }
        if let Some(refusal) = plugin_host_access_refusal(state, manifest).await {
            tracing::warn!(
                plugin = %rec.id,
                "reconcile_plugin_sidecars: sidecars not started: {refusal}"
            );
            continue;
        }
        let Some(binding) = state.plugin_runtime.active_binding(&rec.id).await else {
            tracing::debug!(
                plugin = %rec.id,
                "skipping sidecar reconcile until the plugin runtime generation is active"
            );
            continue;
        };
        apply_sidecars(state, manifest, &rec.approved_grants, true, Some(binding)).await;
    }
}

/// Body for `POST /api/plugins/:id/grants` — the explicit set of grants the user
/// wants this (already-enabled) app to keep. A subset of the app's declared grants;
/// used by the desktop per-app permissions view to revoke (or restore) individual
/// capabilities without disabling the whole app.
#[derive(serde::Deserialize)]
pub(in crate::server) struct SetGrantsBody {
    pub(in crate::server) grants: Vec<String>,
}
