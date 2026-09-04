//! Validated language-pack reads for the desktop/webapp shell.
//!
//! Language packs are portable data, not plugins. Core therefore exposes only
//! validated `language-pack.json` payloads from installed packages; it never
//! evaluates package code or hands the frontend arbitrary package artifacts.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use axum::{extract::State, http::StatusCode, response::IntoResponse, response::Response, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::ServerState;

const LANGUAGE_PACK_ARTIFACT: &str = "language-pack.json";
const LANGUAGE_PACK_SCHEMA_VERSION: u64 = 1;
// Keep this in lockstep with `@ryu/i18n`'s MAX_LANGUAGE_PACK_BYTES. Core checks
// the raw UTF-8 artifact before parsing so every runtime has the same ceiling.
const MAX_LANGUAGE_PACK_BYTES: usize = 4 * 1024 * 1024;
const MAX_LANGUAGE_PACK_MESSAGES: usize = 20_000;
const MAX_LANGUAGE_PACK_MESSAGE_ID: usize = 200;
const MAX_LANGUAGE_PACK_MESSAGE: usize = 32_000;
/// Base64 JSON envelope ceiling for a local language-pack import. This leaves
/// enough room for the base64 expansion of the client-side 8 MiB archive cap,
/// plus the JSON envelope. The decoded artifact is still bounded by
/// `MAX_LANGUAGE_PACK_BYTES` and the generic ZIP validator's limits below.
pub(crate) const MAX_LANGUAGE_PACK_IMPORT_BODY_BYTES: usize =
    ((8 * 1024 * 1024 + 2) / 3) * 4 + 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct LanguagePackWire {
    #[serde(rename = "baseLocale")]
    pub(crate) base_locale: String,
    pub(crate) direction: String,
    pub(crate) id: String,
    pub(crate) locale: String,
    pub(crate) messages: BTreeMap<String, String>,
    pub(crate) name: String,
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u64,
    pub(crate) version: String,
}

fn valid_locale(value: &str) -> bool {
    let parts = value.split('-').collect::<Vec<_>>();
    let Some(first) = parts.first() else {
        return false;
    };
    first.len() >= 2
        && first.len() <= 8
        && first
            .chars()
            .all(|character| character.is_ascii_alphabetic())
        && !first.eq_ignore_ascii_case("x")
        && parts.iter().skip(1).enumerate().all(|(index, part)| {
            !part.is_empty()
                && part.len() <= 8
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
                && (part.len() != 1 || index + 2 < parts.len())
        })
}

fn valid_text(value: &str, max_length: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_length
        && !value.chars().any(|character| {
            let code = u32::from(character);
            code <= 8 || code == 11 || code == 12 || (14..=31).contains(&code) || code == 127
        })
}

