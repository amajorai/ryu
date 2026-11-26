// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

/// Routes are merged into Core's protected router. They intentionally use the
/// existing `ServerState` for canonical Ryu reads/writes and the separate ledger
/// for sync metadata.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/agent-sync/profiles",
            get(list_profiles).post(save_profile),
        )
        .route(
            "/api/agent-sync/profiles/:id",
            put(save_profile_by_id).delete(remove_profile),
        )
        .route("/api/agent-sync/scan", post(scan))
        .route("/api/agent-sync/import", post(import_items))
        .route("/api/agent-sync/threads/import", post(import_thread))
        .route("/api/agent-sync/acp/resume", post(resume_acp))
        .route("/api/agent-sync/export", post(export_bundle))
        .route("/api/agent-sync/status", get(status))
        .route("/api/agent-sync/conflicts/resolve", put(resolve_conflict))
}

async fn require_agent_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
) -> Option<Response> {
    if crate::server::enforce_permission(state, caller, permission)
        .await
        .is_err()
    {
        let message = match permission {
            crate::identity_verify::permissions::AGENT_VIEW => {
                "insufficient permissions: agent.view"
            }
            crate::identity_verify::permissions::AGENT_RUN => "insufficient permissions: agent.run",
            crate::identity_verify::permissions::AGENT_EDIT => {
                "insufficient permissions: agent.edit"
            }
            _ => "insufficient permissions",
        };
        Some(error_response_with(StatusCode::FORBIDDEN, message))
    } else {
        None
    }
}

/// Apply the canonical per-agent ACL to an HTTP caller while preserving the
/// existing internal sync-worker context. The worker deliberately passes
/// `None` because it is a node-owned operation rather than a user request; the
/// route-level coarse permission check has already rejected that context on a
/// managed or org-bound HTTP request.
async fn agent_resource_is_visible(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &'static str,
    agent_id: &str,
) -> bool {
    caller.is_none()
        || crate::server::enforce_permission_on(
            state,
            caller,
            permission,
            crate::acl::KIND_AGENT,
            agent_id,
        )
        .await
        .is_ok()
}

fn filter_status_bindings(
    bindings: Vec<AcpBinding>,
    allowed_agent_ids: &HashSet<String>,
    readable_conversation_ids: &HashSet<String>,
) -> Vec<AcpBinding> {
    bindings
        .into_iter()
        .filter(|binding| {
            allowed_agent_ids.contains(&binding.agent_id)
                && readable_conversation_ids.contains(&binding.conversation_id)
        })
        .collect()
}

fn filter_status_items(
    items: Vec<SyncItemStatus>,
    profile_agent_ids: &HashMap<String, String>,
    allowed_agent_ids: &HashSet<String>,
) -> Vec<SyncItemStatus> {
    // A profile's provider is the only durable link from setup-ledger rows to
    // a Ryu agent. Keep rows for providers with no canonical agent (currently
    // `other`) under the existing coarse sync permission rather than inventing
    // a second resource identity for them.
    items
        .into_iter()
        .filter(|item| {
            profile_agent_ids
                .get(&item.profile_id)
                .is_none_or(|agent_id| allowed_agent_ids.contains(agent_id))
        })
        .collect()
}

fn filter_export_templates(
    templates: Vec<(String, crate::agents::AgentTemplate)>,
    allowed_agent_ids: &HashSet<String>,
) -> Vec<crate::agents::AgentTemplate> {
    templates
        .into_iter()
        .filter_map(|(agent_id, template)| {
            allowed_agent_ids.contains(&agent_id).then_some(template)
        })
        .collect()
}

