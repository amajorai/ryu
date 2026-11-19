//! `POST /api/vault/bulk`: set, delete and move many values in one request.
//!
//! Each item runs through exactly the route a single request would take
//! ([`put_secret_with`], [`delete_secret_with`], [`move_secret_with`]), so
//! policies, parameter constraints, protected-environment change requests,
//! check-and-set, namespace locks and control-plane forwarding apply per
//! item, and the store writes one audit row per item. Items are independent:
//! one refusal does not stop the others, and the response carries a result
//! per item in request order. The request is not a transaction.

use super::*;

/// Most items one bulk request may carry.
pub const MAX_BULK_ITEMS: usize = 100;

/// Body of `POST /api/vault/bulk`.
#[derive(Debug, Deserialize)]
pub struct BulkBody {
    pub(crate) items: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct BulkHead {
    op: String,
    name: String,
}

async fn run_item(ctx: &Ctx, item: Value) -> (Option<String>, Option<String>, Response) {
    let head: BulkHead = match serde_json::from_value(item.clone()) {
        Ok(head) => head,
        Err(error) => return (None, None, invalid_request(&format!("item: {error}"))),
    };
    let mut rest = item;
    if let Some(object) = rest.as_object_mut() {
        object.remove("op");
        object.remove("name");
    }
    let response = match head.op.as_str() {
        "set" => put_secret_with(ctx, &head.name, rest).await,
        "delete" => match parse_body::<DeleteSecretBody>(rest) {
            Ok(body) => delete_secret_with(ctx, &head.name, body).await,
            Err(response) => response,
        },
        "move" => match parse_body::<SecretMoveBody>(rest) {
            Ok(body) => move_secret_with(ctx, &head.name, body).await,
            Err(response) => response,
        },
        _ => invalid_request("op must be `set`, `delete` or `move`"),
    };
    (Some(head.op), Some(head.name), response)
}

async fn response_json(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    (status, body)
}

pub(crate) async fn bulk_with(ctx: &Ctx, body: BulkBody) -> Response {
    if body.items.is_empty() || body.items.len() > MAX_BULK_ITEMS {
        return invalid_request(&format!("send 1 to {MAX_BULK_ITEMS} items"));
    }
    let mut results = Vec::with_capacity(body.items.len());
    let mut failed = 0;
    for (index, item) in body.items.into_iter().enumerate() {
        let (op, name, response) = run_item(ctx, item).await;
        let (status, value) = response_json(response).await;
        let ok = status.is_success();
        if !ok {
            failed += 1;
        }
        let mut result = json!({
            "index": index,
            "op": op,
            "name": name,
            "status": status.as_u16(),
            "ok": ok,
        });
        if let Some(object) = result.as_object_mut() {
            match value.get("error") {
                Some(error) if !ok => {
                    object.insert("error".into(), error.clone());
                }
                _ => {
                    object.insert("result".into(), value);
                }
            }
        }
        results.push(result);
    }
    // Item bodies were already rendered by their own routes.
    no_store_response(
        Json(json!({ "ok": failed == 0, "failed": failed, "results": results })).into_response(),
    )
}

/// POST /api/vault/bulk.
#[utoipa::path(post, path = "/api/vault/bulk", tag = "Vault",
    summary = "Set, delete or move up to 100 values, with a result per item",
    request_body = serde_json::Value,
    responses((status = 200, description = "One result per item, in request order", body = serde_json::Value)))]
pub async fn bulk(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<BulkBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    bulk_with(&ctx, body).await
}

#[cfg(test)]
#[path = "bulk_tests.rs"]
mod tests;
