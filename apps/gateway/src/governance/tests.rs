#[test]
fn administrative_audit_is_operator_only_and_not_an_owner_self_grant() {
    let allow = default_grant_allowlist();
    let reserved = reserved_namespaces();
    let default = GrantPolicy {
        allowlist: &allow,
        reserved_namespaces: &reserved,
        owner_scoped: true,
        protected_owner_ids: &[],
    };
    for owner in [
        "@evil/usage",
        "com.evil.usage",
        "usage",
        "@ryu/video-studio",
    ] {
        let result = ryu_gw_governance::validate_grants_for(
            Some(owner),
            &scopes(&["usage:read", "usage:audit"]),
            &default,
        );
        assert_eq!(result.approved, vec!["usage:read"]);
        assert_eq!(result.denied, vec!["usage:audit"]);
    }
    let approved = vec!["usage:audit".to_owned()];
    let explicit = GrantPolicy {
        allowlist: &approved,
        reserved_namespaces: &reserved,
        owner_scoped: false,
        protected_owner_ids: &[],
    };
    assert!(ryu_gw_governance::validate_grants_for(
        Some("@ryu/video-studio"),
        &scopes(&["usage:audit"]),
        &explicit
    )
    .all_approved());
}

use super::*;
use ed25519_dalek::Signer;
use serde_json::json;

/// Shorthand for the common `&[&str] -> Vec<String>` in these tests.
fn scopes(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn default_allowlist_approves_known_grant() {
    let d = validate_grants_for(None, &scopes(&["mcp.tools", "memory.read"]));
    assert!(d.all_approved());
    assert_eq!(d.approved.len(), 2);
    assert!(d.denied.is_empty());
}

#[test]
fn shared_egress_grant_is_reviewed() {
    let d = validate_grants_for(Some("@ryu/mpp"), &scopes(&["egress:http"]));
    assert!(d.all_approved());
    assert_eq!(d.approved, vec!["egress:http".to_owned()]);
}

#[test]
fn deferred_authorization_is_reviewed_without_namespace_self_approval() {
    let decision = validate_grants_for(Some("com.example.app"), &scopes(&["authorization:defer"]));
    assert!(decision.all_approved());
    let denied = validate_grants_for(
        Some("com.example.authorization"),
        &scopes(&["authorization:arbitrary"]),
    );
    assert_eq!(denied.denied, scopes(&["authorization:arbitrary"]));
}

#[test]
fn conversation_reactions_grant_is_reviewed() {
    let d = validate_grants_for(
        Some("@ryu/agent-comms"),
        &scopes(&["conversation:reactions"]),
    );
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    assert_eq!(d.approved, vec!["conversation:reactions".to_owned()]);
}

#[test]
fn life_recorder_sensitive_grants_are_exact_owner_scoped() {
    let grants = scopes(&["timeline:speech", "media:record"]);
    assert!(validate_grants_for(Some("@ryu/life-recorder"), &grants).all_approved());
    assert!(!validate_grants_for(Some("com.evil.life-recorder"), &grants).all_approved());
    assert!(
        !validate_grants_for(Some("com.evil.media"), &scopes(&["media:record"])).all_approved()
    );
}

#[test]
fn teleprompter_microphone_grant_is_exact_owner_scoped() {
    let grants = scopes(&["storage:kv", "media:record", "media:transcribe"]);
    assert!(validate_grants_for(Some("@ryu/teleprompter"), &grants).all_approved());
    assert!(validate_grants_for(Some("com.ryu.teleprompter"), &grants).all_approved());
    assert!(!validate_grants_for(Some("com.evil.teleprompter"), &grants).all_approved());
    assert!(
        !validate_grants_for(Some("@ryu/teleprompter"), &scopes(&["timeline:speech"]))
            .all_approved()
    );
}

#[test]
fn video_studio_recorder_grant_is_exact_owner_scoped() {
    let record = scopes(&["media:record"]);
    assert!(validate_grants_for(Some("@ryu/video-studio"), &record).all_approved());
    assert!(validate_grants_for(Some("com.ryu.video-studio"), &record).all_approved());
    assert!(!validate_grants_for(Some("com.evil.video-studio"), &record).all_approved());
    // The speech primitive stays Life Recorder only.
    assert!(
        !validate_grants_for(Some("@ryu/video-studio"), &scopes(&["timeline:speech"]))
            .all_approved()
    );
}

#[test]
fn voice_microphone_grant_is_exact_owner_scoped() {
    let grants = scopes(&[
        "files:download",
        "media:generate",
        "media:record",
        "media:transcribe",
        "storage:kv",
        "voice:models:manage",
    ]);
    let d = validate_grants_for(Some("@ryu/voice"), &grants);
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    assert!(validate_grants_for(Some("com.ryu.voice"), &scopes(&["media:record"])).all_approved());
    assert!(
        !validate_grants_for(Some("com.evil.voice"), &scopes(&["media:record"])).all_approved()
    );
    assert!(!validate_grants_for(Some("@ryu/voice"), &scopes(&["timeline:speech"])).all_approved());
}

#[test]
fn native_host_grants_are_reviewed_and_approved() {
    let d = validate_grants_for(
        Some("@ryu/tokenmaxxing"),
        &scopes(&[
            "native:haptics",
            "native:notifications",
            "native:live_activities",
            "notifications:send",
            "storage:kv",
        ]),
    );
    assert!(d.all_approved());
    assert_eq!(d.approved.len(), 5);
    assert!(d.denied.is_empty());
}

#[test]
fn unknown_grant_is_denied_and_blocks() {
    // Neither allowlisted nor owner-scoped (`filesystem` ≠ `canvas`).
    let d = validate_grants_for(
        Some("@ryu/canvas"),
        &scopes(&["mcp.tools", "filesystem.write_all"]),
    );
    assert!(!d.all_approved());
    assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
    assert_eq!(d.approved, vec!["mcp.tools".to_string()]);
}

#[test]
fn empty_grants_approve() {
    let d = validate_grants_for(Some("@ryu/monitors"), &[]);
    assert!(d.all_approved());
}

#[test]
fn protected_first_party_namespace_rejects_owner_squat() {
    let owned = validate_grants_for(Some("@ryu/monitors"), &scopes(&["monitors:crud"]));
    assert!(owned.all_approved(), "denied: {:?}", owned.denied);

    let impostor = validate_grants_for(Some("com.evil.monitors"), &scopes(&["monitors:crud"]));
    assert_eq!(impostor.denied, vec!["monitors:crud".to_string()]);
}

#[test]
fn vault_namespace_is_reserved_and_fill_is_browser_only() {
    for id in [
        "com.x.vault",
        "@evil/vault",
        "vault",
        "@acme/browser",
        "com.acme.notes",
    ] {
        let result = validate_grants_for(
            Some(id),
            &scopes(&["vault:fill", "vault:read", "vault:admin"]),
        );
        assert!(result.approved.is_empty(), "{id}: {:?}", result.approved);
    }
    for id in ["@ryu/browser", "com.ryu.browser"] {
        let result = validate_grants_for(
            Some(id),
            &scopes(&["vault:fill", "vault:read", "vault:admin"]),
        );
        assert_eq!(result.approved, vec!["vault:fill".to_string()]);
        assert_eq!(
            result.denied,
            vec!["vault:read".to_string(), "vault:admin".to_string()]
        );
    }
}

#[test]
fn project_guidance_is_projects_only() {
    for id in [
        "com.evil.projects",
        "@evil/projects",
        "@ryu/drafts",
        "@ryu/chat-broadcast",
        "@ryu/video-studio",
        "chat",
    ] {
        let result = validate_grants_for(Some(id), &scopes(&["chat:project-guidance"]));
        assert!(result.approved.is_empty(), "{id}: {:?}", result.approved);
    }
    for id in ["@ryu/projects", "com.ryu.projects"] {
        let result = validate_grants_for(Some(id), &scopes(&["chat:project-guidance"]));
        assert_eq!(result.approved, vec!["chat:project-guidance".to_string()]);
    }
}

#[test]
fn subscriptions_namespace_is_reserved_and_only_read_is_allowlisted() {
    for id in [
        "com.x.subscriptions",
        "@evil/subscriptions",
        "subscriptions",
    ] {
        let result = validate_grants_for(
            Some(id),
            &scopes(&[
                "subscriptions:read",
                "subscriptions:pin",
                "subscriptions:write",
            ]),
        );
        assert_eq!(result.approved, vec!["subscriptions:read".to_string()]);
        assert_eq!(
            result.denied,
            vec![
                "subscriptions:pin".to_string(),
                "subscriptions:write".to_string()
            ]
        );
    }
}

#[test]
fn safe_actions_namespace_rejects_owner_squat() {
    for id in ["@ryu/safe-actions", "com.ryu.safe-actions"] {
        let owned = validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]));
        assert!(owned.all_approved(), "{id} denied: {:?}", owned.denied);
    }

    for id in [
        "com.evil.safe-actions",
        "@evil/safe-actions",
        "safe-actions",
    ] {
        let impostor = validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]));
        assert_eq!(
            impostor.denied,
            vec!["safe-actions:manage".to_string()],
            "{id} must not squat on Safe Actions' namespace"
        );
    }
}

