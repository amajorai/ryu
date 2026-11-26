//! The Box commit script and the "Credit Ryu in git commits" setting.

use ryu_workspace::git::RYU_COAUTHOR_TRAILER;

use super::super::finish::commit_env;
use super::*;

fn env_value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

#[test]
fn the_commit_env_carries_the_trailer_only_when_credit_is_on() {
    let on = commit_env("/work/repo", "abc123", "Add notes", true);
    assert_eq!(
        env_value(&on, "RYU_COMMIT_TRAILER"),
        Some(RYU_COAUTHOR_TRAILER)
    );
    assert_eq!(env_value(&on, "RYU_COMMIT_MESSAGE"), Some("Add notes"));
    assert_eq!(env_value(&on, "RYU_REPO_DIR"), Some("/work/repo"));
    assert_eq!(env_value(&on, "RYU_BASE_SHA"), Some("abc123"));

    let off = commit_env("/work/repo", "abc123", "Add notes", false);
    assert_eq!(env_value(&off, "RYU_COMMIT_TRAILER"), Some(""));
}

#[test]
fn the_commit_script_takes_the_trailer_only_from_env() {
    assert!(COMMIT_SCRIPT.contains("--trailer \"$RYU_COMMIT_TRAILER\""));
    assert!(COMMIT_SCRIPT.contains("trailer.ifexists=addIfDifferent"));
    assert!(!COMMIT_SCRIPT.contains("Co-authored-by"));
}

/// Runs COMMIT_SCRIPT with real git, with the trailer env set, empty and
/// missing. The script is POSIX `sh` that runs in the Linux box, so the test
/// needs a POSIX shell.
#[cfg(unix)]
#[test]
fn the_commit_script_credits_ryu_with_real_git() {
    use std::process::Command;
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    // A git hook (the pre-commit gate runs this test) exports GIT_INDEX_FILE
    // and friends; inherited, they would point these commands at the outer
    // repository's index instead of the temp repository.
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
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = isolated(Command::new("git"))
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&["add", "-A"]);
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "-m",
        "init",
    ]);
    let base = git(&["rev-parse", "HEAD"]);
    let has_trailer_flag = {
        let help = isolated(Command::new("git"))
            .args(["commit", "-h"])
            .current_dir(&repo)
            .output()
            .unwrap();
        let text = [help.stdout, help.stderr].concat();
        String::from_utf8_lossy(&text).contains("--trailer")
    };

    // Commit one change through the script and return the commit message.
    let commit = |file: &str, message: &str, trailer: Option<&str>| {
        std::fs::write(repo.join(file), "change\n").unwrap();
        let mut command = isolated(Command::new("sh"));
        command
            .args(["-c", COMMIT_SCRIPT])
            .env("RYU_REPO_DIR", &repo)
            .env("RYU_BASE_SHA", &base)
            .env("RYU_COMMIT_MESSAGE", message);
        if let Some(trailer) = trailer {
            command.env("RYU_COMMIT_TRAILER", trailer);
        }
        let out = command.output().unwrap();
        assert!(out.status.success(), "commit script: {out:?}");
        git(&["log", "-1", "--format=%B"])
    };

    let credited = commit("b.txt", "Add b", Some(RYU_COAUTHOR_TRAILER));
    if has_trailer_flag {
        assert_eq!(credited, format!("Add b\n\n{RYU_COAUTHOR_TRAILER}"));
    } else {
        assert_eq!(credited, "Add b");
    }
    assert_eq!(commit("c.txt", "Add c", Some("")), "Add c");
    // An older Core that does not send the variable still commits.
    assert_eq!(commit("d.txt", "Add d", None), "Add d");
    // The Box commit keeps its own author.
    assert_eq!(
        git(&["log", "-1", "--format=%an <%ae>"]),
        "Ryu <cloud-task@ryu.invalid>"
    );
}
