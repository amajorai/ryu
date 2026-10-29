//! Owner-only history API. Imports run on the node and return usage metadata only.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use axum::{
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;

use super::{
    HistoryQuery, HistorySource, HistorySummary, ImportRequest, ModelRates, UsageHistoryStore,
};

static STORE: OnceLock<UsageHistoryStore> = OnceLock::new();
static OPERATIONS: OnceLock<super::operations::ImportOperations> = OnceLock::new();

pub(crate) fn install(store: UsageHistoryStore) {
    let _ = STORE.set(store);
    match super::operations::ImportOperations::open_default() {
        Ok(operations) => {
            let _ = OPERATIONS.set(operations);
        }
        Err(_) => tracing::warn!("Usage history import progress is unavailable"),
    }
}
/// Install a ledger and progress store from a test, without the default data-dir
/// progress file. Like [`install`], the first installation wins for the process.
#[cfg(test)]
pub(super) fn install_for_test(
    store: UsageHistoryStore,
    operations: super::operations::ImportOperations,
) {
    let _ = STORE.set(store);
    let _ = OPERATIONS.set(operations);
}
pub(crate) fn store() -> Option<&'static UsageHistoryStore> {
    STORE.get()
}

pub(crate) fn routes() -> Router<crate::server::ServerState> {
    Router::new()
        .route("/api/usage/history", get(history))
        .route("/api/usage/history/import", post(import))
        .route(
            "/api/usage/history/import/operations/:id",
            get(import_operation),
        )
        .route("/api/usage/history/account-sync", post(account_sync))
        .route(
            "/api/usage/history/tracking",
            get(tracking).put(set_tracking),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
}

fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({"code":code,"error":message})),
    )
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryResponse {
    summary: HistorySummary,
    sources: Vec<HistorySource>,
}

#[utoipa::path(get, path="/api/usage/history", tag="Agents", summary="Historical usage metadata by scope", description="Node owner only. UTC date filters; scope is session by default, account, organization, unattributed, or unreconciled. Unreconciled live usage retains known native session identity but has unresolved event overlap with imported native history and is excluded from session totals. Older Ryu counters without persisted native session identity remain unattributed. API-equivalent estimates use current catalog prices; reported charges remain separate. Missing fields remain unknown.", params(("startDate"=Option<String>,Query),("endDate"=Option<String>,Query),("scope"=Option<String>,Query)), responses((status=200,body=serde_json::Value),(status=400,description="Invalid scope or dates"),(status=403,description="Node owner required"),(status=503,description="History unavailable")))]
pub(crate) async fn history(Query(query): Query<HistoryQuery>) -> Response {
    let Some(store) = store().cloned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Usage history is unavailable on this node.",
        );
    };
    let records_store = store.clone();
    let records_query = query.clone();
    let records =
        match tokio::task::spawn_blocking(move || records_store.records(&records_query)).await {
            Ok(Ok(records)) => records,
            Ok(Err(_)) => {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "invalid_history_query",
                    "Choose valid UTC dates and one history scope.",
                );
            }
            Err(_) => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "history_read_failed",
                    "Could not read usage history.",
                );
            }
        };
    let pairs: BTreeSet<_> = records
        .iter()
        .filter_map(|r| {
            r.model_id
                .as_ref()
                .map(|model| (r.provider_id.clone().unwrap_or_default(), model.clone()))
        })
        .collect();
    let prices: BTreeMap<_, _> = stream::iter(pairs)
        .map(|(provider, model)| async move {
            let meta = ryu_model_catalog::models_dev::meta_for(
                &model,
                (!provider.is_empty()).then_some(provider.as_str()),
            )
            .await;
            let rate = |value: Option<f64>| value.filter(|v| v.is_finite() && *v >= 0.0);
            let rates = meta
                .map(|m| ModelRates {
                    input: rate(m.cost_input_per_1m),
                    output: rate(m.cost_output_per_1m),
                    cache_read: rate(m.cost_cache_read_per_1m),
                    cache_write: rate(m.cost_cache_write_per_1m),
                })
                .unwrap_or_default();
            ((provider, model), rates)
        })
        .buffer_unordered(8)
        .collect()
        .await;
    match tokio::task::spawn_blocking(move || store.summary(&query, &prices)).await {
        Ok(Ok(summary)) => Json(HistoryResponse {
            summary,
            sources: {
                let mut sources = super::sources(&dirs::home_dir().unwrap_or_default());
                sources.push(HistorySource { id: "ryu-sessions".into(), label: "Saved Ryu sessions".into(), transport: "localFiles".into(), available: true, limitations: "Imports saved completed-turn usage parts, never conversation bodies. Missing counters and unbound native sessions remain incomplete.".into() });
                sources
            },
        })
        .into_response(),
        _ => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "history_read_failed",
            "Could not summarize usage history.",
        ),
    }
}