#[test]
fn manual_hook_grant_is_restricted_to_seeded_chat_title() {
    let seeded = validate_grants_for(Some("@ryu/chat-title"), &scopes(&["hook:run-self"]));
    assert!(seeded.all_approved());

    let third_party = validate_grants_for(Some("com.acme/chat-title"), &scopes(&["hook:run-self"]));
    assert_eq!(third_party.denied, vec!["hook:run-self".to_string()]);
}

#[test]
fn run_agent_write_is_not_default_and_restricted_to_reviewed_owners() {
    assert!(!default_grant_allowlist()
        .iter()
        .any(|grant| grant == RUN_AGENT_WRITE_GRANT));
    for id in RUN_AGENT_WRITE_OWNERS {
        assert!(
            validate_grants_for(
                Some(id),
                &scopes(&["hook:run-agent", RUN_AGENT_WRITE_GRANT])
            )
            .all_approved(),
            "{id}"
        );
    }
    for id in [
        "com.acme.autopilot",
        "@evil/sites",
        "com.evil.hook",
        "proof",
    ] {
        assert_eq!(
            validate_grants_for(Some(id), &scopes(&[RUN_AGENT_WRITE_GRANT])).denied,
            vec![RUN_AGENT_WRITE_GRANT.to_owned()],
            "{id}"
        );
    }
    // Plain read-only run-agent stays on the default allowlist.
    assert!(
        validate_grants_for(Some("com.acme.thing"), &scopes(&["hook:run-agent"])).all_approved()
    );
}

#[test]
fn owner_exclusive_grants_never_leak_across_owners_or_onto_the_allowlist() {
    for row in OWNER_EXCLUSIVE_GRANTS {
        for grant in row.grants {
            assert!(
                !grant_allowlist().iter().any(|g| g == grant),
                "{grant} is owner-exclusive and must stay off the global allowlist"
            );
            for other in OWNER_EXCLUSIVE_GRANTS {
                if std::ptr::eq(other, row) {
                    continue;
                }
                for id in other.owner_ids {
                    // A grant reviewed for several exact owners (e.g.
                    // `media:record`) is not a leak to those owners; every
                    // other owner must still be denied it.
                    let reviewed_for_id = OWNER_EXCLUSIVE_GRANTS.iter().any(|candidate| {
                        candidate.owner_ids.contains(id) && candidate.grants.contains(grant)
                    });
                    if reviewed_for_id {
                        continue;
                    }
                    assert!(
                        !validate_grants_for(Some(id), &scopes(&[*grant])).all_approved(),
                        "{id} must not receive {grant}"
                    );
                }
            }
        }
    }
    assert!(owner_exclusive_grants("  @RYU/Kill-Switch ").contains(&"execution:control"));
    assert!(owner_exclusive_grants("@ryu/kill-switch-extra").is_empty());
}

