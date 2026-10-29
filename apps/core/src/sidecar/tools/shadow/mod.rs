pub mod downloader;
pub mod process;

pub use downloader::ShadowDownloader;
pub use process::ShadowProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use anyhow::Context;
use ryu_sidecar_runtime::peer_proof::{self, PeerProbe, ProofCache};

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// How often the background liveness probe re-checks Shadow's HTTP port.
const LIVENESS_PROBE_INTERVAL: Duration = Duration::from_secs(5);

/// How long a successful peer proof is reused before the next request
/// re-challenges Shadow. Short, so a listener swap is noticed within seconds.
const PEER_PROOF_TTL: Duration = Duration::from_secs(2);

/// How often an unverified Shadow listener is logged from the request path.
const UNVERIFIED_WARN_INTERVAL: Duration = Duration::from_secs(60);

/// Resolve the data directory shared by Core's settings surface and the Shadow
/// process. Deployment overrides win; managed runs otherwise use the active Ryu
/// profile so dev and release state stay isolated.
pub fn data_dir() -> std::path::PathBuf {
    std::env::var_os("SHADOW_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::paths::service_dir("shadow"))
}

// ── Shadow API token ───────────────────────────────────────────────────────────
//
// Shadow's HTTP surface is bearer-gated (apps/shadow/src/server.rs): everything
// except `/health` requires a shared secret so a hostile local process or web
// page cannot read screen history or flip capture consent. The secret is a
// persisted file under the Shadow data dir; Core reads-or-creates it at spawn
// and presents it from every Shadow client.
//
// Presenting it is gated: a loopback port can be squatted by another local user
// while Shadow is down, so Core sends the token only to a listener that proved
// it already holds it (see "Verified peer" below). Every outbound Shadow call
// that carries the token goes through [`verified_api_token`].

/// Path of the persisted Shadow API token: `<data dir>/services/shadow/api-token`
/// — the same file Shadow itself resolves, because [`ShadowProcess::start`]
/// points `SHADOW_DATA_DIR` at [`data_dir`].
fn api_token_path() -> std::path::PathBuf {
    data_dir().join("api-token")
}

/// Shadow's downloaded models: `<data dir>/models/vision/shadow`. Exported to
/// Shadow as `SHADOW_MODELS_DIR`.
pub fn models_dir() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::model_family_dir(
        &crate::paths::ryu_dir(),
        ryu_sidecar_runtime::layout::Modality::Vision,
        "shadow",
    )
}

/// Read-or-create the shared-secret Shadow API token (owner-only permissions),
/// mirroring Shadow's own first-run minting so whichever side starts first wins
/// and the other reads the same value.
pub(crate) fn ensure_api_token() -> anyhow::Result<String> {
    let path = api_token_path();
    crate::atomic_file::read_or_create_secret(&path, || {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    })
    .context("persisting shadow api token")
}

