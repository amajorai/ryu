use super::*;
use crate::{set_global_host, DownloadKind, DownloadsHost, VersionRecord};

/// A no-state host for the crate's own tests: a per-process temp data dir (so
/// `downloads.json` / history never touch a real `~/.ryu`), no version-store
/// checksums, and no auth (the tests hit loopback, never Hugging Face).
struct TestHost {
    dir: PathBuf,
}

/// One clock for every observed install step and version-store write, so a
/// test can order them across the two seams.
static JOURNAL: AtomicU64 = AtomicU64::new(1);
/// `(store_key, checksum, journal stamp)` for every version the center records.
static RECORDED_VERSIONS: std::sync::Mutex<Vec<(String, String, u64)>> =
    std::sync::Mutex::new(Vec::new());

fn recorded_versions(store_key: &str) -> Vec<(String, u64)> {
    RECORDED_VERSIONS
        .lock()
        .unwrap()
        .iter()
        .filter(|(key, _, _)| key == store_key)
        .map(|(_, checksum, at)| (checksum.clone(), *at))
        .collect()
}

impl DownloadsHost for TestHost {
    fn ryu_dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn installed_checksum(&self, _store_key: &str) -> Option<String> {
        None
    }
    fn record_version(&self, store_key: &str, _version: &str, checksum: &str) {
        let at = JOURNAL.fetch_add(1, Ordering::SeqCst);
        RECORDED_VERSIONS
            .lock()
            .unwrap()
            .push((store_key.to_owned(), checksum.to_owned(), at));
    }
    fn authorize(&self, _url: &str, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req
    }
}

