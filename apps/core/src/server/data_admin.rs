//! "Danger zone" bulk data administration (`/api/data/*`).
//!
//! One auditable place for the destructive, irreversible "delete all X" actions
//! the desktop's Settings → Danger Zone tab exposes: wipe all chats, all spaces,
//! all long-term memory, or all of one app's data (website monitors, meetings, …).
//! Kernel categories are cleared by a flat truncate (the store owns a transactional
//! `clear_all`); an app category is cleared by the app itself.
//!
//! Deliberately scoped to unambiguous *user data*. Config/built-in stores
//! (agents, teams, workflows, scheduler jobs) are out of scope: wiping them would
//! nuke the flagship `ryu` agent or orphan the jobs that monitors/workflows
//! created. Per the Core-vs-Gateway rule this is all "what runs" data → Core; no
//! policy decision, so no Gateway involvement.
//!
//! # Who decides a category exists
//!
//! Two owners, and the split is the point:
//!
//! - **Kernel categories** (chats/spaces/memory) are compiled in below. No app
//!   created that data, so no manifest could declare it and none is asked to.
//! - **App categories** are declared by the owning app's manifest, in
//!   `contributes.data_categories`, and IMPLEMENTED by the same app through the two
//!   fan-out capabilities ([`crate::plugins::binding::FANOUT_CAPABILITIES`]):
//!   `data.count` (`{ category }` → `{ count }`) and `data.purge` (`{ category }` →
//!   `{ removed }`). A category is served ONLY while its app is enabled and provides
//!   both, so the row appears and disappears with the app and Core holds no per-app
//!   code: it calls whichever enabled app declared the id, through the generic
//!   capability consumer.
//!
//! The copy (title, noun, confirm word, the "what disappears" line) travels with
//! the descriptor either way, so `GET /api/data/counts` returns everything a client
//! needs to draw the whole section and the desktop holds no per-category list at
//! all. A purge is followed by a reconcile of the app-backed scheduler jobs
//! ([`crate::scheduler::app_jobs::reconcile_all`]), so the jobs of purged items
//! (an app job whose id the app no longer lists) are torn down at once rather
//! than on the next reconcile tick.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::plugin_manifest::{DataCategoryContribution, PluginManifest};
use crate::sidecar::capability_consumer::CapabilityConsumer;

/// The fan-out capability an app serves its category counts through.
const CAP_DATA_COUNT: &str = "data.count";
/// The fan-out capability an app clears a category through.
const CAP_DATA_PURGE: &str = "data.purge";

/// App-owned category ids that `GET /api/data/counts` still reports as flat
/// top-level keys. Older desktops parse these keys directly, so the response keeps
/// them (0 when no enabled app serves the category); every newer client reads the
/// `categories` list instead. Frozen: a new app category gets no flat key.
const LEGACY_FLAT_APP_KEYS: &[&str] = &["monitors", "meetings"];

/// The kernel data categories (no owning app).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataCategory {
    /// All conversations + their messages and sessions.
    Chats,
    /// All Spaces + their documents, chunks, and vectors.
    Spaces,
    /// All long-term memory entries.
    Memory,
}

impl DataCategory {
    /// Resolve a kernel wire id (`"chats"`).
    fn from_id(id: &str) -> Option<Self> {
        match id {
            "chats" => Some(Self::Chats),
            "spaces" => Some(Self::Spaces),
            "memory" => Some(Self::Memory),
            _ => None,
        }
    }

    /// Wire id — the value a client puts in `POST /api/data/clear`.
    const fn id(self) -> &'static str {
        match self {
            Self::Chats => "chats",
            Self::Spaces => "spaces",
            Self::Memory => "memory",
        }
    }
}

/// A kernel category's descriptor — the compiled-in twin of a manifest's
/// `contributes.data_categories` entry, for the data no app owns.
struct KernelCategory {
    category: DataCategory,
    title: &'static str,
    noun: &'static str,
    confirm_word: &'static str,
    detail: &'static str,
}

/// The categories with no owning app, in the order the danger zone lists them.
///
/// Their ids are refused to manifests by `validate_data_category`, so this list and
/// the app-declared ones cannot collide.
const KERNEL_CATEGORIES: &[KernelCategory] = &[
    KernelCategory {
        category: DataCategory::Chats,
        title: "Delete all chats",
        noun: "chats",
        confirm_word: "Chats",
        detail: "Every conversation and all of its messages will be permanently deleted.",
    },
    KernelCategory {
        category: DataCategory::Spaces,
        title: "Delete all spaces",
        noun: "spaces",
        confirm_word: "Spaces",
        detail: "Every Space, including all of its documents and their search data, will be permanently deleted. System spaces (Artifacts, Uploads, Meetings, …) are left untouched.",
    },
    KernelCategory {
        category: DataCategory::Memory,
        title: "Clear all memory",
        noun: "memory entries",
        confirm_word: "Memory",
        detail: "Every long-term memory entry will be permanently forgotten.",
    },
];

