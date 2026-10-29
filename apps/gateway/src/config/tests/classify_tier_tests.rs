use super::{
    resolve_classify_model_id, seed_classify_route, ClassifyProviderConfig, FirewallOverlay,
    InspectorConfig, ModelMapping, ProviderId, ProvidersConfig, RoutingConfig,
    DEFAULT_CLASSIFY_PORT, DEFAULT_INSPECTOR_MODEL, ENV_CLASSIFY_MODEL_ID,
};

/// Serializes the tests that read the inspector-model **default**, because
/// `default_inspector_model` now consults [`ENV_CLASSIFY_MODEL_ID`] and one test
/// below sets it. `apps/gateway` has no crate-wide env test lock, so this is the
/// lock for this one variable; every test whose expectation depends on it takes
/// this guard. (Tests that pass an explicit model, or that exercise the pure
/// [`resolve_classify_model_id`], do not need it.)
fn lock_classify_model_env() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The profile-aware port a standalone gateway resolves the classify slot to.
fn expected_port() -> u16 {
    crate::profile::port(DEFAULT_CLASSIFY_PORT)
}

/// Resolve `routing` into the REAL router tables (`ModelRouter::new` does the
/// same lowering) so the seed assertions close the loop through
/// `RoutingTables::route` instead of only inspecting the map. `default_provider`
/// is a hosted one on purpose: that is the fall-through that used to leak the
/// classifier id upstream.
fn tables_for(routing: &RoutingConfig) -> ryu_gw_router::RoutingTables {
    ryu_gw_router::RoutingTables {
        model_map: routing
            .model_map
            .iter()
            .map(|(model, mapping)| {
                (
                    model.clone(),
                    (
                        mapping.provider.as_str().to_owned(),
                        mapping.provider_model.clone(),
                    ),
                )
            })
            .collect(),
        builtin_prefixes: ryu_gw_router::builtin_prefixes(),
        default_provider: "openai".to_owned(),
        modality_map: std::collections::HashMap::new(),
        fallback_chain: Vec::new(),
        provider_tiers: std::collections::HashMap::new(),
        eval_candidates: Vec::new(),
        explore_ratio: 0.0,
    }
}

#[test]
fn classify_slot_is_absent_by_default() {
    // A STANDALONE gateway's state — with no `RYU_CLASSIFY_LLM_URL` published we
    // must not materialize a slot pointing at a dead port. (On a Core-spawned
    // gateway the slot is always `Some`: Core publishes the URL unconditionally.)
    assert!(ProvidersConfig::default().classify.is_none());
}

#[test]
fn classify_slot_parses_from_gateway_toml_and_keeps_its_url() {
    let cfg: ProvidersConfig =
        toml::from_str("[classify]\nbase_url = \"http://127.0.0.1:9083/v1\"\n")
            .expect("classify table must parse");
    assert_eq!(
        cfg.classify.expect("slot present").base_url,
        "http://127.0.0.1:9083/v1"
    );
}

#[test]
fn bare_classify_table_defaults_to_the_classify_port_not_ollama() {
    // Regression guard for the reason `ClassifyProviderConfig` is its own type:
    // reusing `LocalProviderConfig` would default this to the chat engine's
    // :11434 and silently run the guardrail classifier against the chat model.
    let cfg: ProvidersConfig = toml::from_str("[classify]\n").expect("bare table must parse");
    let base_url = cfg.classify.expect("slot present").base_url;
    assert_eq!(base_url, format!("http://127.0.0.1:{}/v1", expected_port()));
    assert!(!base_url.contains("11434"));
}

#[test]
fn classify_config_default_url_is_profile_aware() {
    let c: ClassifyProviderConfig =
        serde_json::from_value(serde_json::json!({})).expect("empty object parses");
    assert!(c.base_url.ends_with(&format!("{}/v1", expected_port())));
}

