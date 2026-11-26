//! Names that become a folder or a file name without coming out of an archive.
//!
//! [`super::append_confined`] is the rule for a name an archive carries. Three
//! other names were joined onto a folder with no test of their own: the last
//! part of a catalog skill id, the file name at the end of an asset URL in a
//! plugin manifest, and the folder a plugin sidecar's Python runtime is
//! provisioned into (built from the sidecar's name). On Windows a name such as
//! `C:x` makes `join` drop the folder it is joined onto, so the write lands in
//! the current folder of that drive. On every OS `..` and an empty name leave
//! the folder too.
//!
//! Everything here is pure. No file system call is made.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use anyhow::bail;

use super::{entry_component_refusal, lies_directly_under};

/// Why `name` may not be the one name joined onto a base folder, or `None` for
/// a plain name. Pure: `windows` picks the rule set, so every OS tests both.
///
/// - Every OS: an empty name, `.`, `..`, and a name that holds `/` or a NUL.
/// - With `windows` - a name that holds `\` or `:`, that ends in a dot or a
///   space, or that is a device name.
/// - With `colon_everywhere` - `:` is refused on every OS. That is for names
///   from a plugin package, which must behave the same everywhere. A skill id
///   keeps `:` off Windows, where `react:components` is an ordinary folder.
pub(crate) fn folder_name_refusal(
    name: &str,
    windows: bool,
    colon_everywhere: bool,
) -> Option<&'static str> {
    if name.is_empty() {
        return Some("is empty");
    }
    if name == "." || name == ".." {
        return Some("is '.' or '..'");
    }
    if name.contains('/') {
        return Some("holds '/'");
    }
    if name.contains('\0') {
        return Some("holds a NUL character");
    }
    if (windows || colon_everywhere) && name.contains(':') {
        return Some("holds ':'");
    }
    if !windows {
        return None;
    }
    if name.contains('\\') {
        return Some("holds '\\'");
    }
    // The trailing dot or space and the device names: the list exists once.
    entry_component_refusal(OsStr::new(name), true)
}

/// `base` plus the single name `name`, or an error that says what kind of name
/// it was (`what`, for example "skill id tail"). The rule first, then the name
/// must be exactly one plain component, then the same backstop as
/// [`super::append_confined`]: the result must have `base` as its parent and
/// `name` as its last part. No file system call is made.
pub(crate) fn append_named(
    base: &Path,
    name: &str,
    what: &str,
    colon_everywhere: bool,
) -> anyhow::Result<PathBuf> {
    if let Some(why) = folder_name_refusal(name, cfg!(windows), colon_everywhere) {
        bail!("{what} '{name}' is refused: it {why}");
    }
    let os_name = OsStr::new(name);
    let mut parts = Path::new(name).components();
    let single_plain_name = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(part)), None) if part == os_name
    );
    let out = base.join(name);
    if !single_plain_name || !lies_directly_under(base, &out, os_name) {
        bail!(
            "{what} '{name}' is refused: it does not stay under {}",
            base.display()
        );
    }
    Ok(out)
}

/// Why `dir` may not be the folder a runtime is provisioned into for the
/// package at `package_root`, or `None`. A test on the two paths as given:
/// `dir` must be `package_root` or lie below it, and every step below it must
/// be a plain name that holds no `:` (refused on every OS, so a stream form
/// such as `ab:c` never reaches the file system either). It does not ask what
/// name the folder was built from: a drive form drops the package folder in
/// the join, so the prefix test fails.
pub(crate) fn runtime_dir_refusal(dir: &Path, package_root: &Path) -> Option<&'static str> {
    let Ok(below) = dir.strip_prefix(package_root) else {
        return Some("does not lie under its package folder");
    };
    for component in below.components() {
        match component {
            Component::Normal(name) if name.as_encoded_bytes().contains(&b':') => {
                return Some("holds ':' in a name below its package folder");
            }
            Component::Normal(_) | Component::CurDir => {}
            _ => return Some("does not lie under its package folder"),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_dot_and_slash_names_are_refused_on_every_os() {
        for windows in [false, true] {
            for name in ["", ".", "..", "a/b", "tcw2x/..", "tcw2x/", "a\0b"] {
                assert!(
                    folder_name_refusal(name, windows, false).is_some(),
                    "{name:?} with windows {windows}"
                );
            }
            for name in ["find-skills", "tcw2.skill", "a b", "..x"] {
                assert_eq!(folder_name_refusal(name, windows, true), None, "{name:?}");
            }
        }
    }

    #[test]
    fn a_colon_is_refused_for_windows_and_on_every_os_where_the_caller_asks() {
        assert_eq!(folder_name_refusal("react:components", false, false), None);
        for name in ["react:components", "C:x", "C:", "C:..", "ab:c"] {
            let refused = Some("holds ':'");
            assert_eq!(folder_name_refusal(name, true, false), refused, "{name}");
            assert_eq!(folder_name_refusal(name, false, true), refused, "{name}");
        }
    }

    #[test]
    fn backslashes_device_names_and_trailing_dots_are_refused_for_windows_only() {
        let names = [
            "..\\..\\x",
            "\\x",
            "\\\\server\\share\\x",
            "NUL",
            "nul.txt",
            "COM1",
            "x.",
            "x ",
        ];
        for name in names {
            assert!(folder_name_refusal(name, true, false).is_some(), "{name:?}");
            assert_eq!(folder_name_refusal(name, false, false), None, "{name:?}");
        }
    }

    #[test]
    fn append_named_joins_a_plain_name_and_says_what_it_refuses() {
        let base = Path::new("skills-tcw2");
        let joined = append_named(base, "find-skills", "skill id tail", false).unwrap();
        assert_eq!(joined, base.join("find-skills"));
        for name in ["", ".", "..", "a/b", "tcw2x/.."] {
            let error = append_named(base, name, "skill id tail", false)
                .unwrap_err()
                .to_string();
            let start = format!("skill id tail '{name}' is refused");
            assert!(error.starts_with(&start), "{error}");
        }
        let error = append_named(base, "C:tcw2.bin", "asset file name", true)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "asset file name 'C:tcw2.bin' is refused: it holds ':'"
        );
    }

    #[test]
    fn a_runtime_folder_must_lie_under_its_package_folder() {
        let root = Path::new("plugins-tcw2").join("demo");
        assert_eq!(runtime_dir_refusal(&root, &root), None);
        let plain = root.join("runtime").join("worker");
        assert_eq!(runtime_dir_refusal(&plain, &root), None);
        let outside = [
            PathBuf::from("elsewhere-tcw2"),
            Path::new("plugins-tcw2").join("demo2").join("runtime"),
            root.join("runtime").join(".."),
            root.join("runtime").join("ab:c"),
            // What the sidecar's join makes of the name "C:x": on Windows the
            // package folder is gone, elsewhere the last name holds ':'.
            root.join("runtime").join("C:x"),
        ];
        for dir in outside {
            assert!(runtime_dir_refusal(&dir, &root).is_some(), "{dir:?}");
        }
    }
}
