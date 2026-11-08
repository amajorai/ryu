use super::*;

#[test]
fn preflight_credit_gate_lets_free_credit_pay_for_any_own_supply_pool_only() {
    // $50 of free credit granted against the Bedrock pool and nothing
    // unrestricted. Free credit of any pool pays for any request Ryu serves
    // from its OWN supply — and for nothing on OpenRouter or a BYOK key.
    // No debit has reported a balance since the resolve, so the headroom is
    // the resolved grant arithmetic alone.
    let state = reserve_state(0, 0);
    let mut ctx = signal_ctx(None, false, false);
    ctx.org_id = Some("o1".to_string());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(50_000_000);
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd = std::collections::HashMap::from([
        ("bedrock".to_string(), 50_000_000_i64),
        ("cloudflare".to_string(), 0_i64),
    ]);

    // Own supply, the grant's pool or another one ⇒ served.
    assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());
    assert!(preflight_credit_gate(&ctx, Some("cloudflare")).is_none());
    assert!(preflight_credit_gate(&ctx, Some("anthropic-credits")).is_none());
    assert_eq!(
        credit_headroom_micro_usd(&state, &ctx, Some("vertex")),
        Some(50_000_000)
    );

    // The retail OpenRouter pass-through is NOT own supply: free credit does
    // not reach it, so this wallet is refused there DESPITE a positive total.
    // This is what proves `unrestricted_budget_micro_usd` is being read.
    assert!(matches!(
        preflight_credit_gate(&ctx, Some("openrouter")),
        Some(GatewayError::InsufficientCredits)
    ));
    assert_eq!(
        credit_headroom_micro_usd(&state, &ctx, Some("openrouter")),
        Some(0)
    );

    // An UNTAGGED provider (openai, anthropic, local, …) is gated on the
    // unrestricted balance, NOT the total — this wallet funds it with nothing.
    // Admitting it here was a live money leak: the debit that follows carries
    // no pool, so `debitWallet` skips every grant row and drives the top-up
    // bucket negative while the $50 Bedrock grant sits untouched and Ryu
    // absorbs OpenAI's bill.
    assert!(matches!(
        preflight_credit_gate(&ctx, None),
        Some(GatewayError::InsufficientCredits)
    ));

    // Unrestricted money alone funds every pool: grants top it up, never cap it.
    ctx.unrestricted_budget_micro_usd = Some(1_000);
    assert!(preflight_credit_gate(&ctx, Some("openrouter")).is_none());
    assert_eq!(
        credit_headroom_micro_usd(&state, &ctx, Some("cloudflare")),
        Some(50_001_000)
    );
    // …and it funds an untagged provider too. Tightening the untagged branch
    // must not become a blanket block on every non-pooled provider for anyone
    // who happens to hold a grant.
    assert!(preflight_credit_gate(&ctx, None).is_none());
}

#[test]
fn preflight_credit_gate_degrades_to_the_scalar_on_a_pre_pool_control_plane() {
    // A control plane that does not yet emit `unrestrictedBudgetMicroUsd`
    // leaves it `None`. Collapsing that to 0 would gate every pooled request
    // to death the moment the gateway outran the control plane, so `None`
    // must mean "treat the whole balance as unrestricted".
    let mut ctx = signal_ctx(None, false, false);
    ctx.org_id = Some("o1".to_string());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(500);
    ctx.unrestricted_budget_micro_usd = None;
    assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());

    ctx.remaining_budget_micro_usd = Some(0);
    assert!(matches!(
        preflight_credit_gate(&ctx, Some("bedrock")),
        Some(GatewayError::InsufficientCredits)
    ));

    // Uncapped stays uncapped whether or not a pool is in play.
    ctx.remaining_budget_micro_usd = None;
    assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());
}