#[utoipa::path(post, path="/api/usage/history/import", tag="Agents", summary="Start a resumable usage metadata import", description="Node owner only. Returns a durable background operation immediately. Poll its operations URL for progress and the final report. Repeating the same selection while running returns the same operation. sourceIds select adapters, roots contain explicit local sourceId/path/accountId, and maxFiles bounds each batch. hasMore in the completed report means repeat the selection to resume checkpoints. Client disconnects stop polling, not the import. No conversations or credentials are uploaded.", request_body=serde_json::Value, responses((status=202,body=super::operations::ImportOperation),(status=400,description="Invalid import selection"),(status=403,description="Node owner required"),(status=409,description="A different import is running"),(status=503,description="History unavailable")))]
pub(crate) async fn import(
    State(state): State<crate::server::ServerState>,
    Json(mut input): Json<ImportRequest>,
) -> Response {
    let known_source = |id: &str| {
        id == "ryu-sessions"
            || super::scan::roots(&dirs::home_dir().unwrap_or_default(), id).is_some()
            || super::scan::EXPORT_SOURCES.contains(&id)
    };
    if input.source_ids.len() > 32
        || input.roots.len() > 32
        || input.source_ids.iter().any(|id| !known_source(id))
        || input.roots.iter().any(|root| {
            root.source_id == "ryu-sessions"
                || !known_source(&root.source_id)
                || !std::path::Path::new(&root.path).is_absolute()
        })
        || input
            .max_files
            .is_some_and(|maximum| !(1..=10000).contains(&maximum))
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "invalid_history_import",
            "Choose supported sources, absolute local paths, and a batch size from 1 to 10000.",
        );
    }
    let (Some(store), Some(operations)) = (store().cloned(), OPERATIONS.get().cloned()) else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Usage history import progress is unavailable on this node.",
        );
    };
    input.source_ids.sort();
    input.source_ids.dedup();
    input.roots.sort_by(|left, right| {
        (&left.source_id, &left.path, &left.account_id).cmp(&(
            &right.source_id,
            &right.path,
            &right.account_id,
        ))
    });
    input.roots.dedup_by(|left, right| {
        left.source_id == right.source_id
            && left.path == right.path
            && left.account_id == right.account_id
    });
    let selection = serde_json::json!({"sourceIds":input.source_ids,"roots":input.roots,"retryFailed":input.retry_failed});
    let digest = super::adapters::digest(&selection.to_string());
    let (operation, start) = match operations.start(&digest) {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::CONFLICT,"history_import_running","A different history import is running. Wait for it to finish before changing the selection."),
    };
    if start {
        let (id, started_at) = match &operation {
            super::operations::ImportOperation::Running { id, started_at, .. } => {
                (id.clone(), started_at.clone())
            }
            _ => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "history_import_failed",
                    "Could not start history import.",
                )
            }
        };
        tokio::spawn(async move {
            let result = run_import(
                state,
                store,
                input,
                operations.clone(),
                id.clone(),
                started_at.clone(),
            )
            .await;
            let completed_at = chrono::Utc::now().to_rfc3339();
            let terminal = match result {
                Ok(report) => {
                    tracing::info!(operation_id=%id,imported_records=report.imported_records,updated_records=report.updated_records,skipped_files=report.skipped_files,error_count=report.error_count,"usage history import completed");
                    super::operations::ImportOperation::Completed {id,started_at,completed_at,report}
                }
                Err(_) => super::operations::ImportOperation::Failed {id,started_at,completed_at,error:"This import could not finish. Check the source selection and retry to resume its saved checkpoints.".into()},
            };
            if operations.update(&terminal).is_err() {
                tracing::warn!("Usage import terminal progress could not be saved");
            }
        });
    }
    (StatusCode::ACCEPTED, Json(operation)).into_response()
}

async fn run_import(
    state: crate::server::ServerState,
    store: UsageHistoryStore,
    mut input: ImportRequest,
    operations: super::operations::ImportOperations,
    id: String,
    started_at: String,
) -> anyhow::Result<super::ImportReport> {
    let default_all = input.source_ids.is_empty() && input.roots.is_empty();
    let include_saved = input
        .source_ids
        .iter()
        .any(|source| source == "ryu-sessions")
        || default_all;
    input.source_ids.retain(|source| source != "ryu-sessions");
    let include_local = default_all || !input.source_ids.is_empty() || !input.roots.is_empty();
    let saved = if include_saved {
        match super::ryu_sessions::import(&state, input.max_files.unwrap_or(2000)).await {
            Ok(report) => report,
            Err(_) => super::ImportReport {
                error_count: 1,
                errors: vec!["Saved Ryu usage metadata could not be read.".into()],
                ..Default::default()
            },
        }
    } else {
        super::ImportReport::default()
    };
    tokio::task::spawn_blocking(move || {
        let mut progress = |report: &super::ImportReport| {
            let operation = super::operations::ImportOperation::Running {
                id: id.clone(),
                started_at: started_at.clone(),
                progress: combine_reports(report.clone(), &saved),
            };
            if operations.update(&operation).is_err() {
                tracing::warn!("Usage import progress could not be saved");
            }
        };
        progress(&super::ImportReport::default());
        let report = if include_local {
            store.import_local_with_progress(&input, &mut progress)?
        } else {
            super::ImportReport::default()
        };
        Ok::<_, anyhow::Error>(combine_reports(report, &saved))
    })
    .await?
}

