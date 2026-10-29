//! One streaming pass to `.part`, plus finalize/install and driver retirement.

use super::*;

/// One streaming pass: open `.part`, send Range+If-Range when resuming, write
/// chunks to disk while polling the control channel.
pub(super) async fn stream_once(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    control_rx: &mut watch::Receiver<Control>,
) -> std::result::Result<StreamResult, StreamErr> {
    let part = part_path(&spec.dest);
    if let Some(parent) = spec.dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| StreamErr::Io(format!("creating {}: {e}", parent.display())))?;
    }

    let existing = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if existing > MAX_TRANSFER_BYTES {
        return Err(StreamErr::Io(format!(
            "partial download exceeds the {}-byte transfer cap",
            MAX_TRANSFER_BYTES
        )));
    }
    let etag = {
        let tasks = inner.tasks.read().await;
        tasks.get(id).and_then(|t| t.etag.clone())
    };

    // Build the request (Range + If-Range when resuming a non-empty .part).
    // Production downloads are screened and DNS-pinned at the transfer sink,
    // immediately before each connection is made. Redirects are followed here,
    // one hop at a time, so a GitHub release asset can move to its CDN without
    // allowing an un-screened redirect target or leaking host-specific auth.
    let download_policy = ryu_egress::GuardedFetchPolicy {
        allow_http: true,
        max_body_bytes: MAX_TRANSFER_BYTES,
        ..ryu_egress::GuardedFetchPolicy::default()
    };
    let mut current_url = spec.url.clone();
    let mut redirect_hops = 0usize;
    let resp = loop {
        #[cfg(test)]
        let mut req = host().authorize(&current_url, inner.client.get(&current_url));
        #[cfg(not(test))]
        let mut req = {
            let target = ryu_egress::resolve_guarded_url(&current_url, download_policy)
                .await
                .map_err(|error| StreamErr::Io(format!("download URL rejected: {error}")))?;
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("ryu-core/0.1")
                .resolve_to_addrs(&target.host, &target.addresses)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(inner.stall_timeout)
                .build()
                .map_err(|error| {
                    StreamErr::Io(format!("building guarded download client: {error}"))
                })?;
            host().authorize(&current_url, client.get(&current_url))
        };
        if existing > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
            if let Some(tag) = &etag {
                req = req.header(reqwest::header::IF_RANGE, tag.clone());
            }
        }

        let header_wait = CONNECT_TIMEOUT + inner.stall_timeout;
        let response = tokio::time::timeout(header_wait, req.send())
            .await
            .map_err(|_| {
                StreamErr::Network(format!(
                    "GET {current_url}: no response within {header_wait:?}"
                ))
            })?
            .map_err(|e| StreamErr::Network(format!("GET {}: {e}", current_url)))?;
        if !(300..400).contains(&response.status().as_u16()) {
            break response;
        }
        if redirect_hops >= download_policy.max_redirect_hops {
            return Err(StreamErr::Network(format!(
                "too many redirects (more than {}) for {}",
                download_policy.max_redirect_hops, spec.url
            )));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                StreamErr::Network(format!(
                    "HTTP {} for {} without a Location header",
                    response.status(),
                    current_url
                ))
            })?;
        current_url = url::Url::parse(&current_url)
            .and_then(|base| base.join(location))
            .map_err(|error| StreamErr::Io(format!("invalid download redirect: {error}")))?
            .to_string();
        redirect_hops += 1;
    };
    let status = resp.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        // The kept bytes cannot be continued: typically a complete `.part` left
        // by a stop during verification, or a remote file that shrank. Asking
        // for the same range again would fail forever, so the bounded retry
        // restarts from byte zero instead.
        tokio::fs::remove_file(&part)
            .await
            .map_err(|e| StreamErr::Io(format!("discarding {}: {e}", part.display())))?;
        return Err(StreamErr::Network(format!(
            "HTTP {status} for {}; restarting the download",
            spec.url
        )));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // Gated (e.g. HF) — not resolvable by retrying.
        return Err(StreamErr::Io(format!(
            "remote refused the download (HTTP {}). If this is a gated model, set a \
             Hugging Face token in Settings → Integrations and accept the model terms.",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(StreamErr::Network(format!(
            "HTTP {} for {}",
            status, spec.url
        )));
    }

    // 206 ⇒ resume from offset; 200 ⇒ server ignored Range / file changed ⇒ restart.
    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && existing > 0;
    let mut received = if resuming { existing } else { 0 };

    let new_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .or_else(|| resp.headers().get(reqwest::header::LAST_MODIFIED))
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_len = resp.content_length();
    let total = match (resuming, content_len) {
        (true, Some(len)) => Some(existing + len),
        (false, Some(len)) => Some(len),
        _ => None,
    };
    if total.is_some_and(|bytes| bytes > MAX_TRANSFER_BYTES) {
        return Err(StreamErr::Io(format!(
            "download exceeds the {}-byte transfer cap",
            MAX_TRANSFER_BYTES
        )));
    }
    // Disk preflight, before any byte is written: what is still to come must fit
    // on the destination volume with the reserve left over. A resume only needs
    // the remainder; a restart truncates the stale `.part`, so its bytes count
    // as free. Full disk is not fixed by retrying, so it fails terminally.
    if let Some(len) = content_len {
        let probe_dir = spec.dest.parent().unwrap_or(&spec.dest);
        let reclaimed = if resuming { 0 } else { existing };
        let free = (inner.disk_free)(probe_dir).map(|free| free.saturating_add(reclaimed));
        if let Some(refusal) = crate::disk::shortfall(len, free) {
            return Err(StreamErr::Io(refusal));
        }
    }

    let file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(&part).await
    } else {
        tokio::fs::File::create(&part).await
    };
    let file = file.map_err(|e| StreamErr::Io(format!("opening {}: {e}", part.display())))?;
    // `tokio::fs::File` hands every write to the blocking pool, and network chunks
    // arrive in ~16 KiB pieces, so an unbuffered multi-GB model costs hundreds of
    // thousands of thread hops. Buffering is resume-safe: the resume offset is the
    // `.part` length on disk, so bytes still buffered when a pass dies are simply
    // fetched again.
    let mut file = tokio::io::BufWriter::with_capacity(WRITE_BUFFER_BYTES, file);

    patch(inner, id, true, |t| {
        t.total_bytes = total;
        t.received_bytes = received;
        if new_etag.is_some() {
            t.etag = new_etag.clone();
        }
    })
    .await;

    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut sample_anchor = (Instant::now(), received);

    loop {
        tokio::select! {
            biased;
            changed = control_rx.changed() => {
                if changed.is_err() { return Ok(StreamResult::Cancelled); }
                let ctl = *control_rx.borrow();
                match ctl {
                    Control::Cancel => return Ok(StreamResult::Cancelled),
                    Control::Pause => {
                        let _ = file.flush().await;
                        return Ok(StreamResult::Paused);
                    }
                    Control::Run => {}
                }
            }
            chunk = tokio::time::timeout(inner.stall_timeout, stream.next()) => {
                let Ok(chunk) = chunk else {
                    // A live-but-silent peer. Keep what already arrived so the
                    // retry resumes from it instead of holding the slot forever.
                    let _ = file.flush().await;
                    return Err(StreamErr::Network(format!(
                        "no data received for {:?}",
                        inner.stall_timeout
                    )));
                };
                match chunk {
                    None => {
                        file.flush().await.map_err(|e| StreamErr::Io(e.to_string()))?;
                        return Ok(StreamResult::Done);
                    }
                    Some(Err(e)) => {
                        // Keep what already arrived so the retry resumes from it.
                        let _ = file.flush().await;
                        return Err(StreamErr::Network(format!("stream error: {e}")));
                    }
                    Some(Ok(bytes)) => {
                        if received.saturating_add(bytes.len() as u64) > MAX_TRANSFER_BYTES {
                            return Err(StreamErr::Io(format!(
                                "download exceeds the {}-byte transfer cap",
                                MAX_TRANSFER_BYTES
                            )));
                        }
                        file.write_all(&bytes)
                            .await
                            .map_err(|e| StreamErr::Io(format!("writing {}: {e}", part.display())))?;
                        received += bytes.len() as u64;

                        if last_emit.elapsed() >= PROGRESS_THROTTLE {
                            let (anchor_t, anchor_b) = sample_anchor;
                            let secs = anchor_t.elapsed().as_secs_f64();
                            let speed = if secs > 0.0 {
                                Some(((received - anchor_b) as f64 / secs) as u64)
                            } else {
                                None
                            };
                            patch(inner, id, false, |t| {
                                t.received_bytes = received;
                                t.speed_bps = speed;
                            })
                            .await;
                            last_emit = Instant::now();
                            sample_anchor = (Instant::now(), received);
                        }
                    }
                }
            }
        }
    }
}