/// Resolve the token Core's Shadow clients present: `SHADOW_API_TOKEN` env
/// (operator override — the spawn env in [`ShadowProcess::start`] honours the
/// same export), else the profile-aware token file (a standalone `shadow start`
/// resolves the same `services/shadow` dir, so Core adopts such servers).
/// `None` = no token found; Shadow will reject the call (fail closed).
pub fn api_token() -> Option<String> {
    if let Ok(env_token) = std::env::var("SHADOW_API_TOKEN") {
        let trimmed = env_token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    let existing = std::fs::read_to_string(api_token_path()).ok()?;
    let trimmed = existing.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// The token file [`api_token`] reads, or `None` when an operator-exported
/// `SHADOW_API_TOKEN` takes precedence over it. Handed to the clips and
/// meetings sidecars (`SHADOW_API_TOKEN_FILE`) so they read the current token
/// on every call: [`rotate_api_token`] can replace it after they were spawned.
pub(crate) fn api_token_file() -> Option<std::path::PathBuf> {
    let overridden = std::env::var("SHADOW_API_TOKEN").is_ok_and(|token| !token.trim().is_empty());
    (!overridden).then(api_token_path)
}

/// Replace the persisted token with a fresh one. Called when an unverified
/// listener is found on Shadow's port: it may have collected the old token from
/// an earlier Core that did not verify peers. An operator-exported
/// `SHADOW_API_TOKEN` cannot be rotated from here and is left alone (logged).
fn rotate_api_token() {
    if std::env::var("SHADOW_API_TOKEN").is_ok_and(|token| !token.trim().is_empty()) {
        tracing::warn!(
            "shadow: SHADOW_API_TOKEN is set by the operator, so Core cannot rotate it; rotate it yourself if the port squatter may have seen it"
        );
        return;
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    match crate::atomic_file::write_atomic(&api_token_path(), token.as_bytes()) {
        Ok(()) => tracing::warn!(
            "shadow: rotated the Shadow API token; the clips and meetings sidecars re-read it from the token file, and other clients that cached the old one fail Shadow's peer check until they restart"
        ),
        Err(e) => tracing::error!("shadow: could not rotate the Shadow API token: {e}"),
    }
    PEER_PROOF_CACHE.forget();
}

// ── Verified peer ──────────────────────────────────────────────────────────────
//
// A listener on Shadow's port is trusted with the token only when it is:
//
// - **Proven**: it answered a fresh `/health?challenge=` with
//   `HMAC-SHA256(token, …)` (`ryu_sidecar_runtime::peer_proof`). This covers a
//   Shadow Core spawned, a dev `shadow start`, and an orphan from an earlier
//   Core, because each one holds the same token.
// - **The spawned child**: the Shadow this Core spawned is alive and owns the
//   listener socket (by PID, through `/proc` or `lsof`). This keeps a Shadow
//   binary that predates the challenge working. It applies only when the peer
//   gave no proof at all; a wrong proof is never trusted.
//
// Anything else answering on the port is unverified: Core does not adopt it,
// does not send it the token (or any proxied request), and reports the port
// conflict from `start`.

/// Recent successful proofs, shared by every Core Shadow client.
static PEER_PROOF_CACHE: ProofCache = ProofCache::new(PEER_PROOF_TTL);

/// The Shadow child this Core spawned, if any, for the legacy-binary path.
static SPAWNED_SHADOW: Mutex<Option<SpawnedShadow>> = Mutex::new(None);

/// When the request path last logged an unverified listener.
static LAST_UNVERIFIED_WARNING: Mutex<Option<Instant>> = Mutex::new(None);

struct SpawnedShadow {
    port: u16,
    process: Weak<Mutex<Option<ShadowProcess>>>,
}

/// Who is answering on Shadow's port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShadowPeer {
    /// Proved it holds the token.
    Proven,
    /// The live Shadow this Core spawned owns the listener (legacy binary that
    /// gives no proof).
    SpawnedChild,
    /// Something answers `/health`, but it did not prove it is Shadow.
    Unverified(&'static str),
    /// Nothing healthy answers.
    Absent,
}

impl ShadowPeer {
    fn is_trusted(self) -> bool {
        matches!(self, Self::Proven | Self::SpawnedChild)
    }
}

/// Short-timeout, no-redirect client for peer probes, so a hostile listener
/// can neither stall the request path nor bounce the probe elsewhere.
fn peer_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("ryu-core/0.1")
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn local_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Record the child this manager just spawned on `port`.
fn register_spawned(port: u16, process: &Arc<Mutex<Option<ShadowProcess>>>) {
    *SPAWNED_SHADOW
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(SpawnedShadow {
        port,
        process: Arc::downgrade(process),
    });
}

/// Forget the spawned child registered for `process`.
fn unregister_spawned(process: &Arc<Mutex<Option<ShadowProcess>>>) {
    let mut guard = SPAWNED_SHADOW
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard
        .as_ref()
        .is_some_and(|spawned| spawned.process.as_ptr() == Arc::as_ptr(process))
    {
        *guard = None;
    }
}

/// The port of `base_url` when it is plain HTTP to exactly `127.0.0.1`.
///
/// The spawned-child exemption rests on [`process::loopback_listener_owned_by`],
/// which sees only IPv4 listeners that accept `127.0.0.1:<port>`. A name such
/// as `localhost` may resolve to `::1`, and another loopback address such as
/// `127.0.0.2` or `[::1]` is a different socket. Another local process can
/// listen there while the child owns `127.0.0.1`, so those never qualify.
fn loopback_port(base_url: &str) -> Option<u16> {
    let url = url::Url::parse(base_url).ok()?;
    let exact = matches!(url.host()?, url::Host::Ipv4(ip) if ip == std::net::Ipv4Addr::LOCALHOST);
    (exact && url.scheme() == "http").then(|| url.port_or_known_default())?
}

/// Whether the live Shadow child this Core spawned owns the listener behind
/// `base_url`.
async fn spawned_child_serves(base_url: &str) -> bool {
    let Some(port) = loopback_port(base_url) else {
        return false;
    };
    let live_pid = || {
        let process = SPAWNED_SHADOW
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|spawned| spawned.port == port)
            .and_then(|spawned| spawned.process.upgrade())?;
        let mut guard = process
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.as_mut().and_then(ShadowProcess::pid)
    };
    let Some(pid) = live_pid() else {
        return false;
    };
    // Re-check after the ownership lookup: the child must still be the same
    // live process, or a replacement listener could inherit its trust.
    process::loopback_listener_owned_by(pid, port).await && live_pid() == Some(pid)
}

/// Classify the listener at `base_url`. Never sends the token.
pub(crate) async fn check_peer(
    client: &reqwest::Client,
    base_url: &str,
    token: Option<&str>,
) -> ShadowPeer {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        // Without a token nothing can be proven, so nothing is trusted.
        let health = format!("{}/health", base_url.trim_end_matches('/'));
        let reachable = client
            .get(health)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        return if reachable {
            ShadowPeer::Unverified("could not be challenged because no Shadow API token exists")
        } else {
            ShadowPeer::Absent
        };
    };
    match peer_proof::probe(client, base_url, token).await {
        PeerProbe::Proven => ShadowPeer::Proven,
        PeerProbe::Unreachable => ShadowPeer::Absent,
        PeerProbe::WrongProof => {
            ShadowPeer::Unverified("answered the peer challenge with a wrong proof")
        }
        PeerProbe::NoProof if spawned_child_serves(base_url).await => ShadowPeer::SpawnedChild,
        PeerProbe::NoProof => ShadowPeer::Unverified("did not answer the peer challenge"),
    }
}

/// The Shadow API token, released only when the listener at [`base_url`] is a
/// verified Shadow (see "Verified peer"). Every Core call that sends Shadow the
/// bearer goes through this. `None` means: send nothing to Shadow at all,
/// because there is no token or the listener did not prove it is Shadow.
pub async fn verified_api_token() -> Option<String> {
    let token = api_token()?;
    let base = base_url();
    if PEER_PROOF_CACHE.is_fresh(&base, &token) {
        return Some(token);
    }
    match check_peer(peer_client(), &base, Some(&token)).await {
        ShadowPeer::Proven => {
            PEER_PROOF_CACHE.remember(&base, &token);
            Some(token)
        }
        ShadowPeer::SpawnedChild => Some(token),
        ShadowPeer::Unverified(reason) => {
            PEER_PROOF_CACHE.forget();
            warn_unverified(&base, reason);
            None
        }
        ShadowPeer::Absent => {
            PEER_PROOF_CACHE.forget();
            None
        }
    }
}

fn warn_unverified(base: &str, reason: &str) {
    let mut last = LAST_UNVERIFIED_WARNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if last.is_some_and(|at| at.elapsed() < UNVERIFIED_WARN_INTERVAL) {
        return;
    }
    *last = Some(Instant::now());
    tracing::warn!(
        "shadow: the listener at {base} {reason}; withholding the Shadow API token and requests"
    );
}

/// Resolve the Shadow base URL: `RYU_SHADOW_URL` if set, else the profile-aware
/// default (`127.0.0.1:3030` on release, `:4030` on dev, …) matching the port the
/// [`ShadowProcess`] spawns on. `profile::apply_env_defaults` also seeds
/// `RYU_SHADOW_URL` under a non-release profile, so this fallback and the env
/// resolve to the same port either way. Used by the `/api/shadow/*` proxy (the
/// bridge the declarative `shadow` plugin tools reach Shadow through).
///
/// A `localhost` host is pinned to `127.0.0.1` (see
/// [`peer_proof::pin_localhost`]), so the peer probe and the request that
/// follows it reach the one address Shadow binds.
pub fn base_url() -> String {
    let base = std::env::var("RYU_SHADOW_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", crate::profile::port(3030)));
    pin_localhost_base(base)
}

