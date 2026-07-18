//! Core-side driver for the out-of-process `ryu-healing` sidecar.
//!
//! Self-healing used to run in-process: `healing_host::spawn` published a
//! `ryu_healing::HealEngine` as a process-global, the scheduler + workflow executor
//! called `ryu_healing::global_engine().report_failure(...)` directly, and the
//! `/api/healing/*` HTTP surface was merged into Core's router. Healing is now an
//! out-of-process app (`com.ryu.healing`): the `ryu-healing` sidecar owns the
//! diagnose→propose ENGINE, the per-source attempt cap (`healing-attempts.json`),
//! the `healing.*` prefs, the Gateway diagnosis call, and the public
//! `/api/healing/config|status` surface (served through the ext-proxy
//! `public_mount`).
//!
//! **The welded couplings stay in Core** and are driven from the sidecar's verdict:
//! a heal proposal embeds a Core `PendingAction` that the `ApprovalEngine` executes
//! on approve, and an auto-fix re-run reaches Core's agent runner / workflow store.
//! So the sidecar does NOT call back into Core; instead Core posts a failed run's
//! context to `POST /api/healing/report-failure`, the sidecar returns a
//! [`ryu_healing::HealVerdict`], and Core applies it via
//! [`ryu_healing::apply_verdict`] against [`CoreHealingHost`] (the approvals write +
//! the re-run). The three failure surfaces that stay kernel drive this client:
//!
//! - **run-status bus** — [`spawn`] subscribes to
//!   [`crate::server::conversations::subscribe_run_events`], reads the failed run's
//!   instruction + failure output from the conversation store (both kernel), and
//!   posts them (the old in-process `healing_host` loop, now over loopback).
//! - **scheduler agent job** — the `JobTarget::Agent` failure arm posts via
//!   [`global_client`].
//! - **workflow run** — `fail_run` posts via [`global_client`].
//!
//! Security mirrors the ext-proxy hop exactly: loopback target on the sidecar's
//! declared port ([`crate::profile::port`]-shifted), with the per-plugin minted
//! bearer ([`crate::sidecar::ext_proxy::ext_token`]) the sidecar was spawned with —
//! nothing hardcoded. Fail-open: an unreachable sidecar (Self-Healing app disabled,
//! so the sidecar isn't spawned) means a run simply isn't auto-healed, never a wedge.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use ryu_healing::{apply_verdict, HealSource, HealVerdict, HealingHost};

use crate::server::conversations::ConversationSummary;
use crate::server::ServerState;
use crate::sidecar::ext_proxy::{ext_token, node_token};

/// The built-in Self-Healing app id (matches the `healing.plugin.json` fixture id
/// and `plugins::builtins::HEALING_PLUGIN_ID`).
const HEALING_PLUGIN_ID: &str = "com.ryu.healing";
/// Fallback loopback port if the manifest is somehow absent — matches the
/// `healing.plugin.json` fixture `port`. Core injects this as `RYU_HEALING_PORT` at
/// spawn.
const HEALING_FALLBACK_PORT: u16 = 8001;

// ---------------------------------------------------------------------------
// CoreHealingHost — the welded-coupling side (approvals write + re-run)
// ---------------------------------------------------------------------------

/// Core's implementation of [`HealingHost`], used ONLY as the [`apply_verdict`]
/// target: its action methods (`rerun_*`, `queue_heal_*`) perform the couplings that
/// stay kernel — the agent/workflow re-run and the approvals-inbox delivery. The
/// read-side methods (`pref_*`, `default_diagnose_model`, `data_dir`,
/// `call_side_model`) are now owned by the sidecar and never invoked Core-side; they
/// are retained only to satisfy the trait.
pub struct CoreHealingHost {
    state: ServerState,
}

impl CoreHealingHost {
    pub fn new(state: ServerState) -> Self {
        Self { state }
    }
}

