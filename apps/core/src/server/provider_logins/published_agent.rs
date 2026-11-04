//! Ryu Pi config, subscription OAuth login and published agents: `published_agent_descriptor_to_template` through `binary_installed_on_disk`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Convert the publish API's safe, human-facing agent descriptor into the
/// portable template consumed by the existing agent installer.
///
/// Older marketplace listings store this descriptor at the root (`display_name`,
/// `system_prompt`, …), while exports use `{ template: { agent_config: … } }`.
/// Accepting both keeps old listings installable and makes the publish path use
/// the same schedule materialization as local imports.
pub(in crate::server) fn published_agent_descriptor_to_template(
    raw: &serde_json::Value,
    fallback_id: &str,
) -> Result<crate::agents::AgentTemplate, String> {
    let source = raw
        .get("descriptor")
        .filter(|value| value.is_object())
        .unwrap_or(raw);
    let object = source
        .as_object()
        .ok_or_else(|| "published agent descriptor must be an object".to_owned())?;
    // A template-shaped body only lands here when it failed to decode as a
    // template (an unknown identity mode, say). Reading it as a flat descriptor
    // would drop that config and install the agent on Core's default mode.
    if object.contains_key("agent_config") {
        return Err("an agent template that failed to decode is not a descriptor".to_owned());
    }
    // `identity_mode` is portable (it names whose accounts, never which). An
    // absent value is Core's default; a value Core does not know is refused
    // rather than guessed, so an install never lands on a wider mode.
    let identity_mode = match object.get("identity_mode") {
        None | Some(serde_json::Value::Null) => crate::agents::AgentIdentityMode::default(),
        Some(value) => value
            .as_str()
            .ok_or_else(|| "published agent `identity_mode` must be a string".to_owned())?
            .parse::<crate::agents::AgentIdentityMode>()
            .map_err(|error| format!("invalid published agent identity mode: {error}"))?,
    };
    let text = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let strings = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let model = object.get("model").and_then(|value| {
        let model = value.as_object()?;
        let engine = model
            .get("engine")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let model_id = model
            .get("model_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        (engine.is_some() || model_id.is_some())
            .then_some(crate::agents::ModelSlot { engine, model_id })
    });
    let persona = object
        .get("avatar")
        .filter(|value| !value.is_null())
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok());
    let schedules = object
        .get("schedules")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let schedules = serde_json::from_value(schedules)
        .map_err(|error| format!("invalid published agent schedules: {error}"))?;
    let name = text("display_name")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            raw.get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| fallback_id.to_owned());
    let version = raw
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("1.0.0")
        .to_owned();

    Ok(crate::agents::AgentTemplate {
        kind: "agent".to_owned(),
        name,
        version,
        agent_config: crate::agents::AgentTemplateConfig {
            title: String::new(),
            description: None,
            system_prompt: text("system_prompt"),
            tools: strings("tools"),
            required_plugins: Vec::new(),
            composio_actions: strings("composio_actions"),
            skills: strings("skills"),
            identity_profile_ids: Vec::new(),
            identity_mode,
            engine: model.as_ref().and_then(|slot| slot.engine.clone()),
            model: model.as_ref().and_then(|slot| slot.model_id.clone()),
            chat_model: model,
            stt: None,
            tts: None,
            image_model: None,
            video_model: None,
            memory: None,
            persona,
            policy_ref: None,
            schedules,
        },
    })
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct PublishedAgentInstallBody {
    /// The published agent's catalog id, as listed by the active Agent source.
    pub(in crate::server) id: String,
    /// Stable across retries/remounts for one node/account/listing install.
    pub(in crate::server) idempotency_key: String,
}