/// `base` with a `localhost` host replaced by `127.0.0.1`; any other URL is
/// returned unchanged.
fn pin_localhost_base(base: String) -> String {
    let Ok(mut url) = reqwest::Url::parse(&base) else {
        return base;
    };
    if !peer_proof::pin_localhost(&mut url) {
        return base;
    }
    let pinned = String::from(url);
    if base.ends_with('/') {
        pinned
    } else {
        pinned.trim_end_matches('/').to_owned()
    }
}

/// Lifecycle manager for the Shadow sidecar process.
///
/// Shadow's liveness is reported from **reachability of its HTTP port**, not
/// merely from process ownership. Shadow is opt-in (not in `startup_order`) and
/// is frequently started outside this Core process — by `bun run dev`
/// (`shadow start`), or as an orphan that survives a Core restart
/// (`ShadowProcess` uses `kill_on_drop(false)`). In both cases the managed
/// `child` is `None`, so an ownership-only `is_running()` would report "stopped"
/// while Shadow happily answers on `:3030`. A background probe keeps
/// `external_alive` in sync with the real port so `/api/sidecar/status` — and
/// every client that reads it (desktop Apps page, island, CLI) — tells the truth.
pub struct ShadowManager {
    process: Arc<Mutex<Option<ShadowProcess>>>,
    /// `true` when a Shadow server was already answering on the port when we
    /// tried to start it (adopted external). We did not spawn it, so `stop`
    /// asks it to exit over HTTP rather than killing a process we don't own.
    adopted_external: Arc<AtomicBool>,
    /// Cached reachability of Shadow's HTTP port, refreshed by a background
    /// probe. This is the source of truth for `is_running()` regardless of who
    /// spawned Shadow.
    external_alive: Arc<AtomicBool>,
    /// Ensures the background liveness probe is spawned at most once.
    probe_started: Arc<AtomicBool>,
    client: reqwest::Client,
    port: u16,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl ShadowManager {
    pub fn new() -> Self {
        let manager = Self {
            process: Arc::new(Mutex::new(None)),
            adopted_external: Arc::new(AtomicBool::new(false)),
            external_alive: Arc::new(AtomicBool::new(false)),
            probe_started: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client"),
            // Profile-aware Shadow port (release 3030, dev 4030, …). Every Shadow
            // CLIENT (`server/clips`, `sidecar/mcp/shadow`, `meetings`) dials the
            // same port via the `RYU_SHADOW_URL` env default that
            // `profile::apply_env_defaults` seeds, so spawn and clients agree.
            port: crate::profile::port(3030),
            downloads: None,
        };
        manager.ensure_liveness_probe();
        manager
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn health_url(&self) -> String {
        format!("http://127.0.0.1:{}/health", self.port)
    }

    /// Returns `true` if Shadow is answering a successful `/health` on its port.
    async fn server_reachable(client: &reqwest::Client, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{port}/health");
        client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// The `sealing` field of a reachable Shadow's `/health` (`ok`, `no-key`,
    /// `mismatch`), or `None` when it does not answer or predates sealing.
    async fn sealing_state(client: &reqwest::Client, port: u16) -> Option<String> {
        let url = format!("http://127.0.0.1:{port}/health");
        let response = client.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: serde_json::Value = response.json().await.ok()?;
        sealing_of(&body)
    }

    /// Ask a Shadow Core did not start to exit (bearer-gated `/stop`) and wait
    /// up to `wait` for its port to close. Returns whether it closed. Sends the
    /// bearer, so call it only for a peer [`check_peer`] trusts.
    async fn stop_external(client: &reqwest::Client, port: u16, wait: Duration) -> bool {
        let mut request = client.get(format!("http://127.0.0.1:{port}/stop"));
        if let Some(token) = api_token() {
            request = request.bearer_auth(token);
        }
        if let Err(error) = request.send().await {
            tracing::warn!("shadow: stop request to the external server failed: {error}");
        }
        let deadline = tokio::time::Instant::now() + wait;
        while tokio::time::Instant::now() < deadline {
            if !Self::server_reachable(client, port).await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        !Self::server_reachable(client, port).await
    }

    /// Spawn the background liveness probe once. Requires a Tokio runtime; in
    /// non-async contexts (e.g. unit tests constructing the manager) this is a
    /// no-op and `external_alive` stays `false`, preserving ownership-only
    /// behaviour there. Only a verified Shadow counts as alive, so a squatter on
    /// the port never shows up as "running".
    fn ensure_liveness_probe(&self) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        if self.probe_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        tokio::spawn(async move {
            loop {
                let token = api_token();
                let peer = check_peer(&client, &local_base_url(port), token.as_deref()).await;
                alive.store(peer.is_trusted(), Ordering::Relaxed);
                tokio::time::sleep(LIVENESS_PROBE_INTERVAL).await;
            }
        });
    }
}

/// Whether anything accepts TCP connections on `127.0.0.1:<port>`.
async fn port_accepts_connections(port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|connected| connected.is_ok())
}

fn shadow_binary_path() -> std::path::PathBuf {
    let name = if cfg!(target_os = "windows") {
        "shadow.exe"
    } else {
        "shadow"
    };
    crate::paths::bin_dir().join(name)
}

/// How long a freshly spawned Shadow has to become a verified peer.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Wait until the child just spawned into `process` is a verified Shadow on
/// `port`. Fails when the child exits (typically: another process holds the
/// port) or never proves itself.
async fn wait_for_verified_child(
    client: &reqwest::Client,
    port: u16,
    process: &Arc<Mutex<Option<ShadowProcess>>>,
) -> anyhow::Result<()> {
    let base = local_base_url(port);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let last = loop {
        let alive = process
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .is_some_and(ShadowProcess::is_running);
        if !alive {
            anyhow::bail!(
                "shadow exited during startup; another process may be holding 127.0.0.1:{port}"
            );
        }
        let token = api_token();
        let peer = check_peer(client, &base, token.as_deref()).await;
        if peer == ShadowPeer::SpawnedChild {
            // A binary older than the peer challenge. Core trusts it by socket
            // ownership, but the clips and meetings sidecars accept only a
            // proof, so they cannot reach it. Keep it running for Core's own
            // calls and drop the install record so the next start downloads
            // the current binary.
            crate::sidecar::remove_from_version_store("shadow");
            tracing::warn!(
                "shadow on 127.0.0.1:{port} predates the peer challenge; Clips and Meetings cannot reach it. The Shadow binary will be re-downloaded on the next start"
            );
            return Ok(());
        }
        if peer.is_trusted() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break peer;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    match last {
        ShadowPeer::Unverified(reason) => {
            // The child is alive and answering but cannot prove it holds the
            // token: an installed binary older than the peer challenge, on a
            // platform where Core cannot check listener ownership. Drop the
            // install record so the next start downloads the current binary.
            crate::sidecar::remove_from_version_store("shadow");
            anyhow::bail!(
                "shadow on 127.0.0.1:{port} {reason}; Core will not send it the API token. The Shadow binary will be re-downloaded on the next start"
            )
        }
        _ => anyhow::bail!("shadow did not start within {}s", STARTUP_TIMEOUT.as_secs()),
    }
}

impl Default for ShadowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ShadowManager {
    fn name(&self) -> &'static str {
        "shadow"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        self.ensure_liveness_probe();
        let process = Arc::clone(&self.process);
        let adopted_external = Arc::clone(&self.adopted_external);
        let external_alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let binary_path = shadow_binary_path();
            // Adopt an already-running Shadow server (e.g. started by `bun run
            // dev`, or an orphan surviving a Core restart) instead of spawning a
            // competing process that would fail to bind the port — but only
            // once it proved it holds the token. A bare `/health` 200 is not
            // evidence: anyone can bind the port and answer it.
            let token = api_token().or_else(|| ensure_api_token().ok());
            match check_peer(&client, &local_base_url(port), token.as_deref()).await {
                peer if peer.is_trusted() => {
                    // Only a Shadow that seals what it captures is adopted
                    // (`sealing: ok` in its health). One without a key (or an
                    // older build) would refuse capture or write plaintext, so
                    // Core asks it to exit and restarts Shadow itself,
                    // delivering Shadow's key.
                    let sealing = Self::sealing_state(&client, port).await;
                    if adoptable(sealing.as_deref()) {
                        adopted_external.store(true, Ordering::Relaxed);
                        external_alive.store(true, Ordering::Relaxed);
                        tracing::info!(
                            "shadow already running on 127.0.0.1:{port} and verified — adopting existing server"
                        );
                        return Ok(());
                    }
                    tracing::warn!(
                        sealing = sealing.as_deref().unwrap_or("unknown"),
                        "shadow on 127.0.0.1:{port} does not seal its capture; restarting it under Core"
                    );
                    if !Self::stop_external(&client, port, Duration::from_secs(10)).await {
                        anyhow::bail!(
                            "a Shadow server that does not seal its capture (sealing: {}) is running on \
                             port {port} and did not stop; quit it so Ryu can restart Shadow with \
                             encryption",
                            sealing.as_deref().unwrap_or("unknown")
                        );
                    }
                    PEER_PROOF_CACHE.forget();
                }
                ShadowPeer::Unverified(reason) => {
                    // An orphan from an earlier Core may be an old Shadow that
                    // gives no proof. Reap it through the PID file (identity
                    // checked), then look at the port again.
                    ShadowProcess::new(binary_path.clone(), port)
                        .cleanup_orphan()
                        .await;
                    if port_accepts_connections(port).await {
                        adopted_external.store(false, Ordering::Relaxed);
                        external_alive.store(false, Ordering::Relaxed);
                        tracing::warn!(
                            "shadow: 127.0.0.1:{port} is held by a process that {reason}; not adopting it"
                        );
                        // It may have collected the token from an older Core.
                        rotate_api_token();
                        anyhow::bail!(
                            "127.0.0.1:{port} is held by a process that {reason}. Core will not adopt it or send it the Shadow API token. Stop that process, then start Shadow again"
                        );
                    }
                }
                _ => {}
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Download binary if not already installed.
            let downloads = downloads.expect("shadow manager: download center not wired (main.rs)");
            ShadowDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing shadow binary")?;

            // Ensure the shadow working directory exists.
            let shadow_dir = data_dir();
            tokio::fs::create_dir_all(&shadow_dir)
                .await
                .context("creating the Shadow data dir")?;

            tracing::info!("shadow sidecar starting");
            let mut proc = ShadowProcess::new(binary_path, port);
            proc.start().await.context("spawning shadow process")?;
            *process
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(proc);
            register_spawned(port, &process);

            // Wait for the child to answer as a verified Shadow (timeout 30 s).
            if let Err(error) = wait_for_verified_child(&client, port, &process).await {
                unregister_spawned(&process);
                let failed = process
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some(mut failed) = failed {
                    let _ = failed.stop().await;
                }
                return Err(error);
            }

            external_alive.store(true, Ordering::Relaxed);
            tracing::info!("shadow sidecar started on port {}", port);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let adopted_external = Arc::clone(&self.adopted_external);
        let external_alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            // Take the process out to avoid holding the mutex across awaits.
            let proc = process
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(mut p) = proc {
                // We spawned it — kill the process we own.
                unregister_spawned(&process);
                if let Err(e) = p.stop().await {
                    tracing::warn!("shadow stop error: {e}");
                }
            } else {
                // We don't own the process (adopted, dev-started, or orphaned).
                // Ask it to exit over Shadow's bearer-gated `/stop` rather than
                // killing a stranger PID, and only once it proved it holds the
                // token: an unverified listener gets neither the token nor the
                // request.
                adopted_external.store(false, Ordering::Relaxed);
                let token = api_token();
                match check_peer(&client, &local_base_url(port), token.as_deref()).await {
                    ShadowPeer::Proven => {
                        if let Some(token) = token {
                            let url = format!("http://127.0.0.1:{port}/stop");
                            if let Err(e) = client.get(&url).bearer_auth(token).send().await {
                                tracing::warn!("shadow external stop request failed: {e}");
                            }
                        }
                    }
                    ShadowPeer::Unverified(reason) => {
                        tracing::warn!("shadow: not asking 127.0.0.1:{port} to stop: it {reason}")
                    }
                    ShadowPeer::SpawnedChild | ShadowPeer::Absent => {}
                }
            }
            PEER_PROOF_CACHE.forget();
            // Reflect the stop immediately; the liveness probe will reconcile.
            external_alive.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            let token = api_token();
            match check_peer(&client, &local_base_url(port), token.as_deref()).await {
                ShadowPeer::Proven | ShadowPeer::SpawnedChild => {
                    match Self::sealing_state(&client, port).await.as_deref() {
                        Some("ok") => HealthStatus::Healthy,
                        Some(state) => HealthStatus::Degraded(format!(
                            "capture writes refused (sealing: {state})"
                        )),
                        None => HealthStatus::Degraded(
                            "this Shadow build does not report sealing; update Shadow".into(),
                        ),
                    }
                }
                ShadowPeer::Unverified(reason) => HealthStatus::Unhealthy(format!(
                    "127.0.0.1:{port} is held by a process that {reason}"
                )),
                ShadowPeer::Absent => {
                    HealthStatus::Unhealthy(format!("shadow is not answering on 127.0.0.1:{port}"))
                }
            }
        })
    }

    fn is_running(&self) -> bool {
        // Lazily ensure the liveness probe is running (covers managers built
        // before a Tokio runtime existed, then queried under one).
        self.ensure_liveness_probe();
        let owned = {
            let mut guard = self.process.lock().unwrap();
            guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
        };
        // Liveness reflects reality: Shadow is "running" if we own a live child
        // OR the port is reachable (dev-started, adopted, or orphaned instance).
        owned || self.external_alive.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("shadow").await;
            crate::sidecar::remove_from_version_store("shadow");

            if delete_data {
                // Remove Shadow's data (services/shadow) and its models.
                crate::sidecar::remove_dir(&data_dir()).await;
                crate::sidecar::remove_dir(&models_dir()).await;
            }

            tracing::info!("shadow uninstalled");
            Ok(())
        })
    }
}

