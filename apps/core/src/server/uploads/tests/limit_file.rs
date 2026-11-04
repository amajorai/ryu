use super::*;

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
    let (status, _) = post_body(json_router(None), create_file_envelope(one_and_a_half_mib)).await;
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
    let server = crate::server::tests::source_text::server_source();
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
