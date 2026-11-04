//! The document.parse facade: `decrypt_blob_input` through `job_outcome_inner`.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::document_parse::*;

/// Decrypt the blob `sha256` into a fresh owner-only file whose name keeps the
/// original extension (parsers dispatch on it).
pub(in crate::document_parse) async fn decrypt_blob_input(
    sha256: &str,
    filename: &str,
) -> Result<DecryptedBlobInput, ParseFailure> {
    blob_input_path(sha256)?;
    let dir = crate::paths::tmp_dir_for(PARSE_TMP_OWNER);
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty() && ext.len() <= 16 && ext.chars().all(char::is_alphanumeric))
        .map(|ext| format!(".{}", ext.to_ascii_lowercase()))
        .unwrap_or_default();
    let path = dir.join(format!("{}{extension}", uuid::Uuid::new_v4().simple()));
    // Claimed first: dropped on any error below, which deletes a partial copy.
    let input = DecryptedBlobInput::claim(path.clone());
    let blob_root = crate::paths::files_path("blobs");
    let sha = sha256.to_owned();
    let target = path.clone();
    let decrypted = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        sweep_parse_inputs(&dir);
        ryu_spaces::decrypt_blob_to_path(&blob_root, &sha, &target)
    })
    .await
    .map_err(|e| {
        ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("decrypting blob {sha256} failed: {e}"),
        )
    })?
    .map_err(|e| {
        ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: {e:#}"),
        )
    })?;
    if !decrypted {
        return Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: it is not in the blob store"),
        ));
    }
    Ok(input)
}

/// Read (and decrypt) a whole blob for the built-in floor, verifying its digest.
pub(in crate::document_parse) async fn read_blob_bytes(
    sha256: &str,
) -> Result<Vec<u8>, ParseFailure> {
    blob_input_path(sha256)?;
    let blob_root = crate::paths::files_path("blobs");
    let sha = sha256.to_owned();
    let read = tokio::task::spawn_blocking(move || ryu_spaces::read_blob_at(&blob_root, &sha))
        .await
        .map_err(|e| {
            ParseFailure::new(
                ParseFailureReason::BlobUnavailable,
                format!("reading blob {sha256} failed: {e}"),
            )
        })?;
    match read {
        Ok(Some(bytes)) => Ok(bytes),
        Ok(None) => Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: it is not in the blob store"),
        )),
        Err(e) => Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: {e:#}"),
        )),
    }
}

/// Whether the host has a Python interpreter to bootstrap a sidecar venv from.
///
/// Probed only on the failure path — a bound provider that will not start is either
/// a broken install or a host with no Python, and only the second one has an
/// instruction the user can act on.
pub(in crate::document_parse) async fn host_python_missing() -> bool {
    let exe = crate::sidecar::external_runtime::bootstrap_python();
    tokio::process::Command::new(exe)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .is_err()
}

/// Wake the provider sidecar if it is lazy, and hold it for this hop — the typed twin
/// of [`wake_provider`].
///
/// Used by BOTH submit and poll, deliberately. Polling is the documented mechanism
/// that re-arms the activity guard across a multi-minute parse, so a poll that only
/// took `enter_request` would fail against exactly the provider the job protocol
/// exists for: one that idle-stopped while its own parse was queued.
pub(in crate::document_parse) async fn hold_provider(
    state: &ServerState,
    route: &ProviderRoute,
) -> Result<Option<crate::sidecar::manager::ActivityGuard>, ParseFailure> {
    let Some(wake) = route.wake_name.as_ref() else {
        return Ok(None);
    };
    if let Err(failure) = state
        .manager
        .wake_and_await_healthy(wake, WAKE_TIMEOUT)
        .await
    {
        // A bound provider that will not start is either a broken install or a host
        // with no Python, and only the second has an instruction the user can act on.
        if host_python_missing().await {
            return Err(ParseFailure::new(
                ParseFailureReason::PythonMissing,
                format!("document parser '{wake}' did not become healthy"),
            ));
        }
        // Still starting: the manager's detached start keeps provisioning, so this is
        // the retryable answer, and the next parse finds the sidecar warm.
        return Err(if crate::sidecar::manager::is_still_starting(&failure) {
            ParseFailure::new(
                ParseFailureReason::ProviderTimeout,
                format!(
                    "document parser '{wake}' is still starting (a first start installs \
                     its Python environment); retry shortly"
                ),
            )
        } else {
            ParseFailure::new(
                ParseFailureReason::ProviderError,
                format!("document parser '{wake}' failed to start: {failure:#}"),
            )
        });
    }
    Ok(Some(state.manager.enter_request(wake)))
}

