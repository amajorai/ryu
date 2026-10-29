//! User-upload kernel surface — files land in the **Uploads** system space.
//!
//! Chat attachments, page/editor media, and the host `ui.uploadFile` bridge all
//! persist here (content-addressed Spaces blobs), not in the legacy
//! `~/.ryu/media/` store. The HTTP surface stays **ungated** by the Spaces app
//! (same reason `/api/media/*` is ungated): uploads are kernel storage that Voice
//! / chat / the editor need even when the Spaces UI is off. Serving is scoped to
//! documents that actually live in the Uploads space so this is not a backdoor
//! into arbitrary Space files.

use std::collections::HashMap;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::MethodRouter,
    Extension, Json,
};
use serde_json::json;

use super::spaces::{self, UPLOADS_SPACE_NAME};
use super::{caller_tenancy, ServerState};

/// **The one ceiling on file content this node enforces, on every route that
/// accepts a file.** 32 MiB.
///
/// Cap mirrors the legacy media upload limit (editor pastes / chat images), and
/// three other things are defined in terms of it rather than repeating it:
/// [`crate::document_parse::MAX_PARSE_BYTES`] ("a file you can attach is a file the
/// parser will look at"), the desktop's `NODE_UPLOAD_MAX_BYTES` mirror, and — since
/// the alignment described on [`SPACE_FILE_BODY_LIMIT`] — `MAX_FILE_BYTES`, the cap
/// `POST /api/spaces/:id/files` checks its decoded body against.
pub const MAX_UPLOAD_BYTES: usize = super::media::MAX_MEDIA_BYTES;

/// Headroom above the base64 payload for the rest of the JSON envelope on
/// `POST /api/spaces/:id/files` — `{"title":…,"mime":…,"data_base64":"…"}` — so a
/// file of exactly [`MAX_UPLOAD_BYTES`] is not refused by the wire limit for the
/// sake of its own filename.
///
/// 64 KiB is far more than any `title`/`mime` pair, and deliberately small relative
/// to the payload: it is slack, not a second limit. `wire_ceiling_is_slack_not_a_loophole`
/// pins that the largest file it can smuggle past the layer is still caught by the
/// handler's exact check.
pub const JSON_ENVELOPE_SLACK_BYTES: usize = 64 * 1024;

/// Bytes on the wire needed to carry `decoded_bytes` of file as base64 inside a JSON
/// envelope: 4 output characters per 3 input bytes, rounded up to the block, plus
/// [`JSON_ENVELOPE_SLACK_BYTES`].
///
/// This is why a body limit and a file limit are two different numbers on the JSON
/// route, and why setting the body limit *to* the file limit would silently cut the
/// real ceiling to three quarters of the advertised one.
pub const fn base64_wire_ceiling(decoded_bytes: usize) -> usize {
    decoded_bytes.div_ceil(3) * 4 + JSON_ENVELOPE_SLACK_BYTES
}

/// Largest file that `b64_len` base64 characters can possibly decode to — a full
/// 3 bytes per 4-character block, i.e. no padding.
///
/// Deliberately unused on the request path: it is the bound the size pre-check must
/// **not** refuse on (see [`decoded_len_lower_bound`]), and it is kept here, next to
/// its twin, so the tests that prove that can compute it and a future reader can see
/// both bounds side by side rather than rediscovering the padding trap.
#[allow(dead_code)]
pub const fn decoded_len_upper_bound(b64_len: usize) -> usize {
    b64_len / 4 * 3
}

/// Smallest file that `b64_len` base64 characters can possibly decode to: the same
/// blocks, minus the up-to-two `=` padding bytes the final block may carry.
///
/// **This — not the upper bound — is what the size pre-check refuses on**, and the
/// distinction is not academic. A file of exactly [`MAX_UPLOAD_BYTES`] (which is
/// `3n + 2` bytes) encodes to a block whose *upper* bound is one byte over the limit,
/// so pre-checking the upper bound rejects a file that fits — with a 413 quoting a
/// limit the user did not exceed. Rejecting on the lower bound can never refuse a file
/// that would have fit; it only skips the decode for uploads that are unambiguously
/// too big. The exact boundary is enforced after decoding, on the real length.
pub const fn decoded_len_lower_bound(b64_len: usize) -> usize {
    (b64_len / 4 * 3).saturating_sub(2)
}

/// How a route carries file content, which is the whole reason its body limit and
/// its file limit can differ.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BodyEncoding {
    /// The request body *is* the file (`POST /api/uploads`).
    Raw,
    /// The file rides base64-encoded inside a JSON object
    /// (`POST /api/spaces/:id/files`).
    Base64Json,
}

impl BodyEncoding {
    const fn wire_name(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Base64Json => "base64-json",
        }
    }
}