#[test]
fn inspector_model_defaults_to_the_classify_tier_classifier() {
    let _lock = lock_classify_model_env();
    // "enabled" must mean "working": an empty default made the guardrail
    // fail open forever while `action` still read Block.
    assert_eq!(InspectorConfig::default().model, DEFAULT_INSPECTOR_MODEL);
    let from_wire: InspectorConfig = serde_json::from_value(serde_json::json!({ "enabled": true }))
        .expect("absent model parses");
    assert_eq!(from_wire.model, DEFAULT_INSPECTOR_MODEL);
}

#[test]
fn blank_inspector_model_resolves_to_the_default() {
    let _lock = lock_classify_model_env();
    // The UI / `PUT /v1/config` send an explicit "" when an operator clears the
    // box — the case `#[serde(default)]` alone does NOT cover.
    for blank in ["", "   "] {
        let cfg: InspectorConfig =
            serde_json::from_value(serde_json::json!({ "enabled": true, "model": blank }))
                .expect("blank model parses");
        assert_eq!(
            cfg.model, DEFAULT_INSPECTOR_MODEL,
            "blank {blank:?} must resolve to the default"
        );
    }
}

#[test]
fn explicit_inspector_model_is_never_overridden() {
    let cfg: InspectorConfig =
        serde_json::from_value(serde_json::json!({ "model": "openrouter/auto" }))
            .expect("explicit model parses");
    assert_eq!(cfg.model, "openrouter/auto");
}

#[test]
fn firewall_overlay_inspector_inherits_the_resolved_model() {
    let _lock = lock_classify_model_env();
    // Overlays are cloned wholesale into the resolved config by
    // `firewall/resolve.rs`, so the normalization has to hold on this path too
    // — otherwise an org/agent overlay reintroduces the empty model.
    let ov: FirewallOverlay = serde_json::from_value(serde_json::json!({
        "inspector": { "enabled": true, "model": "" }
    }))
    .expect("overlay parses");
    assert_eq!(
        ov.inspector.expect("inspector present").model,
        DEFAULT_INSPECTOR_MODEL
    );
}

/// Anchors Core's lazy-start predicate from the crate that owns the default.
///
/// `apps/core/src/sidecar/gateway.rs::patch_selects_classify_tier` decides
/// whether to spawn a 241 MB llama-server from the SERIALIZED firewall section,
/// and it must decline on a fresh node. Two properties of `FirewallConfig`'s
/// default make that safe, and both would be invisible to Core if they changed:
/// the inspector is off, and there is not one enabled evaluator binding (an
/// enabled binding is Core's third arm, because `EvaluatorImpl::LlmJudge` borrows
/// `inspector.model` regardless of `inspector.enabled`). Core's own negative test
/// hand-builds this shape; this is the assertion that keeps the shape honest.
#[test]
fn default_firewall_section_selects_nothing_for_cores_lazy_start() {
    // The model assertion below reads the published-id env var.
    let _lock = lock_classify_model_env();
    let wire =
        serde_json::to_value(super::FirewallConfig::default()).expect("firewall config serializes");
    assert_eq!(
        wire["inspector"]["enabled"],
        serde_json::json!(false),
        "the inspector must default OFF, or every firewall push spawns the tier"
    );
    assert_eq!(
        wire["evaluators"],
        serde_json::json!([]),
        "no evaluator binding may ship enabled — one would arm Core's judge arm on \
         every firewall push"
    );
    // …and the model IS the classify id, which is precisely why the enablement
    // flags above are the only thing standing between a checkbox save and a
    // resident llama-server.
    assert_eq!(
        wire["inspector"]["model"],
        serde_json::json!(super::classify_model_id())
    );
}

// ── Registry-swappable classifier id (the published-id seam) ─────────────

