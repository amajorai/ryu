// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

async fn resolve_conflict(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ResolveConflictInput>,
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
    if !matches!(input.resolution.as_str(), "keep_ryu" | "keep_external") {
        return error_response_with(
            StatusCode::BAD_REQUEST,
            "resolution must be keep_ryu or keep_external",
        );
    }
    let profile = match store.profile(&input.profile_id).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    let item = match store
        .item(&input.profile_id, &input.kind, &input.item_id)
        .await
    {
        Ok(Some(item)) => item,
        Ok(None) => return error_response_with(StatusCode::NOT_FOUND, "sync conflict not found"),
        Err(error) => return error_response(&error.to_string()),
    };
    if item.state != "conflict" {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync item is not currently in conflict",
        );
    }
    if !store.try_start(&profile.id).await {
        return error_response_with(
            StatusCode::CONFLICT,
            "sync operation already running for root",
        );
    }
    let operation_id = format!("resolve_{}", uuid::Uuid::new_v4());
    let result: Result<()> = async {
        let root = crate::import::canonicalize_root(&profile.root)?;
        match input.resolution.as_str() {
            "keep_ryu" => {
                build_export(
                    &state,
                    &store,
                    Some(&profile),
                    &root,
                    &operation_id,
                    false,
                    true,
                    true,
                    profile.include_conversations,
                    &caller,
                    Some((input.kind.as_str(), input.item_id.as_str())),
                )
                .await?;
                let resolved = store
                    .item(&profile.id, &input.kind, &input.item_id)
                    .await?
                    .is_some_and(|item| item.state != "conflict");
                if !resolved {
                    bail!("the selected conflict could not be projected");
                }
            }
            "keep_external" => {
                let path = item
                    .conflict
                    .as_ref()
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .context("conflict has no external projection path")?;
                let path = fs::canonicalize(path)
                    .with_context(|| format!("reading external projection {}", path))?;
                if path.strip_prefix(&root).is_err() {
                    bail!("external projection is outside the selected profile root");
                }
                let bytes = fs::read(&path)
                    .with_context(|| format!("reading external projection {}", path.display()))?;
                let adopted_hash = if input.kind == "bundle" {
                    bundle_projection_hash_from_bytes(&bytes)
                        .context("external bundle is not a valid Ryu projection")?
                } else {
                    sha256_bytes(&bytes)
                };
                let previous_generated_hash = item
                    .conflict
                    .as_ref()
                    .and_then(|value| value.get("generated_hash_before_conflict"))
                    .and_then(Value::as_str)
                    .or(item.generated_hash.as_deref())
                    .unwrap_or_default();
                store
                    .upsert_item(
                        &profile.id,
                        &input.kind,
                        &input.item_id,
                        None,
                        Some(adopted_hash.as_str()),
                        &operation_id,
                        "external",
                        Some(&json!({
                            "resolution": "keep_external",
                            "adopted_hash": adopted_hash,
                            "previous_generated_hash": previous_generated_hash,
                            "path": path.to_string_lossy(),
                        })),
                    )
                    .await?;
            }
            _ => bail!("resolution must be keep_ryu or keep_external"),
        }
        let remaining_conflicts = store
            .items()
            .await?
            .into_iter()
            .filter(|item| item.profile_id == profile.id && item.state == "conflict")
            .count();
        store
            .update_profile_summary(
                &profile.id,
                &operation_id,
                if remaining_conflicts > 0 {
                    "conflict"
                } else {
                    "idle"
                },
            )
            .await?;
        Ok(())
    }
    .await;
    store.finish(&profile.id).await;
    match result {
        Ok(()) => Json(json!({ "resolved": true })).into_response(),
        Err(error) => error_response(&error.to_string()),
    }
}

