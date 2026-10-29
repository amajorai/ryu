//! Local **classify tier** — a dedicated llama.cpp instance serving a 270M model.
//!
//! Mirrors the reranker sidecar (`rerank.rs`) but serves a tiny instruction-tuned
//! GGUF on port 8083 in plain chat-completions mode (no `--embeddings`, no
//! `--reranking`), so the gateway can register it as its own `classify` provider.
//!
//! **Why this exists.** The gateway's two guardrail consumers — the firewall's
//! cheap-LLM traffic inspector (`firewall.inspector.model`) and smart routing's
//! classifier (`routing.smart_routing.classifier_model`) — both resolve a `gemma-*`
//! selection through `RoutingTables::route`, which before this unit sent every
//! `gemma` prefix to the gateway's `local` provider. That provider has a single
//! `base_url` pointing at the **resident chat engine**, and one llama-server serves
//! exactly one model (`process.rs`), so asking for a 270M classifier silently ran
//! the guardrail on the user's full-size chat model: slow, expensive, and nothing in
//! the UI said so. There was no small model to point at. This sidecar is it.
//!
//! Placement (CLAUDE.md §1): deciding *which* model classifies is "what runs" →
//! Core. The model + URL are swappable registry defaults (`local_classifier_model`),
//! never hardcoded.
//!
//! Like the reranker this sidecar is **off by default** — it is NOT in
//! `startup_order`, so it consumes no memory until something selects the classify
//! tier. Core's gateway config-push path lazily starts it
//! (`crate::sidecar::gateway::push_config`) when a pushed config selects a classify
//! model. Both consumers fail **open** (a timeout or unreachable provider is treated
//! as "no verdict": allow + warn), so a classify server that is not warm yet degrades
//! to no guardrail verdict, never to a broken request.

use std::sync::Mutex;

use crate::sidecar::providers::llamacpp::process::LlamaCppStartOptions;
use crate::sidecar::providers::llamacpp::satellite::{Satellite, SatelliteTier};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// The name this sidecar is registered under, and therefore the only string that
/// [`crate::sidecar::SidecarManager::start_sidecar`] will resolve to it.
///
/// **Load-bearing, not tidiness.** Three independent places have to agree on it —
/// [`Sidecar::name`] here, the lazy start in `sidecar/gateway.rs`, and
/// [`crate::sidecar::onboarding`]'s `LLAMACPP_DERIVED_SIDECARS` (which is what marks
/// the sidecar *installed*; `start_sidecar` refuses anything absent from the
/// installed set). Until this const existed all three were bare literals, so a
/// rename in one place produced a lazy start that returns
/// `"'llamacpp-classify' is not installed"` — a permanently dead guardrail on every
/// node, because both consumers fail OPEN. The desktop has had a
/// `CLASSIFY_SIDECAR_NAME` plus a mirror test since the badge shipped
/// (`apps/desktop/src/lib/api/gateway.ts`); Rust had neither.
pub const CLASSIFY_SIDECAR_NAME: &str = "llamacpp-classify";

/// Canonical (release) loopback port the classify server binds to. Distinct from
/// the chat engine's 8080, the embeddings server's 8081 and the reranker's 8082 so
/// all four can run together. The concrete port is profile-aware — see
/// [`classify_port`].
pub const CLASSIFY_PORT_BASE: u16 = 8083;

/// Profile-aware classify port (release 8083, dev 9083, …). The gateway that dials
/// this resolves the SAME port from `RYU_CLASSIFY_LLM_URL`, which Core computes via
/// this function in `gateway::gateway_spawn_env`, so spawn and client never diverge.
pub fn classify_port() -> u16 {
    crate::profile::port(CLASSIFY_PORT_BASE)
}

