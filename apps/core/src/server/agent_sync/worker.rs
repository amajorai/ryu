// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

/// Start the opt-in worker after `ServerState` exists. The worker is intentionally
/// conservative: it imports setup items and projects the portable bundle only;
/// native transcript files remain read-only and are never invented by a timer.
pub fn spawn_worker(state: ServerState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(store) = global_store() else {
                continue;
            };
            let profiles = match store.profiles().await {
                Ok(profiles) => profiles,
                Err(error) => {
                    tracing::warn!("agent sync: cannot list profiles: {error:#}");
                    continue;
                }
            };
            for profile in profiles {
                if profile.import_enabled {
                    reconcile_import(&state, &store, &profile).await;
                    if crate::native_history::engine_supports_history(&profile.provider) {
                        reconcile_native_threads(&state, &store, &profile).await;
                    }
                }
                if profile.export_enabled {
                    reconcile_export(&state, &store, &profile).await;
                }
            }
        }
    });
}

/// Chat-export fingerprints automatic import has fully reconciled, by profile
/// id. Scanning an export parses all of it, so an unchanged export is not
/// scanned again on every tick.
fn reconciled_chat_exports() -> &'static std::sync::Mutex<HashMap<String, String>> {
    static RECONCILED: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();
    RECONCILED.get_or_init(Default::default)
}

fn remember_reconciled_chat_export(profile_id: &str, fingerprint: Option<String>) {
    if let (Some(fingerprint), Ok(mut reconciled)) = (fingerprint, reconciled_chat_exports().lock())
    {
        reconciled.insert(profile_id.to_owned(), fingerprint);
    }
}

/// Marks a ledger `generated_hash` that is the hash of a skill directory the
/// worker installed. The prefix keeps it apart from the hashes of projected
/// files, which the manual import compares with a source hash.
const INSTALLED_SKILL_HASH_PREFIX: &str = "installed:";

fn installed_skill_hash(installed: &Path) -> Option<String> {
    hash_path(installed)
        .ok()
        .map(|hash| format!("{INSTALLED_SKILL_HASH_PREFIX}{hash}"))
}

