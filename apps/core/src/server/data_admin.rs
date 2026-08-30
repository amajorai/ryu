//! "Danger zone" bulk data administration (`/api/data/*`).
//!
//! One auditable place for the destructive, irreversible "delete all X" actions
//! the desktop's Settings → Danger Zone tab exposes: wipe all chats, all spaces,
//! all long-term memory, all website monitors, or all meetings. Each category is
//! cleared by either a flat truncate (chats/memory/spaces, where the store owns a
//! transactional `clear_all`) or by looping the existing per-item delete (monitors
//! and meetings) so the side effects a single delete handles — tearing down a
//! monitor's backing scheduler job, broadcasting SSE — are preserved.
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
//! - **App categories** (monitors/meetings today) are declared by the owning app's
//!   manifest, in `contributes.data_categories`. They are served ONLY while that app
//!   is installed and enabled, which is what makes the row appear and disappear with
//!   the app instead of being permanently welded into the desktop.
//!
//! The copy (title, noun, confirm word, the "what disappears" line) travels with
//! the descriptor either way, so `GET /api/data/counts` returns everything a client
//! needs to draw the whole section and the desktop holds no per-category list at
//! all. What Core keeps is the *implementation*: [`clear_category`] is the only
//! place that knows a monitor delete has to tear down a scheduler job.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;

/// The data categories a danger-zone clear can target.
///
/// Still an enum, and deliberately so: an id only reaches this type once Core has an
/// implementation for it, so "a category exists" and "Core can actually delete it"
/// cannot drift apart. The manifest half is a *declaration* — it decides whether a
/// row is offered and what it says, not what deleting entails (see the module docs).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataCategory {
    /// All conversations + their messages and sessions.
    Chats,
    /// All Spaces + their documents, chunks, and vectors.
    Spaces,
    /// All long-term memory entries.
    Memory,
    /// All website monitors (+ their backing scheduler jobs).
    Monitors,
    /// All meeting records.
    Meetings,
}

impl DataCategory {
    /// Resolve the wire id (`"monitors"`) a manifest declares, or a request names.
    ///
    /// The one id↔variant table. `serde` alone is not enough any more: the clear
    /// request now carries a free-form `String` (see [`ClearRequest`]) precisely so
    /// an unknown id reaches the handler and gets a diagnostic, instead of being
    /// rejected as a 422 before the body runs.
    fn from_id(id: &str) -> Option<Self> {
        match id {
            "chats" => Some(Self::Chats),
            "spaces" => Some(Self::Spaces),
            "memory" => Some(Self::Memory),
            "monitors" => Some(Self::Monitors),
            "meetings" => Some(Self::Meetings),
            _ => None,
        }
    }

