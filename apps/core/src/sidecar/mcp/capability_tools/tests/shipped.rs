//! Guards over the real built-in manifests: verb keys, machine targets,
//! selectability and defaults.

use super::*;

// ── Guards over the REAL built-in manifests ──────────────────────────────
//
// Every other test in this module builds synthetic manifests, so none of them
// can see a typo in a shipped fixture. These can. They matter more than
// usual here because Core's manifest loader never calls `validate_capabilities`,
// so nothing else validates a `provides` block at all: a single-underscore verb
// key (`web_search` for `web.search`) is not an error anywhere — it simply
// makes the layer silently serve nothing.

#[test]
fn every_shipped_verb_key_is_a_real_verb() {
    for m in builtins() {
        for entry in m.provided_capabilities() {
            for key in entry.tools.keys() {
                let verb = verb_by_id(key).unwrap_or_else(|| {
                    panic!(
                        "plugin '{}' binds unknown capability verb '{key}' — check for a \
                        single-underscore typo; the canonical ids are `<server>.<name>`",
                        m.id
                    )
                });
                assert_eq!(
                    verb.capability, entry.capability,
                    "plugin '{}' binds verb '{key}' under capability '{}', but that verb \
                     belongs to '{}'",
                    m.id, entry.capability, verb.capability
                );
            }
        }
    }
}

#[test]
fn every_machine_controlling_provider_declares_what_it_acts_on() {
    // Swapping web.search from exa to tavily changes who answers the same
    // question. Swapping computer.control from ghost to bytebot changes which
    // COMPUTER gets typed on — ghost drives this machine, bytebot drives the
    // desktop bytebotd runs on. A picker that renders those two swaps the same
    // way is telling the user something false, and it can only tell them apart
    // if the manifest says so structurally.
    for m in builtins() {
        for entry in m.provided_capabilities() {
            if !MACHINE_CAPABILITIES.contains(&entry.capability.as_str()) {
                continue;
            }
            assert!(
                entry.target.is_some(),
                "provider '{}' serves '{}', which controls a machine, but declares no \
                 `target` — a user cannot tell whether selecting it acts on their own \
                 computer or somewhere else",
                m.id,
                entry.capability
            );
        }
    }
}

#[test]
fn the_two_computer_control_providers_do_not_claim_the_same_machine() {
    // The specific falsehood this whole field exists to stop: offering ghost and
    // bytebot as interchangeable ways to drive "your computer". If a future
    // provider genuinely drives the local machine it may join ghost here, but
    // that has to be a deliberate edit to this test, not a silent default.
    // Reviewed joiner: `@ryu/codex-computer-use` (OpenAI's Codex engine on a
    // target app here) truly acts on this device, so `local-machine` is right.
    // The session Box (Core-served, not a manifest) is a computer.control
    // provider too, and it drives a separate machine.
    let targets: Vec<_> = builtins()
        .iter()
        .flat_map(|m| {
            m.provided_capabilities()
                .iter()
                .filter(|e| e.capability == CAP_COMPUTER)
                .map(|e| (m.id.clone(), e.target))
                .collect::<Vec<_>>()
        })
        .chain(
            core_machine_providers()
                .into_iter()
                .filter(|(_, capability, _)| *capability == CAP_COMPUTER)
                .map(|(id, _, target)| (id, Some(target))),
        )
        .collect();
    assert!(
        targets.contains(&(
            crate::sidecar::mcp::box_desktop::PROVIDER_ID.to_owned(),
            Some(crate::plugin_manifest::ProviderTarget::RemoteDesktop)
        )),
        "the session Box must be registered as a remote-desktop computer provider: {targets:?}"
    );
    assert!(
        targets.len() >= 2,
        "expected at least two computer.control providers, found {targets:?}"
    );
    let distinct: std::collections::BTreeSet<_> =
        targets.iter().map(|(_, t)| format!("{t:?}")).collect();
    assert!(
        distinct.len() > 1,
        "every computer.control provider claims the same target ({distinct:?}) — if that \
         is now true the picker's swap wording is fine, but verify it rather than \
         letting a missing declaration look like agreement"
    );
}

#[test]
fn machine_verbs_are_exactly_the_computer_and_browser_verbs() {
    for verb in verbs() {
        assert_eq!(
            is_machine_verb(verb.id),
            MACHINE_CAPABILITIES.contains(&verb.capability),
            "{}",
            verb.id
        );
    }
    assert!(is_machine_verb("computer.click"));
    assert!(is_machine_verb("browser.navigate"));
    assert!(!is_machine_verb("web.search"));
    assert!(!is_machine_verb("memory.store"));
    assert!(!is_machine_verb("shadow.computer_use"));
    assert!(!is_machine_verb("computer.unknown"));
}

