//! "Credit Ryu in git commits": the co-author trailer Ryu adds to commits it
//! makes in a user's repository, and the node preference that turns it off.
//!
//! Every commit Ryu itself runs (the commit and pull-request actions, applying
//! an isolated run's worktree, and the Box commit script in Core) takes a
//! `credit` flag from this preference. Ryu's own bookkeeping repositories
//! (worktree retention, checkpoint history) are not user history and never
//! carry the trailer.

use super::remote::installed_git_version;

/// Core preference key. The stored value is `true` or `false`.
pub const GIT_CREDIT_RYU_PREF_KEY: &str = "git-credit-ryu";

/// Credit is on for every node that never saved the preference, new or
/// existing.
pub const DEFAULT_GIT_CREDIT_RYU: bool = true;

/// The one trailer line that credits Ryu, in the form GitHub reads as a
/// co-author.
pub const RYU_COAUTHOR_TRAILER: &str = "Co-authored-by: Ryu <amajorhq@gmail.com>";

/// First Git release whose `git commit` accepts `--trailer`.
pub(crate) const GIT_COMMIT_TRAILER_MIN: (u32, u32) = (2, 32);

/// Read the saved preference. Only an explicit `false` turns credit off: a
/// missing or unrecognized value keeps the default, so a node that upgrades
/// without ever opening the setting credits Ryu.
pub fn git_credit_ryu(preference: Option<&str>) -> bool {
    match preference.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("false") => false,
        Some(value) if value.eq_ignore_ascii_case("true") => true,
        _ => DEFAULT_GIT_CREDIT_RYU,
    }
}

/// Wrap the arguments of one `git commit` call (starting at `commit`) so the
/// commit carries [`RYU_COAUTHOR_TRAILER`] when `credit` is set.
///
/// The trailer is added with Git's own `--trailer`, so the blank line before
/// the trailer block and the join with trailers already in the message follow
/// Git's rules. `trailer.ifexists=addIfDifferent` keeps a message that already
/// carries the same trailer from getting it twice.
///
/// A Git older than [`GIT_COMMIT_TRAILER_MIN`] rejects `--trailer`, so there the
/// arguments come back unchanged: the commit is made without credit instead of
/// failing.
pub(crate) fn credited_commit_args<'a>(commit_args: &[&'a str], credit: bool) -> Vec<&'a str> {
    // The version probe spawns `git`; skip it when no trailer is wanted.
    let git_version = if credit {
        installed_git_version()
    } else {
        None
    };
    credited_commit_args_for(commit_args, credit, git_version)
}

fn credited_commit_args_for<'a>(
    commit_args: &[&'a str],
    credit: bool,
    git_version: Option<(u32, u32)>,
) -> Vec<&'a str> {
    let supported = git_version.is_some_and(|version| version >= GIT_COMMIT_TRAILER_MIN);
    if !(credit && supported) {
        return commit_args.to_vec();
    }
    let mut args = Vec::with_capacity(commit_args.len() + 4);
    args.extend(["-c", "trailer.ifexists=addIfDifferent"]);
    args.extend_from_slice(commit_args);
    args.extend(["--trailer", RYU_COAUTHOR_TRAILER]);
    args
}

#[cfg(test)]
#[path = "credit_tests.rs"]
mod tests;