/// Re-hash the completed `.part` from disk, verify, then atomically rename into
/// place and record the version/checksum.
pub(super) async fn finalize(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
) -> std::result::Result<PathBuf, String> {
    patch(inner, id, true, |t| {
        t.state = DownloadState::Verifying;
        t.speed_bps = None;
    })
    .await;

    let part = part_path(&spec.dest);
    let actual = sha256_file(&part).await.map_err(|e| e.to_string())?;

    if let Some(expected) = expected_checksum(spec).as_deref() {
        if actual != expected {
            return Err(format!(
                "checksum mismatch: expected {expected}, got {actual}"
            ));
        }
    }

    let install_fs = Arc::clone(&inner.install_fs);
    let dest = spec.dest.clone();
    tokio::task::spawn_blocking(move || install_durably(install_fs.as_ref(), &part, &dest))
        .await
        .map_err(|e| format!("install task failed: {e}"))??;

    // Recorded only once the install is durable, so the checksum-skip fast path
    // never vouches for a file a power loss could still take away.
    if let Some(rec) = &spec.version_record {
        host().record_version(&rec.store_key, &rec.version, &actual);
    }

    Ok(spec.dest.clone())
}

/// Make a verified `.part` the installed file durably: flush its bytes before
/// the rename publishes them, then flush the directory so the rename itself
/// survives power loss.
///
/// A rename whose directory cannot be flushed is reported as a failure and
/// undone, so the version store (written only on success) never names a file
/// that might not survive. An update keeps the previous install under a second
/// name until then and puts it back; a first install removes the new file.
/// Both renames are atomic, so every state a crash can leave holds a complete
/// file at `dest`. On a filesystem without hard links there is no second name,
/// and an update that fails this way keeps the new, verified file rather than
/// leaving nothing installed. A second name a crash leaves behind is replaced
/// by the next install of the same file, and dropped at startup beside an
/// installed file (see [`remove_stale_previous_installs`]).
pub(super) fn install_durably(
    fs: &dyn InstallFs,
    part: &Path,
    dest: &Path,
) -> std::result::Result<(), String> {
    fs.sync_file(part)
        .map_err(|e| format!("syncing {}: {e}", part.display()))?;
    let updating = dest.is_file();
    let previous = previous_install_path(dest);
    let kept_previous = updating && {
        // A second name left by an interrupted update would refuse the link.
        if previous.exists() {
            let _ = fs.remove_file(&previous);
        }
        fs.hard_link(dest, &previous).is_ok()
    };
    if let Err(e) = fs.rename(part, dest) {
        if kept_previous {
            let _ = fs.remove_file(&previous);
        }
        return Err(format!(
            "rename {} -> {}: {e}",
            part.display(),
            dest.display()
        ));
    }
    let dir = match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    match fs.sync_dir(dir) {
        Ok(()) => {
            if kept_previous {
                let _ = fs.remove_file(&previous);
            }
            Ok(())
        }
        Err(e) => {
            if kept_previous {
                // If even that fails, the new verified file stays installed;
                // the second name is not left to hold the old bytes.
                if fs.rename(&previous, dest).is_err() {
                    let _ = fs.remove_file(&previous);
                }
            } else if !updating {
                let _ = fs.remove_file(dest);
            }
            Err(format!("syncing directory {}: {e}", dir.display()))
        }
    }
}

