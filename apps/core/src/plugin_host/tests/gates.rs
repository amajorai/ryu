//! Declarative match gates and reply cadence.

use super::*;

fn ctx_with(user: Option<&str>, flags: &[(&str, bool)]) -> HookContext {
    let mut transcript = Vec::new();
    if let Some(u) = user {
        transcript.push(HookMessage {
            role: "user".into(),
            content: u.into(),
        });
    }
    transcript.push(HookMessage {
        role: "assistant".into(),
        content: "…".into(),
    });
    HookContext {
        conversation_id: Some("c1".into()),
        transcript,
        flags: flags.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        ..Default::default()
    }
}

#[test]
fn tenant_namespace_is_shared_by_bridge_and_core_projections() {
    assert_eq!(
        storage_namespace_for_tenant(Some("user-42"), "default"),
        "tenant:user-42:default"
    );
}

fn cadence(first_reply: bool) -> crate::plugin_manifest::ReplyCadence {
    crate::plugin_manifest::ReplyCadence {
        every_pref: Some("auto-title-every-n".into()),
        every_default: 5,
        first_reply,
        first_pref: Some("auto-title-on-first-turn".into()),
        enabled_pref: Some("auto-title-enabled".into()),
    }
}

#[tokio::test]
async fn cadence_requires_approved_preference_read_before_observing_settings() {
    let directory = tempfile::tempdir().unwrap();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    let cadence = cadence(true);
    let context = ctx_with(Some("fixture"), &[]);
    let unapproved = HashSet::new();
    preferences
        .set("auto-title-enabled", "false")
        .await
        .unwrap();
    assert!(reply_cadence_due(&preferences, &cadence, &context, &unapproved).await);
    let approved = HashSet::from(["preferences:read".to_owned()]);
    assert!(!reply_cadence_due(&preferences, &cadence, &context, &approved).await);
    preferences.set("auto-title-enabled", "true").await.unwrap();
    assert!(reply_cadence_due(&preferences, &cadence, &context, &unapproved).await);
    assert!(reply_cadence_due(&preferences, &cadence, &context, &approved).await);
}

/// Mirrors `chat-title`'s `rename.js`: the gate may only skip a turn the hook
/// itself would have returned `none` for.
#[test]
fn reply_cadence_agrees_with_the_chat_title_hook() {
    let c = cadence(true);
    // No completed reply yet, or turned off: never.
    assert!(!reply_cadence_matches(&c, 0, None, None, None));
    assert!(!reply_cadence_matches(&c, 5, Some("false"), None, None));
    // First reply, then every 5th by default.
    assert!(reply_cadence_matches(&c, 1, None, None, None));
    assert!(!reply_cadence_matches(&c, 2, None, None, None));
    assert!(reply_cadence_matches(&c, 5, None, None, None));
    assert!(reply_cadence_matches(&c, 10, Some("true"), None, None));
    // First-reply trigger switched off.
    assert!(!reply_cadence_matches(&c, 1, None, None, Some("false")));
    // parseInt semantics for N.
    assert!(reply_cadence_matches(&c, 3, None, Some("3"), None));
    assert!(reply_cadence_matches(&c, 7, None, Some("7 turns"), None));
    assert!(
        reply_cadence_matches(&c, 5, None, Some("0"), None),
        "below 1 -> default"
    );
    assert!(
        reply_cadence_matches(&c, 5, None, Some("abc"), None),
        "NaN -> default"
    );
    assert!(
        reply_cadence_matches(&c, 5, None, Some(""), None),
        "empty -> default"
    );
    assert!(
        reply_cadence_matches(&c, 100, None, Some("250"), None),
        "clamped to 100"
    );
    assert!(!reply_cadence_matches(&c, 250, None, Some("250"), None));
    assert!(
        reply_cadence_matches(&c, 4, None, Some("1"), None),
        "every turn"
    );
    // A hook that never runs on the first reply.
    assert!(!reply_cadence_matches(&cadence(false), 1, None, None, None));
}

#[test]
fn a_reply_cadence_defers_to_the_stored_gate() {
    let m = HookMatch {
        reply_cadence: Some(cadence(true)),
        ..Default::default()
    };
    assert_eq!(
        gate_without_storage(&m, &ctx_with(None, &[])),
        GateVerdict::CheckStateful
    );
}

