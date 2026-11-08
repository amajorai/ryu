//! Pull request tests against a fake GitHub API.

use super::*;

/// One-shot local HTTP fake: answers a single request with `status` and
/// `body`, and returns the raw request it received.
async fn github_fake(
    status: &'static str,
    body: &'static str,
) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text[..split]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request.len() >= split + 4 + length {
                    break;
                }
            }
        }
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
        String::from_utf8_lossy(&request).to_string()
    });
    (base, handle)
}

fn local_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

fn pr_plan(draft: bool) -> PullRequestPlan {
    PullRequestPlan {
        title: "Fix the parser".into(),
        body: "Body text".into(),
        draft,
    }
}

#[tokio::test]
async fn cloud_box_pull_request_posts_to_github_and_builds_the_url() {
    let (base, handle) = github_fake(
        "201 Created",
        r#"{"number":42,"html_url":"https://evil.example/pull/42"}"#,
    )
    .await;
    let opened = create_pull_request_at(
        &local_client(),
        &base,
        "ghp_secretvalue123",
        "acme/app",
        "ryu/abcdefgh",
        "main",
        &pr_plan(true),
    )
    .await
    .unwrap();
    assert_eq!(
        opened,
        PullRequestRef {
            url: "https://github.com/acme/app/pull/42".into(),
            number: 42,
        }
    );
    let request = handle.await.unwrap();
    assert!(request.starts_with("POST /repos/acme/app/pulls HTTP/1.1\r\n"));
    let lower = request.to_ascii_lowercase();
    assert!(lower.contains("authorization: bearer ghp_secretvalue123"));
    assert!(lower.contains("x-github-api-version: 2022-11-28"));
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        body,
        json!({"title":"Fix the parser","head":"ryu/abcdefgh","base":"main","body":"Body text","draft":true})
    );
}

#[tokio::test]
async fn cloud_box_pull_request_errors_map_to_stable_codes() {
    let cases = [
        (
            "422 Unprocessable Entity",
            r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for acme:ryu/abcdefgh."}]}"#,
            "already_exists",
        ),
        (
            "422 Unprocessable Entity",
            r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","field":"base","code":"invalid"}]}"#,
            "validation",
        ),
        (
            "401 Unauthorized",
            r#"{"message":"Bad credentials"}"#,
            "auth",
        ),
        (
            "403 Forbidden",
            r#"{"message":"Resource not accessible"}"#,
            "auth",
        ),
        ("404 Not Found", r#"{"message":"Not Found"}"#, "auth"),
        ("502 Bad Gateway", "upstream ghp_secretvalue123", "unknown"),
        (
            "201 Created",
            r#"{"html_url":"https://github.com/x"}"#,
            "unknown",
        ),
    ];
    for (status, body, expected) in cases {
        let (base, handle) = github_fake(status, body).await;
        let error = create_pull_request_at(
            &local_client(),
            &base,
            "ghp_secretvalue123",
            "acme/app",
            "ryu/abcdefgh",
            "main",
            &pr_plan(false),
        )
        .await
        .unwrap_err();
        assert_eq!(error, expected, "{status} {body}");
        handle.await.unwrap();
    }
}

#[tokio::test]
async fn cloud_box_pull_request_unreachable_api_is_a_network_error() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let error = create_pull_request_at(
        &local_client(),
        &base,
        "ghp_secretvalue123",
        "acme/app",
        "ryu/abcdefgh",
        "main",
        &pr_plan(false),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "network");
}

#[test]
fn cloud_box_pull_request_title_and_message() {
    assert_eq!(
        default_pull_request_title("\n  Fix parser  \n\nDetails"),
        "Fix parser"
    );
    assert_eq!(default_pull_request_title(&"x".repeat(300)).len(), 256);
    assert_eq!(
        default_pull_request_title("  "),
        "Changes from a Ryu cloud task"
    );
    let mut summary = FinishSummary {
        branch: Some("ryu/abc".into()),
        head_sha: Some("a".repeat(40)),
        pushed: true,
        push_error: None,
        compare_url: Some(compare_url("acme/app", Some("main"), "ryu/abc")),
        pull_request: Some(PullRequestRef {
            url: "https://github.com/acme/app/pull/7".into(),
            number: 7,
        }),
        pull_request_error: None,
        teardown: "kept".into(),
        files: 1,
        insertions: 2,
        deletions: 0,
    };
    let message = finish_event(&summary).text();
    assert!(message.contains("Opened pull request #7: https://github.com/acme/app/pull/7"));
    assert!(!message.contains("compare"));
    summary.pull_request = None;
    summary.pull_request_error = Some("already_exists".into());
    let message = finish_event(&summary).text();
    assert!(message.contains("Opening a pull request failed (already_exists)"));
    assert!(message.contains("/compare/main...ryu/abc"));
    let serialized = serde_json::to_value(&summary).unwrap();
    assert_eq!(serialized["pullRequest"], Value::Null);
    assert_eq!(serialized["pullRequestError"], "already_exists");
}
