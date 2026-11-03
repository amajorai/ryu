//! Lifecycle events, view actions, hook grants and hook policy.

use super::*;

#[test]
fn script_run_lifecycle_events_carry_no_result_or_error() {
    let script_run = serde_json::json!({
        "run_id": "sr-0123", "workflow_id": "script-abc", "status": "completed",
        "error": "agent said: secret", "output": { "result": "secret" },
    });
    let redacted = redact_script_run_event(script_run);
    assert_eq!(
        redacted,
        serde_json::json!({
            "run_id": "sr-0123", "workflow_id": "script-abc", "status": "completed",
        })
    );

    // User workflow runs keep their full payload.
    let workflow_run = serde_json::json!({
        "run_id": "run-1", "status": "failed", "error": "boom", "output": { "k": "v" },
    });
    assert_eq!(redact_script_run_event(workflow_run.clone()), workflow_run);
}

#[test]
fn hook_logs_are_bounded_and_sanitized() {
    let mut logs: Vec<String> = (0..MAX_HOOK_LOG_LINES + 5)
        .map(|i| format!("line {i}"))
        .collect();
    logs[0] = format!(
        "forged\nINFO other\u{1b}[31m{}",
        "x".repeat(MAX_HOOK_LOG_LINE_CHARS * 2)
    );
    let (kept, dropped) = bounded_hook_logs(&logs);
    assert_eq!(kept.len(), MAX_HOOK_LOG_LINES);
    assert_eq!(dropped, 5);
    assert!(!kept[0].contains('\n') && !kept[0].contains('\u{1b}'));
    assert!(kept[0].ends_with('…'));
    assert_eq!(kept[0].chars().count(), MAX_HOOK_LOG_LINE_CHARS + 1);
    assert_eq!(kept[1], "line 1");
}

fn view_hook(plugin_id: &str, hook_id: &str, on: &str) -> HookPlugin {
    HookPlugin {
        plugin_id: plugin_id.to_owned(),
        hook_id: hook_id.to_owned(),
        on: on.to_owned(),
        mode: crate::plugin_manifest::HookMode::default(),
        priority: 0,
        code: "return null;".to_owned(),
        grants: HashSet::new(),
        run_when: None,
    }
}

#[test]
fn plugin_update_selects_only_the_updated_plugins_hooks() {
    let hooks = vec![
        view_hook("@acme/tasks", "migrate", ON_PLUGIN_UPDATE),
        view_hook("@acme/tasks", "title", ON_POST_ASSISTANT_TURN),
        view_hook("@other/app", "spy", ON_PLUGIN_UPDATE),
    ];
    let ids: Vec<String> = plugin_update_hooks_for(hooks, "@acme/tasks")
        .into_iter()
        .map(|hook| hook.hook_id)
        .collect();
    assert_eq!(ids, vec!["migrate"]);
    let event = plugin_update_event("@acme/tasks", "1.0.0", "2.0.0", "rollback");
    assert_eq!(event["source"], ON_PLUGIN_UPDATE);
    assert_eq!(event["from_version"], "1.0.0");
    assert_eq!(event["to_version"], "2.0.0");
    assert_eq!(event["reason"], "rollback");
}

#[test]
fn view_action_selects_only_the_owning_plugins_view_hooks() {
    let hooks = vec![
        view_hook("@acme/tasks", "on-view", ON_VIEW_ACTION),
        view_hook("@acme/tasks", "title", ON_POST_ASSISTANT_TURN),
        view_hook("@other/app", "steal", ON_VIEW_ACTION),
    ];
    let selected = view_action_hooks_for(hooks, "@acme/tasks");
    let ids: Vec<&str> = selected.iter().map(|h| h.hook_id.as_str()).collect();
    assert_eq!(ids, vec!["on-view"]);
    assert!(view_action_hooks_for(
        vec![view_hook("@other/app", "steal", ON_VIEW_ACTION)],
        "@acme/tasks"
    )
    .is_empty());
}

#[test]
fn view_action_event_forwards_only_documented_fields() {
    let event = view_action_event(&serde_json::json!({
        "view_id": "board",
        "action_id": "archive",
        "intent": "archive",
        "payload": { "id": 7 },
        "item": { "id": "7" },
        "source": "spoofed",
        "extra": true,
    }));
    assert_eq!(event["source"], ON_VIEW_ACTION);
    assert_eq!(event["view_id"], "board");
    assert_eq!(event["action_id"], "archive");
    assert_eq!(event["payload"]["id"], 7);
    assert_eq!(event["values"], serde_json::Value::Null);
    assert!(event.get("extra").is_none());
}