#[test]
fn published_classify_id_wins_and_blank_falls_back() {
    // Core pushes `RYU_CLASSIFY_MODEL_ID` unconditionally, so a blank value has
    // to read as "not published" — never as an empty model id, which is the very
    // failure `de_inspector_model` exists to prevent.
    assert_eq!(
        resolve_classify_model_id(Some("my-tiny-classifier")),
        "my-tiny-classifier"
    );
    assert_eq!(
        resolve_classify_model_id(Some("  my-tiny-classifier  ")),
        "my-tiny-classifier"
    );
    for absent in [None, Some(""), Some("   ")] {
        assert_eq!(
            resolve_classify_model_id(absent),
            DEFAULT_INSPECTOR_MODEL,
            "{absent:?} must fall back to the compile-time default"
        );
    }
}

#[test]
fn published_classify_id_becomes_the_inspector_default() {
    // The WIRING assertion: `default_inspector_model` must actually consult the
    // published id, not just have a resolver available next to it.
    let _lock = lock_classify_model_env();
    let prev = std::env::var(ENV_CLASSIFY_MODEL_ID).ok();
    std::env::set_var(ENV_CLASSIFY_MODEL_ID, "my-tiny-classifier");
    let default_model = InspectorConfig::default().model;
    let blanked: InspectorConfig =
        serde_json::from_value(serde_json::json!({ "enabled": true, "model": "" }))
            .expect("blank model parses");
    match prev {
        Some(v) => std::env::set_var(ENV_CLASSIFY_MODEL_ID, v),
        None => std::env::remove_var(ENV_CLASSIFY_MODEL_ID),
    }
    assert_eq!(default_model, "my-tiny-classifier");
    assert_eq!(blanked.model, "my-tiny-classifier");
}

/// The end-to-end assertion the original seam was missing: an overridden
/// classifier id must be **routable**, not merely readable. Before the seed,
/// `route("my-tiny-classifier")` matched no map and no builtin prefix and fell
/// through to `default_provider` — so the guardrail classifier id was shipped to
/// a hosted provider, 400'd, and the inspector failed open in silence.
#[test]
fn seeded_classify_route_makes_an_overridden_id_routable() {
    let mut routing = RoutingConfig::default();
    seed_classify_route(&mut routing, "my-tiny-classifier");
    assert_eq!(
        routing.model_map["my-tiny-classifier"].provider.as_str(),
        "classify"
    );
    // Close the loop through the real router tables.
    assert_eq!(
        tables_for(&routing).route("my-tiny-classifier").0,
        "classify"
    );
}

#[test]
fn seeded_classify_route_defends_the_default_id_from_a_user_gemma_prefix() {
    // `route` runs the user `model_map` (exact, then longest prefix) BEFORE the
    // builtin table, so `gemma` → `openrouter` used to capture the default
    // classifier and bill the guardrail to a paid provider. The exact seed wins
    // step 1, ahead of that prefix scan.
    let mut routing = RoutingConfig::default();
    routing.model_map.insert(
        "gemma".to_owned(),
        ModelMapping {
            provider: ProviderId::from("openrouter"),
            provider_model: None,
        },
    );
    seed_classify_route(&mut routing, DEFAULT_INSPECTOR_MODEL);
    let tables = tables_for(&routing);
    assert_eq!(tables.route(DEFAULT_INSPECTOR_MODEL).0, "classify");
    // A normal gemma chat model still follows the operator's mapping.
    assert_eq!(tables.route("gemma-3-12b-it").0, "openrouter");
}

#[test]
fn seeded_classify_route_never_overwrites_an_explicit_operator_entry() {
    let mut routing = RoutingConfig::default();
    routing.model_map.insert(
        DEFAULT_INSPECTOR_MODEL.to_owned(),
        ModelMapping {
            provider: ProviderId::from("local"),
            provider_model: None,
        },
    );
    let marked = seed_classify_route(&mut routing, DEFAULT_INSPECTOR_MODEL);
    assert_eq!(
        routing.model_map[DEFAULT_INSPECTOR_MODEL].provider.as_str(),
        "local",
        "an explicit exact mapping is a deliberate operator choice"
    );
    assert!(
        marked.is_none(),
        "a row we did not insert must never be reported as ours to strip"
    );
    // A blank id is a no-op, never a `"" → classify` row.
    let before = routing.model_map.len();
    assert!(seed_classify_route(&mut routing, "   ").is_none());
    assert_eq!(routing.model_map.len(), before);
}

