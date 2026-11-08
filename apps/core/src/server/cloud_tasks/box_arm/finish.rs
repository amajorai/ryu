//! Reviewing and finishing a task: diff, commit, clean-room push.
//! test-exempt: moved unchanged from box_arm.rs; it needs a live Box, and its scripts and parsers are covered in box_arm/tests.rs.

use super::super::environments::GitPushCredential;
use super::git::{compare_url, parse_diff_output, parse_numstat, push_error_code, redact};
use super::pull_request::open_pull_request;
use super::*;

/// Review the uncommitted and committed changes since setup.
pub(in crate::server::cloud_tasks) async fn diff(
    workspace: &WorkspaceId,
    repo_dir: &str,
    base_sha: &str,
    redactions: &[String],
) -> Result<(Vec<DiffFile>, String, bool)> {
    let env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.to_owned()),
        ("RYU_BASE_SHA".to_owned(), base_sha.to_owned()),
    ];
    let output = session_box::box_client()
        .await?
        .exec_script(workspace, DIFF_SCRIPT, &env, BoxUser::Box, 120)
        .await?;
    ensure!(output.exit_code == 0, "The change review could not be read");
    let (files, patch, truncated) = parse_diff_output(&String::from_utf8_lossy(&output.stdout));
    Ok((files, redact(&patch, redactions), truncated))
}

/// Everything `finish` needs, copied out so the slot lock is not held across
/// the Box calls.
pub(in crate::server::cloud_tasks) struct FinishPlan {
    pub workspace: WorkspaceId,
    pub repo_dir: Option<String>,
    pub base_sha: Option<String>,
    pub base_branch: Option<String>,
    pub branch: Option<String>,
    pub commit_message: String,
    pub push: bool,
    pub token: Option<GitPushCredential>,
    pub repository: Option<String>,
    /// Open a pull request from `branch` into `base_branch` after the push.
    pub pull_request: Option<PullRequestPlan>,
}

/// Title, body and draft flag of a requested pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::server::cloud_tasks) struct PullRequestPlan {
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// The env of the clean-room push. Git authenticates with
/// `credential.push_secret`: for a network secret that is its placeholder,
/// which the Box egress proxy swaps for the token inside the Basic credential
/// on its way to github.com, so the token never enters the Box.
pub(super) fn push_env(
    push_dir: String,
    branch: &str,
    repository: &str,
    credential: &GitPushCredential,
) -> Vec<(String, String)> {
    vec![
        ("RYU_PUSH_DIR".to_owned(), push_dir),
        ("RYU_BRANCH".to_owned(), branch.to_owned()),
        (
            "RYU_REMOTE_URL".to_owned(),
            format!("https://github.com/{repository}.git"),
        ),
        ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
        (
            "GIT_CONFIG_KEY_0".to_owned(),
            "http.https://github.com/.extraheader".to_owned(),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_owned(),
            format!(
                "Authorization: Basic {}",
                super::super::environments::github_basic_credential(&credential.push_secret)
            ),
        ),
    ]
}

/// Interrupt, commit, and optionally clean-room push. The summary's teardown
/// is "kept"; the caller decides whether to destroy.
pub(in crate::server::cloud_tasks) async fn finish(plan: FinishPlan) -> Result<FinishSummary> {
    let client = session_box::box_client().await?;
    let _ = client.interrupt(&plan.workspace).await;
    let mut summary = FinishSummary {
        branch: plan.branch.clone(),
        head_sha: None,
        pushed: false,
        push_error: None,
        compare_url: None,
        pull_request: None,
        pull_request_error: None,
        teardown: "kept".into(),
        files: 0,
        insertions: 0,
        deletions: 0,
    };
    let (Some(repo_dir), Some(base_sha)) = (&plan.repo_dir, &plan.base_sha) else {
        return Ok(summary);
    };
    let commit_env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.clone()),
        ("RYU_BASE_SHA".to_owned(), base_sha.clone()),
        ("RYU_COMMIT_MESSAGE".to_owned(), plan.commit_message.clone()),
    ];
    let committed = client
        .exec_script(
            &plan.workspace,
            COMMIT_SCRIPT,
            &commit_env,
            BoxUser::Box,
            300,
        )
        .await?;
    ensure!(
        committed.exit_code == 0,
        "The changes could not be committed"
    );
    let stdout = String::from_utf8_lossy(&committed.stdout);
    let (head, numstat) = stdout.split_once('\n').unwrap_or((&stdout, ""));
    summary.head_sha = Some(head.trim().to_owned()).filter(|sha| !sha.is_empty());
    let files = parse_numstat(numstat);
    summary.files = files.len() as u64;
    summary.insertions = files.iter().filter_map(|file| file.insertions).sum();
    summary.deletions = files.iter().filter_map(|file| file.deletions).sum();
    if !plan.push {
        return Ok(summary);
    }
    let (Some(branch), Some(token), Some(repository)) =
        (&plan.branch, &plan.token, &plan.repository)
    else {
        bail!("Push requires a branch, a repository and a GitHub credential");
    };
    let push_dir = format!("/root/ryu-push-{}", uuid::Uuid::new_v4().simple());
    let fetch_env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.clone()),
        ("RYU_BRANCH".to_owned(), branch.clone()),
        ("RYU_PUSH_DIR".to_owned(), push_dir.clone()),
    ];
    let fetched = client
        .exec_script(
            &plan.workspace,
            FETCH_SCRIPT,
            &fetch_env,
            BoxUser::Root,
            300,
        )
        .await;
    if !matches!(&fetched, Ok(output) if output.exit_code == 0) {
        summary.push_error = Some("unknown".into());
        return Ok(summary);
    }
    let push_env = push_env(push_dir, branch, repository, token);
    match client
        .exec_script(&plan.workspace, PUSH_SCRIPT, &push_env, BoxUser::Root, 300)
        .await
    {
        Ok(output) if output.exit_code == 0 => {
            summary.pushed = true;
            summary.compare_url =
                Some(compare_url(repository, plan.base_branch.as_deref(), branch));
        }
        Ok(output) => {
            summary.push_error =
                Some(push_error_code(&String::from_utf8_lossy(&output.stderr)).to_owned());
        }
        Err(_) => summary.push_error = Some("network".into()),
    }
    if let (true, Some(pull_request), Some(base)) = (
        summary.pushed,
        &plan.pull_request,
        plan.base_branch.as_deref(),
    ) {
        match open_pull_request(&token.api_token, repository, branch, base, pull_request).await {
            Ok(opened) => summary.pull_request = Some(opened),
            Err(code) => summary.pull_request_error = Some(code.to_owned()),
        }
    }
    Ok(summary)
}
