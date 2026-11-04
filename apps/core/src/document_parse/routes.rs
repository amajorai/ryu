//! Routes.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::document_parse::*;

// ── Routes ────────────────────────────────────────────────────────────────────
//
// All three are mounted in `apps/core/src/server/mod.rs` (see the module doc).

/// `GET /api/documents/parse/capability` — what this node can read, right now.
///
/// **Mounted** in the main route table (not `spaces_routes`): the bound provider
/// serves chat attachments as well as Space uploads, so this must answer on a node
/// with the Spaces app disabled.
///
/// Two consumers, one response:
/// - the desktop's **Document parsing** settings panel renders `provider_name`,
///   `available`, `extensions`, `missing_dependencies` and `max_input_bytes` from it
///   — every figure it prints about parsing comes from here rather than from a
///   client-side constant that cannot know which backend is bound;
/// - the composer's file-picker `accept` list is built from `extensions`, so the
///   picker offers exactly what the bound backend (plus the floor) can actually
///   handle instead of a hardcoded guess that drifts the moment a provider is
///   swapped.
///
/// Cheap by construction: it never wakes a sleeping provider (see the probe below),
/// so mounting a settings panel or a composer costs at most one refused loopback
/// connection.
#[utoipa::path(
    get,
    path = "/api/documents/parse/capability",
    tag = "Documents",
    summary = "Formats this node can extract text from",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn parse_capability(State(state): State<ServerState>) -> Response {
    let builtin: Vec<String> = BUILTIN_EXTENSIONS.iter().map(|s| (*s).to_owned()).collect();

    let Some((route, provider_name)) = bound_provider(&state).await else {
        // No provider bound. Honest, not empty: the floor still works, and the
        // caller needs to know the difference so it can tell the user why a PDF is
        // refused rather than dropping it.
        return Json(json!({
            "provider": Value::Null,
            "provider_name": Value::Null,
            "available": true,
            "extensions": builtin,
            "builtin_extensions": BUILTIN_EXTENSIONS,
            "missing_dependencies": [],
            "max_input_bytes": MAX_PARSE_BYTES,
        }))
        .into_response();
    };

    // A lazy provider is deliberately NOT woken to answer this. Every composer mount
    // asks what formats are readable; spinning a 1-2 GB Python process for a picker's
    // `accept` list would make opening a chat expensive. So the probe is a plain
    // short-timeout call: an asleep sidecar is refused by the manager's forward gate
    // (registered, claim held, process down) before anything is dialed at all, and we
    // answer with the floor plus the provider's identity. The format list fills in once
    // a real parse has woken it.
    let probe = provider_call(
        &state,
        &route,
        reqwest::Method::GET,
        &sibling_path(&route, "capability"),
        None,
        CAPABILITY_PROBE_TIMEOUT,
    )
    .await
    .ok();

    let (formats, missing, available) = match probe {
        Some((status, body)) if status.is_success() => {
            let formats: Vec<String> = body
                .get("formats")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let missing: Vec<String> = body
                .get("missing_dependencies")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let available = body
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            (formats, missing, available)
        }
        _ => (Vec::new(), Vec::new(), true),
    };

    let mut extensions: Vec<String> = builtin.clone();
    for f in formats {
        if !extensions.contains(&f) {
            extensions.push(f);
        }
    }
    extensions.sort();

    Json(json!({
        "provider": route.provider_id,
        "provider_name": provider_name,
        "available": available,
        "extensions": extensions,
        "builtin_extensions": BUILTIN_EXTENSIONS,
        "missing_dependencies": missing,
        "max_input_bytes": MAX_PARSE_BYTES,
    }))
    .into_response()
}