#[test]
fn execution_control_requires_the_reviewed_kill_switch_owner() {
    for id in ["@ryu/kill-switch", "com.ryu.kill-switch"] {
        assert!(validate_grants_for(Some(id), &scopes(&["execution:control"])).all_approved());
    }
    for id in [
        "com.evil.execution",
        "@evil/kill-switch",
        "com.evil.kill-switch",
    ] {
        assert_eq!(
            validate_grants_for(Some(id), &scopes(&["execution:control"])).denied,
            vec!["execution:control".to_owned()]
        );
    }
}

#[test]
fn identity_vault_scopes_are_approved() {
    // #523: the identity-vault grant scopes must be on the built-in allowlist
    // so a credential-read/connect flow is governed, not denied. Both are in
    // RESERVED namespaces (`browser`, `identity`), so the reviewed entry is
    // the only thing approving them — no app can name its way into them.
    let d = validate_grants_for(
        Some("@ryu/browser"),
        &scopes(&["browser.connect", "identity.read"]),
    );
    assert!(d.all_approved());
    assert_eq!(d.approved.len(), 2);
    assert!(d.denied.is_empty());
}

#[test]
fn workflows_companion_grants_are_approved() {
    // Crux #2: the Workflows companion's four bridge grants must all survive a
    // runtime disable→re-enable (which re-runs `/v1/grants/validate`) instead
    // of being dropped with GrantsDenied — which would leave the canvas unable
    // to call anything. Post-grammar the three `workflows:*` scopes are
    // owner-scoped (`@ryu/workflows` ⇒ namespace `workflows`) and
    // `ghost:record` is a reviewed host primitive; the app must not notice.
    let d = validate_grants_for(
        Some("@ryu/workflows"),
        &scopes(&[
            "workflows:crud",
            "workflows:runstate",
            "workflows:catalogs",
            "ghost:record",
        ]),
    );
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    assert_eq!(d.approved.len(), 4);
}

#[test]
fn healing_run_recovery_grants_are_reviewed_and_runs_is_reserved() {
    // `@ryu/healing` subscribes to `core#run.failed` and applies its verdicts
    // through three kernel capabilities; its whole declared set must validate
    // or `enable_app` fails the app with GrantsDenied.
    let d = validate_grants_for(
        Some("@ryu/healing"),
        &scopes(&[
            "runs:failures",
            "approvals:request",
            "runs:rerun-agent",
            "workflows:runstate",
        ]),
    );
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    // `runs` is reserved: an app named after it gets nothing beyond the
    // reviewed exact entries.
    let d = validate_grants_for(
        Some("com.evil.runs"),
        &scopes(&["runs:everything", "runs:rerun-workflow"]),
    );
    assert_eq!(d.approved, Vec::<String>::new());
    assert_eq!(d.denied.len(), 2);
    // The reviewed `approvals:request` does not widen to the owner-scoped inbox
    // CRUD for anyone but `@ryu/approvals`.
    let d = validate_grants_for(Some("@ryu/healing"), &scopes(&["approvals:crud"]));
    assert_eq!(d.denied, vec!["approvals:crud".to_string()]);
}

#[test]
fn cross_app_request_grants_are_form_checked_and_individually_reviewed() {
    // The one reviewed target: the Workflows Companion reading Recipes.
    let d = validate_grants_for(Some("@ryu/workflows"), &scopes(&["app:http:@ryu/recipes"]));
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    // Malformed targets: wildcards, unscoped / legacy ids, extra segments,
    // empty, uppercase. Denied for every caller, including the target itself.
    for bad in [
        "app:http:*",
        "app:http:@ryu/*",
        "app:http:@*/recipes",
        "app:http:recipes",
        "app:http:com.ryu.recipes",
        "app:http:@ryu/recipes/extra",
        "app:http:@ryu/",
        "app:http:",
        "app:http:@Ryu/Recipes",
        "APP:HTTP:@ryu/recipes",
    ] {
        for caller in [
            "@ryu/workflows",
            "@ryu/recipes",
            "com.evil.app",
            "@evil/app",
        ] {
            let d = validate_grants_for(Some(caller), &scopes(&[bad]));
            assert_eq!(d.denied, vec![bad.to_string()], "{caller} → {bad}");
        }
    }
    // Well-formed but unreviewed targets: denied, and no owner-scoped
    // self-grant reaches them (the `app` namespace is reserved).
    for unreviewed in ["app:http:@ryu/mail", "app:http:@acme/notes"] {
        for caller in ["@ryu/workflows", "@acme/notes", "com.evil.app", "@evil/app"] {
            let d = validate_grants_for(Some(caller), &scopes(&[unreviewed]));
            assert_eq!(
                d.denied,
                vec![unreviewed.to_string()],
                "{caller} → {unreviewed}"
            );
        }
    }
    let d = validate_grants_for(Some("com.evil.app"), &scopes(&["app:anything"]));
    assert_eq!(d.denied, vec!["app:anything".to_string()]);
    // Mixed requests keep the general grammar for everything else.
    let d = validate_grants_for(
        Some("@ryu/workflows"),
        &scopes(&["workflows:crud", "app:http:@ryu/recipes", "app:http:*"]),
    );
    assert_eq!(d.approved, vec!["workflows:crud", "app:http:@ryu/recipes"]);
    assert_eq!(d.denied, vec!["app:http:*"]);
    // Every reviewed per-target entry is itself well-formed.
    for entry in default_grant_allowlist() {
        if is_app_http_target_grant(&entry) {
            assert!(app_http_target_grant_well_formed(&entry), "{entry}");
        }
    }
}

#[test]
fn blueprint_app_grants_are_approved() {
    // The two halves of `@ryu/blueprint`'s declared set travel through DIFFERENT
    // rules, and asserting them together is the point: `blueprint:review` is a
    // reviewed cross-app host capability consumed by Blueprint and Feedback Board,
    // while `mcp:blueprint` is in the reserved `mcp` namespace and can only ever be
    // approved by its explicit entry. A change that cleans up either one breaks
    // enable, because `enable_app` demands `all_approved` and fails the whole app
    // on a single denial — the app installs, and then has no sidecar or MCP tools.
    let d = validate_grants_for(
        Some("@ryu/blueprint"),
        &scopes(&["blueprint:review", "mcp:blueprint"]),
    );
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    assert_eq!(d.approved.len(), 2);

    // The capability is deliberately reusable by another first-party consumer.
    let consumer = validate_grants_for(Some("@ryu/feedback-board"), &scopes(&["blueprint:review"]));
    assert!(consumer.all_approved(), "denied: {:?}", consumer.denied);
}

