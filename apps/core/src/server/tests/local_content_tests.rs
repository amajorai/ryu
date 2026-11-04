use crate::server::*;

async fn call(
    seal: bool,
    local: bool,
    purpose: &str,
    value: String,
) -> (StatusCode, serde_json::Value) {
    let request = Json(LocalContentRequest {
        purpose: purpose.to_owned(),
        value,
    });
    let response = if seal {
        REQUEST_PEER_IS_LOCAL
            .scope(local, local_content_seal(axum::Extension(None), request))
            .await
    } else {
        REQUEST_PEER_IS_LOCAL
            .scope(local, local_content_open(axum::Extension(None), request))
            .await
    };
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

#[tokio::test]
async fn local_content_seals_and_opens_for_the_local_owner_only() {
    let history = r#"["first prompt","second prompt with sk-marker"]"#.to_owned();
    let (status, sealed) = call(true, true, "cli.prompt-history", history.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let sealed = sealed["sealed"].as_str().unwrap().to_owned();
    assert!(sealed.starts_with("encb:v1:"));
    assert!(!sealed.contains("prompt"));
    let (status, opened) = call(false, true, "cli.prompt-history", sealed.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(opened["value"], history);

    // Not from this machine, an unknown purpose, plaintext, or too large.
    assert_eq!(
        call(true, false, "cli.prompt-history", "x".to_owned())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(false, false, "cli.prompt-history", sealed.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(true, true, "other.purpose", "x".to_owned()).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(false, true, "cli.prompt-history", history).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            true,
            true,
            "cli.prompt-history",
            "x".repeat(LOCAL_CONTENT_MAX_BYTES + 1)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