// ── The seeded row is DERIVED: routable in memory, absent from the file ──────
//
// `GET /v1/config` renders `routing.model_map` as the desktop's hand-authored
// "Model mappings" list with per-row delete buttons, so a seeded row read as an
// entry the operator never wrote AND could not delete (the delete PUT dropped it
// from the file; the next `load()` seeded it straight back). These close the loop
// from the config layer; `api::config`'s tests cover the served view and the PUT.

/// How many `model_map` rows point at the classify provider. Asserted instead of
/// looking up `classify_model_id()` on purpose: another test in this binary
/// temporarily sets `RYU_CLASSIFY_MODEL_ID`, so *which* id got seeded is not
/// stable across a parallel run — but "a row pointing at `classify` exists" is,
/// and it is the stronger claim anyway.
fn classify_rows(routing: &RoutingConfig) -> Vec<&String> {
    let mut rows: Vec<&String> = routing
        .model_map
        .iter()
        .filter(|(_, mapping)| mapping.provider.as_str() == "classify")
        .map(|(model, _)| model)
        .collect();
    rows.sort();
    rows
}

#[test]
fn load_seeds_a_routable_classify_row_that_save_never_persists() {
    let guard = super::test_config_path::ConfigPathGuard::isolated("seed-not-persisted");
    // An operator's own mapping, so the assertions also prove the strip is
    // surgical rather than a `model_map` wipe.
    std::fs::write(
        guard.path(),
        "[routing.model_map.\"claude-3-5-sonnet\"]\nprovider = \"anthropic\"\n",
    )
    .expect("seed gateway.toml");

    let loaded = super::GatewayConfig::load().expect("load the seeded file");

    // In memory: exactly one classify row, it is marked as ours, and it ROUTES.
    // The id is read from the marker rather than recomputed, so a parallel test
    // flipping `RYU_CLASSIFY_MODEL_ID` cannot make this assert the wrong key.
    let seeded_id = loaded
        .seeded_classify_model
        .clone()
        .expect("load must mark the row it seeded");
    assert_eq!(classify_rows(&loaded.routing), vec![&seeded_id]);
    assert_eq!(
        tables_for(&loaded.routing).route(&seeded_id).0,
        "classify",
        "the seed's whole purpose is that the classifier id resolves to the tier"
    );

    loaded.save().expect("persist the loaded config");

    // On disk: the operator's row, and no classify row at all.
    let text = std::fs::read_to_string(guard.path()).expect("gateway.toml written");
    let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
    assert_eq!(
        on_disk.routing.model_map["claude-3-5-sonnet"]
            .provider
            .as_str(),
        "anthropic",
        "the operator's own mapping must survive"
    );
    assert!(
        classify_rows(&on_disk.routing).is_empty(),
        "a derived row must never reach the file: there it looks operator-authored \
         forever and outlives the id it was seeded for — got {:?}",
        classify_rows(&on_disk.routing)
    );

    // …and the next load re-seeds, so nothing was lost by not persisting it.
    let reloaded = super::GatewayConfig::load().expect("reload");
    assert_eq!(classify_rows(&reloaded.routing).len(), 1);
}

