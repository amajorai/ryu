use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::governance::{GovernanceScope, HookPolicyOverride};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_manifest::PluginManifest;
use crate::plugins::PluginRecord;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHandlerSummary {
    pub display: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInventoryItem {
    pub effective_enabled: bool,
    pub enabled: bool,
    pub handler: HookHandlerSummary,
    pub hook_key: String,
    pub id: String,
    pub local_overrides: BTreeMap<String, HookPolicyOverride>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<serde_json::Value>,
    pub owner_id: String,
    pub owner_name: String,
    pub phase: String,
    pub plugin_enabled: bool,
    pub priority: i32,
    pub review_required: bool,
    pub source: String,
    pub trusted: bool,
}

pub fn build_hook_inventory(
    manifests: &[PluginManifest],
    records: &[PluginRecord],
    overrides: &BTreeMap<String, HookPolicyOverride>,
) -> Vec<HookInventoryItem> {
    let records_by_id: HashMap<&str, &PluginRecord> = records
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect();
    let mut hooks = Vec::new();
    for manifest in manifests {
        let Some(record) = records_by_id.get(manifest.id.as_str()) else {
            continue;
        };
        let Some(contributes) = manifest.contributes.as_ref() else {
            continue;
        };
        let trusted_by_default = crate::plugins::builtins::is_exact_compiled_manifest(manifest);
        for hook in &contributes.turn_hooks {
            let hook_key = format!("{}::{}", manifest.id, hook.id);
            let policy = overrides.get(&hook_key);
            let enabled = policy.and_then(|value| value.enabled).unwrap_or(true);
            let trusted = policy
                .and_then(|value| value.trusted)
                .unwrap_or(trusted_by_default);
            hooks.push(HookInventoryItem {
                effective_enabled: record.enabled && enabled && trusted,
                enabled,
                handler: HookHandlerSummary {
                    display: "Sandboxed JavaScript".to_owned(),
                    kind: "sandbox_js".to_owned(),
                    path: hook.code_file.clone(),
                },
                hook_key,
                id: hook.id.clone(),
                local_overrides: BTreeMap::new(),
                mode: match hook.mode.unwrap_or_default() {
                    crate::plugin_manifest::HookMode::Directive => "directive".to_owned(),
                    crate::plugin_manifest::HookMode::Middleware => "middleware".to_owned(),
                },
                matcher: hook
                    .run_when
                    .as_ref()
                    .and_then(|matcher| serde_json::to_value(matcher).ok()),
                owner_id: manifest.id.clone(),
                owner_name: manifest.name.clone(),
                phase: hook.on.clone(),
                plugin_enabled: record.enabled,
                priority: hook.priority,
                review_required: !trusted,
                source: "plugin".to_owned(),
                trusted,
            });
        }
    }
    hooks.sort_by(|left, right| {
        left.owner_name
            .cmp(&right.owner_name)
            .then_with(|| left.phase.cmp(&right.phase))
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| left.id.cmp(&right.id))
    });
    hooks
}

async fn hook_inventory_for_state(
    state: &crate::server::ServerState,
) -> Result<Vec<HookInventoryItem>, String> {
    let records = state
        .app_store
        .list_all_records()
        .await
        .map_err(|error| error.to_string())?;
    let overrides = state
        .app_store
        .effective_hook_overrides()
        .await
        .map_err(|error| error.to_string())?;
    let override_records = state
        .app_store
        .list_hook_overrides()
        .await
        .map_err(|error| error.to_string())?;
    let manifests = state.app_manifests.read().await;
    let mut inventory = build_hook_inventory(&manifests, &records, &overrides);
    for hook in &mut inventory {
        for record in override_records
            .iter()
            .filter(|record| record.hook_key == hook.hook_key && !record.managed)
        {
            let scope = match record.scope {
                GovernanceScope::Node => "node",
                GovernanceScope::Organization => "organization",
                GovernanceScope::Team => "team",
                GovernanceScope::User => "user",
            };
            hook.local_overrides
                .insert(scope.to_owned(), record.policy.clone());
        }
    }
    Ok(inventory)
}