    /// Wire id — the value a client puts in `POST /api/data/clear`.
    const fn id(self) -> &'static str {
        match self {
            Self::Chats => "chats",
            Self::Spaces => "spaces",
            Self::Memory => "memory",
            Self::Monitors => "monitors",
            Self::Meetings => "meetings",
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

/// `GET /api/data/counts`
///
/// How many items each danger-zone category currently holds, so the desktop can
/// render "Delete all 42 chats?" before the user commits. Best-effort per field:
/// a store error surfaces as `0` for that category rather than failing the whole
/// response (the worst case is an under-count in the confirm dialog).
#[utoipa::path(
    get,
    path = "/api/data/counts",
    tag = "Data",
    summary = "Counts of deletable user-data categories",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn data_counts(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let chats = count_category(&state, DataCategory::Chats).await;
    let spaces = count_category(&state, DataCategory::Spaces).await;
    let memory = count_category(&state, DataCategory::Memory).await;
    // Monitors and meetings are counted even when their app is disabled, because the
    // flat keys below are read by clients that know nothing about enablement.
    let monitors = count_category(&state, DataCategory::Monitors).await;
    let meetings = count_category(&state, DataCategory::Meetings).await;
    // Every count is taken exactly once above and then read from here — the
    // descriptors and the flat keys describe the same node, so counting twice would
    // let them disagree within one response.
    let count_of = |category: DataCategory| match category {
        DataCategory::Chats => chats,
        DataCategory::Spaces => spaces,
        DataCategory::Memory => memory,
        DataCategory::Monitors => monitors,
        DataCategory::Meetings => meetings,
    };

    // The descriptor list — every row the danger zone should draw, kernel-owned
    // first and then whatever the enabled apps declare, each with its own copy and
    // live count. Clients build the section from this alone.
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
    for (plugin_id, declared) in enabled_app_categories(&state).await {
        // Declaration without implementation. Serving it would put a button in the
        // danger zone that 400s, so skip it — but say so, because from the app
        // author's side a silently missing row is indistinguishable from a typo in
        // the manifest.
        let Some(category) = DataCategory::from_id(&declared.id) else {
            tracing::warn!(
                "app '{plugin_id}' declares data category '{}', which this Core has no clear \
                 implementation for — the danger-zone row is omitted",
                declared.id
            );
            continue;
        };
        categories.push(json!({
            "id": declared.id,
            "title": declared.title,
            "noun": declared.noun,
            "confirm_word": declared.confirm_word(),
            "detail": declared.detail,
            "count": count_of(category),
            "plugin": plugin_id,
        }));
    }

    Json(json!({
        // The flat per-category keys predate `categories` and stay: they are the
        // shape older desktops parse, and dropping them would blank the counts on
        // every client that has not been updated alongside this node.
        "chats": chats,
        "spaces": spaces,
        "memory": memory,
        "monitors": monitors,
        "meetings": meetings,
        "categories": categories,
    }))
}

/// Every `contributes.data_categories` entry of every **enabled** app, paired with
/// the id of the app that declared it.
///
/// Enablement is checked here, server-side, rather than left to the client: the
/// desktop used to feature-detect the owning app itself, which meant every other
/// surface (island, web, a script) either re-implemented the same filter or offered
/// to delete data from an app the node does not run.
async fn enabled_app_categories(
    state: &ServerState,
) -> Vec<(String, crate::plugin_manifest::DataCategoryContribution)> {
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
        for category in &contributes.data_categories {
            out.push((manifest.id.clone(), category.clone()));
        }
    }
    out
}

/// How many items one category holds. Best-effort: an unreachable sidecar or a
/// store error reads as `0`, so the worst case is an under-count in the confirm
/// dialog rather than a failed page.
async fn count_category(state: &ServerState, category: DataCategory) -> u64 {
    match category {
        DataCategory::Chats => state.conversations.count_conversations().await.unwrap_or(0),
        DataCategory::Spaces => state.spaces.count_spaces().await.unwrap_or(0),
        DataCategory::Memory => state.memory.count().await.unwrap_or(0),
        DataCategory::Monitors => match crate::monitors_client::global_client() {
            Some(client) => client.list_monitors().await.map(|m| m.len()).unwrap_or(0) as u64,
            None => 0,
        },
        DataCategory::Meetings => state
            .meetings
            .list()
            .await
            .map(|m| m.len() as u64)
            .unwrap_or(0),
    }
}

/// Count one app-declared data category for the uninstall inventory. A category
/// is only resolvable when both halves exist: the manifest declares it and Core
/// has a concrete implementation for its id.
pub(crate) async fn app_category_count(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    category_id: &str,
) -> Option<u64> {
    let declared = manifest.contributes.as_ref().is_some_and(|contributes| {
        contributes
            .data_categories
            .iter()
            .any(|category| category.id == category_id)
    });
    if !declared {
        return None;
    }
    let category = DataCategory::from_id(category_id)?;
    Some(count_category(state, category).await)
}

/// Clear one app-declared data category through the same per-item side effects
/// as the danger-zone endpoint. Unknown declarations fail closed instead of
/// silently reporting success to uninstall.
pub(crate) async fn clear_app_category(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    category_id: &str,
) -> anyhow::Result<u64> {
    let declared = manifest.contributes.as_ref().is_some_and(|contributes| {
        contributes
            .data_categories
            .iter()
            .any(|category| category.id == category_id)
    });
    if !declared {
        anyhow::bail!("data category '{category_id}' is not declared by this app");
    }
    match DataCategory::from_id(category_id) {
        Some(DataCategory::Monitors) => clear_all_monitors(state).await.map_err(anyhow::Error::msg),
        Some(DataCategory::Meetings) => clear_all_meetings(state).await.map_err(anyhow::Error::msg),
        Some(category) => anyhow::bail!(
            "data category '{}' is Core-owned and cannot be cleared as app data",
            category.id()
        ),
        None => anyhow::bail!("Core has no clear implementation for '{category_id}'"),
    }
}

/// `POST /api/data/clear`  body: `{ "category": "chats" }`
///
/// Irreversibly delete every item in one category. Returns `{ removed: N }` with
/// the number of top-level items deleted. Monitors and meetings are cleared by
/// looping the existing per-item delete so their side effects (scheduler-job
/// teardown, SSE) fire; the rest use the store's transactional `clear_all`.
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
    // token could truncate EVERY user's chats, spaces, memory, monitors and meetings.
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