// ── capability grammar, against the REAL gateway policy ──────────────────

/// **Requirement-5 regression proof.** Every capability string that used to
/// be hand-listed in `default_grant_allowlist()` — including the 14 per-app
/// companion scopes the grammar retired — paired with the manifest id that
/// actually declares it. Each must still validate, whether it now passes via
/// the owner-scoped rule or the retained host-primitive vocabulary.
///
/// This is a **frozen historical table**, deliberately restated rather than
/// derived: removing entries from the built-in list is the goal, and a
/// derived table would shrink alongside it and stop proving anything. The
/// fixture-driven `every_builtin_fixture_grant_is_allowlisted` below is the
/// forward-looking half (it catches a NEW fixture with an ungranted scope);
/// this one is the backward-looking half.
#[test]
fn every_pre_grammar_allowlist_entry_still_validates() {
    // (owning manifest id, capability scope) — the id is the one that really
    // declares the scope in `apps/core/src/plugin_manifest/fixtures/`, or a
    // representative holder for the scopes no fixture declares.
    let table: &[(&str, &str)] = &[
        // tool / MCP capability scopes (host vocabulary, no declarer)
        ("@ryu/canvas", "mcp.tools"),
        ("@ryu/canvas", "tools.read"),
        ("@ryu/canvas", "tools.invoke"),
        // per-server MCP tool grants from the seeded system MCP-tool plugins
        ("spider", "mcp:spider"),
        ("agentbrowser", "mcp:agentbrowser"),
        ("ghost", "mcp:ghost"),
        ("shadow", "mcp:shadow"),
        // declarative `http` / `command` tool plugins
        ("exa", "tool:http-egress:api.exa.ai"),
        ("@ryu/advisor", "tool:http-egress:127.0.0.1"),
        ("spider", "tool:command:spider"),
        ("rtk", "tool:command:rtk"),
        ("just-bash", "tool:command:just-bash"),
        // data scopes
        ("@ryu/canvas", "memory.read"),
        ("@ryu/canvas", "memory.write"),
        ("@ryu/canvas", "spaces.read"),
        ("@ryu/canvas", "spaces.write"),
        ("@ryu/canvas", "files.read"),
        // companion bridge capabilities (the 14 the grammar retired)
        ("@ryu/monitors", "monitors:crud"),
        ("@ryu/mail", "mail:crud"),
        ("@ryu/finetune", "finetune:runs"),
        ("@ryu/workflows", "workflows:crud"),
        ("@ryu/workflows", "workflows:runstate"),
        ("@ryu/workflows", "workflows:catalogs"),
        ("@ryu/simulator", "simulator:control"),
        ("@ryu/webhooks", "webhooks:crud"),
        ("@ryu/activity", "activity:read"),
        ("@ryu/timeline", "timeline:read"),
        ("@ryu/calendar", "calendar:crud"),
        ("@ryu/learning", "learning:crud"),
        ("@ryu/approvals", "approvals:crud"),
        ("@ryu/meetings", "meetings:crud"),
        // cross-app / reserved-namespace holds that stay on the list
        ("@ryu/skill-editor", "skills:crud"),
        ("@ryu/quests", "quests:crud"),
        ("@ryu/quests", "quests:capture"),
        ("@ryu/approvals", "quests:crud"),
        ("@ryu/browser", "browser:control"),
        // model / network scopes
        ("@ryu/canvas", "model.chat"),
        ("@ryu/canvas", "model.embed"),
        ("@ryu/canvas", "network.fetch"),
        // identity-vault scopes (#523)
        ("@ryu/browser", "browser.connect"),
        ("@ryu/browser", "identity.read"),
        ("@ryu/browser", "vault:fill"),
        ("@ryu/projects", "chat:project-guidance"),
        // widget consent + companion host primitives
        ("sample-widget", "widget:render"),
        ("@ryu/canvas", "spaces:docs"),
        ("@ryu/canvas", "core:list_agents"),
        ("@ryu/canvas", "media:generate"),
        ("@ryu/canvas", "media:transcribe"),
        ("proof", "hook:run-agent"),
        ("double-check", "hook:side-model"),
        ("@ryu/workflows", "ghost:record"),
        ("@ryu/activity", "shell:integrate"),
        ("goal", "storage:kv"),
        ("checklist", "chat.sendFollowUp"),
    ];

    let mut failures: Vec<String> = Vec::new();
    for (app_id, scope) in table {
        let d = validate_grants_for(Some(app_id), &scopes(&[scope]));
        if !d.all_approved() {
            failures.push(format!("{app_id} → '{scope}'"));
        }
    }
    assert!(
        failures.is_empty(),
        "first-party capability regression: these validated before the capability \
         grammar and must still validate (add the scope to default_grant_allowlist() \
         if it is a host primitive, or check that the app id's last segment matches \
         the capability namespace): {}",
        failures.join(", ")
    );
}

#[test]
fn third_party_app_self_grants_its_own_namespace() {
    // The whole point: an app nobody hardcoded, declaring capabilities in its
    // own namespace, validates — so it can actually be ENABLED (Core aborts
    // enable with GrantsDenied on any denial) with no Gateway edit.
    let d = validate_grants_for(
        Some("com.acme.invoices"),
        &scopes(&["invoices:crud", "invoices:export", "invoices.read"]),
    );
    assert!(d.all_approved(), "denied: {:?}", d.denied);
    assert_eq!(d.approved.len(), 3);
}

