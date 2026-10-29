//! Pull, sync, and `gh` pull-request creation.

use super::*;

/// Pull the current branch from its upstream, or pull and then push for sync.
///
/// Pull is deliberately fast-forward-only: the Environment summary must not
/// create an implicit merge commit or leave a conflict in the user's folder.
/// Sync uses the same pull first, then pushes the current branch to its
/// configured upstream. Neither action stages or commits working-tree files.
pub fn run_git_remote_action(cwd: &str, action: &str) -> Result<GitRemoteOutcome, String> {
    if !matches!(action, "pull" | "sync") {
        return Err("invalid git remote action".to_string());
    }
    // Confirm this is a git repo before running a mutating remote command.
    if current_branch(cwd).is_none() {
        return Err("not a git repository".to_string());
    }
    reject_local_executable_filters(cwd)?;

    let pull = run_remote_git_command(
        cwd,
        &["pull", "--ff-only", "--no-stat", "--no-recurse-submodules"],
    )
    .map_err(|error| format!("git pull {error}"))?;
    if !pull.status.success() {
        return Err(remote_git_failed("pull", &pull));
    }

    let pushed = action == "sync";
    if pushed {
        let push = run_remote_git_command(cwd, &["push", "--no-verify"])
            .map_err(|error| format!("git push {error}"))?;
        if !push.status.success() {
            return Err(remote_git_failed("push", &push));
        }
    }

    Ok(GitRemoteOutcome {
        success: true,
        pulled: true,
        pushed,
        commit: run_git(cwd, &["rev-parse", "--short", "HEAD"]),
    })
}

pub(super) const PULL_REQUEST_FIELDS: &str =
    "baseRefName,commentsCount,headRefName,headRefOid,isDraft,number,repository,state,title,url";

#[derive(serde::Deserialize)]
pub(super) struct GhRepository {
    #[serde(rename = "nameWithOwner")]
    pub(super) name_with_owner: Option<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct GhPullRequest {
    #[serde(rename = "baseRefName")]
    pub(super) base_ref_name: Option<String>,
    #[serde(rename = "commentsCount")]
    pub(super) comments_count: Option<u64>,
    #[serde(rename = "headRefName")]
    pub(super) head_ref_name: Option<String>,
    #[serde(rename = "headRefOid")]
    pub(super) head_ref_oid: Option<String>,
    #[serde(rename = "isDraft")]
    pub(super) is_draft: bool,
    pub(super) number: u64,
    pub(super) repository: Option<GhRepository>,
    pub(super) state: Option<String>,
    pub(super) title: String,
    pub(super) url: String,
}

pub(super) static ACTIVE_PR_CREATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub(super) struct PullRequestCreationGuard {
    pub(super) key: String,
}

impl Drop for PullRequestCreationGuard {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE_PR_CREATIONS.get() {
            if let Ok(mut keys) = active.lock() {
                keys.remove(&self.key);
            }
        }
    }
}

pub(super) fn begin_pull_request_creation(
    cwd: &str,
    branch: &str,
) -> Result<PullRequestCreationGuard, String> {
    let key = format!("{cwd}\0{branch}");
    let active = ACTIVE_PR_CREATIONS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut keys = active
        .lock()
        .map_err(|_| "pull request operation lock is unavailable".to_string())?;
    if !keys.insert(key.clone()) {
        return Err("a pull request operation is already in progress for this branch".to_string());
    }
    Ok(PullRequestCreationGuard { key })
}

pub(super) fn list_open_pull_requests(
    cwd: &str,
    branch: &str,
) -> Result<Vec<GhPullRequest>, String> {
    let args = [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        PULL_REQUEST_FIELDS,
    ];
    let gh = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if !gh.status.success() {
        return Err(String::from_utf8_lossy(&gh.stderr).trim().to_string());
    }
    serde_json::from_slice(&gh.stdout).map_err(|e| format!("invalid gh pull request response: {e}"))
}

pub(super) fn existing_open_pull_request(
    cwd: &str,
    branch: &str,
) -> Result<Option<GhPullRequest>, String> {
    let mut pulls = list_open_pull_requests(cwd, branch)?;
    if pulls.len() > 1 {
        return Err(format!(
            "more than one open pull request exists for branch {branch}"
        ));
    }
    Ok(pulls.pop())
}