pub async fn get_hook_management(State(state): State<crate::server::ServerState>) -> Response {
    match hook_inventory_for_state(&state).await {
        Ok(hooks) => Json(json!({ "hooks": hooks })).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookOverrideUpdate {
    hook_key: String,
    policy: HookPolicyOverride,
    scope: GovernanceScope,
}

pub async fn put_hook_override(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(update): Json<HookOverrideUpdate>,
) -> Response {
    if !matches!(update.scope, GovernanceScope::Node | GovernanceScope::User) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "organization and team hook policy are managed by the control plane" })),
        )
            .into_response();
    }
    // Hook overrides are node-wide: the "user" layer here is not keyed per
    // member, so on an organization/team-bound node it would let any member
    // enable or trust a hook for everyone. There it needs the same authority
    // as the node layer; an unbound node is single-user and stays open.
    let shared_node = crate::sidecar::control_plane::registered_org().is_some();
    if (update.scope == GovernanceScope::Node || shared_node)
        && super::enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::GATEWAY_CONFIGURE,
        )
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: gateway.configure" })),
        )
            .into_response();
    }
    let inventory = match hook_inventory_for_state(&state).await {
        Ok(hooks) => hooks,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error })),
            )
                .into_response();
        }
    };
    if !inventory
        .iter()
        .any(|hook| hook.hook_key == update.hook_key)
    {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "hook not found" })),
        )
            .into_response();
    }
    if let Err(error) = state
        .app_store
        .upsert_hook_override(update.scope, &update.hook_key, &update.policy, false)
        .await
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response();
    }
    get_hook_management(State(state)).await
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::build_hook_inventory;
    use crate::plugin_manifest::PluginManifest;
    use crate::plugins::PluginRecord;

    #[test]
    fn altered_compiled_hook_inventory_requires_review() {
        let original = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
            .into_iter()
            .find(|manifest| {
                manifest
                    .contributes
                    .as_ref()
                    .is_some_and(|contributes| !contributes.turn_hooks.is_empty())
            })
            .expect("compiled hooks");
        let record = PluginRecord {
            id: original.id.clone(),
            version: original.version.clone(),
            enabled: true,
            approved_grants: Vec::new(),
            channel: "stable".to_owned(),
            provenance: None,
            created_at: None,
            updated_at: None,
        };
        let trusted = build_hook_inventory(
            std::slice::from_ref(&original),
            std::slice::from_ref(&record),
            &BTreeMap::new(),
        );
        assert!(!trusted.is_empty());
        assert!(trusted
            .iter()
            .all(|hook| hook.trusted && hook.effective_enabled));
        let mut changed = original;
        changed.permission_grants.push("hook:run-agent".to_owned());
        let untrusted = build_hook_inventory(&[changed], &[record], &BTreeMap::new());
        assert!(untrusted
            .iter()
            .all(|hook| hook.review_required && !hook.effective_enabled));
    }

    #[test]
    fn third_party_hook_inventory_requires_review_and_never_exposes_code() {
        let manifest: PluginManifest = serde_json::from_str(
            r#"{
                "id": "com.example.reviewer",
                "name": "Reviewer",
                "version": "1.0.0",
                "runnables": [],
                "contributes": {
                    "turn_hooks": [{
                        "id": "review",
                        "on": "post_assistant_turn",
                        "priority": 4,
                        "code": "return { kind: 'none' };",
                        "code_file": "hooks/review.js",
                        "match": { "flag": "com.example.reviewer" }
                    }]
                }
            }"#,
        )
        .expect("valid third-party manifest shape");
        let record = PluginRecord {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            enabled: true,
            approved_grants: Vec::new(),
            channel: "stable".to_owned(),
            provenance: None,
            created_at: None,
            updated_at: None,
        };

        let inventory = build_hook_inventory(&[manifest], &[record], &BTreeMap::new());

        assert_eq!(inventory.len(), 1);
        let hook = &inventory[0];
        assert!(hook.enabled);
        assert!(!hook.trusted);
        assert!(!hook.effective_enabled);
        assert!(hook.review_required);
        assert_eq!(hook.mode, "directive");
        assert_eq!(hook.handler.path.as_deref(), Some("hooks/review.js"));
        let serialized = serde_json::to_string(hook).expect("serialize hook inventory");
        assert!(!serialized.contains("return { kind"));
    }
}