#[test]
fn spoofed_app_id_cannot_claim_another_apps_namespace() {
    // The named spoofing case: `com.ryu.evil` must not self-approve the
    // Monitors app's capability. Its owner namespace is `evil`, `monitors` is
    // not on the reviewed list any more, so it is denied outright.
    let d = validate_grants_for(Some("com.ryu.evil"), &scopes(&["monitors:crud"]));
    assert_eq!(d.denied, vec!["monitors:crud".to_string()]);
    assert!(d.approved.is_empty());

    // Nor by dressing the id up as a prefix/suffix of the real owner.
    for id in [
        "monitors.evil",
        "@ryu/monitors.evil",
        "com.ryu.evil-monitors",
        "com.ryu.monitorz",
    ] {
        let d = validate_grants_for(Some(id), &scopes(&["monitors:crud"]));
        assert_eq!(
            d.denied,
            vec!["monitors:crud".to_string()],
            "'{id}' must not reach the monitors namespace"
        );
    }
}

#[test]
fn sidecar_process_is_never_approved_by_any_caller() {
    // Handoff §8 + requirement 3: running an unsandboxed managed process from
    // a manifest is arbitrary code execution. It is on no default allowlist,
    // and `sidecar` is reserved so no manifest id can name its way into it.
    for id in [
        "@ryu/monitors",
        "com.evil.sidecar",
        "sidecar",
        "com.ryu.sidecar",
    ] {
        let d = validate_grants_for(Some(id), &scopes(&["sidecar:process"]));
        assert_eq!(
            d.denied,
            vec!["sidecar:process".to_string()],
            "'{id}' must not self-approve sidecar:process"
        );
    }
}

#[test]
fn reserved_host_namespaces_are_not_self_grantable() {
    // A privileged scope that is NOT on the reviewed list stays denied even
    // for an app that named itself after the namespace — the fence that keeps
    // the grammar from loosening the host-primitive set.
    let cases: &[(&str, &str)] = &[
        ("com.evil.memory", "memory.purge"),
        ("com.evil.model", "model.finetune"),
        ("com.evil.files", "files.write"),
        ("com.evil.network", "network.listen"),
        ("com.evil.tool", "tool:command:rm"),
        ("com.evil.tool", "tool:http-egress:evil.example"),
        ("com.evil.mcp", "mcp:evil"),
        ("com.evil.identity", "identity.write"),
        ("com.evil.core", "core:shutdown"),
        ("com.evil.hook", "hook:pre-turn"),
        ("com.evil.widget", "widget:inject"),
        ("com.evil.shell", "shell:exec"),
        ("com.evil.storage", "storage:global"),
        ("com.evil.chat", "chat.readAll"),
        ("com.evil.media", "media:record"),
        ("com.evil.ghost", "ghost:replay"),
        ("com.evil.browser", "browser:hijack"),
        ("com.evil.spaces", "spaces:purge"),
        ("com.evil.skills", "skills:write"),
        ("com.evil.quests", "quests:purge"),
        ("com.evil.self_build", "self_build:write"),
        // The three namespaces an adversarial pass caught missing: each names
        // a host verb that Core gates on `approved_grants`, so a miss here is
        // not cosmetic — it is a capability the grammar hands out that the
        // pre-grammar allowlist denied to everyone.
        //
        // `runtime:external` is the sharp one: it is what
        // `external_runtime::may_provision` checks before a Community-tier
        // plugin runs `pip install` from its own manifest.
        ("com.evil.runtime", "runtime:external"),
        ("runtime", "runtime:external"),
        // `ui:send_message` posts a chat turn as the user; `ui:render`
        // promotes a frame; `views:actions` relays a shell view intent.
        ("com.evil.ui", "ui:send_message"),
        ("com.evil.ui", "ui:render"),
        ("com.evil.views", "views:actions"),
    ];
    let mut approved: Vec<String> = Vec::new();
    for (app_id, scope) in cases {
        if validate_grants_for(Some(app_id), &scopes(&[scope])).all_approved() {
            approved.push(format!("{app_id} → '{scope}'"));
        }
    }
    assert!(
        approved.is_empty(),
        "reserved host-primitive namespaces must never be owner-scoped: {}",
        approved.join(", ")
    );
}

#[test]
fn env_override_parses_and_replaces_the_default_list() {
    // The operator override keeps working as an override/extension. Parsed
    // through the same helper the process cache uses; the cache itself is a
    // `OnceLock`, so we exercise the policy with the parsed value directly
    // rather than mutating process env from a parallel test.
    assert_eq!(
        parse_grant_allowlist_env(""),
        None,
        "blank ⇒ built-in default"
    );
    assert_eq!(parse_grant_allowlist_env("   \n"), None);
    let parsed = parse_grant_allowlist_env("sidecar:process, mcp.tools\nmemory.read")
        .expect("non-blank value parses");
    assert_eq!(
        parsed,
        scopes(&["sidecar:process", "mcp.tools", "memory.read"])
    );

    // An override CAN approve a reserved scope the built-in default refuses —
    // that is the point of an operator escape hatch, and it stays explicit
    // (an exact scope, not an un-reserved family).
    let reserved = reserved_namespaces();
    let policy = GrantPolicy {
        allowlist: &parsed,
        reserved_namespaces: &reserved,
        owner_scoped: true,
        protected_owner_ids: &[],
    };
    let d = ryu_gw_governance::validate_grants_for(
        Some("@ryu/browser"),
        &scopes(&["sidecar:process"]),
        &policy,
    );
    assert!(d.all_approved(), "an explicit override entry approves");

    // …and a narrowed override still denies what it left out.
    let d = ryu_gw_governance::validate_grants_for(
        Some("@ryu/browser"),
        &scopes(&["browser:control"]),
        &policy,
    );
    assert_eq!(d.denied, vec!["browser:control".to_string()]);
}

#[test]
fn owner_scoped_env_toggle_parses_off_words_only() {
    for off in ["0", "false", "no", "off", " OFF ", "False"] {
        assert!(!parse_owner_scoped_env(off), "'{off}' must disable");
    }
    for on in ["1", "true", "yes", "", "banana"] {
        assert!(parse_owner_scoped_env(on), "'{on}' must leave it on");
    }

    // With the rule off, the gateway is back to a pure allowlist: an app's
    // own namespace is no longer enough.
    let allow = default_grant_allowlist();
    let reserved = reserved_namespaces();
    let strict = GrantPolicy {
        allowlist: &allow,
        reserved_namespaces: &reserved,
        owner_scoped: false,
        protected_owner_ids: &[],
    };
    let d = ryu_gw_governance::validate_grants_for(
        Some("@ryu/monitors"),
        &scopes(&["monitors:crud"]),
        &strict,
    );
    assert_eq!(d.denied, vec!["monitors:crud".to_string()]);
}

