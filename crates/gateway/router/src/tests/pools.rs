//! Own-supply pool routing: aliases, namespaces, equivalents and pool prefixes.

use super::*;

#[test]
fn cloudflare_workers_ai_ids_route_to_the_cloudflare_pool() {
    let t = bare("openai");
    // Workers AI namespaces its whole catalog under `@cf/<vendor>/<id>`.
    assert_eq!(
        t.route("@cf/meta/llama-3.1-8b-instruct"),
        (
            "cloudflare".to_string(),
            "@cf/meta/llama-3.1-8b-instruct".to_string()
        )
    );
    assert_eq!(
        t.route("@cf/mistral/mistral-7b-instruct-v0.2").0,
        "cloudflare"
    );
    assert_eq!(t.route("@cf/qwen/qwen1.5-14b-chat-awq").0, "cloudflare");
}

/// The exact model ids Core puts in front of users for the pool-backed
/// managed providers still route to the pool those rows claim.
///
/// The alias list is a literal COPY of `suggested_models` on the five
/// `managed-<pool>` rows in `apps/core/src/pi_config/mod.rs`. Core is a
/// separate crate that cannot import this table, and the failure mode of a
/// disagreement is silent and financial: an id this table stops claiming
/// falls through to `default_provider` — the retail pool — while the picker
/// still calls it "Ryu Fast" and the user's Fast grant goes untouched.
///
/// So the duplication is the point. If a row here has to change to keep this
/// test green, the corresponding Core row is wrong and must change with it.
#[test]
fn the_model_ids_core_offers_for_each_pool_still_route_to_that_pool() {
    let t = bare("openai");
    for (model, pool, upstream) in [
        // managed-cloudflare → "Ryu Fast"
        (
            "ryu-fast/lite",
            "cloudflare",
            "@cf/mistral/mistral-7b-instruct-v0.2",
        ),
        (
            "ryu-fast/standard",
            "cloudflare",
            "@cf/meta/llama-3.1-8b-instruct",
        ),
        (
            "ryu-fast/max",
            "cloudflare",
            "@cf/qwen/qwen1.5-14b-chat-awq",
        ),
        // managed-vertex → "Ryu Vision"
        ("ryu-vision/lite", "vertex", "google/gemini-2.5-flash"),
        ("ryu-vision/max", "vertex", "google/gemini-2.5-pro"),
        // managed-openai-credits → "Ryu Reasoning"
        ("ryu-reasoning/lite", "openai-credits", "o4-mini"),
        ("ryu-reasoning/standard", "openai-credits", "o3"),
        ("ryu-reasoning/max", "openai-credits", "gpt-5"),
        // managed-anthropic-credits → "Ryu Code"
        ("ryu-code/lite", "anthropic-credits", "claude-haiku-4-5"),
        (
            "ryu-code/standard",
            "anthropic-credits",
            "claude-sonnet-4-5",
        ),
        ("ryu-code/max", "anthropic-credits", "claude-opus-4-5"),
    ] {
        assert_eq!(
            t.route(model),
            (pool.to_string(), upstream.to_string()),
            "Core offers `{model}` as {pool} supply"
        );
        // The usage/ledger attribution maps the served id back to the alias.
        assert_eq!(pool_model_alias_for(pool, upstream), Some(model));
    }
    // And the table holds nothing Core does not offer.
    assert_eq!(POOL_MODEL_ALIASES.len(), 11);
}

/// The pre-alias forms Core used to offer still route to the same pool and
/// upstream id (saved configs and free-typed ids keep working), even though
/// they are no longer advertised.
#[test]
fn pre_alias_pool_model_ids_still_route_for_back_compat() {
    let t = bare("openai");
    for (model, pool) in [
        ("@cf/meta/llama-3.1-8b-instruct", "cloudflare"),
        ("@cf/mistral/mistral-7b-instruct-v0.2", "cloudflare"),
        ("@cf/qwen/qwen1.5-14b-chat-awq", "cloudflare"),
        ("anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock"),
        ("amazon.nova-pro-v1:0", "bedrock"),
        ("meta.llama3-1-70b-instruct-v1:0", "bedrock"),
    ] {
        assert_eq!(t.route(model), (pool.to_string(), model.to_string()));
    }
    for (model, pool, upstream) in [
        (
            "ryu-code/claude-sonnet-4-5",
            "anthropic-credits",
            "claude-sonnet-4-5",
        ),
        (
            "ryu-code/claude-opus-4-5",
            "anthropic-credits",
            "claude-opus-4-5",
        ),
        (
            "ryu-code/claude-haiku-4-5",
            "anthropic-credits",
            "claude-haiku-4-5",
        ),
        ("ryu-reasoning/o3", "openai-credits", "o3"),
        ("ryu-reasoning/o4-mini", "openai-credits", "o4-mini"),
        ("ryu-reasoning/gpt-5", "openai-credits", "gpt-5"),
        (
            "ryu-vision/google/gemini-2.5-pro",
            "vertex",
            "google/gemini-2.5-pro",
        ),
        (
            "ryu-vision/google/gemini-2.5-flash",
            "vertex",
            "google/gemini-2.5-flash",
        ),
    ] {
        assert_eq!(t.route(model), (pool.to_string(), upstream.to_string()));
    }
}