/// Validate one installed package's language artifact and identity.
pub(crate) fn validate_package_files(
    kind: &str,
    id: &str,
    version: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<LanguagePackWire> {
    if kind != "language_pack" {
        bail!("package kind `{kind}` is not a language pack");
    }
    let bytes = files.get(LANGUAGE_PACK_ARTIFACT).ok_or_else(|| {
        anyhow::anyhow!("language-pack package is missing {LANGUAGE_PACK_ARTIFACT}")
    })?;
    if files.len() != 1 {
        bail!("language-pack package may contain only {LANGUAGE_PACK_ARTIFACT}");
    }
    if bytes.len() > MAX_LANGUAGE_PACK_BYTES {
        bail!("language-pack artifact exceeds the 4 MiB limit");
    }
    let pack = serde_json::from_slice::<LanguagePackWire>(bytes)
        .context("language-pack artifact is not valid JSON")?;
    if pack.schema_version != LANGUAGE_PACK_SCHEMA_VERSION {
        bail!("language-pack schemaVersion must be {LANGUAGE_PACK_SCHEMA_VERSION}");
    }
    if pack.id != id
        || pack.version.trim().trim_start_matches('v') != version.trim().trim_start_matches('v')
    {
        bail!("language-pack identity does not match the installed package");
    }
    if !valid_text(&pack.name, 120)
        || !valid_text(&pack.id, 160)
        || !valid_text(&pack.version, 128)
        || !valid_locale(&pack.locale)
        || !valid_locale(&pack.base_locale)
    {
        bail!("language-pack metadata is invalid");
    }
    if pack.direction != "ltr" && pack.direction != "rtl" {
        bail!("language-pack direction must be ltr or rtl");
    }
    if pack.messages.len() > MAX_LANGUAGE_PACK_MESSAGES {
        bail!("language-pack contains too many messages");
    }
    for (message_id, message) in &pack.messages {
        if message_id.is_empty()
            || message_id.len() > MAX_LANGUAGE_PACK_MESSAGE_ID
            || message_id.starts_with("__")
            || !valid_text(message, MAX_LANGUAGE_PACK_MESSAGE)
        {
            bail!("language-pack contains an invalid message");
        }
    }
    Ok(pack)
}

/// Enforce the package-envelope half of the data-only contract. This is kept
/// beside the artifact validator so an old installed package cannot regain an
/// executable/capability-bearing shape merely by going through enable again.
pub(crate) fn validate_language_pack_manifest(
    kind: &str,
    id: &str,
    version: &str,
    manifest: &crate::portable_packages::PortablePackageManifest,
) -> Result<()> {
    if kind != "language_pack"
        || manifest.kind != "language_pack"
        || manifest.id != id
        || manifest.version.trim().trim_start_matches('v') != version.trim().trim_start_matches('v')
        || manifest.artifacts.len() != 1
        || manifest.artifacts[0] != LANGUAGE_PACK_ARTIFACT
        || !manifest.capabilities.is_empty()
        || !manifest.security.permissions.is_empty()
        || manifest.security.contains_secrets
        || manifest.security.private_content
    {
        bail!(
            "language-pack package must contain only language-pack.json and no capabilities or permissions"
        );
    }
    Ok(())
}

/// `GET /api/language-packs/installed` — validated installed pack data only.
#[utoipa::path(
    get,
    path = "/api/language-packs/installed",
    tag = "Core",
    summary = "List validated language packs installed on this node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn installed(State(_state): State<ServerState>) -> Response {
    let records = match crate::portable_packages::list() {
        Ok(records) => records,
        Err(error) => {
            return super::json_error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            )
        }
    };
    let mut packs = Vec::new();
    for record in records
        .into_iter()
        .filter(|record| record.kind == "language_pack")
    {
        let manifest = match crate::portable_packages::manifest(&record.kind, &record.id) {
            Ok(Some(manifest)) => manifest,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(package_id = %record.id, %error, "language-pack manifest read failed");
                continue;
            }
        };
        if let Err(error) =
            validate_language_pack_manifest(&record.kind, &record.id, &record.version, &manifest)
        {
            tracing::warn!(package_id = %record.id, %error, "unsafe installed language pack skipped");
            continue;
        }
        let files = match crate::portable_packages::artifact_files(&record.kind, &record.id) {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(package_id = %record.id, %error, "language-pack artifact read failed");
                continue;
            }
        };
        let pack = match validate_package_files(&record.kind, &record.id, &record.version, &files) {
            Ok(pack) => pack,
            Err(error) => {
                tracing::warn!(package_id = %record.id, %error, "invalid installed language pack skipped");
                continue;
            }
        };
        let mut value = match serde_json::to_value(pack) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(package_id = %record.id, %error, "language-pack serialization failed");
                continue;
            }
        };
        if let Some(object) = value.as_object_mut() {
            object.insert("enabled".to_owned(), json!(record.enabled));
        }
        packs.push(value);
    }
    Json(json!({ "packs": packs })).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct LanguagePackImportBody {
    archive_base64: String,
}