#[test]
fn gate_flag_on_runs_off_skips() {
    let m = HookMatch {
        flag: Some("io.ryu.double-check".into()),
        ..Default::default()
    };
    assert_eq!(
        gate_without_storage(&m, &ctx_with(None, &[("io.ryu.double-check", true)])),
        GateVerdict::Run
    );
    // Off / absent flag → skip (double-check must not run a sandbox every turn).
    assert_eq!(
        gate_without_storage(&m, &ctx_with(None, &[("io.ryu.double-check", false)])),
        GateVerdict::Skip
    );
    assert_eq!(
        gate_without_storage(&m, &ctx_with(None, &[])),
        GateVerdict::Skip
    );
}

#[test]
fn glob_match_supports_wildcards() {
    assert!(glob_match("*", "anything"));
    assert!(glob_match("bash", "bash"));
    assert!(!glob_match("bash", "bashx"));
    assert!(glob_match("bash*", "bash.run"));
    assert!(!glob_match("bash*", "sh"));
    assert!(glob_match("*write", "fs.write"));
    assert!(glob_match("*edit*", "editor.do_edit"));
    assert!(!glob_match("*edit*", "read_only"));
}

#[test]
fn gate_tools_matches_tool_name() {
    let m = HookMatch {
        tools: vec!["bash*".into(), "*delete*".into()],
        ..Default::default()
    };
    let ctx = |name: &str| HookContext {
        tool_name: Some(name.into()),
        ..Default::default()
    };
    assert_eq!(gate_without_storage(&m, &ctx("bash.run")), GateVerdict::Run);
    assert_eq!(
        gate_without_storage(&m, &ctx("fs.delete_file")),
        GateVerdict::Run
    );
    // A tool the firewall doesn't watch → skip (no sandbox spawn).
    assert_eq!(
        gate_without_storage(&m, &ctx("web_fetch")),
        GateVerdict::Skip
    );
    // No tool name in context (a non-tool phase) → skip.
    assert_eq!(
        gate_without_storage(&m, &HookContext::default()),
        GateVerdict::Skip
    );
}

#[test]
fn phase_matches_treats_stop_as_post_assistant_turn() {
    assert!(phase_matches(ON_STOP, ON_POST_ASSISTANT_TURN));
    assert!(phase_matches(
        ON_POST_ASSISTANT_TURN,
        ON_POST_ASSISTANT_TURN
    ));
    assert!(!phase_matches(ON_STOP, ON_PRE_USER_TURN));
    assert!(!phase_matches(ON_PRE_TOOL_USE, ON_POST_TOOL_USE));
}

#[test]
fn gate_command_prefix_matches_last_user_turn() {
    let m = HookMatch {
        commands: vec!["/goal".into()],
        stateful: true,
        ..Default::default()
    };
    // `/goal write tests` → the command wakes it immediately.
    assert_eq!(
        gate_without_storage(&m, &ctx_with(Some("/goal write tests"), &[])),
        GateVerdict::Run
    );
    // `/goal clear` also starts with `/goal`.
    assert_eq!(
        gate_without_storage(&m, &ctx_with(Some("/goal clear"), &[])),
        GateVerdict::Run
    );
    // No command this turn but the hook is stateful → defer to the KV read.
    assert_eq!(
        gate_without_storage(&m, &ctx_with(Some("hello"), &[])),
        GateVerdict::CheckStateful
    );
}

#[test]
fn gate_command_does_not_match_unrelated_slash() {
    let m = HookMatch {
        commands: vec!["/goal".into()],
        ..Default::default()
    };
    // `/proof …` is a different plugin's command; goal must not wake for it,
    // and with no stateful flag that means Skip.
    assert_eq!(
        gate_without_storage(&m, &ctx_with(Some("/proof the build passes"), &[])),
        GateVerdict::Skip
    );
}

#[test]
fn gate_empty_or_absent_always_runs() {
    // An empty match block is "always run" (backward compatible).
    assert_eq!(
        gate_without_storage(&HookMatch::default(), &ctx_with(None, &[])),
        GateVerdict::Run
    );
}