/// A route's two ceilings and the one message that explains either of them.
///
/// ## Why this type exists rather than a bare `DefaultBodyLimit::max(N)`
///
/// Three ceilings used to govern uploads and none of them was the advertised one:
///
/// | route | declared | actually enforced |
/// |---|---|---|
/// | `POST /api/uploads` | 32 MiB | 32 MiB (limit layered explicitly) |
/// | `POST /api/media/upload` | 32 MiB | 32 MiB (limit layered explicitly) |
/// | `POST /api/spaces/:id/files` | **200 MiB** | **~1.5 MiB of file** |
///
/// The third row is the defect. That route was registered with no
/// [`axum::extract::DefaultBodyLimit`], so axum's implicit 2 MiB default rejected the
/// request in the *layer* — before the handler's 200 MiB check could run — and its
/// body is base64, so 2 MiB of wire is only ~1.5 MiB of file. The settings panel
/// printed 200 MiB as "Maximum file in a Space". A user following the UI got a bare
/// 413 at 1/133rd of the number they had just read.
///
/// Bundling `route` + both ceilings into one value is what makes that unrepeatable:
/// the limit a route enforces, the layer that enforces it, and the sentence a
/// rejection prints all come from the same place, and [`upload_limits`] serves that
/// same place to the settings panel instead of the panel hardcoding a figure.
#[derive(Clone, Copy)]
pub struct BodyLimit {
    /// Method + path as the user's client wrote it, so a rejection says which of
    /// several upload routes refused them.
    pub route: &'static str,
    /// Ceiling on the request body **as transmitted**. Enforced by the layer.
    pub max_body_bytes: usize,
    /// Ceiling on the **file content** once decoded. Enforced by the handler.
    /// Equal to `max_body_bytes` when [`BodyEncoding::Raw`].
    pub max_file_bytes: usize,
    pub encoding: BodyEncoding,
}

impl BodyLimit {
    /// The sentence a rejection prints. Names the route and the ceiling in units a
    /// person reads, and for an encoded route says *both* numbers, because "your
    /// 33 MB file is over the 42 MB body limit" is exactly the confusion the base64
    /// expansion causes.
    pub fn too_large_message(&self, observed: Observed) -> String {
        let file_mib = self.max_file_bytes / (1024 * 1024);
        let seen = match observed {
            Observed::FileBytes(n) => format!("file is {n} bytes"),
            Observed::BodyBytes(n) => format!("request body is {n} bytes"),
            Observed::BodyOverLimit => "request body is over the limit".to_owned(),
        };
        match self.encoding {
            BodyEncoding::Raw => format!(
                "too large for {}: {seen}, and this node's limit is {} bytes ({file_mib} MiB) per file",
                self.route, self.max_file_bytes
            ),
            BodyEncoding::Base64Json => format!(
                "too large for {}: {seen}, and this node's limit is {} bytes ({file_mib} MiB) per file — \
                 which this route carries base64-encoded in JSON, so its request body may not exceed {} bytes",
                self.route, self.max_file_bytes, self.max_body_bytes
            ),
        }
    }

    /// Apply this limit to a route: the body-size layer, plus a middleware that turns
    /// the layer's bare 413 into [`too_large_message`](Self::too_large_message).
    ///
    /// **Order is load-bearing.** The explainer must wrap the limit, not the other way
    /// round, or it never observes the rejection it exists to explain. `axum` applies
    /// the *last* `.layer` outermost, so the explainer is added second — and
    /// `an_over_limit_body_is_refused_with_the_route_and_the_ceiling` fails outright
    /// if that ever inverts.
    pub fn apply<S>(self, route: MethodRouter<S>) -> MethodRouter<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        route
            .layer(axum::extract::DefaultBodyLimit::max(self.max_body_bytes))
            .layer(axum::middleware::from_fn(
                move |req: axum::extract::Request, next: axum::middleware::Next| async move {
                    let response = next.run(req).await;
                    if response.status() != StatusCode::PAYLOAD_TOO_LARGE {
                        return response;
                    }
                    // A 413 the *handler* produced already carries a JSON explanation
                    // built from this same value; only the layer's bare text/plain
                    // rejection needs rewriting. Rewriting both would replace a
                    // message that names the observed size with one that cannot.
                    let already_explained = response
                        .headers()
                        .get(header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| v.starts_with("application/json"));
                    if already_explained {
                        return response;
                    }
                    (
                        StatusCode::PAYLOAD_TOO_LARGE,
                        Json(json!({ "error": self.too_large_message(Observed::BodyOverLimit) })),
                    )
                        .into_response()
                },
            ))
    }

    fn to_json(self) -> serde_json::Value {
        json!({
            "route": self.route,
            "max_file_bytes": self.max_file_bytes,
            "max_body_bytes": self.max_body_bytes,
            "encoding": self.encoding.wire_name(),
        })
    }
}

