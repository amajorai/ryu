//! Keep an ENABLED plugin's dependency closure enabled across an update.
//!
//! `install_new_dependencies_for_update` installs a new version's new
//! dependencies, but the install sink lands every record disabled, and the update
//! keeps the target's enabled bit as it was. Without this step an enabled target
//! would keep running on top of disabled dependencies — exactly the state the
//! dependency graph promises never to produce ("a plugin is never left enabled
//! with a disabled dependency").
//!
//! After the new manifest is persisted and reloaded, this enables each disabled
//! dependency through the same dependency-aware
//! [`enable_app`](crate::plugins::lifecycle::enable_app) the enable route uses
//! (its own dependencies first, each through the Gateway grant gate) and
//! activates every dependency it turned on. It only acts when the post-update
//! enable order actually contains a disabled dependency.
//!
//! The updated plugin itself is never enabled again here. `enable_app` approves
//! every grant its target's manifest declares, so handing it the new version
//! would give that version grants no user approved and bring back grants the
//! user had switched off. An update only ever narrows approvals; newly declared
//! grants stay unapproved until the user approves them.

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
    caller: &Option<crate::identity_verify::VerifiedCaller>,
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
    let disabled = disabled_dependencies(&order, &manifest.id, &records);
    if disabled.is_empty() {
        return result;
    }

    // Turning a dependency on is an enable. The update route itself only asked
    // for `app.update`; the enable route asks for `app.enable`.
    let permission = crate::identity_verify::permissions::APP_ENABLE;
    if super::enforce_app_lifecycle_permission(state, caller, permission)
        .await
        .is_err()
    {
        result.error = Some(json!({
            "error": format!("insufficient permissions: {permission}"),
            "permission": permission,
            "disabled_dependencies": disabled,
        }));
        return result;
    }

    let (enabled, error) = enable_disabled_dependencies(
        &state.app_store,
        &disabled,
        &all_manifests,
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token().as_deref(),
        &state.client,
    )
    .await;
    result.error = error;
    for record in &enabled {
        let Some(dep_manifest) = all_manifests.iter().find(|m| m.id == record.id) else {
            tracing::warn!(plugin = %record.id, "post-update enable: no manifest for dependency");
            continue;
        };
        let _ = activate_plugin(state, dep_manifest, record).await;
        result.enabled.push(record.id.clone());
    }
    result
}