/// The `sealing` field of a Shadow `/health` body.
fn sealing_of(body: &serde_json::Value) -> Option<String> {
    body.get("sealing")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

/// Whether Core may adopt an externally started Shadow: only one that reports
/// `sealing: ok`.
fn adoptable(sealing: Option<&str>) -> bool {
    sealing == Some("ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_sealing_shadow_is_adopted() {
        assert!(adoptable(Some("ok")));
        assert!(!adoptable(Some("no-key")));
        assert!(!adoptable(Some("mismatch")));
        assert!(!adoptable(None));
        assert_eq!(
            sealing_of(&serde_json::json!({"status": "healthy", "sealing": "no-key"})).as_deref(),
            Some("no-key")
        );
        assert_eq!(sealing_of(&serde_json::json!({"status": "healthy"})), None);
    }

    #[tokio::test]
    async fn sealing_state_reads_the_health_body() {
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/health",
            get(|| async {
                axum::Json(serde_json::json!({"status": "healthy", "sealing": "no-key"}))
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        assert_eq!(
            ShadowManager::sealing_state(&client, port).await.as_deref(),
            Some("no-key")
        );
        server.abort();
    }

    // Serializes SHADOW_API_TOKEN mutation so the get/restore never races a parallel
    // test that reads the same global (poison-tolerant).
    static SHADOW_TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_token() -> std::sync::MutexGuard<'static, ()> {
        SHADOW_TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn api_token_prefers_env_and_trims() {
        // The env branch returns BEFORE any file read, so it is deterministic regardless
        // of whatever token files happen to exist on the host.
        let _lock = lock_token();
        let prev = std::env::var("SHADOW_API_TOKEN").ok();
        std::env::set_var("SHADOW_API_TOKEN", "  secret-bearer  ");
        assert_eq!(api_token().as_deref(), Some("secret-bearer"));
        match prev {
            Some(v) => std::env::set_var("SHADOW_API_TOKEN", v),
            None => std::env::remove_var("SHADOW_API_TOKEN"),
        }
    }

    #[test]
    fn api_token_path_lives_under_ryu_shadow() {
        let p = api_token_path();
        assert!(p.ends_with("api-token"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "shadow");
    }

    #[test]
    fn health_url_and_port_are_loopback() {
        // Construct with an explicit port (no liveness probe in a sync test → no-op).
        let mgr = ShadowManager::new().with_port(4030);
        assert_eq!(mgr.health_url(), "http://127.0.0.1:4030/health");
        assert_eq!(mgr.name(), "shadow");
        assert!(!mgr.is_required());
    }

    /// How a fake Shadow answers `/health?challenge=`.
    #[derive(Clone, Copy)]
    enum FakeHealth {
        /// A plain `/health` 200 with no proof (an impostor, or an old Shadow).
        NoProof,
        /// A correct proof for this token (the real Shadow).
        Proves(&'static str),
        /// A proof made with some other token.
        WrongProof,
    }

    struct FakeShadow {
        port: u16,
        /// Every `Authorization` header the fake received, on any route.
        authorizations: Arc<Mutex<Vec<String>>>,
        /// How many `/stop` requests reached it.
        stops: Arc<std::sync::atomic::AtomicUsize>,
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
        server: Option<tokio::task::JoinHandle<()>>,
    }

    impl FakeShadow {
        async fn spawn(health: FakeHealth) -> Self {
            use axum::extract::Query;
            use axum::http::HeaderMap;
            use axum::routing::get;
            use axum::{Json, Router};
            use std::collections::HashMap;

            let authorizations = Arc::new(Mutex::new(Vec::new()));
            let stops = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let record = {
                let authorizations = Arc::clone(&authorizations);
                move |headers: &HeaderMap| {
                    if let Some(value) = headers.get(reqwest::header::AUTHORIZATION) {
                        authorizations
                            .lock()
                            .unwrap()
                            .push(value.to_str().unwrap_or_default().to_owned());
                    }
                }
            };
            let health_record = record.clone();
            let stop_record = record;
            let stop_count = Arc::clone(&stops);
            let app = Router::new()
                .route(
                    "/health",
                    get(
                        move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                            health_record(&headers);
                            let challenge = query.get("challenge").cloned().unwrap_or_default();
                            let proof = match health {
                                FakeHealth::NoProof => None,
                                FakeHealth::Proves(token) => peer_proof::proof(token, &challenge),
                                FakeHealth::WrongProof => {
                                    peer_proof::proof("not-the-token", &challenge)
                                }
                            };
                            async move {
                                // `start` adopts only a Shadow that reports it seals its capture.
                                let mut body =
                                    serde_json::json!({ "status": "healthy", "sealing": "ok" });
                                if let Some(proof) = proof {
                                    body["proof"] = proof.into();
                                }
                                Json(body)
                            }
                        },
                    ),
                )
                .route(
                    "/stop",
                    get(move |headers: HeaderMap| {
                        stop_record(&headers);
                        stop_count.fetch_add(1, Ordering::SeqCst);
                        async { "stopping" }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = rx.await;
                    })
                    .await
                    .unwrap();
            });
            Self {
                port,
                authorizations,
                stops,
                shutdown: Some(tx),
                server: Some(server),
            }
        }

        fn base(&self) -> String {
            local_base_url(self.port)
        }

        fn authorizations(&self) -> Vec<String> {
            self.authorizations.lock().unwrap().clone()
        }

        async fn shut_down(mut self) {
            if let Some(tx) = self.shutdown.take() {
                let _ = tx.send(());
            }
            if let Some(server) = self.server.take() {
                let _ = server.await;
            }
        }
    }

    /// Run `body` with `SHADOW_API_TOKEN` set, restoring it afterwards. Holds
    /// the env lock across the body on purpose: the variable is process-global.
    #[allow(clippy::await_holding_lock)]
    async fn with_env_token<F: std::future::Future<Output = ()>>(token: &str, body: F) {
        let _lock = lock_token();
        let prev = std::env::var("SHADOW_API_TOKEN").ok();
        std::env::set_var("SHADOW_API_TOKEN", token);
        body.await;
        match prev {
            Some(v) => std::env::set_var("SHADOW_API_TOKEN", v),
            None => std::env::remove_var("SHADOW_API_TOKEN"),
        }
    }

    #[tokio::test]
    async fn a_listener_that_cannot_prove_the_token_is_never_trusted() {
        let client = reqwest::Client::new();
        for health in [FakeHealth::NoProof, FakeHealth::WrongProof] {
            let fake = FakeShadow::spawn(health).await;
            let peer = check_peer(&client, &fake.base(), Some("the-token")).await;
            assert!(matches!(peer, ShadowPeer::Unverified(_)), "{peer:?}");
            // Without a token there is nothing to prove, so nothing is trusted.
            let peer = check_peer(&client, &fake.base(), None).await;
            assert!(matches!(peer, ShadowPeer::Unverified(_)), "{peer:?}");
            assert!(fake.authorizations().is_empty());
            fake.shut_down().await;
        }
    }

    #[tokio::test]
    async fn a_listener_that_proves_the_token_is_trusted() {
        let client = reqwest::Client::new();
        let fake = FakeShadow::spawn(FakeHealth::Proves("the-token")).await;
        assert_eq!(
            check_peer(&client, &fake.base(), Some("the-token")).await,
            ShadowPeer::Proven
        );
        // Proving a different token is a wrong proof for ours.
        assert!(matches!(
            check_peer(&client, &fake.base(), Some("another-token")).await,
            ShadowPeer::Unverified(_)
        ));
        // The probe itself never carries the bearer.
        assert!(fake.authorizations().is_empty());
        let base = fake.base();
        fake.shut_down().await;
        assert_eq!(
            check_peer(&client, &base, Some("the-token")).await,
            ShadowPeer::Absent
        );
    }

    #[tokio::test]
    async fn stop_never_sends_the_token_to_an_unverified_listener() {
        let fake = FakeShadow::spawn(FakeHealth::NoProof).await;
        let port = fake.port;
        with_env_token("g3-impostor-token", async {
            let manager = ShadowManager::new().with_port(port);
            manager.stop().await.unwrap();
            assert!(!manager.external_alive.load(Ordering::Relaxed));
        })
        .await;
        assert_eq!(fake.stops.load(Ordering::SeqCst), 0);
        assert!(fake.authorizations().is_empty());
        fake.shut_down().await;
    }

    #[tokio::test]
    async fn stop_asks_a_verified_shadow_to_exit_with_the_bearer() {
        let fake = FakeShadow::spawn(FakeHealth::Proves("g3-real-token")).await;
        let port = fake.port;
        with_env_token("g3-real-token", async {
            ShadowManager::new().with_port(port).stop().await.unwrap();
        })
        .await;
        assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            fake.authorizations(),
            vec!["Bearer g3-real-token".to_owned()]
        );
        fake.shut_down().await;
    }

    #[tokio::test]
    async fn start_refuses_to_adopt_an_unverified_listener() {
        let fake = FakeShadow::spawn(FakeHealth::NoProof).await;
        let port = fake.port;
        with_env_token("g3-impostor-token", async {
            let manager = ShadowManager::new().with_port(port);
            let error = manager.start().await.expect_err("must not adopt");
            assert!(
                error.to_string().contains("will not adopt"),
                "unexpected error: {error:#}"
            );
            assert!(!manager.adopted_external.load(Ordering::Relaxed));
            assert!(!manager.external_alive.load(Ordering::Relaxed));
            assert!(matches!(
                manager.health_check().await,
                HealthStatus::Unhealthy(_)
            ));
        })
        .await;
        assert!(fake.authorizations().is_empty());
        fake.shut_down().await;
    }

    #[tokio::test]
    async fn start_adopts_a_verified_shadow_without_spawning() {
        let fake = FakeShadow::spawn(FakeHealth::Proves("g3-adopt-token")).await;
        let port = fake.port;
        with_env_token("g3-adopt-token", async {
            // No download center is wired: reaching the spawn path would panic,
            // so success proves the verified server was adopted.
            let manager = ShadowManager::new().with_port(port);
            manager.start().await.unwrap();
            assert!(manager.adopted_external.load(Ordering::Relaxed));
            assert!(manager.is_running());
            assert!(matches!(
                manager.health_check().await,
                HealthStatus::Healthy
            ));
        })
        .await;
        assert!(fake.authorizations().is_empty());
        fake.shut_down().await;
    }

    #[tokio::test]
    async fn no_proof_is_not_trusted_without_a_live_spawned_child() {
        // The legacy-binary path needs the live child this Core spawned to own
        // the listener; a registration whose process is gone grants nothing.
        let fake = FakeShadow::spawn(FakeHealth::NoProof).await;
        let gone: Arc<Mutex<Option<ShadowProcess>>> = Arc::new(Mutex::new(None));
        register_spawned(fake.port, &gone);
        assert!(!spawned_child_serves(&fake.base()).await);
        let client = reqwest::Client::new();
        assert!(matches!(
            check_peer(&client, &fake.base(), Some("t")).await,
            ShadowPeer::Unverified(_)
        ));
        unregister_spawned(&gone);
        fake.shut_down().await;
    }

    #[test]
    fn loopback_port_accepts_only_plain_http_loopback_urls() {
        assert_eq!(loopback_port("http://127.0.0.1:3030"), Some(3030));
        assert_eq!(loopback_port("http://127.0.0.1:4030/"), Some(4030));
        // Names and other loopback addresses can reach a socket the listener
        // ownership check does not see.
        assert_eq!(loopback_port("http://localhost:4030/"), None);
        assert_eq!(loopback_port("http://[::1]:3030"), None);
        assert_eq!(loopback_port("http://127.0.0.2:3030"), None);
        assert_eq!(loopback_port("http://10.0.0.2:3030"), None);
        assert_eq!(loopback_port("https://127.0.0.1:3030"), None);
        assert_eq!(loopback_port("not a url"), None);
    }

    #[test]
    fn base_url_pins_localhost_to_the_address_shadow_binds() {
        assert_eq!(
            pin_localhost_base("http://localhost:4030".to_owned()),
            "http://127.0.0.1:4030"
        );
        assert_eq!(
            pin_localhost_base("http://localhost:4030/".to_owned()),
            "http://127.0.0.1:4030/"
        );
        assert_eq!(
            pin_localhost_base("http://127.0.0.1:3030".to_owned()),
            "http://127.0.0.1:3030"
        );
        assert_eq!(
            pin_localhost_base("http://[::1]:3030".to_owned()),
            "http://[::1]:3030"
        );
        assert_eq!(pin_localhost_base("not a url".to_owned()), "not a url");
    }
}