#[test]
fn core_served_machine_providers_target_a_remote_desktop() {
    let providers = core_machine_providers();
    for capability in MACHINE_CAPABILITIES {
        assert!(
            providers.iter().any(|(id, served, target)| {
                id == crate::sidecar::mcp::box_desktop::PROVIDER_ID
                    && *served == capability
                    && *target == crate::plugin_manifest::ProviderTarget::RemoteDesktop
            }),
            "{capability}: {providers:?}"
        );
    }
}

#[test]
fn machine_verb_schemas_refuse_undeclared_arguments() {
    // A model must not be able to name a Box, URL or session: every
    // computer.* and browser.* schema is closed, so the target comes only
    // from Core state.
    for verb in verbs().iter().filter(|verb| is_machine_verb(verb.id)) {
        let schema = (verb.schema)();
        assert_eq!(
            schema["additionalProperties"],
            json!(false),
            "{} must refuse undeclared arguments",
            verb.id
        );
        let properties = schema["properties"].as_object().expect("properties");
        for field in [
            "box",
            "boxId",
            "box_id",
            "session",
            "sessionId",
            "session_id",
            "endpoint",
            "target",
            "display",
            "workspaceId",
        ] {
            assert!(
                !properties.contains_key(field),
                "{} must not accept '{field}'",
                verb.id
            );
        }
        if verb.capability == CAP_COMPUTER {
            assert!(
                !properties.contains_key("url"),
                "{} must not accept a URL",
                verb.id
            );
        }
    }
    // `browser.tabs` no longer shares the open verify.scopes schema.
    assert_eq!(schema_empty()["additionalProperties"], Value::Null);
}

#[test]
fn a_shipped_verb_never_targets_another_verb() {
    // Dispatch refuses this at call time; catching it here means a bad fixture
    // fails the build instead of one agent's turn.
    for m in builtins() {
        for entry in m.provided_capabilities() {
            for (key, binding) in &entry.tools {
                assert!(
                    !binding.tool.is_empty(),
                    "plugin '{}' binds verb '{key}' to an empty target",
                    m.id
                );
                assert!(
                    verb_by_id(&binding.tool).is_none(),
                    "plugin '{}' points verb '{key}' at another facade verb ('{}') — that \
                     would be a manifest-authored dispatch loop",
                    m.id,
                    binding.tool
                );
            }
        }
    }
}

#[test]
fn shipped_capabilities_with_two_providers_are_unanimously_selectable() {
    // The failure this prevents is silent: `pick_selectable` requires unanimity,
    // so one provider missing `"selectable": true` makes the capability ambiguous
    // and the whole layer resolves to nothing — no error, no refused enable
    // (nothing `requires` these capabilities), just verbs that stop being served.
    let all = builtins();
    let mut by_capability: BTreeMap<&str, Vec<&PluginManifest>> = BTreeMap::new();
    for m in &all {
        for entry in m.provided_capabilities() {
            by_capability
                .entry(entry.capability.as_str())
                .or_default()
                .push(m);
        }
    }
    for (capability, providers) in by_capability {
        // Fan-out capabilities are called on every provider and never bound, so
        // several non-selectable providers are their normal shape.
        if providers.len() < 2 || crate::plugins::binding::is_fanout_capability(capability) {
            continue;
        }
        let ids: Vec<&str> = providers.iter().map(|m| m.id.as_str()).collect();
        assert!(
            crate::plugins::binding::is_selectable(&all, capability),
            "capability '{capability}' ships {} providers ({}) but is not unanimously \
             selectable — it will resolve to nothing. Add \"selectable\": true to every \
             provider, or stop shipping a second one.",
            providers.len(),
            ids.join(", ")
        );
    }
}

#[test]
fn no_shipped_capability_declares_two_defaults() {
    // Resolution degrades to lexicographic rather than erroring, so a duplicate
    // `default` is a silently wrong pick, not a crash.
    let mut defaults: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in builtins() {
        for entry in m.provided_capabilities() {
            if entry.default_provider {
                defaults
                    .entry(entry.capability.clone())
                    .or_default()
                    .push(m.id.clone());
            }
        }
    }
    for (capability, claimants) in defaults {
        assert_eq!(
            claimants.len(),
            1,
            "capability '{capability}' has {} providers claiming \"default\" ({}) — exactly \
             one may",
            claimants.len(),
            claimants.join(", ")
        );
    }
}