/// `POST /api/language-packs/import` — install and activate a user-selected
/// data-only `.ryupack`. Local imports intentionally do not claim Marketplace
/// provenance; they still pass the same ZIP/path/size/identity validation and
/// can only contain the language artifact, with no capabilities or secrets.
#[utoipa::path(
    post,
    path = "/api/language-packs/import",
    tag = "Core",
    summary = "Import a data-only language pack archive",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn import(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<LanguagePackImportBody>,
) -> Response {
    use base64::Engine as _;

    if let Err(response) = super::enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    if body.archive_base64.trim().is_empty() {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "archive_base64 is required".to_owned(),
        );
    }
    if body.archive_base64.len() > MAX_LANGUAGE_PACK_IMPORT_BODY_BYTES {
        return super::json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "language-pack import exceeds the request limit".to_owned(),
        );
    }
    let archive =
        match base64::engine::general_purpose::STANDARD.decode(body.archive_base64.as_bytes()) {
            Ok(bytes) => bytes,
            Err(error) => {
                return super::json_error(
                    StatusCode::BAD_REQUEST,
                    format!("archive_base64 is invalid: {error}"),
                )
            }
        };
    let extracted = match crate::portable_packages::extract_archive(&archive) {
        Ok(package) => package,
        Err(error) => return super::json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    if let Err(error) = validate_language_pack_manifest(
        &extracted.manifest.kind,
        &extracted.manifest.id,
        &extracted.manifest.version,
        &extracted.manifest,
    ) {
        return super::json_error(StatusCode::BAD_REQUEST, error.to_string());
    }
    if extracted.manifest.kind != "language_pack"
        || extracted.files.len() != 1
        || extracted.manifest.artifacts.len() != 1
        || extracted.manifest.artifacts.first().map(String::as_str) != Some("language-pack.json")
        || !extracted.manifest.capabilities.is_empty()
        || !extracted.manifest.security.permissions.is_empty()
        || extracted.manifest.security.contains_secrets
        || extracted.manifest.security.private_content
    {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "language-pack import must contain only language-pack.json and no capabilities or secrets"
                .to_owned(),
        );
    }
    let pack = match validate_package_files(
        &extracted.manifest.kind,
        &extracted.manifest.id,
        &extracted.manifest.version,
        &extracted.files,
    ) {
        Ok(pack) => pack,
        Err(error) => return super::json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let installed = match crate::portable_packages::install(
        "language_pack",
        &pack.id,
        &archive,
        None,
        None,
        None,
        false,
    ) {
        Ok(package) => package,
        Err(error) => {
            return super::json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
        }
    };
    let owner = super::spaces::owner_of(&super::caller_tenancy(&caller));
    match super::portable_package_runtime::enable_with_owner(
        &state,
        "language_pack",
        &pack.id,
        &owner,
    )
    .await
    {
        Ok(package) => {
            Json(json!({ "success": true, "package": package, "pack": pack })).into_response()
        }
        Err(error) => {
            // The archive was new and is data-only; remove it on activation
            // failure so a failed import cannot leave a misleading installed row.
            let _ = crate::portable_packages::uninstall("language_pack", &installed.id);
            super::json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{valid_locale, validate_package_files, LANGUAGE_PACK_ARTIFACT};
    use std::collections::BTreeMap;

    fn files(id: &str, version: &str) -> BTreeMap<String, Vec<u8>> {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "id": id,
            "name": "Example",
            "version": version,
            "locale": "en",
            "baseLocale": "en",
            "direction": "ltr",
            "messages": { "common.install": "Install" }
        });
        BTreeMap::from([(
            LANGUAGE_PACK_ARTIFACT.to_owned(),
            serde_json::to_vec(&value).unwrap(),
        )])
    }

    #[test]
    fn validates_a_language_pack_artifact_against_the_install_record() {
        let pack = validate_package_files(
            "language_pack",
            "example-online",
            "1.0.0",
            &files("example-online", "1.0.0"),
        )
        .unwrap();
        assert_eq!(pack.locale, "en");
        assert_eq!(pack.messages["common.install"], "Install");
    }

    #[test]
    fn rejects_identity_mismatch_and_invalid_direction() {
        let error = validate_package_files(
            "language_pack",
            "other-pack",
            "1.0.0",
            &files("example-online", "1.0.0"),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("identity"));

        let mut invalid = files("example-online", "1.0.0");
        invalid.insert(
            LANGUAGE_PACK_ARTIFACT.to_owned(),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "id": "example-online",
                "name": "Example",
                "version": "1.0.0",
                "locale": "en",
                "baseLocale": "en",
                "direction": "sideways",
                "messages": { "common.install": "Install" }
            }))
            .unwrap(),
        );
        assert!(
            validate_package_files("language_pack", "example-online", "1.0.0", &invalid)
                .unwrap_err()
                .to_string()
                .contains("direction")
        );
    }

    #[test]
    fn rejects_control_characters_consistently_with_the_client_validator() {
        let invalid = serde_json::json!({
            "schemaVersion": 1,
            "id": "example-online",
            "name": "Example",
            "version": "1.0.0",
            "locale": "en",
            "baseLocale": "en",
            "direction": "ltr",
            "messages": { "common.install": "Install\u{007f}" }
        });
        let files = BTreeMap::from([(
            LANGUAGE_PACK_ARTIFACT.to_owned(),
            serde_json::to_vec(&invalid).unwrap(),
        )]);
        assert!(
            validate_package_files("language_pack", "example-online", "1.0.0", &files)
                .unwrap_err()
                .to_string()
                .contains("invalid message")
        );
    }

    #[test]
    fn locale_shape_matches_the_runtime_contract() {
        assert!(valid_locale("en"));
        assert!(valid_locale("en-x-online"));
        assert!(valid_locale("zh-Hant"));
        assert!(!valid_locale("e"));
        assert!(!valid_locale("en-u"));
        assert!(!valid_locale("x-private"));
        assert!(!valid_locale("EN_us"));
    }

    #[test]
    fn rejects_extra_language_pack_artifacts() {
        let mut files = files("example-online", "1.0.0");
        files.insert("README.md".to_owned(), b"not executable".to_vec());
        assert!(
            validate_package_files("language_pack", "example-online", "1.0.0", &files)
                .unwrap_err()
                .to_string()
                .contains("only")
        );
    }
}
