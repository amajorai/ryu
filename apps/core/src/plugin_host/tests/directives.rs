//! App-event activity, directive parsing and hook program shape.

use super::*;

/// An app event fires with no turn in flight, so only the directives that mean
/// something off the chat path survive. Getting this wrong would let a hook
/// reacting to "a meeting ended" silently inject text into whatever chat happened
/// to be open.
fn hint(kind: &str, title: &str) -> AppEventActivity {
    AppEventActivity {
        kind: kind.to_owned(),
        title: title.to_owned(),
        body: None,
        level: None,
        metadata: None,
    }
}

#[test]
fn app_event_activity_is_attributed_to_the_authenticated_caller() {
    let mut h = hint("meeting", "Meeting started: Standup");
    h.level = Some("success".to_owned());
    h.metadata = Some(serde_json::json!({ "meeting_id": "mtg_1" }));
    let item =
        app_event_activity_item("@ryu/meetings", "@ryu/meetings#meeting.started", &h).unwrap();
    assert_eq!(item.source, "meetings");
    assert_eq!(item.kind, "meeting");
    assert_eq!(item.title, "Meeting started: Standup");
    assert_eq!(item.level, ryu_activity::ActivityLevel::Success);
    assert_eq!(item.metadata["meeting_id"], "mtg_1");
    assert_eq!(item.metadata["event"], "@ryu/meetings#meeting.started");
    assert_eq!(activity_source_for("com.acme.flat"), "com.acme.flat");
}

#[test]
fn app_event_activity_hint_is_bounded() {
    for bad in [
        hint("Meeting", "t"),
        hint("", "t"),
        hint("meeting", "   "),
        hint("meeting", &"x".repeat(513)),
        AppEventActivity {
            body: Some("x".repeat(5000)),
            ..hint("meeting", "t")
        },
        AppEventActivity {
            level: Some("panic".to_owned()),
            ..hint("meeting", "t")
        },
        AppEventActivity {
            metadata: Some(serde_json::json!(["not", "an", "object"])),
            ..hint("meeting", "t")
        },
    ] {
        assert!(app_event_activity_item("@ryu/meetings", "e#x", &bad).is_err());
    }
}

#[test]
fn app_event_hooks_may_only_observe_or_note() {
    assert!(app_event_directive_allowed(&HookDirective::None));
    assert!(app_event_directive_allowed(&HookDirective::Note {
        text: "meeting summarized".into()
    }));

    for turn_only in [
        HookDirective::Continue {
            text: "keep going".into(),
        },
        HookDirective::Replace {
            text: "rewritten".into(),
            fresh_session: false,
        },
        HookDirective::Inject {
            text: "context".into(),
        },
    ] {
        assert!(
            !app_event_directive_allowed(&turn_only),
            "{turn_only:?} has no meaning off the chat path and must be dropped"
        );
    }
}

/// An app-event phase must route through the ordinary exact-match dispatch, and
/// must never be captured by the one alias `phase_matches` implements.
#[test]
fn app_event_phases_match_exactly_and_never_alias() {
    assert!(phase_matches(
        "com.acme.meet/meeting.ended",
        "com.acme.meet/meeting.ended"
    ));
    assert!(!phase_matches(
        "com.acme.meet/meeting.ended",
        "com.acme.meet/meeting.started"
    ));
    // The `stop` → `post_assistant_turn` alias must not drag an app event in.
    assert!(!phase_matches(
        "com.acme.meet/meeting.ended",
        ON_POST_ASSISTANT_TURN
    ));
    assert!(!phase_matches(ON_STOP, "com.acme.meet/meeting.ended"));
}

