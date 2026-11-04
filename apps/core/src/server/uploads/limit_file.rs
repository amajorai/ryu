//! Upload and body-limit policy: `MAX_UPLOAD_BYTES` through `upload_limits`.
// test-exempt: moved verbatim out of uploads.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::server::uploads::*;

/// **The one ceiling on file content this node enforces, on every route that
/// accepts a file.** 32 MiB.
///
/// Cap mirrors the legacy media upload limit (editor pastes / chat images), and
/// three other things are defined in terms of it rather than repeating it:
/// [`crate::document_parse::MAX_PARSE_BYTES`] ("a file you can attach is a file the
/// parser will look at"), the desktop's `NODE_UPLOAD_MAX_BYTES` mirror, and — since
/// the alignment described on [`SPACE_FILE_BODY_LIMIT`] — `MAX_FILE_BYTES`, the cap
/// `POST /api/spaces/:id/files` checks its decoded body against.
pub const MAX_UPLOAD_BYTES: usize = crate::server::media::MAX_MEDIA_BYTES;

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
    pub(in crate::server::uploads) const fn wire_name(self) -> &'static str {
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

    pub(in crate::server::uploads) fn to_json(self) -> serde_json::Value {
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
