//! Setup and chat-export imports as a durable operation.
//!
//! `POST /api/import/run` with `"async": true` starts one. The runner takes
//! the same per-item path as the plain request ([`ImportSteps`]) and writes a
//! checkpoint after every item, so the batch keeps going when the client goes
//! away and a restarted node continues with the items that are left. The item
//! that was in flight is run again; that is safe because every import item
//! finds what it already wrote (content-hash tags, name checks).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ryu_durable::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{announce_import_complete, import_source_name, ImportSteps};
use crate::background_processes::operations::{
    global, routes::failure, NewOperation, OperationContext, OperationProgress, OperationRunner,
    OperationService,
};
use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
use crate::import::ImportSelection;
use crate::server::*;

/// The operation kind of a setup or chat-export import.
pub(crate) const IMPORT_OPERATION_KIND: &str = "import.setup";

/// What an import needs to run again: the folder, the selected items and who
/// asked. No file content and no credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct ImportInput {
    pub(super) path: String,
    pub(super) items: Vec<StoredSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) caller: Option<StoredCaller>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct StoredSelection {
    pub(super) kind: String,
    pub(super) id: String,
}

/// The caller as the operation keeps it: the user, the organization and the
/// role the request was verified with. No token and no address. A resumed
/// import acts as this caller, which is who the interrupted request acted as.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredCaller {
    pub(super) user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) org_id: Option<String>,
    pub(super) role: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) teams: Vec<StoredTeam>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredTeam {
    pub(super) id: String,
    pub(super) org_id: String,
    pub(super) role: String,
}

impl StoredCaller {
    pub(super) fn of(caller: &VerifiedCaller) -> Self {
        Self {
            user_id: caller.user_id.clone(),
            org_id: caller.org_id.clone(),
            role: caller.role.label().to_owned(),
            teams: caller
                .teams
                .iter()
                .map(|team| StoredTeam {
                    id: team.id.clone(),
                    org_id: team.org_id.clone(),
                    role: team.role.clone(),
                })
                .collect(),
        }
    }

    /// The caller again. A role this build does not know reads as the lowest.
    pub(super) fn to_caller(&self) -> VerifiedCaller {
        VerifiedCaller {
            user_id: self.user_id.clone(),
            email: None,
            email_verified: false,
            org_id: self.org_id.clone(),
            role: OrgRole::from_ba_str(&self.role),
            teams: self
                .teams
                .iter()
                .map(|team| TeamMembership {
                    id: team.id.clone(),
                    org_id: team.org_id.clone(),
                    role: team.role.clone(),
                })
                .collect(),
        }
    }
}

/// The input of an import of `items` from `root` by `caller`.
pub(super) fn import_input(
    caller: &Option<VerifiedCaller>,
    root: &Path,
    items: &[ImportSelection],
) -> ImportInput {
    ImportInput {
        path: root.to_string_lossy().into_owned(),
        items: items
            .iter()
            .map(|item| StoredSelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
            })
            .collect(),
        caller: caller.as_ref().map(StoredCaller::of),
    }
}

