use super::*;

// ── Shared domain types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    /// Persisted role/title shown beside the agent name when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub description: Option<String>,
    pub install_hint: Option<String>,
    pub installed: Option<bool>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: Option<String>,
    /// The engine this agent is bound to, as decided by Core (never the client).
    /// For ACP agents this is the agent's own runtime (e.g. "claude"); for
    /// OpenAI-compatible agents it is the local engine that serves it (e.g.
    /// "zeroclaw"). Lets every client show "agent → engine" without inventing
    /// its own mapping.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Transport kind backing the agent: `"acp"` (spawned subprocess) or
    /// `"openai_compat"` (local OpenAI-compatible server). Clients use this to
    /// label the binding without hard-coding the agent list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// True for the default flagship agent ("ryu"). Clients may surface this as
    /// a recommended/default selection badge. Only one agent sets this to `true`
    /// at a time; the field is omitted from the response when `false` or absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
    /// Semver version of the agent template. `None` for registry built-ins (they
    /// are not versioned as app templates). Custom agents always carry a version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Latest upstream version discovered for an external agent runtime.
    /// Omitted for custom agents and registry entries without update metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// Update status for an external agent runtime:
    /// `"current" | "behind_latest" | "unknown"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_status: Option<String>,
    /// When `true` the agent is locked and cannot be edited via the API.
    /// Omitted from the response when `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    /// `true` for the agent that is auto-installed + set as the default on
    /// first Core start (derived from `ProviderRegistry::default_agent_id`,
    /// NOT persisted as a DB column — config is authoritative for AC4).
    /// Omitted from the response when not the default agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `true` when this agent's provider calls cannot be redirected through the
    /// local gateway via env-var injection (i.e. the engine does not honour
    /// `OPENAI_BASE_URL` / `OPENAI_API_KEY`). Clients may surface this as a
    /// "gateway bypass" warning in the UI. Omitted when `false` or absent.
    ///
    /// Engines in this category: Claude Code (Anthropic `/v1/messages` format),
    /// Gemini CLI (Google format). Both hardcode their provider endpoint and
    /// ignore `OPENAI_BASE_URL`, so injecting it would silently fail or break
    /// them. The residual bypass is an explicit design choice (AC3 of #214).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_bypass: Option<bool>,
    /// Custom avatar image for the agent, as a data URL (or remote URL), taken
    /// from the agent's persona slot. When present, clients render this in place
    /// of the engine logo. Only custom (DB-backed) agents carry it; registry
    /// built-ins leave it `None` and fall back to the engine logo. Omitted from
    /// the response when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Complete custom glyph payload from the persona slot. This mirrors the
    /// shared desktop `GlyphValue` shape so non-image avatars survive the list
    /// endpoint without requiring a full-record fetch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_glyph: Option<serde_json::Value>,
    /// Persisted lifecycle for DB-backed agents. Registry-only entries omit it
    /// and are treated as active by clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle_status: Option<String>,
    /// Persisted safety profile for DB-backed agents. Registry-only entries omit
    /// it and are treated as autonomous by clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

/// A selectable chat-model option for an engine, shown in client model pickers.
/// Keyed by engine id (e.g. "claude"), matching [`AgentInfo::engine`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineModel {
    pub id: String,
    pub name: String,
}

fn engine_model(id: &str, name: &str) -> EngineModel {
    EngineModel {
        id: id.to_string(),
        name: name.to_string(),
    }
}

/// The Core-owned catalog of per-engine chat-model options — the single source of
/// truth that desktop/CLI/mobile used to each hardcode. These are swappable
/// defaults (a default table Core owns, not a lock): a later config/registry can
/// override them without touching any client. Clients fetch this via
/// `GET /api/engines/models` and fall back to it only when offline.
pub fn engine_model_catalog() -> std::collections::BTreeMap<String, Vec<EngineModel>> {
    let mut catalog = std::collections::BTreeMap::new();
    catalog.insert(
        "claude".to_string(),
        vec![
            engine_model("opus", "Opus"),
            engine_model("sonnet", "Sonnet"),
            engine_model("fable", "Fable"),
            engine_model("haiku", "Haiku"),
        ],
    );
    catalog.insert(
        "codex".to_string(),
        vec![
            engine_model("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
            engine_model("gpt-5.1-codex", "GPT-5.1 Codex"),
            engine_model("gpt-5.1", "GPT-5.1"),
        ],
    );
    catalog.insert(
        "gemini".to_string(),
        vec![
            engine_model("gemini-2.5-pro", "Gemini 2.5 Pro"),
            engine_model("gemini-2.5-flash", "Gemini 2.5 Flash"),
        ],
    );
    catalog.insert("pi".to_string(), vec![engine_model("default", "Default")]);
    catalog.insert(
        "hermes".to_string(),
        vec![engine_model("hermes3", "Hermes 3")],
    );
    let local_models = vec![engine_model("gemma-4-e2b-it", "Gemma 4 E2B")];
    // The flagship `ryu` agent (Pi + Gateway) runs on the local engine by
    // default, so its picker surfaces the same local models as `local`.
    // Without this key `resolveEngine("ryu")` finds no catalog entry and the
    // selector collapses to a single "Auto" option.
    catalog.insert("ryu".to_string(), local_models.clone());
    catalog.insert("local".to_string(), local_models);
    catalog
}

/// Replace the bundled local chat placeholder with the model Core currently
/// serves. Both `ryu` and `local` use the same resident model, so their picker
/// options must follow model installs and runtime switches together.
pub fn set_active_local_chat_model(
    catalog: &mut std::collections::BTreeMap<String, Vec<EngineModel>>,
    id: &str,
    name: &str,
) {
    let model = engine_model(id, name);
    catalog.insert("ryu".to_string(), vec![model.clone()]);
    catalog.insert("local".to_string(), vec![model]);
}

#[cfg(test)]
mod active_local_chat_model_tests {
    use super::*;

    #[test]
    fn active_model_replaces_only_the_local_picker_options() {
        let mut catalog = engine_model_catalog();

        set_active_local_chat_model(&mut catalog, "gemma-4b-Q4_K_M", "google/gemma-4b");

        for engine in ["ryu", "local"] {
            let options = catalog.get(engine).unwrap();
            assert_eq!(options.len(), 1);
            assert_eq!(options[0].id, "gemma-4b-Q4_K_M");
            assert_eq!(options[0].name, "google/gemma-4b");
        }
        assert_eq!(catalog.get("claude").unwrap().len(), 4);
    }
}