fn combine_reports(
    mut report: super::ImportReport,
    saved: &super::ImportReport,
) -> super::ImportReport {
    report.scanned_files += saved.scanned_files;
    report.imported_records += saved.imported_records;
    report.updated_records += saved.updated_records;
    report.duplicate_records += saved.duplicate_records;
    report.skipped_files += saved.skipped_files;
    report.error_count += saved.error_count;
    report.has_more |= saved.has_more;
    report.errors.extend(saved.errors.iter().cloned());
    report.errors.truncate(20);
    report
}

#[utoipa::path(get,path="/api/usage/history/import/operations/{id}",tag="Agents",summary="Read durable import progress",description="Node owner only. Progress uses a separate store so a large history file cannot block polling. Completed operations include the final report; interrupted imports become failed with safe checkpoint-resume guidance on restart.",params(("id"=String,Path)),responses((status=200,body=super::operations::ImportOperation),(status=400,description="Invalid operation identifier"),(status=403,description="Node owner required"),(status=404,description="Operation not retained"),(status=503,description="Progress unavailable")))]
pub(crate) async fn import_operation(AxumPath(id): AxumPath<String>) -> Response {
    if uuid::Uuid::parse_str(&id).is_err() {
        return failure(
            StatusCode::BAD_REQUEST,
            "invalid_import_operation",
            "Choose a valid import operation.",
        );
    }
    let Some(operations) = OPERATIONS.get() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Usage import progress is unavailable.",
        );
    };
    match operations.get(&id) {
        Ok(Some(operation)) => Json(operation).into_response(),
        Ok(None) => failure(
            StatusCode::NOT_FOUND,
            "import_operation_not_found",
            "This import operation is no longer retained. Import the same selection to resume.",
        ),
        Err(_) => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_progress_failed",
            "Could not read import progress. Retry shortly.",
        ),
    }
}

#[utoipa::path(post, path="/api/usage/history/account-sync", tag="Agents", summary="Import an authorized provider history page", description="Node owner only. Uses an explicit transient admin credential with fixed HTTPS provider endpoints. No redirects, credential persistence, credential echo or conversation upload. Provide sourceId, accountId, credential, UTC startDate/endDate and optional opaque cursor. Response nextCursor supports resumable pages. Account and organization reports are separate from session history to avoid overlapping totals.", request_body=serde_json::Value, responses((status=200,body=serde_json::Value),(status=400,description="Invalid dates or source"),(status=403,description="Owner or provider authorization required"),(status=429,description="Provider rate limit"),(status=502,description="Provider request failed")))]
pub(crate) async fn account_sync(
    Json(input): Json<super::provider_api::AccountSyncInput>,
) -> Response {
    let Some(store) = store().cloned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Usage history is unavailable on this node.",
        );
    };
    match super::provider_api::sync_page(&store, input).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => failure(error.status, error.code, error.message),
    }
}

#[derive(serde::Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tracking {
    enabled: bool,
}

#[utoipa::path(get,path="/api/usage/history/tracking",tag="Agents",summary="Read history tracking consent",responses((status=200,body=Tracking),(status=503,description="Store unavailable")))]
pub(crate) async fn tracking() -> Response {
    match store().map(UsageHistoryStore::is_enabled) {
        Some(Ok(enabled)) => Json(Tracking { enabled }).into_response(),
        _ => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Usage history is unavailable on this node.",
        ),
    }
}

#[utoipa::path(put,path="/api/usage/history/tracking",tag="Agents",summary="Opt into future ACP usage metadata",description="Node owner only. Off by default. Retains previously recorded metadata when disabled. Only reported turn tokens are retained, never prompts or context occupancy.",request_body=Tracking,responses((status=200,body=Tracking),(status=503,description="Store unavailable")))]
pub(crate) async fn set_tracking(Json(input): Json<Tracking>) -> Response {
    match store().map(|store| store.set_enabled(input.enabled)) {
        Some(Ok(())) => Json(input).into_response(),
        _ => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Could not save history tracking.",
        ),
    }
}
