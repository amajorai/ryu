#[test]
fn networked_box_actions_refuse_while_desktop_routing_is_on() {
    assert!(desktop_routing_refusal(false, false).is_none());
    assert!(desktop_routing_refusal(false, true).is_none());
    assert!(desktop_routing_refusal(true, false).is_none());
    let (status, _) = desktop_routing_refusal(true, true).expect("refused");
    assert_eq!(status, StatusCode::CONFLICT);
}

use super::git::{parse_base_revision, prompt_text, relative_cwd};
use super::run_event;
use super::runs::{chatgpt_plan_refusal, managed_env};
use super::*;

#[test]
fn codex_on_a_chatgpt_plan_in_a_box_waits_for_the_hosted_flag() {
    let none: Vec<(String, String)> = Vec::new();
    let keyed = vec![("OPENAI_API_KEY".to_owned(), "sk-test".to_owned())];
    let empty_key = vec![("OPENAI_API_KEY".to_owned(), String::new())];
    assert!(chatgpt_plan_refusal("codex", &none, false).is_some());
    assert!(chatgpt_plan_refusal("codex", &empty_key, false).is_some());
    assert!(chatgpt_plan_refusal("codex", &keyed, false).is_none());
    assert!(chatgpt_plan_refusal("codex", &none, true).is_none());
    // Claude Code with the user's own in-Box sign-in is allowed.
    assert!(chatgpt_plan_refusal("claude-code", &none, false).is_none());
}

#[test]
fn cloud_box_branch_validation_rejects_unsafe_names() {
    for branch in [
        "-x", "a..b", "x.lock", "a//b", "a@{b", "a/", ".hidden", "", "a b",
    ] {
        assert!(validate_branch(branch, None).is_err(), "{branch}");
    }
    assert!(validate_branch("main", Some("main")).is_err());
    assert_eq!(
        validate_branch("ryu/abc123", Some("main")).unwrap(),
        "ryu/abc123"
    );
    assert!(validate_branch(&"a".repeat(101), None).is_err());
    assert!(validate_branch(&"a".repeat(100), None).is_ok());
}

#[test]
fn cloud_box_default_branch_is_valid_for_any_conversation_id() {
    assert_eq!(default_branch("0123456789abcdef"), "ryu/01234567");
    let branch = default_branch("ab_cd_ef_gh");
    assert_eq!(branch, "ryu/ab-cd-ef");
    assert!(validate_branch(&branch, Some("main")).is_ok());
}

#[test]
fn cloud_box_numstat_parses_text_and_binary_files() {
    let files = parse_numstat("3\t1\tsrc/main.rs\n-\t-\tassets/logo.png\nnot a numstat line\n");
    assert_eq!(
        files,
        vec![
            DiffFile {
                path: "src/main.rs".into(),
                insertions: Some(3),
                deletions: Some(1)
            },
            DiffFile {
                path: "assets/logo.png".into(),
                insertions: None,
                deletions: None
            },
        ]
    );
}

#[test]
fn cloud_box_diff_output_splits_and_truncates_the_patch() {
    let (files, patch, truncated) =
        parse_diff_output("1\t0\ta.txt\n\n--RYU-PATCH--\ndiff --git a/a.txt b/a.txt\n");
    assert_eq!(files.len(), 1);
    assert_eq!(patch, "diff --git a/a.txt b/a.txt\n");
    assert!(!truncated);

    let (files, patch, truncated) = parse_diff_output("\n--RYU-PATCH--\n");
    assert!(files.is_empty());
    assert!(patch.is_empty());
    assert!(!truncated);

    let big = format!(
        "1\t1\tbig.txt\n{PATCH_MARKER}{}",
        "é".repeat(MAX_PATCH_BYTES)
    );
    let (_, patch, truncated) = parse_diff_output(&big);
    assert!(truncated);
    assert!(patch.len() <= MAX_PATCH_BYTES);
}

#[test]
fn cloud_box_push_errors_map_to_stable_codes() {
    assert_eq!(
        push_error_code("! [rejected] x -> x (non-fast-forward)"),
        "non_fast_forward"
    );
    assert_eq!(
        push_error_code("remote: Permission denied. The requested URL returned error: 403"),
        "auth"
    );
    assert_eq!(
        push_error_code("fatal: could not read Username for 'https://github.com'"),
        "auth"
    );
    assert_eq!(
        push_error_code("fatal: unable to access: Could not resolve host: github.com"),
        "network"
    );
    assert_eq!(push_error_code("Operation timed out"), "network");
    assert_eq!(push_error_code("something else"), "unknown");
}

