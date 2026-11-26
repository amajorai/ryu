//! Whole transfers against a loopback origin, with caps of a few kilobytes: the
//! cap at the announced size and at the streamed count, the pin rule, the
//! checksum before the install, the free-space check, and what is left on disk
//! after each refusal. Nothing here downloads from the network.
//!
//! The transfers need a `DownloadsHost`, and the global slot keeps the first
//! one installed. In the shared test process that would take the slot from
//! `center::tests`, whose assertions read their own host. So the transfers are
//! ignored fixtures, and one test runs them in a fresh process (the pattern of
//! `settings_persistence_refusal_retry_and_reopen`).

use super::tests::{scratch_dir, set_limits, spec};
use super::*;

/// Names the folder the fixtures may write to. Set only by the parent test.
const ROOT_ENV: &str = "RYU_DOWNLOADS_CAP_FIXTURE_ROOT";
const FIXTURES: &str = "center::stream::cap::transfer_test::fixture_";
const FIXTURE_COUNT: usize = 7;

#[test]
fn transfers_obey_their_cap_in_a_fresh_process() {
    let root = scratch_dir("transfers");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([FIXTURES, "--ignored", "--nocapture", "--test-threads=1"])
        .env(ROOT_ENV, &root)
        .env_remove("RYU_DOWNLOADS_FILE")
        .env_remove("RYU_DOWNLOADS_HISTORY_FILE")
        .env_remove("RYU_DOWNLOADS_SETTINGS_FILE")
        .env_remove("RYU_MAX_CONCURRENT_DOWNLOADS")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&root);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "transfer fixtures failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains(&format!("{FIXTURE_COUNT} passed; 0 failed")),
        "expected {FIXTURE_COUNT} fixtures to run:\n{stdout}"
    );
}

struct FixtureHost {
    dir: PathBuf,
}

impl crate::DownloadsHost for FixtureHost {
    fn ryu_dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn installed_checksum(&self, _store_key: &str) -> Option<String> {
        None
    }
    fn record_version(&self, _store_key: &str, _version: &str, _checksum: &str) {}
    fn authorize(&self, _url: &str, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
    }
}

