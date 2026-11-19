//! `/v1/sys/tools/{random,hash}`: Vault wire shapes, known digests, limits,
//! refusals, and the token and sealed checks.

use base64::Engine as _;

use super::fixture_test::*;
use super::tools::{digest, random_path, MAX_RANDOM_BYTES};

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap()
}

#[test]
fn random_paths_name_a_source_a_count_or_both() {
    let parse = |rest: &str| random_path(rest).ok();
    assert_eq!(parse(""), Some((None, None)));
    assert_eq!(parse("64"), Some((None, Some(64))));
    assert_eq!(parse("seal"), Some((Some("seal".to_owned()), None)));
    assert_eq!(parse("all/16"), Some((Some("all".to_owned()), Some(16))));
    assert_eq!(parse("all/sixteen"), None);
    assert_eq!(parse("all/16/extra"), None);
}

#[test]
fn digests_match_the_sha2_test_vectors() {
    let hex_of = |algorithm: &str| hex::encode(digest(algorithm, b"abc").ok().unwrap());
    assert_eq!(
        hex_of("sha2-256"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        hex_of("sha2-224"),
        "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
    );
    assert_eq!(
        hex_of("sha2-512/256"),
        "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"
    );
    assert_eq!(hex_of("sha2-384").len(), 96);
    assert_eq!(hex_of("sha2-512").len(), 128);
    assert_eq!(hex_of("sha2-512/224").len(), 56);
    assert!(digest("sha3-256", b"abc").is_err());
    assert!(digest("md5", b"abc").is_err());
}

#[tokio::test]
async fn random_returns_the_requested_bytes_in_the_requested_format() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;

    let (status, body) = call(app, "POST", "/v1/sys/tools/random", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let first = unb64(body["data"]["random_bytes"].as_str().unwrap());
    assert_eq!(first.len(), 32);
    let (_, body) = call(app, "POST", "/v1/sys/tools/random", Some(&token), None).await;
    assert_ne!(unb64(body["data"]["random_bytes"].as_str().unwrap()), first);

    let (status, body) = call(
        app,
        "POST",
        "/v1/sys/tools/random",
        Some(&token),
        Some(json!({ "bytes": 16, "format": "hex" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hex_text = body["data"]["random_bytes"].as_str().unwrap();
    assert_eq!(hex::decode(hex_text).unwrap().len(), 16);

    // The path wins over the body, as in Vault.
    let (status, body) = call(
        app,
        "POST",
        "/v1/sys/tools/random/all/8",
        Some(&token),
        Some(json!({ "bytes": 64 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        unb64(body["data"]["random_bytes"].as_str().unwrap()).len(),
        8
    );

    for (uri, request) in [
        ("/v1/sys/tools/random", json!({ "bytes": 0 })),
        (
            "/v1/sys/tools/random",
            json!({ "bytes": MAX_RANDOM_BYTES + 1 }),
        ),
        ("/v1/sys/tools/random", json!({ "bytes": "lots" })),
        ("/v1/sys/tools/random", json!({ "format": "base32" })),
        ("/v1/sys/tools/random/tpm", json!({})),
    ] {
        let (status, body) = call(app, "POST", uri, Some(&token), Some(request.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {request}: {body}");
        assert!(body["errors"][0].is_string(), "{body}");
    }
}

#[tokio::test]
async fn hash_returns_vault_sums_for_each_algorithm_and_format() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;
    let input = b64(b"abc");
    let sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    let (status, body) = call(
        app,
        "POST",
        "/v1/sys/tools/hash",
        Some(&token),
        Some(json!({ "input": input })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"], json!({ "sum": sha256 }));

    let (status, body) = call(
        app,
        "POST",
        "/v1/sys/tools/hash/sha2-256",
        Some(&token),
        Some(json!({ "input": input, "format": "base64" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        unb64(body["data"]["sum"].as_str().unwrap()),
        hex::decode(sha256).unwrap()
    );

    // An algorithm with a slash in its name still routes.
    let (status, body) = call(
        app,
        "POST",
        "/v1/sys/tools/hash/sha2-512/256",
        Some(&token),
        Some(json!({ "input": input })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["sum"],
        "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"
    );

    for request in [
        json!({}),
        json!({ "input": "not base64!" }),
        json!({ "input": input, "algorithm": "sha3-256" }),
        json!({ "input": input, "format": "binary" }),
        json!({ "input": 42 }),
    ] {
        let (status, body) = call(
            app,
            "POST",
            "/v1/sys/tools/hash",
            Some(&token),
            Some(request.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{request}: {body}");
    }
}

#[tokio::test]
async fn tools_need_a_valid_token_and_an_unsealed_vault() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let input = json!({ "input": b64(b"abc") });
    for (uri, token) in [
        ("/v1/sys/tools/random", None),
        ("/v1/sys/tools/random", Some("rvt_not_a_token")),
        ("/v1/sys/tools/hash", None),
        ("/v1/sys/tools/hash/sha2-256", Some("rvt_not_a_token")),
    ] {
        let (status, body) = call(app, "POST", uri, token, Some(input.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
    }

    let token = login(&fixture).await;
    seal(&fixture);
    let (status, body) = call(app, "POST", "/v1/sys/tools/random", Some(&token), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body, json!({ "errors": ["Vault is sealed"] }));
    unseal(&fixture).await;
}