#[test]
fn default_allowlist_holds_no_retired_per_app_scope() {
    // Tripwire against re-growing the list one app at a time. If a first-party
    // capability is denied, fix the id/namespace match or classify it as a host
    // primitive — do not paste the string back in.
    let allow = default_grant_allowlist();
    let retired = [
        "monitors:crud",
        "finetune:runs",
        "simulator:control",
        "webhooks:crud",
        "activity:read",
        "timeline:read",
        "calendar:crud",
        "learning:crud",
        "approvals:crud",
        "meetings:crud",
    ];
    let regrown: Vec<&str> = retired
        .iter()
        .copied()
        .filter(|scope| allow.iter().any(|a| a.eq_ignore_ascii_case(scope)))
        .collect();
    assert!(
        regrown.is_empty(),
        "these are owner-scoped and must NOT be hardcoded again: {regrown:?}"
    );
}

/// Drift tripwire: every grant a **seeded built-in** fixture declares must
/// validate *for that fixture's own id*. Core's enable path
/// (`plugins/lifecycle.rs`) sends an app's full `permission_grants` set —
/// with its manifest id as `app_id` — through `/v1/grants/validate` on every
/// enable, including a runtime disable→re-enable, so a declared grant that
/// neither the allowlist nor the owner-scoped rule approves is denied with
/// GrantsDenied and the app cannot re-enable.
///
/// Feeding the fixture's real `id` (not `None`) is what makes this the
/// forward-looking half of the requirement-5 proof: a new app whose
/// capability namespace does not match its id fails HERE, at the same place
/// an unlisted host primitive does.
///
/// Rather than restate the grant set (which would silently pass when a NEW
/// fixture adds an unlisted grant — the exact drift this guards), the test
/// READS the fixtures Core compiles in (`apps/core/src/plugin_manifest/
/// fixtures/*.manifest.json`) and asserts `validate_grants` approves each
/// declared grant. This also enforces handoff §8 automatically: a fixture that
/// declared `sidecar:process` (or any other unlisted scope) would fail here.
///
/// `sample.manifest.json` is excluded: it is a test-only demo, not in
/// `SEED_MANIFESTS`, so it is never enabled at runtime and its file-read/
/// web-search scopes must NOT loosen the marketplace-publish allowlist.
///
/// Read at runtime (not `include_str!`, which can't cross crates cleanly) and
/// skipped when the fixtures dir is absent, so a separately-vendored gateway
/// (no sibling `apps/core`) still tests green — mirrors the core companion-pair
/// test's skip-if-absent posture.
#[test]
fn every_builtin_fixture_grant_is_allowlisted() {
    // Built-in manifests live in TWO homes and BOTH must be scanned. The packaged
    // ones moved to `apps-store/<x>/manifest.json` /
    // `plugins-store/{plugins,lsp,external_plugins}/<x>/manifest.json`
    // (Core `include_str!`s them directly; the duplicate fixture copies are gone),
    // leaving only the ~13 Core-only manifests in `fixtures/`.
    //
    // Scanning `fixtures/` alone would still PASS — on 13 files instead of 71 —
    // because every remaining orphan happens to carry an allowlisted grant block.
    // That is a silent 58-manifest hole in a grant check, which is precisely what
    // the `checked_files > 0` guard below cannot catch. Hence both roots.
    let gateway = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut manifest_paths: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(gateway.join("../core/src/plugin_manifest/fixtures")) {
        manifest_paths.extend(entries.flatten().map(|e| e.path()).filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".manifest.json"))
        }));
    }
    for root in ["apps-store", "plugins-store"] {
        if let Ok(entries) = std::fs::read_dir(gateway.join("../..").join("generated/ryu-runtime").join(root)) {
            manifest_paths.extend(
                entries
                    .flatten()
                    .map(|e| e.path().join("manifest.json"))
                    .filter(|p| p.is_file()),
            );
        }
    }
    if manifest_paths.is_empty() {
        // Vendored gateway without sibling `apps/core` or package roots.
        return;
    }
    manifest_paths.sort();

    let mut checked_files = 0;
    let mut checked_grants = 0;
    let mut failures: Vec<String> = Vec::new();

    for path in manifest_paths {
        // Name the OWNING package (`plugins-store/plugins/exa/manifest.json` -> `exa`), not
        // the bare `manifest.json`, so a failure message still identifies the app.
        let name = if path.file_name().and_then(|n| n.to_str()) == Some("manifest.json") {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|n| format!("{}.manifest.json", n.to_string_lossy()))
                .unwrap_or_else(|| path.display().to_string())
        } else {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string())
        };
        if name == "sample.manifest.json" {
            continue; // test-only demo, not seeded (see doc comment)
        }
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", path.display()));
        let manifest: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("fixture {name} is not valid JSON: {e}"));
        let Some(grants) = manifest.get("permission_grants").and_then(Value::as_array) else {
            continue; // no declared grants
        };
        // The id is load-bearing here: it is the subject of the owner-scoped
        // rule. A fixture without one cannot owner-scope anything.
        let app_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("fixture {name} declares grants but has no `id`"));
        checked_files += 1;
        let declared: Vec<String> = grants
            .iter()
            .filter_map(|g| g.as_str().map(str::to_string))
            .collect();
        let decision = validate_grants_for(Some(app_id), &declared);
        for denied in decision.denied {
            // Community managed-sidecar, MCP-server, Scrapling, and Pi-extension
            // packages intentionally declare operator-only grants. They must
            // stay absent from the default allowlist; the dedicated
            // reserved-namespace tests below pin that fail-closed policy.
            // This fixture audit covers the safe host vocabulary, not operator
            // opt-ins. Core-tier packages may still use the host gate directly.
            if matches!(
                denied.as_str(),
                "sidecar:process" | "mcp:server" | "mcp:scrapling" | "pi:extension"
            ) {
                continue;
            }
            failures.push(format!("{name} ({app_id}): '{denied}'"));
        }
        checked_grants += declared.len();
    }

    assert!(
        failures.is_empty(),
        "seeded built-in fixtures declare grants that neither default_grant_allowlist() nor \
         the owner-scoped rule approves (a runtime disable→re-enable would fail with \
         GrantsDenied). Either the capability namespace does not match the last segment of \
         the app's id, or the scope is a host primitive that must be added to the allowlist \
         (and, for `sidecar:process`, removed from the fixture per handoff §8): {}",
        failures.join(", ")
    );
    // Guard against a vacuous pass: the dir existed, so we must have parsed at
    // least a few grant-bearing fixtures.
    assert!(
        checked_files > 0 && checked_grants > 0,
        "fixtures dir resolved but no grant-bearing fixtures were read \
         (checked_files={checked_files}, checked_grants={checked_grants})"
    );
}