/// What the rejecting code actually measured. The layer only knows "over" — it never
/// sees a length, because refusing to buffer the body is the point.
#[derive(Clone, Copy)]
pub enum Observed {
    FileBytes(usize),
    BodyBytes(usize),
    BodyOverLimit,
}

/// `POST /api/uploads` — raw bytes, so body limit == file limit.
pub const UPLOADS_BODY_LIMIT: BodyLimit = BodyLimit {
    route: "POST /api/uploads",
    max_body_bytes: MAX_UPLOAD_BYTES,
    max_file_bytes: MAX_UPLOAD_BYTES,
    encoding: BodyEncoding::Raw,
};

/// `POST /api/spaces/:id/files` — **the route this unit realigned.**
///
/// It now enforces the same [`MAX_UPLOAD_BYTES`] file ceiling as `/api/uploads`, and
/// carries a body limit of [`base64_wire_ceiling`] of it (~42.7 MiB) so that ceiling
/// is actually reachable.
///
/// ## Why 32 MiB and not the 200 MiB it declared
///
/// Honouring 200 MiB here means accepting a ~267 MiB JSON body and decoding it to
/// 200 MiB. Peak transient memory on this path is roughly *three* copies — the
/// buffered wire `Bytes`, serde's owned `String` for `data_base64`, and the decoded
/// `Vec<u8>` — so 200 MiB of file is ~800 MiB per concurrent request. That is a
/// denial-of-service shape, not a feature, and it would have been the first time the
/// number was ever reachable: no client has ever successfully sent this route more
/// than ~1.5 MiB.
///
/// And the `space.write` gate does **not** contain that cost. `enforce_permission`
/// runs inside `create_file`, i.e. after the layer has buffered the body and the
/// `Json` extractor has parsed it — so the buffer-and-parse is reachable by any
/// authenticated caller, permitted or not. Sizing this route as if RBAC bounded who
/// can spend the memory would be sizing it wrong.
///
/// 32 MiB is the honest direction for a second reason: `/api/uploads` already accepts
/// a 32 MiB body from the same population of callers, so the marginal exposure of
/// accepting ~43 MiB here is bounded by a figure this node already accepts. The 3x
/// decode multiplier is the one thing genuinely worse than the raw route, and at
/// 32 MiB it is bounded at ~128 MiB transient rather than ~800 MiB.
///
/// The alternative — keeping two different file ceilings and labelling each — was
/// rejected because every surface in the desktop uploads through `/api/uploads`; a
/// second, smaller "but in a Space" number would describe a path no user takes.
pub const SPACE_FILE_BODY_LIMIT: BodyLimit = BodyLimit {
    route: "POST /api/spaces/:id/files",
    max_body_bytes: base64_wire_ceiling(MAX_UPLOAD_BYTES),
    max_file_bytes: MAX_UPLOAD_BYTES,
    encoding: BodyEncoding::Base64Json,
};

/// `POST /api/documents/parse` — raw bytes for extraction (the SDK's document
/// loaders and the composer seam). Its ceiling is [`crate::document_parse::MAX_PARSE_BYTES`],
/// which is [`MAX_UPLOAD_BYTES`] by design: a document only reaches a parser by
/// being something the node would accept as an upload.
pub const DOCUMENT_PARSE_BODY_LIMIT: BodyLimit = BodyLimit {
    route: "POST /api/documents/parse",
    max_body_bytes: crate::document_parse::MAX_PARSE_BYTES,
    max_file_bytes: crate::document_parse::MAX_PARSE_BYTES,
    encoding: BodyEncoding::Raw,
};

/// Every route that accepts a file, in the order a limits panel would list them.
/// [`upload_limits`] serves this, so a route added without a row here is a route the
/// user cannot be told about.
pub const FILE_ROUTE_LIMITS: [BodyLimit; 3] = [
    UPLOADS_BODY_LIMIT,
    SPACE_FILE_BODY_LIMIT,
    DOCUMENT_PARSE_BODY_LIMIT,
];

