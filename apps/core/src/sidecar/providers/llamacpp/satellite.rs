//! Lifecycle shared by the dedicated llama.cpp satellite servers: embeddings
//! (`embed.rs`), reranker (`rerank.rs`) and the classify tier (`classify.rs`).
//!
//! Each runs a second `llama-server` from the chat engine's binary on its own
//! profile-aware port, beside the chat engine. A start adopts a server already
//! answering that port rather than fighting for the bind, and *who* owns the
//! answering server decides what `stop`, `is_running` and `pid` may claim. That
//! ownership logic lives here once; each tier keeps its model, launch flags and
//! wording in its own file and describes the rest with a [`SatelliteTier`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

use super::process::{LlamaCppProcess, LlamaCppStartOptions};
use super::{process_is_running, stop_held_child, wait_for_ready, LlamaCppDownloader};
use crate::sidecar::{BoxFuture, HealthStatus};

/// What one satellite tier contributes to the shared lifecycle.
pub(super) struct SatelliteTier {
    /// Registered sidecar name (`llamacpp-embed`, …), used in lifecycle log lines.
    pub(super) name: &'static str,
    /// What log lines call the tier: the `"<kind> server"`, the `"<kind> process"`.
    pub(super) kind: &'static str,
    /// The tier's profile-aware loopback port.
    pub(super) port: fn() -> u16,
    /// Runs on both success paths of a start (adopting an answering server, and
    /// spawning one that came up).
    pub(super) on_serving: fn(),
    /// Why the tier is not up, when known; appended to the not-running health status.
    pub(super) failure_reason: fn() -> Option<String>,
}

impl SatelliteTier {
    /// Loopback `host:port` the tier binds to (profile-aware).
    fn addr(&self) -> String {
        format!("127.0.0.1:{}", (self.port)())
    }
}

/// Who owns the server that answered the port probe — the question the adopt branch
/// of a tier's `start` has to answer, and the one it used to get wrong.
///
/// Before this enum, *any* answering port was recorded as `adopted_external = true`,
/// including the server **this manager spawned itself** on an earlier start. That
/// made the next `stop` a no-op which left our own llama-server resident and
/// unstoppable — through `stop_sidecar`, `uninstall_sidecar` and the idle reaper
/// alike — and made `is_running` return `true` unconditionally instead of reflecting
/// the child we hold (for the classify tier, the desktop's "Local classifier running"
/// badge, which `deriveClassifyTierState` maps straight from `/api/sidecar/status`).
/// Our own child answering is the common case, not the rare one: `llamacpp-embed` is
/// in `startup_order` (`main.rs`), the reranker is lazy-started on every Spaces
/// search, and the classify tier on every gateway config push that selects it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReachableServer {
    /// The child this manager spawned on an earlier start is still held: we own it,
    /// so `stop` must kill it and `is_running` must report the handle's state.
    OurChild,
    /// A server this manager did not spawn — an operator's own `llama-server`, a
    /// leftover from a previous Core process, another profile pointed at this port.
    /// Hands off: we hold no `Child` for it, so we could not stop it even if we tried.
    Foreign,
}

/// One satellite's lifecycle state. Cheap to clone: a start future owns a copy.
#[derive(Clone)]
pub(super) struct Satellite {
    tier: &'static SatelliteTier,
    pub(super) running: Arc<AtomicBool>,
    pub(super) process: Arc<Mutex<Option<LlamaCppProcess>>>,
    /// `true` when the reachable server is one this manager did **not** spawn
    /// ([`ReachableServer::Foreign`]) — never merely because a server was up when we
    /// looked (our own child from an earlier start is the common case for that).
    ///
    /// It is not what *protects* a foreign process: `stop` only ever kills the
    /// [`LlamaCppProcess`] in `process`, and for a foreign server that slot is empty.
    /// Its real job is to keep `stop` from reporting a kill it did not perform, and
    /// to let [`Self::is_running`] answer for a server whose liveness we cannot see
    /// through a handle. So do not "simplify" the flag away as redundant with the
    /// empty slot — and do not treat its early return in `stop` as the safety
    /// mechanism.
    pub(super) adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456), injected at construction in `main.rs`.
    pub(super) downloads: Option<crate::downloads::DownloadCenter>,
}