/// Retire a driver's terminal state. The row and history are only this
/// driver's to finish while it still owns the id: a reinstall may have taken
/// the id over (and its control handle) after this terminal commit.
pub(super) async fn retire_driver(
    inner: &Inner,
    id: &str,
    seq: u64,
    finished: Option<DownloadTask>,
) {
    persist_inner(inner).await;
    let mut handles = inner.handles.lock().await;
    if handles.get(id).is_some_and(|handle| handle.seq == seq) {
        if let Some(task) = finished {
            record_history(inner, &task).await;
        }
        handles.remove(id);
    }
}

pub(super) async fn finish_completed(
    inner: &Inner,
    id: &str,
    seq: u64,
    done_tx: &watch::Sender<Term>,
    path: PathBuf,
) {
    let finished = patch(inner, id, false, |t| {
        t.state = DownloadState::Completed;
        t.error = None;
        t.speed_bps = None;
        if let Some(total) = t.total_bytes {
            t.received_bytes = total;
        }
    })
    .await;
    retire_driver(inner, id, seq, finished).await;
    let _ = done_tx.send(Some(Ok(path)));
}

pub(super) async fn cleanup_cancelled(
    inner: &Inner,
    id: &str,
    seq: u64,
    spec: &DownloadSpec,
    done_tx: &watch::Sender<Term>,
) {
    let _ = tokio::fs::remove_file(part_path(&spec.dest)).await;
    let finished = patch(inner, id, false, |t| {
        t.state = DownloadState::Cancelled;
        t.speed_bps = None;
    })
    .await;
    retire_driver(inner, id, seq, finished).await;
    let _ = done_tx.send(Some(Err("cancelled".to_string())));
}

/// Write buffer between the network stream and the `.part` file.
pub(super) const WRITE_BUFFER_BYTES: usize = 1024 * 1024;

/// Read buffer for [`sha256_file`]. Model files run to tens of GB, so the hash
/// streams through a fixed buffer instead of loading the file into memory.
pub(super) const HASH_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// SHA-256 of a file on disk, streamed on the blocking pool so a multi-GB
/// verification neither allocates the whole file nor stalls an async worker.
pub(super) async fn sha256_file(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await?
}