#[test]
fn tool_signal_active_only_on_explicit_new_signal() {
    let cfg = crate::config::ToolsConfig::default();
    // Legacy-only context: x-ryu-composio-actions folded into tool_actions,
    // but the new header was not present → must NOT trigger the unified loop
    // (the bare Composio agent keeps its fast stream + legacy loop).
    let legacy = signal_ctx(Some("composio.SLACK"), false, false);
    assert!(!tool_signal_active(&legacy, &cfg));
    // New header present → triggers.
    let new_header = signal_ctx(Some("spider.crawl"), true, false);
    assert!(tool_signal_active(&new_header, &cfg));
    // x-ryu-tool-search: on → triggers even without an allowlist header.
    let search = signal_ctx(None, false, true);
    assert!(tool_signal_active(&search, &cfg));
    // always_on alone is request-independent and must NOT trigger (would fire
    // on header-less ACP egress).
    let mut always_on = cfg.clone();
    always_on.always_on = vec![json!({"type":"function","function":{"name":"x"}})];
    assert!(!tool_signal_active(
        &signal_ctx(None, false, false),
        &always_on
    ));
    // Disabled config is always inert.
    let disabled = crate::config::ToolsConfig {
        enabled: false,
        ..crate::config::ToolsConfig::default()
    };
    assert!(!tool_signal_active(&new_header, &disabled));
}

#[test]
fn select_tool_loop_raw_passthrough_forces_plain() {
    let cfg = crate::config::ToolsConfig::default();

    // A request that WOULD hit the unified loop (catalog wired + signal)...
    let signaled = signal_ctx(Some("composio.GMAIL_SEARCH_EMAILS"), true, false);
    assert_eq!(
        select_tool_loop(&signaled, true, true, &cfg, false),
        ToolLoopKind::Unified
    );
    // ...and one that WOULD hit the legacy Composio loop (no signal, Composio on).
    let bare = signal_ctx(None, false, false);
    assert_eq!(
        select_tool_loop(&bare, false, true, &cfg, false),
        ToolLoopKind::Composio
    );
    // Missing discovery headers retain the legacy presentation, but the
    // configured catalog must still govern its connected-account execution.
    assert_eq!(
        select_tool_loop(&bare, true, true, &cfg, false),
        ToolLoopKind::Composio
    );

    // raw_tools forces Plain in BOTH cases, even with Composio configured —
    // so an SDK-side loop's own tool_calls are never swallowed.
    let mut raw_signaled = signaled;
    raw_signaled.raw_tools = true;
    assert_eq!(
        select_tool_loop(&raw_signaled, true, true, &cfg, false),
        ToolLoopKind::Plain
    );
    let mut raw_bare = bare;
    raw_bare.raw_tools = true;
    assert_eq!(
        select_tool_loop(&raw_bare, false, true, &cfg, false),
        ToolLoopKind::Plain
    );

    // Sanity: no catalog and no Composio ⇒ Plain regardless of signal.
    assert_eq!(
        select_tool_loop(&signal_ctx(None, true, false), false, false, &cfg, false),
        ToolLoopKind::Plain
    );
}