/// `POST /api/agents/published/install { id }` — install a **published** agent
/// definition from the `agent` catalog.
///
/// Distinct from `/api/agents/catalog/install`, which installs an ACP *runtime*
/// (Claude Code, Codex). This one materialises an agent DEFINITION: the seam
/// resolves a descriptor carrying the same portable template
/// `GET /api/agents/:id/export` emits, and Core hands it to the existing importer
/// ([`crate::agents::AgentTemplate::into_create_agent`]) — there is deliberately
/// no second importer to drift from the first.
///
/// The template is third-party content, so it goes through
/// [`crate::agents::AgentTemplate::sanitize_for_untrusted_install`] first: the
/// installer's Identity Vault bindings, Composio actions, Spaces/memory scopes and
/// Gateway policy reference are removed and returned in `requires` for the user to
/// grant deliberately. Nothing is auto-enabled and nothing is auto-installed —
/// declared tool/MCP dependencies are reported, never resolved here.
#[utoipa::path(
    post,
    path = "/api/agents/published/install",
    tag = "Agents",
    summary = "Install a published agent definition from the catalog",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub(in crate::server) async fn published_agent_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PublishedAgentInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    let id = body.id.trim().to_string();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`id` is required" })),
        );
    }
    let idempotency_key = body.idempotency_key.trim();
    if idempotency_key.is_empty() || idempotency_key.len() > 2048 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`idempotency_key` is required" })),
        );
    }

    // Resolve the caller before replay. The idempotency key is client-controlled
    // and is only meaningful inside this server-verified user/org scope. On an
    // unbound local node, the absent caller intentionally retains the node-token
    // single-principal behavior (empty scope).
    let caller_user_id = caller.as_ref().map(|value| value.user_id.as_str());
    let caller_org_id = caller.as_ref().and_then(|value| value.org_id.as_deref());

    // A completed install is authoritative even when the publisher has since
    // mutated the listing. Only a server-verified caller may take this fast
    // path; anonymous/local requests must reach the catalog so its signed
    // descriptor and source checks still run before an empty-scope mapping can be replayed.
    if caller.is_some() {
        match state
            .agent_store
            .get_published_idempotent(&id, idempotency_key, caller_user_id, caller_org_id)
            .await
        {
            Ok(Some((record, requires))) => {
                return (
                    StatusCode::OK,
                    Json(json!({ "success": true, "agent": record, "requires": requires })),
                );
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    if e.to_string()
                        .starts_with("published-agent idempotency key already used")
                    {
                        StatusCode::CONFLICT
                    } else {
                        StatusCode::INTERNAL_SERVER_ERROR
                    },
                    Json(json!({ "success": false, "error": e.to_string() })),
                );
            }
        }
    }

    // Forward the caller's bearer to the Marketplace install handoff for optional
    // account-aware commerce. A listing price or license does not gate install.
    let buyer_token = buyer_bearer_from_headers(&headers);

    let Some(source) = active_published_agent_source(&state).await else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "success": false, "error": "no active agent source" })),
        );
    };
    let descriptor = match crate::catalog_source::with_buyer_token(
        buyer_token,
        source.install_descriptor(&state.client, &id),
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
    };

    // The template rides in the descriptor's opaque `raw`, either under `template`
    // (the export envelope the publisher uploaded) or at the root when the source
    // stored it bare — the same two shapes `import_agent` already accepts.
    let raw_template = descriptor
        .raw
        .get("template")
        .cloned()
        .unwrap_or(descriptor.raw);
    let template: crate::agents::AgentTemplate = match serde_json::from_value(raw_template.clone())
    {
        Ok(t) => t,
        Err(template_error) => match published_agent_descriptor_to_template(&raw_template, &id) {
            Ok(t) => t,
            Err(descriptor_error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "success": false,
                        "error": format!("published agent `{id}` has no valid template: {template_error}; descriptor fallback failed: {descriptor_error}"),
                    })),
                );
            }
        },
    };
    if template.name.trim().is_empty() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "success": false,
                "error": format!("published agent `{id}` has no name"),
            })),
        );
    }

    let (template, requires) = template.sanitize_for_untrusted_install();
    if let Err(error) = validate_agent_schedules(&template.agent_config.schedules) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "success": false, "error": format!("published agent `{id}` has invalid schedules: {error}") }),
            ),
        );
    }
    let schedules = template.agent_config.schedules.clone();
    let input = template.into_create_agent();
    match state
        .agent_store
        .create_published_idempotent(
            &id,
            idempotency_key,
            caller_user_id,
            caller_org_id,
            input,
            requires,
        )
        .await
    {
        Ok((record, replayed, requires)) => {
            if !replayed {
                if let Err(error) =
                    persist_agent_schedules(&record.id, &record.name, &schedules, caller.as_ref())
                {
                    let _ = state.agent_store.delete(&record.id).await;
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(
                            json!({ "success": false, "error": format!("agent created, but schedules could not be saved: {error}") }),
                        ),
                    );
                }
                if source.is_canonical_marketplace() {
                    crate::stats_beacon::witness_public_marketplace_install("agent", &id).await;
                    crate::stats_beacon::associate_marketplace_runtime("agent", &id, &record.id);
                    crate::stats_beacon::witness_runtime_definition(
                        "agent", &id, &record.id, &record,
                    );
                    crate::stats_beacon::record_marketplace_event("agent", &id, true);
                }
            }
            (
                if replayed {
                    StatusCode::OK
                } else {
                    StatusCode::CREATED
                },
                Json(json!({ "success": true, "agent": record, "requires": requires })),
            )
        }
        Err(e) => (
            if e.to_string()
                .starts_with("published-agent idempotency key already used")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// True if `name`'s installed binary is present on disk (or the sidecar ships no
/// file-based binary, in which case we trust the version store). Centralizes the
/// `llamacpp`→`llama-server` and `.exe` handling used by every install-status
/// endpoint so they all report the same per-engine reality.
pub(in crate::server) fn binary_installed_on_disk(name: &str) -> bool {
    if name == "ryutts" {
        return crate::sidecar::external_runtime::venv_exists(
            &crate::sidecar::providers::ryutts::sidecar_dir(),
        ) && crate::sidecar::providers::ryutts::kokoro::is_model_present();
    }
    // Sidecars without a file-based binary: trust the store.
    if matches!(name, "openclaw" | "vllm") {
        return true;
    }
    // Parakeet installs an ONNX model directory (not a binary in ~/.ryu/bin).
    if name == "parakeet" {
        return crate::sidecar::providers::parakeet::model_present();
    }
    // Island is a desktop-owned Electron bundle rather than a loose binary in
    // ~/.ryu/bin. Its install endpoint still participates in the global download
    // center, so report the bundle's real launch target here.
    if name == "island" {
        return crate::sidecar::tools::island::is_installed_on_disk();
    }
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    // The mesh needs BOTH `tailscaled` (the daemon) and `tailscale` (the CLI that
    // enrolls and queries it), and it may run an ADOPTED pair from PATH rather than
    // a Ryu-managed one (macOS installs via Homebrew and puts nothing in
    // `~/.ryu/bin` at all). The generic branch below checks one filename in the
    // managed bin dir, so it would both miss every adopted install and report the
    // mesh installed with the daemon missing. Ask the resolver instead — its answer
    // is the one `start()` will actually act on.
    if name == "tailscale" {
        return crate::sidecar::tailscale::resolve_mesh_pair().is_ok();
    }
    if name == "tailcat" {
        return crate::sidecar::tailcat::resolve_binary().is_ok();
    }
    if name == "mesh-llm" {
        return crate::sidecar::providers::mesh_llm::installer::binary_is_available();
    }
    if name == "mlx-serve" {
        return crate::sidecar::providers::mlx_serve::installer::binary_is_available();
    }
    // Inference engines live in their own `engines/<group>/<engine>/` dir (the
    // archive is extracted there with its shared libraries); ask each engine's
    // resolver so this probe agrees with what `start()` launches.
    match name {
        "llamacpp" | "llamacpp-embed" => {
            return crate::sidecar::providers::llamacpp::variant::server_path().exists();
        }
        "sdcpp" => {
            return crate::sidecar::providers::sdcpp::downloader::server_binary_path().exists();
        }
        "whispercpp" => {
            return crate::sidecar::providers::whispercpp::downloader::server_binary_path()
                .exists();
        }
        "ollama" => return crate::sidecar::providers::ollama::downloader::bin_path().exists(),
        _ => {}
    }
    let bin_name = format!("{name}{ext}");
    ryu_sidecar_runtime::layout::bin_dir(&crate::paths::ryu_dir())
        .join(&bin_name)
        .exists()
}