/// Submit a Spaces blob for extraction: floor if Core can read it, otherwise a job on
/// the bound provider.
///
/// **The blob travels as a PATH, not as bytes.** Space files reach 200 MiB while the
/// ext-proxy caps a forwarded body at 10 MiB and base64 costs another third on top,
/// so inlining a large document is not merely wasteful, it is unrepresentable. The
/// provider runs on this machine and already has `${RYU_DIR}` in its allow-list, so it
/// opens the file itself. Core resolves the sha (never the provider), which keeps
/// the shard layout — and therefore a future object-store backend — Core's
/// business alone. Blobs are sealed at rest, so the path handed over is a
/// decrypted owner-only copy under `tmp/document-parse/`, deleted when the job
/// ends (see [`DecryptedBlobInput`]).
pub async fn submit_blob(
    state: &ServerState,
    blob_sha256: &str,
    filename: &str,
    mime: &str,
    size_bytes: u64,
) -> Result<ParseSubmission, ParseFailure> {
    blob_input_path(blob_sha256)?;

    // The floor, in the same two arms as
    // [`crate::space_file_index::create_file_indexed`] and for the same reason: the
    // extension is the primary signal, and a name that carries none is judged by its
    // declared mime instead (see [`mime_floor_name`]). Spelled out rather than hidden
    // behind one combined helper so that both entry points to the floor read
    // identically and neither can quietly acquire a different notion of it.
    let floor_name: Option<std::borrow::Cow<'_, str>> = if is_builtin_readable(filename) {
        Some(std::borrow::Cow::Borrowed(filename))
    } else {
        mime_floor_name(filename, mime).map(std::borrow::Cow::Owned)
    };

    if let Some(floor_name) = floor_name {
        // The address validated but the blob is not there (or does not open or
        // verify). That is this node's storage, not a missing parser — same
        // reasoning as [`blob_input_path`].
        let bytes = read_blob_bytes(blob_sha256).await?;
        let mut outcome = builtin_parse(&floor_name, &bytes)?;
        // Trust the caller's address over a recomputed one only when they agree;
        // a mismatch means the blob store handed us the wrong file, which the
        // caller must see rather than inherit silently.
        if outcome.source_sha256 != blob_sha256 {
            outcome.warnings.push(format!(
                "blob content hashes to {} but was addressed as {blob_sha256}",
                outcome.source_sha256
            ));
        }
        return Ok(ParseSubmission::Done(Box::new(outcome)));
    }

    let Some((route, _)) = bound_provider(state).await else {
        return Err(ParseFailure::new(
            ParseFailureReason::NoProvider,
            format!(
                "no document parser is installed that can read {}",
                display_extension(filename)
            ),
        ));
    };

    let _activity = hold_provider(state, &route).await?;

    // Blobs are sealed at rest: the provider gets a decrypted owner-only copy,
    // kept until the job is polled to an end (then deleted).
    let input = decrypt_blob_input(blob_sha256, filename).await?;
    let (status, value) = provider_call_typed(
        state,
        &route,
        reqwest::Method::POST,
        &route.upstream_path,
        Some(json!({
            "path": input.path.to_string_lossy(),
            "blob_sha256": blob_sha256,
            "filename": filename,
            "mime": mime,
            "size_bytes": size_bytes,
        })),
        PROVIDER_TIMEOUT,
    )
    .await?;

    if !status.is_success() {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("document parser rejected this file")
                .to_owned(),
        ));
    }
    let Some(job_id) = value.get("job_id").and_then(Value::as_str) else {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            "document parser accepted the file but returned no job id",
        ));
    };
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.insert(job_id.to_owned(), input);
    }
    Ok(ParseSubmission::Job {
        job_id: job_id.to_owned(),
        backend_id: route.provider_id.clone(),
    })
}

/// Poll a job from [`submit_blob`]. `Ok(None)` means still running — not an error and
/// not an empty document.
pub async fn job_outcome(
    state: &ServerState,
    job_id: &str,
    source_sha256: &str,
) -> Result<Option<ParseOutcome>, ParseFailure> {
    let outcome = job_outcome_inner(state, job_id, source_sha256).await;
    // Any end of the job (success, failure, unknown job) releases its decrypted
    // input; only "still running" keeps it.
    if !matches!(outcome, Ok(None)) {
        if let Ok(mut pending) = pending_parse_inputs().lock() {
            pending.remove(job_id);
        }
    }
    outcome
}

pub(in crate::document_parse) async fn job_outcome_inner(
    state: &ServerState,
    job_id: &str,
    source_sha256: &str,
) -> Result<Option<ParseOutcome>, ParseFailure> {
    let Some((route, _)) = bound_provider(state).await else {
        return Err(ParseFailure::new(
            ParseFailureReason::NoProvider,
            "the document parser was disabled while this file was parsing",
        ));
    };
    let _activity = hold_provider(state, &route).await?;

    let (status, value) = provider_call_typed(
        state,
        &route,
        reqwest::Method::GET,
        &sibling_path(&route, &format!("jobs/{job_id}")),
        None,
        PROVIDER_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown parse job")
                .to_owned(),
        ));
    }

    let normalized = normalize_job(&value);
    match normalized["status"].as_str().unwrap_or("running") {
        "queued" | "running" => Ok(None),
        "succeeded" => {
            let markdown = normalized["markdown"].as_str().unwrap_or_default();
            let mut warnings: Vec<String> = value
                .get("result")
                .and_then(|r| r.get("warnings"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            for dep in normalized["missing_dependencies"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                warnings.push(format!("missing system dependency: {dep}"));
            }
            let truncated = normalized["truncated"].as_bool().unwrap_or(false);
            if truncated {
                warnings.push("output was truncated".to_owned());
            }
            Ok(Some(ParseOutcome {
                markdown: markdown.to_owned(),
                backend_id: route.provider_id.clone(),
                backend_version: value
                    .get("result")
                    .and_then(|r| r.get("backend_version"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                source_sha256: source_sha256.to_owned(),
                parsed_at: chrono::Utc::now(),
                warnings,
                truncated,
            }))
        }
        // `cancelled` and `failed` are both "no text, and here is why".
        _ => {
            let message = normalized["error"]
                .as_str()
                .unwrap_or("the parser returned no text for this file")
                .to_owned();
            let reason = if value.get("error_code").and_then(Value::as_str) == Some("timeout") {
                ParseFailureReason::ProviderTimeout
            } else {
                ParseFailureReason::ProviderError
            };
            Err(ParseFailure::new(reason, message))
        }
    }
}