/// Every first-party capability a satellite **provides** (`provides[].grant`
/// in `apps-store/<app>/manifest.json`) is gated by Core's broker only on the
/// caller holding that grant. So the grant's namespace must be either a
/// reserved host primitive or a protected first-party namespace; otherwise
/// `@evil/teams` names itself into `teams:manage`. Derived from the manifests
/// so a new provider cannot ship without protection.
#[test]
fn every_first_party_provided_grant_namespace_is_protected() {
    fn collect_provided_grants(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if key == "provides" {
                        for entry in child.as_array().into_iter().flatten() {
                            if let Some(grant) = entry.get("grant").and_then(Value::as_str) {
                                out.push(grant.to_string());
                            }
                        }
                    }
                    collect_provided_grants(child, out);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect_provided_grants(item, out);
                }
            }
            _ => {}
        }
    }

    let apps_store = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps-store");
    let Ok(entries) = std::fs::read_dir(&apps_store) else {
        // Vendored gateway without the sibling apps-store.
        return;
    };
    let mut manifest_paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path().join("manifest.json"))
        .filter(|p| p.is_file())
        .collect();
    manifest_paths.sort();

    let reserved = reserved_namespace_list();
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    for path in manifest_paths {
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let manifest: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
        let mut provided = Vec::new();
        collect_provided_grants(&manifest, &mut provided);
        if provided.is_empty() {
            continue;
        }
        let owner = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{} provides grants but has no `id`", path.display()));
        for grant in provided {
            checked += 1;
            let Some(namespace) = ryu_gw_governance::capability_namespace(&grant) else {
                failures.push(format!("{owner}: malformed provided grant '{grant}'"));
                continue;
            };
            if reserved.iter().any(|r| r.eq_ignore_ascii_case(namespace)) {
                // Reserved namespaces are never owner-scoped; only the
                // reviewed allowlist can approve them.
                continue;
            }
            // A non-allowlisted sibling scope proves the NAMESPACE is fenced
            // even when the provided grant itself is a reviewed cross-app
            // allowlist entry (`blueprint:review`, `rlm:query`).
            let probe = format!("{namespace}:squat-probe");
            let grant_allowlisted = grant_allowlist()
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(grant.trim()));
            for squatter in [
                format!("com.evil.{namespace}"),
                format!("@evil/{namespace}"),
                namespace.to_string(),
            ] {
                if validate_grants_for(Some(&squatter), &scopes(&[&probe])).all_approved() {
                    failures.push(format!(
                        "{squatter} self-grants '{probe}' (namespace of {owner}'s '{grant}')"
                    ));
                }
                if !grant_allowlisted
                    && validate_grants_for(Some(&squatter), &scopes(&[&grant])).all_approved()
                {
                    failures.push(format!("{squatter} self-grants {owner}'s '{grant}'"));
                }
            }
            let decision = validate_grants_for(Some(owner), &scopes(&[&grant]));
            if !decision.all_approved() {
                failures.push(format!("{owner} is denied its own provided '{grant}'"));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "first-party provided grants are not protected; add the provider to \
         protected_owner_id_list(): {}",
        failures.join(", ")
    );
    if apps_store.join("teams/manifest.json").is_file() {
        assert!(
            checked > 0,
            "apps-store resolved but no provided grants were read"
        );
    }
}

#[test]
fn sign_then_verify_roundtrips() {
    let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
    let sig = sign_manifest(&manifest);
    assert!(verify_manifest(&manifest, &sig, None));
}

#[test]
fn explicit_public_key_verifies() {
    let manifest = json!({"id": "x"});
    let sig = sign_manifest(&manifest);
    let pk = public_key_b64();
    assert!(verify_manifest(&manifest, &sig, Some(&pk)));
}

#[test]
fn malformed_pinned_public_key_fails_verify() {
    // The gateway wrapper resolves a caller-pinned public key; a malformed one
    // must return false (unverifiable), not fall through to the process key.
    let manifest = json!({"id": "x"});
    let sig = sign_manifest(&manifest);
    assert!(!verify_manifest(&manifest, &sig, Some("not-base64!!!")));
}