    // ── Resolve the requested id ─────────────────────────────────────────────
    // Two ways an id fails, and they are different answers. An id no build of Core
    // implements is a bad request. An id that IS implemented but whose owning app is
    // not enabled here is a 404: the category exists as a concept, this node just
    // does not hold that data — and answering 400 would tell a caller to fix a body
    // that is perfectly well-formed.
    let Some(category) = DataCategory::from_id(req.category.trim()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("unknown data category '{}'", req.category)
            })),
        );
    };
    let kernel_owned = KERNEL_CATEGORIES.iter().any(|k| k.category == category);
    if !kernel_owned
        && !enabled_app_categories(&state)
            .await
            .iter()
            .any(|(_, declared)| declared.id == category.id())
    {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": format!(
                    "data category '{}' is owned by an app that is not enabled on this node",
                    category.id()
                )
            })),
        );
    }

    let result: Result<u64, String> = match (category, bound_owner.as_deref()) {
        // ── Unbound personal node: unchanged behaviour ───────────────────────
        (DataCategory::Chats, None) => state
            .conversations
            .clear_all_conversations()
            .await
            .map_err(|e| e.to_string()),
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
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": error.to_string() })),
                );
            }
            state
                .memory
                .clear_all()
                .await
                .map_err(|error| error.to_string())
        }
        (DataCategory::Monitors, None) => clear_all_monitors(&state).await,
        (DataCategory::Meetings, None) => clear_all_meetings(&state).await,

        // ── Org-bound node: scope, or refuse ─────────────────────────────────
        (DataCategory::Chats, Some(owner)) => state
            .conversations
            .clear_conversations_owned_by(owner)
            .await
            .map_err(|e| e.to_string()),
        (
            DataCategory::Spaces
            | DataCategory::Memory
            | DataCategory::Monitors
            | DataCategory::Meetings,
            Some(_),
        ) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "forbidden: this category cannot be cleared on a shared (org-bound) node —                               it carries no per-user ownership, so clearing it would destroy other users' data"
                })),
            );
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

/// Loop the per-monitor delete so each monitor's backing scheduler job is torn down
/// (a flat SQL truncate would leave `monitor-<id>` jobs ticking forever). Monitors are
/// out-of-process (`ryu-monitors` sidecar): list + delete rows over the loopback
/// client, and tear the `JobTarget::Monitor` job down Core-side (the sidecar stubs
/// `remove_backing_job`).
async fn clear_all_monitors(_state: &ServerState) -> Result<u64, String> {
    let Some(client) = crate::monitors_client::global_client() else {
        return Ok(0);
    };
    let monitors = client.list_monitors().await.unwrap_or_default();
    let mut removed = 0u64;
    for monitor in monitors {
        let Some(id) = monitor.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        // Tear down the backing scheduler job first (best-effort), then the row.
        crate::monitors_client::clear_backing_job(id);
        if client.delete_monitor(id).await.unwrap_or(false) {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Loop the per-meeting delete so each delete broadcasts on the meetings SSE
/// stream the desktop/island listen to. Meetings is out-of-process (`ryu-meetings`
/// sidecar): list + delete rows over the loopback client.
async fn clear_all_meetings(state: &ServerState) -> Result<u64, String> {
    let meetings = state.meetings.list().await?;
    let mut removed = 0u64;
    for meeting in meetings {
        let Some(id) = meeting.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if state.meetings.delete(id).await? {
            removed += 1;
        }
    }
    Ok(removed)
}
