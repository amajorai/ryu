//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `list_engines` through `persona_dither_value`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Built-in engines (Claude Code, ZeroClaw, …) available to bind an agent to.
/// Each entry reports whether its runtime is installed so the Desktop engine
/// picker can offer only what is usable (U8).
#[utoipa::path(
    get,
    path = "/api/engines",
    tag = "Engines",
    summary = "List engine runtimes",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_engines(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    // Built-in engine runtimes plus any engine bindings contributed by enabled
    // plugins (`RunnableKind::Engine`, held in the app-contrib registry). App
    // engines are rendered in the same `AgentInfo` shape so every client shows one
    // uniform list; `transport` labels the binding and `engine`/`model` carry the
    // engine type so the picker can offer it without a special case.
    let mut engines = state.agents.list_infos();
    for e in state.app_contrib.engines() {
        engines.push(crate::sidecar::adapters::AgentInfo {
            id: e.id,
            name: e.name,
            title: None,
            description: Some(format!("Plugin-contributed engine ({})", e.engine_type)),
            install_hint: None,
            installed: None,
            model: None,
            system_prompt: None,
            created_at: None,
            engine: Some(e.engine_type),
            transport: e
                .base_url
                .as_ref()
                .map(|_| "openai_compat".to_owned())
                .or_else(|| Some("acp".to_owned())),
            recommended: None,
            version: None,
            latest_version: None,
            version_status: None,
            locked: None,
            enabled: None,
            gateway_bypass: None,
            avatar_url: None,
            avatar_glyph: None,
            lifecycle_status: None,
            safety_profile: None,
        });
    }
    Json(json!({ "engines": engines }))
}