impl Satellite {
    pub(super) fn new(tier: &'static SatelliteTier) -> Self {
        Self {
            tier,
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    /// The installed `llama-server`. Resolved through the shared variant
    /// resolver, so every tier always runs the SAME build as the chat engine —
    /// the binary lives inside a per-variant directory (`engines/chat/llamacpp/`)
    /// next to that backend's own `ggml-*` libraries.
    pub(super) fn binary_path() -> PathBuf {
        super::variant::server_path()
    }

    /// Classify a reachable port: is the server that answered the child we
    /// spawned, or one we do not own?
    ///
    /// The predicate is "do we hold an OS child handle" — `pid()`, which is `Some`
    /// exactly while `LlamaCppProcess::child` is `Some` (`process.rs`). We spawned that
    /// child on this very port and llama-server holds its listener for its whole life,
    /// so a held handle plus an answering port means the answer came from us.
    ///
    /// It is a *presumption*, not a proof: if our child exited and something else then
    /// bound the port, this says [`ReachableServer::OurChild`] for a server we do not
    /// own. That direction is harmless — `stop` kills the pid in the handle we hold and
    /// nothing else, so it reaps our dead child and never touches the squatter. The
    /// opposite mistake is the one that costs a resident process, which is why the
    /// predicate errs toward "ours".
    ///
    /// **Why not `LlamaCppProcess::is_running()`** (the obvious call): it is
    /// `child.is_some() && binary_path.exists()` (`process.rs`), so a llama.cpp binary
    /// deleted or moved under a running server flips it to `false` while our child is
    /// still alive and serving. That would classify our own child as
    /// [`ReachableServer::Foreign`] and leak the process on `stop` — the same
    /// unstoppable-server bug from the other direction. Ownership is about the handle,
    /// not about the binary.
    ///
    /// **Why not `Option::is_some()`**: a `LlamaCppProcess` that never spawned (or was
    /// stopped, which `take()`s the handle out) owns nothing, and `pid()` says so
    /// without assuming the slot is only ever filled by the spawn path.
    pub(super) fn reachable_server_owner(
        process: &Mutex<Option<LlamaCppProcess>>,
    ) -> ReachableServer {
        if Self::holds_own_child(process) {
            ReachableServer::OurChild
        } else {
            ReachableServer::Foreign
        }
    }

    /// Do we hold an OS child handle for a server we spawned?
    ///
    /// One predicate, two callers on purpose: [`Self::reachable_server_owner`] (who
    /// owns the answering port) and the own-child arm of [`Self::is_running`] (is the
    /// tier up). They ask the same question of the same slot, and when they were
    /// written separately they disagreed — ownership used `pid()`, liveness used
    /// `LlamaCppProcess::is_running()`, which additionally requires the llama.cpp
    /// binary to still exist on disk. The "why not" paragraphs above apply verbatim.
    ///
    /// What this does NOT claim: that the child is alive. Only a liveness check
    /// (`process_is_running`, which `start` runs before spawning) or `stop` clears
    /// the handle, so a child that exited on its own still reads `true` here until
    /// one of them runs.
    ///
    /// Scope note: the CHAT engine's `LlamaCppManager` (`llamacpp/mod.rs`) still calls
    /// `LlamaCppProcess::is_running()` for its own liveness, so the binary-existence
    /// term survives there. This is a statement about these satellites, not about the
    /// whole directory.
    fn holds_own_child(process: &Mutex<Option<LlamaCppProcess>>) -> bool {
        process
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|p| p.pid())
            .is_some()
    }

    /// Record that the port is serving, tagged with who owns the server. Pure over the
    /// two flags (no port, no process) so both arms are unit-testable.
    ///
    /// `store` rather than `fetch_or`: a manager that adopted a foreign server on an
    /// earlier start and later spawned its own child must stop claiming the server is
    /// foreign, or `stop` keeps skipping the child it now owns.
    pub(super) fn record_reachable_server(
        running: &AtomicBool,
        adopted_external: &AtomicBool,
        owner: ReachableServer,
    ) {
        adopted_external.store(owner == ReachableServer::Foreign, Ordering::Relaxed);
        running.store(true, Ordering::Relaxed);
    }

    /// `true` if a server already answers `/health` on the tier's port.
    async fn server_reachable(&self) -> bool {
        self.client
            .get(format!("http://{}/health", self.tier.addr()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// The adopt branch and live-child gate every tier's `start` opens with: `true`
    /// when a server is already up or still coming up, so there is nothing to spawn.
    ///
    /// A server answering `/health` means nothing to spawn — but WHO owns it decides
    /// what `stop`/`is_running` may do, so it is classified instead of assumed to be
    /// someone else's.
    pub(super) async fn already_up(&self) -> bool {
        let addr = self.tier.addr();
        let kind = self.tier.kind;
        if self.server_reachable().await {
            let owner = Self::reachable_server_owner(&self.process);
            Self::record_reachable_server(&self.running, &self.adopted_external, owner);
            (self.tier.on_serving)();
            match owner {
                ReachableServer::OurChild => tracing::info!(
                    "{kind} server already running on {addr} — our own child is \
                     serving it, nothing to start"
                ),
                ReachableServer::Foreign => tracing::info!(
                    "{kind} server already running on {addr} — adopting a server \
                     we did not spawn"
                ),
            }
            return true;
        }
        // Our child is alive but not answering `/health` yet: llama-server
        // returns 503 while the model loads, so this is a start already in
        // progress. Spawning again would fail to bind the port and, by replacing
        // the slot, kill the loading child. A crashed child is reaped by the
        // check and falls through to a fresh spawn.
        if process_is_running(&self.process) {
            tracing::info!("{kind} server on {addr} is still loading — our child is starting it");
            return true;
        }
        // Nothing is answering, so nothing external is being adopted. Whatever we
        // spawn next is ours to stop.
        self.adopted_external.store(false, Ordering::Relaxed);
        false
    }

    /// Ensure the llama.cpp binary is installed (shared with the chat engine).
    pub(super) async fn install_llamacpp(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> anyhow::Result<()> {
        LlamaCppDownloader::new()
            .ensure_installed(downloads)
            .await
            .with_context(|| format!("installing llama.cpp for {} server", self.tier.kind))
    }

    /// Fail unless the tier's GGUF (`model` names it in the error) is on disk, then
    /// announce the start. Onboarding (`install_local_stack`) is the single owner of
    /// model downloads, so a tier never fetches its own weights.
    pub(super) fn require_model(
        &self,
        model_path: PathBuf,
        model: &str,
    ) -> anyhow::Result<PathBuf> {
        let kind = self.tier.kind;
        if !model_path.exists() {
            anyhow::bail!(
                "{model} model not found at {} — onboarding may still be downloading it, \
                 or the download failed. The {kind} server will start once the model is \
                 present (it is fetched by default during onboarding).",
                model_path.display()
            );
        }
        tracing::info!("{kind} server will serve model: {}", model_path.display());
        tracing::info!(
            "{} sidecar starting on {}",
            self.tier.name,
            self.tier.addr()
        );
        Ok(model_path)
    }

    /// Spawn the tier's llama-server (`mode` names it in the spawn error) and wait
    /// for it to become ready.
    pub(super) async fn spawn(&self, opts: LlamaCppStartOptions, mode: &str) -> anyhow::Result<()> {
        let name = self.tier.name;
        let mut proc = LlamaCppProcess::new(Self::binary_path());
        proc.start_with(opts)
            .await
            .with_context(|| format!("spawning llama-server ({mode})"))?;
        *self.process.lock().unwrap() = Some(proc);

        // Wait for the server to become ready. Even a small GGUF takes a few seconds
        // to load, and `wait_for_ready`'s 120s ceiling keeps a cold page-cache on slow
        // disks from counting as a failure.
        // A bare TCP connect is not enough: if our child exits (bad GGUF, bind
        // failure) while another listener holds the port, the connect would succeed
        // against that listener. `wait_for_ready` requires `/health` 2xx from a child
        // that is still alive.
        let addr = self.tier.addr();
        let ready = wait_for_ready(&self.client, &self.process, (self.tier.port)(), None).await;
        if ready.is_err() {
            // A child that never became ready is useless; stop it so the next
            // start spawns afresh instead of waiting on it behind the gate above.
            stop_held_child(&self.process).await;
        }
        ready.with_context(|| format!("{name} did not become ready"))?;

        self.running.store(true, Ordering::Relaxed);
        (self.tier.on_serving)();
        tracing::info!("{name} sidecar started on {addr}");
        Ok(())
    }

    /// Stop the server we own; leave a foreign one running.
    ///
    /// The early return fires only for a server this manager did NOT spawn. It used to
    /// fire for our own child too (every adopt recorded `adopted_external = true`), so
    /// after the first repeat start this was a logged no-op and the child stayed
    /// resident through `stop_sidecar`, `uninstall_sidecar` and the idle reaper alike.
    pub(super) fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        let tier = self.tier;
        Box::pin(async move {
            running.store(false, Ordering::Relaxed);
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!(
                    "{} server was not spawned by us — leaving it running",
                    tier.kind
                );
                return Ok(());
            }
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("{} stop error: {e}", tier.name);
                }
            }
            Ok(())
        })
    }

    pub(super) fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        let tier = self.tier;
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                // Carry the tier's recorded reason when there is one, so "not
                // running" says WHY instead of only that.
                return HealthStatus::Unhealthy(match (tier.failure_reason)() {
                    Some(reason) => format!("{} process not running: {reason}", tier.kind),
                    None => format!("{} process not running", tier.kind),
                });
            }
            match client
                .get(format!("http://{}/health", tier.addr()))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    /// Whether the tier can serve, as far as this manager can tell **synchronously**
    /// (`Sidecar::is_running` is not async, so there is no `/health` probe here).
    ///
    /// Two different claims, depending on who owns the server:
    /// * a **foreign** server we adopted — `true` until `stop` clears the flag.
    ///   Unverifiable by construction: we hold no handle and cannot probe, so this is
    ///   the adoption decision being remembered, not a liveness check; it can outlive
    ///   the actual process.
    /// * **our own child** (or nothing) — whether we hold the handle
    ///   ([`Self::holds_own_child`]). Before the ownership fix a repeat start put our
    ///   own child in the first arm, so this returned `true` forever regardless of the
    ///   child's fate.
    ///
    /// The own-child arm asks [`Self::holds_own_child`], **not**
    /// `LlamaCppProcess::is_running()`, which is `child.is_some() &&
    /// binary_path.exists()` (`process.rs`). The binary-existence term does not belong
    /// in a liveness predicate, and the way it goes wrong was traced rather than
    /// imagined: `LlamaCppManager::uninstall` (the CHAT engine, `llamacpp/mod.rs`)
    /// removes `engines/chat/llamacpp/`, which deletes the very path
    /// [`Self::binary_path`] points at. Each satellite's own `uninstall` deliberately
    /// leaves that file alone because it is *shared* — so uninstalling the chat engine
    /// unlinks the binary while our child keeps running and serving (unlinking an
    /// executable does not kill the process running it). With the old term a live
    /// tier reported `false`, `/api/sidecar/status` called it stopped, and for the
    /// classify tier the desktop badge dropped "Local classifier running". A status
    /// that says "dead" about a live server is the same defect as one that says
    /// "healthy" about a dead one. `reachable_server_owner` already refused the same
    /// term for the same reason.
    ///
    /// One claim NOT to make here, because it was checked and is false: a llama.cpp
    /// *upgrade* does not open this window. `download_manager::write_flattened` writes
    /// a `.download-tmp` sibling and `std::fs::rename`s it over the destination, so
    /// the path keeps resolving throughout (`write_flattened_writes_via_temp_rename`
    /// pins that). Only an unlink — uninstall, or an operator moving the file — makes
    /// it vanish.
    ///
    /// Exactly what changed: the ONLY state that reads differently is *handle held +
    /// binary gone* — previously `false`, now `true`. Its sub-case where our child is
    /// also dead used to be accidentally right and is now over-reported, but that
    /// sub-case was ALREADY over-reported whenever the binary was present, because
    /// `LlamaCppProcess` does not reap. No liveness information is lost; a term about
    /// a file is.
    pub(super) fn is_running(&self) -> bool {
        if self.adopted_external.load(Ordering::Relaxed) {
            return true;
        }
        Self::holds_own_child(&self.process)
    }