#[test]
fn persist_then_read_signing_key_roundtrips() {
    // A generated key persisted to disk must read back as the SAME key, so a
    // signature made before a restart still verifies after (the dev-persist
    // path that closes the "ephemeral key dies on bounce" gap). We exercise
    // the helpers directly since `signing_key()` is a process-wide OnceLock.
    let mut csprng = rand::rngs::OsRng;
    let key = SigningKey::generate(&mut csprng);
    let dir = std::env::temp_dir().join(format!("ryu-govtest-{}", std::process::id()));
    let path = dir.join("marketplace-signing-key");

    let sealer = test_signing_sealer();
    assert!(
        persist_signing_key(&path, &key, Some(&sealer)),
        "persist should succeed"
    );
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.starts_with("encc:v1:"), "the seed must be sealed");
    assert!(
        !raw.contains(&B64.encode(key.to_bytes())),
        "raw seed on disk"
    );
    let loaded = read_persisted_signing_key(&path, Some(&sealer))
        .unwrap()
        .expect("read back the key");

    // Same public key ⇒ same verifying identity across a simulated restart.
    assert_eq!(
        loaded.verifying_key().to_bytes(),
        key.verifying_key().to_bytes()
    );
    // A signature made with the original verifies against the reloaded key.
    let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
    let sig = B64.encode(
        key.sign(&ryu_gw_governance::canonical_bytes(&manifest))
            .to_bytes(),
    );
    assert!(verify_manifest(
        &manifest,
        &sig,
        Some(&B64.encode(loaded.verifying_key().to_bytes()))
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

fn test_signing_sealer() -> ryu_crypto::ComponentCipher {
    ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
    )
    .unwrap()
}

#[test]
fn legacy_plaintext_signing_seed_is_read_and_resealed() {
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    let seed = B64.encode(key.to_bytes());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("marketplace-signing-key");
    std::fs::write(&path, &seed).unwrap();
    // Readable without a key (plaintext), and left as is.
    let loaded = read_persisted_signing_key(&path, None).unwrap().unwrap();
    assert_eq!(loaded.to_bytes(), key.to_bytes());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), seed);
    // With the key it is resealed in place, keeping the same identity.
    let sealer = test_signing_sealer();
    let loaded = read_persisted_signing_key(&path, Some(&sealer))
        .unwrap()
        .unwrap();
    assert_eq!(loaded.to_bytes(), key.to_bytes());
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.starts_with("encc:v1:"));
    assert!(!raw.contains(&seed));
    // A sealed seed without the key is an error (never a silent new key),
    // and persisting without a key writes nothing.
    assert!(read_persisted_signing_key(&path, None).is_err());
    let other = dir.path().join("other-key");
    assert!(!persist_signing_key(&other, &key, None));
    assert!(!other.exists());
}

#[test]
fn adopting_the_shared_pre_profile_key_never_rewrites_the_release_file() {
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    let seed = B64.encode(key.to_bytes());
    let dir = tempfile::tempdir().unwrap();
    let legacy = dir.path().join("ryu").join("marketplace-signing-key");
    let own = dir.path().join("ryu-dev").join("marketplace-signing-key");
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, &seed).unwrap();

    let sealer = test_signing_sealer();
    let adopted = adopt_legacy_signing_key(&legacy, &own, Some(&sealer)).expect("adopted");
    assert_eq!(adopted.to_bytes(), key.to_bytes());
    // The release profile's file is byte-for-byte what it was, still
    // plaintext: the dev sealer never touched it.
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), seed);
    // The adopted seed lives sealed in this profile's own file.
    let raw = std::fs::read_to_string(&own).unwrap();
    assert!(raw.starts_with("encc:v1:"));
    assert!(!raw.contains(&seed));
    let reloaded = read_persisted_signing_key(&own, Some(&sealer))
        .unwrap()
        .unwrap();
    assert_eq!(reloaded.to_bytes(), key.to_bytes());

    // A legacy file already sealed under the release key cannot be opened
    // here: it is left untouched and nothing is adopted.
    let release_sealed = dir.path().join("sealed").join("marketplace-signing-key");
    let release_sealer = ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    )
    .unwrap();
    assert!(persist_signing_key(
        &release_sealed,
        &key,
        Some(&release_sealer)
    ));
    let before = std::fs::read_to_string(&release_sealed).unwrap();
    let other = dir.path().join("ryu-beta").join("marketplace-signing-key");
    assert!(adopt_legacy_signing_key(&release_sealed, &other, Some(&sealer)).is_none());
    assert_eq!(std::fs::read_to_string(&release_sealed).unwrap(), before);
    assert!(!other.exists());
}

#[test]
fn non_release_profiles_can_adopt_the_shared_pre_profile_key() {
    let data = std::path::Path::new("/home/test/.local/share");
    assert_eq!(
        legacy_signing_key_path_for(&data.join("ryu-beta").join("marketplace-signing-key")),
        Some(data.join("ryu").join("marketplace-signing-key"))
    );
    // The release path is already the shared path; overrides and other
    // file names have no legacy location.
    assert_eq!(
        legacy_signing_key_path_for(&data.join("ryu").join("marketplace-signing-key")),
        None
    );
    assert_eq!(
        legacy_signing_key_path_for(std::path::Path::new("/keys/sign")),
        None
    );
    assert_eq!(
        legacy_signing_key_path_for(&data.join("ryu-beta").join("other-file")),
        None
    );
}

#[test]
fn persisted_signing_key_is_profile_scoped() {
    // A dev Gateway must not read or overwrite the release node's key.
    let data = std::path::Path::new("/home/test/.local/share");
    assert_eq!(
        signing_key_path_for(None, None, Some(data), ""),
        Some(data.join("ryu").join("marketplace-signing-key"))
    );
    assert_eq!(
        signing_key_path_for(None, None, Some(data), "-dev"),
        Some(data.join("ryu-dev").join("marketplace-signing-key"))
    );
    // The explicit override still wins, and blank overrides are ignored.
    assert_eq!(
        signing_key_path_for(Some(" /keys/sign "), None, Some(data), "-dev"),
        Some(std::path::PathBuf::from("/keys/sign"))
    );
    assert_eq!(
        signing_key_path_for(Some("  "), None, Some(data), "-dev"),
        Some(data.join("ryu-dev").join("marketplace-signing-key"))
    );
    assert_eq!(signing_key_path_for(None, None, None, ""), None);
    // Under Core (`RYU_DIR` set) the key lives in the data dir's secrets slot.
    let core = std::path::Path::new("/tmp/ryu-dev-headless");
    assert_eq!(
        signing_key_path_for(None, Some(core), Some(data), "-dev"),
        Some(ryu_sidecar_runtime::layout::secret_path(
            core,
            "marketplace-signing-key"
        ))
    );
    assert_eq!(
        signing_key_path_for(Some("/keys/sign"), Some(core), Some(data), "-dev"),
        Some(std::path::PathBuf::from("/keys/sign"))
    );
}