#[test]
fn a_classify_row_already_in_the_file_is_treated_as_the_operators_and_kept() {
    // The migration case a marker-based strip must not get wrong: a node whose
    // `gateway.toml` ALREADY carries `<classify id> → classify`, either because a
    // pre-fix gateway persisted the seed or because the operator wrote it. `load`'s
    // `or_insert` finds it, marks nothing, and `save` must leave it alone —
    // otherwise the fix silently edits hand-authored files. Such a row is
    // deletable by the ordinary read-modify-write PUT (nothing re-adds it under
    // that exact id unless it IS the current classify id, in which case the row is
    // simply re-seeded in memory and stripped from the view again).
    let guard = super::test_config_path::ConfigPathGuard::isolated("preexisting-row");
    std::fs::write(
        guard.path(),
        "[routing.model_map.\"my-own-classifier\"]\nprovider = \"classify\"\n",
    )
    .expect("seed gateway.toml");

    let loaded = super::GatewayConfig::load().expect("load");
    assert!(
        loaded.routing.model_map.contains_key("my-own-classifier"),
        "the operator's classify row must be loaded"
    );
    assert_ne!(
        loaded.seeded_classify_model.as_deref(),
        Some("my-own-classifier"),
        "a row that came from the file is never claimed by the seed"
    );
    loaded.save().expect("save");

    let text = std::fs::read_to_string(guard.path()).expect("written");
    let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
    assert_eq!(
        on_disk.routing.model_map["my-own-classifier"]
            .provider
            .as_str(),
        "classify",
        "a classify row that came from the FILE is the operator's, not ours to strip"
    );
}

#[test]
fn strip_leaves_a_seeded_row_that_was_since_replaced() {
    // The marker says "we inserted this key"; it does not license deleting whatever
    // value happens to live there later. If something re-pointed the mapping after
    // the seed ran, that value is somebody's choice.
    let mut cfg = super::GatewayConfig::default();
    cfg.seeded_classify_model = seed_classify_route(&mut cfg.routing, DEFAULT_INSPECTOR_MODEL);
    assert_eq!(
        cfg.seeded_classify_model.as_deref(),
        Some(DEFAULT_INSPECTOR_MODEL)
    );
    cfg.routing.model_map.insert(
        DEFAULT_INSPECTOR_MODEL.to_owned(),
        ModelMapping {
            provider: ProviderId::from("local"),
            provider_model: None,
        },
    );

    let clean = cfg.without_derived_values();

    assert_eq!(
        clean.routing.model_map[DEFAULT_INSPECTOR_MODEL]
            .provider
            .as_str(),
        "local"
    );
    assert!(
        clean.seeded_classify_model.is_none(),
        "the marker is consumed, so a second strip cannot delete a later row"
    );
}

#[test]
fn seeded_classify_marker_never_crosses_the_wire() {
    // The marker is provenance, not config: it must not appear in `gateway.toml`,
    // must not be settable by a `PUT /v1/config` body, and must not survive a
    // round-trip (else a client could ask us to delete one of its own rows).
    let mut cfg = super::GatewayConfig::default();
    cfg.seeded_classify_model = seed_classify_route(&mut cfg.routing, DEFAULT_INSPECTOR_MODEL);

    let toml_text = toml::to_string_pretty(&cfg).expect("serialize config");
    assert!(!toml_text.contains("seeded_classify_model"), "{toml_text}");
    let json = serde_json::to_value(&cfg).expect("serialize config as json");
    assert!(json.get("seeded_classify_model").is_none());

    let injected: super::GatewayConfig = serde_json::from_value(serde_json::json!({
        "seeded_classify_model": DEFAULT_INSPECTOR_MODEL,
        "routing": { "model_map": { DEFAULT_INSPECTOR_MODEL: { "provider": "classify" } } }
    }))
    .expect("config patch parses");
    assert!(
        injected.seeded_classify_model.is_none(),
        "a PUT body must not be able to mark an operator row as strippable"
    );
}

// ── `[providers.classify]` is the STANDALONE setting; Core's env wins the slot ──