#[test]
fn cloud_box_compare_url_links_base_and_branch() {
    assert_eq!(
        compare_url("acme/app", Some("main"), "ryu/abc"),
        "https://github.com/acme/app/compare/main...ryu/abc?expand=1"
    );
    assert_eq!(
        compare_url("acme/app", None, "ryu/abc"),
        "https://github.com/acme/app/compare/ryu/abc?expand=1"
    );
}

#[test]
fn cloud_box_redaction_removes_raw_and_basic_tokens() {
    let token = "ghp_secretvalue123";
    let basic = crate::server::cloud_environments::github_basic_credential(token);
    let secrets = vec![token.to_owned(), basic.clone(), String::new()];
    let text = format!("token={token} header=Authorization: Basic {basic}");
    let redacted = redact(&text, &secrets);
    assert!(!redacted.contains(token));
    assert!(!redacted.contains(&basic));
    assert_eq!(redacted.matches("[redacted]").count(), 2);
}

#[test]
fn cloud_box_push_env_carries_only_the_push_secret() {
    use crate::server::cloud_environments::{github_basic_credential, GitPushCredential};
    let placeholder = "__RYU_SECRET_0123456789abcdef__";
    let credential = GitPushCredential::network_secret("ghp_real_token".into(), placeholder.into());
    let env = super::finish::push_env("/root/ryu-push-x".into(), "ryu/b", "acme/app", &credential);
    let header = env
        .iter()
        .find(|(key, _)| key == "GIT_CONFIG_VALUE_0")
        .map(|(_, value)| value.clone())
        .expect("the extraheader is set");
    assert_eq!(
        header,
        format!(
            "Authorization: Basic {}",
            github_basic_credential(placeholder)
        )
    );
    let joined = format!("{env:?}");
    assert!(!joined.contains("ghp_real_token"));
    assert!(!joined.contains(&github_basic_credential("ghp_real_token")));
    assert!(env.contains(&(
        "RYU_REMOTE_URL".to_owned(),
        "https://github.com/acme/app.git".to_owned()
    )));
}

#[test]
fn cloud_box_tail_keeps_the_last_characters() {
    assert_eq!(tail("abcdef".into(), 3), "def");
    assert_eq!(tail("ab".into(), 3), "ab");
    assert_eq!(tail("ééé".into(), 2), "éé");
}

#[test]
fn cloud_box_prompt_inputs_strip_git_credentials_and_root() {
    assert_eq!(relative_cwd("/workspace/acme/app"), "acme/app");
    assert_eq!(relative_cwd("/workspace"), ".");
    let env = vec![
        ("GITHUB_TOKEN".to_owned(), "t".to_owned()),
        ("API_KEY".to_owned(), "k".to_owned()),
    ];
    assert_eq!(
        managed_env(&env, &["GITHUB_TOKEN".to_owned()]),
        vec![("API_KEY".to_owned(), "k".to_owned())]
    );
    assert_eq!(prompt_text("", "fix it"), "fix it");
    assert_eq!(
        prompt_text("Be careful.", "fix it"),
        "Be careful.\n\nfix it"
    );
    assert_eq!(prompt_text("", &"x".repeat(40_000)).chars().count(), 32_000);
}

#[test]
fn cloud_box_run_message_reports_exit_code_or_reason() {
    assert_eq!(
        run_event(None, Some(0), None).text(),
        "The agent finished without output."
    );
    assert_eq!(
        run_event(Some("Done"), Some(2), None).text(),
        "Done\n\nExit code 2."
    );
    assert_eq!(
        run_event(Some("Partial"), None, Some("timeout")).text(),
        "Partial\n\nThe run ended early (timeout)."
    );
}

#[test]
fn cloud_box_base_revision_parses_sha_and_branch() {
    let sha = "a".repeat(40);
    assert_eq!(
        parse_base_revision(&format!("{sha}\nmain\n")).unwrap(),
        (sha.clone(), Some("main".to_owned()))
    );
    assert_eq!(
        parse_base_revision(&format!("{sha}\nHEAD\n")).unwrap(),
        (sha, None)
    );
    assert!(parse_base_revision("not-a-sha\n").is_err());
}