#[test]
fn parse_directive_handles_each_variant() {
    assert_eq!(parse_directive(None), HookDirective::None);
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "none" }))),
        HookDirective::None
    );
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "note", "text": "looks good" }))),
        HookDirective::Note {
            text: "looks good".into()
        }
    );
    assert_eq!(
        parse_directive(Some(&json!({
            "kind": "tool_approval",
            "question": "Can I run the tests?",
            "summary": "I will run the test suite to verify the change."
        }))),
        HookDirective::ToolApproval {
            question: "Can I run the tests?".into(),
            summary: "I will run the test suite to verify the change.".into(),
        }
    );
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "continue", "text": "keep going" }))),
        HookDirective::Continue {
            text: "keep going".into()
        }
    );
    // Old hook payloads omit the ACP session flag and must remain pooled.
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "replace", "text": "rewrite" }))),
        HookDirective::Replace {
            text: "rewrite".into(),
            fresh_session: false,
        }
    );
    assert_eq!(
        parse_directive(Some(
            &json!({ "kind": "replace", "text": "rewrite", "fresh_session": true }),
        )),
        HookDirective::Replace {
            text: "rewrite".into(),
            fresh_session: true,
        }
    );
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "deny", "reason": "no" }))),
        HookDirective::Deny {
            reason: "no".into()
        }
    );
    // `transform` carries an arbitrary JSON result, not text — a tool result is
    // a structured value, so redaction must be able to return an object.
    assert_eq!(
        parse_directive(Some(
            &json!({ "kind": "transform", "output": { "content": "[redacted]" } })
        )),
        HookDirective::Transform {
            output: json!({ "content": "[redacted]" })
        }
    );
    assert_eq!(
        parse_directive(Some(
            &json!({ "kind": "transform", "output": "plain string" })
        )),
        HookDirective::Transform {
            output: json!("plain string")
        }
    );
    assert_eq!(
        parse_directive(Some(&json!({
            "kind": "select_model",
            "model": "opus",
            "acp_config": { "fast_mode": "true" }
        }))),
        HookDirective::SelectModel {
            model: "opus".into(),
            effort: None,
            acp_config: Some(std::collections::HashMap::from([(
                "fast_mode".into(),
                "true".into(),
            )])),
            reason: None,
        }
    );
    // Garbage / unknown shape → None (fail-safe, never loops on noise).
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "explode" }))),
        HookDirective::None
    );
    assert_eq!(
        parse_directive(Some(&json!("nonsense"))),
        HookDirective::None
    );
    // A `transform` with no `output` is malformed — it must NOT silently become
    // a rewrite to null, which would erase the real tool result.
    assert_eq!(
        parse_directive(Some(&json!({ "kind": "transform" }))),
        HookDirective::None
    );
}

#[test]
fn channel_actions_and_interactive_directives_cross_the_hook_boundary() {
    let action = ryu_channel_contracts::ChannelActionEvent {
        action_id: "review.approve".into(),
        label: "Approve".into(),
        payload: json!({ "requestId": "req-42" }),
    };
    let context = HookContext {
        channel_action: Some(action),
        ..Default::default()
    };
    let context_json = serde_json::to_value(context).unwrap();
    assert_eq!(context_json["channel_action"]["actionId"], "review.approve");
    assert_eq!(
        context_json["channel_action"]["payload"]["requestId"],
        "req-42"
    );

    let markup = json!({
        "layout": "inline",
        "rows": [[{
            "label": "Approve",
            "action": {
                "type": "callback",
                "actionId": "review.approve",
                "payload": { "requestId": "req-42" }
            }
        }]]
    });
    assert_eq!(
        parse_directive(Some(
            &json!({ "kind": "interactive_message", "markup": markup })
        )),
        HookDirective::InteractiveMessage {
            markup: serde_json::from_value(markup).unwrap(),
        }
    );
    assert!(matches!(
        parse_directive(Some(&json!({
            "kind": "handled",
            "text": "Approval recorded.",
            "interactive_markup": {
                "layout": "reply_keyboard",
                "rows": [[{
                    "label": "View status",
                    "action": { "type": "reply" }
                }]]
            }
        }))),
        HookDirective::Handled {
            interactive_markup: Some(_),
            ..
        }
    ));
}