#[derive(Debug, Deserialize)]
pub struct ClearRequest {
    /// The category id, as a raw string.
    ///
    /// NOT the [`DataCategory`] enum. Extracting straight into the enum makes axum
    /// reject an unrecognised id with a 422 *before the handler body runs*, so no
    /// manifest-declared id could ever reach the resolution below and a category
    /// this Core cannot clear would look like a malformed request rather than an
    /// unknown one.
    pub category: String,
}

/// Whether `manifest` implements its declared categories: it provides both
/// fan-out data capabilities.
fn serves_data_categories(manifest: &PluginManifest) -> bool {
    [CAP_DATA_COUNT, CAP_DATA_PURGE].iter().all(|cap| {
        manifest
            .provided_capabilities()
            .iter()
            .any(|p| p.capability == *cap)
    })
}

fn declares_category(manifest: &PluginManifest, category_id: &str) -> bool {
    manifest.contributes.as_ref().is_some_and(|contributes| {
        contributes
            .data_categories
            .iter()
            .any(|category| category.id == category_id)
    })
}

/// `GET /api/data/counts`
///
/// How many items each danger-zone category currently holds, so the desktop can
/// render "Delete all 42 chats?" before the user commits. Best-effort per field:
/// a store or provider error surfaces as `0` for that category rather than failing
/// the whole response (the worst case is an under-count in the confirm dialog).
#[utoipa::path(
    get,
    path = "/api/data/counts",
    tag = "Data",
    summary = "Counts of deletable user-data categories",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn data_counts(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let chats = count_kernel_category(&state, DataCategory::Chats).await;
    let spaces = count_kernel_category(&state, DataCategory::Spaces).await;
    let memory = count_kernel_category(&state, DataCategory::Memory).await;
    let count_of = |category: DataCategory| match category {
        DataCategory::Chats => chats,
        DataCategory::Spaces => spaces,
        DataCategory::Memory => memory,
    };

    // The descriptor list — every row the danger zone should draw, kernel-owned
    // first and then whatever the enabled apps declare and serve, each with its own
    // copy and live count. Clients build the section from this alone.
    let mut categories: Vec<serde_json::Value> = Vec::new();
    for kernel in KERNEL_CATEGORIES {
        categories.push(json!({
            "id": kernel.category.id(),
            "title": kernel.title,
            "noun": kernel.noun,
            "confirm_word": kernel.confirm_word,
            "detail": kernel.detail,
            "count": count_of(kernel.category),
            // Explicitly null rather than absent: "no owning app" is the fact that
            // makes this row permanent, so it is worth stating.
            "plugin": serde_json::Value::Null,
        }));
    }
    let consumer = CapabilityConsumer::from_state(&state);
    let mut flat_app_counts: std::collections::BTreeMap<&str, u64> =
        LEGACY_FLAT_APP_KEYS.iter().map(|key| (*key, 0)).collect();
    for app in enabled_app_categories(&state).await {
        // Declaration without implementation. Serving it would put a button in the
        // danger zone that fails, so skip it, but say so: from the app author's side
        // a silently missing row is indistinguishable from a typo in the manifest.
        if !app.served {
            tracing::warn!(
                "app '{}' declares data category '{}' but does not provide both \
                 '{CAP_DATA_COUNT}' and '{CAP_DATA_PURGE}' — the danger-zone row is omitted",
                app.plugin_id,
                app.declared.id
            );
            continue;
        }
        let count = count_app_category(&consumer, &app.plugin_id, &app.declared.id).await;
        if let Some(flat) = flat_app_counts.get_mut(app.declared.id.as_str()) {
            *flat += count;
        }
        categories.push(json!({
            "id": app.declared.id,
            "title": app.declared.title,
            "noun": app.declared.noun,
            "confirm_word": app.declared.confirm_word(),
            "detail": app.declared.detail,
            "count": count,
            "plugin": app.plugin_id,
        }));
    }

    let mut body = json!({
        // The flat per-category keys predate `categories` and stay: they are the
        // shape older desktops parse, and dropping them would blank the counts on
        // every client that has not been updated alongside this node.
        "chats": chats,
        "spaces": spaces,
        "memory": memory,
        "categories": categories,
    });
    for (key, count) in flat_app_counts {
        body[key] = json!(count);
    }
    Json(body)
}

/// One `contributes.data_categories` entry of an enabled app.
struct AppCategory {
    plugin_id: String,
    declared: DataCategoryContribution,
    /// The app provides `data.count` and `data.purge`.
    served: bool,
}

