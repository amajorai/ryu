//! The shipped layers resolve and serve their verbs, and the layer settings
//! app targets real arguments.

use super::*;

#[test]
fn the_shipped_search_layer_actually_resolves_and_is_swappable() {
    // End-to-end over real fixtures: two shipped providers, deterministic default,
    // and an override that moves the target without moving the tool.
    let all = builtins();
    let default_pick = resolve_verbs(&all, &BindingConfig::default());
    let search = default_pick
        .iter()
        .find(|r| r.verb.id == "web.search")
        .expect("the shipped fixtures must serve web.search");
    assert_eq!(
        search.provider_id, "@ryu/exa",
        "exa declares itself the default"
    );
    assert_eq!(search.binding.tool, "exa.search");

    let mut cfg = BindingConfig::default();
    cfg.overrides
        .insert(CAP_WEB_SEARCH.to_owned(), "@ryu/tavily".to_owned());
    let swapped = resolve_verbs(&all, &cfg);
    let search_after = swapped
        .iter()
        .find(|r| r.verb.id == "web.search")
        .expect("web.search must survive the swap");
    assert_eq!(search_after.provider_id, "@ryu/tavily");
    assert_eq!(search_after.binding.tool, "tavily.search");
}

#[test]
fn the_shipped_verification_layer_resolves_to_the_reasoning_solver() {
    // The verify layer is only useful if the shipped provider serves BOTH verbs:
    // a claim check with no way to list scopes leaves a multi-policy node unable
    // to name what it checks against. Both bodies are adapters because the
    // reasoning server answers in an MCP text envelope and its verdict
    // vocabulary must be mapped onto the canonical one, which no response map
    // can express.
    let resolved = resolve_verbs(&builtins(), &BindingConfig::default());
    for (verb, tool) in [
        ("verify.claim", "reasoning.check"),
        ("verify.scopes", "reasoning.policies"),
    ] {
        let r = resolved
            .iter()
            .find(|r| r.verb.id == verb)
            .unwrap_or_else(|| panic!("the shipped fixtures must serve {verb}"));
        assert_eq!(r.provider_id, "@ryu/reasoning", "{verb}");
        assert_eq!(r.binding.tool, tool, "{verb}");
        let adapter = r.binding.adapter.as_ref().expect("adapter-mapped");
        assert!(
            !adapter.code.is_empty(),
            "{verb}: adapter body must be hydrated"
        );
    }
    let claim = resolved
        .iter()
        .find(|r| r.verb.id == "verify.claim")
        .unwrap();
    assert_eq!(
        claim.binding.adapter.as_ref().unwrap().tools,
        vec!["reasoning.policies".to_owned()],
        "the claim adapter may only reach the policy list besides its own tool"
    );
    // The adapter speaks the canonical vocabulary, not the solver's.
    let body = &claim.binding.adapter.as_ref().unwrap().code;
    for verdict in VERIFY_VERDICTS {
        assert!(body.contains(&format!("\"{verdict}\"")), "{verdict}");
    }
}

