use super::super::tests::body_json;
use super::*;

#[test]
fn folder_name_accepts_plain_names() {
    assert!(validate_folder_name("My Project").is_ok());
    assert!(validate_folder_name("ryu-app_2").is_ok());
}

#[test]
fn folder_name_rejects_traversal_and_separators() {
    assert!(validate_folder_name("").is_err());
    assert!(validate_folder_name("..").is_err());
    assert!(validate_folder_name("a/b").is_err());
    assert!(validate_folder_name("a\\b").is_err());
    assert!(validate_folder_name("foo..bar").is_err());
    assert!(validate_folder_name("bad\nname").is_err());
}

#[test]
fn git_clone_url_accepts_github_gitlab_azure_and_custom_hosts() {
    let cases = [
        (
            "https://github.com/amajorai/ryu.git",
            "ryu",
            "github.com",
            443,
        ),
        (
            "https://gitlab.com/group/subgroup/web-app.git",
            "web-app",
            "gitlab.com",
            443,
        ),
        (
            "https://dev.azure.com/acme/platform/_git/agent-runtime",
            "agent-runtime",
            "dev.azure.com",
            443,
        ),
        (
            "ssh://git@ssh.dev.azure.com/v3/acme/platform/agent-runtime",
            "agent-runtime",
            "ssh.dev.azure.com",
            22,
        ),
        (
            "https://git.example.test:8443/team/repository.git",
            "repository",
            "git.example.test",
            8443,
        ),
        (
            "git@git.example.test:team/repository.git",
            "repository",
            "git.example.test",
            22,
        ),
        (
            "ssh://git@git.example.test:2222/team/repository.git",
            "repository",
            "git.example.test",
            2222,
        ),
    ];

    for (url, repository_name, host, port) in cases {
        let parsed = parse_git_clone_url(url).unwrap();
        assert_eq!(parsed.repository_name, repository_name, "{url}");
        assert_eq!(parsed.host, host, "{url}");
        assert_eq!(parsed.port, port, "{url}");
    }
}

#[test]
fn git_clone_pins_the_screened_addresses() {
    let source = parse_git_clone_url("https://git.example.test/team/repository.git").unwrap();
    let approved = [
        "93.184.216.34:443".parse().unwrap(),
        "[2606:2800:220:1::248]:443".parse().unwrap(),
    ];
    assert_eq!(
        git_clone_pinned_resolve(&source, &approved).as_deref(),
        Some("git.example.test:443:93.184.216.34,[2606:2800:220:1::248]")
    );
    let literal = parse_git_clone_url("https://93.184.216.34/team/repository.git").unwrap();
    assert_eq!(git_clone_pinned_resolve(&literal, &approved[..1]), None);
}

#[test]
fn git_clone_url_rejects_unsafe_or_unsupported_forms() {
    for url in [
        "",
        "owner/repository",
        "file:///tmp/repository",
        "http://git.example.test/team/repository",
        "https://token@git.example.test/team/repository",
        "https://git.example.test/team/repository?token=secret",
        "https://git.example.test/team/repository#fragment",
        "ssh://root@git.example.test/team/repository",
        "ssh://git:password@git.example.test/team/repository",
        "git@/team/repository",
        "git@git.example.test:team/../repository",
        "https://github.com/org/repository/tree/main",
    ] {
        assert!(
            parse_git_clone_url(url).is_err(),
            "accepted unsafe URL: {url}"
        );
    }
}

#[tokio::test]
async fn git_clone_host_screen_rejects_private_and_metadata_targets() {
    for host in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "metadata.google.internal",
    ] {
        assert!(
            crate::server::resolve_guarded_host(host, 443)
                .await
                .is_err(),
            "allowed blocked Git host {host}"
        );
    }
}

#[tokio::test]
async fn create_project_folder_rejects_unsafe_names() {
    // Validation fails before any filesystem write, so nothing is created.
    for bad in ["", "..", "a/b", "a\\b", "foo..bar"] {
        let body = NewFolderBody {
            name: bad.to_string(),
        };
        let (status, json) = body_json(create_project_folder(JsonBody(body)).await).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "name {bad:?} should be rejected"
        );
        assert!(json["error"].is_string());
    }
}