// ── Lazy-start failure record ───────────────────────────────────────────────────
//
// The tier is started fire-and-forget from `sidecar/gateway.rs`, off a config push
// that has already returned to its caller. There is no request to fail and no
// `Result` to hand anywhere, so before this record a failed start left only a log
// line. That is the gap: the desktop's classify-tier badge
// (`deriveClassifyTierState`) crosses `/api/sidecar/status` with a weights probe,
// which distinguishes exactly ONE cause (`unweighted`) and reads every other —
// llama.cpp binary missing, port taken, name not in the installed set, download
// center unwired — as the sidecar's normal lazy `idle`.
//
// Modelled on `manifest_sidecar`'s `missing_binary_record`: a process-global keyed
// record, written on failure, CLEARED by the success path, and surfaced through
// [`HealthStatus`] — the reason channel that already exists — rather than a new one.

/// Why the classify tier is not up, or `None` if the most recent start succeeded (or
/// nothing has been attempted). One slot, not a log: the useful question is always
/// "can the tier serve right now, and if not why", never "how many times".
///
/// Two kinds of writer, both from the lazy-start hook in `sidecar/gateway.rs`:
/// a start that FAILED, and a start that was deliberately SKIPPED in a state that
/// cannot be told apart from a misconfiguration (`RYU_CLASSIFY_LLM_URL` repointed
/// while the model id is still the registry default). The slot is named for the first
/// because that is what it was built for; both answer the same question, and a skip
/// that is genuinely benign — an external tier configured in full, a remote gateway —
/// deliberately writes nothing.
fn lazy_start_failure() -> &'static Mutex<Option<String>> {
    static RECORD: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();
    RECORD.get_or_init(|| Mutex::new(None))
}

/// Record why the tier is not up: the flattened `anyhow` chain when a lazy start
/// failed, or an explanation when one was skipped in a state indistinguishable from a
/// misconfiguration.
///
/// The WRITE half of the seam. Both callers are in [`crate::sidecar::gateway`]'s
/// `maybe_start_classify_tier` — the fire-and-forget spawn (the only place that ever
/// sees the start's `Err`) and its second spend gate. A poisoned lock is dropped
/// silently — losing a diagnostic must never be able to panic the task that was
/// already handling a failure.
pub fn record_lazy_start_failure(reason: String) {
    if let Ok(mut slot) = lazy_start_failure().lock() {
        *slot = Some(reason);
    }
}

/// Forget any recorded failure. The tier's `on_serving` hook, so both success paths
/// of [`Sidecar::start`] (adopt and spawn) clear it: the record can only ever describe
/// the CURRENT state — the same self-clearing contract that lets a reader treat any
/// entry in `manifest_sidecar::missing_sidecar_binary_reports` as actionable.
fn clear_lazy_start_failure() {
    if let Ok(mut slot) = lazy_start_failure().lock() {
        *slot = None;
    }
}

/// The recorded reason, if the last lazy start failed or was skipped in a state that
/// cannot be told apart from a misconfiguration.
///
/// The READ half. Its only consumer today is this module's [`Sidecar::health_check`]:
/// it is the tier's `failure_reason`, which `satellite.rs` appends to the not-running
/// status — the same treatment `ManifestSidecar::health_check` gives a missing binary,
/// riding the `HealthStatus` reason channel rather than adding a second one. That is
/// why it is not `pub`: the `/api/sidecar/status` key that would put this in
/// front of a user lives in `server/mod.rs`, outside this change set. That followup is
/// the point of the seam — mirroring the note on
/// `SidecarManager::native_sidecar_permissions`. Be honest about the reach today: a
/// failed lazy start spawns NO health monitor (`start_sidecar` only calls
/// `spawn_health_monitor` after `start()` returns `Ok`) and nothing wakes this
/// sidecar through `await_healthy` (the gateway dials its port directly, never through
/// Core's ext-proxy), so on the failure path the `warn!` at the call site is what a
/// human actually sees. This record makes the reason *retrievable*; wiring the status
/// key is what will make it *visible*. The same is true of the skip path added beside
/// it: a skipped start spawns no monitor either, so its `warn!` carries the same
/// weight.
fn lazy_start_failure_reason() -> Option<String> {
    lazy_start_failure().lock().ok().and_then(|s| s.clone())
}