#[async_trait]
impl HealingHost for CoreHealingHost {
    async fn pref_get(&self, key: &str) -> Option<String> {
        // Owned by the sidecar out-of-process; retained for the trait only.
        self.state.preferences.get(key).await.ok().flatten()
    }

    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.state
            .preferences
            .set(key, value)
            .await
            .map_err(|e| e.to_string())
    }

    fn default_diagnose_model(&self) -> String {
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string()
    }

    fn data_dir(&self) -> std::path::PathBuf {
        crate::paths::ryu_dir()
    }

    async fn call_side_model(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        crate::server::call_side_model(&self.state, model, effort, system, user).await
    }

    async fn rerun_agent(&self, agent_id: Option<String>, run_id: String, prompt: String) {
        if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
            if let Err(e) = runner.run(agent_id, run_id, prompt).await {
                tracing::warn!("healing: auto re-run failed: {e:#}");
            }
        }
    }

    async fn rerun_workflow(&self, source_id: &str) {
        if let Err(e) = crate::workflow::rerun_run(source_id).await {
            tracing::warn!("healing: auto workflow re-run failed for {source_id}: {e}");
        }
    }

    async fn queue_heal_fix(
        &self,
        source_id: &str,
        agent_id: Option<String>,
        diagnosis: &str,
        corrected: String,
    ) {
        if let Some(engine) = crate::approvals::global_engine() {
            let req = crate::approvals::ApprovalRequest::for_heal_fix(
                source_id, agent_id, diagnosis, corrected,
            );
            if let Err(e) = engine.request_deduped(req).await {
                tracing::warn!("healing: queue heal approval failed for {source_id}: {e:#}");
            }
        }
    }

    async fn queue_heal_workflow(&self, source_id: &str, diagnosis: &str) {
        if let Some(engine) = crate::approvals::global_engine() {
            let req = crate::approvals::ApprovalRequest::for_heal_workflow(source_id, diagnosis);
            if let Err(e) = engine.request_deduped(req).await {
                tracing::warn!("healing: queue workflow heal failed for {source_id}: {e:#}");
            }
        }
    }

    async fn queue_heal_exhausted(&self, source_id: &str, note: &str) {
        if let Some(engine) = crate::approvals::global_engine() {
            let req = crate::approvals::ApprovalRequest::for_heal_exhausted(source_id, note);
            if let Err(e) = engine.request_deduped(req).await {
                tracing::warn!("healing: escalation enqueue failed for {source_id}: {e:#}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HealingClient — post-failure → verdict → apply
// ---------------------------------------------------------------------------

/// Typed loopback client for the `ryu-healing` sidecar. Cheap to clone (holds the
/// resolved port + a shared [`CoreHealingHost`]); the bearer is minted per call so
/// it always tracks the current node token.
#[derive(Clone)]
pub struct HealingClient {
    port: u16,
    host: Arc<CoreHealingHost>,
}

impl HealingClient {
    /// Build a client bound to the sidecar's resolved loopback port, applying
    /// verdicts against a [`CoreHealingHost`] over `state`.
    pub fn new(port: u16, state: ServerState) -> Self {
        Self {
            port,
            host: Arc::new(CoreHealingHost::new(state)),
        }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/healing", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with — the same value
    /// the ext-proxy stamps on its hop, so a hand-rolled local request without it is
    /// rejected fail-closed.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), HEALING_PLUGIN_ID)
    }

    /// Report a failed run to the sidecar and apply the returned verdict. Best-effort
    /// end to end: an unreachable sidecar (Self-Healing disabled) is a benign no-op,
    /// and a `Skip` verdict does nothing. The diagnosis is a slow Gateway call, so
    /// callers already run this inside a spawned, fire-and-forget task.
    pub async fn report_failure(
        &self,
        source_id: &str,
        source: HealSource,
        instruction: String,
        failure: String,
    ) {
        let kind = match source {
            HealSource::Agent { .. } => "agent",
            HealSource::Workflow => "workflow",
        };
        let agent_id = match &source {
            HealSource::Agent { agent_id } => agent_id.clone(),
            HealSource::Workflow => None,
        };
        let body = json!({
            "source_id": source_id,
            "kind": kind,
            "agent_id": agent_id,
            "instruction": instruction,
            "failure": failure,
        });
        let resp = reqwest::Client::new()
            .post(format!("{}/report-failure", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&body)
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                // Fail-open: the sidecar being down just means no auto-heal.
                tracing::debug!("healing: sidecar not reachable for {source_id} ({e})");
                return;
            }
        };
        if !resp.status().is_success() {
            tracing::debug!("healing: report-failure returned HTTP {}", resp.status());
            return;
        }
        let verdict: HealVerdict = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("healing: unparseable verdict for {source_id}: {e}");
                return;
            }
        };
        // Core owns the welded action (approvals write / re-run).
        apply_verdict(&*self.host, verdict).await;
    }
}

/// Process-global healing client so the scheduler (`JobTarget::Agent` failure arm)
/// and the workflow executor (`fail_run`) — neither of which carries `ServerState`
/// — can reach the sidecar. Set once from `main.rs`, mirroring the `quests_client`
/// pattern.
static GLOBAL_CLIENT: std::sync::OnceLock<HealingClient> = std::sync::OnceLock::new();

/// Publish the process-global healing client. Idempotent (first write wins).
pub fn set_global_client(client: HealingClient) {
    let _ = GLOBAL_CLIENT.set(client);
}

/// The process-global healing client, or `None` before `main.rs` has set it.
pub fn global_client() -> Option<&'static HealingClient> {
    GLOBAL_CLIENT.get()
}