#[test]
fn cores_published_classify_url_wins_the_file_table() {
    // The precedence half of the cross-process contract (see the env overlay in
    // `load`): Core publishes `RYU_CLASSIFY_LLM_URL` on every spawn, so on a
    // Core-spawned node the URL the gateway dials for `classify` is always the one
    // Core computed — which is what lets Core gate its 300-400 MB lazy sidecar
    // start on that URL's locality without reading this file.
    //
    // This test mutates `RYU_CLASSIFY_LLM_URL`, which is process-global. The
    // config-path guard is what makes that safe: the only reader is
    // `GatewayConfig::load`, and every test that reaches `load` holds this same
    // lock, so no other test can be observing the variable while it is swapped.
    let guard = super::test_config_path::ConfigPathGuard::isolated("classify-url");
    let authored = "[providers.classify]\nbase_url = \"http://small-model.internal:9999/v1\"\n";
    std::fs::write(guard.path(), authored).expect("seed gateway.toml");
    let prior = std::env::var_os("RYU_CLASSIFY_LLM_URL");
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:8083/v1");

    // 1. File table + env ⇒ the env wins the LIVE slot, and the file's value is
    //    captured for the strip (asserted in the persistence test below).
    let with_file = super::GatewayConfig::load().expect("load");

    // 2. No table + env ⇒ the env registers the tier, as it always did.
    std::fs::write(guard.path(), "bind = \"127.0.0.1:7981\"\n").expect("rewrite gateway.toml");
    let without_table = super::GatewayConfig::load().map(|c| c.providers.classify);

    // 3. No table + BLANK env ⇒ "not published": the slot stays empty and the tier
    //    fails open, rather than registering an unusable "" URL.
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "   ");
    let blank_env_no_table = super::GatewayConfig::load().map(|c| c.providers.classify);

    // 4. File table + BLANK env ⇒ the standalone case the field exists for. Nothing
    //    overwrites it, including a bare table, which keeps this type's own
    //    profile-aware default (never Ollama's `:11434`).
    std::fs::write(guard.path(), authored).expect("rewrite gateway.toml");
    let blank_env_with_table = super::GatewayConfig::load().expect("load");
    std::fs::write(guard.path(), "[providers.classify]\n").expect("rewrite gateway.toml");
    let blank_env_bare_table = super::GatewayConfig::load().map(|c| c.providers.classify);

    match prior {
        Some(v) => std::env::set_var("RYU_CLASSIFY_LLM_URL", v),
        None => std::env::remove_var("RYU_CLASSIFY_LLM_URL"),
    }

    assert_eq!(
        with_file
            .providers
            .classify
            .as_ref()
            .expect("slot present")
            .base_url,
        "http://127.0.0.1:8083/v1",
        "Core's published URL must win the live slot — the gateway has to dial the \
         tier Core decided on, because that is the only URL Core can gate its lazy \
         start against"
    );
    assert!(
        with_file.env_injected_classify_provider,
        "the overwritten slot must be marked derived"
    );
    assert_eq!(
        with_file
            .file_classify_provider
            .as_ref()
            .expect("the file's table is captured, not discarded")
            .base_url,
        "http://small-model.internal:9999/v1",
    );
    assert_eq!(
        without_table.expect("load").expect("slot present").base_url,
        "http://127.0.0.1:8083/v1",
        "with no table, Core's published URL is what registers the tier"
    );
    assert!(
        blank_env_no_table.expect("load").is_none(),
        "a blank env must leave the tier unregistered (fail open), not register \"\""
    );
    assert_eq!(
        blank_env_with_table
            .providers
            .classify
            .as_ref()
            .expect("slot present")
            .base_url,
        "http://small-model.internal:9999/v1",
        "on a STANDALONE gateway (no published URL) the file setting is what takes \
         effect — that is the scope this field has"
    );
    assert!(
        !blank_env_with_table.env_injected_classify_provider,
        "a file-authored table with no env is not derived"
    );
    assert_eq!(
        blank_env_bare_table
            .expect("load")
            .expect("slot present")
            .base_url,
        format!("http://127.0.0.1:{}/v1", expected_port()),
        "a bare table keeps the classify default, not Ollama's port"
    );
}