/// Start the import as an operation on `service` and answer with its id: 202
/// for a new operation, 200 when the idempotency key named one that exists.
pub(super) async fn start_import_operation(
    service: &OperationService,
    caller: &Option<VerifiedCaller>,
    root: &Path,
    items: Vec<ImportSelection>,
    idempotency_key: Option<String>,
) -> axum::response::Response {
    let input = match serde_json::to_value(import_input(caller, root, &items)) {
        Ok(input) => input,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let new = NewOperation {
        kind: IMPORT_OPERATION_KIND.to_owned(),
        title: import_source_name(root).to_owned(),
        owner_user_id: caller.as_ref().map(|verified| verified.user_id.clone()),
        input,
        idempotency_key,
    };
    match service.start(new).await {
        Ok((record, created)) => {
            let status = if created {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            };
            let mut body = serde_json::Map::new();
            body.insert("operationId".to_owned(), Value::String(record.id.clone()));
            body.insert(
                "operation".to_owned(),
                serde_json::to_value(record.summary()).unwrap_or(Value::Null),
            );
            (status, Json(Value::Object(body))).into_response()
        }
        Err(error) => failure(&error),
    }
}

/// [`start_import_operation`] on the node's own operations service.
pub(super) async fn start_on_node(
    caller: &Option<VerifiedCaller>,
    root: &Path,
    items: Vec<ImportSelection>,
    idempotency_key: Option<String>,
) -> axum::response::Response {
    match global() {
        Ok(service) => start_import_operation(&service, caller, root, items, idempotency_key).await,
        Err(error) => failure(&error),
    }
}

/// Runs an import operation against one node state.
pub(super) struct ImportOperationRunner {
    state: ServerState,
}

impl OperationRunner for ImportOperationRunner {
    /// Every import item is repeat-safe, so a restart may continue the batch.
    fn resumable(&self) -> bool {
        true
    }

    fn run<'a>(&'a self, context: OperationContext) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(self.run_import(context))
    }
}

impl ImportOperationRunner {
    async fn run_import(&self, context: OperationContext) -> Result<Value, String> {
        let record = context.record();
        let input: ImportInput = serde_json::from_value(record.input.clone())
            .map_err(|_| String::from("The stored import request cannot be read."))?;
        let total = input.items.len();
        // The outcomes of the items a previous start finished, as it stored them.
        let mut results = stored_results(&record.cursor);
        results.truncate(total);
        let root = PathBuf::from(&input.path);
        let caller = input.caller.as_ref().map(StoredCaller::to_caller);
        let left: Vec<ImportSelection> = input.items[results.len()..]
            .iter()
            .map(|item| ImportSelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
            })
            .collect();

        let mut steps = ImportSteps::open(&self.state, &caller, &root, &left).await;
        for selection in &left {
            if context.is_cancelled() {
                break;
            }
            context
                .progress(progress(results.len(), total).with_label(selection.id.clone()))
                .await;
            let outcome = steps.apply(selection).await;
            results.push(serde_json::to_value(&outcome).map_err(|e| e.to_string())?);
            context
                .checkpoint(cursor_of(&results))
                .await
                .map_err(|e| e.to_string())?;
        }
        context.progress(progress(results.len(), total)).await;

        if results.len() == total {
            announce_import_complete(
                &root,
                count(&results, "imported"),
                count(&results, "skipped"),
                count(&results, "failed"),
                record.owner_user_id.clone(),
            );
        }
        let mut result = serde_json::Map::new();
        result.insert("root".to_owned(), Value::String(input.path));
        result.insert("results".to_owned(), Value::Array(results));
        Ok(Value::Object(result))
    }
}

fn progress(done: usize, total: usize) -> OperationProgress {
    OperationProgress::steps(done as u64, total as u64)
}

/// The checkpoint: the outcome of every finished item, in order.
pub(super) fn cursor_of(results: &[Value]) -> Value {
    let mut cursor = serde_json::Map::new();
    cursor.insert("results".to_owned(), Value::Array(results.to_vec()));
    Value::Object(cursor)
}

fn stored_results(cursor: &Value) -> Vec<Value> {
    cursor
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn count(results: &[Value], status: &str) -> usize {
    results
        .iter()
        .filter(|outcome| outcome.get("status").and_then(Value::as_str) == Some(status))
        .count()
}

/// Register the import runner on `service` for `state`.
pub(super) fn register_import_runner(service: &OperationService, state: ServerState) {
    service.register_runner(
        IMPORT_OPERATION_KIND,
        Arc::new(ImportOperationRunner { state }),
    );
}

/// Register the import runner with the node's operations service. Called
/// while the router is built, before interrupted operations are recovered.
pub(crate) fn register_import_operation_runner(state: &ServerState) {
    match global() {
        Ok(service) => register_import_runner(&service, state.clone()),
        Err(error) => {
            tracing::warn!(%error, "imports cannot run as operations: the store did not open");
        }
    }
}

#[cfg(test)]
#[path = "operation_tests.rs"]
mod tests;
