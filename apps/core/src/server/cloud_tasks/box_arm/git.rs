//! Repository helpers: base revision, branch names, diffs and compare links.

use super::*;

pub(super) fn repo_env(task: &LiveTask) -> Vec<(String, String)> {
    vec![(
        "RYU_REPO_DIR".to_owned(),
        task.context.working_directory.clone(),
    )]
}

/// The commit and branch setup checked out in the primary repository.
pub(in crate::server::cloud_tasks) async fn base_revision(
    task: &LiveTask,
) -> Result<(String, Option<String>)> {
    let TaskWorkspace::Box(workspace) = &task.workspace else {
        bail!("Not a Box task");
    };
    let output = session_box::box_client()
        .await?
        .exec_script(
            workspace,
            BASE_REVISION_SCRIPT,
            &repo_env(task),
            BoxUser::Box,
            60,
        )
        .await?;
    ensure!(output.exit_code == 0, "Repository revision is unavailable");
    parse_base_revision(&String::from_utf8_lossy(&output.stdout))
}

pub(super) fn parse_base_revision(stdout: &str) -> Result<(String, Option<String>)> {
    let mut lines = stdout.lines().map(str::trim);
    let sha = lines.next().unwrap_or_default();
    ensure!(
        matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Repository revision is invalid"
    );
    let branch = lines
        .next()
        .filter(|branch| !branch.is_empty() && *branch != "HEAD")
        .map(str::to_owned);
    Ok((sha.to_owned(), branch))
}

/// Replace every non-empty secret with `[redacted]`.
pub(in crate::server::cloud_tasks) fn redact(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            text = text.replace(secret.as_str(), "[redacted]");
        }
    }
    text
}

/// The last `max` characters.
pub(in crate::server::cloud_tasks) fn tail(text: String, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    text.chars().skip(count - max).collect()
}

/// A branch name safe for a clean-room push.
pub(in crate::server::cloud_tasks) fn validate_branch(
    branch: &str,
    base: Option<&str>,
) -> Result<String> {
    let mut bytes = branch.bytes();
    ensure!(
        bytes.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
            && branch.len() <= 100
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte)),
        "Branch names start with a letter or digit and use only letters, digits, '.', '_', '/' and '-' (up to 100 characters)."
    );
    ensure!(
        !branch.contains("..") && !branch.contains("@{") && !branch.contains("//"),
        "Branch names cannot contain '..', '@{{' or '//'."
    );
    ensure!(
        !branch.ends_with('/')
            && !branch.ends_with(".lock")
            && branch
                .split('/')
                .all(|part| !part.starts_with('.') && !part.ends_with(".lock")),
        "Branch names cannot end in '/' or '.lock', and no part may start with '.'."
    );
    ensure!(
        base != Some(branch),
        "Push to a new branch, not the branch the task started from."
    );
    Ok(branch.to_owned())
}

/// `ryu/<first 8 characters of the conversation id>`.
pub(in crate::server::cloud_tasks) fn default_branch(conversation_id: &str) -> String {
    let suffix: String = conversation_id
        .chars()
        .take(8)
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("ryu/{}", if suffix.is_empty() { "task" } else { &suffix })
}

/// Parse `git diff --numstat` lines; binary files report `-` counts.
pub(in crate::server::cloud_tasks) fn parse_numstat(text: &str) -> Vec<DiffFile> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let insertions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(DiffFile {
                path: path.to_owned(),
                insertions: insertions.trim().parse().ok(),
                deletions: deletions.trim().parse().ok(),
            })
        })
        .take(MAX_DIFF_FILES)
        .collect()
}

/// Split DIFF_SCRIPT stdout into `(files, patch, truncated)`.
pub(in crate::server::cloud_tasks) fn parse_diff_output(
    stdout: &str,
) -> (Vec<DiffFile>, String, bool) {
    let (numstat, patch) = stdout.split_once(PATCH_MARKER).unwrap_or((stdout, ""));
    let files = parse_numstat(numstat);
    let mut truncated = files.len() >= MAX_DIFF_FILES;
    let patch = if patch.len() > MAX_PATCH_BYTES {
        truncated = true;
        let mut end = MAX_PATCH_BYTES;
        while !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch[..end].to_owned()
    } else {
        patch.to_owned()
    };
    (files, patch, truncated)
}

/// Map git push stderr to a stable error code.
pub(in crate::server::cloud_tasks) fn push_error_code(stderr: &str) -> &'static str {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("non-fast-forward") || lower.contains("rejected") {
        "non_fast_forward"
    } else if lower.contains("403")
        || lower.contains("authentication")
        || lower.contains("could not read")
    {
        "auth"
    } else if lower.contains("could not resolve") || lower.contains("timed out") {
        "network"
    } else {
        "unknown"
    }
}

/// The GitHub compare page for a pushed branch.
pub(in crate::server::cloud_tasks) fn compare_url(
    owner_repo: &str,
    base: Option<&str>,
    branch: &str,
) -> String {
    match base {
        Some(base) => format!("https://github.com/{owner_repo}/compare/{base}...{branch}?expand=1"),
        None => format!("https://github.com/{owner_repo}/compare/{branch}?expand=1"),
    }
}

pub(super) fn relative_cwd(working_directory: &str) -> String {
    working_directory
        .strip_prefix(BOX_WORKSPACE_ROOT)
        .map(|rest| rest.trim_start_matches('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(".")
        .to_owned()
}

pub(super) fn prompt_text(start_instructions: &str, text: &str) -> String {
    let joined = if start_instructions.trim().is_empty() {
        text.to_owned()
    } else {
        format!("{start_instructions}\n\n{text}")
    };
    joined.chars().take(MAX_PROMPT_CHARS).collect()
}
