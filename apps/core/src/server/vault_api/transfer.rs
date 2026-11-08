//! Export, import, and snapshots.

use std::collections::BTreeSet;

use super::*;

/// True for the control plane's step-up refusal (`error: "STEP_UP_REQUIRED"`).
pub(super) fn is_step_up_required(value: &Value) -> bool {
    value.get("error").and_then(Value::as_str) == Some("STEP_UP_REQUIRED")
}

/// The `sharedError` prefix for an export the control plane refused for the
/// caller; the refusal's code follows (`vault_shared_refused: org_ip_not_allowed`),
/// so the CLI and Desktop can say what to do about it.
pub(super) const SHARED_REFUSED_PREFIX: &str = "vault_shared_refused: ";

/// Whether a control-plane refusal of a proxied export is about the caller's
/// access rather than about the values: a forwarded JWT the control plane
/// would not bind (`node_proxy_required`, `user_jwt_*`), the organization's
/// access policy (`org_*`) or the two-factor mandates. The export goes on
/// with this node's and the caller's own values and names the refusal in
/// `sharedError`, as for an outage, so `ryu secrets run` keeps working for a
/// member with no shared values and warns one who has them. Only the step-up
/// prompt fails the export ([`is_step_up_required`]): the control plane asks
/// for it only when there are shared values to hand over.
///
/// Not one: `not_an_org_member` (403), which the control plane answers to a
/// caller who is not on the node's organization's roster. There is nothing
/// shared for them, so the export goes on without a warning.
pub(super) fn is_caller_refusal(status: u16, value: &Value) -> bool {
    if !matches!(status, 401 | 403) || is_step_up_required(value) {
        return false;
    }
    crate::vault::shared::refusal_code(value).is_some_and(|code| {
        code == "node_proxy_required"
            || code == "mfa_enrollment_required"
            || code == "staff_session_factor_required"
            || code.starts_with("user_jwt_")
            || code.starts_with("org_")
    })
}

/// Lay the caller's effective local values over the control plane's shared
/// ones, as runtime resolution does: a local value wins its name, and a name
/// a local sealed value holds (`withheld`) is dropped, so the shared value it
/// shadows is never exported in its place.
pub(super) fn overlay_local_values(
    mut values: BTreeMap<String, String>,
    local: BTreeMap<String, (SecretCoords, String)>,
    withheld: &BTreeSet<String>,
) -> BTreeMap<String, String> {
    values.retain(|name, _| !withheld.contains(name));
    for (name, (_, value)) in local {
        values.insert(name, value);
    }
    values
}

/// Body of `POST /api/vault/export`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBody {
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    /// `dotenv` (default), `json`, `yaml`, `shell`, `k8s-secret`.
    #[serde(default)]
    pub(crate) format: Option<String>,
    #[serde(default)]
    pub(crate) names: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) k8s_name: Option<String>,
    #[serde(default)]
    pub(crate) k8s_namespace: Option<String>,
    /// An organization project whose values to include ahead of Team and
    /// Organization values (P1-15). The control plane checks the caller can
    /// reach it.
    #[serde(default)]
    pub(crate) project_id: Option<String>,
}

/// The control-plane export request for `environment`/`path`, naming the
/// chosen project when there is one. A malformed project id is refused.
pub(super) fn shared_export_request(
    environment: &str,
    path: &str,
    project_id: Option<&str>,
) -> Result<Value, &'static str> {
    let mut request = json!({ "environment": environment, "path": path });
    if let Some(project) = project_id.map(str::trim).filter(|id| !id.is_empty()) {
        if !crate::plugin_secrets::is_valid_scope_id(project) {
            return Err("projectId is not a valid project id");
        }
        request["projectId"] = json!(project);
    }
    Ok(request)
}

/// Refuse an export that names a project when the project's values cannot be
/// fetched. A requested project is all-or-nothing: exporting without its
/// values would hand `ryu secrets run` an environment that silently lacks
/// them, so the caller gets an error naming why instead.
pub(super) fn project_unavailable(status: StatusCode, reason: &str) -> Response {
    no_store_response(json_error(
        status,
        format!("vault_project_unavailable: {reason}"),
    ))
}

/// POST /api/vault/export returns the effective values for an environment
/// and folder, rendered in one format. Requires `read` on every included value.
#[utoipa::path(
    post,
    path = "/api/vault/export",
    tag = "Vault",
    summary = "Export effective values (dotenv, JSON, YAML, shell, or a Kubernetes Secret)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Rendered content", body = serde_json::Value))
)]
pub async fn export(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ExportBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    export_with(&ctx, body).await
}