/// Install the temp-dir [`TestHost`] once for the whole test binary.
/// `set_global_host` is idempotent, so every test can call this cheaply.
fn ensure_host() {
    let dir = std::env::temp_dir().join(format!("ryu-dl-host-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    set_global_host(std::sync::Arc::new(TestHost { dir }));
}

fn spec(dest: PathBuf) -> DownloadSpec {
    DownloadSpec {
        kind: DownloadKind::Model,
        role: DownloadRole::ChatModel,
        label: "test".to_string(),
        url: "http://127.0.0.1:0/never".to_string(),
        dest,
        sha256: None,
        version_record: None,
    }
}

#[test]
fn id_is_stable_and_dest_derived() {
    let a = derive_id(Path::new("/x/y/model.gguf"));
    let b = derive_id(Path::new("/x/y/model.gguf"));
    let c = derive_id(Path::new("/x/y/other.gguf"));
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with("dl_"));
}

#[test]
fn executable_download_roles_require_integrity_metadata() {
    assert!(requires_checksum(DownloadRole::Engine));
    assert!(requires_checksum(DownloadRole::Agent));
    assert!(requires_checksum(DownloadRole::Tool));
    assert!(requires_checksum(DownloadRole::Plugin));
    assert!(requires_checksum(DownloadRole::McpServer));
    assert!(!requires_checksum(DownloadRole::ChatModel));
}

#[test]
fn atomic_state_write_replaces_whole_file_without_leaving_staging() {
    let dir = std::env::temp_dir().join(format!("ryu-dl-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("downloads.json");
    write_file_atomically(&path, br#"[{"long":"previous snapshot body"}]"#).unwrap();
    write_file_atomically(&path, b"[]").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name() != "downloads.json")
        .collect();
    assert!(leftovers.is_empty(), "staging files left: {leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn persisted_task_keeps_expected_checksum_for_restart_resume() {
    ensure_host();
    let dir = std::env::temp_dir().join(format!("ryu-dl-sha-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut s = spec(dir.join("model.gguf"));
    s.sha256 = Some("ab".repeat(32));

    let center = DownloadCenter::with_default_client();
    let (id, _rx) = center.spawn(s.clone(), true, false).await;
    let task = center
        .snapshot()
        .await
        .into_iter()
        .find(|task| task.id == id)
        .expect("parked task is registered");
    // What `load()` reads back after a restart must still carry the digest.
    let reloaded: DownloadTask =
        serde_json::from_str(&serde_json::to_string(&task).unwrap()).unwrap();
    assert_eq!(reloaded.sha256, s.sha256);

    center.cancel(&id).await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[test]
fn part_path_appends_suffix() {
    assert_eq!(
        part_path(Path::new("/m/x.gguf")),
        PathBuf::from("/m/x.gguf.part")
    );
}

#[tokio::test]
async fn streamed_hash_matches_a_whole_buffer_digest_across_buffer_boundaries() {
    let dir = std::env::temp_dir().join(format!("ryu-dl-hash-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("multi-buffer.bin");
    // Several full buffers plus a ragged tail, so every read boundary is crossed.
    let body: Vec<u8> = (0..(HASH_BUFFER_BYTES * 3 + 12_345))
        .map(|index| (index % 251) as u8)
        .collect();
    tokio::fs::write(&path, &body).await.unwrap();

    let streamed = sha256_file(&path).await.unwrap();
    let _ = tokio::fs::remove_dir_all(&dir).await;

    assert_eq!(streamed, hex::encode(Sha256::digest(&body)));
}

#[tokio::test]
async fn fast_path_skips_when_checksum_matches() {
    ensure_host();
    let dir = std::env::temp_dir().join(format!("ryu-dl-test-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let dest = dir.join("present.bin");
    tokio::fs::write(&dest, b"hello world").await.unwrap();
    let sum = sha256_file(&dest).await.unwrap();

    let mut s = spec(dest.clone());
    s.sha256 = Some(sum);
    assert_eq!(fast_path(&s).await, Some(dest.clone()));

    // Wrong checksum ⇒ no skip.
    let mut bad = spec(dest.clone());
    bad.sha256 = Some("deadbeef".to_string());
    assert_eq!(fast_path(&bad).await, None);

    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn blocking_download_returns_a_failed_transfer_without_hanging() {
    ensure_host();
    let dir = std::env::temp_dir().join(format!("ryu-dl-failure-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let dest = dir.join("engine.bin");
    let mut s = spec(dest);
    s.kind = DownloadKind::Engine;
    s.role = DownloadRole::Engine;

    let center = DownloadCenter::with_default_client();
    let error = tokio::time::timeout(Duration::from_secs(2), center.download_blocking(s.clone()))
        .await
        .expect("a failed download must resolve its blocking waiter")
        .expect_err("an engine without integrity metadata must fail");
    assert!(error.to_string().contains("requires a SHA-256 checksum"));

    let id = derive_id(&s.dest);
    let task = center
        .snapshot()
        .await
        .into_iter()
        .find(|task| task.id == id)
        .expect("failed task remains visible for retry");
    assert_eq!(task.state, DownloadState::Failed);
    assert!(
        !task.retryable,
        "missing integrity metadata is not retryable"
    );

    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// Asking again for a download that FAILED must run it again with the new
/// caller's spec. The failed driver parks for a UI retry, and deduping onto it
/// as-is replayed the stale error to every later install of the same file.
#[tokio::test]
async fn a_new_request_restarts_a_failed_download_with_its_own_spec() {
    ensure_host();
    use axum::routing::get;
    use axum::Router;

    let body: Vec<u8> = (0u8..=255).cycle().take(4_096).collect();
    let served = body.clone();
    let app = Router::new().route("/engine", get(move || async move { served.clone() }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let dir = std::env::temp_dir().join(format!("ryu-dl-restart-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut s = spec(dir.join("engine.bin"));
    s.kind = DownloadKind::Engine;
    s.role = DownloadRole::Engine;
    s.url = format!("http://{addr}/engine");

    let center = DownloadCenter::with_default_client();
    // No checksum: an engine fails closed.
    center
        .download_blocking(s.clone())
        .await
        .expect_err("an engine without a checksum must fail");

    // Same destination, now with the checksum the first caller lacked.
    s.sha256 = Some({
        let mut h = Sha256::new();
        h.update(&body);
        hex::encode(h.finalize())
    });
    let path = tokio::time::timeout(Duration::from_secs(5), center.download_blocking(s))
        .await
        .expect("the restarted download must finish")
        .expect("the restarted download uses the new caller's checksum");
    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);

    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// Cancelling a download that is still waiting for a slot takes effect at
/// once; it used to sit in `Queued` (and hang its blocking caller) until a
/// slot freed and a request had already gone out.
#[tokio::test]
async fn cancelling_a_queued_download_resolves_without_waiting_for_a_slot() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    center
        .set_settings(ConcurrencyMode::Manual, Some(1))
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("ryu-dl-qcancel-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();

    // The first task holds the only slot while it retries an unroutable URL.
    let mut holder = spec(dir.join("holder.bin"));
    holder.url = "http://127.0.0.1:1/never".to_string();
    let holder_id = center.enqueue(holder).await;

    let mut waiting = spec(dir.join("waiting.bin"));
    waiting.url = "http://127.0.0.1:1/never".to_string();
    let waiting_id = derive_id(&waiting.dest);
    let blocked = {
        let center = center.clone();
        tokio::spawn(async move { center.download_blocking(waiting).await })
    };
    for _ in 0..50 {
        let queued = center
            .snapshot()
            .await
            .iter()
            .any(|t| t.id == waiting_id && t.state == DownloadState::Queued);
        if queued {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert!(center.cancel(&waiting_id).await);
    let result = tokio::time::timeout(Duration::from_secs(2), blocked)
        .await
        .expect("a cancelled queued download must resolve its waiter")
        .unwrap();
    assert!(result.is_err());

    center.cancel(&holder_id).await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// End-to-end on loopback: a half-written `.part` resumes via a Range request
/// and the final file equals the full body (no concatenation corruption). This
/// is the advisor's #3 concern exercised deterministically — no timing races.
#[tokio::test]
async fn resumes_from_part_via_range() {
    ensure_host();
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    let body: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
    let served = body.clone();
    let app = Router::new().route(
        "/file",
        get(move |req: Request| {
            let body = served.clone();
            async move {
                let range = req
                    .headers()
                    .get(header::RANGE)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                match range {
                    Some(r) => {
                        let start: usize = r
                            .trim_start_matches("bytes=")
                            .trim_end_matches('-')
                            .parse()
                            .unwrap_or(0);
                        let slice = body[start..].to_vec();
                        let mut resp = (StatusCode::PARTIAL_CONTENT, slice).into_response();
                        resp.headers_mut()
                            .insert(header::ETAG, "\"v1\"".parse().unwrap());
                        resp
                    }
                    None => {
                        let mut resp = (StatusCode::OK, body.clone()).into_response();
                        resp.headers_mut()
                            .insert(header::ETAG, "\"v1\"".parse().unwrap());
                        resp
                    }
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let dir = std::env::temp_dir().join(format!("ryu-dl-resume-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let dest = dir.join("file.bin");
    // Simulate an interrupted download: first 4000 bytes already on disk.
    tokio::fs::write(part_path(&dest), &body[..4000])
        .await
        .unwrap();

    let center = DownloadCenter::with_default_client();
    let mut s = spec(dest.clone());
    s.url = format!("http://{addr}/file");
    s.sha256 = Some({
        let mut h = Sha256::new();
        h.update(&body);
        hex::encode(h.finalize())
    });

    let path = center.download_blocking(s).await.unwrap();
    let got = tokio::fs::read(&path).await.unwrap();
    assert_eq!(got, body, "resumed file must equal the full body");
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// The disk preflight refuses a transfer that would not leave the reserve
/// free, before the `.part` is created and without a retry, and a resume is
/// measured by its remainder only.
#[tokio::test]
async fn disk_preflight_refuses_before_writing_and_counts_only_the_resume_remainder() {
    ensure_host();
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    let body: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
    let served = body.clone();
    let app = Router::new().route(
        "/file",
        get(move |req: Request| {
            let body = served.clone();
            async move {
                let start: usize = req
                    .headers()
                    .get(header::RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|r| {
                        r.trim_start_matches("bytes=")
                            .trim_end_matches('-')
                            .parse()
                            .ok()
                    })
                    .unwrap_or(0);
                let status = if start > 0 {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                };
                let mut resp = (status, body[start..].to_vec()).into_response();
                resp.headers_mut()
                    .insert(header::ETAG, "\"v1\"".parse().unwrap());
                resp
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let dir = std::env::temp_dir().join(format!("ryu-dl-disk-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    // Room for 6000 more bytes past the reserve: the full 10000-byte body does
    // not fit, the 6000-byte remainder of a 4000-byte `.part` does.
    let center = DownloadCenter::with_default_client()
        .with_disk_probe(|_| Some(crate::DISK_HEADROOM_BYTES + 6_000));
    let checksum = {
        let mut h = Sha256::new();
        h.update(&body);
        hex::encode(h.finalize())
    };

    let fresh = dir.join("fresh.bin");
    let mut s = spec(fresh.clone());
    s.url = format!("http://{addr}/file");
    s.sha256 = Some(checksum.clone());
    let error = center.download_blocking(s).await.expect_err("no room");
    assert!(
        error.to_string().contains("Not enough free disk space"),
        "{error:#}"
    );
    assert!(!part_path(&fresh).exists(), "nothing may be written");
    let task = center
        .snapshot()
        .await
        .into_iter()
        .find(|t| t.id == derive_id(&fresh))
        .expect("failed task stays listed");
    assert_eq!(task.state, DownloadState::Failed);
    assert!(!task.retryable, "a full disk is not fixed by retrying");

    let resumed = dir.join("resumed.bin");
    tokio::fs::write(part_path(&resumed), &body[..4000])
        .await
        .unwrap();
    let mut s = spec(resumed);
    s.url = format!("http://{addr}/file");
    s.sha256 = Some(checksum);
    let path = center.download_blocking(s).await.expect("remainder fits");
    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn follows_redirects_with_a_fresh_download_guard_per_hop() {
    ensure_host();
    use axum::response::Redirect;
    use axum::routing::get;
    use axum::Router;

    let body = b"redirected archive".to_vec();
    let served = body.clone();
    let app = Router::new()
        .route("/start", get(|| async { Redirect::temporary("/file") }))
        .route(
            "/file",
            get(move || {
                let body = served.clone();
                async move { body }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let dir = std::env::temp_dir().join(format!("ryu-dl-redirect-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let dest = dir.join("redirected.bin");
    let mut s = spec(dest.clone());
    s.url = format!("http://{addr}/start");
    s.sha256 = Some({
        let mut hasher = Sha256::new();
        hasher.update(&body);
        hex::encode(hasher.finalize())
    });

    let center = DownloadCenter::with_default_client();
    let path = center.download_blocking(s).await.unwrap();
    assert_eq!(tokio::fs::read(path).await.unwrap(), body);
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// Read one HTTP/1.1 request head (through the blank line) from a raw socket.
async fn read_request_head(socket: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if socket.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// A server that sends headers and part of the body, then goes silent while
/// keeping the socket open, must not hang the transfer: the stall bound turns
/// it into a network error and the retry resumes the `.part` via Range.
#[tokio::test]
async fn stalled_transfer_times_out_and_resumes_via_range() {
    ensure_host();
    use tokio::io::AsyncWriteExt;

    let body: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
    let first_half = 4_000usize;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let range_start = Arc::new(std::sync::Mutex::new(None::<usize>));
    let served = body.clone();
    let seen_range = range_start.clone();
    tokio::spawn(async move {
        // Held open (never written to again) to simulate a live, silent peer.
        let mut stalled = Vec::new();
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let head = read_request_head(&mut socket).await;
            let range = head.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("range").then(|| {
                    value
                        .trim()
                        .trim_start_matches("bytes=")
                        .trim_end_matches('-')
                        .parse::<usize>()
                        .ok()
                })?
            });
            match range {
                Some(start) => {
                    *seen_range.lock().unwrap() = Some(start);
                    let rest = &served[start..];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                        rest.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(rest).await;
                    let _ = socket.shutdown().await;
                }
                None => {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\n\r\n",
                        served.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&served[..first_half]).await;
                    let _ = socket.flush().await;
                    stalled.push(socket);
                }
            }
        }
    });

    let dir = std::env::temp_dir().join(format!("ryu-dl-stall-{}", std::process::id()));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let dest = dir.join("stalled.bin");
    let mut s = spec(dest.clone());
    s.url = format!("http://{addr}/file");
    s.sha256 = Some(hex::encode(Sha256::digest(&body)));

    let center =
        DownloadCenter::with_default_client().with_stall_timeout(Duration::from_millis(200));
    let path = tokio::time::timeout(Duration::from_secs(10), center.download_blocking(s))
        .await
        .expect("a stalled transfer must not hang its blocking waiter")
        .expect("the retry resumes the stalled transfer and completes");

    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    let resumed_from = *range_start.lock().unwrap();
    assert!(
        resumed_from.is_some_and(|start| start > 0 && start <= first_half),
        "the retry must resume the kept .part with a Range request, got {resumed_from:?}"
    );
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
#[ignore = "live Hugging Face smoke; downloads the pinned 35 MB public Needle 3 model"]
async fn live_plugin_model_download_verifies_the_pinned_hugging_face_file() {
    ensure_host();
    let host_dir = std::env::temp_dir().join(format!("ryu-dl-host-{}", std::process::id()));
    let dir = std::env::temp_dir().join(format!("ryu-dl-live-needle-{}", std::process::id()));
    assert!(
        !dir.exists(),
        "refusing to reuse the live model-download directory: {}",
        dir.display()
    );
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create temp dir");
    let dest = dir.join("needle3.cact");
    let center = DownloadCenter::with_default_client();
    let result = center
        .download_blocking(DownloadSpec {
            kind: DownloadKind::Model,
            role: DownloadRole::PluginModel,
            label: "@ryu/needle3 (needle3.cact)".to_owned(),
            url: "https://huggingface.co/Cactus-Compute/needle3/resolve/b274efcb211a9eef48c9a88da4b43bd569696a39/needle3.cact".to_owned(),
            dest: dest.clone(),
            sha256: Some(
                "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38"
                    .to_owned(),
            ),
            version_record: Some(VersionRecord {
                store_key: "plugin-model:hf:Cactus-Compute/needle3:needle3.cact".to_owned(),
                version: "b274efcb211a9eef48c9a88da4b43bd569696a39".to_owned(),
            }),
        })
        .await;
    let downloaded = tokio::fs::read(&dest).await;
    let cleanup = tokio::fs::remove_dir_all(&dir).await;
    let host_cleanup = tokio::fs::remove_dir_all(&host_dir).await;

    result.expect("Ryu Downloads should fetch and verify the pinned model file");
    cleanup.expect("remove the isolated model-download directory");
    host_cleanup.expect("remove the isolated download-history directory");
    let downloaded = downloaded.expect("read downloaded Needle 3 model");
    assert_eq!(downloaded.len(), 35_335_380);
    assert_eq!(
        hex::encode(Sha256::digest(downloaded)),
        "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38"
    );
}

#[tokio::test]
async fn register_indeterminate_tracks_completion_and_failure() {
    ensure_host();
    let center = DownloadCenter::with_default_client();

    let ok: Result<i32> = center
        .register_indeterminate("ind:ok".into(), DownloadKind::Skill, "ok".into(), async {
            Ok(42)
        })
        .await;
    assert_eq!(ok.unwrap(), 42);
    let t = center
        .snapshot()
        .await
        .into_iter()
        .find(|t| t.id == "ind:ok")
        .unwrap();
    assert_eq!(t.state, DownloadState::Completed);
    assert!(t.total_bytes.is_none(), "indeterminate task has no total");

    let err: Result<i32> = center
        .register_indeterminate("ind:err".into(), DownloadKind::Skill, "err".into(), async {
            anyhow::bail!("boom")
        })
        .await;
    assert!(err.is_err());
    let t = center
        .snapshot()
        .await
        .into_iter()
        .find(|t| t.id == "ind:err")
        .unwrap();
    assert_eq!(t.state, DownloadState::Failed);
    assert!(t.retryable);
}

/// Two indeterminate registrations can legitimately share an id — the same
/// artifact installed from two surfaces (an agent runtime reachable from both
/// the Agents tab and the Engines tab), or a retry racing the first attempt.
/// Unlike a byte transfer, they cannot dedup: the future's output type belongs
/// to the caller, so the second registration replaces the map entry.
///
/// The bug that guards against: when the FIRST one finished it removed the id
/// unconditionally, deleting the SECOND one's live control handle — so Cancel
/// on the still-running install silently no-opped and the row could never be
/// stopped. Removal is stamped, so only the owning registration retires it.
#[tokio::test]
async fn a_finished_registration_does_not_strand_a_later_same_id_one() {
    ensure_host();
    let center = DownloadCenter::with_default_client();

    // Wait until the registration wearing `label` owns the id.
    async fn until_registered(center: &DownloadCenter, label: &str) {
        for _ in 0..1000 {
            if center
                .snapshot()
                .await
                .iter()
                .any(|t| t.id == "ind:shared" && t.label == label)
            {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("registration `{label}` never appeared");
    }

    let (release_first, first_held) = tokio::sync::oneshot::channel::<()>();
    let first = {
        let center = center.clone();
        tokio::spawn(async move {
            center
                .register_indeterminate(
                    "ind:shared".into(),
                    DownloadKind::Agent,
                    "first".into(),
                    async {
                        let _ = first_held.await;
                        Ok(1)
                    },
                )
                .await
        })
    };
    until_registered(&center, "first").await;

    let (_release_second, second_held) = tokio::sync::oneshot::channel::<()>();
    let second = {
        let center = center.clone();
        tokio::spawn(async move {
            center
                .register_indeterminate(
                    "ind:shared".into(),
                    DownloadKind::Agent,
                    "second".into(),
                    async {
                        let _ = second_held.await;
                        Ok(2)
                    },
                )
                .await
        })
    };
    until_registered(&center, "second").await;

    // The FIRST registration finishes while the SECOND still holds the id.
    drop(release_first);
    assert_eq!(first.await.expect("task joined").unwrap(), 1);

    // The second is still cancelable: its control handle survived.
    assert!(
        center.cancel("ind:shared").await,
        "cancel must still reach the registration that owns the id"
    );
    let outcome = second.await.expect("task joined");
    assert!(
        outcome.is_err(),
        "a cancelled registration returns an error"
    );
}

/// A download waiting on the concurrency gate must report `Queued`, not
/// `Active`. This is what makes the queue visible at all: the driver used to
/// flip the state to Active before acquiring a permit, so every waiting task
/// claimed to be downloading and the tray had nothing to group.
#[tokio::test]
async fn waiting_downloads_report_queued_not_active() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    // One slot, so everything after the first must wait on the gate.
    center
        .set_settings(ConcurrencyMode::Manual, Some(1))
        .await
        .unwrap();

    let dir = std::env::temp_dir().join(format!("ryu-dl-queue-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();

    // Unroutable URLs: the first task holds the single permit while it retries,
    // which is exactly the "slot is busy" condition the others must queue behind.
    let mut ids = Vec::new();
    for n in 0..3 {
        let mut s = spec(dir.join(format!("queued-{n}.bin")));
        s.url = "http://127.0.0.1:1/never".to_string();
        ids.push(center.enqueue(s).await);
    }

    // Let the drivers reach their first await point.
    let mut queued = 0;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let snap = center.snapshot().await;
        queued = snap
            .iter()
            .filter(|t| ids.contains(&t.id) && t.state == DownloadState::Queued)
            .count();
        if queued >= 2 {
            break;
        }
    }
    assert!(
        queued >= 2,
        "with 1 slot and 3 downloads, at least 2 must sit in Queued (saw {queued})"
    );

    for id in &ids {
        center.cancel(id).await;
    }
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

/// Manual mode resizes the live gate and the view reports what is in force.
#[tokio::test]
async fn manual_settings_resize_the_gate() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    let view = center
        .set_settings(ConcurrencyMode::Manual, Some(6))
        .await
        .unwrap();
    assert_eq!(view.mode, ConcurrencyMode::Manual);
    assert_eq!(view.manual_slots, 6);
    assert_eq!(view.effective_slots, 6);

    // Growing is immediate; shrinking with nothing running is too.
    let view = center
        .set_settings(ConcurrencyMode::Manual, Some(2))
        .await
        .unwrap();
    assert_eq!(view.effective_slots, 2);

    // Out-of-range values clamp rather than being rejected.
    let view = center
        .set_settings(ConcurrencyMode::Manual, Some(999))
        .await
        .unwrap();
    assert_eq!(view.manual_slots, MAX_SLOTS);
}

#[tokio::test]
async fn enqueue_dedups_onto_same_id() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    let dest = std::env::temp_dir().join("ryu-dedup-test.bin");
    let id1 = center.enqueue(spec(dest.clone())).await;
    let id2 = center.enqueue(spec(dest.clone())).await;
    assert_eq!(id1, id2);
    let snap = center.snapshot().await;
    assert_eq!(snap.iter().filter(|t| t.id == id1).count(), 1);
    // Clean up the driver (it's stuck retrying an unroutable URL).
    center.cancel(&id1).await;
}

/// Run the real persistence boundary in a fresh process: the global host and
/// operator environment must not leak into unrelated download tests.
#[test]
fn settings_persistence_refusal_retry_and_reopen() {
    let root =
        std::env::temp_dir().join(format!("ryu-settings-persistence-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "center::tests::settings_persistence_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("RYU_DOWNLOADS_SETTINGS_PROOF_ROOT", &root)
        .env_remove("RYU_MAX_CONCURRENT_DOWNLOADS")
        .env_remove("RYU_DOWNLOADS_SETTINGS_FILE")
        .output()
        .unwrap();
    let cleanup = std::fs::remove_dir_all(&root);
    assert!(
        output.status.success(),
        "actual settings child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
    cleanup.unwrap();
}

#[tokio::test]
#[ignore = "isolated settings persistence child, invoked by its parent"]
async fn settings_persistence_fixture() {
    let root = PathBuf::from(
        std::env::var_os("RYU_DOWNLOADS_SETTINGS_PROOF_ROOT").expect("owned child root required"),
    );
    set_global_host(Arc::new(TestHost { dir: root.clone() }));
    let path = root.join("settings.json");
    std::env::set_var("RYU_DOWNLOADS_SETTINGS_FILE", &path);
    let center = DownloadCenter::with_default_client();
    center
        .set_settings(ConcurrencyMode::Manual, Some(2))
        .await
        .unwrap();
    let prior = std::fs::read(&path).unwrap();
    let fresh = DownloadCenter::with_default_client();
    assert_eq!(fresh.settings().await.manual_slots, 2);
    assert_eq!(fresh.settings().await.effective_slots, 2);

    // A directory cannot be replaced by a JSON settings file, even when
    // this test runs as root. The previously accepted bytes remain intact.
    let refused = root.join("refused-settings");
    std::fs::create_dir(&refused).unwrap();
    std::env::set_var("RYU_DOWNLOADS_SETTINGS_FILE", &refused);
    let failure = center.set_settings(ConcurrencyMode::Manual, Some(6)).await;
    assert!(
        failure.is_err(),
        "saving to an actual directory must report refusal"
    );
    assert_eq!(
        center.settings().await.manual_slots,
        2,
        "refused save must retain live preference"
    );
    assert_eq!(
        center.settings().await.effective_slots,
        2,
        "refused save must retain live gate"
    );
    assert_eq!(std::fs::read(&path).unwrap(), prior);
    assert!(refused.is_dir());

    std::env::set_var("RYU_DOWNLOADS_SETTINGS_FILE", &path);
    center
        .set_settings(ConcurrencyMode::Manual, Some(6))
        .await
        .unwrap();
    assert_eq!(
        DownloadCenter::with_default_client()
            .settings()
            .await
            .manual_slots,
        6
    );
    let disk: DownloadSettings = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(disk.manual_slots, 6);

    // Two accepted mutations must leave the saved preference and live gate
    // in the same order, regardless of which future acquired the lock first.
    let (first, second) = tokio::join!(
        center.set_settings(ConcurrencyMode::Manual, Some(4)),
        center.set_settings(ConcurrencyMode::Manual, Some(7))
    );
    first.unwrap();
    second.unwrap();
    let current = center.settings().await;
    let reopened = DownloadCenter::with_default_client().settings().await;
    assert_eq!(current.manual_slots, reopened.manual_slots);
    assert_eq!(current.effective_slots, reopened.effective_slots);
    center
        .set_settings(ConcurrencyMode::Auto, None)
        .await
        .unwrap();
    let reopened = DownloadCenter::with_default_client().settings().await;
    assert_eq!(reopened.mode, ConcurrencyMode::Auto);
    assert_eq!(reopened.manual_slots, current.manual_slots);

    let prior = std::fs::read(&path).unwrap();
    std::env::set_var("RYU_MAX_CONCURRENT_DOWNLOADS", "3");
    assert!(center
        .set_settings(ConcurrencyMode::Manual, Some(9))
        .await
        .is_err());
    assert_eq!(
        std::fs::read(&path).unwrap(),
        prior,
        "operator refusal must not replace saved settings"
    );
    assert_eq!(
        DownloadCenter::with_default_client()
            .settings()
            .await
            .effective_slots,
        3
    );
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        2,
        "accepted/refused saves must not leak staging files"
    );
}

/// A loopback origin with a real HTTP boundary. It records each request's
/// `Range` header. With `ranges`, a satisfiable range gets 206 plus
/// `Content-Range` and one past the end gets 416 (RFC 9110); without it
/// every request receives the complete 200 body.
async fn range_origin(
    body: Vec<u8>,
    ranges: bool,
) -> (String, Arc<std::sync::Mutex<Vec<Option<String>>>>) {
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let app = Router::new().route(
        "/model.gguf",
        get(move |request: Request| {
            let body = body.clone();
            let recorded = recorded.clone();
            async move {
                let range = request
                    .headers()
                    .get(header::RANGE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                recorded.lock().unwrap().push(range.clone());
                let start = range.filter(|_| ranges).and_then(|value| {
                    value
                        .strip_prefix("bytes=")?
                        .strip_suffix('-')?
                        .parse()
                        .ok()
                });
                let mut response = match start {
                    Some(start) if start >= body.len() => {
                        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                        response.headers_mut().insert(
                            header::CONTENT_RANGE,
                            format!("bytes */{}", body.len()).parse().unwrap(),
                        );
                        response
                    }
                    Some(start) => {
                        let range = format!("bytes {start}-{}/{}", body.len() - 1, body.len());
                        let mut response =
                            (StatusCode::PARTIAL_CONTENT, body[start..].to_vec()).into_response();
                        response
                            .headers_mut()
                            .insert(header::CONTENT_RANGE, range.parse().unwrap());
                        response
                    }
                    None => (StatusCode::OK, body).into_response(),
                };
                response
                    .headers_mut()
                    .insert(header::ETAG, "\"model-v1\"".parse().unwrap());
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}/model.gguf"), seen)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn owned_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-dl-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A second name a crash left beside an installed file is dropped at
/// startup; one beside a missing install is kept, since it may be the only
/// copy of that file.
#[test]
fn startup_drops_a_stale_previous_install_only_beside_an_installed_file() {
    let dir = owned_dir("stale-previous");
    let installed = dir.join("installed.gguf");
    std::fs::write(&installed, b"new model").unwrap();
    std::fs::write(previous_install_path(&installed), b"old model").unwrap();
    let missing = dir.join("missing.gguf");
    std::fs::write(previous_install_path(&missing), b"only copy").unwrap();
    let clean = dir.join("clean.gguf");
    std::fs::write(&clean, b"model").unwrap();

    remove_stale_previous_installs(
        [&installed, &missing, &clean]
            .into_iter()
            .filter_map(|dest| dest.to_str()),
    );

    assert_eq!(std::fs::read(&installed).unwrap(), b"new model");
    assert!(!previous_install_path(&installed).exists());
    assert_eq!(
        std::fs::read(previous_install_path(&missing)).unwrap(),
        b"only copy"
    );
    assert_eq!(std::fs::read(&clean).unwrap(), b"model");
    assert!(!previous_install_path(&clean).exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Without integrity metadata (an ordinary chat model), only the transfer
/// itself protects the bytes: a full 200 answer must replace stale partial
/// bytes rather than being appended to them.
#[tokio::test]
async fn an_origin_ignoring_range_restarts_the_part_instead_of_appending() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let (url, seen) = range_origin(body.clone(), false).await;
    let dir = owned_dir("ignored-range");
    let dest = dir.join("model.gguf");
    tokio::fs::write(part_path(&dest), vec![0xEE; 4_000])
        .await
        .unwrap();
    let mut s = spec(dest.clone());
    s.url = url;
    let center = DownloadCenter::with_default_client();
    let path = tokio::time::timeout(Duration::from_secs(20), center.download_blocking(s))
        .await
        .expect("download must settle")
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    assert!(!part_path(&dest).exists());
    assert_eq!(*seen.lock().unwrap(), [Some("bytes=4000-".to_string())]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A process stopped while verifying leaves a complete `.part`. Resuming it
/// asks for a range that starts at the end of the file, so the origin
/// correctly answers 416. That answer must not strand the download in a
/// permanently failing retry loop: it restarts and installs verified bytes.
#[tokio::test]
async fn an_unsatisfiable_resume_of_a_complete_part_restarts_instead_of_failing_forever() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let (url, seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("complete-part");
    let dest = dir.join("model.gguf");
    let unrelated = dir.join("other-model.gguf");
    tokio::fs::write(&unrelated, b"keep me").await.unwrap();
    tokio::fs::write(part_path(&dest), &body).await.unwrap();
    let mut s = spec(dest.clone());
    s.url = url;
    s.sha256 = Some(sha256_hex(&body));
    let center = DownloadCenter::with_default_client();
    let result = tokio::time::timeout(Duration::from_secs(30), center.download_blocking(s.clone()))
        .await
        .expect("download must settle");
    let task = center
        .snapshot()
        .await
        .into_iter()
        .find(|task| task.id == derive_id(&dest))
        .expect("task remains visible");
    let path = result.unwrap_or_else(|error| {
        panic!(
            "complete partial download never installed: {error:#}; state {:?}, requests {:?}",
            task.state,
            seen.lock().unwrap()
        )
    });
    assert_eq!(task.state, DownloadState::Completed);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    assert!(!part_path(&dest).exists());
    assert_eq!(tokio::fs::read(&unrelated).await.unwrap(), b"keep me");
    assert_eq!(
        *seen.lock().unwrap(),
        [Some("bytes=10000-".to_string()), None],
        "the restart must request the whole file exactly once"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Cancel closes the live response instead of draining it, deletes the
/// partial bytes and never installs the destination. The next download of
/// the same file therefore starts from byte zero, with no stale `Range`.
#[tokio::test]
async fn cancel_closes_the_live_response_removes_the_part_and_the_next_download_starts_from_zero() {
    ensure_host();
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::header;
    use axum::routing::get;
    use axum::Router;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Released(Arc<AtomicBool>);
    impl Drop for Released {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let slow = Arc::new(AtomicBool::new(true));
    let released = Arc::new(AtomicBool::new(false));
    let chunks_sent = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
    let app = {
        let (body, slow, released, chunks_sent, seen) = (
            body.clone(),
            slow.clone(),
            released.clone(),
            chunks_sent.clone(),
            seen.clone(),
        );
        Router::new().route(
            "/model.gguf",
            get(move |request: Request| {
                let (body, slow, released, chunks_sent, seen) = (
                    body.clone(),
                    slow.clone(),
                    released.clone(),
                    chunks_sent.clone(),
                    seen.clone(),
                );
                async move {
                    seen.lock().unwrap().push(
                        request
                            .headers()
                            .get(header::RANGE)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_string),
                    );
                    if !slow.load(Ordering::SeqCst) {
                        return Body::from(body);
                    }
                    // An endless trickle: hyper notices a closed connection
                    // on its next write and drops this stream (and guard).
                    let guard = Released(released);
                    let stream = futures_util::stream::unfold(
                        (guard, chunks_sent),
                        |(guard, sent)| async move {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            sent.fetch_add(1, Ordering::SeqCst);
                            Some((Ok::<_, std::io::Error>(vec![7u8; 512]), (guard, sent)))
                        },
                    );
                    Body::from_stream(stream)
                }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let dir = owned_dir("cancel");
    let dest = dir.join("model.gguf");
    let mut s = spec(dest.clone());
    s.url = format!("http://{address}/model.gguf");
    let center = DownloadCenter::with_default_client();
    let id = center.enqueue(s.clone()).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while chunks_sent.load(Ordering::SeqCst) < 5 || !part_path(&dest).exists() {
        assert!(
            Instant::now() < deadline,
            "transfer never started streaming"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(center.cancel(&id).await);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = center
            .snapshot()
            .await
            .into_iter()
            .find(|task| task.id == id)
            .map(|task| task.state);
        if state == Some(DownloadState::Cancelled) && !part_path(&dest).exists() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cancel did not settle: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while !released.load(Ordering::SeqCst) {
        assert!(
            Instant::now() < deadline,
            "the cancelled response stayed open"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let after_close = chunks_sent.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(chunks_sent.load(Ordering::SeqCst), after_close);
    assert!(!dest.exists(), "a cancelled transfer was installed");

    slow.store(false, Ordering::SeqCst);
    let path = tokio::time::timeout(Duration::from_secs(20), center.download_blocking(s))
        .await
        .expect("download must settle")
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    assert_eq!(*seen.lock().unwrap(), [None, None]);
    let _ = std::fs::remove_dir_all(&dir);
}

// ── durable install ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallStep {
    SyncFile(PathBuf),
    HardLink(PathBuf, PathBuf),
    Rename(PathBuf, PathBuf),
    SyncDir(PathBuf),
    RemoveFile(PathBuf),
}

/// One install step plus the disk state it found when it started.
#[derive(Debug, Clone)]
struct ObservedStep {
    at: u64,
    step: InstallStep,
    part_len: Option<u64>,
    dest_len: Option<u64>,
}

/// Delegates every step to the real [`StdInstallFs`], after journaling it,
/// and refuses the steps named in `fail` without performing them.
struct ObservingInstallFs {
    dest: PathBuf,
    fail: Vec<&'static str>,
    steps: std::sync::Mutex<Vec<ObservedStep>>,
}

impl ObservingInstallFs {
    fn new(dest: &Path, fail: Option<&'static str>) -> Arc<Self> {
        Self::failing(dest, fail.as_slice())
    }

    fn failing(dest: &Path, fail: &[&'static str]) -> Arc<Self> {
        Arc::new(Self {
            dest: dest.to_path_buf(),
            fail: fail.to_vec(),
            steps: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn observe(&self, step: InstallStep, name: &str) -> std::io::Result<()> {
        let len = |path: &Path| std::fs::metadata(path).ok().map(|meta| meta.len());
        self.steps.lock().unwrap().push(ObservedStep {
            at: JOURNAL.fetch_add(1, Ordering::SeqCst),
            step,
            part_len: len(&part_path(&self.dest)),
            dest_len: len(&self.dest),
        });
        if self.fail.contains(&name) {
            return Err(std::io::Error::other(format!("injected {name} failure")));
        }
        Ok(())
    }

    fn observed(&self) -> Vec<ObservedStep> {
        self.steps.lock().unwrap().clone()
    }

    fn steps(&self) -> Vec<InstallStep> {
        self.observed().into_iter().map(|seen| seen.step).collect()
    }
}

impl InstallFs for ObservingInstallFs {
    fn sync_file(&self, path: &Path) -> std::io::Result<()> {
        self.observe(InstallStep::SyncFile(path.to_path_buf()), "sync_file")?;
        StdInstallFs.sync_file(path)
    }

    fn hard_link(&self, original: &Path, link: &Path) -> std::io::Result<()> {
        self.observe(
            InstallStep::HardLink(original.to_path_buf(), link.to_path_buf()),
            "hard_link",
        )?;
        StdInstallFs.hard_link(original, link)
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.observe(
            InstallStep::Rename(from.to_path_buf(), to.to_path_buf()),
            "rename",
        )?;
        StdInstallFs.rename(from, to)
    }

    fn sync_dir(&self, path: &Path) -> std::io::Result<()> {
        self.observe(InstallStep::SyncDir(path.to_path_buf()), "sync_dir")?;
        StdInstallFs.sync_dir(path)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        self.observe(InstallStep::RemoveFile(path.to_path_buf()), "remove_file")?;
        StdInstallFs.remove_file(path)
    }
}

fn durable_spec(dest: &Path, url: String, body: &[u8], store_key: &str) -> DownloadSpec {
    let mut s = spec(dest.to_path_buf());
    s.url = url;
    s.sha256 = Some(sha256_hex(body));
    s.version_record = Some(VersionRecord {
        store_key: store_key.to_owned(),
        version: "v1".to_owned(),
    });
    s
}

async fn task_of(center: &DownloadCenter, id: &str) -> Option<DownloadTask> {
    center
        .snapshot()
        .await
        .into_iter()
        .find(|task| task.id == id)
}

/// The verified `.part` reaches stable storage before the rename publishes
/// it, the directory entry reaches stable storage after the rename, and only
/// then does the version store claim the artifact is installed.
#[tokio::test]
async fn a_verified_download_is_synced_before_the_rename_and_its_directory_after() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(64 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-order");
    let dest = dir.join("model.gguf");
    let store_key = format!("durable-order-{}", std::process::id());
    let install_fs = ObservingInstallFs::new(&dest, None);
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    let path = tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect("a verified download installs");

    let observed = install_fs.observed();
    assert_eq!(
        install_fs.steps(),
        [
            InstallStep::SyncFile(part_path(&dest)),
            InstallStep::Rename(part_path(&dest), dest.clone()),
            InstallStep::SyncDir(dir.clone()),
        ],
        "sync the data, then publish it, then sync the directory entry"
    );
    let len = Some(body.len() as u64);
    assert_eq!(
        (observed[0].part_len, observed[0].dest_len),
        (len, None),
        "the data sync must cover the complete part before anything is installed"
    );
    assert_eq!(
        (observed[2].part_len, observed[2].dest_len),
        (None, len),
        "the directory sync must follow the rename"
    );
    let recorded = recorded_versions(&store_key);
    assert_eq!(recorded.len(), 1, "exactly one version record");
    assert_eq!(recorded[0].0, sha256_hex(&body));
    assert!(
        recorded[0].1 > observed[2].at,
        "the version store must not claim an install whose rename is not durable yet"
    );
    assert_eq!(path, dest);
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body);
    assert_eq!(
        task_of(&center, &derive_id(&dest)).await.map(|t| t.state),
        Some(DownloadState::Completed)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A part that cannot be flushed is never published: the previous install
/// stays byte-for-byte, nothing is recorded, and the task reports failure.
#[tokio::test]
async fn a_failed_part_sync_keeps_the_previous_install_and_records_nothing() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(32 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-file-refusal");
    let dest = dir.join("model.gguf");
    let unrelated = dir.join("other-model.gguf");
    tokio::fs::write(&dest, b"previous model").await.unwrap();
    tokio::fs::write(&unrelated, b"keep me").await.unwrap();
    let store_key = format!("durable-file-refusal-{}", std::process::id());
    let install_fs = ObservingInstallFs::new(&dest, Some("sync_file"));
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    let error = tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect_err("an unsynced part must not install");

    assert!(
        error.to_string().contains("injected sync_file failure"),
        "the refusal names the failed sync: {error:#}"
    );
    assert_eq!(
        install_fs.steps(),
        [InstallStep::SyncFile(part_path(&dest))],
        "no rename may follow a failed data sync"
    );
    let task = task_of(&center, &derive_id(&dest)).await.unwrap();
    assert_eq!(task.state, DownloadState::Failed);
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), b"previous model");
    assert!(!part_path(&dest).exists(), "the unsynced part is discarded");
    assert_eq!(tokio::fs::read(&unrelated).await.unwrap(), b"keep me");
    assert!(recorded_versions(&store_key).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// When the directory entry cannot be flushed the rename is not durable, so
/// the task fails, the version store is untouched, and no installed file is
/// left for a loader to mistake for a completed download.
#[tokio::test]
async fn a_failed_directory_sync_reports_failure_and_leaves_nothing_installed() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(32 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-dir-refusal");
    let dest = dir.join("model.gguf");
    let unrelated = dir.join("other-model.gguf");
    tokio::fs::write(&unrelated, b"keep me").await.unwrap();
    let store_key = format!("durable-dir-refusal-{}", std::process::id());
    let install_fs = ObservingInstallFs::new(&dest, Some("sync_dir"));
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    let error = tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect_err("an undurable rename must not report success");

    assert!(
        error.to_string().contains("injected sync_dir failure"),
        "the refusal names the failed sync: {error:#}"
    );
    assert_eq!(
        install_fs.steps(),
        [
            InstallStep::SyncFile(part_path(&dest)),
            InstallStep::Rename(part_path(&dest), dest.clone()),
            InstallStep::SyncDir(dir.clone()),
            InstallStep::RemoveFile(dest.clone()),
        ],
        "a first install has no previous copy to keep; the new file is removed"
    );
    let task = task_of(&center, &derive_id(&dest)).await.unwrap();
    assert_eq!(task.state, DownloadState::Failed);
    assert!(!dest.exists(), "a failed install leaves no installed file");
    assert!(!part_path(&dest).exists());
    assert_eq!(tokio::fs::read(&unrelated).await.unwrap(), b"keep me");
    assert!(recorded_versions(&store_key).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// An update whose directory entry cannot be flushed fails without costing
/// the user the copy they already had: the previous install is restored
/// byte-for-byte, nothing is recorded, and no backup or part is left.
#[tokio::test]
async fn a_failed_directory_sync_on_update_restores_the_previous_install() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(32 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-dir-update");
    let dest = dir.join("model.gguf");
    let unrelated = dir.join("other-model.gguf");
    tokio::fs::write(&dest, b"previous model").await.unwrap();
    tokio::fs::write(&unrelated, b"keep me").await.unwrap();
    let store_key = format!("durable-dir-update-{}", std::process::id());
    let install_fs = ObservingInstallFs::new(&dest, Some("sync_dir"));
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    let error = tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect_err("an undurable rename must not report success");

    assert!(
        error.to_string().contains("injected sync_dir failure"),
        "the refusal names the failed sync: {error:#}"
    );
    let previous = previous_install_path(&dest);
    assert_eq!(
        install_fs.steps(),
        [
            InstallStep::SyncFile(part_path(&dest)),
            InstallStep::HardLink(dest.clone(), previous.clone()),
            InstallStep::Rename(part_path(&dest), dest.clone()),
            InstallStep::SyncDir(dir.clone()),
            InstallStep::Rename(previous, dest.clone()),
        ],
        "keep a second name for the previous install, then put it back"
    );
    let task = task_of(&center, &derive_id(&dest)).await.unwrap();
    assert_eq!(task.state, DownloadState::Failed);
    assert_eq!(
        tokio::fs::read(&dest).await.ok().as_deref(),
        Some(&b"previous model"[..]),
        "previous install destroyed by a failed directory sync"
    );
    assert!(!part_path(&dest).exists());
    let leftovers = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "model.gguf" && name != "other-model.gguf")
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "no backup or part is left: {leftovers:?}"
    );
    assert_eq!(tokio::fs::read(&unrelated).await.unwrap(), b"keep me");
    assert!(recorded_versions(&store_key).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A durable update replaces the previous install, drops its second name
/// only after the directory sync, and then records the new version.
#[tokio::test]
async fn a_durable_update_replaces_the_previous_install_and_drops_its_second_name() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(32 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-update");
    let dest = dir.join("model.gguf");
    tokio::fs::write(&dest, b"previous model").await.unwrap();
    // A second name an interrupted update left behind is replaced.
    let previous = previous_install_path(&dest);
    tokio::fs::write(&previous, b"stale second name")
        .await
        .unwrap();
    let store_key = format!("durable-update-{}", std::process::id());
    let install_fs = ObservingInstallFs::new(&dest, None);
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect("a verified update installs");

    let observed = install_fs.observed();
    assert_eq!(
        install_fs.steps(),
        [
            InstallStep::SyncFile(part_path(&dest)),
            InstallStep::RemoveFile(previous.clone()),
            InstallStep::HardLink(dest.clone(), previous.clone()),
            InstallStep::Rename(part_path(&dest), dest.clone()),
            InstallStep::SyncDir(dir.clone()),
            InstallStep::RemoveFile(previous.clone()),
        ]
    );
    assert_eq!(
        observed[4].dest_len,
        Some(body.len() as u64),
        "the directory sync covers the new install"
    );
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body);
    assert!(
        !previous.exists(),
        "the second name is dropped after success"
    );
    assert!(!part_path(&dest).exists());
    let recorded = recorded_versions(&store_key);
    assert_eq!(recorded.len(), 1);
    assert!(
        recorded[0].1 > observed[4].at,
        "recorded after the directory sync"
    );
    assert_eq!(
        task_of(&center, &derive_id(&dest)).await.map(|t| t.state),
        Some(DownloadState::Completed)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Without hard links an update has no second name for the previous
/// install. A failed directory sync then reports failure and records
/// nothing, but keeps the new, verified file instead of deleting it and
/// leaving nothing installed.
#[tokio::test]
async fn without_hard_links_a_failed_directory_sync_keeps_the_new_verified_install() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(32 * 1024).collect();
    let (url, _seen) = range_origin(body.clone(), true).await;
    let dir = owned_dir("durable-no-links");
    let dest = dir.join("model.gguf");
    tokio::fs::write(&dest, b"previous model").await.unwrap();
    let store_key = format!("durable-no-links-{}", std::process::id());
    let install_fs = ObservingInstallFs::failing(&dest, &["hard_link", "sync_dir"]);
    let center = DownloadCenter::with_install_fs(default_http_client(), install_fs.clone());

    let error = tokio::time::timeout(
        Duration::from_secs(20),
        center.download_blocking(durable_spec(&dest, url, &body, &store_key)),
    )
    .await
    .expect("download must settle")
    .expect_err("an undurable rename must not report success");

    assert!(error.to_string().contains("injected sync_dir failure"));
    assert_eq!(
        install_fs.steps(),
        [
            InstallStep::SyncFile(part_path(&dest)),
            InstallStep::HardLink(dest.clone(), previous_install_path(&dest)),
            InstallStep::Rename(part_path(&dest), dest.clone()),
            InstallStep::SyncDir(dir.clone()),
        ],
        "nothing is removed when there is no previous copy to put back"
    );
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body);
    assert!(!previous_install_path(&dest).exists());
    assert!(!part_path(&dest).exists());
    let task = task_of(&center, &derive_id(&dest)).await.unwrap();
    assert_eq!(task.state, DownloadState::Failed);
    assert!(recorded_versions(&store_key).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── GET versus the event stream on one node ─────────────────────────────

/// Fold events the way the desktop and Native mirrors do: a snapshot
/// replaces, an update upserts by id and a removal drops the row.
fn drain_events(
    rx: &mut broadcast::Receiver<DownloadEvent>,
    mirror: &mut HashMap<String, DownloadTask>,
) {
    loop {
        match rx.try_recv() {
            Ok(DownloadEvent::Snapshot { tasks }) => {
                *mirror = tasks.into_iter().map(|t| (t.id.clone(), t)).collect();
            }
            Ok(DownloadEvent::Update { task }) => {
                mirror.insert(task.id.clone(), task);
            }
            Ok(DownloadEvent::Removed { id }) => {
                mirror.remove(&id);
            }
            Err(broadcast::error::TryRecvError::Empty) => return,
            Err(error) => panic!("the event stream broke: {error:?}"),
        }
    }
}

/// A fresh GET and the stream-fed mirror must hold the identical commit.
async fn assert_stream_matches_get(
    center: &DownloadCenter,
    rx: &mut broadcast::Receiver<DownloadEvent>,
    mirror: &mut HashMap<String, DownloadTask>,
    id: &str,
    moment: &str,
) {
    drain_events(rx, mirror);
    let get = task_of(center, id).await;
    assert_eq!(
        serde_json::to_value(mirror.get(id)).unwrap(),
        serde_json::to_value(&get).unwrap(),
        "{moment}: the event stream disagrees with GET /api/downloads"
    );
}

/// A loopback origin that serves `body` in full, or, while `held` is set,
/// answers with headers and one chunk and then never finishes. Each mode
/// carries its own `ETag` so a test can tell which response a task is on.
async fn switch_origin(body: Vec<u8>) -> (String, Arc<AtomicBool>, Arc<AtomicUsize>) {
    use axum::body::Body;
    use axum::http::header;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    let held = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicUsize::new(0));
    let app = {
        let (held, requests) = (held.clone(), requests.clone());
        Router::new().route(
            "/model.gguf",
            get(move || {
                let (body, held, requests) = (body.clone(), held.clone(), requests.clone());
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if held.load(Ordering::SeqCst) {
                        let stream = futures_util::stream::once(async {
                            Ok::<_, std::io::Error>(vec![1u8; 16])
                        })
                        .chain(futures_util::stream::pending());
                        ([(header::ETAG, "\"held\"")], Body::from_stream(stream)).into_response()
                    } else {
                        ([(header::ETAG, "\"full\"")], body).into_response()
                    }
                }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}/model.gguf"), held, requests)
}

/// Wait until the task is streaming the held response.
async fn until_streaming_held(center: &DownloadCenter, id: &str) {
    loop {
        if let Some(task) = task_of(center, id).await {
            if task.state == DownloadState::Active && task.etag.as_deref() == Some("\"held\"") {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn until_state(center: &DownloadCenter, id: &str, state: DownloadState) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let current = task_of(center, id).await.map(|task| task.state);
        if current == Some(state) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{id} never reached {state:?}: {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn reached(park: &CommitPark) {
    let mut reached = park.reached.subscribe();
    tokio::time::timeout(Duration::from_secs(10), reached.wait_for(|hit| *hit))
        .await
        .expect("the parked commit was never reached")
        .unwrap();
}

fn is_update(event: &DownloadEvent, id: &str, state: DownloadState) -> bool {
    matches!(event, DownloadEvent::Update { task } if task.id == id && task.state == state)
}

/// Dismissing a finished row while the same artifact is reinstalled: the
/// stream must not deliver the dismissal after the reinstall's newer rows,
/// and the reinstall keeps the control handle that Pause and Cancel use.
#[tokio::test]
async fn a_dismissal_racing_a_reinstall_keeps_get_and_stream_agreeing_and_the_reinstall_controllable(
) {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let (url, held, requests) = switch_origin(body.clone()).await;
    let dir = owned_dir("clear-race");
    let dest = dir.join("model.gguf");
    let unrelated = dir.join("other-model.gguf");
    tokio::fs::write(&unrelated, b"keep me").await.unwrap();
    let mut s = spec(dest.clone());
    s.url = url;
    let id = derive_id(&dest);
    let center = DownloadCenter::with_default_client();
    let mut rx = center.subscribe();
    let mut mirror = HashMap::new();

    tokio::time::timeout(Duration::from_secs(20), center.download_blocking(s.clone()))
        .await
        .expect("first download must settle")
        .unwrap();
    held.store(true, Ordering::SeqCst);

    let park = center.park_after_commit({
        let id = id.clone();
        move |event| matches!(event, DownloadEvent::Removed { id: removed } if *removed == id)
    });
    let clearing = tokio::spawn({
        let (center, id) = (center.clone(), id.clone());
        async move { center.clear(&id).await }
    });
    reached(&park).await;
    let reinstall = tokio::spawn({
        let (center, s) = (center.clone(), s.clone());
        async move { center.enqueue(s).await }
    });
    // Let the reinstall run as far as it can while the dismissal is parked.
    let _ = tokio::time::timeout(
        Duration::from_millis(500),
        until_streaming_held(&center, &id),
    )
    .await;
    park.release.add_permits(1);
    assert!(clearing.await.unwrap(), "the finished row is dismissed");
    assert_eq!(reinstall.await.unwrap(), id);
    tokio::time::timeout(Duration::from_secs(10), until_streaming_held(&center, &id))
        .await
        .expect("the reinstall never started streaming");

    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after the race").await;
    assert!(
        center.pause(&id).await,
        "Pause must still reach the reinstall"
    );
    until_state(&center, &id, DownloadState::Paused).await;
    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after Pause").await;
    assert!(
        center.cancel(&id).await,
        "Cancel must still reach the reinstall"
    );
    until_state(&center, &id, DownloadState::Cancelled).await;
    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after Cancel").await;
    assert!(!part_path(&dest).exists());
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body);
    assert_eq!(tokio::fs::read(&unrelated).await.unwrap(), b"keep me");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A reinstall that starts while the previous transfer's completion is
/// still being published: the stale Completed must not reach the stream
/// after the reinstall's rows, history must not list the live transfer as
/// finished, and the reinstall keeps its control handle.
#[tokio::test]
async fn a_reinstall_racing_a_completion_keeps_the_stream_ordered_and_the_reinstall_controllable() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let (url, held, requests) = switch_origin(body.clone()).await;
    let dir = owned_dir("complete-race");
    let dest = dir.join("model.gguf");
    let mut s = spec(dest.clone());
    s.url = url;
    let id = derive_id(&dest);
    let center = DownloadCenter::with_default_client();
    let mut rx = center.subscribe();
    let mut mirror = HashMap::new();

    let park = center.park_after_commit({
        let id = id.clone();
        move |event| is_update(event, &id, DownloadState::Completed)
    });
    let first = tokio::spawn({
        let (center, s) = (center.clone(), s.clone());
        async move { center.download_blocking(s).await }
    });
    reached(&park).await;
    held.store(true, Ordering::SeqCst);
    assert_eq!(center.enqueue(s.clone()).await, id);
    tokio::time::timeout(Duration::from_secs(10), until_streaming_held(&center, &id))
        .await
        .expect("the reinstall never started streaming");
    park.release.add_permits(1);
    let installed = tokio::time::timeout(Duration::from_secs(10), first)
        .await
        .expect("the first download must settle")
        .unwrap()
        .expect("the first download completed");
    assert_eq!(installed, dest);

    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after the race").await;
    let live_in_history: Vec<DownloadState> = center
        .history()
        .await
        .into_iter()
        .filter(|task| task.id == id && !task.state.is_terminal())
        .map(|task| task.state)
        .collect();
    assert!(
        live_in_history.is_empty(),
        "history lists a live transfer as a previous download: {live_in_history:?}"
    );
    assert!(
        center.pause(&id).await,
        "Pause must still reach the reinstall"
    );
    until_state(&center, &id, DownloadState::Paused).await;
    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after Pause").await;
    assert!(center.cancel(&id).await);
    until_state(&center, &id, DownloadState::Cancelled).await;
    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after Cancel").await;
    assert_eq!(
        center
            .history()
            .await
            .into_iter()
            .find(|task| task.id == id)
            .map(|task| task.state),
        Some(DownloadState::Cancelled)
    );
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A reinstall that starts while a cancellation is still being published
/// must download afresh instead of inheriting the cancelled result, and the
/// stale cancellation must not overwrite the reinstall in history.
#[tokio::test]
async fn a_reinstall_racing_a_cancellation_downloads_instead_of_inheriting_it() {
    ensure_host();
    let body: Vec<u8> = (0u8..=250).cycle().take(10_000).collect();
    let (url, held, requests) = switch_origin(body.clone()).await;
    let dir = owned_dir("cancel-race");
    let dest = dir.join("model.gguf");
    let mut s = spec(dest.clone());
    s.url = url;
    let id = derive_id(&dest);
    let center = DownloadCenter::with_default_client();
    let mut rx = center.subscribe();
    let mut mirror = HashMap::new();

    held.store(true, Ordering::SeqCst);
    let first = tokio::spawn({
        let (center, s) = (center.clone(), s.clone());
        async move { center.download_blocking(s).await }
    });
    tokio::time::timeout(Duration::from_secs(10), until_streaming_held(&center, &id))
        .await
        .expect("the first transfer never started streaming");
    let park = center.park_after_commit({
        let id = id.clone();
        move |event| is_update(event, &id, DownloadState::Cancelled)
    });
    assert!(center.cancel(&id).await);
    reached(&park).await;
    held.store(false, Ordering::SeqCst);
    let reinstall = tokio::spawn({
        let (center, s) = (center.clone(), s.clone());
        async move { center.download_blocking(s).await }
    });
    // Let the reinstall run as far as it can while the cancellation is parked.
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        while !reinstall.is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    park.release.add_permits(1);
    let path = tokio::time::timeout(Duration::from_secs(20), reinstall)
        .await
        .expect("the reinstall must settle")
        .unwrap()
        .expect("the reinstall must download, not inherit the cancellation");
    let cancelled = tokio::time::timeout(Duration::from_secs(10), first)
        .await
        .expect("the cancelled download must settle")
        .unwrap();
    assert!(cancelled.unwrap_err().to_string().contains("cancelled"));

    assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
    assert_stream_matches_get(&center, &mut rx, &mut mirror, &id, "after the race").await;
    assert_eq!(
        task_of(&center, &id).await.map(|task| task.state),
        Some(DownloadState::Completed)
    );
    assert_eq!(
        center
            .history()
            .await
            .into_iter()
            .find(|task| task.id == id)
            .map(|task| task.state),
        Some(DownloadState::Completed),
        "the stale cancellation replaced the reinstall in history"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two same-id indeterminate registrations: the older one finishing must
/// not mark the newer, still-running registration's row as finished.
#[tokio::test]
async fn an_older_same_id_registration_finishing_leaves_the_newer_row_running() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    let mut rx = center.subscribe();
    let mut mirror = HashMap::new();
    let id = "ind:row-owner";

    async fn until_label(center: &DownloadCenter, id: &str, label: &str) {
        loop {
            if task_of(center, id).await.is_some_and(|t| t.label == label) {
                return;
            }
            tokio::task::yield_now().await;
        }
    }
    let (release_first, first_held) = tokio::sync::oneshot::channel::<()>();
    let first = tokio::spawn({
        let center = center.clone();
        async move {
            center
                .register_indeterminate(id.into(), DownloadKind::Agent, "first".into(), async {
                    let _ = first_held.await;
                    Ok(1)
                })
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(10), until_label(&center, id, "first"))
        .await
        .unwrap();
    let (release_second, second_held) = tokio::sync::oneshot::channel::<()>();
    let second = tokio::spawn({
        let center = center.clone();
        async move {
            center
                .register_indeterminate(id.into(), DownloadKind::Agent, "second".into(), async {
                    let _ = second_held.await;
                    Ok(2)
                })
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(10), until_label(&center, id, "second"))
        .await
        .unwrap();

    drop(release_first);
    assert_eq!(first.await.unwrap().unwrap(), 1);
    let row = task_of(&center, id).await.unwrap();
    assert_eq!(
        (row.label.as_str(), row.state),
        ("second", DownloadState::Active),
        "the running registration's row was finished by an older one"
    );
    assert_stream_matches_get(&center, &mut rx, &mut mirror, id, "after the older finish").await;

    release_second.send(()).unwrap();
    assert_eq!(second.await.unwrap().unwrap(), 2);
    let row = task_of(&center, id).await.unwrap();
    assert_eq!(
        (row.label.as_str(), row.state),
        ("second", DownloadState::Completed)
    );
    assert_stream_matches_get(&center, &mut rx, &mut mirror, id, "after the newer finish").await;
}

/// A stream opened while commits land (the SSE routes' snapshot, then
/// deltas) must start at its snapshot: a delta the snapshot already holds
/// is never replayed after it, so a row never steps back to an older
/// state, and no commit after the snapshot is missed.
#[tokio::test]
async fn a_stream_opened_while_commits_land_never_replays_what_its_snapshot_holds() {
    ensure_host();
    let center = DownloadCenter::with_default_client();
    let id = "ind:snapshot-boundary";
    let (release_row, row_held) = tokio::sync::oneshot::channel::<()>();
    let row = tokio::spawn({
        let center = center.clone();
        async move {
            center
                .register_indeterminate(id.into(), DownloadKind::Agent, "row".into(), async {
                    let _ = row_held.await;
                    Ok(())
                })
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while task_of(&center, id).await.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let park = center.park_next_snapshot();
    let opener = tokio::spawn({
        let center = center.clone();
        async move { center.snapshot_and_subscribe().await }
    });
    reached(&park).await;
    // Two progress commits race the open.
    let mut committer = tokio::spawn({
        let center = center.clone();
        async move {
            for received in [1, 2] {
                patch(&center.inner, id, false, |task| {
                    task.received_bytes = received
                })
                .await;
            }
        }
    });
    // Let them land, unless the open holds them back until it has returned.
    let committed_during_open = tokio::time::timeout(Duration::from_millis(250), &mut committer)
        .await
        .is_ok();
    park.release.add_permits(1);
    let (snapshot, mut rx) = opener.await.unwrap();
    if !committed_during_open {
        committer.await.unwrap();
    }

    let mut mirror: HashMap<String, DownloadTask> =
        snapshot.into_iter().map(|t| (t.id.clone(), t)).collect();
    loop {
        match rx.try_recv() {
            Ok(DownloadEvent::Update { task }) => {
                let shown = mirror.get(&task.id).map_or(0, |t| t.received_bytes);
                assert!(
                    task.received_bytes > shown,
                    "a delta the snapshot already held was replayed: {} went from {shown} \
                     back to {} bytes",
                    task.id,
                    task.received_bytes
                );
                mirror.insert(task.id.clone(), task);
            }
            Ok(event) => panic!("unexpected event {event:?}"),
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(error) => panic!("the event stream broke: {error:?}"),
        }
    }
    assert_eq!(
        serde_json::to_value(mirror.get(id)).unwrap(),
        serde_json::to_value(task_of(&center, id).await).unwrap(),
        "the stream missed a commit made after its snapshot"
    );

    release_row.send(()).unwrap();
    row.await.unwrap().unwrap();
}
