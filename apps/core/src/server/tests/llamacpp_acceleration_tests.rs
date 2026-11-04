use crate::server::llamacpp_variant_alias;
use crate::sidecar::active_engine::is_local_engine;
use crate::sidecar::providers::llamacpp::variant::{LlamaVariant, AUTO};

// "Run llama.cpp on the CPU" is offered as an engine you can swap to, but it
// is not a second resident engine — it is the same engine with a pinned
// build. These tests hold that seam in place.

#[test]
fn cpu_alias_maps_to_the_cpu_build() {
    assert_eq!(llamacpp_variant_alias("llamacpp-cpu"), Some("cpu"));
    assert_eq!(llamacpp_variant_alias("LlamaCpp-CPU"), Some("cpu"));
}

#[test]
fn every_alias_names_a_real_choice() {
    for alias in [
        "llamacpp-cpu",
        "llamacpp-metal",
        "llamacpp-cuda",
        "llamacpp-vulkan",
        "llamacpp-auto",
        "llamacpp-gpu",
    ] {
        let value = llamacpp_variant_alias(alias)
            .unwrap_or_else(|| panic!("{alias} must resolve to a variant"));
        assert!(
            value == AUTO || LlamaVariant::parse(value).is_some(),
            "{alias} resolved to '{value}', which is neither `auto` nor a build"
        );
    }
}

#[test]
fn plain_engine_names_are_not_aliases() {
    // A real engine must fall through untouched to the ordinary swap path,
    // or selecting Ollama would rewrite the llama.cpp build preference.
    for name in ["llamacpp", "ollama", "vllm", "mlx", ""] {
        assert_eq!(llamacpp_variant_alias(name), None, "{name}");
    }
}

#[test]
fn aliases_are_not_themselves_local_engines() {
    // The point of the alias: no second manager, no second port, no second
    // GGUF-serving engine for `pick_engine` to choose between.
    for alias in ["llamacpp-cpu", "llamacpp-cuda", "llamacpp-vulkan"] {
        assert!(
            !is_local_engine(alias),
            "{alias} must not be in LOCAL_ENGINES"
        );
    }
}
