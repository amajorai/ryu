// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

async fn import_items(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ImportInput>,
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
    if input.items.is_empty() {
        return error_response_with(StatusCode::BAD_REQUEST, "no items selected");
    }
    if input.items.len() > MAX_IMPORT_SELECTIONS {
        let message = format!("too many items selected; maximum is {MAX_IMPORT_SELECTIONS}");
        return error_response_with(StatusCode::BAD_REQUEST, &message);
    }
    if let Some(key) = duplicate_selection_key(&input.items) {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            &format!("duplicate item selected: {key}"),
        );
    }
    let profile = match store.profile(&input.profile_id).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    let configured_root = match crate::import::canonicalize_root(&profile.root) {
        Ok(root) => root,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let root = match input.path.as_deref() {
        None => configured_root,
        Some(requested_root) => {
            let requested_root = match crate::import::canonicalize_root(requested_root) {
                Ok(root) => root,
                Err(error) => {
                    return error_response_with(StatusCode::BAD_REQUEST, &error.to_string());
                }
            };
            if requested_root != configured_root {
                return error_response_with(
                    StatusCode::BAD_REQUEST,
                    "path must match the selected profile root",
                );
            }
            configured_root
        }
    };
    let operation_id = format!("import_{}", uuid::Uuid::new_v4());
    if input.dry_run {
        let skipped = input.items.len();
        return Json(SyncImportResult {
            profile_id: profile.id,
            operation_id,
            dry_run: true,
            results: input
                .items
                .into_iter()
                .map(|selection| {
                    crate::import::ImportOutcome::skipped(
                        &selection.kind,
                        &selection.id,
                        &selection.id,
                        "dry run",
                    )
                })
                .collect(),
            imported: 0,
            skipped,
            failed: 0,
            conflicts: 0,
        })
        .into_response();
    }
    if !store.try_start(&profile.id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let selections = input.items.clone();
    let hash_root = root.clone();
    let hash_selections = selections.clone();
    let hash_results = match tokio::task::spawn_blocking(move || {
        let mut budget = HashBudget::default();
        hash_selections
            .iter()
            .map(|selection| {
                (
                    selection_key(selection),
                    hash_selected_item_with_budget(&hash_root, selection, &mut budget),
                )
            })
            .collect::<Vec<_>>()
    })
    .await
    {
        Ok(results) => results,
        Err(error) => {
            store.finish(&profile.id).await;
            return error_response(&format!("hashing selected items failed: {error}"));
        }
    };
    let mut hash_results: HashMap<_, _> = hash_results.into_iter().collect();
    let mut filtered = Vec::with_capacity(selections.len());
    let mut skipped_hashes = HashMap::new();
    let mut source_hashes = HashMap::new();
    for selection in selections {
        let selection_key = selection_key(&selection);
        if let Some(reason) = own_skill_skip_reason(&store, &profile.id, &root, &selection).await {
            skipped_hashes.insert(selection_key.clone(), reason.to_owned());
            continue;
        }
        let source_hash = match hash_results.remove(&selection_key) {
            Some(result) => result,
            None => Err(anyhow::anyhow!("selected item was not hashed")),
        };
        let source_hash = match source_hash {
            Ok(hash) => hash,
            Err(error) => {
                skipped_hashes.insert(selection_key.clone(), error.to_string());
                continue;
            }
        };
        if let Some(hash) = source_hash.as_deref() {
            source_hashes.insert(selection_key.clone(), hash.to_owned());
            match store
                .item(&profile.id, &selection.kind, &selection.id)
                .await
            {
                Ok(Some(previous))
                    if previous.source_hash.as_deref() == Some(hash)
                        && previous.state == "imported" =>
                {
                    skipped_hashes.insert(selection_key.clone(), "unchanged source".to_owned());
                    continue;
                }
                Ok(Some(previous)) if previous.generated_hash.as_deref() == Some(hash) => {
                    skipped_hashes.insert(selection_key.clone(), "generated output".to_owned());
                    continue;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("agent sync: reading ledger item failed: {error:#}");
                }
            }
        }
        filtered.push(selection);
    }
    let results = crate::server::apply_import_selections(&state, &caller, &root, filtered).await;
    store.finish(&profile.id).await;
    let mut final_results = Vec::with_capacity(input.items.len());
    let mut result_by_id: HashMap<String, crate::import::ImportOutcome> = results
        .into_iter()
        .map(|result| (format!("{}:{}", result.kind, result.id), result))
        .collect();
    for selection in input.items {
        let selection_key = selection_key(&selection);
        if let Some(reason) = skipped_hashes.remove(&selection_key) {
            final_results.push(crate::import::ImportOutcome::skipped(
                &selection.kind,
                &selection.id,
                &selection.id,
                &reason,
            ));
        } else if let Some(result) = result_by_id.remove(&selection_key) {
            if let Some(source_hash) = source_hashes.get(&selection_key) {
                let _ = store
                    .upsert_item(
                        &profile.id,
                        &selection.kind,
                        &selection.id,
                        Some(source_hash.as_str()),
                        None,
                        &operation_id,
                        if result.status == "failed" {
                            "failed"
                        } else {
                            "imported"
                        },
                        None,
                    )
                    .await;
            }
            final_results.push(result);
        }
    }
    let imported = final_results
        .iter()
        .filter(|result| result.status == "imported")
        .count();
    let skipped = final_results
        .iter()
        .filter(|result| result.status == "skipped")
        .count();
    let failed = final_results
        .iter()
        .filter(|result| result.status == "failed")
        .count();
    let _ = store
        .update_profile_summary(
            &profile.id,
            &operation_id,
            if failed > 0 { "error" } else { "idle" },
        )
        .await;
    Json(SyncImportResult {
        profile_id: profile.id,
        operation_id,
        dry_run: false,
        results: final_results,
        imported,
        skipped,
        failed,
        conflicts: 0,
    })
    .into_response()
}

async fn export_bundle(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ExportInput>,
) -> Response {
    let Some(store) = global_store() else {
        return error_response("agent sync store is unavailable");
    };
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return error_response_with(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.edit",
        );
    }
    let destination = match crate::import::canonicalize_root(&input.destination) {
        Ok(path) => path,
        Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let profile = match input.profile_id.as_deref() {
        Some(id) => match store.profile(id).await {
            Ok(Some(profile)) => Some(profile),
            Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
            Err(error) => return error_response(&error.to_string()),
        },
        None => match store.profile_for_root(&destination).await {
            Ok(profile) => profile,
            Err(error) => return error_response(&error.to_string()),
        },
    };
    if let Some(profile) = profile.as_ref() {
        let profile_root = match crate::import::canonicalize_root(&profile.root) {
            Ok(root) => root,
            Err(error) => return error_response_with(StatusCode::BAD_REQUEST, &error.to_string()),
        };
        if profile_root != destination {
            return error_response_with(
                StatusCode::BAD_REQUEST,
                "destination must match the selected profile root",
            );
        }
    }
    let lock_id = profile
        .as_ref()
        .map(|profile| profile.id.as_str())
        .unwrap_or("manual-export");
    if !store.try_start(lock_id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let operation_id = format!("export_{}", uuid::Uuid::new_v4());
    let result = build_export(
        &state,
        &store,
        profile.as_ref(),
        &destination,
        &operation_id,
        input.dry_run,
        input.include_agents,
        input.include_skills,
        input.include_conversations,
        &caller,
        None,
    )
    .await;
    store.finish(lock_id).await;
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn status(
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
    match (
        store.profiles().await,
        store.bindings().await,
        store.items().await,
    ) {
        (Ok(profiles), Ok(bindings), Ok(items)) => {
            if caller.is_none() {
                return Json(SyncStatus {
                    profiles,
                    bindings,
                    items,
                    active_operations: store.active_count().await,
                    node_id: store.node_id().to_owned(),
                })
                .into_response();
            }

            let agent_infos = state.agents.list_infos();
            let profile_agent_ids: HashMap<String, String> = profiles
                .iter()
                .filter_map(|profile| {
                    agent_infos
                        .iter()
                        .find(|info| {
                            info.engine.as_deref().is_some_and(|engine| {
                                engine.eq_ignore_ascii_case(&profile.provider)
                            })
                        })
                        .map(|info| (profile.id.clone(), info.id.clone()))
                })
                .collect();
            let mut candidate_agent_ids: HashSet<String> = bindings
                .iter()
                .map(|binding| binding.agent_id.clone())
                .collect();
            candidate_agent_ids.extend(profile_agent_ids.values().cloned());
            let mut allowed_agent_ids = HashSet::new();
            for agent_id in candidate_agent_ids {
                if agent_resource_is_visible(
                    &state,
                    &caller,
                    crate::identity_verify::permissions::AGENT_VIEW,
                    &agent_id,
                )
                .await
                {
                    allowed_agent_ids.insert(agent_id);
                }
            }
            let mut readable_conversation_ids = HashSet::new();
            for binding in &bindings {
                if allowed_agent_ids.contains(&binding.agent_id)
                    && crate::server::require_conversation_read_by_id(
                        &state,
                        &caller,
                        &binding.conversation_id,
                    )
                    .await
                    .is_ok()
                {
                    readable_conversation_ids.insert(binding.conversation_id.clone());
                }
            }
            let bindings =
                filter_status_bindings(bindings, &allowed_agent_ids, &readable_conversation_ids);
            let items = filter_status_items(items, &profile_agent_ids, &allowed_agent_ids);
            Json(SyncStatus {
                profiles,
                bindings,
                items,
                active_operations: store.active_count().await,
                node_id: store.node_id().to_owned(),
            })
            .into_response()
        }
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            error_response(&error.to_string())
        }
    }
}
