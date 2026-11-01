//! Keep an ENABLED plugin's dependency closure enabled across an update.
//!
//! `install_new_dependencies_for_update` installs a new version's new
//! dependencies, but the install sink lands every record disabled, and the update
//! keeps the target's enabled bit as it was. Without this step an enabled target
//! would keep running on top of disabled dependencies — exactly the state the
//! dependency graph promises never to produce ("a plugin is never left enabled
//! with a disabled dependency").
//!
//! After the new manifest is persisted and reloaded, this runs the same
//! dependency-aware [`enable_app`](crate::plugins::lifecycle::enable_app) the
//! enable route uses (deps first, each through the Gateway grant gate) and
//! activates every dependency it turned on. It only acts when the post-update
//! enable order actually contains a disabled dependency, so ordinary updates do
//! not re-run grant validation.

use serde_json::{json, Value};

use super::{activate_plugin, ServerState};
use crate::plugin_manifest::PluginManifest;
use crate::plugins::PluginRecord;

/// What the post-update enable did, reported in the update response.
#[derive(Debug, Default)]
pub(super) struct UpdateDependencyEnable {
    /// Dependencies this call enabled and activated, in enable order.
    pub enabled: Vec<String>,
    /// Why the dependencies could not be enabled. The update itself already
    /// succeeded; the client shows this so the user can resolve it.
    pub error: Option<Value>,
}

impl UpdateDependencyEnable {
    /// Add `enabled_dependencies` (and `dependency_enable_error` on failure) to
    /// the update response.
    pub fn attach(self, payload: &mut Value) {
        payload["enabled_dependencies"] = json!(self.enabled);
        if let Some(error) = self.error {
            payload["dependency_enable_error"] = error;
        }
    }
}

/// The ids in `order` (other than `target`) whose records are not enabled.
pub(super) fn disabled_dependencies(
    order: &[String],
    target: &str,
    records: &[PluginRecord],
) -> Vec<String> {
    order
        .iter()
        .filter(|id| id.as_str() != target)
        .filter(|id| !records.iter().any(|r| &r.id == *id && r.enabled))
        .cloned()
        .collect()
}

/// Enable (and activate) the disabled dependencies of the just-updated,
/// enabled `manifest`. A no-op when the target is disabled or every
/// dependency is already enabled.
pub(super) async fn enable_dependencies_after_update(
    state: &ServerState,
    manifest: &PluginManifest,
    target_enabled: bool,
) -> UpdateDependencyEnable {
    let mut result = UpdateDependencyEnable::default();
    if !target_enabled {
        return result;
    }
    let records = match state.app_store.list_all_records().await {
        Ok(records) => records,
        Err(e) => {
            result.error = Some(json!({ "error": e.to_string() }));
            return result;
        }
    };
    let all_manifests: Vec<PluginManifest> = state.app_manifests.read().await.clone();
    let installed: Vec<PluginManifest> = all_manifests
        .iter()
        .filter(|m| records.iter().any(|r| r.id == m.id))
        .cloned()
        .collect();
    let lowered = crate::plugins::binding::lower_manifests(
        &installed,
        &crate::plugins::binding::active_config(),
    );
    let order = match crate::plugins::graph::resolve_enable_order(&manifest.id, &lowered) {
        Ok(order) => order,
        Err(e) => {
            result.error = Some(json!({ "error": e.to_string(), "dependency_error": e }));
            return result;
        }
    };
    if disabled_dependencies(&order, &manifest.id, &records).is_empty() {
        return result;
    }

    let outcome = match crate::plugins::lifecycle::enable_app(
        &state.app_store,
        manifest,
        &all_manifests,
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token().as_deref(),
        &state.client,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(plugin = %manifest.id, "post-update dependency enable failed: {e}");
            result.error = Some(enable_error_json(&e));
            return result;
        }
    };
    for record in &outcome.dependencies {
        let Some(dep_manifest) = all_manifests.iter().find(|m| m.id == record.id) else {
            tracing::warn!(plugin = %record.id, "post-update enable: no manifest for dependency");
            continue;
        };
        let _ = activate_plugin(state, dep_manifest, record).await;
        result.enabled.push(record.id.clone());
    }
    result
}

/// The same typed fields the enable route returns, so clients reuse their parser.
fn enable_error_json(error: &crate::plugins::lifecycle::EnableError) -> Value {
    use crate::plugins::lifecycle::EnableError;
    match error {
        EnableError::GrantsDenied { plugin, denied } => json!({
            "error": "Gateway denied one or more grants",
            "plugin": plugin,
            "denied_grants": denied,
        }),
        EnableError::GatewayUnreachable { reason } => json!({
            "error": "Gateway unreachable; enable fails closed",
            "reason": reason,
        }),
        EnableError::Dependency(e) => json!({
            "error": e.to_string(),
            "dependency_error": e,
        }),
        EnableError::Binding { plugin, source } => json!({
            "error": source.to_string(),
            "plugin": plugin,
            "binding_error": source.code(),
        }),
        EnableError::Other(e) => json!({ "error": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::disabled_dependencies;
    use crate::plugins::PluginRecord;

    fn record(id: &str, enabled: bool) -> PluginRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "enabled": enabled,
        }))
        .expect("record parses")
    }

    #[test]
    fn reports_only_disabled_non_target_dependencies() {
        let order = vec![
            "@ryu/a".to_owned(),
            "@ryu/b".to_owned(),
            "@ryu/t".to_owned(),
        ];
        let records = vec![
            record("@ryu/a", true),
            record("@ryu/b", false),
            record("@ryu/t", true),
        ];
        assert_eq!(
            disabled_dependencies(&order, "@ryu/t", &records),
            vec!["@ryu/b".to_owned()]
        );
    }

    #[test]
    fn missing_record_counts_as_disabled() {
        let order = vec!["@ryu/new".to_owned(), "@ryu/t".to_owned()];
        let records = vec![record("@ryu/t", true)];
        assert_eq!(
            disabled_dependencies(&order, "@ryu/t", &records),
            vec!["@ryu/new".to_owned()]
        );
    }

    #[test]
    fn nothing_to_do_when_all_enabled() {
        let order = vec!["@ryu/a".to_owned(), "@ryu/t".to_owned()];
        let records = vec![record("@ryu/a", true), record("@ryu/t", false)];
        assert!(disabled_dependencies(&order, "@ryu/t", &records).is_empty());
    }
}