async fn list_profiles(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.profiles().await {
        Ok(profiles) => Json(json!({ "profiles": profiles })).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn save_profile(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ProfileInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    save_profile_inner(input).await
}

async fn save_profile_by_id(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    AxumPath(id): AxumPath<String>,
    Json(mut input): Json<ProfileInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    input.id = Some(id);
    save_profile_inner(input).await
}

async fn save_profile_inner(input: ProfileInput) -> Response {
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.upsert_profile(input).await {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn remove_profile(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    match store.delete_profile(&id).await {
        Ok(true) => Json(json!({ "deleted": true, "id": id })).into_response(),
        Ok(false) => error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn scan(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ScanInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let root = match crate::import::canonicalize_root(&input.path) {
        Ok(root) => root,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let provider = match input.provider.as_deref() {
        Some(raw) => match normalize_provider(raw) {
            Ok(provider) => provider,
            Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
        },
        None => detect_provider(&root),
    };
    let scan_root = root.clone();
    let scan_provider = provider.clone();
    let result = tokio::task::spawn_blocking(move || {
        let setup = crate::import::scan_source(&scan_root)?;
        let mut warnings = setup.warnings;
        let threads = if crate::native_history::engine_supports_history(&scan_provider) {
            crate::native_history::list_threads(&scan_provider, None)?
        } else {
            if scan_provider == "cursor" {
                warnings.push(
                    "Cursor native conversation history is not a documented import format; use the portable bundle.".to_owned(),
                );
            }
            Vec::new()
        };
        Ok::<_, anyhow::Error>((setup.items, threads, warnings))
    })
    .await;
    match result {
        Ok(Ok((items, threads, warnings))) => Json(SyncScan {
            agent_id: state
                .agents
                .list_infos()
                .into_iter()
                .find(|info| info.engine.as_deref() == Some(provider.as_str()))
                .map(|info| info.id),
            root: root.to_string_lossy().to_string(),
            provider: provider.clone(),
            items,
            threads,
            warnings,
            capabilities: capabilities_for(&provider),
        })
        .into_response(),
        Ok(Err(error)) => error_response(&error.to_string()),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn import_thread(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ImportThreadInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    if input.agent_id.trim().is_empty() || input.thread_id.trim().is_empty() {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            "agent_id and thread_id are required",
        );
    }
    crate::server::import_agent_thread_handler(
        State(state),
        axum::Extension(caller),
        AxumPath(input.agent_id),
        Json(crate::server::ImportThreadBody {
            thread_id: input.thread_id,
            dry_run: input.dry_run,
        }),
    )
    .await
}

async fn resume_acp(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<AcpResumeInput>,
) -> Response {
    if let Some(response) = require_agent_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    {
        return response;
    }
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    let conversation_id = input.conversation_id.trim().to_owned();
    if conversation_id.is_empty() {
        return error_response_with(StatusCode::BAD_REQUEST, "conversation_id is required");
    }
    if let Err(response) =
        crate::server::require_conversation_read_by_id(&state, &caller, &conversation_id).await
    {
        return response;
    }
    let binding = match store.binding_for(&conversation_id).await {
        Ok(binding) => binding,
        Err(error) => return error_response(&error.to_string()),
    };
    let Some(binding) = binding else {
        return Json(AcpResumeResponse {
            conversation_id,
            agent_id: None,
            native_session_id: None,
            mode: "replay".to_owned(),
            reason: "No node-scoped ACP binding is recorded; replay the canonical Ryu transcript."
                .to_owned(),
            response: None,
        })
        .into_response();
    };
    if crate::server::enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        &binding.agent_id,
    )
    .await
    .is_err()
    {
        return error_response_with(StatusCode::FORBIDDEN, "insufficient permissions: agent.run");
    }
    let Some(spawn_cmd) = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        &binding.agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await
    else {
        return Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(binding.native_session_id),
            mode: "replay".to_owned(),
            reason:
                "The bound agent is unavailable on this node; replay the canonical Ryu transcript."
                    .to_owned(),
            response: None,
        })
        .into_response();
    };
    let cwd = binding
        .working_directory
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    if store
        .current_generation(&conversation_id)
        .ok()
        .flatten()
        .as_deref()
        != Some(binding.conversation_generation.as_str())
    {
        return error_response_with(
            StatusCode::CONFLICT,
            "Conversation changed; retry from its current transcript",
        );
    }
    let native_session_id = binding.native_session_id.clone();
    let loaded =
        crate::sidecar::adapters::acp::load_acp_session(spawn_cmd, native_session_id.clone(), cwd)
            .await;
    if store
        .current_generation(&conversation_id)
        .ok()
        .flatten()
        .as_deref()
        != Some(binding.conversation_generation.as_str())
    {
        return error_response_with(
            StatusCode::CONFLICT,
            "Conversation changed; retry from its current transcript",
        );
    }
    match loaded {
        Ok(response) if response.get("supported").and_then(Value::as_bool) == Some(true) => {
            let mode = response
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("load");
            Json(AcpResumeResponse {
                conversation_id,
                agent_id: Some(binding.agent_id),
                native_session_id: Some(native_session_id),
                mode: mode.to_owned(),
                reason: if mode == "resume" {
                    "ACP session/resume succeeded; the native session is available without transcript replay.".to_owned()
                } else {
                    "ACP session/load succeeded; the native session is available with native history replay.".to_owned()
                },
                response: Some(response),
            })
            .into_response()
        }
        Ok(response) => Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(native_session_id),
            mode: "replay".to_owned(),
            reason: "The agent does not advertise ACP session/resume or session/load; replay the canonical Ryu transcript.".to_owned(),
            response: Some(response),
        })
        .into_response(),
        Err(error) => Json(AcpResumeResponse {
            conversation_id,
            agent_id: Some(binding.agent_id),
            native_session_id: Some(native_session_id),
            mode: "replay".to_owned(),
            reason: format!("ACP session resume/load was unavailable ({error}); replay the canonical Ryu transcript."),
            response: None,
        })
        .into_response(),
    }
}