/// Install the fixture host and return this fixture's own folder.
fn fixture_dir(name: &str) -> PathBuf {
    let root = PathBuf::from(
        std::env::var_os(ROOT_ENV)
            .expect("run through transfers_obey_their_cap_in_a_fresh_process"),
    );
    crate::set_global_host(Arc::new(FixtureHost {
        dir: root.join("host"),
    }));
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A loopback origin serving `body` at `/file`. With `announce` the response
/// carries a Content-Length. Without it the body is streamed in chunks, so its
/// size is unknown until it ends. A `Range` header is ignored.
async fn origin(body: Vec<u8>, announce: bool) -> String {
    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;

    let app = Router::new().route(
        "/file",
        get(move || {
            let body = body.clone();
            async move {
                if announce {
                    return Body::from(body);
                }
                let chunks: Vec<std::io::Result<Vec<u8>>> = body
                    .chunks(64 * 1024)
                    .map(|chunk| Ok(chunk.to_vec()))
                    .collect();
                Body::from_stream(futures_util::stream::iter(chunks))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}/file")
}

fn body_of(bytes: usize) -> Vec<u8> {
    (0u8..=250).cycle().take(bytes).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A spec for `dest` served by `url`, pinned to `pinned_to` when given.
fn spec_for(dest: &Path, url: &str, pinned_to: Option<&[u8]>) -> DownloadSpec {
    let pin = pinned_to.map(sha256_hex);
    let mut spec = spec(dest.to_path_buf(), pin.as_deref());
    spec.url = url.to_string();
    spec
}

/// Run one transfer to its end. `Err` is the text the user is shown.
async fn download(
    center: &DownloadCenter,
    spec: DownloadSpec,
) -> std::result::Result<PathBuf, String> {
    tokio::time::timeout(Duration::from_secs(60), center.download_blocking(spec))
        .await
        .expect("the transfer must reach a terminal state")
        .map_err(|error| error.to_string())
}

fn assert_nothing_on_disk(dest: &Path) {
    assert!(!dest.exists(), "nothing may be installed");
    assert!(!part_path(dest).exists(), "no .part may be left");
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_an_announced_size_over_the_cap_is_refused_before_a_byte_is_written() {
    let dir = fixture_dir("announced");
    let body = body_of(5_000);
    let url = origin(body.clone(), true).await;
    let dest = dir.join("model.gguf");
    set_limits(&dest, 1_000, 4_000);
    // A stale `.part` from an earlier pass is removed with the refusal.
    std::fs::write(part_path(&dest), b"stale").unwrap();

    let error = download(
        &DownloadCenter::with_default_client(),
        spec_for(&dest, &url, Some(&body)),
    )
    .await
    .expect_err("5000 bytes are over the 4000-byte cap");

    assert_eq!(
        error,
        "download is 5000 bytes; the transfer cap is 4000 bytes \
         for a download pinned by a SHA-256"
    );
    assert_nothing_on_disk(&dest);
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_pin_raises_the_cap_and_no_pin_keeps_the_small_one() {
    let dir = fixture_dir("pin-rule");
    let body = body_of(5_000);
    let url = origin(body.clone(), true).await;
    let center = DownloadCenter::with_default_client();

    // The image engine fault in small: a file over the plain cap, under the
    // pinned one.
    let unpinned = dir.join("unpinned.gguf");
    set_limits(&unpinned, 1_000, 8_000);
    let error = download(&center, spec_for(&unpinned, &url, None))
        .await
        .expect_err("no pin keeps the 1000-byte cap");
    assert_eq!(
        error,
        "download is 5000 bytes; the transfer cap is 1000 bytes \
         for a download with no valid SHA-256 pin"
    );
    assert_nothing_on_disk(&unpinned);

    let pinned = dir.join("pinned.gguf");
    set_limits(&pinned, 1_000, 8_000);
    let path = download(&center, spec_for(&pinned, &url, Some(&body)))
        .await
        .expect("the pin raises the cap to 8000 bytes");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert!(!part_path(&pinned).exists());
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_stream_of_unknown_size_is_cut_at_the_cap_and_its_part_removed() {
    const MIB: usize = 1024 * 1024;
    let dir = fixture_dir("streamed");
    // Over the 1 MiB write buffer, so bytes are on disk when the cap is hit.
    let body = body_of(3 * MIB);
    let url = origin(body.clone(), false).await;
    let dest = dir.join("model.gguf");
    set_limits(&dest, 1_000, 2 * MIB as u64);

    let error = download(
        &DownloadCenter::with_default_client(),
        spec_for(&dest, &url, Some(&body)),
    )
    .await
    .expect_err("3 MiB are over the 2 MiB cap");

    assert_eq!(
        error,
        "download did not end at the cap; the transfer cap is 2097152 bytes \
         for a download pinned by a SHA-256"
    );
    assert_nothing_on_disk(&dest);
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_stream_of_unknown_size_under_the_cap_installs() {
    const MIB: usize = 1024 * 1024;
    let dir = fixture_dir("streamed-ok");
    let body = body_of(MIB + MIB / 2);
    let url = origin(body.clone(), false).await;
    let dest = dir.join("model.gguf");
    set_limits(&dest, 1_000, 2 * MIB as u64);

    let path = download(
        &DownloadCenter::with_default_client(),
        spec_for(&dest, &url, Some(&body)),
    )
    .await
    .expect("1.5 MiB fit the 2 MiB cap");

    assert_eq!(
        sha256_hex(&std::fs::read(&path).unwrap()),
        sha256_hex(&body)
    );
    assert!(!part_path(&dest).exists());
}

/// Passes every install step through to the real filesystem and records it.
struct RecordingFs(std::sync::Mutex<Vec<&'static str>>);

impl RecordingFs {
    fn note(&self, step: &'static str) {
        self.0.lock().unwrap().push(step);
    }
}

impl InstallFs for RecordingFs {
    fn sync_file(&self, path: &Path) -> std::io::Result<()> {
        self.note("sync_file");
        StdInstallFs.sync_file(path)
    }
    fn hard_link(&self, original: &Path, link: &Path) -> std::io::Result<()> {
        self.note("hard_link");
        StdInstallFs.hard_link(original, link)
    }
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.note("rename");
        StdInstallFs.rename(from, to)
    }
    fn sync_dir(&self, path: &Path) -> std::io::Result<()> {
        self.note("sync_dir");
        StdInstallFs.sync_dir(path)
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        self.note("remove_file");
        StdInstallFs.remove_file(path)
    }
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_wrong_hash_is_caught_before_any_install_step_and_removes_the_part() {
    let dir = fixture_dir("wrong-hash");
    let body = body_of(5_000);
    let url = origin(body.clone(), true).await;
    let fs = Arc::new(RecordingFs(std::sync::Mutex::new(Vec::new())));
    let center = DownloadCenter::with_install_fs(crate::default_http_client(), fs.clone());

    // An update whose bytes do not match the pin: the installed file stays.
    let dest = dir.join("model.gguf");
    std::fs::write(&dest, b"previous install").unwrap();
    let other = body_of(4_999);
    let error = download(&center, spec_for(&dest, &url, Some(&other)))
        .await
        .expect_err("the served bytes do not match the pin");

    assert_eq!(
        error,
        format!(
            "checksum mismatch: expected {}, got {}",
            sha256_hex(&other),
            sha256_hex(&body)
        )
    );
    assert!(
        fs.0.lock().unwrap().is_empty(),
        "no install step may run before the checksum passes"
    );
    assert_eq!(std::fs::read(&dest).unwrap(), b"previous install");
    assert!(
        !part_path(&dest).exists(),
        "the mismatched .part is removed"
    );

    // The same center installs the same bytes once the pin matches, so the
    // empty record above is not an idle recorder.
    let good = dir.join("good.gguf");
    let path = download(&center, spec_for(&good, &url, Some(&body)))
        .await
        .expect("matching bytes install");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert!(fs.0.lock().unwrap().contains(&"rename"));
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_full_disk_refuses_a_pinned_download_before_writing() {
    let dir = fixture_dir("disk");
    let body = body_of(5_000);
    let url = origin(body.clone(), true).await;
    let dest = dir.join("model.gguf");
    // Under the pinned cap, so only the free space can refuse it.
    set_limits(&dest, 1_000, 8_000);
    let center = DownloadCenter::with_default_client()
        .with_disk_probe(|_| Some(crate::DISK_HEADROOM_BYTES + 4_999));

    let error = download(&center, spec_for(&dest, &url, Some(&body)))
        .await
        .expect_err("one byte short of the room the file needs");

    assert!(
        error.starts_with("Not enough free disk space: needs 5000 B"),
        "{error}"
    );
    assert_nothing_on_disk(&dest);
}

#[tokio::test]
#[ignore = "transfer fixture, run by transfers_obey_their_cap_in_a_fresh_process"]
async fn fixture_a_part_over_the_cap_is_refused_and_removed() {
    let dir = fixture_dir("part");
    let body = body_of(5_000);
    let url = origin(body.clone(), true).await;
    let dest = dir.join("model.gguf");
    set_limits(&dest, 1_000, 4_000);
    std::fs::write(part_path(&dest), &body).unwrap();

    let error = download(
        &DownloadCenter::with_default_client(),
        spec_for(&dest, &url, Some(&body)),
    )
    .await
    .expect_err("the .part alone is over the cap");

    assert_eq!(
        error,
        "partial download is 5000 bytes; the transfer cap is 4000 bytes \
         for a download pinned by a SHA-256"
    );
    assert_nothing_on_disk(&dest);
}