#[test]
fn pool_model_aliases_are_exact_case_insensitive_and_slot_keyed() {
    let t = bare("openai");
    assert_eq!(
        t.route("RYU-Code/Max"),
        (
            "anthropic-credits".to_string(),
            "claude-opus-4-5".to_string()
        )
    );
    assert_eq!(pool_model_alias_id("RYU-Code/Max"), Some("ryu-code/max"));
    // Exact only: a suffix or a missing size is not an alias.
    assert_eq!(pool_model_alias_route("ryu-fast/lite-2"), None);
    assert_eq!(pool_model_alias_route("ryu-fast/"), None);
    assert_eq!(t.route("ryu-fast/lite-2").0, "openai");
    // An unknown size in a namespaced tier keeps the old namespace behavior.
    assert_eq!(
        t.route("ryu-code/ultra"),
        ("anthropic-credits".to_string(), "ultra".to_string())
    );
    // The reverse map is keyed on the managed SLOT: the same upstream id on
    // a BYOK slot is the user's own traffic and keeps its real name.
    assert_eq!(pool_model_alias_for("anthropic", "claude-opus-4-5"), None);
    assert_eq!(pool_model_alias_for("openai", "o3"), None);
    assert_eq!(
        pool_model_alias_for("openrouter", "google/gemini-2.5-pro"),
        None
    );
    // Aliases sit in namespaces no vendor uses: none is a builtin-prefix id.
    for (alias, _, _) in POOL_MODEL_ALIASES {
        assert!(alias.starts_with("ryu-"));
        assert!(!builtin_prefixes()
            .iter()
            .any(|(prefix, _)| alias.starts_with(prefix.as_str())));
    }
}

#[test]
fn pool_model_equivalents_are_exact_routable_and_openrouter_ids() {
    let t = bare("openrouter");
    for (id, slot, upstream) in SEED_OWN_SUPPLY_EQUIVALENTS {
        // The left id is Ryu Router traffic today.
        assert_eq!(t.route(id).0, "openrouter", "{id}");
        // The upstream is an aliased (priced, routable) own-supply id, and
        // the alias routes to exactly this slot + upstream.
        let alias = pool_model_alias_for(slot, upstream)
            .unwrap_or_else(|| panic!("{id}: {slot}/{upstream} has no alias"));
        assert_eq!(
            t.route(alias),
            ((*slot).to_string(), (*upstream).to_string()),
            "{id}"
        );
        // Both directions agree, and only for the own-supply slot.
        assert_eq!(
            pool_model_equivalents(id).next(),
            Some((*slot, *upstream)),
            "{id}"
        );
        assert_eq!(pool_model_equivalent_id(slot, upstream), Some(*id));
        assert_eq!(pool_model_equivalent_id("openrouter", upstream), None);
    }
    assert_eq!(
        pool_model_equivalents("Anthropic/Claude-Sonnet-4.5").next(),
        Some(("anthropic-credits", "claude-sonnet-4-5"))
    );
    assert_eq!(pool_model_equivalents("openrouter/auto").next(), None);
    assert_eq!(
        pool_model_equivalents("anthropic/claude-sonnet-4").next(),
        None
    );
    // A BYOK slot serving the same bare id keeps its name.
    assert_eq!(
        pool_model_equivalent_id("anthropic", "claude-sonnet-4-5"),
        None
    );
    assert_eq!(pool_model_equivalent_id("openai", "o3"), None);
}

#[test]
fn a_slot_override_resolves_an_alias_on_its_own_slot_only() {
    let t = bare("openrouter");
    assert_eq!(
        t.route_modality(
            "chat",
            "anything",
            Some("anthropic-credits"),
            Some("ryu-code/max")
        ),
        (
            "anthropic-credits".to_string(),
            "claude-opus-4-5".to_string()
        )
    );
    assert_eq!(
        t.route_modality("chat", "ryu-code/max", Some("openai"), None),
        ("openai".to_string(), "ryu-code/max".to_string())
    );
}