pub(super) fn pull_request_outcome(
    pull: &GhPullRequest,
    branch: &str,
    fallback_base: Option<&str>,
    already_exists: bool,
) -> PullRequestOutcome {
    PullRequestOutcome {
        already_exists,
        base: pull
            .base_ref_name
            .clone()
            .or_else(|| fallback_base.map(str::to_owned)),
        branch: pull
            .head_ref_name
            .clone()
            .unwrap_or_else(|| branch.to_string()),
        comments_count: pull.comments_count,
        head_sha: pull.head_ref_oid.clone(),
        is_draft: pull.is_draft,
        number: Some(pull.number),
        pr_url: pull.url.clone(),
        repository: pull
            .repository
            .as_ref()
            .and_then(|repo| repo.name_with_owner.clone()),
        state: pull.state.clone(),
        success: true,
        title: Some(pull.title.clone()),
    }
}

/// Shaped `POST /api/git/pull-request` result. The URL is returned by `gh` so
/// the desktop can offer both a completion link and an explicit browser action.
#[derive(serde::Serialize)]
pub struct PullRequestOutcome {
    pub already_exists: bool,
    pub base: Option<String>,
    pub branch: String,
    pub comments_count: Option<u64>,
    pub head_sha: Option<String>,
    pub is_draft: bool,
    pub number: Option<u64>,
    pub pr_url: String,
    pub repository: Option<String>,
    pub state: Option<String>,
    pub success: bool,
    pub title: Option<String>,
}

/// Optionally commit local changes, push the current branch, and create a pull
/// request through the authenticated GitHub CLI. Arguments are passed directly
/// to `git`/`gh` — no shell interpolation is used.
pub fn create_pull_request(
    cwd: &str,
    title: Option<&str>,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
    include_unstaged: bool,
) -> Result<PullRequestOutcome, String> {
    let branch = current_branch(cwd).ok_or_else(|| "not a git repository".to_string())?;
    if branch == "HEAD" {
        return Err("cannot create a pull request from a detached HEAD".to_string());
    }

    // The UI check is only an affordance. The node owns the final decision so
    // two concurrent clicks (or two desktop windows) cannot create two PRs for
    // the same local branch.
    let _creation_guard = begin_pull_request_creation(cwd, &branch)?;
    if include_unstaged {
        reject_local_executable_filters(cwd)?;
    }
    if let Some(existing) = existing_open_pull_request(cwd, &branch)? {
        return Ok(pull_request_outcome(
            &existing,
            &branch,
            base.map(str::trim).filter(|value| !value.is_empty()),
            true,
        ));
    }

    let requested_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Update {branch}"));

    if include_unstaged {
        let add = git_without_hooks(&["add", "-A"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git add".to_string())?;
        if !add.status.success() {
            return Err(git_mutation_failed("add"));
        }
    }

    let staged = run_git(cwd, &["diff", "--cached", "--name-only"])
        .map(|value| value.lines().any(|line| !line.trim().is_empty()))
        .unwrap_or(false);
    if staged {
        let message = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Update via Ryu");
        let commit = git_without_hooks(&["commit", "--no-verify", "-m", message])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git commit".to_string())?;
        if !commit.status.success() {
            return Err(git_mutation_failed("commit"));
        }
    }

    let has_upstream = run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_some();
    let push_args: &[&str] = if has_upstream {
        &["push", "--no-verify"]
    } else {
        &["push", "--no-verify", "-u", "origin", "HEAD"]
    };
    let push = git_without_hooks(push_args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|_| "could not start git push".to_string())?;
    if !push.status.success() {
        return Err(git_mutation_failed("push"));
    }

    let body = body.unwrap_or("");
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--head".to_string(),
        branch.clone(),
        "--title".to_string(),
        requested_title.clone(),
        "--body".to_string(),
        body.to_string(),
    ];
    if let Some(base) = base.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--base".to_string(), base.to_string()]);
    }
    if draft {
        args.push("--draft".to_string());
    }

    let gh = Command::new("gh")
        .args(&args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if !gh.status.success() {
        return Err(String::from_utf8_lossy(&gh.stderr).trim().to_string());
    }
    let pr_url = String::from_utf8_lossy(&gh.stdout).trim().to_string();
    if pr_url.is_empty() {
        return Err("gh did not return a pull request URL".to_string());
    }

    // A second lookup closes the check-then-create race across Core processes
    // and enriches the result with the title/number/repository the app uses for
    // its compact CI surface. The URL is still a valid success result if GitHub
    // accepts creation but the follow-up read is temporarily unavailable.
    if let Ok(Some(created)) = existing_open_pull_request(cwd, &branch) {
        return Ok(pull_request_outcome(
            &created,
            &branch,
            base.map(str::trim).filter(|value| !value.is_empty()),
            false,
        ));
    }

    Ok(PullRequestOutcome {
        already_exists: false,
        base: base
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        branch,
        comments_count: None,
        head_sha: None,
        is_draft: draft,
        number: None,
        pr_url,
        repository: None,
        state: Some("OPEN".to_string()),
        success: true,
        title: Some(requested_title),
    })
}
