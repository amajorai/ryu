//! Tag routes and the listing's tag filter.
//!
//! * `GET    /api/vault/tags`: every tag entity and every tag in use, each
//!   with the number of values carrying it that the caller may `list`
//!   (counts never include values the caller cannot see);
//! * `PUT    /api/vault/tags/{slug}`: create or update an entity (`admin` on
//!   `sys/tags/<slug>`);
//! * `DELETE /api/vault/tags/{slug}`: delete an entity; values keep the label
//!   (`admin` on the same key).
//!
//! `GET /api/vault/secrets?tag=a,b` lists only values carrying every tag.
//! Tags are labels, not authorization: policies do not match on them.

use std::collections::BTreeMap;

use super::*;
use crate::plugin_secrets::kv::{is_valid_tag, VaultTag};

/// The tags a `tag=` query names (comma-separated, trimmed, empty dropped).
pub(crate) fn tag_filter(query: Option<&str>) -> Vec<String> {
    query
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether `tags` carries every tag in `wanted`.
pub(crate) fn has_tags(tags: &[String], wanted: &[String]) -> bool {
    wanted.iter().all(|tag| tags.contains(tag))
}

/// [`has_tags`] for a control-plane listing row (`metadata.tags`).
pub(crate) fn wire_has_tags(secret: &Value, wanted: &[String]) -> bool {
    if wanted.is_empty() {
        return true;
    }
    let tags: Vec<String> = secret
        .pointer("/metadata/tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    has_tags(&tags, wanted)
}

fn tag_key(slug: &str) -> String {
    format!("sys/tags/{slug}")
}

pub(crate) async fn list_tags_with(ctx: &Ctx) -> Response {
    let entities = match ctx.store.tag_entities().await {
        Ok(entities) => entities,
        Err(error) => return vault_error(error),
    };
    let values = match ctx.store.list_vault_secrets_filtered(&ListFilter::default()).await {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for info in values
        .iter()
        .filter(|info| ctx.caps(&info.coords()).contains(&Capability::List))
    {
        for tag in &info.metadata.tags {
            *counts.entry(tag.clone()).or_default() += 1;
        }
    }
    let mut tags = Vec::new();
    for entity in &entities {
        let count = counts.remove(&entity.slug).unwrap_or_default();
        let mut wire = serde_json::to_value(entity).unwrap_or(Value::Null);
        if let Some(object) = wire.as_object_mut() {
            object.insert("defined".into(), json!(true));
            object.insert("count".into(), json!(count));
        }
        tags.push(wire);
    }
    for (slug, count) in counts {
        tags.push(json!({ "slug": slug, "defined": false, "count": count }));
    }
    respond(json!({ "tags": tags }))
}

pub(crate) async fn put_tag_with(ctx: &Ctx, slug: &str, body: Value) -> Response {
    if !is_valid_tag(slug) {
        return invalid_request("invalid tag");
    }
    try_response!(ctx.require_sys(&tag_key(slug), Capability::Admin));
    let mut tag: VaultTag = try_response!(parse_body(body));
    tag.slug = slug.to_owned();
    match ctx.store.put_tag_entity(&tag, &ctx.actor()).await {
        Ok(tag) => respond(json!({ "ok": true, "tag": tag })),
        Err(error) => vault_error(error),
    }
}

pub(crate) async fn delete_tag_with(ctx: &Ctx, slug: &str) -> Response {
    try_response!(ctx.require_sys(&tag_key(slug), Capability::Admin));
    match ctx.store.delete_tag_entity(slug, &ctx.actor()).await {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/tags.
#[utoipa::path(get, path = "/api/vault/tags", tag = "Vault",
    summary = "List tag entities and tags in use, with visible value counts",
    responses((status = 200, description = "Tags", body = serde_json::Value)))]
pub async fn list_tags(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_tags_with(&ctx).await
}

/// PUT /api/vault/tags/{slug}.
#[utoipa::path(put, path = "/api/vault/tags/{slug}", tag = "Vault",
    summary = "Create or update a tag entity (admin)",
    params(("slug" = String, Path, description = "Tag label")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_tag(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    put_tag_with(&ctx, &slug, body).await
}

/// DELETE /api/vault/tags/{slug}.
#[utoipa::path(delete, path = "/api/vault/tags/{slug}", tag = "Vault",
    summary = "Delete a tag entity; values keep the label (admin)",
    params(("slug" = String, Path, description = "Tag label")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_tag(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    delete_tag_with(&ctx, &slug).await
}

#[cfg(test)]
#[path = "tags_tests.rs"]
mod tests;