/// Resolve the `ryu-healing` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]).
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == HEALING_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-healing"))
        .map(|s| s.port)
        .unwrap_or(HEALING_FALLBACK_PORT);
    crate::profile::port(raw)
}

// ---------------------------------------------------------------------------
// Run-status bus loop (kernel: the bus + the conversation read stay Core-side)
// ---------------------------------------------------------------------------

/// Subscribe the run-status bus and drive the healing sidecar for failed chat/agent
/// runs. The bus + the conversation-store read stay kernel (Core-side); only the
/// engine moved out-of-process. Fail-open: a missed event (lagged/closed) only means
/// a run isn't auto-healed, never a wedge. Spawned unconditionally in `main.rs`.
pub fn spawn(client: HealingClient, state: ServerState) {
    tokio::spawn(async move {
        let mut rx = crate::server::conversations::subscribe_run_events();
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if ev.run.run_status.as_deref() == Some("failed") {
                        let client = client.clone();
                        let state = state.clone();
                        // Handle off the recv path so a slow diagnosis can't block
                        // draining the bus.
                        tokio::spawn(async move { handle_failed(&state, &client, ev.run).await });
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("healing: lagged {n} run events (fail-open, unhealed)");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Bus path: a chat/agent conversation run failed. Load its instruction + error from
/// the conversation store (kernel), then post to the sidecar.
async fn handle_failed(state: &ServerState, client: &HealingClient, run: ConversationSummary) {
    let (instruction, failure) = extract_context(state, &run.id).await;
    if instruction.is_empty() {
        tracing::debug!("healing: {} has no instruction to retry", run.id);
        return;
    }
    client
        .report_failure(
            &run.id,
            HealSource::Agent {
                agent_id: run.agent_id,
            },
            instruction,
            failure,
        )
        .await;
}

/// Load the failed run's last user instruction + last assistant/error output from
/// the kernel conversation store, applying the crate's length policy.
async fn extract_context(state: &ServerState, conv_id: &str) -> (String, String) {
    let Ok(messages) = state.conversations.get_messages(conv_id).await else {
        return (String::new(), String::new());
    };
    let mut instruction = String::new();
    let mut failure = String::new();
    for m in &messages {
        match m.role.as_str() {
            "user" => instruction = m.content.clone(),
            "assistant" => failure = m.content.clone(),
            _ => {}
        }
    }
    (
        ryu_healing::truncate_context(&instruction),
        ryu_healing::truncate_context(&failure),
    )
}
