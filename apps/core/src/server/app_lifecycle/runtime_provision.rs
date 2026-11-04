//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `PolicyApplyOutcome` through `provision_external_runtime`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

/// What [`apply_policy`] did with respect to the **gateway** — threaded up through
/// [`activate_plugin`]/[`deactivate_plugin`] so the enable/disable/uninstall
/// handlers can tell the client the truth about whether a gateway-enforced policy
/// (firewall/routing/compression) actually took effect.
#[derive(Debug, Clone, Copy, Default)]
pub(in crate::server) struct PolicyApplyOutcome {
    /// A gateway-affecting policy was applied this call (a live config-push for
    /// firewall/routing, or a respawn for compression). `false` means no
    /// firewall/routing/compression policy was in this manifest and the gateway was
    /// never touched.
    pub(in crate::server) gateway_touched: bool,
    /// A **respawn-only** (compression) policy changed but the gateway is externally
    /// managed (RYU_GATEWAY_MANAGED=0), so the running gateway was NOT reconfigured
    /// and the control is a no-op until a manual restart. Never set by the
    /// firewall/routing arms, which hot-swap live via PUT /v1/config (they reach a
    /// remote gateway directly).
    pub(in crate::server) gateway_externally_managed: bool,
}

impl PolicyApplyOutcome {
    /// Fold another plugin's outcome in (an enable/disable can touch several
    /// plugins; if any of them left the gateway un-reconfigured, the whole call did).
    pub(in crate::server) fn merge(self, other: Self) -> Self {
        Self {
            gateway_touched: self.gateway_touched || other.gateway_touched,
            gateway_externally_managed: self.gateway_externally_managed
                || other.gateway_externally_managed,
        }
    }
}

/// Resolve the per-plugin external-runtime directory: `<plugins_dir>/<id>/runtime`.
///
/// The venv + pip-installed deps land here, namespaced under the plugin id so two
/// plugins never collide. `<id>` is already path-validated by the manifest loader
/// (`validate_plugin_id`), so this join is traversal-safe.
pub(in crate::server) fn plugin_runtime_dir(plugin_id: &str) -> std::path::PathBuf {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(plugin_id))
        .join("runtime")
}

/// Provision a plugin's declared external runtime (#449) — the live call path for
/// [`crate::sidecar::external_runtime::provision`].
///
/// Gated by [`crate::sidecar::external_runtime::may_provision`]: a **Core-tier**
/// (first-party) plugin is auto-allowed; a **Community-tier** plugin may provision
/// IFF the Gateway approved the `runtime:external` grant — read from the plugin's
/// *approved* grants (`approved_grants`, post-Gateway-validation at enable), never
/// the manifest's declared, unvalidated `permission_grants`. Fail-closed: an
/// un-granted Community plugin does not provision (and enable itself already fails
/// closed with 403/503 upstream if the Gateway denied / was unreachable).
///
/// The work is **spawned** and **best-effort**: a rejected asset, missing Python
/// interpreter, or a failed pip install is logged, never fatal, and never blocks
/// the enable response — the graceful-degrade contract the `RyuTtsManager` venv
/// path follows.
pub(in crate::server) fn provision_external_runtime(
    manifest: &crate::plugin_manifest::PluginManifest,
    approved_grants: &[String],
    downloads: crate::downloads::DownloadCenter,
) {
    let Some(runtime) = manifest.runtime.clone() else {
        return;
    };
    let tier = crate::plugins::builtins::tier_for_manifest(manifest);
    if !crate::sidecar::external_runtime::may_provision(tier, approved_grants) {
        tracing::info!(
            "plugin '{}' declares an external runtime but is Community-tier without an \
             approved '{}' Gateway grant; provisioning is skipped (fail-closed)",
            manifest.id,
            crate::sidecar::external_runtime::GRANT_EXTERNAL_RUNTIME
        );
        return;
    }
    let dir = plugin_runtime_dir(&manifest.id);
    let plugin_id = manifest.id.clone();
    tokio::spawn(async move {
        match crate::sidecar::external_runtime::provision(&runtime, &dir, &downloads).await {
            Ok(python) => tracing::info!(
                "plugin '{plugin_id}': external runtime provisioned at {}",
                python.display()
            ),
            Err(e) => tracing::warn!(
                "plugin '{plugin_id}': external-runtime provisioning failed (best-effort): {e}"
            ),
        }
    });
}
