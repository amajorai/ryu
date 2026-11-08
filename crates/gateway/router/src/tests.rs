use super::*;
use serde_json::json;

fn descriptions() -> Vec<String> {
    vec!["coding".to_string(), "chit-chat".to_string()]
}

// ── Model routing ─────────────────────────────────────────────────────────

fn tables(
    model_map: HashMap<String, (String, Option<String>)>,
    modality_map: HashMap<String, (String, Option<String>)>,
    fallback_chain: Vec<String>,
    provider_tiers: HashMap<String, u8>,
    eval_candidates: Vec<String>,
    explore_ratio: f32,
    default_provider: &str,
) -> RoutingTables {
    RoutingTables {
        model_map,
        builtin_prefixes: builtin_prefixes(),
        default_provider: default_provider.to_string(),
        modality_map,
        fallback_chain,
        provider_tiers,
        eval_candidates,
        explore_ratio,
    }
}

fn bare(default_provider: &str) -> RoutingTables {
    tables(
        HashMap::new(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        default_provider,
    )
}

#[test]
fn builtin_prefix_routes_claude_to_anthropic() {
    let t = bare("openai");
    let (provider, model) = t.route("claude-sonnet-4-5");
    assert_eq!(provider, "anthropic");
    assert_eq!(model, "claude-sonnet-4-5");
}

#[test]
fn route_with_source_names_the_precedence_step() {
    let mut model_map = HashMap::new();
    model_map.insert("pinned".to_owned(), ("anthropic".to_owned(), None));
    let t = tables(
        model_map,
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    assert_eq!(t.route_with_source("pinned").2, RouteSource::ModelMap);
    assert_eq!(
        t.route_with_source("claude-sonnet-4-5").2,
        RouteSource::BuiltinPrefix
    );
    assert_eq!(
        t.route_with_source("anthropic/claude-sonnet-4"),
        (
            "openai".to_owned(),
            "anthropic/claude-sonnet-4".to_owned(),
            RouteSource::DefaultProvider
        )
    );
}

#[test]
fn router_neutral_prefix_is_stripped_case_insensitively() {
    assert_eq!(
        strip_upstream_router_prefix("router/anthropic/claude-sonnet-4"),
        Some("anthropic/claude-sonnet-4")
    );
    assert_eq!(strip_upstream_router_prefix("Router/auto"), Some("auto"));
    assert_eq!(strip_upstream_router_prefix("router/"), None);
    assert_eq!(strip_upstream_router_prefix("router/  "), None);
    assert_eq!(strip_upstream_router_prefix("openrouter/auto"), None);
    assert_eq!(strip_upstream_router_prefix("rout"), None);
}

#[test]
fn upstream_wire_model_keeps_openrouter_meta_routers_in_its_namespace() {
    assert_eq!(
        upstream_router_wire_model("openrouter", "auto"),
        "openrouter/auto"
    );
    assert_eq!(
        upstream_router_wire_model("openrouter", "anthropic/claude-sonnet-4"),
        "anthropic/claude-sonnet-4"
    );
    assert_eq!(upstream_router_wire_model("litellm", "auto"), "auto");
    assert_eq!(upstream_router_wire_model("local", "llama3.2"), "llama3.2");
}

#[test]
fn apple_foundationmodel_routes_to_local() {
    let t = bare("openai");
    assert_eq!(t.route("apple-foundationmodel").0, "local");
}

#[test]
fn absolute_local_model_paths_route_to_local() {
    let t = bare("openai");
    let requested = "/Users/ryu/models/gemma-4-E2B-it-Q4_K_M.gguf";
    assert_eq!(
        t.route(requested),
        ("local".to_owned(), requested.to_owned())
    );
}

#[test]
fn builtin_prefix_order_puts_classify_gemma_before_local_gemma() {
    let t = bare("openai");
    // The classify-tier classifier reaches its own dedicated sidecar…
    assert_eq!(t.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
    // …while every other gemma still reaches the resident chat engine.
    assert_eq!(t.route("gemma-3-12b-it").0, "local");
    assert_eq!(t.route("gemma2:9b").0, "local");

    // `route` takes the FIRST prefix hit, not the longest, so this is an
    // ORDERING assertion, not a matching one: a future alphabetical tidy-up
    // of `builtin_prefixes` would put "gemma" above "gemma-3-270m" and send
    // the classifier to `local` while every assertion above still *looked*
    // reasonable. Pin the positions directly so that edit fails here.
    let prefixes = builtin_prefixes();
    let idx = |p: &str| {
        prefixes
            .iter()
            .position(|(prefix, _)| prefix == p)
            .unwrap_or_else(|| panic!("builtin prefix {p} missing"))
    };
    assert!(
        idx("gemma-3-270m") < idx("gemma"),
        "gemma-3-270m→classify must precede gemma→local; route() is first-match, not longest-match"
    );
}

/// Pins the precedence the builtin table's own ORDER-IS-LOAD-BEARING comment
/// does NOT cover: steps 1-2 outrank the entire builtin table. A broad operator
/// prefix silently re-homes infrastructure routes underneath it — most sharply
/// `gemma-3-270m` → `classify`, whose capture sends the guardrail classifier to
/// a paid hosted provider. The exact-entry seed is the only defense, so both
/// halves are asserted here.
#[test]
fn user_model_map_outranks_the_builtin_table() {
    let mut model_map = HashMap::new();
    model_map.insert("gemma".to_string(), ("openrouter".to_string(), None));
    let captured = tables(
        model_map.clone(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    // Step 2 (longest user prefix) beats the builtin `gemma-3-270m`→`classify`
    // row entirely — the builtin table is never consulted.
    assert_eq!(captured.route("gemma-3-270m-it-qat-Q4_0").0, "openrouter");

    // An EXACT entry (step 1) is what survives that: it is evaluated before the
    // prefix scan, so seeding one restores the classify route.
    model_map.insert(
        "gemma-3-270m-it-qat-Q4_0".to_string(),
        ("classify".to_string(), None),
    );
    let seeded = tables(
        model_map,
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    assert_eq!(seeded.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
    // …while the operator's own broad mapping still applies to everything else.
    assert_eq!(seeded.route("gemma-3-12b-it").0, "openrouter");
}

#[test]
fn openrouter_prefix_routes_any_slug() {
    let t = bare("openai");
    assert_eq!(
        t.route("openrouter/mistralai/mistral-7b-instruct").0,
        "openrouter"
    );
    assert_eq!(t.route("gemini-2.5-pro").0, "genai");
}

#[test]
fn openrouter_pareto_code_routes_to_openrouter() {
    let t = bare("openai");
    assert_eq!(t.route("openrouter/pareto-code").0, "openrouter");
}

fn provider_of(prefixes: &[(String, String)], prefix: &str) -> String {
    prefixes
        .iter()
        .find(|(p, _)| p == prefix)
        .map(|(_, provider)| provider.clone())
        .unwrap_or_else(|| panic!("builtin prefix {prefix} missing"))
}

mod classifier;
mod pools;
mod table_routes;
