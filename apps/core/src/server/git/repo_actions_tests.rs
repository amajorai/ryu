// These exercise ONLY the pre-git validation guards (missing/empty params,
// non-directory cwd, bad action). None of them reach `spawn_blocking`, so no
// real `git` process is shelled and no repository is required.

use super::super::tests::{body_json, query, NON_DIR};
use super::super::*;

#[tokio::test]
async fn git_status_missing_cwd_is_bad_request() {
    let (status, json) = body_json(git_status(query(&[])).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn git_status_empty_cwd_is_bad_request() {
    // An empty cwd is filtered out and treated as absent.
    let (status, _) = body_json(git_status(query(&[("cwd", "")])).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn git_status_non_dir_returns_not_repo() {
    let (status, json) = body_json(git_status(query(&[("cwd", NON_DIR)])).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["is_repo"], serde_json::json!(false));
}

#[tokio::test]
async fn git_branches_missing_cwd_is_bad_request() {
    let (status, _) = body_json(git_branches(query(&[])).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn git_branches_non_dir_returns_empty_repo_shape() {
    let (status, json) = body_json(git_branches(query(&[("cwd", NON_DIR)])).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["is_repo"], serde_json::json!(false));
    assert!(json["current"].is_null());
    assert_eq!(json["branches"], serde_json::json!([]));
}

#[tokio::test]
async fn git_checkout_rejects_empty_fields() {
    for (cwd, branch) in [("", "main"), ("/some/path", ""), ("", "")] {
        let body = GitCheckoutBody {
            cwd: cwd.to_string(),
            branch: branch.to_string(),
        };
        let (status, json) = body_json(git_checkout(JsonBody(body)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["success"], serde_json::json!(false));
    }
}

#[tokio::test]
async fn git_checkout_rejects_non_dir_cwd() {
    let body = GitCheckoutBody {
        cwd: NON_DIR.to_string(),
        branch: "main".to_string(),
    };
    let (status, json) = body_json(git_checkout(JsonBody(body)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));
}

#[tokio::test]
async fn git_create_branch_rejects_empty_and_non_dir() {
    let empty = GitCheckoutBody {
        cwd: String::new(),
        branch: "feature".to_string(),
    };
    let (status, _) = body_json(git_create_branch(JsonBody(empty)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let non_dir = GitCheckoutBody {
        cwd: NON_DIR.to_string(),
        branch: "feature".to_string(),
    };
    let (status, json) = body_json(git_create_branch(JsonBody(non_dir)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));
}

#[tokio::test]
async fn git_commit_push_rejects_empty_cwd() {
    let body = GitCommitPushBody {
        cwd: String::new(),
        message: None,
        action: None,
        include_unstaged: true,
    };
    let (status, _) = body_json(git_commit_push(JsonBody(body)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn git_commit_push_rejects_non_dir_cwd() {
    let body = GitCommitPushBody {
        cwd: NON_DIR.to_string(),
        message: None,
        action: None,
        include_unstaged: true,
    };
    let (status, json) = body_json(git_commit_push(JsonBody(body)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));
}

#[tokio::test]
async fn git_pull_and_sync_reject_empty_and_non_dir_cwd() {
    let empty = GitRemoteBody { cwd: String::new() };
    let (status, _) = body_json(git_pull(JsonBody(empty)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let non_dir = GitRemoteBody {
        cwd: NON_DIR.to_string(),
    };
    let (status, json) = body_json(git_pull(JsonBody(non_dir)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));

    let empty = GitRemoteBody { cwd: String::new() };
    let (status, _) = body_json(git_sync(JsonBody(empty)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let non_dir = GitRemoteBody {
        cwd: NON_DIR.to_string(),
    };
    let (status, json) = body_json(git_sync(JsonBody(non_dir)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));
}

#[tokio::test]
async fn git_commit_push_rejects_invalid_action() {
    // A real, existing directory (not a git repo) so the is_dir guard passes
    // and the action-allowlist check is what rejects. `git` is never shelled
    // because the action is validated before `spawn_blocking`.
    let base = std::env::temp_dir().join(format!("ryu_gitaction_{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let body = GitCommitPushBody {
        cwd: base.to_string_lossy().into_owned(),
        message: Some("hi".to_string()),
        action: Some("rm-rf".to_string()),
        include_unstaged: false,
    };
    let (status, json) = body_json(git_commit_push(JsonBody(body)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json["error"].as_str().unwrap(), "invalid git action");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn git_pull_request_rejects_empty_and_non_dir_cwd() {
    let empty = GitPullRequestBody {
        cwd: String::new(),
        title: None,
        body: None,
        base: None,
        draft: false,
        include_unstaged: true,
    };
    let (status, _) = body_json(git_pull_request(JsonBody(empty)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let non_dir = GitPullRequestBody {
        cwd: NON_DIR.to_string(),
        title: Some("Ship it".to_string()),
        body: None,
        base: Some("main".to_string()),
        draft: false,
        include_unstaged: true,
    };
    let (status, json) = body_json(git_pull_request(JsonBody(non_dir)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"].as_str().unwrap().contains("not a directory"));
}