/// `GET /api/uploads/limits` — the upload ceilings this node compiles in.
///
/// Exists so a settings panel prints a number it *fetched* rather than a number it
/// mirrored: the 200 MiB row this unit removed was a hand-copied constant that stayed
/// truthful for exactly as long as nobody changed Core.
///
/// `max_file_bytes` is the headline — the one number that governs every upload — and
/// `uniform` says whether it really is one number. While `uniform` is true a panel
/// prints a single row; if a future route ever enforces a different file ceiling,
/// `uniform` goes false and the panel must render `routes` instead. That is the
/// mechanism behind "one label must not describe two ceilings": the client is told
/// when its single label stopped being true.
#[utoipa::path(
    get,
    path = "/api/uploads/limits",
    tag = "Uploads",
    summary = "Upload size ceilings enforced by this node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn upload_limits() -> Json<serde_json::Value> {
    let smallest = FILE_ROUTE_LIMITS
        .iter()
        .map(|l| l.max_file_bytes)
        .min()
        .unwrap_or(MAX_UPLOAD_BYTES);
    let uniform = FILE_ROUTE_LIMITS
        .iter()
        .all(|l| l.max_file_bytes == smallest);
    Json(json!({
        "max_file_bytes": smallest,
        "uniform": uniform,
        "routes": FILE_ROUTE_LIMITS.iter().map(|l| l.to_json()).collect::<Vec<_>>(),
    }))
}

/// `POST /api/uploads` — store raw request-body bytes as a file document in the
/// Uploads system space. Filename from `x-filename` / `?name=`; content-type from
/// the `content-type` header. Returns id + serve URL (`/api/uploads/<id>`).
#[utoipa::path(
    post,
    path = "/api/uploads",
    tag = "Uploads",
    summary = "Store a user file in the Uploads system space",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn upload_file(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "empty upload" })),
        )
            .into_response();
    }
    // Reachable only for a body between the layer's ceiling and this one — which for
    // a raw route is nothing, since they are the same number. Kept because the two
    // ceilings are separate fields that a future encoding change could separate, and
    // a handler that trusts its layer is a handler that stops checking.
    if body.len() > MAX_UPLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": UPLOADS_BODY_LIMIT.too_large_message(Observed::BodyBytes(body.len()))
            })),
        )
            .into_response();
    }

    let name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| params.get("name").cloned())
        .unwrap_or_else(|| "upload".to_string());
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or(c).trim().to_owned())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_owned());

    let space_id = match state
        .spaces
        .ensure_system_space(
            UPLOADS_SPACE_NAME,
            Some("Files you upload in chat and pages"),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("upload_file: ensuring Uploads space: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "failed to resolve Uploads space" })),
            )
                .into_response();
        }
    };

    let title = if name.trim().is_empty() {
        "Untitled"
    } else {
        name.trim()
    };
    let tenancy = spaces::owner_of(&caller_tenancy(&caller));
    // Through the shared ingest path, NOT `store.create_file` directly: that one
    // indexes a file by its `{title}\n{mime}` descriptor only, so a PDF dropped in
    // chat was searchable by its filename and by nothing inside it. `index` reports
    // what happened to the contents — never an error, since a file the parser cannot
    // read is still a file the user wanted stored. See [`crate::space_file_index`].
    match crate::space_file_index::create_file_indexed(
        &state, &space_id, title, &body, &mime, &tenancy,
    )
    .await
    {
        Ok(created) => (
            StatusCode::OK,
            Json(json!({
                "id": created.document_id,
                "space_id": space_id,
                "file_name": title,
                "url": format!("/api/uploads/{}", created.document_id),
                "size": body.len(),
                "content_type": mime,
                "index": created.index.to_json(),
            })),
        )
            .into_response(),
        Err(e) => {
            let message = e.to_string();
            let status = if message.contains("file quota exceeded") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            tracing::error!("upload_file: create_file: {e:#}");
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

/// `GET /api/uploads/:id` — serve a file that lives in the Uploads system space.
/// Images render inline (editor `<img>`); risky MIME types are neutralized.
#[utoipa::path(
    get,
    path = "/api/uploads/{id}",
    tag = "Uploads",
    summary = "Serve a user upload from the Uploads system space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK"))
)]
pub async fn serve_upload(
    State(state): State<ServerState>,
    Path(doc_id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    // Uploads are Spaces content, so the coarse Spaces read permission is required
    // before any metadata or blob lookup. The per-document check below is still
    // necessary because a node member may be allowed to use Spaces without being
    // allowed to read this particular private upload.
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    .is_err()
    {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let Some(meta) = (match state.spaces.get_file_meta(&doc_id).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    }) else {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    };

    // Only documents in the Uploads system space are reachable here.
    let uploads_id = match state
        .spaces
        .ensure_system_space(UPLOADS_SPACE_NAME, None)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("serve_upload: ensuring Uploads space: {e:#}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    if meta.space_id != uploads_id {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    }

    if let Err(response) = super::require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "upload not found",
    ) {
        return response;
    }

    let Some((mime, bytes)) = (match state.spaces.read_file_blob(&doc_id).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    }) else {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    };

    let content_type = safe_inline_mime(&mime);
    let is_image = content_type.starts_with("image/");
    if is_image {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable".to_owned(),
                ),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            ],
            bytes,
        )
            .into_response()
    } else {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CONTENT_DISPOSITION, "attachment".to_owned()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "sandbox; default-src 'none'".to_owned(),
                ),
            ],
            bytes,
        )
            .into_response()
    }
}

