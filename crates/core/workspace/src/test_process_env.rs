//! Test-binary isolation from any git repository around the test process.
//!
//! Fixtures create repositories under the system temp directory. Two things
//! can point their `git` calls at a different repository:
//!
//! - A git hook exports variables that pick a repository, its index and its
//!   object store (the pre-commit hook sets `GIT_INDEX_FILE`). A fixture
//!   `git add` would then write into the commit being made.
//! - When the temp directory lies inside a checkout (for example `TMPDIR`
//!   under `target/`), git discovery walks up from a fixture directory that
//!   is not a repository yet and finds the checkout. Fixture `git config` and
//!   `git add` calls, and the code under test, then act on the real repository.
//!
//! Clearing the first set and adding the temp directory to
//! `GIT_CEILING_DIRECTORIES`, once and before any test starts, keeps every
//! `git` call inside its own fixture.

use std::ffi::OsString;
use std::path::PathBuf;

/// The variables through which an inherited environment chooses the
/// repository, work tree, index or object store a `git` call works on.
pub(crate) const INHERITED_GIT_REPOSITORY_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/// The temp directory as given and, when it differs, its canonical form, so a
/// symlinked temp root (macOS `/var` to `/private/var`) is covered either way.
pub(crate) fn temp_ceilings() -> Vec<PathBuf> {
    let temp = std::env::temp_dir();
    let mut ceilings = vec![temp.clone()];
    if let Ok(canonical) = temp.canonicalize() {
        if canonical != temp {
            ceilings.push(canonical);
        }
    }
    ceilings
}

/// `existing` (an inherited `GIT_CEILING_DIRECTORIES`, if any) with `ceilings`
/// appended, joined with the platform path separator git expects.
pub(crate) fn ceiling_value(existing: Option<OsString>, ceilings: &[PathBuf]) -> OsString {
    let mut paths: Vec<PathBuf> = existing
        .as_deref()
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    for ceiling in ceilings {
        if !paths.contains(ceiling) {
            paths.push(ceiling.clone());
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| existing.unwrap_or_default())
}

/// Runs before the test harness starts any thread, so changing the process
/// environment here cannot race a test that reads it.
#[ctor::ctor]
fn isolate_tests_from_surrounding_repositories() {
    for name in INHERITED_GIT_REPOSITORY_ENV {
        std::env::remove_var(name);
    }
    let value = ceiling_value(
        std::env::var_os("GIT_CEILING_DIRECTORIES"),
        &temp_ceilings(),
    );
    std::env::set_var("GIT_CEILING_DIRECTORIES", value);
}

#[cfg(test)]
mod tests {
    use super::{ceiling_value, temp_ceilings, INHERITED_GIT_REPOSITORY_ENV};
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn no_test_sees_an_inherited_git_repository() {
        for name in INHERITED_GIT_REPOSITORY_ENV {
            assert!(
                std::env::var_os(name).is_none(),
                "{name} reached the test process; fixture git calls would act on the launching repository"
            );
        }
    }

    #[test]
    fn the_temp_directory_is_a_git_ceiling() {
        let value = std::env::var_os("GIT_CEILING_DIRECTORIES").expect("ceiling is set");
        let ceilings: Vec<PathBuf> = std::env::split_paths(&value).collect();
        for temp in temp_ceilings() {
            assert!(ceilings.contains(&temp), "{} missing from {value:?}", temp.display());
        }
    }

    /// The regression this guards: with `TMPDIR` inside a checkout, a fresh
    /// fixture directory used to resolve to that checkout. It must read as
    /// "not a repository" wherever the temp directory lives.
    #[test]
    fn a_fresh_temp_directory_is_never_inside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let output = Command::new("git")
            .args(["rev-parse", "--absolute-git-dir"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "a fixture directory resolved to the repository at {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }

    #[test]
    fn an_inherited_ceiling_is_kept_and_not_duplicated() {
        let inherited = std::env::join_paths([PathBuf::from("/srv/outer")]).unwrap();
        let temp = PathBuf::from("/srv/tmp");
        let value = ceiling_value(Some(inherited), &[temp.clone(), temp.clone()]);
        let paths: Vec<PathBuf> = std::env::split_paths(&value).collect();
        assert_eq!(paths, vec![PathBuf::from("/srv/outer"), temp]);
    }

    #[test]
    fn without_an_inherited_ceiling_only_the_temp_roots_are_set() {
        let temp = PathBuf::from("/srv/tmp");
        let value = ceiling_value(None::<OsString>, std::slice::from_ref(&temp));
        assert_eq!(std::env::split_paths(&value).collect::<Vec<_>>(), vec![temp]);
    }
}