/// Every `contributes.data_categories` entry of every **enabled** app.
///
/// Enablement is checked here, server-side, rather than left to the client: the
/// desktop used to feature-detect the owning app itself, which meant every other
/// surface (island, web, a script) either re-implemented the same filter or offered
/// to delete data from an app the node does not run.
async fn enabled_app_categories(state: &ServerState) -> Vec<AppCategory> {
    let enabled = match super::enabled_plugin_records(state).await {
        Ok(records) => records,
        // A store we cannot read is not evidence that nothing is enabled — but the
        // safe direction for an irreversible action is to offer fewer buttons, not
        // more, so fail closed to the kernel categories alone.
        Err(e) => {
            tracing::warn!(
                "data/counts: could not read plugin records ({e}) — app-owned categories omitted"
            );
            return Vec::new();
        }
    };
    let manifests = state.app_manifests.read().await;
    let mut out = Vec::new();
    for manifest in manifests.iter() {
        if !enabled.contains_key(&manifest.id) {
            continue;
        }
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        let served = serves_data_categories(manifest);
        for category in &contributes.data_categories {
            out.push(AppCategory {
                plugin_id: manifest.id.clone(),
                declared: category.clone(),
                served,
            });
        }
    }
    out
}

/// Whether any loaded manifest (enabled or not) declares AND serves `category_id`:
/// the difference between "this node's app for that data is not enabled" (404)
/// and "no such category" (400).
async fn category_known_to_any_app(state: &ServerState, category_id: &str) -> bool {
    state
        .app_manifests
        .read()
        .await
        .iter()
        .any(|m| serves_data_categories(m) && declares_category(m, category_id))
}

/// How many items one kernel category holds. Best-effort: a store error reads as
/// `0`, so the worst case is an under-count in the confirm dialog.
async fn count_kernel_category(state: &ServerState, category: DataCategory) -> u64 {
    match category {
        DataCategory::Chats => state.conversations.count_conversations().await.unwrap_or(0),
        DataCategory::Spaces => state.spaces.count_spaces().await.unwrap_or(0),
        DataCategory::Memory => state.memory.count().await.unwrap_or(0),
    }
}

/// How many items `provider` holds in `category_id`, through its `data.count`.
/// Best-effort: an unavailable provider or a malformed reply reads as `0`.
async fn count_app_category(
    consumer: &CapabilityConsumer,
    provider: &str,
    category_id: &str,
) -> u64 {
    match consumer
        .call_provider_capability(
            provider,
            CAP_DATA_COUNT,
            &json!({ "category": category_id }),
        )
        .await
    {
        Ok(reply) if reply.is_success() => {
            reply.body.get("count").and_then(Value::as_u64).unwrap_or(0)
        }
        Ok(reply) => {
            tracing::debug!(
                "data/counts: '{provider}' answered HTTP {} for '{category_id}'",
                reply.status
            );
            0
        }
        Err(e) => {
            tracing::debug!("data/counts: '{category_id}' from '{provider}' unavailable: {e}");
            0
        }
    }
}

