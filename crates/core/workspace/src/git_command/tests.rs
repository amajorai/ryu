//! Tests for the hardened `git` builder: a program named by a repository's own
//! configuration must not start when this crate reads or changes that
//! repository.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use super::*;

/// Plain `git`, as a user's own shell would run it. Used for fixtures and for
/// the control that proves a fixture's planted program really runs.
fn plain_git(cwd: &Path, args: &[&str]) -> Output {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn shell_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// A repository with one commit and one unstaged change.
fn repository(root: &Path) {
    plain_git(root, &["init", "-q", "-b", "main"]);
    plain_git(root, &["config", "user.name", "Ryu Test"]);
    plain_git(root, &["config", "user.email", "ryu-test@example.com"]);
    plain_git(root, &["config", "commit.gpgSign", "false"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    plain_git(root, &["add", "a.txt"]);
    plain_git(root, &["commit", "-q", "-m", "init"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
}

/// Point `core.fsmonitor` of the repository at `root` at a program that
/// leaves `marker` behind. Git runs it on `status` and `diff`.
fn plant_file_monitor(root: &Path, marker: &Path) {
    let program = format!("touch '{}'; false", shell_path(marker));
    plain_git(root, &["config", "core.fsmonitor", &program]);
}

#[test]
fn a_planted_file_monitor_does_not_run_on_status_branches_or_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("ran");
    repository(dir.path());
    plant_file_monitor(dir.path(), &marker);
    let cwd = dir.path().to_str().unwrap();

    let state = crate::git::query_git_state(cwd);
    assert!(state.is_repo);
    assert!(state.dirty, "the unstaged change is still reported");
    assert_eq!(state.insertions, 1);
    assert!(!marker.exists(), "status started the planted program");

    let branches = crate::git::list_branches(cwd);
    assert!(branches.is_repo);
    assert_eq!(branches.current.as_deref(), Some("main"));
    assert!(!marker.exists(), "branches started the planted program");

    let diff = {
        let guard = crate::worktree::create_worktree_in(dir.path(), None).unwrap();
        crate::worktree::worktree_diff(&guard.path, &guard.base_hash)
    };
    assert!(diff.files.is_empty());
    assert!(
        !marker.exists(),
        "a run worktree started the planted program"
    );

    // Control: the same repository does start the program for plain git, so
    // the assertions above fail without the overrides.
    plain_git(dir.path(), &["status", "--porcelain"]);
    assert!(marker.exists(), "the fixture's program never runs");
}

#[test]
fn an_embedded_bare_repository_is_not_used() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("ran");
    repository(dir.path());
    let embedded = dir.path().join("vendor").join("data");
    std::fs::create_dir_all(&embedded).unwrap();
    plain_git(&embedded, &["init", "-q", "--bare"]);
    plain_git(&embedded, &["config", "core.bare", "false"]);
    plain_git(&embedded, &["config", "core.worktree", "."]);
    plant_file_monitor(&embedded, &marker);
    let cwd = embedded.to_str().unwrap();

    assert!(!crate::git::query_git_state(cwd).is_repo);
    assert!(!crate::git::list_branches(cwd).is_repo);
    assert!(!marker.exists(), "the embedded repository's program ran");

    // Control: plain git uses the embedded repository and starts its program.
    let _ = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&embedded)
        .output()
        .unwrap();
    assert!(marker.exists(), "the fixture's program never runs");
}

#[test]
fn a_repository_external_diff_and_hook_do_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let diff_marker = outside.path().join("diff-ran");
    let hook_marker = outside.path().join("hook-ran");
    repository(dir.path());
    let program = format!("touch '{}'; true", shell_path(&diff_marker));
    plain_git(dir.path(), &["config", "diff.external", &program]);
    let hooks = dir.path().join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ntouch '{}'\n", shell_path(&hook_marker)),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let patch = git_command(&["diff", "HEAD"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(patch.status.success());
    assert!(String::from_utf8_lossy(&patch.stdout).contains("+two"));
    assert!(!diff_marker.exists(), "diff started the external program");

    let commit = git_command(&["commit", "-q", "-a", "-m", "two"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(
        commit.status.success(),
        "{}",
        String::from_utf8_lossy(&commit.stderr)
    );
    assert!(!hook_marker.exists(), "commit ran the repository hook");
}

#[test]
fn patch_guards_follow_the_subcommand() {
    assert_eq!(
        guarded_args(&["diff", "HEAD", "--numstat"]),
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--numstat"
        ]
    );
    assert_eq!(
        guarded_args(&[
            "-c",
            "color.ui=false",
            "-C",
            "sub",
            "--no-pager",
            "log",
            "-1"
        ]),
        [
            "-c",
            "color.ui=false",
            "-C",
            "sub",
            "--no-pager",
            "log",
            "--no-ext-diff",
            "--no-textconv",
            "-1"
        ]
    );
    assert_eq!(
        guarded_args(&["notes", "--ref=ryu", "show", "HEAD"]),
        ["notes", "--ref=ryu", "show", "HEAD"]
    );
    assert_eq!(
        guarded_args(&["status", "--porcelain"]),
        ["status", "--porcelain"]
    );
    assert!(guarded_args(&[]).is_empty());
    assert_eq!(guarded_args(&["-c"]), ["-c"]);
}

#[test]
fn user_level_settings_keep_helper_order_and_resets() {
    let records = concat!(
        "credential.helper\nmanager\0",
        "credential.https://github.com.helper\n\0",
        "credential.https://github.com.helper\n!gh auth git-credential\0",
        "core.sshcommand\nC:/Windows/System32/OpenSSH/ssh.exe\0",
        "credential.usehttppath\ntrue\0",
    );
    let settings = parse_user_level_settings(records);
    assert_eq!(
        settings.credential_helpers,
        [
            ("credential.helper".to_string(), "manager".to_string()),
            (
                "credential.https://github.com.helper".to_string(),
                String::new()
            ),
            (
                "credential.https://github.com.helper".to_string(),
                "!gh auth git-credential".to_string()
            ),
        ]
    );
    assert_eq!(
        settings.ssh_command.as_deref(),
        Some("C:/Windows/System32/OpenSSH/ssh.exe")
    );
    assert_eq!(parse_user_level_settings(""), UserLevelSettings::default());
}

#[test]
fn the_ssh_program_never_comes_from_the_repository() {
    let user = UserLevelSettings {
        credential_helpers: Vec::new(),
        ssh_command: Some("user-ssh".to_string()),
    };
    assert_eq!(
        ssh_command_from(Some("env-ssh".to_string()), &user),
        "env-ssh"
    );
    assert_eq!(ssh_command_from(Some("  ".to_string()), &user), "user-ssh");
    assert_eq!(ssh_command_from(None, &user), "user-ssh");
    assert_eq!(ssh_command_from(None, &UserLevelSettings::default()), "ssh");

    // Whatever the user has, the command clears the helper list and pins the
    // ssh program in the environment.
    let mut command = Command::new("git");
    apply_overrides(&mut command, &user);
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.contains(&"core.fsmonitor=false".to_string()));
    assert!(args.contains(&"safe.bareRepository=explicit".to_string()));
    assert!(args.contains(&"credential.helper=".to_string()));
    let ssh = command
        .get_envs()
        .find(|(key, _)| key.to_str() == Some("GIT_SSH_COMMAND"))
        .and_then(|(_, value)| value)
        .expect("ssh program pinned");
    assert!(!ssh.is_empty());
}

/// The entry point for callers outside the crate clears the environment,
/// keeps what the caller passes, and still applies every override last.
#[test]
fn the_environment_builder_keeps_the_overrides_and_only_the_given_variables() {
    let command = git_command_with_env(
        &["diff", "HEAD"],
        [("RYU_TEST_KEPT", "1"), ("GIT_TERMINAL_PROMPT", "1")],
    );
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.contains(&"core.fsmonitor=false".to_string()));
    assert!(args.contains(&"safe.bareRepository=explicit".to_string()));
    let diff = args
        .iter()
        .position(|arg| arg == "diff")
        .expect("subcommand");
    assert_eq!(
        &args[diff + 1..diff + 3],
        ["--no-ext-diff", "--no-textconv"]
    );
    let env = |name: &str| {
        command
            .get_envs()
            .find(|(key, _)| key.to_str() == Some(name))
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    };
    assert_eq!(env("RYU_TEST_KEPT").as_deref(), Some("1"));
    assert_eq!(env("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));

    // A planted file monitor stays off when the caller passes its own
    // environment (here the full one, so git and its shell are found).
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("ran");
    repository(dir.path());
    plant_file_monitor(dir.path(), &marker);
    let output = git_command_with_env(&["status", "--porcelain"], std::env::vars())
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!marker.exists(), "status started the planted program");
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Every `git` this crate starts must come from [`git_command`]. Two files
/// may build one directly: this module, and the checkpoint store, which runs
/// against Ryu's own `--git-dir` (never the workspace's `.git/config`) with
/// its own overrides.
#[test]
fn no_source_file_builds_git_outside_the_builder() {
    let needle = ["Command::new(", "\"git\")"].concat();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    assert!(files.len() > 10, "source tree not found");
    let mut offenders = Vec::new();
    for file in files {
        let relative = shell_path(file.strip_prefix(&src).unwrap());
        let is_test = relative.contains("tests")
            || relative.ends_with("_test.rs")
            || relative == "test_process_env.rs";
        if is_test || relative == "git_command.rs" || relative == "checkpoints.rs" {
            continue;
        }
        let source = std::fs::read_to_string(&file).unwrap();
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        if production.contains(&needle) {
            offenders.push(relative);
        }
    }
    assert!(offenders.is_empty(), "bare git in {offenders:?}");
}