/// Poison-tolerant lock serializing every test — in ANY module — that reads or writes
/// the process-global record above.
///
/// `cargo` runs a crate's unit tests in ONE process, in parallel. Two modules write
/// this slot now (this one's own test, and `sidecar::gateway`'s spend-gate test), so
/// without a shared lock a write from one can land inside the other's "the record is
/// empty" window and fail it for the wrong reason. Lives here because this module owns
/// the record, exactly like `sidecar::gateway`'s `GATEWAY_ENV_TEST_LOCK`.
#[cfg(test)]
pub(crate) fn lock_lazy_start_record() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Test-only reader for the record, for the `sidecar::gateway` spend-gate test that
/// writes it through [`record_lazy_start_failure`]. Not `pub(crate)` on the real
/// reader: production visibility stays exactly as narrow as it was.
#[cfg(test)]
pub(crate) fn lazy_start_failure_reason_for_test() -> Option<String> {
    lazy_start_failure_reason()
}

/// Test-only clear, so a cross-module test can leave the slot as it found it.
#[cfg(test)]
pub(crate) fn clear_lazy_start_failure_for_test() {
    clear_lazy_start_failure();
}

static TIER: SatelliteTier = SatelliteTier {
    name: CLASSIFY_SIDECAR_NAME,
    kind: "classify",
    port: classify_port,
    on_serving: clear_lazy_start_failure,
    failure_reason: lazy_start_failure_reason,
};

/// Lifecycle manager for the dedicated llama.cpp classify sidecar.
pub struct LlamaCppClassifyManager {
    satellite: Satellite,
}

impl LlamaCppClassifyManager {
    pub fn new() -> Self {
        Self {
            satellite: Satellite::new(&TIER),
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.satellite.downloads = Some(downloads);
        self
    }

    /// The injected download center, as an `Err` rather than a panic when it is
    /// absent.
    ///
    /// It used to be `.expect("download center not wired (main.rs)")`. `main.rs` does
    /// wire it, so the panic was unreachable *there* — but this runs inside the
    /// fire-and-forget `tokio::spawn` of the gateway config-push path, whose
    /// `JoinHandle` is dropped. A panic on that task therefore kills only the task:
    /// the start silently never happens, and the guardrail fails open with no `Err`
    /// for the caller to record. As a `Result` it becomes the same reportable failure
    /// as a missing binary. Kept as a named accessor so the bare-`new()` case is
    /// unit-testable without touching the port or the filesystem.
    fn downloads_or_err(
        downloads: Option<&crate::downloads::DownloadCenter>,
    ) -> anyhow::Result<&crate::downloads::DownloadCenter> {
        downloads.ok_or_else(|| {
            anyhow::anyhow!(
                "{CLASSIFY_SIDECAR_NAME}: download center not wired — the manager was built \
                 without `with_downloads` (see the `main.rs` sidecar registration), so \
                 llama.cpp cannot be installed for the classify tier"
            )
        })
    }
}

impl Default for LlamaCppClassifyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppClassifyManager {
    fn name(&self) -> &'static str {
        CLASSIFY_SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let satellite = self.satellite.clone();
        Box::pin(async move {
            // A server already answering `/health` on the port means there is nothing
            // to spawn — but WHO owns it decides what `stop`/`is_running` may do, so
            // `already_up` classifies it instead of assuming "already up ⇒ someone
            // else's". The lazy start hook fires on EVERY config push that selects the
            // tier, so the common case after the first push is that the answering
            // server is our own child from the previous push. A serving tier makes any
            // earlier failure history wrong, so the adopt branch clears the record too
            // (the tier's `on_serving`) — not just the spawn branch.
            //
            // **Scope of "safe to call on every push".** Adoption makes a repeat start
            // a no-op *for the process* once `/health` answers 2xx. Between "port
            // bound" and "`/health` 2xx" (the model-load window), the live-child gate
            // in `already_up` keeps a repeat push from spawning a competitor that would
            // replace, and so kill, the loading child.
            // *For the manager*, a repeat start no longer leaks a health monitor either:
            // `SidecarManager::spawn_health_monitor` (`sidecar/manager.rs`) aborts the
            // monitor it displaces, which it did not do before this change.
            if satellite.already_up().await {
                return Ok(());
            }

            let downloads = Self::downloads_or_err(satellite.downloads.as_ref())?;
            satellite.install_llamacpp(downloads).await?;

            // Serve the classifier GGUF downloaded by onboarding. Like the embeddings
            // and reranker servers, this engine does NOT download the model itself —
            // onboarding (`install_local_stack`) is the single owner of model
            // downloads, so there is no double-download race against a lazy start.
            //
            // Resolved via `from_env()` — the SAME constructor the gateway-push
            // predicate uses to decide whether to start us. If the two resolved the
            // registry differently the hook could fire for a model we do not serve.
            let registry = crate::registry::ModelRegistry::from_env();
            let model_path = satellite
                .require_model(registry.local_classifier_model.weight_path(), "classifier")?;

            let opts = LlamaCppStartOptions {
                port: classify_port(),
                model_path: Some(model_path),
                // The classifier is text-only — no vision adapter.
                mmproj_path: None,
                // gemma-3-270m-it accepts 32K tokens, but llama-server allocates the
                // whole KV cache up front, so taking the model maximum would cost
                // memory for headroom neither consumer can use: the firewall
                // inspector scans ONE turn (and skips turns under `min_chars`) and
                // the routing classifier scores ONE prompt against a short rubric.
                // 4096 tokens (~16k characters) covers both with room to spare while
                // keeping the whole tier small enough to sit resident alongside the
                // full-size chat engine — which is the entire point of having it.
                ctx_size: 4096,
                // Plain chat completions: this tier answers a prompt, it does not
                // embed or cross-encode. Both flags off ⇒ llama-server exposes
                // `/v1/chat/completions`, which is what the gateway's `classify`
                // provider dials.
                embeddings: false,
                reranking: false,
                // Saved classify-tier settings; a saved context size replaces
                // the 4096 default above.
                launch: crate::sidecar::providers::engine_launch_config("llamacpp-classify").await,
            };
            // A 241 MB model loads in a couple of seconds; the shared 120s ceiling
            // keeps a cold page-cache on slow disks from being a failure.
            satellite.spawn(opts, "classify").await
        })
    }

