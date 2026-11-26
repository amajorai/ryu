//! Login import routes under `/api/vault/login-imports`. They read a password
//! export (CSV) from Chrome, Firefox, Safari, Bitwarden or 1Password into
//! typed `login` items. See [`crate::vault::items::login_import`].
//!
//! Both routes are human-only under the node bearer, like the item routes,
//! and take the file's text in the JSON body. Core parses it in memory and
//! keeps nothing between the two calls.
//!
//! * `POST /api/vault/login-imports/preview` saves nothing. It answers with
//!   one entry per record (title, site, username, and whether the record has
//!   an authenticator key or a note) and marks a record as a duplicate when
//!   the folder holds a login for the same site and username that the caller
//!   may read (`list` plus `use` or `read`).
//! * `POST /api/vault/login-imports` saves the records named in `rows` as
//!   new items and replaces the logins named in `replace`. Each new item
//!   needs `write` on its own policy key, and a replacement needs `write` on
//!   the existing item plus its current id and version. In a protected
//!   environment both also need `admin`, as for any item change.
//!
//! No reply or error carries a password, an authenticator seed or a note.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ctx, invalid_request, respond, try_response, vault_error, Ctx};
use crate::identity_verify::VerifiedCaller;
use crate::server::ServerState;
use crate::vault::items::login_import::{
    new_item_key, ApplyInput, ImportFolder, LoginImport, ReplaceChoice,
};
use crate::vault::items::policy_key;
use crate::vault::policy::Capability;

/// Import routes, merged into the authenticated vault router.
pub fn routes() -> Router<ServerState> {
    use axum::extract::DefaultBodyLimit;
    let bulk = || DefaultBodyLimit::max(super::MAX_BULK_BODY_BYTES);
    Router::new()
        .route(
            "/api/vault/login-imports/preview",
            post(login_import_preview).layer(bulk()),
        )
        .route(
            "/api/vault/login-imports",
            post(login_import_apply).layer(bulk()),
        )
}

/// Body of a preview. It holds the file, so it has no `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewBody {
    csv: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// Body of an import. It holds the file, so it has no `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyBody {
    csv: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// Records to save as new logins (the header is record 1).
    #[serde(default)]
    rows: Vec<usize>,
    /// Duplicates the user chose to replace.
    #[serde(default)]
    replace: Vec<ReplaceChoice>,
}

/// Parse a body. A parser message can quote the value it tripped over, and
/// that value may be the file, so the answer is a fixed text.
fn parse_body<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, Response> {
    serde_json::from_value(body)
        .map_err(|_| invalid_request("the body of a login import is not in the expected form"))
}

fn parse_csv(text: &str) -> Result<LoginImport, Response> {
    LoginImport::parse(text).map_err(|error| invalid_request(&error.to_string()))
}

/// What the caller may do with the items already in a folder.
struct FolderAccess {
    /// Whether item changes in the environment need `admin`.
    protected: bool,
    /// Ids of items whose non-sensitive values the caller may see.
    readable: BTreeSet<String>,
    /// Ids of items the caller may change.
    writable: BTreeSet<String>,
}

impl FolderAccess {
    async fn load(ctx: &Ctx, folder: &ImportFolder) -> Result<Self, Response> {
        let protected = ctx
            .store
            .environment(&folder.environment)
            .await
            .map_err(vault_error)?
            .is_some_and(|environment| environment.protected);
        let items = ctx
            .store
            .item_list(Some(&folder.environment), Some(&folder.path))
            .await
            .map_err(vault_error)?;
        let mut access = Self {
            protected,
            readable: BTreeSet::new(),
            writable: BTreeSet::new(),
        };
        for item in items {
            let key = policy_key(&item.environment, &item.path, &item.key);
            if access.may_write(ctx, &key) {
                access.writable.insert(item.id.clone());
            }
            let caps = ctx.sys_caps(&key);
            if caps.contains(&Capability::List)
                && (caps.contains(&Capability::Use) || caps.contains(&Capability::Read))
            {
                access.readable.insert(item.id);
            }
        }
        Ok(access)
    }

    /// Whether the caller may create or change the item at policy key `key`.
    fn may_write(&self, ctx: &Ctx, key: &str) -> bool {
        let caps = ctx.sys_caps(key);
        caps.contains(&Capability::Write) && (!self.protected || caps.contains(&Capability::Admin))
    }
}

/// POST /api/vault/login-imports/preview.
pub async fn login_import_preview(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    preview_import(&ctx, body).await
}

async fn preview_import(ctx: &Ctx, body: Value) -> Response {
    let body: PreviewBody = try_response!(parse_body(body));
    let folder = try_response!(ImportFolder::new(
        body.environment.as_deref(),
        body.path.as_deref()
    )
    .map_err(vault_error));
    let import = try_response!(parse_csv(&body.csv));
    let access = try_response!(FolderAccess::load(ctx, &folder).await);
    match ctx
        .store
        .login_import_preview(&folder, &import, &access.readable)
        .await
    {
        Ok(preview) => respond(json!({ "preview": preview })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/login-imports.
pub async fn login_import_apply(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    apply_import(&ctx, body).await
}

async fn apply_import(ctx: &Ctx, body: Value) -> Response {
    let body: ApplyBody = try_response!(parse_body(body));
    let folder = try_response!(ImportFolder::new(
        body.environment.as_deref(),
        body.path.as_deref()
    )
    .map_err(vault_error));
    let import = try_response!(parse_csv(&body.csv));
    if body.rows.len() > import.len() || body.replace.len() > import.len() {
        return invalid_request("more records are chosen than the file holds");
    }
    let access = try_response!(FolderAccess::load(ctx, &folder).await);

    // Each new login gets its key here, so the right to write it is checked
    // on the exact policy key it will live at.
    let mut create: BTreeMap<usize, String> = BTreeMap::new();
    let mut denied: BTreeSet<usize> = BTreeSet::new();
    for row in body.rows {
        // A record that cannot be imported keeps a placeholder key; the
        // store reports it as invalid and never uses the key.
        let key = new_item_key(import.importable_host(row).unwrap_or_default());
        if access.may_write(ctx, &policy_key(&folder.environment, &folder.path, &key)) {
            create.insert(row, key);
        } else {
            denied.insert(row);
        }
    }
    let input = ApplyInput {
        create: &create,
        denied: &denied,
        replace: &body.replace,
        readable: &access.readable,
        writable: &access.writable,
    };
    match ctx
        .store
        .login_import_apply(&folder, &import, &input, &ctx.actor())
        .await
    {
        Ok(result) => respond(json!({ "result": result })),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
#[path = "login_import_tests.rs"]
mod tests;