    pub(super) fn pid(&self) -> Option<u32> {
        // `None` whenever we hold no child handle — exactly the condition
        // `reachable_server_owner` reads as `Foreign`, so a server we did not spawn
        // never reports a pid (and leaves `stop` nothing to kill).
        self.process.lock().unwrap().as_ref().and_then(|p| p.pid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tier whose adopt probe never finds anything answering: port 0 is never
    /// bound, so these tests cannot adopt (or race) a real server on the machine.
    static TEST_TIER: SatelliteTier = SatelliteTier {
        name: "llamacpp-test",
        kind: "test",
        port: || 0,
        on_serving: || {},
        failure_reason: || None,
    };

    fn satellite() -> Satellite {
        Satellite::new(&TEST_TIER)
    }

    /// Spawn `program` through the same `LlamaCppProcess` API the start path uses, so
    /// the slot holds a real OS child handle (`LlamaCppProcess::child` is private and
    /// only `start_with` fills it). The program is handed llama-server's argv; whether
    /// it then exits is irrelevant — ownership is about holding the handle.
    #[cfg(unix)]
    async fn spawned(program: PathBuf) -> LlamaCppProcess {
        let mut proc = LlamaCppProcess::new(program);
        proc.start_with(LlamaCppStartOptions {
            // Port 0 is never bound. These tests are about the handle, not a listener.
            port: 0,
            model_path: None,
            mmproj_path: None,
            ctx_size: 0,
            embeddings: false,
            reranking: false,
            launch: crate::inference::LaunchConfig::default(),
        })
        .await
        .expect("the stand-in server must spawn, so we hold a real child handle");
        assert!(proc.pid().is_some());
        proc
    }

    /// Ownership is decided by whether we hold an OS child handle — NOT by whether a
    /// server answered. The two `Foreign` cases below are the states in which we
    /// genuinely own nothing, and they are the only ones `stop` may skip.
    #[test]
    fn a_reachable_port_is_foreign_only_when_we_hold_no_child() {
        let empty: Mutex<Option<LlamaCppProcess>> = Mutex::new(None);
        assert_eq!(
            Satellite::reachable_server_owner(&empty),
            ReachableServer::Foreign
        );

        // A process struct with no spawned child owns nothing either — `stop()` takes
        // the handle out, so this is also the post-stop state.
        let never_spawned = Mutex::new(Some(LlamaCppProcess::new(Satellite::binary_path())));
        assert_eq!(
            Satellite::reachable_server_owner(&never_spawned),
            ReachableServer::Foreign
        );
    }

    /// The flag must track the CURRENT owner, not latch on the first adoption, or a
    /// manager that adopted a foreign server once and later spawned its own child would
    /// skip stopping it forever.
    #[test]
    fn recording_a_reachable_server_tracks_ownership_in_both_directions() {
        let running = AtomicBool::new(false);
        let adopted = AtomicBool::new(false);

        Satellite::record_reachable_server(&running, &adopted, ReachableServer::Foreign);
        assert!(running.load(Ordering::Relaxed));
        assert!(
            adopted.load(Ordering::Relaxed),
            "a foreign server is adopted"
        );

        // Our own child later serves the port: the stale "foreign" claim MUST clear, or
        // `stop` keeps skipping the child we now own.
        Satellite::record_reachable_server(&running, &adopted, ReachableServer::OurChild);
        assert!(running.load(Ordering::Relaxed));
        assert!(
            !adopted.load(Ordering::Relaxed),
            "our own child must never be recorded as an external adoption"
        );
    }

    /// The half of the old behaviour that was always correct and must stay correct: a
    /// server we did not spawn is never killed, the tier reads as up while the adoption
    /// is remembered, and `stop` forgets the adoption so a later start re-decides
    /// ownership from scratch.
    #[tokio::test]
    async fn stop_leaves_a_server_we_did_not_spawn_alone() {
        let satellite = satellite();
        Satellite::record_reachable_server(
            &satellite.running,
            &satellite.adopted_external,
            ReachableServer::Foreign,
        );
        assert!(
            satellite.is_running(),
            "an adopted server reads as the tier being up"
        );
        assert_eq!(
            satellite.pid(),
            None,
            "we hold no child, so there is no pid"
        );

        satellite.stop().await.unwrap();
        assert!(
            !satellite.adopted_external.load(Ordering::Relaxed),
            "stop forgets the adoption"
        );
        assert!(satellite.process.lock().unwrap().is_none());
        assert!(!satellite.is_running());
    }

    /// The regression: a repeat start that finds the port answered by OUR OWN child
    /// must leave that child stoppable. Under the old `adopted_external.store(true)`,
    /// a repeat start set the flag and `stop` took its early return, leaving this
    /// child resident.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repeat_start_over_our_own_child_keeps_it_stoppable() {
        let satellite = satellite();
        *satellite.process.lock().unwrap() = Some(spawned(PathBuf::from("/bin/sleep")).await);

        // Exactly what the adopt branch does when the port answers on a repeat start.
        let owner = Satellite::reachable_server_owner(&satellite.process);
        assert_eq!(owner, ReachableServer::OurChild);
        Satellite::record_reachable_server(&satellite.running, &satellite.adopted_external, owner);
        assert!(
            !satellite.adopted_external.load(Ordering::Relaxed),
            "our own child is not an external adoption"
        );
        assert!(satellite.is_running());
        assert!(satellite.pid().is_some(), "our own child reports its pid");

        // The point of the fix: stop actually reaps it instead of returning early.
        satellite.stop().await.unwrap();
        assert!(
            satellite.process.lock().unwrap().is_none(),
            "stop must take and kill our own child, not skip it"
        );
        assert!(!satellite.is_running());
    }

    /// A repeat start while our child is still loading (alive, `/health` not yet
    /// 2xx) must neither spawn nor replace it: storing a new child in the slot drops,
    /// and so kills, the loading one.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repeat_start_while_our_child_loads_keeps_it() {
        let satellite = satellite();
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep fixture");
        *satellite.process.lock().unwrap() = Some(LlamaCppProcess::from_child_for_test(child));
        let pid = satellite.pid();
        assert!(pid.is_some());

        assert!(
            satellite.already_up().await,
            "a loading child is a start already in progress"
        );
        assert_eq!(
            satellite.pid(),
            pid,
            "the loading child must not be replaced"
        );

        satellite.stop().await.unwrap();
        assert!(satellite.process.lock().unwrap().is_none());
    }