    /// Only a server we did NOT spawn is left alone. Our own child — including one a
    /// later lazy start found already serving — is killed; that is the whole point of
    /// distinguishing the two, since a mislabelled child made this an unconditional
    /// no-op after the second push.
    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        self.satellite.stop()
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        self.satellite.health_check()
    }

    fn is_running(&self) -> bool {
        self.satellite.is_running()
    }

    fn pid(&self) -> Option<u32> {
        self.satellite.pid()
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // The binary is shared with the chat engine — do NOT remove it here.
            // Only drop the version-store marker for this sidecar. The classifier
            // GGUF under `models/classifier/` is left intact.
            crate::sidecar::remove_from_version_store(CLASSIFY_SIDECAR_NAME);
            tracing::info!(
                "{CLASSIFY_SIDECAR_NAME} uninstalled (shared binary + models left intact)"
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The classify tier must never collide with the three llama.cpp servers that
    /// can be resident at the same time (chat 8080, embed 8081, rerank 8082) — a
    /// shared port would mean the second process to start silently fails to bind
    /// and the tier looks "not up" forever.
    #[test]
    fn classify_port_base_is_distinct_from_the_other_llamacpp_servers() {
        assert_eq!(CLASSIFY_PORT_BASE, 8083);
        assert_ne!(CLASSIFY_PORT_BASE, 8080, "chat engine port");
        assert_ne!(
            CLASSIFY_PORT_BASE,
            crate::sidecar::providers::llamacpp::embed::EMBED_PORT_BASE
        );
        assert_ne!(
            CLASSIFY_PORT_BASE,
            crate::sidecar::providers::llamacpp::rerank::RERANK_PORT_BASE
        );
    }

    /// The concrete port must ride the profile offset like every other Ryu port,
    /// so a dev profile (`+1000`) does not dial the release node's classify server.
    #[test]
    fn classify_port_is_profile_aware() {
        assert_eq!(classify_port(), crate::profile::port(CLASSIFY_PORT_BASE));
        assert_eq!(
            crate::profile::port_for(CLASSIFY_PORT_BASE, "release"),
            CLASSIFY_PORT_BASE
        );
        assert_eq!(
            crate::profile::port_for(CLASSIFY_PORT_BASE, "dev"),
            CLASSIFY_PORT_BASE + crate::profile::DEV_PORT_OFFSET
        );
        // The dev-profile ports of all four servers stay distinct too.
        assert_eq!(crate::profile::port_for(CLASSIFY_PORT_BASE, "dev"), 9083);
    }

    #[test]
    fn sidecar_is_named_and_optional() {
        let mgr = LlamaCppClassifyManager::new();
        // Both directions: the const is the wire name, and `name()` is the const —
        // so neither can be edited into disagreement with the other.
        assert_eq!(CLASSIFY_SIDECAR_NAME, "llamacpp-classify");
        assert_eq!(mgr.name(), CLASSIFY_SIDECAR_NAME);
        // Off by default: never required, never in `startup_order` — it only runs
        // once a pushed gateway config selects the classify tier.
        assert!(!mgr.is_required());
        assert!(!mgr.is_running());
    }

    /// A manager built without `with_downloads` must return an `Err`, not panic.
    ///
    /// The start path runs inside a detached `tokio::spawn` whose `JoinHandle` is
    /// dropped, so a panic there is swallowed: the tier never starts and the caller
    /// gets no `Err` to log or record. Tested through the extracted accessor rather
    /// than a whole `start()` call, which would first probe the classify port and
    /// could adopt (or race) a real server on a developer's machine.
    #[test]
    fn a_manager_without_a_download_center_errs_instead_of_panicking() {
        // `DownloadCenter` is not `Debug`, so unwrap the arm by hand rather than with
        // `expect_err` (which requires `T: Debug`).
        let msg = match LlamaCppClassifyManager::downloads_or_err(None) {
            Ok(_) => panic!("no download center must be an Err, never an Ok"),
            Err(e) => format!("{e:#}"),
        };
        assert!(
            msg.contains(CLASSIFY_SIDECAR_NAME) && msg.contains("download center"),
            "the reason has to name the sidecar and the cause, it is what gets recorded: {msg}"
        );
        // And the wired case passes the value straight through.
        assert!(LlamaCppClassifyManager::new().satellite.downloads.is_none());
    }

    /// The lazy-start failure record is what turns an invisible fire-and-forget
    /// failure into a retrievable reason, and `health_check` is its consumer: a
    /// stopped sidecar must say WHY when a cause is known, and go back to the bare
    /// message once a start succeeds.
    #[tokio::test]
    async fn a_recorded_lazy_start_failure_is_reported_and_cleared() {
        // The record is BINARY-scoped, not module-scoped, and it now has a second test
        // writer: `sidecar/gateway.rs`'s spend-gate test records the half-configured
        // skip, which happens BEFORE the `SIDECAR_MANAGER.get()` early return that used
        // to make this test the only writer in a test process. Hence the shared lock.
        let _rec = lock_lazy_start_record();
        clear_lazy_start_failure();
        assert_eq!(lazy_start_failure_reason(), None);

        record_lazy_start_failure("llama.cpp binary is not installed".to_owned());
        assert_eq!(
            lazy_start_failure_reason().as_deref(),
            Some("llama.cpp binary is not installed")
        );

        // `running` is false on a fresh manager, so this is the branch a failed lazy
        // start leaves the sidecar in.
        let mgr = LlamaCppClassifyManager::new();
        match mgr.health_check().await {
            HealthStatus::Unhealthy(msg) => {
                assert!(
                    msg.contains("llama.cpp binary is not installed"),
                    "the recorded reason must ride the health status: {msg}"
                );
            }
            other => panic!("a stopped sidecar must be Unhealthy, got {other:?}"),
        }

        // A success path clears it — the record may only ever describe the present.
        clear_lazy_start_failure();
        match mgr.health_check().await {
            HealthStatus::Unhealthy(msg) => assert_eq!(msg, "classify process not running"),
            other => panic!("a stopped sidecar must be Unhealthy, got {other:?}"),
        }
    }
}