pub(super) async fn export_with(ctx: &Ctx, body: ExportBody) -> Response {
    let format = match body.format.as_deref().map(dotenv::Format::parse) {
        None => dotenv::Format::Dotenv,
        Some(Some(format)) => format,
        Some(None) => return invalid_request("unknown format"),
    };
    let environment = body
        .environment
        .clone()
        .unwrap_or_else(crate::vault::active_environment);
    let path = body.path.clone().unwrap_or_else(|| ROOT_PATH.to_owned());
    let request = match shared_export_request(&environment, &path, body.project_id.as_deref()) {
        Ok(request) => request,
        Err(message) => return invalid_request(message),
    };
    let project_requested = request.get("projectId").is_some();
    if project_requested && (!crate::vault::shared::is_enabled() || ctx.jwt.is_none()) {
        return project_unavailable(
            StatusCode::CONFLICT,
            "project values need a signed-in user on a node enrolled in an organization",
        );
    }
    let context = ctx.resolution_context(Some(environment.clone()));
    let (local, withheld) = match ctx
        .store
        .effective_local_values_and_withheld(&context, &environment, &path, |coords| {
            ctx.can_read_directly(coords)
        })
        .await
    {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    let mut shared_error: Option<String> = None;
    // Shared values first so local user/node values win, matching runtime order.
    if crate::vault::shared::is_enabled() {
        if let Some(jwt) = ctx.jwt.as_deref() {
            let node_proof = ctx.node_vouches().await;
            match crate::vault::shared::proxy(
                reqwest::Method::POST,
                "/export",
                &[],
                jwt,
                Some(request),
                node_proof,
            )
            .await
            {
                Ok(value) => {
                    if let Some(map) = value.get("values").and_then(Value::as_object) {
                        for (key, value) in map {
                            if let Some(text) = value.as_str() {
                                values.insert(key.clone(), text.to_owned());
                            }
                        }
                    }
                }
                // The control plane wants a fresh step-up before it hands over
                // the shared plaintext it holds for this caller. Pass that on so
                // the caller can confirm and retry, instead of quietly
                // exporting without values they have.
                Err(crate::vault::shared::ProxyError::Status(status, value))
                    if matches!(status, 401 | 403) && is_step_up_required(&value) =>
                {
                    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN);
                    return no_store_response((status, Json(value)).into_response());
                }
                // A requested project the control plane refuses (not in this
                // organization, archived, or out of the caller's reach), or
                // any refusal of an export that names one, fails the export.
                Err(crate::vault::shared::ProxyError::Status(status, value))
                    if project_requested && status < 500 =>
                {
                    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN);
                    return no_store_response((status, Json(value)).into_response());
                }
                Err(crate::vault::shared::ProxyError::Unavailable) if project_requested => {
                    return project_unavailable(
                        StatusCode::CONFLICT,
                        "this node is not connected to its organization",
                    );
                }
                // The control plane refused the caller's access (the sign-in
                // ended or is not accepted, an organization policy applies, or
                // the request did not come through this node). Export what does
                // not depend on it and name the refusal, so the CLI and Desktop
                // warn with what to do.
                Err(crate::vault::shared::ProxyError::Status(status, value))
                    if is_caller_refusal(status, &value) =>
                {
                    let code = crate::vault::shared::refusal_code(&value).unwrap_or("refused");
                    shared_error = Some(format!("{SHARED_REFUSED_PREFIX}{code}"));
                }
                // An outage (including the control plane's 503 when it cannot
                // check the forwarded sign-in): export what this node holds and
                // say that the shared values are missing (`sharedError`, as the
                // list does), so the CLI and Desktop warn. Values that never
                // depended on the control plane keep working through it.
                Err(crate::vault::shared::ProxyError::Status(status, _)) if status >= 500 => {
                    shared_error = Some(format!(
                        "vault_shared_unreachable: the control plane answered {status}"
                    ));
                }
                Err(crate::vault::shared::ProxyError::Transport(error)) => {
                    shared_error = Some(format!("vault_shared_unreachable: {error}"));
                }
                // Not a member of this node's organization
                // (`not_an_org_member`), or a vault that is closed (a family
                // workspace): there are no shared values for this caller. Not
                // connected: none either.
                Err(crate::vault::shared::ProxyError::Status(_, _))
                | Err(crate::vault::shared::ProxyError::Unavailable) => {}
            }
        }
    }
    if let Some(error) = shared_error.as_deref().filter(|_| project_requested) {
        return project_unavailable(StatusCode::SERVICE_UNAVAILABLE, error);
    }
    let mut values = overlay_local_values(values, local, &withheld);
    if let Some(names) = &body.names {
        values.retain(|name, _| names.contains(name));
    }
    if !ctx
        .store
        .audit(
            &AuditEntry::new(&ctx.actor(), "vault.export", "ok").details(json!({
                "environment": environment, "path": path, "count": values.len(),
                "names": values.keys().collect::<Vec<_>>(),
            })),
        )
        .await
    {
        return vault_error(VaultError::AuditUnavailable.into());
    }
    let options = dotenv::K8sOptions {
        name: body.k8s_name,
        namespace: body.k8s_namespace,
    };
    match dotenv::serialize(&values, format, &options) {
        Ok(content) => respond(json!({
            "format": format,
            "contentType": format.content_type(),
            "count": values.len(),
            "environment": environment,
            "path": path,
            "content": content,
            "sharedError": shared_error,
        })),
        Err(error) => vault_error(error),
    }
}