    /// A liveness answer must not be a function of the llama.cpp binary FILE.
    ///
    /// `LlamaCppProcess::is_running()` is `child.is_some() && binary_path.exists()`,
    /// and uninstalling the CHAT engine removes `engines/chat/llamacpp/llama-server` —
    /// the binary every satellite shares with it and deliberately never removes itself
    /// (`LlamaCppManager::uninstall` removes the engine dir). While the file is gone,
    /// that predicate reports a tier that is up and serving as stopped —
    /// `/api/sidecar/status.running = false` for a process that never stopped
    /// answering.
    ///
    /// The throwaway executable is a temp-dir shell script (nothing to bind, exits at
    /// once) so the test can delete it out from under the handle, which is the whole
    /// point.
    #[cfg(unix)]
    #[tokio::test]
    async fn is_running_ignores_the_shared_binary_being_unlinked_under_a_held_child() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let fake_server = dir.path().join("llama-server");
        std::fs::write(&fake_server, "#!/bin/sh\nexit 0\n").expect("write throwaway server");
        std::fs::set_permissions(&fake_server, std::fs::Permissions::from_mode(0o755))
            .expect("chmod throwaway server");

        let satellite = satellite();
        *satellite.process.lock().unwrap() = Some(spawned(fake_server.clone()).await);
        assert!(satellite.is_running(), "a held child means the tier is up");

        // The window: the shared binary is unlinked (what the chat engine's uninstall
        // does), so the path stops resolving. On unix that does not touch a process
        // already running it — nothing about our child changed.
        std::fs::remove_file(&fake_server).expect("remove the binary");
        assert!(!fake_server.exists());
        assert!(
            satellite.is_running(),
            "unlinking the shared binary must not report a serving tier as stopped"
        );
        assert!(satellite.pid().is_some(), "and the pid stays reportable");
        // The ownership predicate must keep agreeing with it — they are one function.
        assert_eq!(
            Satellite::reachable_server_owner(&satellite.process),
            ReachableServer::OurChild
        );

        // `stop` is still the only thing that takes the handle out, binary or no binary.
        satellite.stop().await.unwrap();
        assert!(!satellite.is_running());
    }
}