/// Enable each of `disabled` through its OWN manifest, in the given order
/// (dependencies first). The updated plugin is not in `disabled` and its record
/// is not written: its approvals stay exactly as the update left them.
///
/// Returns the records this call enabled, in enable order, and the error that
/// stopped it. A dependency enabled before a later one failed stays enabled; it
/// passed the Gateway grant gate on its own.
async fn enable_disabled_dependencies(
    store: &crate::plugins::PluginStore,
    disabled: &[String],
    all_manifests: &[PluginManifest],
    gateway_url: &str,
    gateway_token: Option<&str>,
    client: &reqwest::Client,
) -> (Vec<PluginRecord>, Option<Value>) {
    let mut enabled: Vec<PluginRecord> = Vec::new();
    for id in disabled {
        // Already turned on as a dependency of an earlier entry.
        if enabled.iter().any(|record| &record.id == id) {
            continue;
        }
        let Some(dep_manifest) = all_manifests.iter().find(|m| &m.id == id) else {
            let error = json!({ "error": format!("no manifest for dependency `{id}`") });
            return (enabled, Some(error));
        };
        match crate::plugins::lifecycle::enable_app(
            store,
            dep_manifest,
            all_manifests,
            gateway_url,
            gateway_token,
            client,
        )
        .await
        {
            Ok(outcome) => enabled.extend(outcome.in_enable_order().cloned()),
            Err(e) => {
                tracing::warn!(plugin = %id, "post-update dependency enable failed: {e}");
                return (enabled, Some(enable_error_json(&e)));
            }
        }
    }
    (enabled, None)
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
    use super::{disabled_dependencies, enable_disabled_dependencies};
    use crate::plugin_manifest::PluginManifest;
    use crate::plugins::PluginRecord;

    const ISOLATED_TEST: &str =
        "server::plugin_update_deps::tests::an_update_never_reapproves_the_updated_plugin";

    fn manifest(id: &str, version: &str, grants: &[&str], requires: &[&str]) -> PluginManifest {
        use crate::plugin_manifest::schema::RunnableEntry;
        use crate::plugin_manifest::{AppDependency, Requires};
        PluginManifest {
            id: id.to_owned(),
            name: "Test App".to_owned(),
            version: version.to_owned(),
            runnables: vec![RunnableEntry {
                id: "agent-x".to_owned(),
                name: "Agent X".to_owned(),
                kind: crate::runnable::RunnableKind::Agent,
                config: None,
            }],
            permission_grants: grants.iter().map(|grant| (*grant).to_owned()).collect(),
            requires: (!requires.is_empty()).then(|| Requires {
                apps: requires
                    .iter()
                    .map(|dependency| AppDependency {
                        id: (*dependency).to_owned(),
                        min_version: None,
                    })
                    .collect(),
                capabilities: vec![],
                grants: vec![],
            }),
            ..Default::default()
        }
    }

    /// Security sweep 19 Nov 2026, finding VG-1. The user enabled v1 and then
    /// switched its grants off. v2 declares more grants and a new dependency.
    /// After the update the dependency is enabled, and the updated plugin still
    /// holds no approved grant.
    ///
    /// Runs in a child process, because grant validation is stubbed through a
    /// process-wide environment variable that other tests also set and clear.
    #[tokio::test]
    async fn an_update_never_reapproves_the_updated_plugin() {
        if std::env::var_os("RYU_UPDATE_DEPS_CHILD").is_none() {
            let dir = tempfile::tempdir().unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", ISOLATED_TEST, "--nocapture"])
                .env("RYU_UPDATE_DEPS_CHILD", "1")
                .env("RYU_STUB_GRANT_VALIDATION", "1")
                .env("RYU_PROFILE", "dev")
                .env("RYU_KEYCHAIN", "off")
                .env("RYU_DIR", dir.path())
                .env("RUST_MIN_STACK", "16777216")
                .status()
                .unwrap();
            assert!(status.success(), "isolated update dependency test failed");
            return;
        }
        use crate::plugins::lifecycle::{enable_app, install_app, set_app_grants, update_app};
        let store = crate::plugins::PluginStore::open_in_memory().unwrap();
        let client = reqwest::Client::new();
        let gateway = "http://127.0.0.1:7981";
        let (target, dependency) = ("com.test.target", "com.test.dep");

        let v1 = manifest(target, "1.0.0", &["spaces:docs"], &[]);
        install_app(&store, &v1).await.unwrap();
        let first = enable_app(
            &store,
            &v1,
            std::slice::from_ref(&v1),
            gateway,
            None,
            &client,
        )
        .await
        .unwrap();
        assert_eq!(first.target.approved_grants, ["spaces:docs"]);
        // The user switches every grant off in the permissions editor.
        let narrowed = set_app_grants(&store, &v1, &[], gateway, None, &client)
            .await
            .unwrap();
        assert!(narrowed.enabled && narrowed.approved_grants.is_empty());

        // The update installs the new dependency disabled, then commits v2.
        let dep = manifest(dependency, "1.0.0", &["spaces:docs"], &[]);
        install_app(&store, &dep).await.unwrap();
        let v2 = manifest(
            target,
            "2.0.0",
            &["spaces:docs", "mcp:web_search"],
            &[dependency],
        );
        let updated = update_app(&store, &v2, None, false).await.unwrap();
        assert!(updated.enabled && updated.approved_grants.is_empty());

        let all = vec![v2.clone(), dep.clone()];
        let records = store.list_all_records().await.unwrap();
        let order = crate::plugins::graph::resolve_enable_order(target, &all).unwrap();
        let disabled = disabled_dependencies(&order, target, &records);
        assert_eq!(disabled, vec![dependency.to_owned()]);

        let (enabled, error) =
            enable_disabled_dependencies(&store, &disabled, &all, gateway, None, &client).await;
        assert!(error.is_none(), "{error:?}");
        let enabled_ids: Vec<&str> = enabled.iter().map(|record| record.id.as_str()).collect();
        assert_eq!(enabled_ids, [dependency]);

        let dep_record = store.get(dependency).await.unwrap().unwrap();
        assert!(dep_record.enabled, "the new dependency is enabled");
        let target_record = store.get(target).await.unwrap().unwrap();
        assert!(target_record.enabled);
        assert_eq!(target_record.version, "2.0.0");
        assert!(
            target_record.approved_grants.is_empty(),
            "the update approved grants for the updated plugin: {:?}",
            target_record.approved_grants
        );

        // Control: the call this path made before does widen the target, so
        // the assertion above fails without the fix.
        let widened = enable_app(&store, &v2, &all, gateway, None, &client)
            .await
            .unwrap();
        assert_eq!(
            widened.target.approved_grants,
            ["spaces:docs", "mcp:web_search"]
        );
    }

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
