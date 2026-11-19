//! Transit `batchInput` and the CMAC verify route.
//!
//! [`transit_batch_op`] runs after [`transit_op`] has authorized the caller
//! for the key (one policy check covers the batch; every item is still
//! audited by the store). The response is `{"batchResults": [...]}` in input
//! order, each item carrying its output or its own `error`. The status is 200
//! when any item succeeded and 400 when every item failed, as Vault answers
//! a batch whose items all fail.

use super::*;
use crate::vault::transit::{TransitBatchResult, MAX_BATCH_ITEMS};

/// Fields of the request body that serve as defaults for every item.
fn batch_defaults(body: &TransitOpBody) -> TransitBatchItem {
    TransitBatchItem {
        context: body.context.clone(),
        associated_data: body.associated_data.clone(),
        key_version: body.key_version,
        signature_algorithm: body.signature_algorithm.clone(),
        mac_length: body.mac_length,
        ..TransitBatchItem::default()
    }
}

/// 200 when any item succeeded, 400 when all failed.
pub(super) fn batch_status(results: &[TransitBatchResult]) -> StatusCode {
    if results.iter().all(TransitBatchResult::is_error) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::OK
    }
}

pub(super) async fn transit_batch_op(
    who: &Who,
    op: &str,
    name: &str,
    items: &[TransitBatchItem],
    body: &TransitOpBody,
) -> Response {
    let Some(batch_op) = TransitBatchOp::parse(op) else {
        return invalid_request(&format!("`{op}` does not accept batchInput"));
    };
    if items.len() > MAX_BATCH_ITEMS {
        return invalid_request(&format!(
            "batchInput carries at most {MAX_BATCH_ITEMS} items"
        ));
    }
    match who
        .store()
        .transit_batch(name, batch_op, items, &batch_defaults(body), &who.actor())
        .await
    {
        Ok(results) => (
            batch_status(&results),
            Json(json!({ "batchResults": results })),
        )
            .into_response(),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/transit/cmac/verify/{name}: verify a CMAC (OpenBao's
/// `cmac/verify` path; the same as the `cmac-verify` operation).
#[utoipa::path(post, path = "/api/vault/transit/cmac/verify/{name}", tag = "Vault",
    summary = "Verify an AES-CMAC (use; batchInput accepted)",
    params(("name" = String, Path, description = "Key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "`valid`, or `batchResults`", body = serde_json::Value)))]
pub async fn transit_cmac_verify(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Option<Json<TransitOpBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    transit_op(
        &who,
        "cmac-verify",
        &name,
        body.map(|Json(body)| body).unwrap_or_default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(error: bool) -> TransitBatchResult {
        TransitBatchResult {
            error: error.then(|| "vault_invalid_request: bad".to_owned()),
            valid: (!error).then_some(true),
            ..TransitBatchResult::default()
        }
    }

    #[test]
    fn a_batch_is_400_only_when_every_item_failed() {
        assert_eq!(
            batch_status(&[result(true), result(true)]),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(batch_status(&[result(true), result(false)]), StatusCode::OK);
        assert_eq!(batch_status(&[result(false)]), StatusCode::OK);
    }

    #[test]
    fn top_level_fields_become_item_defaults_and_batch_input_parses() {
        let body: TransitOpBody = serde_json::from_value(json!({
            "context": "Y3R4",
            "keyVersion": 2,
            "macLength": 8,
            "batchInput": [{ "plaintext": "YQ==", "reference": "r1" }, { "input": "Yg==" }],
        }))
        .unwrap();
        let defaults = batch_defaults(&body);
        assert_eq!(defaults.context.as_deref(), Some("Y3R4"));
        assert_eq!(defaults.key_version, Some(2));
        assert_eq!(defaults.mac_length, Some(8));
        assert!(defaults.plaintext.is_none());
        let items = body.batch_input.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].reference.as_deref(), Some("r1"));
        assert_eq!(items[1].input.as_deref(), Some("Yg=="));
        let rendered = serde_json::to_value(result(false)).unwrap();
        assert_eq!(rendered, json!({ "valid": true }));
    }
}