#[test]
fn the_shipped_browser_layer_serves_the_whole_verb_set() {
    // The browser sidecar now answers snapshot/context/annotation and full
    // mouse/keyboard input over its own CDP session, so the local browser's
    // extended verb set must resolve to it. Pinned because the
    // failure is silent in both directions: a mistyped verb key just stops being
    // advertised, and a runnable renamed out from under `binding.tool` only fails
    // at call time, on someone's turn.
    let all = builtins();
    let resolved = resolve_verbs(&all, &BindingConfig::default());
    let served: BTreeMap<&str, (&str, &str)> = resolved
        .iter()
        .filter(|r| r.verb.capability == CAP_BROWSER)
        .map(|r| (r.verb.id, (r.provider_id.as_str(), r.binding.tool.as_str())))
        .collect();
    for (verb, tool) in [
        ("browser.tabs", "chromium.list_tabs"),
        ("browser.navigate", "chromium.open_tab"),
        ("browser.screenshot", "chromium.screenshot_tab"),
        ("browser.snapshot", "chromium.snapshot_tab"),
        ("browser.click", "chromium.click"),
        ("browser.type", "chromium.type"),
        ("browser.scroll", "chromium.scroll"),
        ("browser.context", "chromium.context"),
        ("browser.annotate", "chromium.annotate"),
        ("browser.clear_annotations", "chromium.clear_annotations"),
        ("browser.hover", "chromium.hover"),
        ("browser.click_at", "chromium.click_at"),
        ("browser.key", "chromium.key"),
        ("browser.drag", "chromium.drag"),
    ] {
        assert_eq!(
            served.get(verb),
            Some(&("@ryu/browser", tool)),
            "the shipped browser provider must serve {verb} via {tool}"
        );
    }
    // `browser.eval` is not a verb at all (see the module docs); nothing may
    // reintroduce it through a binding.
    assert!(verb_by_id("browser.eval").is_none());

    // Every `chromium.*` target must be a runnable the app actually registers,
    // and each declared route must exist on the sidecar — a binding pointing at a
    // slug or path that is not there 404s at call time and nowhere else.
    let browser = all
        .iter()
        .find(|m| m.id == "@ryu/browser")
        .expect("the browser app must be compiled in and parseable");
    let slugs: Vec<&str> = browser
        .runnables
        .iter()
        .filter_map(|r| r.config.as_ref()?.get("slug").and_then(Value::as_str))
        .collect();
    let urls: Vec<&str> = browser
        .runnables
        .iter()
        .filter_map(|r| r.config.as_ref()?.get("url").and_then(Value::as_str))
        .collect();
    for (_, (_, tool)) in &served {
        assert!(
            slugs.contains(tool),
            "verb target '{tool}' is not a runnable slug on @ryu/browser"
        );
    }
    for url in [
        "/tabs/{id}/snapshot",
        "/tabs/{id}/context",
        "/tabs/{id}/annotations",
        "/click",
        "/type",
        "/scroll",
        "/hover",
        "/click-at",
        "/key",
        "/drag",
    ] {
        let full = format!("core:/api/ext/@ryu/browser{url}");
        assert!(
            urls.contains(&full.as_str()),
            "no runnable targets {full}; the new control routes would be unreachable"
        );
        // The ext-proxy refuses a sub-path matching none of the declared routes,
        // so the manifest's own route list has to carry it too.
        let declared = url.replace("{id}", ":id");
        assert!(
            browser.sidecars.iter().any(|s| s
                .http
                .as_ref()
                .is_some_and(|h| h.routes.iter().any(|r| r.path == declared))),
            "route '{declared}' is not declared on the browser sidecar"
        );
    }
}

// ── Layer argument defaults ──────────────────────────────────────────────

#[test]
fn the_layers_settings_app_loads_and_every_field_targets_a_real_argument() {
    // Three silent failure modes at once, none of which any other test can see:
    //
    // 1. A malformed fixture. `load_builtins()` SKIPS a manifest it cannot parse,
    //    and every guard test iterates that same set — so a skipped manifest is
    //    indistinguishable from a clean pass.
    // 2. A `pref_key` typo. The key is a plain string on both sides; a mismatch
    //    means the facade reads a key nothing ever writes and the knob does
    //    nothing, with no error anywhere.
    // 3. A field for an argument no verb has. Same outcome: pure decoration.
    let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let layers = builtins
        .iter()
        .find(|m| m.id == "@ryu/layers")
        .expect("the layers settings app must be compiled in and parseable");
    assert!(
        crate::plugins::builtins::is_preinstalled("@ryu/layers"),
        "a settings surface the user cannot reach is not a setting"
    );

    // `Contributes::settings_tabs` forwards the ORIGINAL JSON (so a newer
    // manifest still round-trips through an older Core), so read it as JSON
    // rather than through the typed struct.
    let tabs = &layers
        .contributes
        .as_ref()
        .expect("layers contributes settings")
        .settings_tabs;
    let fields: Vec<String> = tabs
        .iter()
        .flat_map(|t| {
            t.get("fields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|f| f.get("pref_key").and_then(Value::as_str).map(str::to_owned))
        .collect();
    assert!(!fields.is_empty(), "layers must declare settings fields");

    for pref_key in &fields {
        // Reconstruct which capability + argument the key names, exactly as
        // `layer_default_key` composes it, and prove BOTH halves are real.
        let (capability, arg) = verbs()
            .iter()
            .flat_map(|v| {
                canonical_args(v)
                    .into_iter()
                    .map(move |a| (v.capability, a))
            })
            .find(|(cap, a)| &layer_default_key(cap, a) == pref_key)
            .unwrap_or_else(|| {
                panic!(
                    "settings field '{pref_key}' does not correspond to any canonical \
                     verb argument — nothing will ever read it"
                )
            });

        // And prove at least one SHIPPED provider actually forwards that argument
        // rather than dropping it, which is the difference between a working knob
        // and one whose value `map_args` discards on the way out.
        let served = builtins.iter().any(|m| {
            m.provided_capabilities().iter().any(|p| {
                p.capability == capability
                    && p.tools
                        .values()
                        .any(|b| b.args.get(&arg).map(String::as_str) != Some(""))
            })
        });
        assert!(
            served,
            "settings field '{pref_key}' targets '{arg}' on '{capability}', but every \
             shipped provider drops that argument — the setting would be decoration"
        );
    }
}