#[test]
fn view_action_outcome_distinguishes_missing_declined_and_handled() {
    assert_eq!(
        view_action_outcome(vec![], &[]),
        ViewActionOutcome::NoHandler
    );
    assert_eq!(
        view_action_outcome(vec!["h".to_owned()], &[]),
        ViewActionOutcome::Declined {
            hook_ids: vec!["h".to_owned()]
        }
    );
    assert_eq!(
        view_action_outcome(
            vec!["h".to_owned()],
            &[
                HookDirective::Note {
                    text: "Archived".to_owned()
                },
                HookDirective::Note {
                    text: "  ".to_owned()
                },
            ]
        ),
        ViewActionOutcome::Handled {
            hook_ids: vec!["h".to_owned()],
            messages: vec!["Archived".to_owned()],
        }
    );
}

#[test]
fn hook_grants_never_use_unapproved_declared_capabilities() {
    let declared = HashSet::from(["storage:kv".to_string(), "preferences:read".to_string()]);
    assert_eq!(
        restrict_hook_grants(
            &declared,
            &[
                "preferences:read".to_string(),
                "hook:side-model".to_string()
            ]
        ),
        HashSet::from(["preferences:read".to_string()])
    );
    assert!(restrict_hook_grants(&declared, &[]).is_empty());
    assert_eq!(
        restrict_hook_grants(&declared, &["storage:kv".to_string()]),
        HashSet::from(["storage:kv".to_string()])
    );
}
#[test]
fn hook_collection_uses_current_approved_grants_and_exact_compiled_trust() {
    let original = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|m| {
            m.contributes
                .as_ref()
                .is_some_and(|c| !c.turn_hooks.is_empty())
        })
        .expect("compiled hook manifest");
    let mut enabled = std::collections::HashMap::from([(
        original.id.clone(),
        vec![original
            .permission_grants
            .first()
            .expect("declared hook grant")
            .clone()],
    )]);
    let overrides = std::collections::BTreeMap::new();
    let trusted =
        collect_hooks_from_manifests(std::slice::from_ref(&original), &enabled, &overrides);
    assert!(!trusted.is_empty());
    assert!(trusted
        .iter()
        .all(|h| h.grants == HashSet::from([original.permission_grants[0].clone()])));
    enabled.insert(original.id.clone(), Vec::new());
    let revoked =
        collect_hooks_from_manifests(std::slice::from_ref(&original), &enabled, &overrides);
    assert!(revoked.iter().all(|h| h.grants.is_empty()));
    let mut changed = original.clone();
    changed.permission_grants.push("hook:run-agent".to_owned());
    assert!(
        collect_hooks_from_manifests(std::slice::from_ref(&changed), &enabled, &overrides)
            .is_empty()
    );
    let overrides = changed
        .contributes
        .as_ref()
        .unwrap()
        .turn_hooks
        .iter()
        .map(|h| {
            (
                format!("{}::{}", changed.id, h.id),
                crate::governance::HookPolicyOverride {
                    enabled: Some(true),
                    trusted: Some(true),
                },
            )
        })
        .collect();
    let explicitly_trusted =
        collect_hooks_from_manifests(std::slice::from_ref(&changed), &enabled, &overrides);
    assert!(!explicitly_trusted.is_empty());
    assert!(explicitly_trusted.iter().all(|h| h.grants.is_empty()));
    enabled.clear();
    assert!(collect_hooks_from_manifests(&[changed], &enabled, &overrides).is_empty());
}

#[test]
fn hook_policy_requires_explicit_trust_for_third_party_hooks() {
    assert!(!hook_policy_allows(None, false));
    assert!(hook_policy_allows(None, true));
    assert!(hook_policy_allows(
        Some(&crate::governance::HookPolicyOverride {
            enabled: None,
            trusted: Some(true),
        }),
        false
    ));
}

#[test]
fn hook_policy_keeps_enable_and_trust_as_independent_gates() {
    assert!(!hook_policy_allows(
        Some(&crate::governance::HookPolicyOverride {
            enabled: Some(false),
            trusted: Some(true),
        }),
        true
    ));
    assert!(!hook_policy_allows(
        Some(&crate::governance::HookPolicyOverride {
            enabled: Some(true),
            trusted: Some(false),
        }),
        true
    ));
}
