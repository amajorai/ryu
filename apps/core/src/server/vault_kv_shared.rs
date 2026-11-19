//! KV v2 routes for control-plane shared values (team and org values on a
//! managed node): Core forwards them to the control plane, which owns those
//! values and enforces capabilities, protected environments, check-and-set,
//! and sealed refusals (`packages/api/src/routers/control-plane-vault-kv.ts`).
//! Forwarding mirrors [`super::vault_api::put_secret_with`]: the member's user
//! JWT and this node's key go with the request, and the control plane's
//! answer (or refusal) is returned as is.
//!
//! Each route builds a [`Forward`] with a pure function (so tests pin the
//! method, subpath, query and body), and [`send`] sends it.

use axum::response::Response;
use serde_json::{json, Map, Value};

use super::vault_api::{proxy_with_proof, rfc3339_fields, CoordsBody, Ctx};

/// One request Core forwards to the control plane for a KV v2 route.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Forward {
    pub(super) method: reqwest::Method,
    /// Relative to `/api/control-plane/orgs/{org}/vault`.
    pub(super) subpath: String,
    pub(super) query: Vec<(String, String)>,
    pub(super) body: Option<Value>,
    /// Whether the request asks for this node's vouch. Subkeys take the
    /// reveal's proof (decision `subkeysProof` in
    /// `packages/api/src/lib/vault-kv-decisions.ts`), so they vouch like a
    /// reveal; [`send`] adds the vouch only when [`Ctx::node_vouches`].
    pub(super) vouch: bool,
}

/// The control-plane subpath for one value's KV v2 `suffix`.
pub(super) fn shared_path(name: &str, suffix: &str) -> String {
    format!("/secrets/{}/{suffix}", urlencoding::encode(name))
}

/// A forwarded body: the value's coordinates (scope id defaulting to this
/// node's team or org) plus `extra`, with `null` top-level fields dropped.
pub(super) fn shared_body(scope_id: &str, coords: &CoordsBody, extra: Map<String, Value>) -> Value {
    let mut body = Map::new();
    body.insert("scope".into(), json!(coords.scope));
    body.insert("scopeId".into(), json!(scope_id));
    body.insert("binding".into(), json!(coords.binding));
    body.insert("environment".into(), json!(coords.environment));
    body.insert("path".into(), json!(coords.path));
    body.extend(extra);
    body.retain(|_, value| !value.is_null());
    Value::Object(body)
}

/// `PATCH metadata`: the merge patch with RFC 3339 `…At` fields, with
/// `customMetadata` (user-defined keys) left untouched. In this and every
/// builder below `scope_id` is [`Ctx::shared_scope_id`].
pub(super) fn metadata_patch(
    scope_id: &str,
    name: &str,
    coords: &CoordsBody,
    mut metadata: Value,
    expected_metadata_version: Option<i64>,
) -> Forward {
    let custom = metadata
        .as_object_mut()
        .and_then(|object| object.remove("customMetadata"));
    let mut extra = Map::new();
    extra.insert("metadata".into(), metadata);
    extra.insert(
        "expectedMetadataVersion".into(),
        json!(expected_metadata_version),
    );
    let mut body = rfc3339_fields(shared_body(scope_id, coords, extra));
    if let Some(custom) = custom {
        if let Some(object) = body.get_mut("metadata").and_then(Value::as_object_mut) {
            object.insert("customMetadata".into(), custom);
        }
    }
    Forward {
        method: reqwest::Method::PATCH,
        subpath: shared_path(name, "metadata"),
        query: Vec::new(),
        body: Some(body),
        vouch: false,
    }
}

/// `PATCH data`: the merge patch under `expectedVersion` check-and-set.
pub(super) fn data_patch(
    scope_id: &str,
    name: &str,
    coords: &CoordsBody,
    patch: Value,
    expected_version: Option<i64>,
) -> Forward {
    // Value keys are user data: no `…At` conversion.
    let mut extra = Map::new();
    extra.insert("patch".into(), patch);
    extra.insert("expectedVersion".into(), json!(expected_version));
    Forward {
        method: reqwest::Method::PATCH,
        subpath: shared_path(name, "data"),
        query: Vec::new(),
        body: Some(shared_body(scope_id, coords, extra)),
        vouch: false,
    }
}

/// `GET subkeys`: the coordinates and `depth` in the query, with the vouch.
pub(super) fn subkeys(
    scope_id: &str,
    name: &str,
    coords: &CoordsBody,
    depth: Option<usize>,
) -> Forward {
    let mut query = coords.query_pairs(scope_id);
    if let Some(depth) = depth {
        query.push(("depth".to_owned(), depth.to_string()));
    }
    Forward {
        method: reqwest::Method::GET,
        subpath: shared_path(name, "subkeys"),
        query,
        body: None,
        vouch: true,
    }
}

/// `POST versions/delete` (when `delete`) or `versions/undelete`.
pub(super) fn versions(
    scope_id: &str,
    name: &str,
    coords: &CoordsBody,
    versions: &[i64],
    delete: bool,
) -> Forward {
    let mut extra = Map::new();
    extra.insert("versions".into(), json!(versions));
    let suffix = if delete {
        "versions/delete"
    } else {
        "versions/undelete"
    };
    Forward {
        method: reqwest::Method::POST,
        subpath: shared_path(name, suffix),
        query: Vec::new(),
        body: Some(shared_body(scope_id, coords, extra)),
        vouch: false,
    }
}

#[cfg(test)]
tokio::task_local! {
    /// Tests: every request [`proxy_with_proof`] is asked to send in this
    /// task, with `vouch` the vouch it would carry.
    pub(super) static RECORDED: std::sync::Arc<std::sync::Mutex<Vec<Forward>>>;
}

/// Tests: record what [`proxy_with_proof`] was asked to send (before its JWT
/// check) when [`RECORDED`] is set, and answer `202` instead of sending it.
#[cfg(test)]
pub(super) fn record_forward(
    method: &reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    body: &Option<Value>,
    node_proof: bool,
) -> Option<Response> {
    let recorded = RECORDED.try_with(std::sync::Arc::clone).ok()?;
    recorded.lock().expect("recorded forwards").push(Forward {
        method: method.clone(),
        subpath: subpath.to_owned(),
        query: query.to_vec(),
        body: body.clone(),
        vouch: node_proof,
    });
    Some(axum::response::IntoResponse::into_response(
        axum::http::StatusCode::ACCEPTED,
    ))
}

/// Send `forward` with the member's JWT, adding this node's vouch when the
/// route asks for it and [`Ctx::node_vouches`] holds (as a reveal does).
pub(super) async fn send(ctx: &Ctx, forward: Forward) -> Response {
    let node_proof = forward.vouch && ctx.node_vouches().await;
    proxy_with_proof(
        ctx,
        forward.method,
        &forward.subpath,
        &forward.query,
        forward.body,
        node_proof,
    )
    .await
}

#[cfg(test)]
#[path = "vault_kv_shared_tests.rs"]
mod tests;