#[test]
fn pool_default_alias_prefers_standard_then_the_first_size() {
    assert_eq!(
        pool_default_alias_for("anthropic-credits"),
        Some("ryu-code/standard")
    );
    assert_eq!(
        pool_default_alias_for("cloudflare"),
        Some("ryu-fast/standard")
    );
    // Ryu Vision has no `standard` size: its first (lite) alias stands in.
    assert_eq!(pool_default_alias_for("vertex"), Some("ryu-vision/lite"));
    // BYOK / untiered slots sell no tier.
    assert_eq!(pool_default_alias_for("anthropic"), None);
    assert_eq!(pool_default_alias_for("openrouter"), None);
}

/// An operator `model_map` entry still outranks an alias.
#[test]
fn operator_model_map_outranks_a_pool_model_alias() {
    let mut model_map = HashMap::new();
    model_map.insert(
        "ryu-code/max".to_string(),
        ("anthropic".to_string(), Some("claude-opus-4-5".to_string())),
    );
    let t = tables(
        model_map,
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    assert_eq!(t.route("ryu-code/max").0, "anthropic");
    assert_eq!(t.route("ryu-code/lite").0, "anthropic-credits");
}

/// The namespaces reach the donated slots WITHOUT taking a single id that
/// routes somewhere today. This is the whole reason they are namespaces and
/// not prefixes: the bare vendor ids belong to BYOK slots and OpenRouter.
#[test]
fn pool_namespaces_do_not_capture_byok_or_openrouter_ids() {
    let t = bare("openrouter");
    assert_eq!(t.route("claude-sonnet-4-5").0, "anthropic");
    assert_eq!(t.route("gpt-5").0, "openai");
    assert_eq!(t.route("o3").0, "openai");
    assert_eq!(t.route("o4-mini").0, "openai");
    assert_eq!(t.route("google/gemini-2.5-pro").0, "openrouter");
    assert_eq!(t.route("gemini-2.5-pro").0, "genai");
    // No builtin prefix row points at a namespaced slot either; the
    // namespace step is the only compiled-in way in.
    assert!(!builtin_prefixes()
        .iter()
        .any(|(_, p)| p == "anthropic-credits" || p == "openai-credits" || p == "vertex"));
}

#[test]
fn pool_namespace_matching_is_anchored_case_insensitive_and_non_empty() {
    let t = bare("openai");
    // Namespace case is forgiven; the upstream id's case is preserved.
    assert_eq!(
        t.route("Ryu-Code/Claude-X"),
        ("anthropic-credits".to_string(), "Claude-X".to_string())
    );
    // A bare namespace is not a model: it takes the normal order.
    assert_eq!(t.route("ryu-code/").0, "openai");
    // Anchored at position 0 — a namespace inside an id is just text.
    assert_eq!(
        t.route("openrouter/ryu-code/claude-sonnet-4-5").0,
        "openrouter"
    );
    // Multi-byte input around the boundary must not panic on slicing.
    assert_eq!(t.route("ryu-codé/x").0, "openai");
    assert_eq!(pool_namespace_route("ryu-co"), None);
}

/// An operator's `model_map` still outranks the compiled-in namespace, the
/// same precedence every builtin route has.
#[test]
fn operator_model_map_outranks_a_pool_namespace() {
    let mut model_map = HashMap::new();
    model_map.insert(
        "ryu-code/claude-sonnet-4-5".to_string(),
        (
            "bedrock".to_string(),
            Some("anthropic.claude-3-5-sonnet-20241022-v2:0".to_string()),
        ),
    );
    let t = tables(
        model_map,
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
        0.0,
        "openai",
    );
    assert_eq!(t.route("ryu-code/claude-sonnet-4-5").0, "bedrock");
    assert_eq!(t.route("ryu-code/claude-opus-4-5").0, "anthropic-credits");
}

/// A/B eval routing must not reassign an explicit pool choice: it would send
/// the namespaced id verbatim to another candidate and bill the wrong pool.
#[test]
fn eval_route_leaves_pool_namespaced_ids_to_route() {
    let t = tables(
        HashMap::new(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        vec!["openai".to_string(), "openrouter".to_string()],
        0.5,
        "openai",
    );
    assert_eq!(t.eval_route("ryu-reasoning/o3", &|_| None, &|| 0), None);
    assert_eq!(t.eval_route("ryu-fast/max", &|_| None, &|| 0), None);
    assert_eq!(t.eval_route("ryu-vision/lite", &|_| None, &|| 0), None);
    assert!(t.eval_route("gpt-5", &|_| None, &|| 0).is_some());
}

#[test]
fn bedrock_vendor_ids_route_to_the_bedrock_pool() {
    let t = bare("openai");
    // One representative id per served vendor family. The `anthropic.` case
    // is the one the pre-fix table missed most quietly: it does NOT start
    // with `claude-`, so it fell through to `default_provider`.
    assert_eq!(
        t.route("anthropic.claude-3-5-sonnet-20241022-v2:0"),
        (
            "bedrock".to_string(),
            "anthropic.claude-3-5-sonnet-20241022-v2:0".to_string()
        )
    );
    assert_eq!(t.route("amazon.nova-pro-v1:0").0, "bedrock");
    assert_eq!(t.route("meta.llama3-1-70b-instruct-v1:0").0, "bedrock");
    assert_eq!(t.route("mistral.mistral-large-2407-v1:0").0, "bedrock");
    assert_eq!(t.route("mistral.mixtral-8x7b-instruct-v0:1").0, "bedrock");
}

/// No builtin prefix routes to a donated pool by itself. The pools are aimed
/// by an operator (`routing.model_map` / `default_provider`), never claimed at
/// compile time.
#[test]
fn google_ids_still_fall_through_to_the_default_provider() {
    // A `("google/", "vertex")` row looked safe against the other BUILTIN rows
    // — and that is the wrong axis. Step 3 runs before step 4, so what such a
    // row actually takes is the ids that previously fell through to
    // `default_provider`. `google/gemini-2.5-pro` is a valid OpenRouter id, and
    // `openrouter` is an exposed `default_provider` value, so the row broke a
    // working id: unavailable when `vertex` was unconfigured, and silently
    // spending the DONATED allowance on retail-aimed traffic when it was.
    let t = bare("openrouter");
    assert_eq!(
        t.route("google/gemini-2.5-pro"),
        (
            "openrouter".to_string(),
            "google/gemini-2.5-pro".to_string()
        )
    );
    assert_eq!(t.route("google/gemini-2.5-flash").0, "openrouter");
    // The native `generateContent` path form is likewise unclaimed.
    assert_ne!(
        t.route("publishers/google/models/gemini-2.5-flash").0,
        "vertex"
    );
}

/// The bare `gemini-*` ids stay with `genai`. This is the money-shaped half of
/// the Vertex wiring: `("gemini-", "vertex")` above the existing row would
/// silently move every current Gemini request onto donated credit, and below
/// it would never fire at all (first-match, not longest-match).
#[test]
fn bare_gemini_ids_stay_on_genai_not_the_vertex_pool() {
    let t = bare("openai");
    assert_eq!(t.route("gemini-1.5-pro").0, "genai");
    assert_eq!(t.route("gemini-2.5-flash").0, "genai");
    assert_eq!(
        provider_of(&builtin_prefixes(), "gemini-"),
        "genai",
        "the gemini- row must not be re-homed to the vertex pool"
    );
}

/// The donated OpenAI pool has NO builtin row, and that absence is the design
/// (see `config::OPENAI_CREDITS_PROVIDER_ID`). Pinned as a test because the
/// obvious "fix" — pointing `gpt-` at the pool — would convert every BYOK
/// caller's own-key traffic into donated spend, which is exactly what the
/// separate registry id exists to prevent.
#[test]
fn no_builtin_prefix_routes_to_the_donated_openai_pool() {
    let prefixes = builtin_prefixes();
    assert!(
        !prefixes
            .iter()
            .any(|(_, provider)| provider == "openai-credits"),
        "the donated OpenAI pool is reachable via its `ryu-reasoning/` namespace \
         or model_map/default_provider only"
    );
    let t = bare("openai");
    for model in ["gpt-4o", "gpt-5", "o1-preview", "o3-mini", "o4-mini"] {
        assert_eq!(
            t.route(model).0,
            "openai",
            "{model} must keep routing to the BYOK openai slot"
        );
    }
}

/// Bedrock is no longer own supply: the retired `ryu-frontier/*` aliases name
/// no pool, so they fall through to normal routing like any unknown id.
#[test]
fn retired_ryu_frontier_aliases_no_longer_reach_bedrock() {
    let t = bare("openai");
    assert_eq!(pool_model_alias_route("ryu-frontier/lite"), None);
    assert_ne!(t.route("ryu-frontier/standard").0, "bedrock");
    assert!(POOL_MODEL_ALIASES
        .iter()
        .all(|(_, slot, _)| *slot != "bedrock"));
}