/// Body of `POST /api/vault/import`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBody {
    #[serde(flatten)]
    pub(crate) coords: CoordsBody,
    /// `dotenv`, `json`, or `snapshot`.
    pub(crate) format: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) passphrase: Option<String>,
    #[serde(default)]
    pub(crate) on_conflict: snapshot::OnConflict,
}

/// POST /api/vault/import writes values from `.env`, JSON, or an encrypted snapshot.
#[utoipa::path(
    post,
    path = "/api/vault/import",
    tag = "Vault",
    summary = "Import values from .env, JSON, or an encrypted snapshot",
    request_body = serde_json::Value,
    responses((status = 200, description = "Counts", body = serde_json::Value))
)]
pub async fn import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    import_with(&ctx, body).await
}

pub(super) async fn import_with(ctx: &Ctx, body: ImportBody) -> Response {
    if ctx.shared_remote(body.coords.scope) && body.format != "snapshot" {
        let forwarded = json!({
            "scope": body.coords.scope, "scopeId": ctx.shared_scope_id(&body.coords),
            "environment": body.coords.environment, "path": body.coords.path,
            "format": body.format, "content": body.content, "onConflict": body.on_conflict,
        });
        return proxy(&ctx, reqwest::Method::POST, "/import", &[], Some(forwarded)).await;
    }
    let actor = ctx.actor();
    // Imports write directly, so on a protected environment they are limited
    // to admins (see `protected_denied`).
    let protected: std::collections::HashSet<String> = match ctx.store.list_environments().await {
        Ok(environments) => environments
            .into_iter()
            .filter(|environment| environment.protected)
            .map(|environment| environment.slug)
            .collect(),
        Err(error) => return vault_error(error),
    };
    // Imports honour the same parameter constraints as `PUT`; a value that
    // breaks one is skipped like any other unauthorized entry.
    let allow = |coords: &SecretCoords, value: &str| {
        let caps = ctx.caps(coords);
        caps.contains(&Capability::Write)
            && (!protected.contains(&coords.environment) || caps.contains(&Capability::Admin))
            && ctx.write_parameters_violation(coords, value).is_none()
    };
    if body.format == "snapshot" {
        let envelope: snapshot::Envelope = match serde_json::from_str(&body.content) {
            Ok(envelope) => envelope,
            Err(_) => return invalid_request("content is not a Ryu vault snapshot"),
        };
        let Some(passphrase) = body.passphrase.as_deref() else {
            return invalid_request("passphrase is required for snapshots");
        };
        return match ctx
            .store
            .snapshot_import(&envelope, passphrase, body.on_conflict, allow, &actor)
            .await
        {
            Ok(report) => respond(json!({ "ok": true, "report": report })),
            Err(error) => vault_error(error),
        };
    }
    let parsed = match body.format.as_str() {
        "dotenv" | "env" => dotenv::parse(&body.content),
        "json" => dotenv::parse_json(&body.content),
        _ => return invalid_request("format must be dotenv, json, or snapshot"),
    };
    let values = match parsed {
        Ok(values) => values,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let mut entries = Vec::with_capacity(values.len());
    for (name, value) in values {
        if value.len() > MAX_VAULT_SECRET_VALUE_LEN {
            return invalid_request(&format!("`{name}` exceeds the maximum value size"));
        }
        let coords = match coords_for(&ctx, &name, body.coords.clone()) {
            Ok(coords) => coords,
            Err(response) => return response,
        };
        entries.push(snapshot::Entry {
            coords,
            value,
            metadata: Default::default(),
        });
    }
    match ctx
        .store
        .import_entries(entries, body.on_conflict, allow, &actor)
        .await
    {
        Ok(report) => {
            ctx.store
                .audit(
                    &AuditEntry::new(&actor, "vault.import", "ok")
                        .details(serde_json::to_value(&report).unwrap_or(Value::Null)),
                )
                .await;
            respond(json!({ "ok": true, "report": report }))
        }
        Err(error) => vault_error(error),
    }
}

/// Body of `POST /api/vault/snapshot`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBody {
    pub(crate) passphrase: String,
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
}

/// POST /api/vault/snapshot exports a passphrase-sealed snapshot.
#[utoipa::path(
    post,
    path = "/api/vault/snapshot",
    tag = "Vault",
    summary = "Export an encrypted, portable snapshot of readable values",
    request_body = serde_json::Value,
    responses((status = 200, description = "Snapshot envelope", body = serde_json::Value))
)]
pub async fn snapshot_export(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<SnapshotBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let filter = ListFilter {
        environment: body.environment,
        path: body.path,
        recursive: true,
        include_deleted: false,
    };
    match ctx
        .store
        .snapshot_export(
            &filter,
            |coords| ctx.can_read_directly(coords),
            &body.passphrase,
            &ctx.actor(),
        )
        .await
    {
        Ok(envelope) => no_store_response(Json(envelope).into_response()),
        Err(error) => vault_error(error),
    }
}