#[test]
fn budget_restrict_disables_every_managed_tool_loop() {
    let cfg = crate::config::ToolsConfig::default();
    let mut hinted = signal_ctx(Some("composio.GMAIL_SEARCH_EMAILS"), true, true);
    hinted.capability_hints =
        Some(r#"{"tools":["composio.GMAIL_SEARCH_EMAILS"],"skills":["mail"]}"#.into());
    for ctx in [hinted, signal_ctx(None, false, false)] {
        for (catalog, composio) in [(true, true), (true, false), (false, true)] {
            assert_eq!(
                select_tool_loop(&ctx, catalog, composio, &cfg, true),
                ToolLoopKind::Plain
            );
        }
    }
}

#[test]
fn anthropic_beta_survives_only_for_the_anthropic_dialect_providers() {
    // `bedrock` and `anthropic-credits` are the non-obvious cases: each is
    // `AnthropicProvider` under a different registry id, so stripping there
    // would silently drop the betas on a wire format that accepts them.
    for provider in [
        "anthropic",
        crate::config::BEDROCK_PROVIDER_ID,
        crate::config::ANTHROPIC_CREDITS_PROVIDER_ID,
    ] {
        let mut body = body_with_betas();
        strip_anthropic_beta_for(&mut body, provider);
        assert_eq!(
            body[ANTHROPIC_BETA_FIELD],
            json!("code-execution-2025-05-22"),
            "{provider} reads the field and must keep it"
        );
    }
}

#[test]
fn anthropic_credit_pool_keeps_the_anthropic_top_k_sampler() {
    let mut body = json!({
        "model": "m",
        "messages": [],
        SAMPLING_EXTENSIONS_FIELD: { "top_k": 20, "min_p": 0.05 }
    });
    let mut extensions = SamplingExtensions::take(&mut body);
    extensions.apply_for(&mut body, crate::config::ANTHROPIC_CREDITS_PROVIDER_ID);
    assert_eq!(body["top_k"], json!(20));
    assert!(body.get("min_p").is_none());
}

#[test]
fn anthropic_beta_is_stripped_for_every_other_provider() {
    // Each of these clones the request body verbatim into its payload, where an
    // unknown top-level key 400s a strict endpoint.
    for provider in [
        "openai",
        "openrouter",
        "local",
        "core",
        "genai",
        "modal",
        crate::config::CLASSIFY_PROVIDER_ID,
        crate::config::CLOUDFLARE_PROVIDER_ID,
        crate::config::VERTEX_PROVIDER_ID,
        crate::config::OPENAI_CREDITS_PROVIDER_ID,
        // A provider id nobody has thought about yet: the allowlist direction
        // means it is safe by default.
        "some-future-provider",
    ] {
        let mut body = body_with_betas();
        strip_anthropic_beta_for(&mut body, provider);
        assert_eq!(
            body.get(ANTHROPIC_BETA_FIELD),
            None,
            "{provider} would forward the private field upstream"
        );
        // Only that key goes; the rest of the payload is untouched.
        assert_eq!(body, json!({ "model": "m" }));
    }
}

#[test]
fn anthropic_beta_strip_is_a_no_op_when_the_field_was_never_set() {
    let original = json!({ "model": "gpt-4o", "messages": [] });
    let mut body = original.clone();
    strip_anthropic_beta_for(&mut body, "openai");
    assert_eq!(body, original);
}

#[test]
fn cache_control_is_stripped_for_strict_openai_providers_and_kept_for_breakpoint_dialects() {
    let marked = || {
        json!({
            "model": "m",
            "cache_control": { "type": "ephemeral" },
            "messages": [
                { "role": "system", "content": [
                    { "type": "text", "text": "s", "cache_control": { "type": "ephemeral" } }
                ] },
                { "role": "user", "content": "hi" }
            ],
            "tools": [{
                "type": "function",
                "function": { "name": "t" },
                "cache_control": { "type": "ephemeral" }
            }]
        })
    };

    // Strict OpenAI endpoint: the root, block and tool markers all go.
    for (provider, model) in [
        ("openai", "gpt-4o"),
        ("openai", "claude-sonnet-4-5"),
        (crate::config::OPENAI_CREDITS_PROVIDER_ID, "gpt-4o"),
        ("local", "llama-3"),
        ("some-future-provider", "mistral-large"),
    ] {
        let mut body = marked();
        strip_cache_control_for(&mut body, provider, model);
        assert!(
            !body.to_string().contains("cache_control"),
            "{provider}/{model} would forward cache_control upstream"
        );
        // Only the markers go; the rest of the payload is untouched.
        assert_eq!(body["messages"][0]["content"][0]["text"], json!("s"));
        assert_eq!(body["tools"][0]["function"]["name"], json!("t"));
    }

    // Anthropic-dialect providers, OpenRouter, and breakpoint-dialect models
    // keep every marker.
    for (provider, model) in [
        ("anthropic", "claude-sonnet-4-5"),
        (crate::config::BEDROCK_PROVIDER_ID, "claude-sonnet-4-5"),
        (
            crate::config::ANTHROPIC_CREDITS_PROVIDER_ID,
            "claude-sonnet-4-5",
        ),
        ("openrouter", "gpt-4o"),
        ("genai", "claude-sonnet-4-5"),
    ] {
        let mut body = marked();
        strip_cache_control_for(&mut body, provider, model);
        assert_eq!(body, marked(), "{provider}/{model} must keep its markers");
    }
}

#[test]
fn sampling_extensions_are_a_no_op_when_absent() {
    let original = json!({ "model": "gpt-4o", "messages": [], "top_k": 5 });
    let mut body = original.clone();
    let mut extensions = SamplingExtensions::take(&mut body);
    extensions.apply_for(&mut body, "openai");
    assert_eq!(body, original);
}

#[test]
fn allowlist_no_profile_is_unchanged_default_behavior() {
    // Default-safety guard: with no profile selected the resolved list is
    // exactly the x-ryu-tools CSV followed by the always_on names, in order.
    let cfg = cfg_with_always_on("search.web");
    let ctx = profile_ctx(Some("spider.crawl, exa.find"), None);
    assert_eq!(
        effective_tool_allowlist(&ctx, &cfg),
        vec![
            "spider.crawl".to_string(),
            "exa.find".to_string(),
            "search.web".to_string(),
        ]
    );
    // No header and no profile ⇒ just always_on (the pre-profile behavior).
    let bare = profile_ctx(None, None);
    assert_eq!(
        effective_tool_allowlist(&bare, &cfg),
        vec!["search.web".to_string()]
    );
}

/// `x-ryu-untrusted-caller` only removes tool surfaces. Without it the
/// unified loop keeps `tool_search` and the operator's always-on tools;
/// with it both are gone and the turn is offered its explicit allowlist.
#[test]
fn untrusted_caller_signal_omits_always_on_and_search_tools() {
    let cfg = cfg_with_always_on("search.web");
    let mut ctx = profile_ctx(Some("notify.desktop"), None);
    ctx.capability_hints = Some(r#"{"tools":["exa.search"]}"#.to_owned());

    let owner_allowed = effective_tool_allowlist(&ctx, &cfg);
    assert_eq!(owner_allowed, vec!["notify.desktop", "search.web"]);
    let mut owner_body = json!({ "messages": [] });
    inject_unified_loop_tools(&mut owner_body, &ctx, &cfg, false);
    let owner_tools = offered_tool_names(&owner_body);
    assert!(owner_tools.contains(&crate::tools::TOOL_SEARCH_NAME.to_owned()));
    assert!(owner_tools.contains(&"search.web".to_owned()));
    assert_eq!(
        unified_loop_hints(&ctx, &owner_allowed),
        ctx.capability_hints,
        "the owner's turn keeps Core's own suggestions"
    );

    ctx.untrusted_caller = true;
    let caller_allowed = effective_tool_allowlist(&ctx, &cfg);
    assert_eq!(caller_allowed, vec!["notify.desktop"]);
    let mut caller_body = json!({ "messages": [] });
    inject_unified_loop_tools(&mut caller_body, &ctx, &cfg, false);
    assert!(offered_tool_names(&caller_body).is_empty());
    let hints = unified_loop_hints(&ctx, &caller_allowed).expect("allowlist hints");
    assert_eq!(
        serde_json::from_str::<Value>(&hints).unwrap(),
        json!({ "tools": ["notify.desktop"] })
    );
}

/// The signal cannot be used to gain anything: it drops capability-hint
/// grants and an unrestricted profile's wildcard, while a profile deny
/// still applies to the explicit allowlist.
#[test]
fn untrusted_caller_signal_never_widens_the_allowlist() {
    let mut cfg = cfg_with_always_on("search.web");
    cfg.profiles.insert(
        "full".to_owned(),
        ToolProfile {
            unrestricted: true,
            deny: vec!["shell.exec".to_owned()],
            ..Default::default()
        },
    );

    let mut forwarder = profile_ctx(None, None);
    forwarder.is_master_key = true;
    forwarder.capability_hints = Some(r#"{"tools":["exa.search"]}"#.to_owned());
    assert!(effective_tool_allowlist(&forwarder, &cfg).contains(&"exa.search".to_owned()));
    forwarder.untrusted_caller = true;
    assert!(effective_tool_allowlist(&forwarder, &cfg).is_empty());

    let mut full = profile_ctx(Some("notify.desktop,shell.exec"), Some("full"));
    assert!(effective_tool_allowlist(&full, &cfg).contains(&"*".to_owned()));
    full.untrusted_caller = true;
    assert_eq!(
        effective_tool_allowlist(&full, &cfg),
        vec!["notify.desktop"]
    );
}

/// An untrusted-caller request without an explicit allowlist runs no
/// managed tool loop, even when it asks for `tool_search` or Composio is
/// configured; with an allowlist the unified loop runs, confined to it.
#[test]
fn untrusted_caller_without_an_allowlist_runs_no_managed_loop() {
    let cfg = ToolsConfig::default();
    let mut searching = signal_ctx(None, false, true);
    assert_eq!(
        select_tool_loop(&searching, true, true, &cfg, false),
        ToolLoopKind::Unified
    );
    searching.untrusted_caller = true;
    assert_eq!(
        select_tool_loop(&searching, true, true, &cfg, false),
        ToolLoopKind::Plain
    );
    let mut listed = signal_ctx(Some("notify.desktop"), true, false);
    listed.untrusted_caller = true;
    assert_eq!(
        select_tool_loop(&listed, true, true, &cfg, false),
        ToolLoopKind::Unified
    );
}
