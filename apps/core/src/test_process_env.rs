//! Test-binary isolation from the git repository that launched the run.
//!
//! A git hook exports the variables that pick a repository, its index and its
//! object store (the pre-commit hook sets `GIT_INDEX_FILE` to the commit's
//! temporary index). Any ryu-core test that runs `git` in a fixture repository
//! would inherit them, so a fixture `git add` would write entries into the
//! commit being made, and the commit fails with "invalid object" or records
//! paths that are not in the change. Clearing them once, before any test
//! starts, keeps every fixture `git` call pointed at its own repository.

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

/// Runs before the test harness starts any thread, so removing process
/// environment variables here cannot race a test that reads them.
#[ctor::ctor]
fn isolate_tests_from_the_launching_repository() {
    for name in INHERITED_GIT_REPOSITORY_ENV {
        std::env::remove_var(name);
    }
}

#[cfg(test)]
mod tests {
    use super::INHERITED_GIT_REPOSITORY_ENV;

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
    fn the_repository_selecting_variables_are_covered() {
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
        ] {
            assert!(INHERITED_GIT_REPOSITORY_ENV.contains(&name), "{name}");
        }
    }
}