#[test]
fn cloud_box_scripts_take_data_only_from_env() {
    for script in [DIFF_SCRIPT, COMMIT_SCRIPT, FETCH_SCRIPT, PUSH_SCRIPT] {
        assert!(!script.contains("--force"));
        assert!(!script.contains("-f "));
    }
    assert!(PUSH_SCRIPT.contains("\"$RYU_REMOTE_URL\""));
    assert!(!FETCH_SCRIPT.contains("GIT_CONFIG_VALUE"));
}

/// Runs FETCH_SCRIPT and PUSH_SCRIPT with real git. When the test runs as
/// root (as Box does), the source repo is owned by another user so the
/// dubious-ownership check is exercised.
#[test]
fn cloud_box_clean_room_scripts_push_with_real_git() {
    use std::process::Command;
    let git_ok = Command::new("git").arg("--version").output().is_ok();
    if !git_ok {
        return;
    }
    // A git hook (the pre-commit gate runs this test) exports GIT_INDEX_FILE
    // and friends; inherited, they would point these commands at the outer
    // repository's index instead of the temp repositories.
    let isolated = |mut command: Command| {
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command
    };
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let remote = root.path().join("remote.git");
    let push_dir = root.path().join("push");
    let run = |args: &[&str], cwd: &std::path::Path| {
        let out = isolated(Command::new("git"))
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {out:?}");
    };
    std::fs::create_dir_all(&repo).unwrap();
    run(&["init", "-q"], &repo);
    std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
    run(&["add", "-A"], &repo);
    run(
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "init",
        ],
        &repo,
    );
    run(
        &["init", "-q", "--bare", remote.to_str().unwrap()],
        root.path(),
    );
    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "0");
    if is_root {
        let status = Command::new("chown")
            .args(["-R", "65534:65534"])
            .arg(&repo)
            .status()
            .unwrap();
        assert!(status.success());
    }
    let script = |body: &str, extra: &[(&str, &str)]| {
        let mut command = isolated(Command::new("sh"));
        command
            .args(["-c", body])
            .env("RYU_REPO_DIR", &repo)
            .env("RYU_PUSH_DIR", &push_dir)
            .env("RYU_BRANCH", "ryu/test");
        for (key, value) in extra {
            command.env(key, value);
        }
        command.output().unwrap()
    };
    let fetched = script(FETCH_SCRIPT, &[]);
    assert!(fetched.status.success(), "fetch: {fetched:?}");
    let remote_url = format!("file://{}", remote.display());
    let pushed = script(PUSH_SCRIPT, &[("RYU_REMOTE_URL", &remote_url)]);
    assert!(pushed.status.success(), "push: {pushed:?}");
    assert!(!push_dir.exists());
    let refs = isolated(Command::new("git"))
        .args(["-C", remote.to_str().unwrap(), "show-ref"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&refs.stdout).contains("refs/heads/ryu/test"));
}

#[path = "pull_request_tests.rs"]
mod pull_request_tests;

#[test]
fn cloud_box_network_secret_refusal_is_said_plainly_without_values() {
    use ryu_sandbox::box_session::BoxNetworkSecret;
    use ryu_sandbox::box_types::SecretString;
    let refusal = || BoxApiError::Http {
        status: 422,
        code: "not_supported".into(),
        message: "The vm driver cannot substitute network secrets.".into(),
    };
    let plan = BoxNetworkPlan {
        network: BoxNetwork::Egress,
        secrets: vec![BoxNetworkSecret {
            placeholder: "__RYU_SECRET_0123456789abcdef0123__".into(),
            hosts: vec!["api.openai.com".into()],
            value: SecretString::new("sk-live-7"),
        }],
    };
    let message = network_secrets_refusal(refusal(), &plan).to_string();
    assert!(
        message.contains("cannot substitute network secrets"),
        "{message}"
    );
    assert!(!message.contains("sk-live-7"));
    // Without network secrets, the Box's own error passes through.
    let plain = network_secrets_refusal(refusal(), &BoxNetworkPlan::plain(BoxNetwork::Egress));
    assert!(plain.to_string().contains("vm driver"), "{plain}");
}