#[test]
fn tool_result_is_a_distinct_phase_from_post_tool_use() {
    // The split is what keeps observation detached (zero latency) while rewrite
    // is awaited. If these ever aliased, every `post_tool_use` observer would
    // start costing the tool hot path a sandbox spawn.
    assert_ne!(ON_TOOL_RESULT, ON_POST_TOOL_USE);
    assert!(!phase_matches(ON_POST_TOOL_USE, ON_TOOL_RESULT));
    assert!(!phase_matches(ON_TOOL_RESULT, ON_POST_TOOL_USE));
    assert!(phase_matches(ON_TOOL_RESULT, ON_TOOL_RESULT));
    // `stop` stays an alias of post_assistant_turn and must not leak into the
    // tool phases.
    assert!(!phase_matches(ON_STOP, ON_TOOL_RESULT));
}

#[test]
fn build_program_injects_ctx_and_host_facade() {
    let ctx = HookContext {
        conversation_id: Some("conv-1".into()),
        agent_id: Some("ryu".into()),
        transcript: vec![HookMessage {
            role: "assistant".into(),
            content: "hi".into(),
        }],
        ..Default::default()
    };
    let program = build_hook_program(&ctx, "return { kind: 'note', text: 'x' };");
    assert!(program.contains("const ctx = "));
    assert!(program.contains("conv-1"));
    assert!(program.contains("host.sideModel") || program.contains("sideModel:"));
    assert!(program.contains("tools.host.sideModel"));
    assert!(program.contains("notify: (a) => tools.host.notify(a ?? {}),"));
    assert!(program.contains("return { kind: 'note', text: 'x' };"));
}

#[test]
fn middleware_program_injects_a_core_owned_next_continuation() {
    let program = build_middleware_hook_program(
        &HookContext::default(),
        "return await next({ ...ctx, event: { forwarded: true } });",
    );
    assert!(program.contains("__ryu_function_hook"));
    assert!(program.contains("__ryu_deep_freeze"));
    assert!(program.contains("(ctx, host, next)"));
    assert!(program.contains("tools.host.next"));
    assert!(program.contains("event: { forwarded: true }"));
}

#[test]
fn middleware_next_preserves_request_identity_and_plugin_flags() {
    let root = HookContext {
        agent_id: Some("agent-a".into()),
        caller_user_id: Some("user-a".into()),
        conversation_id: Some("conversation-a".into()),
        flags: std::iter::once(("plugin-a".to_owned(), true)).collect(),
        ..Default::default()
    };
    let identity = MiddlewareIdentity::from(&root);
    let candidate = HookContext {
        agent_id: Some("agent-b".into()),
        caller_user_id: Some("user-b".into()),
        conversation_id: Some("conversation-b".into()),
        flags: std::iter::once(("plugin-b".to_owned(), true)).collect(),
        event: Some(json!({ "rewritten": true })),
        ..Default::default()
    };
    let forwarded = preserve_middleware_identity(&identity, candidate);
    assert_eq!(forwarded.agent_id.as_deref(), Some("agent-a"));
    assert_eq!(forwarded.caller_user_id.as_deref(), Some("user-a"));
    assert_eq!(forwarded.conversation_id.as_deref(), Some("conversation-a"));
    assert_eq!(forwarded.flags.get("plugin-a"), Some(&true));
    assert_eq!(forwarded.event, Some(json!({ "rewritten": true })));
}

#[test]
fn delegation_lifecycle_is_an_exact_match_phase() {
    assert!(phase_matches(
        ON_DELEGATION_LIFECYCLE,
        ON_DELEGATION_LIFECYCLE
    ));
    assert!(!phase_matches(ON_DELEGATION_LIFECYCLE, ON_NOTIFICATION));
    assert!(!phase_matches(
        ON_DELEGATION_LIFECYCLE,
        ON_POST_ASSISTANT_TURN
    ));
}

#[test]
fn directive_default_is_none() {
    assert_eq!(HookDirective::default(), HookDirective::None);
}

// ── Cheap pre-gate (`match`) ──────────────────────────────────────────────