/// Clear `category_id` through `provider`'s `data.purge`, then reconcile the
/// app-backed scheduler jobs so the purged items' backing jobs go at once.
async fn purge_app_category(
    consumer: &CapabilityConsumer,
    provider: &str,
    category_id: &str,
) -> Result<u64, String> {
    let reply = consumer
        .call_provider_capability(
            provider,
            CAP_DATA_PURGE,
            &json!({ "category": category_id }),
        )
        .await
        .map_err(|e| e.to_string())?;
    if !reply.is_success() {
        return Err(reply
            .body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{CAP_DATA_PURGE} failed: HTTP {}", reply.status)));
    }
    let removed = reply
        .body
        .get("removed")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{CAP_DATA_PURGE} reply has no `removed` count"))?;
    crate::scheduler::app_jobs::reconcile_all(Some(consumer)).await;
    Ok(removed)
}

/// Count one app-declared data category for the uninstall inventory. A category
/// is only resolvable when both halves exist: the manifest declares it and the
/// app provides the data capabilities.
pub(crate) async fn app_category_count(
    state: &ServerState,
    manifest: &PluginManifest,
    category_id: &str,
) -> Option<u64> {
    if !declares_category(manifest, category_id) || !serves_data_categories(manifest) {
        return None;
    }
    let consumer = CapabilityConsumer::from_state(state);
    Some(count_app_category(&consumer, &manifest.id, category_id).await)
}

/// Clear one app-declared data category through the app's own `data.purge`.
/// Unknown declarations fail closed instead of silently reporting success to
/// uninstall.
pub(crate) async fn clear_app_category(
    state: &ServerState,
    manifest: &PluginManifest,
    category_id: &str,
) -> anyhow::Result<u64> {
    if !declares_category(manifest, category_id) {
        anyhow::bail!("data category '{category_id}' is not declared by this app");
    }
    if let Some(kernel) = DataCategory::from_id(category_id) {
        anyhow::bail!(
            "data category '{}' is Core-owned and cannot be cleared as app data",
            kernel.id()
        );
    }
    if !serves_data_categories(manifest) {
        anyhow::bail!(
            "'{}' does not provide '{CAP_DATA_PURGE}', so '{category_id}' cannot be cleared",
            manifest.id
        );
    }
    let consumer = CapabilityConsumer::from_state(state);
    purge_app_category(&consumer, &manifest.id, category_id)
        .await
        .map_err(anyhow::Error::msg)
}

/// `POST /api/data/clear`  body: `{ "category": "chats" }`
///
/// Irreversibly delete every item in one category. Returns `{ removed: N }` with
/// the number of top-level items deleted. Kernel categories use the store's
/// transactional `clear_all`; an app category is purged by the app that declared
/// it (`data.purge`), which keeps its own per-item side effects.
///
/// `category` is whatever `GET /api/data/counts` offered — a kernel id, or one an
/// enabled app declared in its manifest. An app-owned category is refused unless
/// that app is still enabled, so the authorization matches what the list offered
/// rather than trusting the client to have filtered.
#[utoipa::path(
    post,
    path = "/api/data/clear",
    tag = "Data",
    summary = "Delete all items in a data category",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn data_clear(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<ClearRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    // ── ACL ──────────────────────────────────────────────────────────────────
    // This handler took NO caller: on an org-bound node any holder of the shared node
    // token could truncate EVERY user's chats, spaces, memory and app data.
    //
    //   - Node UNBOUND (personal): one principal, `RYU_TOKEN` is the boundary. The
    //     danger zone behaves EXACTLY as before — an unscoped truncate of the user's
    //     own machine, which is the whole point of the feature.
    //   - Node ORG-BOUND: an unscoped truncate is never acceptable. `Chats` is scoped
    //     to the caller's OWN conversations. Every other category has no per-user
    //     tenancy in the store yet (spaces/documents carry no owner columns — see the
    //     Spaces deferral), so there is nothing to scope by and a truncate would
    //     destroy other users' data: REFUSE rather than half-scope it.
    let bound_owner: Option<String> = match super::node_org_id() {
        None => None,
        Some(_) => match caller.as_ref() {
            Some(c) => Some(c.user_id.clone()),
            None => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": "forbidden: a signed-in user is required to clear data on a shared node"
                    })),
                );
            }
        },
    };

    let requested = req.category.trim();
    let result: Result<u64, String> = match DataCategory::from_id(requested) {
        Some(kernel) => match clear_kernel_category(&state, kernel, bound_owner.as_deref()).await {
            Ok(result) => result,
            Err(refusal) => return refusal,
        },
        None => {
            match clear_requested_app_category(&state, requested, bound_owner.is_some()).await {
                Ok(result) => result,
                Err(refusal) => return refusal,
            }
        }
    };

    match result {
        Ok(removed) => (StatusCode::OK, Json(json!({ "removed": removed }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// An early refusal: the status and body to return as-is.
type Refusal = (StatusCode, Json<serde_json::Value>);

fn shared_node_refusal() -> Refusal {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "forbidden: this category cannot be cleared on a shared (org-bound) node — \
                      it carries no per-user ownership, so clearing it would destroy other users' data"
        })),
    )
}

/// Clear a kernel category, scoped on an org-bound node (`bound_owner`) or refused.
async fn clear_kernel_category(
    state: &ServerState,
    category: DataCategory,
    bound_owner: Option<&str>,
) -> Result<Result<u64, String>, Refusal> {
    Ok(match (category, bound_owner) {
        // ── Unbound personal node: unchanged behaviour ───────────────────────
        (DataCategory::Chats, None) => clear_chats_with_residue(state, None).await,
        (DataCategory::Spaces, None) => state
            .spaces
            .clear_all_spaces()
            .await
            .map_err(|e| e.to_string()),
        (DataCategory::Memory, None) => {
            // Remove the derived plaintext index first. If either operation
            // fails, the encrypted source remains available for a retry and a
            // failed cleanup can never leave deleted memory searchable.
            if let Err(error) = state.retrieval.clear_memory_chunks().await {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": error.to_string() })),
                ));
            }
            state
                .memory
                .clear_all()
                .await
                .map_err(|error| error.to_string())
        }
        // ── Org-bound node: scope, or refuse ─────────────────────────────────
        (DataCategory::Chats, Some(owner)) => clear_chats_with_residue(state, Some(owner)).await,
        (DataCategory::Spaces | DataCategory::Memory, Some(_)) => {
            return Err(shared_node_refusal());
        }
    })
}