/// `GET /api/engines/{engine}/launch-options` — the engine's native launch
/// option catalog (flags and server environment beyond the typed launch
/// fields). Clients render settings from it and store values under the launch
/// config's `native` map. Engines without a verified catalog return an empty
/// list and keep only the raw `extra_args` passthrough.
#[utoipa::path(
    get,
    path = "/api/engines/{engine}/launch-options",
    tag = "Engines",
    summary = "An engine's native launch options",
    params(("engine" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn engine_launch_options(
    Path(engine): Path<String>,
) -> Json<serde_json::Value> {
    Json(json!({
        "engine": engine,
        "options": crate::inference::native_options(&engine),
    }))
}

/// Per-engine chat-model options, keyed by engine id (e.g. `claude` →
/// Opus/Sonnet/Haiku). Core owns this catalog so every client — desktop, CLI,
/// mobile — shows the same swappable defaults instead of each hardcoding its own
/// list. Clients fall back to a local copy only when offline.
#[utoipa::path(
    get,
    path = "/api/engines/models",
    tag = "Engines",
    summary = "Per-engine chat-model options",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn engine_models(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let mut models = crate::sidecar::adapters::engine_model_catalog();
    // The local picker follows the model currently served by the Gateway. The
    // catalog default is only a fallback: after a user switches models, clients
    // need the new served id so a fresh Ryu chat can preselect those weights.
    if let Some(active) = state
        .preferences
        .get(crate::model_catalog::installed::ACTIVE_MODEL_PREF)
        .await
        .ok()
        .flatten()
        .and_then(|raw| crate::model_catalog::installed::parse_active_pref(&raw))
    {
        let name = match active.format {
            crate::model_format::ModelFormat::Gguf => {
                crate::model_catalog::installed::repo_for_stem(&active.r#ref)
                    .unwrap_or_else(|| active.r#ref.clone())
            }
            _ => active.r#ref.clone(),
        };
        crate::sidecar::adapters::set_active_local_chat_model(&mut models, &active.r#ref, &name);
    }
    // Mesh LLM owns its model catalog because model weights/config live in its
    // runtime, not in Ryu. When it is the selected resident engine, project its
    // OpenAI-compatible `/v1/models` ids into the same secret-free catalog that
    // every other engine picker consumes. A down/unselected Mesh LLM contributes
    // no stale placeholder model, so Rooms cannot offer a prompt that would be
    // routed to a different local engine.
    if crate::sidecar::active_engine::ActiveEngineStore::load()
        .active
        .as_deref()
        == Some("mesh-llm")
    {
        let endpoint = crate::sidecar::active_engine::local_engine_base_url("mesh-llm")
            .map(|base| format!("{}/v1/models", base.trim_end_matches('/')));
        if let Some(endpoint) = endpoint {
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_millis(250))
                .timeout(std::time::Duration::from_secs(1))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            if let Ok(response) = client.get(endpoint).send().await {
                if let Ok(value) = response.json::<serde_json::Value>().await {
                    let discovered = value
                        .get("data")
                        .and_then(serde_json::Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|entry| {
                            let id = entry.get("id")?.as_str()?.trim();
                            (!id.is_empty()).then(|| crate::sidecar::adapters::EngineModel {
                                id: id.to_owned(),
                                name: id.to_owned(),
                            })
                        })
                        .collect::<Vec<_>>();
                    if !discovered.is_empty() {
                        models.insert("mesh-llm".to_owned(), discovered);
                    }
                }
            }
        }
    }
    if crate::sidecar::active_engine::ActiveEngineStore::load()
        .active
        .as_deref()
        == Some("lemonade")
    {
        match crate::sidecar::providers::LemonadeManager::new()
            .chat_models()
            .await
        {
            Ok(discovered) => {
                models.insert("lemonade".to_owned(), discovered);
            }
            Err(error) => tracing::debug!(%error, "Lemonade model discovery unavailable"),
        }
    }
    if crate::sidecar::active_engine::ActiveEngineStore::load()
        .active
        .as_deref()
        == Some("magnitude")
    {
        match crate::sidecar::providers::MagnitudeManager::new()
            .chat_models()
            .await
        {
            Ok(discovered) => {
                models.insert("magnitude".to_owned(), discovered);
            }
            Err(error) => tracing::debug!(%error, "Magnitude model discovery unavailable"),
        }
    }
    if crate::sidecar::active_engine::ActiveEngineStore::load()
        .active
        .as_deref()
        == Some("llama-swap")
    {
        match crate::sidecar::providers::LlamaSwapManager::new()
            .chat_models()
            .await
        {
            Ok(discovered) => {
                models.insert("llama-swap".to_owned(), discovered);
            }
            Err(error) => tracing::debug!(%error, "llama-swap model discovery unavailable"),
        }
    }
    if crate::sidecar::active_engine::ActiveEngineStore::load()
        .active
        .as_deref()
        == Some("freetoken")
    {
        match crate::sidecar::providers::FreeTokenManager::new()
            .chat_models()
            .await
        {
            Ok(discovered) => {
                models.insert("freetoken".to_owned(), discovered);
            }
            Err(error) => tracing::debug!(%error, "FreeToken model discovery unavailable"),
        }
    }
    Json(json!({ "models": models }))
}

/// Convert the persona's first active source into the shared desktop glyph shape.
/// The list endpoint carries this alongside the legacy avatar URL so compact
/// clients can render every avatar kind without fetching the full record.
pub(in crate::server) fn persona_avatar_glyph(
    persona: Option<&crate::agents::PersonaSlot>,
) -> Option<serde_json::Value> {
    let persona = persona?;
    if let Some(url) = persona.avatar_url.as_ref() {
        return Some(json!({ "kind": "avatar", "dataUrl": url }));
    }
    if let Some(spec) = persona
        .expressive
        .as_ref()
        .filter(|spec| spec.expression.is_some())
    {
        let mut glyph = serde_json::to_value(spec).ok()?;
        glyph["kind"] = json!("expressive");
        return Some(glyph);
    }
    if let Some(emoji) = persona.emoji.as_ref() {
        let mut glyph = json!({ "kind": "emoji", "emoji": emoji });
        if let Some(dither) = persona_dither_value(persona) {
            glyph["dither"] = dither;
        }
        return Some(glyph);
    }
    if let Some(icon) = persona.icon.as_ref() {
        let mut glyph = json!({ "kind": "icon", "id": icon });
        if let Some(color) = persona.icon_color.as_ref() {
            glyph["color"] = json!(color);
        }
        if let Some(dither) = persona_dither_value(persona) {
            glyph["dither"] = dither;
        }
        return Some(glyph);
    }
    if let Some(dicebear) = persona.dicebear.as_ref() {
        if let (Some(style), Some(seed)) = (dicebear.style.as_ref(), dicebear.seed.as_ref()) {
            return Some(json!({
                "kind": "dicebear",
                "style": style,
                "seed": seed,
            }));
        }
    }
    if let Some(spec) = persona.avatar_style.as_ref() {
        if let (Some(style), Some(seed)) = (spec.style.as_ref(), spec.seed.as_ref()) {
            let mut glyph = json!({ "kind": "avatar_style", "style": style, "seed": seed });
            if let Some(palette) = spec.palette.as_ref() {
                glyph["palette"] = json!(palette);
            }
            if let Some(parts) = spec.parts.as_ref().filter(|parts| !parts.is_empty()) {
                glyph["parts"] = json!(parts);
            }
            return Some(glyph);
        }
    }
    persona_dither_value(persona).map(|dither| json!({ "kind": "dither", "dither": dither }))
}

pub(in crate::server) fn persona_dither_value(
    persona: &crate::agents::PersonaSlot,
) -> Option<serde_json::Value> {
    let dither = persona.dither.as_ref()?;
    let from = dither.from.as_ref()?;
    let direction = match dither.direction.as_deref() {
        Some("down") => "down",
        Some("left") => "left",
        Some("right") => "right",
        _ => "up",
    };
    Some(json!({
        "direction": direction,
        "from": from,
        "to": dither.to.as_ref(),
    }))
}