#[test]
fn an_env_injected_classify_slot_is_never_written_back_and_never_eats_the_file() {
    // Two failure modes at once, both on the `save()` path, because env-wins makes
    // them the SAME code path:
    //
    // 1. No file table: every provider slot serializes out on `save()`, so the first
    //    save on a Core-spawned node would freeze Core's computed, profile-scoped
    //    loopback URL (`:8083` release, `:9083` dev) into `gateway.toml` as an
    //    operator-authored-looking table — stale on the next profile/port change,
    //    and live the moment something other than Core starts the gateway.
    // 2. WITH a file table: the strip used to blank the slot, which was safe only
    //    while the file BEAT the env (a file table then never set the marker).
    //    Under env-wins the live value is Core's, so a blanking strip would delete
    //    the operator's own `[providers.classify]` from their file on the next
    //    `PUT`-triggered save. It must RESTORE, not clear.
    let guard = super::test_config_path::ConfigPathGuard::isolated("classify-env-save");
    std::fs::write(guard.path(), "bind = \"127.0.0.1:7981\"\n").expect("seed gateway.toml");
    let prior = std::env::var_os("RYU_CLASSIFY_LLM_URL");
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:8083/v1");

    let loaded = super::GatewayConfig::load().expect("load");
    // In memory the tier IS registered — the strip must not cost the running
    // process its classify provider.
    assert_eq!(
        loaded
            .providers
            .classify
            .as_ref()
            .expect("env fills the slot")
            .base_url,
        "http://127.0.0.1:8083/v1"
    );
    assert!(loaded.env_injected_classify_provider);
    loaded.save().expect("save");

    let text = std::fs::read_to_string(guard.path()).expect("gateway.toml written");
    let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
    // …and the next load still registers the tier from the env.
    let after_save = super::GatewayConfig::load().expect("reload");

    // Now the operator's own table, which the env overwrites in memory and which a
    // save must nevertheless leave on disk untouched.
    std::fs::write(
        guard.path(),
        "[providers.classify]\nbase_url = \"http://small-model.internal:9999/v1\"\n",
    )
    .expect("rewrite gateway.toml");
    let authored = super::GatewayConfig::load().expect("load authored");
    assert!(
        authored.env_injected_classify_provider,
        "under env-wins the marker is set even when the file HAD a table — which is \
         exactly why the strip has to restore rather than clear"
    );
    // The strip is idempotent: `api::config::persisted_config` runs it, then the
    // resulting config is what `save()` strips again. Model both hops.
    let via_persisted_read = authored.without_derived_values();
    via_persisted_read.save().expect("save authored");
    let authored_text = std::fs::read_to_string(guard.path()).expect("written");
    let authored_on_disk: super::GatewayConfig =
        toml::from_str(&authored_text).expect("re-parse authored");

    match prior {
        Some(v) => std::env::set_var("RYU_CLASSIFY_LLM_URL", v),
        None => std::env::remove_var("RYU_CLASSIFY_LLM_URL"),
    }

    assert!(
        on_disk.providers.classify.is_none(),
        "a derived provider slot must not be persisted as a file setting: {text}"
    );
    assert!(
        !text.contains("[providers.classify]"),
        "not even as a bare table: {text}"
    );
    assert_eq!(
        after_save
            .providers
            .classify
            .expect("env still fills the slot")
            .base_url,
        "http://127.0.0.1:8083/v1",
        "saving must leave Core's published URL in charge of the slot"
    );
    assert_eq!(
        via_persisted_read
            .providers
            .classify
            .as_ref()
            .expect("the file's table is restored, not dropped")
            .base_url,
        "http://small-model.internal:9999/v1",
        "the strip restores what the file said — a `None` here is the data-loss bug"
    );
    assert_eq!(
        authored_on_disk
            .providers
            .classify
            .expect("authored table survives")
            .base_url,
        "http://small-model.internal:9999/v1",
        "the operator's own table must survive a save, even though the env \
         overwrote it in memory"
    );
}