/// Clear chats (all, or only `owner`'s) and the residue they leave outside the
/// conversation store, as a single delete does: the checkpoint pins that keep
/// copies of the files those chats touched, and their Pi / pi-acp transcripts.
/// The store reads that residue under the same lock as the deletes, so exactly
/// the conversations it removed are released. The release runs in a detached
/// task, batched per folder: it can take a while on large checkpoint stores,
/// and a dropped request must not cancel it after the rows are gone.
async fn clear_chats_with_residue(state: &ServerState, owner: Option<&str>) -> Result<u64, String> {
    clear_chats_detaching_residue(state, owner)
        .await
        .map(|(removed, _release)| removed)
}

/// [`clear_chats_with_residue`], also returning the detached residue release so
/// tests can wait for it.
async fn clear_chats_detaching_residue(
    state: &ServerState,
    owner: Option<&str>,
) -> Result<(u64, Option<tokio::task::JoinHandle<()>>), String> {
    let cleared = match owner {
        None => state.conversations.clear_all_conversations().await,
        Some(owner) => {
            state
                .conversations
                .clear_conversations_owned_by(owner)
                .await
        }
    }
    .map_err(|e| e.to_string())?;
    let release = (!cleared.residue.is_empty())
        .then(|| super::spawn_cleared_residue_release(cleared.residue));
    Ok((cleared.removed, release))
}

/// Clear an app category through every enabled app that declares and serves it.
///
/// Two ways an id fails, and they are different answers. An id no app on this node
/// serves is a bad request. An id an app serves but that app is not enabled here
/// is a 404: the category exists as a concept, this node just does not hold that
/// data, and answering 400 would tell a caller to fix a body that is perfectly
/// well-formed. App data carries no per-user ownership, so an org-bound node
/// refuses it after that check.
async fn clear_requested_app_category(
    state: &ServerState,
    category_id: &str,
    org_bound: bool,
) -> Result<Result<u64, String>, Refusal> {
    let providers: Vec<String> = enabled_app_categories(state)
        .await
        .into_iter()
        .filter(|app| app.served && app.declared.id == category_id)
        .map(|app| app.plugin_id)
        .collect();
    if providers.is_empty() {
        return Err(if category_known_to_any_app(state, category_id).await {
            (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": format!(
                        "data category '{category_id}' is owned by an app that is not enabled on this node"
                    )
                })),
            )
        } else {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("unknown data category '{category_id}'") })),
            )
        });
    }
    if org_bound {
        return Err(shared_node_refusal());
    }
    let consumer = CapabilityConsumer::from_state(state);
    let mut removed = 0u64;
    for provider in providers {
        match purge_app_category(&consumer, &provider, category_id).await {
            Ok(count) => removed += count,
            Err(e) => return Ok(Err(e)),
        }
    }
    Ok(Ok(removed))
}

#[derive(Debug, Deserialize)]
pub struct ResetNodeRequest {
    /// Client-side type-to-confirm echo (the node name). The server only requires it
    /// to be present and non-empty; the exact-name match is a UI guard against an
    /// accidental click, not an auth boundary (auth is the node token / caller).
    #[serde(default)]
    pub confirm: String,
}

