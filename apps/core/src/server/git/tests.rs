use super::*;

pub(super) async fn body_json(resp: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

pub(super) fn query(pairs: &[(&str, &str)]) -> Query<HashMap<String, String>> {
    let map = pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    Query(map)
}

/// A path guaranteed not to be a directory on any platform.
pub(super) const NON_DIR: &str = "/no/such/ryu/dir/xyz-does-not-exist";

#[tokio::test]
async fn turn_file_endpoints_bound_requests_before_git() {
    let diff = GitFileDiffBody {
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        paths: Vec::new(),
    };
    let (status, json) = body_json(git_file_diff(JsonBody(diff)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("between 1 and 64"));

    let reverse = GitReverseEditsBody {
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        plan: ReverseEditPlanBody::TextReplacements { edits: Vec::new() },
    };
    let (status, json) = body_json(git_reverse_edits(JsonBody(reverse)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"]
        .as_str()
        .unwrap()
        .contains("between 1 and 256"));
}

// ── Extractor rejections stay JSON ────────────────────────────────────────
//
// The reported bug was a plain-text axum rejection being fed to the desktop's
// `JSON.parse`. These drive `JsonBody` directly (no router needed) and assert
// that the two rejection shapes a client can trigger — wrong content type and
// an undeserializable body — still come back as `{success:false,error:"…"}`.

async fn reject_body(content_type: &str, body: &'static str) -> (StatusCode, serde_json::Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/api/git/commit-push")
        .header("content-type", content_type)
        .body(axum::body::Body::from(body))
        .unwrap();
    let resp = JsonBody::<GitCommitPushBody>::from_request(req, &())
        .await
        .err()
        .expect("request should be rejected");
    body_json(resp).await
}

#[tokio::test]
async fn json_body_rejects_wrong_content_type_with_json() {
    // The exact trigger: `fetch` combined two Content-Type record entries into
    // `application/json, application/json`, which axum's mime parse refuses.
    let (status, json) =
        reject_body("application/json, application/json", r#"{"cwd":"/tmp"}"#).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(json["success"], serde_json::json!(false));
    assert!(
        json["error"].as_str().unwrap().contains("Content-Type"),
        "rejection reason must survive into the JSON body: {json}"
    );
}

#[tokio::test]
async fn json_body_rejects_malformed_body_with_json() {
    // A body missing the required `cwd` never reaches the handler's own
    // "cwd is required" branch — the deserializer rejects it first.
    let (status, json) = reject_body("application/json", r#"{"message":"hi"}"#).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json["success"], serde_json::json!(false));
    assert!(json["error"].as_str().unwrap().contains("cwd"));
}