/// `POST /api/documents/parse` — submit bytes for extraction.
///
/// Raw request body + `x-filename` (the same shape as `POST /api/uploads`, so a
/// caller that already stages an upload does not have to learn a second encoding).
///
/// Returns one of three things, and **never** silently succeeds with nothing:
/// - `{ status: "succeeded", via: "builtin", markdown, truncated }` — the floor read it;
/// - `{ status: "queued", via: "<provider id>", job_id }` — poll [`parse_job`];
/// - `415 { code: "no_provider", extension }` — no floor, no provider that claims
///   it (or `415 { code: "not_text" }` for a text extension that is not UTF-8). The
///   caller shows this on the attachment chip.
///
/// Mounted with [`crate::server::uploads::DOCUMENT_PARSE_BODY_LIMIT`]: without that
/// layer, axum's implicit 2 MiB default would refuse the body before this handler's
/// `too_large` branch could name the real ceiling.
#[utoipa::path(
    post,
    path = "/api/documents/parse",
    tag = "Documents",
    summary = "Extract markdown from a document",
    description = "Send the document as the raw request body (any content type) with its \
        percent-encoded file name in `x-filename`; the extension decides how it is read. \
        Text formats are answered at once with `{ status: \"succeeded\", via: \"builtin\", \
        markdown, truncated }`. Other formats go to the node's bound document parser and \
        return `{ status: \"queued\", via, job_id }`; poll \
        `GET /api/documents/parse/jobs/{job_id}`. Errors: `400 empty`, \
        `413 too_large` (the body is over the node's upload ceiling), `415 not_text` \
        (a text extension whose bytes are not UTF-8), and `415 no_provider` (no installed \
        parser reads this format; `extension` names it).",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn parse_document(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "empty document", "code": "empty" })),
        )
            .into_response();
    }
    if body.len() > MAX_PARSE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": format!(
                    "document too large: {} bytes (max {} MB)",
                    body.len(),
                    MAX_PARSE_BYTES / (1024 * 1024)
                ),
                "code": "too_large",
            })),
        )
            .into_response();
    }

    // `x-filename` is percent-encoded by the caller. HTTP headers are Latin-1, so a
    // raw `Rapport financier — Q3.pdf` either throws in the browser's fetch or
    // arrives mojibake'd; percent-encoding is the only way a non-ASCII document name
    // survives the hop, and losing it would cost the extension the dispatch depends on.
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "document".to_owned());
    let ext = extension_of(&filename);

    // 1. Floor first — a text file must not depend on an opt-in 1-2 GB install.
    if is_builtin_readable(&filename) {
        return match builtin_markdown(&filename, &body) {
            Some((markdown, truncated)) => Json(json!({
                "status": "succeeded",
                "via": "builtin",
                "filename": filename,
                "markdown": markdown,
                "truncated": truncated,
            }))
            .into_response(),
            None => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({
                    "error": format!("{filename} is not valid UTF-8 text"),
                    "code": "not_text",
                    "extension": ext,
                })),
            )
                .into_response(),
        };
    }

    // 2. Otherwise the bound provider, or an honest refusal that names the format.
    let Some((route, provider_name)) = bound_provider(&state).await else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(json!({
                "error": format!(
                    "no document parser is installed that can read {}",
                    if ext.is_empty() { "this file" } else { ext.as_str() }
                ),
                "code": "no_provider",
                "extension": ext,
            })),
        )
            .into_response();
    };

    let _activity = match wake_provider(&state, &route).await {
        Ok(guard) => guard,
        Err(resp) => return resp,
    };

    // The provider takes inline bytes (`content_base64`) rather than a path: Core
    // holds the request body in memory and has no shared staging contract with an
    // arbitrary provider, and handing a provider a filesystem path it then reads
    // would be an arbitrary-file-read primitive if the path ever came from a client.
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
    let (status, value) = match provider_call(
        &state,
        &route,
        reqwest::Method::POST,
        &route.upstream_path,
        Some(json!({ "content_base64": encoded, "filename": filename })),
        PROVIDER_TIMEOUT,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("document parser rejected this file");
        return (
            status,
            Json(json!({
                "error": msg,
                "code": value.get("error_code").and_then(Value::as_str).unwrap_or("provider_error"),
                "provider": route.provider_id,
                "provider_name": provider_name,
            })),
        )
            .into_response();
    }

    let Some(job_id) = value.get("job_id").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "document parser accepted the file but returned no job id",
                "code": "provider_contract",
            })),
        )
            .into_response();
    };

    Json(json!({
        "status": value.get("status").and_then(Value::as_str).unwrap_or("queued"),
        "via": route.provider_id,
        "provider_name": provider_name,
        "job_id": job_id,
        "filename": filename,
    }))
    .into_response()
}