/// `POST /api/node/reset`  body: `{ "confirm": "<node name>" }`
///
/// Wipe this ENTIRE node back to a fresh, just-installed state: every store DB,
/// session, download, and preference under the data dir is deleted (only the
/// encryption key is preserved so the node can still boot), then Core restarts and
/// re-runs onboarding. Useful for a clean slate during development.
///
/// The wipe cannot run live (the SQLite files are open), so this handler only ARMS
/// it — it writes a marker and returns `restart_required: true`; the desktop then
/// restarts Core, and the wipe happens at the very start of the next boot
/// (`paths::apply_pending_reset`).
///
/// Refused on an org-bound (shared) node: a full wipe would destroy every user's
/// data and there is no per-user scoping for it — mirrors the danger-zone refusal
/// for shared categories. Personal (unbound) nodes only.
#[utoipa::path(
    post,
    path = "/api/node/reset",
    tag = "Data",
    summary = "Wipe and reset this node to a fresh state (restart required)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn node_reset(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<ResetNodeRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Org-bound node: a full node wipe is never acceptable (it destroys every user's
    // data with no way to scope it). Require a signed-in caller to even learn this,
    // then refuse.
    if super::node_org_id().is_some() {
        if caller.is_none() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "forbidden: a signed-in user is required on a shared node"
                })),
            );
        }
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden: resetting a node wipes ALL data on it and is not allowed on a shared (org-bound) node"
            })),
        );
    }

    if req.confirm.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "confirmation required to reset the node" })),
        );
    }

    match crate::paths::request_node_reset() {
        Ok(()) => {
            // The wipe cannot run while this process (and its sidecars) hold
            // SQLite handles open. Arming the marker alone used to rely on the
            // desktop restarting Core — but in practice that restart was often a
            // no-op (dev: turbo owns Core; release: Tauri lost the child handle
            // and `start` saw "already running"). Exit ourselves after the
            // response flushes so the next boot always consumes the marker.
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                tracing::warn!("node reset armed — stopping sidecars/gateway before exit");
                state.manager.stop_all().await;
                if let Err(e) = state.gateway.stop().await {
                    tracing::warn!("node reset: gateway stop failed: {e}");
                }
                // Brief settle so Windows releases file handles before the
                // replacement process's `apply_pending_reset` runs.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                tracing::warn!("node reset: exiting so wipe can run on next boot");
                std::process::exit(0);
            });
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "restart_required": true })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::Contributes;
    use crate::sidecar::capability_consumer::test_support::{
        fixture_manifest, register_fixture_sidecar, reserve_port, serve, FIXTURE_ID,
    };
    use axum::routing::post;
    use axum::Router;
    use std::sync::{Arc, Mutex};

    fn monitors_category() -> DataCategoryContribution {
        DataCategoryContribution {
            id: "monitors".to_owned(),
            title: "Delete all monitors".to_owned(),
            noun: "monitors".to_owned(),
            confirm_word: Some("Monitors".to_owned()),
            detail: "Every website monitor will be deleted.".to_owned(),
        }
    }

    /// A node whose only app is a fixture declaring the `monitors` category, served
    /// (or not) through the data capabilities, and enabled (or not).
    async fn node_with_app(
        dir: &std::path::Path,
        served: bool,
        enabled: bool,
    ) -> (ServerState, u16) {
        let state = crate::server::isolated_plugin_hook_test_state(dir);
        let port = reserve_port();
        let provides: &[(&str, Option<&str>)] = if served {
            &[
                (CAP_DATA_COUNT, Some("/data/count")),
                (CAP_DATA_PURGE, Some("/data/purge")),
            ]
        } else {
            &[]
        };
        let mut manifest = fixture_manifest(port, provides);
        manifest.contributes = Some(Contributes {
            data_categories: vec![monitors_category()],
            ..Default::default()
        });
        *state.app_manifests.write().await = vec![manifest];
        state.app_store.insert(FIXTURE_ID, "1.0.0").await.unwrap();
        if enabled {
            state.app_store.set_enabled(FIXTURE_ID, &[]).await.unwrap();
        }
        register_fixture_sidecar(&state.manager, port).await;
        (state, port)
    }

    /// The fake app: 3 monitors; records every purge body.
    fn fake_app(purges: Arc<Mutex<Vec<Value>>>) -> Router {
        Router::new()
            .route(
                "/api/fixture/data/count",
                post(|Json(body): Json<Value>| async move {
                    if body["category"] == "monitors" {
                        (StatusCode::OK, Json(json!({ "count": 3 })))
                    } else {
                        (
                            StatusCode::NOT_FOUND,
                            Json(json!({ "error": "unknown category" })),
                        )
                    }
                }),
            )
            .route(
                "/api/fixture/data/purge",
                post(move |Json(body): Json<Value>| {
                    let purges = Arc::clone(&purges);
                    async move {
                        purges.lock().unwrap().push(body);
                        Json(json!({ "removed": 3 }))
                    }
                }),
            )
    }

    async fn clear(state: &ServerState, category: &str) -> (StatusCode, Value) {
        let (status, Json(body)) = data_clear(
            State(state.clone()),
            Extension(None),
            Json(ClearRequest {
                category: category.to_owned(),
            }),
        )
        .await;
        (status, body)
    }

    /// The response keeps every flat key older desktops parse, plus the
    /// `categories` descriptors, and the app row's count comes from the app.
    #[tokio::test]
    async fn counts_keep_their_shape_and_read_app_counts_from_the_provider() {
        let dir = tempfile::tempdir().unwrap();
        let (state, port) = node_with_app(dir.path(), true, true).await;
        let server = serve(port, fake_app(Arc::default())).await;

        let Json(body) = data_counts(State(state)).await;
        for key in ["chats", "spaces", "memory", "monitors", "meetings"] {
            assert!(body[key].is_u64(), "flat key '{key}' missing: {body}");
        }
        assert_eq!(body["monitors"], 3);
        assert_eq!(body["meetings"], 0);
        let categories = body["categories"].as_array().unwrap();
        let ids: Vec<&str> = categories
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["chats", "spaces", "memory", "monitors"]);
        let app_row = &categories[3];
        assert_eq!(app_row["count"], 3);
        assert_eq!(app_row["plugin"], FIXTURE_ID);
        assert_eq!(app_row["confirm_word"], "Monitors");
        for key in ["title", "noun", "detail"] {
            assert!(app_row[key].is_string(), "{key}");
        }
        assert!(categories[0]["plugin"].is_null());
        server.abort();
    }

    /// Clearing an app category purges through the declaring app and answers the
    /// same `{ removed }` body as before; the uninstall cleanup reaches the same
    /// purge.
    #[tokio::test]
    async fn clear_purges_through_the_declaring_app() {
        let dir = tempfile::tempdir().unwrap();
        let (state, port) = node_with_app(dir.path(), true, true).await;
        let purges: Arc<Mutex<Vec<Value>>> = Arc::default();
        let server = serve(port, fake_app(Arc::clone(&purges))).await;

        let (status, body) = clear(&state, "monitors").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "removed": 3 }));
        assert_eq!(
            purges.lock().unwrap().as_slice(),
            &[json!({ "category": "monitors" })]
        );

        let manifest = state.app_manifests.read().await[0].clone();
        assert_eq!(
            app_category_count(&state, &manifest, "monitors").await,
            Some(3)
        );
        assert_eq!(
            clear_app_category(&state, &manifest, "monitors")
                .await
                .unwrap(),
            3
        );
        assert!(clear_app_category(&state, &manifest, "chats")
            .await
            .is_err());
        server.abort();
    }

    /// A disabled app's category is a 404 (the concept exists, this node does not
    /// hold it); an id nothing serves is a 400; neither dials the app.
    #[tokio::test]
    async fn clear_tells_a_disabled_app_apart_from_an_unknown_category() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _port) = node_with_app(dir.path(), true, false).await;
        let (status, body) = clear(&state, "monitors").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        let (status, body) = clear(&state, "bogus").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let Json(counts) = data_counts(State(state)).await;
        assert_eq!(counts["monitors"], 0);
        assert_eq!(counts["categories"].as_array().unwrap().len(), 3);
    }

    /// A category declared without the data capabilities offers no row and cannot
    /// be cleared: a declaration alone is not an implementation.
    #[tokio::test]
    async fn a_declared_but_unserved_category_is_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _port) = node_with_app(dir.path(), false, true).await;
        let Json(counts) = data_counts(State(state.clone())).await;
        assert_eq!(counts["categories"].as_array().unwrap().len(), 3);
        assert_eq!(counts["monitors"], 0);
        let (status, _) = clear(&state, "monitors").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let manifest = state.app_manifests.read().await[0].clone();
        assert_eq!(
            app_category_count(&state, &manifest, "monitors").await,
            None
        );
    }

    async fn uninstall(state: &ServerState, body: Value) -> (StatusCode, Value) {
        let response = crate::server::uninstall_app_handler(
            State(state.clone()),
            axum::extract::Path(FIXTURE_ID.to_owned()),
            axum::extract::Query(crate::server::UninstallAppParams::default()),
            Extension(None),
            axum::body::Bytes::from(body.to_string()),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// Uninstall purges the selected app data through the app BEFORE teardown
    /// (after it, the broker refuses the disabled provider), always deletes the
    /// app's saved secrets, and keeps its key-value storage unless asked.
    #[tokio::test]
    async fn uninstall_purges_before_teardown_drops_secrets_and_keeps_storage_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let (state, port) = node_with_app(dir.path(), true, true).await;
        let manifest = state.app_manifests.read().await[0].clone();
        let purges: Arc<Mutex<Vec<Value>>> = Arc::default();
        let server = serve(port, fake_app(Arc::clone(&purges))).await;

        crate::plugin_secrets::set_global(
            crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
        );
        crate::plugin_storage::set_global(
            crate::plugin_storage::PluginStorage::in_memory().unwrap(),
        );
        let secrets = crate::plugin_secrets::global().unwrap();
        let storage = crate::plugin_storage::global().unwrap();
        secrets.set(FIXTURE_ID, "API_KEY", "s3cret").await.unwrap();
        storage
            .set(FIXTURE_ID, "notes", "draft", "kept")
            .await
            .unwrap();

        let (status, body) = uninstall(&state, json!({ "cleanup": ["data:monitors"] })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["cleanup_errors"], json!([]), "{body}");
        assert_eq!(
            purges.lock().unwrap().as_slice(),
            &[json!({ "category": "monitors" })],
            "the purge must reach the provider before teardown"
        );
        assert!(state
            .app_store
            .get_record(FIXTURE_ID)
            .await
            .unwrap()
            .is_none());
        assert_eq!(secrets.get(FIXTURE_ID, "API_KEY").await.unwrap(), None);
        assert_eq!(
            storage.get(FIXTURE_ID, "notes", "draft").await.unwrap(),
            Some("kept".to_owned())
        );

        // Reinstall, then uninstall with the opt-in flag: storage goes too.
        *state.app_manifests.write().await = vec![manifest];
        state.app_store.insert(FIXTURE_ID, "1.0.0").await.unwrap();
        state.app_store.set_enabled(FIXTURE_ID, &[]).await.unwrap();
        let (status, body) = uninstall(&state, json!({ "delete_storage": true })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            storage.get(FIXTURE_ID, "notes", "draft").await.unwrap(),
            None
        );
        server.abort();
    }

    /// A chat with a folder checkpoint; returns that checkpoint's commit.
    async fn chat_with_checkpoint(
        state: &ServerState,
        conversation_id: &str,
        owner: &str,
        workspace: &std::path::Path,
    ) -> String {
        std::fs::write(workspace.join("notes.txt"), b"private file contents").unwrap();
        state
            .conversations
            .claim_tenancy(conversation_id, owner, None)
            .await
            .unwrap();
        let message = state
            .conversations
            .append_message(conversation_id, "user", "edit notes", None, None, None)
            .await
            .unwrap();
        crate::server::chat_checkpoints::capture_turn(
            &state.conversations,
            conversation_id,
            &message,
            Some(workspace.to_path_buf()),
        )
        .await;
        let rows = state
            .conversations
            .list_chat_checkpoints(conversation_id, 10)
            .await
            .unwrap();
        let record = state
            .conversations
            .get_chat_checkpoint(conversation_id, &rows[0].id)
            .await
            .unwrap()
            .unwrap();
        record.commit_id.expect("folder snapshot captured")
    }

    /// "Clear chats" releases the checkpoint pins of every chat it deletes (the
    /// Git objects holding copies of the files those chats touched), scoped to
    /// the owner on an org-bound node, like a single delete does.
    #[tokio::test]
    async fn clearing_chats_releases_their_checkpoint_pins() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(data.path());
        let checkpoints = ryu_workspace::checkpoints::WorkspaceCheckpoints::new(
            crate::paths::state_path("chat-checkpoints"),
        );
        let alice_folder = tempfile::tempdir().unwrap();
        let bob_folder = tempfile::tempdir().unwrap();
        let alice_conv = format!("conv-clear-alice-{}", uuid::Uuid::new_v4());
        let bob_conv = format!("conv-clear-bob-{}", uuid::Uuid::new_v4());
        let alice_commit =
            chat_with_checkpoint(&state, &alice_conv, "alice", alice_folder.path()).await;
        let bob_commit = chat_with_checkpoint(&state, &bob_conv, "bob", bob_folder.path()).await;
        // Several of alice's chats pin snapshots of one folder; clearing them
        // releases all of them in one batched pass over that store.
        let mut alice_extra = Vec::new();
        for index in 0..3 {
            std::fs::write(
                alice_folder.path().join("draft.txt"),
                format!("alice draft {index}"),
            )
            .unwrap();
            let conv = format!("conv-clear-alice-{index}-{}", uuid::Uuid::new_v4());
            let commit = chat_with_checkpoint(&state, &conv, "alice", alice_folder.path()).await;
            alice_extra.push(commit);
        }
        assert!(checkpoints
            .changes_since(alice_folder.path(), &alice_commit)
            .is_ok());
        for commit in &alice_extra {
            assert!(checkpoints
                .changes_since(alice_folder.path(), commit)
                .is_ok());
        }
        assert!(checkpoints
            .changes_since(bob_folder.path(), &bob_commit)
            .is_ok());

        // Org-bound clear for bob: only bob's snapshot goes.
        let (removed, release) = clear_chats_detaching_residue(&state, Some("bob"))
            .await
            .unwrap();
        assert_eq!(removed, 1);
        release.expect("bob's residue is released").await.unwrap();
        assert!(
            checkpoints
                .changes_since(bob_folder.path(), &bob_commit)
                .is_err(),
            "bob's checkpoint pin must be released by the clear"
        );
        assert!(
            checkpoints
                .changes_since(alice_folder.path(), &alice_commit)
                .is_ok(),
            "an owner-scoped clear must not touch another user's checkpoints"
        );

        // Unbound clear-all through the category path: everything goes, and
        // the release finishes even though the caller does not wait for it.
        let removed = clear_kernel_category(&state, DataCategory::Chats, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(removed, 4);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let released = std::iter::once(&alice_commit)
                .chain(alice_extra.iter())
                .all(|commit| {
                    checkpoints
                        .changes_since(alice_folder.path(), commit)
                        .is_err()
                });
            if released {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "clearing all chats must release every checkpoint pin"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}
