//! # ryu-sdk — the Ryu developer SDK core
//!
//! This crate is the **shared Rust kernel** that every Ryu language binding
//! builds on. The architecture splits the SDK by *layer*, not by language:
//!
//! - **Shared local logic (this crate, bound out via FFI):** the `plugin.json`
//!   manifest/runnable model + validation ([`manifest`], [`runnable`]) and the
//!   gateway egress rules ([`gateway`]). One implementation, bound to Go/Python/
//!   Swift/Kotlin via uniffi/cgo so it never drifts across languages.
//! - **Transport (per-language, contract from OpenAPI):** the model client
//!   ([`model`]) speaks the gateway's OpenAI-compat API. Every target language
//!   already has first-class HTTP, so the canonical OpenAPI specs are vendored
//!   here (see `specs/`) as the contract; this crate ships a hand-written
//!   reqwest client, and bindings either reuse it or generate their own client
//!   from the same vendored spec.
//!
//! TypeScript intentionally stays a **native fetch-based package** consuming the
//! JSON Schema this crate emits ([`json_schema`]) rather than a napi addon — a
//! native addon would lose browser/edge/worker support and force per-platform
//! prebuilt binaries. FFI is reserved for languages with no SDK today.

pub mod embedding;
pub mod gateway;
pub mod manifest;
pub mod model;
pub mod runnable;

#[cfg(feature = "codegen")]
pub mod generated;

pub use embedding::{
    define_embedding, Embedding, EmbeddingClient, EmbeddingClientOptions, EmbeddingError,
    EmbeddingResult, EmbeddingUsage,
};
pub use gateway::{
    assert_allowed_egress, resolve_gateway_token, resolve_gateway_url, EgressNotAllowed,
    DEFAULT_GATEWAY_URL,
};
pub use manifest::{
    load_user_plugins, plugins_dir, validate_plugin_id, CompanionSurface, PluginManifest,
};
pub use model::{
    define_model, ChatDelta, ChatMessage, ChatResult, ModelClient, ModelClientOptions, ModelError,
    Usage,
};
pub use runnable::{
    validate_runnable, AgentConfig, ChannelConfig, CompanionConfig, EngineConfig, PolicyConfig,
    RunnableEntry, RunnableKind, RunnableMeta, SkillConfig, ToolConfig, WorkflowConfig,
};

/// JSON Schema export — lets any language validate a `plugin.json` without a
/// Rust FFI binding (the "validate everywhere, bind only where it pays" path).
pub mod json_schema {
    use crate::manifest::PluginManifest;

    /// The JSON Schema for a `plugin.json` [`PluginManifest`], as a JSON value.
    ///
    /// Emit this to a `.schema.json` your TS/Go/Python tooling consumes; it
    /// stays in lockstep with the Rust types because it is derived from them.
    pub fn plugin_manifest_schema() -> serde_json::Value {
        serde_json::to_value(schemars::schema_for!(PluginManifest))
            .expect("PluginManifest JsonSchema serialises to a JSON value")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_plugin_manifest_json_schema() {
        let schema = json_schema::plugin_manifest_schema();
        // The schema must describe the top-level manifest object with our fields.
        let props = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("schema has properties");
        for key in ["id", "name", "version", "runnables", "permission_grants", "companion"] {
            assert!(props.contains_key(key), "schema missing property '{key}'");
        }
    }

    #[test]
    fn public_surface_is_reexported() {
        // Smoke check that the crate's headline API resolves.
        assert_eq!(DEFAULT_GATEWAY_URL, "http://127.0.0.1:7981");
        assert!(validate_plugin_id("io.ryu.example").is_ok());
        assert_eq!(RunnableKind::Agent.as_str(), "agent");
    }
}