async fn reconcile_import(state: &ServerState, store: &AgentSyncStore, profile: &SyncProfile) {
    let root = PathBuf::from(&profile.root);
    let export_fingerprint = tokio::task::spawn_blocking({
        let root = root.clone();
        move || {
            crate::import::chat_exports::detect(&root)?;
            chat_export_fingerprint(&root).ok()
        }
    })
    .await
    .ok()
    .flatten();
    if let Some(fingerprint) = &export_fingerprint {
        let reconciled = reconciled_chat_exports()
            .lock()
            .is_ok_and(|reconciled| reconciled.get(&profile.id) == Some(fingerprint));
        if reconciled {
            return;
        }
    }
    let scan = match tokio::task::spawn_blocking({
        let root = root.clone();
        move || crate::import::scan_source(&root)
    })
    .await
    {
        Ok(Ok(scan)) => scan,
        Ok(Err(error)) => {
            tracing::warn!("agent sync: scan failed for {}: {error}", profile.root);
            return;
        }
        Err(error) => {
            tracing::warn!("agent sync: scan task failed for {}: {error}", profile.root);
            return;
        }
    };
    // Each pending item keeps the hash it was compared under. That is the hash
    // recorded once it is imported: hashing the folder again after the import
    // would also cover files that arrived while the import ran, and mark them
    // imported although the import never read them.
    let mut pending: Vec<(ImportSelection, String)> = Vec::new();
    // By skill item id: the hash of the directory this profile installed from
    // that item the last time, as the ledger recorded it.
    let mut installed_skills: HashMap<String, String> = HashMap::new();
    let mut budget = HashBudget::default();
    for item in scan.items {
        let selection = ImportSelection {
            kind: item.kind.to_owned(),
            id: item.id,
        };
        // The timer never imports an MCP server. A stdio entry is a command
        // that runs as the user, and nobody is present here to read it. The
        // import dialog is the way in: it shows the command, and the entry
        // lands disabled. The skip is by kind, so it does not depend on the
        // item failing to hash.
        if selection.kind == crate::import::kind::MCP_SERVER {
            continue;
        }
        if own_skill_skip_reason(store, &profile.id, &root, &selection)
            .await
            .is_some()
        {
            continue;
        }
        let Ok(Some(hash)) = hash_selected_item_with_budget(&root, &selection, &mut budget) else {
            continue;
        };
        // A chat export can be very large, so a failed chat-export item is
        // retried when the export changes (or from a manual import), not on
        // every tick.
        let chat_export = is_chat_export_selection(&selection);
        let previous = store
            .item(&profile.id, &selection.kind, &selection.id)
            .await
            .ok()
            .flatten();
        let unchanged = previous.as_ref().is_some_and(|previous| {
            previous.source_hash.as_deref() == Some(hash.as_str())
                && (previous.state == "imported" || chat_export)
        });
        if !unchanged {
            if selection.kind == crate::import::kind::SKILL {
                if let Some(installed) = previous.and_then(|previous| previous.generated_hash) {
                    installed_skills.insert(selection.id.clone(), installed);
                }
            }
            pending.push((selection, hash));
        }
    }
    let truncated = pending.len() > MAX_IMPORT_SELECTIONS;
    if truncated {
        pending.truncate(MAX_IMPORT_SELECTIONS);
    }
    if pending.is_empty() {
        remember_reconciled_chat_export(&profile.id, export_fingerprint);
        return;
    }
    if !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-import_{}", uuid::Uuid::new_v4());
    let selections = pending
        .iter()
        .map(|(selection, _)| selection.clone())
        .collect();
    // Nobody is present, and a skill's install name is the front-matter name of
    // a file in the synced folder. An installed skill of that name is replaced
    // only when its directory is still exactly what this profile installed from
    // the same item. A skill the user installed, edited or reinstalled, and a
    // skill another item installed, is kept.
    let may_replace_skill = |selection: &ImportSelection, installed: &Path| {
        installed_skills
            .get(&selection.id)
            .is_some_and(|expected| installed_skill_hash(installed).as_ref() == Some(expected))
    };
    let results =
        crate::server::apply_sync_worker_selections(state, &root, selections, &may_replace_skill)
            .await;
    store.finish(&profile.id).await;
    for ((selection, hash), result) in pending.into_iter().zip(results) {
        // Recorded for the next change of this item: the proof that the
        // installed directory is this profile's own. A kept skill records
        // nothing, so it is kept again.
        let installed_hash = result
            .installed_skill_dir
            .as_deref()
            .and_then(installed_skill_hash);
        let result = result.outcome;
        let _ = store
            .upsert_item(
                &profile.id,
                &selection.kind,
                &selection.id,
                Some(hash.as_str()),
                installed_hash.as_deref(),
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
    if !truncated {
        remember_reconciled_chat_export(&profile.id, export_fingerprint);
    }
}

async fn reconcile_export(state: &ServerState, store: &AgentSyncStore, profile: &SyncProfile) {
    if !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-export_{}", uuid::Uuid::new_v4());
    let result = build_export(
        state,
        store,
        Some(profile),
        Path::new(&profile.root),
        &operation_id,
        false,
        true,
        true,
        profile.include_conversations,
        &None,
        None,
    )
    .await;
    store.finish(&profile.id).await;
    if let Err(error) = result {
        tracing::warn!("agent sync: export failed for {}: {error:#}", profile.root);
    }
}

async fn reconcile_native_threads(
    state: &ServerState,
    store: &AgentSyncStore,
    profile: &SyncProfile,
) {
    let Some(agent_id) = state
        .agents
        .list_infos()
        .into_iter()
        .find(|info| info.engine.as_deref() == Some(profile.provider.as_str()))
        .map(|info| info.id)
    else {
        return;
    };
    let provider = profile.provider.clone();
    let threads = match tokio::task::spawn_blocking(move || {
        crate::native_history::list_threads(&provider, None)
    })
    .await
    {
        Ok(Ok(threads)) => threads,
        Ok(Err(error)) => {
            tracing::debug!("agent sync: native thread scan failed: {error:#}");
            return;
        }
        Err(error) => {
            tracing::debug!("agent sync: native thread scan task failed: {error}");
            return;
        }
    };
    let mut pending = Vec::new();
    for thread in threads.into_iter().take(20) {
        let source_hash = format!("{}:{}", thread.updated_at, thread.message_count);
        let unchanged = store
            .item(&profile.id, "native_thread", &thread.id)
            .await
            .ok()
            .flatten()
            .is_some_and(|previous| {
                previous.source_hash.as_deref() == Some(source_hash.as_str())
                    && previous.state == "imported"
            });
        if !unchanged {
            pending.push((thread.id, source_hash));
        }
    }
    if pending.is_empty() || !store.try_start(&profile.id).await {
        return;
    }
    let operation_id = format!("auto-thread-import_{}", uuid::Uuid::new_v4());
    for (thread_id, source_hash) in pending {
        let response =
            crate::server::import_agent_thread_for_sync(state, agent_id.clone(), thread_id.clone())
                .await;
        if response.status().is_success() {
            let _ = store
                .upsert_item(
                    &profile.id,
                    "native_thread",
                    &thread_id,
                    Some(source_hash.as_str()),
                    None,
                    &operation_id,
                    "imported",
                    None,
                )
                .await;
        }
    }
    store.finish(&profile.id).await;
}
