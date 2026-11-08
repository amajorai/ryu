//! Scanning text for leaked copies of stored values.

use super::*;

/// The stored values `scan` looks for, labelled by `ENV/folder/NAME`: the
/// ones the caller may read directly. A sealed value is left out, so a scan
/// can never confirm which submitted string equals it.
pub(super) async fn scan_known_values(ctx: &Ctx) -> anyhow::Result<Vec<(String, String)>> {
    Ok(ctx
        .store
        .current_values(&ListFilter::default())
        .await?
        .into_iter()
        .filter(|(info, _)| {
            info.metadata.value_type.is_revealable() && ctx.can_read_directly(&info.coords())
        })
        .map(|(info, value)| (info.coords().policy_key(), value))
        .collect())
}

/// One file to scan.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFile {
    #[serde(default)]
    pub(crate) path: Option<String>,
    pub(crate) content: String,
}

/// Body of `POST /api/vault/scan`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBody {
    pub(crate) files: Vec<ScanFile>,
    /// Finding fingerprints to suppress.
    #[serde(default)]
    pub(crate) allow: Vec<String>,
    /// Also match values stored in the vault that the caller may read (default true).
    #[serde(default)]
    pub(crate) known_values: Option<bool>,
}

/// POST /api/vault/scan finds leaked credentials in text.
#[utoipa::path(
    post,
    path = "/api/vault/scan",
    tag = "Vault",
    summary = "Scan text for leaked credentials and stored vault values",
    request_body = serde_json::Value,
    responses((status = 200, description = "Findings (no secret values)", body = serde_json::Value))
)]
pub async fn scan(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ScanBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let known: Vec<(String, String)> = if body.known_values.unwrap_or(true) {
        match scan_known_values(&ctx).await {
            Ok(known) => known,
            Err(error) => return vault_error(error),
        }
    } else {
        Vec::new()
    };
    let known_refs: Vec<scan::KnownValue<'_>> = known
        .iter()
        .map(|(label, value)| scan::KnownValue { label, value })
        .collect();
    let mut findings = Vec::new();
    for file in &body.files {
        findings.extend(scan::scan(
            &file.content,
            file.path.as_deref(),
            &known_refs,
            &body.allow,
        ));
    }
    ctx.store
        .audit(
            &AuditEntry::new(&ctx.actor(), "vault.scan", "ok").details(json!({
                "files": body.files.len(), "findings": findings.len()
            })),
        )
        .await;
    respond(json!({ "findings": findings }))
}