async fn build_export(
    state: &ServerState,
    store: &AgentSyncStore,
    profile: Option<&SyncProfile>,
    destination: &Path,
    operation_id: &str,
    dry_run: bool,
    include_agents: bool,
    include_skills: bool,
    include_conversations: bool,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    force_item: Option<(&str, &str)>,
) -> Result<SyncExportResult> {
    let mut warnings = Vec::new();
    let agents = if include_agents {
        let records = state
            .agent_store
            .list()
            .await
            .context("listing agents for export")?;
        let mut allowed_agent_ids = HashSet::new();
        let mut templates = Vec::with_capacity(records.len());
        for record in records {
            if agent_resource_is_visible(
                state,
                caller,
                crate::identity_verify::permissions::AGENT_VIEW,
                &record.id,
            )
            .await
            {
                allowed_agent_ids.insert(record.id.clone());
                templates.push((record.id.clone(), record.to_template()));
            }
        }
        filter_export_templates(templates, &allowed_agent_ids)
    } else {
        Vec::new()
    };
    let skills = if include_skills {
        state.skills.list_all()
    } else {
        Vec::new()
    };
    let conversation_summaries = state
        .conversations
        .list_conversations()
        .await
        .context("listing conversations for export")?;
    let mut visible_conversations = Vec::with_capacity(conversation_summaries.len());
    for summary in conversation_summaries {
        if crate::server::require_conversation_read_by_id(state, caller, &summary.id)
            .await
            .is_ok()
        {
            visible_conversations.push(summary);
        }
    }
    let mut conversations = Vec::new();
    let mut messages = 0;
    if include_conversations {
        for summary in &visible_conversations {
            let rows = state
                .conversations
                .get_messages(&summary.id)
                .await
                .with_context(|| format!("reading conversation {} for export", summary.id))?;
            messages += rows.len();
            conversations.push(BundleConversation {
                id: summary.id.clone(),
                title: summary.title.clone(),
                agent_id: summary.agent_id.clone(),
                created_at: summary.created_at,
                updated_at: summary.updated_at,
                folder_path: summary.folder_path.clone(),
                branch: summary.branch.clone(),
                messages: rows,
            });
        }
        warnings.push(
            "Conversation transcripts are portable-bundle data only; no native history file is written.".to_owned(),
        );
    }
    let bundle = Bundle {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        operation_id: operation_id.to_owned(),
        generated_by: "ryu",
        node_id: store.node_id.clone(),
        created_at: now_ms(),
        agents,
        skills,
        conversations,
        warnings: warnings.clone(),
    };
    let raw = serde_json::to_vec_pretty(&bundle).context("serializing Ryu sync bundle")?;
    // Operation ids and timestamps are useful metadata but must not make an
    // unchanged projection look changed. The ledger compares this stable
    // content hash, not the volatile envelope bytes.
    let bundle_hash = bundle_projection_hash(&bundle)?;
    let bundle_path = destination.join(BUNDLE_FILE_NAME);
    let mut projected_files = 0;
    let mut conflicts = 0;
    let existing_projection = fs::read(&bundle_path)
        .ok()
        .and_then(|bytes| bundle_projection_hash_from_bytes(&bytes));
    let previous = match profile {
        Some(profile) => store.item(&profile.id, "bundle", BUNDLE_FILE_NAME).await?,
        None => None,
    };
    let force_bundle = force_item == Some(("bundle", BUNDLE_FILE_NAME));
    let external_preserved = previous.as_ref().is_some_and(|item| {
        item.state == "external"
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("resolution"))
                .and_then(Value::as_str)
                == Some("keep_external")
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("adopted_hash"))
                .and_then(Value::as_str)
                == existing_projection.as_deref()
            && item
                .conflict
                .as_ref()
                .and_then(|value| value.get("previous_generated_hash"))
                .and_then(Value::as_str)
                == Some(bundle_hash.as_str())
    });
    if let Some(ref existing_projection) = existing_projection {
        let external_changed = previous
            .as_ref()
            .and_then(|item| item.generated_hash.as_deref())
            .is_none_or(|previous_hash| previous_hash != existing_projection);
        let paused = previous
            .as_ref()
            .is_some_and(|item| item.state == "conflict");
        if !force_bundle
            && !external_preserved
            && (external_changed || paused)
            && existing_projection.as_str() != bundle_hash
        {
            conflicts = 1;
            warnings.push(
                "The destination bundle changed outside Ryu; it was preserved and export paused for review.".to_owned(),
            );
        }
    }
    let force_skill = force_item.is_some_and(|(kind, _)| kind == "skill");
    if (conflicts == 0 || force_skill) && !force_bundle {
        if let Some(profile) = profile {
            let (skill_files, skill_conflicts, skill_warnings) = project_skills(
                store,
                profile,
                destination,
                &bundle.skills,
                operation_id,
                dry_run,
                force_item,
            )
            .await?;
            projected_files += skill_files;
            conflicts += skill_conflicts;
            warnings.extend(skill_warnings);
        }
    }
    if conflicts == 0 && !external_preserved && existing_projection != Some(bundle_hash.clone()) {
        projected_files += 1;
        if !dry_run {
            write_atomic(&bundle_path, &raw)?;
        }
    }
    if let Some(profile) = profile {
        if !dry_run {
            if external_preserved {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        existing_projection.as_deref(),
                        operation_id,
                        "external",
                        Some(&json!({
                            "resolution": "keep_external",
                            "adopted_hash": existing_projection,
                            "previous_generated_hash": bundle_hash,
                            "path": bundle_path.to_string_lossy(),
                        })),
                    )
                    .await?;
            } else if conflicts == 0 {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        Some(&bundle_hash),
                        operation_id,
                        "projected",
                        None,
                    )
                    .await?;
            } else {
                store
                    .upsert_item(
                        &profile.id,
                        "bundle",
                        BUNDLE_FILE_NAME,
                        None,
                        existing_projection.as_deref(),
                        operation_id,
                        "conflict",
                        Some(&json!({
                            "reason": "external bundle changed",
                            "path": bundle_path.to_string_lossy(),
                            "generated_hash_before_conflict": bundle_hash,
                        })),
                    )
                    .await?;
            }
            store
                .update_profile_summary(
                    &profile.id,
                    operation_id,
                    if conflicts > 0 { "conflict" } else { "idle" },
                )
                .await?;
        }
    }
    let readable_conversation_ids: HashSet<String> = visible_conversations
        .iter()
        .map(|conversation| conversation.id.clone())
        .collect();
    let mut bindings = Vec::new();
    for binding in store.bindings().await? {
        if !readable_conversation_ids.contains(&binding.conversation_id)
            || !agent_resource_is_visible(
                state,
                caller,
                crate::identity_verify::permissions::AGENT_VIEW,
                &binding.agent_id,
            )
            .await
        {
            continue;
        }
        bindings.push(binding);
    }
    let acp_resume = visible_conversations
        .into_iter()
        .map(|conversation| {
            let binding = bindings.iter().find(|binding| {
                binding.conversation_id == conversation.id
                    && conversation
                        .agent_id
                        .as_deref()
                        .is_none_or(|agent_id| binding.agent_id == agent_id)
            });
            let can_resume = binding.is_some_and(|binding| {
                binding
                    .capabilities
                    .get("loadSession")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || binding
                        .capabilities
                        .get("sessionCapabilities")
                        .and_then(|value| value.get("resume"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            });
            AcpResumeStatus {
                conversation_id: conversation.id,
                agent_id: conversation.agent_id,
                mode: if can_resume { "resume" } else { "replay" }.to_owned(),
                reason: if can_resume {
                    "The ACP binding advertises session load/resume; the native session id is retained.".to_owned()
                } else {
                    "No load/resume capability was recorded; Ryu replays the canonical transcript.".to_owned()
                },
            }
        })
        .collect();
    Ok(SyncExportResult {
        profile_id: profile.map(|profile| profile.id.clone()),
        operation_id: operation_id.to_owned(),
        dry_run,
        destination: destination.to_string_lossy().to_string(),
        bundle_path: bundle_path.to_string_lossy().to_string(),
        bundle_hash,
        agents: bundle.agents.len(),
        skills: bundle.skills.len(),
        conversations: bundle.conversations.len(),
        messages,
        projected_files,
        conflicts,
        warnings,
        acp_resume,
    })
}