/// Collapse script-capable MIME types; leave images/PDF/plain data alone so the
/// editor can render uploads inline.
fn safe_inline_mime(mime: &str) -> String {
    let base = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let risky = matches!(
        base.as_str(),
        "text/html" | "application/xhtml+xml" | "image/svg+xml" | "application/xml" | "text/xml"
    ) || base.ends_with("+xml")
        || base.is_empty();
    if risky {
        "application/octet-stream".to_owned()
    } else {
        mime.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        base64_wire_ceiling, decoded_len_lower_bound, decoded_len_upper_bound, header,
        safe_inline_mime, upload_limits, BodyEncoding, Bytes, Observed, StatusCode,
        FILE_ROUTE_LIMITS, JSON_ENVELOPE_SLACK_BYTES, MAX_UPLOAD_BYTES, SPACE_FILE_BODY_LIMIT,
        UPLOADS_BODY_LIMIT,
    };

    /// Axum 0.7's implicit body limit for any route that does not layer its own
    /// [`axum::extract::DefaultBodyLimit`]. Not exported by axum, so it is restated
    /// here and *proved* by [`a_route_without_an_explicit_limit_caps_at_axums_default`]
    /// rather than trusted.
    const AXUM_DEFAULT_BODY_LIMIT: usize = 2 * 1024 * 1024;

    /// A router shaped exactly like one `.route(path, post(handler))` registration,
    /// with the body limit applied only when `limit` is `Some`.
    fn json_router(limit: Option<usize>) -> axum::Router {
        let route = axum::routing::post(|_: Bytes| async { StatusCode::OK });
        let route = match limit {
            Some(n) => route.layer(axum::extract::DefaultBodyLimit::max(n)),
            None => route,
        };
        axum::Router::new().route("/f", route)
    }

    async fn post_bytes(router: axum::Router, len: usize) -> StatusCode {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/f")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(vec![b'x'; len]))
            .unwrap();
        router.oneshot(request).await.unwrap().status()
    }

    /// **The explicit `DefaultBodyLimit` on `/api/uploads` is load-bearing, and its
    /// absence elsewhere is a ceiling nobody wrote down.**
    ///
    /// A route registered without one does not inherit [`MAX_UPLOAD_BYTES`] or any
    /// other project constant — it inherits axum's own 2 MiB default, and the
    /// rejection happens in the *layer*, before the handler's own size check can
    /// produce a message naming the real limit.
    ///
    /// This was not a hypothetical. `POST /api/spaces/:id/files` was registered in
    /// `server::mod` with no limit layer while its handler checked a 200 MiB
    /// `MAX_FILE_BYTES`, so the constant it advertised was unreachable by a factor of
    /// ~100 (and worse still by 4/3, because that body is base64) — see
    /// [`the_unlayered_json_route_capped_at_just_under_1_5_mib_of_file`] for the
    /// measurement. The desktop's upload-limits panel printed that 200 MiB figure.
    /// Both routes now declare their limit through a [`super::BodyLimit`]; this test
    /// stays because it is the reason they must.
    #[tokio::test]
    async fn a_route_without_an_explicit_limit_caps_at_axums_default() {
        let over = AXUM_DEFAULT_BODY_LIMIT + 1;
        assert_eq!(
            post_bytes(json_router(None), over).await,
            StatusCode::PAYLOAD_TOO_LARGE,
            "an unlayered route must reject just over 2 MiB — if this ever passes, \
             axum's default moved and every un-layered route's real ceiling moved with it"
        );
        assert_eq!(
            post_bytes(json_router(None), AXUM_DEFAULT_BODY_LIMIT).await,
            StatusCode::OK
        );
    }

    /// The same body an unlayered route refuses is accepted once the route declares
    /// the limit this module compiles in — which is what makes [`MAX_UPLOAD_BYTES`]
    /// the number `/api/uploads` truly enforces, and therefore the only upload
    /// ceiling a settings panel may print.
    /// The premise the test below rests on, checked at COMPILE time: if
    /// [`MAX_UPLOAD_BYTES`] ever drops to or under axum's default, the test stops
    /// distinguishing the layered route from the unlayered one and would keep
    /// passing while proving nothing.
    const _: () = assert!(MAX_UPLOAD_BYTES > AXUM_DEFAULT_BODY_LIMIT);

    #[tokio::test]
    async fn the_explicit_limit_is_what_makes_max_upload_bytes_real() {
        assert_eq!(
            post_bytes(
                json_router(Some(MAX_UPLOAD_BYTES)),
                AXUM_DEFAULT_BODY_LIMIT + 1
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            post_bytes(json_router(Some(MAX_UPLOAD_BYTES)), MAX_UPLOAD_BYTES + 1).await,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    /// A JSON envelope shaped exactly like `CreateFileBody`, wrapping `file_bytes`
    /// bytes of file. The envelope is part of the measurement: the wire cost of an
    /// upload is the base64 payload *plus* the object around it.
    fn create_file_envelope(file_bytes: usize) -> Vec<u8> {
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD.encode(vec![0u8; file_bytes]);
        serde_json::to_vec(&serde_json::json!({
            "title": "f.bin",
            "mime": "application/octet-stream",
            "data_base64": data,
        }))
        .unwrap()
    }

    async fn post_body(router: axum::Router, body: Vec<u8>) -> (StatusCode, String) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/f")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(body))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    /// **The ~1.5 MiB figure, measured rather than derived.**
    ///
    /// This is what `POST /api/spaces/:id/files` enforced before this unit: no
    /// `DefaultBodyLimit` layer, so axum's implicit 2 MiB cap applied — and because
    /// the file rides base64 inside JSON, 2 MiB of wire is only three quarters of that
    /// in file, minus the envelope. A handler checking 200 MiB never saw the request.
    ///
    /// Both directions are asserted because only the pair pins the number: a file just
    /// under it goes through, and a *round* 1.5 MiB does not — the envelope has to fit
    /// as well, which is why the true ceiling is a few dozen bytes shy of 1.5 MiB
    /// rather than at it.
    #[tokio::test]
    async fn the_unlayered_json_route_capped_at_just_under_1_5_mib_of_file() {
        let (status, _) = post_body(json_router(None), create_file_envelope(1_500_000)).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "1.5 MB of file still fits inside axum's 2 MiB default"
        );

        let one_and_a_half_mib = 3 * 1024 * 1024 / 2;
        let (status, _) =
            post_body(json_router(None), create_file_envelope(one_and_a_half_mib)).await;
        assert_eq!(
            status,
            StatusCode::PAYLOAD_TOO_LARGE,
            "a full 1.5 MiB base64-expands to exactly the 2 MiB limit, so the envelope \
             around it pushes the request over — the real ceiling is just under 1.5 MiB"
        );
    }

    /// **The composed limit stack answers an over-limit body with the route and the
    /// ceiling** — not with a bare 413, which is what a user following the settings
    /// panel used to get.
    ///
    /// This also pins the layer ORDER. The explainer only ever sees the rejection if
    /// it wraps the body limit; if the two `.layer` calls in
    /// [`super::BodyLimit::apply`] are ever swapped, the response is axum's plain-text
    /// 413 and the `contains` assertions below fail.
    #[tokio::test]
    async fn an_over_limit_body_is_refused_with_the_route_and_the_ceiling() {
        let router = axum::Router::new().route(
            "/f",
            SPACE_FILE_BODY_LIMIT.apply(axum::routing::post(|_: Bytes| async { StatusCode::OK })),
        );
        let over = vec![b'x'; SPACE_FILE_BODY_LIMIT.max_body_bytes + 1];
        let (status, body) = post_body(router, over).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            body.contains("POST /api/spaces/:id/files"),
            "a rejection must name the route that refused it, got: {body}"
        );
        assert!(
            body.contains(&MAX_UPLOAD_BYTES.to_string()),
            "a rejection must name the limit it enforced, got: {body}"
        );
        assert!(
            body.contains(&SPACE_FILE_BODY_LIMIT.max_body_bytes.to_string()),
            "an encoded route must also name the WIRE limit, or a 32 MiB file refused \
             by a 42 MiB body limit reads as arithmetic nonsense, got: {body}"
        );

        // The control, so the assertions above cannot pass for the wrong reason. The
        // SAME over-limit body through the SAME limit without the explainer is what a
        // user got before this unit: a 413 that names nothing. If this ever starts
        // containing the route, the explainer has stopped being the thing that
        // explains, and the assertions above are proving nothing.
        let bare = axum::Router::new().route(
            "/f",
            axum::routing::post(|_: Bytes| async { StatusCode::OK }).layer(
                axum::extract::DefaultBodyLimit::max(SPACE_FILE_BODY_LIMIT.max_body_bytes),
            ),
        );
        let (status, body) =
            post_body(bare, vec![b'x'; SPACE_FILE_BODY_LIMIT.max_body_bytes + 1]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            !body.contains("POST /api/spaces/:id/files"),
            "axum's own rejection names no route: {body}"
        );
    }

    /// The handler's own 413 is more informative than the layer's — it knows the size
    /// it measured — so the explainer must leave it alone. Two rejection paths, two
    /// different code paths, both asserted.
    #[tokio::test]
    async fn a_413_the_handler_already_explained_is_not_rewritten() {
        let router = axum::Router::new().route(
            "/f",
            SPACE_FILE_BODY_LIMIT.apply(axum::routing::post(|_: Bytes| async {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    axum::Json(serde_json::json!({ "error": "handler measured 40000000 bytes" })),
                )
            })),
        );
        let (status, body) = post_body(router, create_file_envelope(1_000)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            body.contains("handler measured 40000000 bytes"),
            "the handler's own message must survive the explainer, got: {body}"
        );
    }

    /// The envelope slack exists so a file of exactly [`MAX_UPLOAD_BYTES`] is not
    /// refused for the size of its own filename. It must not become a second, larger
    /// limit — so the most a full wire body could possibly decode to stays within one
    /// slack-width of the real ceiling.
    #[test]
    fn wire_ceiling_is_slack_not_a_loophole() {
        let encoded_at_ceiling = base64_wire_ceiling(MAX_UPLOAD_BYTES) - JSON_ENVELOPE_SLACK_BYTES;
        assert!(
            encoded_at_ceiling <= SPACE_FILE_BODY_LIMIT.max_body_bytes,
            "a file of exactly the limit must fit on the wire"
        );
        let smuggled = decoded_len_upper_bound(SPACE_FILE_BODY_LIMIT.max_body_bytes);
        assert!(
            smuggled <= MAX_UPLOAD_BYTES + JSON_ENVELOPE_SLACK_BYTES,
            "the wire limit must not admit meaningfully more file than the file limit: \
             {smuggled} vs {MAX_UPLOAD_BYTES}"
        );
    }

    /// **The handler's exact check is reachable, so it is not dead code.**
    ///
    /// Naming a test after an invariant obliges it to cover the invariant: this one
    /// proves a file exists that the *layer* admits and the *handler* must refuse —
    /// i.e. one in the band the slack opens. Without that band the handler check would
    /// be unreachable behind the layer and a future reader would be right to delete
    /// it, taking the precise "your file is N bytes" message with it.
    #[test]
    fn the_slack_leaves_a_band_where_only_the_handler_can_refuse() {
        let near_miss = MAX_UPLOAD_BYTES + 1;
        let wire = base64_wire_ceiling(near_miss) - JSON_ENVELOPE_SLACK_BYTES + 64;
        assert!(
            wire <= SPACE_FILE_BODY_LIMIT.max_body_bytes,
            "a file one byte over the limit still fits under the wire ceiling, so the \
             layer passes it through"
        );
        assert!(
            near_miss > SPACE_FILE_BODY_LIMIT.max_file_bytes,
            "and the handler is what refuses it"
        );
        // Which is also why the handler rejects from the ENCODED length: it can decide
        // without allocating the decode buffer.
        assert!(decoded_len_lower_bound(wire) > MAX_UPLOAD_BYTES);
    }

    /// **A file of exactly the limit must be accepted, and the cheap pre-check is
    /// where that is easy to get wrong.**
    ///
    /// [`MAX_UPLOAD_BYTES`] is `3n + 2` bytes, so its base64 block carries one padding
    /// byte and [`decoded_len_upper_bound`] of that encoding is one byte *over* the
    /// limit. A pre-check written against the upper bound therefore 413s a file that
    /// fits, quoting a ceiling the user did not exceed — the same class of defect as
    /// the 200 MiB label this unit removed, just one byte wide instead of 133x.
    #[test]
    fn a_file_of_exactly_the_limit_survives_the_pre_check() {
        use base64::Engine as _;
        // The encoded-length formula, checked against a real encoder on a `3n + 2`
        // input (the shape that produces one padding byte) so it cannot drift from
        // what base64 actually emits — then applied to the real ceiling rather than
        // allocating 32 MiB to observe the same thing.
        assert_eq!(MAX_UPLOAD_BYTES % 3, 2);
        let sample = vec![0u8; 3 * 5 + 2];
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .encode(&sample)
                .len(),
            sample.len().div_ceil(3) * 4
        );
        let encoded_len = MAX_UPLOAD_BYTES.div_ceil(3) * 4;
        assert!(
            decoded_len_lower_bound(encoded_len) <= MAX_UPLOAD_BYTES,
            "the pre-check must let a file of exactly the limit through to the decode"
        );
        assert!(
            decoded_len_upper_bound(encoded_len) > MAX_UPLOAD_BYTES,
            "and the upper bound must NOT be used for it — this is the trap: {} > {}",
            decoded_len_upper_bound(encoded_len),
            MAX_UPLOAD_BYTES
        );
        // One base64 block more is unambiguously over, and the pre-check catches it.
        assert!(decoded_len_lower_bound(encoded_len + 4) > MAX_UPLOAD_BYTES);
    }

    /// One label, one ceiling. Every route that accepts a file enforces the same
    /// number of file bytes, which is what entitles a settings panel to print a single
    /// "maximum file you can upload" row.
    #[tokio::test]
    async fn every_file_route_enforces_the_same_file_ceiling() {
        for limit in FILE_ROUTE_LIMITS {
            assert_eq!(
                limit.max_file_bytes, MAX_UPLOAD_BYTES,
                "{} enforces a different file ceiling — if that is deliberate, the \
                 single-row settings label is now a lie and must be split per route",
                limit.route
            );
        }
        let served = upload_limits().await.0;
        assert_eq!(served["max_file_bytes"], MAX_UPLOAD_BYTES);
        assert_eq!(served["uniform"], true);
        assert_eq!(served["routes"].as_array().unwrap().len(), 3);
        assert_eq!(served["routes"][2]["route"], "POST /api/documents/parse");
        // The per-route detail is served even while uniform, so a client that wants to
        // say "and this one carries it base64" never has to guess.
        assert_eq!(served["routes"][1]["route"], "POST /api/spaces/:id/files");
        assert_eq!(served["routes"][1]["encoding"], "base64-json");
        assert_eq!(
            served["routes"][1]["max_body_bytes"],
            SPACE_FILE_BODY_LIMIT.max_body_bytes
        );
        assert_eq!(served["routes"][0]["encoding"], "raw");
    }

    /// `/api/uploads/limits` sits beside `/api/uploads/:id`, so the static segment
    /// must win — otherwise the new endpoint is silently swallowed as a request for a
    /// document whose id is the word "limits", and the settings panel gets a 404 that
    /// looks like "this node has no limits".
    #[tokio::test]
    async fn the_limits_endpoint_is_not_shadowed_by_the_serve_by_id_route() {
        use tower::ServiceExt as _;
        let router = axum::Router::new()
            .route("/api/uploads/limits", axum::routing::get(upload_limits))
            .route(
                "/api/uploads/:id",
                axum::routing::get(|| async { "served a document" }),
            );
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/uploads/limits")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let served: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(served["max_file_bytes"], MAX_UPLOAD_BYTES);
    }

    /// A raw route must not print a wire limit (it has none distinct from its file
    /// limit); an encoded one must, or the two numbers look like a contradiction.
    #[test]
    fn the_rejection_message_matches_how_the_route_carries_the_file() {
        let raw = UPLOADS_BODY_LIMIT.too_large_message(Observed::BodyBytes(99));
        assert!(raw.contains("POST /api/uploads"));
        assert!(raw.contains("request body is 99 bytes"));
        assert!(
            !raw.contains("base64"),
            "nothing is encoded on a raw route: {raw}"
        );

        let encoded = SPACE_FILE_BODY_LIMIT.too_large_message(Observed::FileBytes(99));
        assert!(encoded.contains("file is 99 bytes"));
        assert!(encoded.contains("base64-encoded"));
        assert_eq!(SPACE_FILE_BODY_LIMIT.encoding, BodyEncoding::Base64Json);
    }

    /// The live registrations, pinned in source. The tests above exercise stub routers,
    /// so on their own they would prove the policy works without proving the real
    /// routes use it — the exact overreach this repo has shipped before.
    #[test]
    fn the_real_routes_declare_their_limits_through_body_limit() {
        let server = include_str!("mod.rs").replace("\r\n", "\n");
        assert!(
            server.contains("uploads::SPACE_FILE_BODY_LIMIT.apply(post(create_file)),"),
            "POST /api/spaces/:id/files must declare a body limit; with none it \
             silently reverts to axum's 2 MiB default"
        );
        assert!(server.contains("uploads::UPLOADS_BODY_LIMIT.apply(post(uploads::upload_file)),"));
        assert!(
            server.contains("const MAX_FILE_BYTES: usize = uploads::MAX_UPLOAD_BYTES;"),
            "the Spaces file ceiling must be DEFINED as the upload ceiling, not \
             restated as a literal that can drift from it"
        );
        assert!(server.contains(r#".route("/api/uploads/limits", get(uploads::upload_limits))"#));
    }

    #[test]
    fn images_pass_through() {
        assert_eq!(safe_inline_mime("image/png"), "image/png");
        assert_eq!(
            safe_inline_mime("image/jpeg; charset=binary"),
            "image/jpeg; charset=binary"
        );
    }

    #[test]
    fn html_and_svg_are_neutralized() {
        assert_eq!(safe_inline_mime("text/html"), "application/octet-stream");
        assert_eq!(
            safe_inline_mime("image/svg+xml"),
            "application/octet-stream"
        );
    }
}
