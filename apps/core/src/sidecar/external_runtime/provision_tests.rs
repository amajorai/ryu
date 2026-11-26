//! Tests for the folder a Python runtime is provisioned into (finding TC-W2,
//! the sidecar name).
//!
//! Every case declares a package-relative source folder that holds no
//! `pyproject.toml`. So neither the code before the fix nor the fix can get as
//! far as starting Python: the most the old code does is create the folder and
//! copy one note file into it. Every name these tests can create holds "tcw2".

use super::*;

const ROOT_ENV: &str = "RYU_TCW2_PACKAGE_ROOT";
const NAME_ENV: &str = "RYU_TCW2_SIDECAR_NAME";
const RESULT: &str = "TCW2-RESULT";

/// A package folder whose source folder holds one note and no `pyproject.toml`.
fn package_in(root: &Path) -> PathBuf {
    let package = root.join("tcw2-package");
    fs::create_dir_all(package.join("tcw2-src")).unwrap();
    fs::write(package.join("tcw2-src").join("tcw2-note.txt"), "tcw2").unwrap();
    package
}

fn config() -> ExternalRuntimeConfig {
    ExternalRuntimeConfig {
        kind: RUNTIME_PYTHON.to_owned(),
        entry: "tcw2".to_owned(),
        source: Some(SourceArchiveSpec {
            url: String::new(),
            sha256: None,
            format: "tar.gz".to_owned(),
            path: Some("tcw2-src".to_owned()),
        }),
        ..Default::default()
    }
}

/// Provisions into the folder a sidecar start builds for the sidecar name
/// `name` (package folder, `runtime`, then the name) and returns what came back.
async fn provision_named(package: &Path, name: &str) -> String {
    let dir = package.join("runtime").join(name);
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    match provision_with_package_root(&config(), &dir, &downloads, package).await {
        Ok(python) => format!("provisioned {}", python.display()),
        Err(error) => error.to_string(),
    }
}

fn is_the_refusal(text: &str) -> bool {
    text.contains("unsafe package path: runtime folder") && text.contains("is refused")
}

/// A drive letter with no volume behind it. Panics, never skips, if none is free.
fn unused_drive_letter() -> char {
    if !cfg!(windows) {
        return 'Q';
    }
    ('G'..='Z')
        .rev()
        .find(|letter| !Path::new(&format!("{letter}:\\")).exists())
        .expect("no free drive letter from Z down to G, so this test cannot run safely")
}

/// The drive letter of `root` itself. Panics, never skips, if it has none.
fn drive_letter_of(root: &Path) -> char {
    use std::path::Prefix;
    match root.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter as char,
            other => panic!("the temp folder has no drive letter: {other:?}"),
        },
        _ if cfg!(windows) => panic!("the temp folder {root:?} has no drive letter"),
        _ => 'Q',
    }
}

fn list_below(root: &Path, dir: &Path, found: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let rel = path.strip_prefix(root).unwrap().to_string_lossy();
        found.push(rel.replace('\\', "/"));
        if path.is_dir() {
            list_below(root, &path, found);
        }
    }
}

// On Windows the name `Q:tcw2x` is a drive-relative path: the sidecar's join
// drops the package folder. The letter has no volume behind it, so the code
// before the fix fails in the file system and creates nothing either.
#[tokio::test]
async fn a_runtime_folder_on_another_drive_is_refused_before_it_is_created() {
    let tmp = tempfile::tempdir().unwrap();
    let package = package_in(tmp.path());
    let name = format!("{}:tcw2x", unused_drive_letter());
    let result = provision_named(&package, &name).await;
    println!("TCW2 runtime {name}: {result}");
    assert!(is_the_refusal(&result), "{result}");
    assert!(!package.join("runtime").exists());
}

// A colon that is not a drive form stays under the package folder, and is
// refused on every OS before the folder is created.
#[tokio::test]
async fn a_runtime_folder_name_with_a_colon_is_refused_before_it_is_created() {
    let tmp = tempfile::tempdir().unwrap();
    let package = package_in(tmp.path());
    let result = provision_named(&package, "ab:tcw2c").await;
    println!("TCW2 runtime ab:tcw2c: {result}");
    assert!(is_the_refusal(&result), "{result}");
    assert!(!package.join("runtime").exists());
}

/// The child. It does nothing unless the parent test below started it.
#[tokio::test]
#[ignore = "started only by a_drive_form_runtime_folder_stays_out_of_the_current_folder"]
async fn tcw2_child_provisions_in_its_jail() {
    let (Some(package), Ok(name)) = (std::env::var_os(ROOT_ENV), std::env::var(NAME_ENV)) else {
        return;
    };
    let result = provision_named(Path::new(&package), &name).await;
    println!("{RESULT} {result}");
}

// The same with the drive letter of the temp folder itself, in a child process
// whose current folder is `tcw2-jail` inside the temp folder. On the code
// before the fix the runtime folder is made at `tcw2-jail/tcw2x` and the note
// is copied into it.
#[test]
fn a_drive_form_runtime_folder_stays_out_of_the_current_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let package = package_in(root);
    let jail = root.join("tcw2-jail");
    fs::create_dir_all(&jail).unwrap();
    let name = format!("{}:tcw2x", drive_letter_of(root));
    let module = module_path!().split_once("::").expect("a module path").1;
    let child = format!("{module}::tcw2_child_provisions_in_its_jail");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([child.as_str(), "--exact", "--ignored", "--nocapture"])
        .env(ROOT_ENV, &package)
        .env(NAME_ENV, &name)
        .current_dir(&jail)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut tree = Vec::new();
    list_below(root, root, &mut tree);
    tree.sort();
    println!("TCW2 runtime {name} in a child, tree {tree:?}\n{stdout}");
    assert!(
        output.status.success() && stdout.contains(RESULT),
        "the child did not run to its end: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let refused = stdout
        .lines()
        .any(|line| line.starts_with(RESULT) && is_the_refusal(line));
    assert!(refused, "{name} was not refused: {stdout}");
    let untouched = [
        "tcw2-jail",
        "tcw2-package",
        "tcw2-package/tcw2-src",
        "tcw2-package/tcw2-src/tcw2-note.txt",
    ];
    assert_eq!(tree, untouched, "{name} left something behind");
}

// The folders every caller of today passes: the package folder itself and a
// plain name below it. Neither is refused; both get as far as the source copy,
// which then stops on the missing `pyproject.toml`.
#[tokio::test]
async fn an_ordinary_runtime_folder_is_not_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let package = package_in(tmp.path());
    let result = provision_named(&package, "tcw2-worker").await;
    assert!(
        result.contains("does not contain a 'pyproject.toml'"),
        "{result}"
    );
    let copied = package
        .join("runtime")
        .join("tcw2-worker")
        .join("tcw2-note.txt");
    assert!(copied.is_file());

    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let result = provision(&config(), &package, &downloads)
        .await
        .expect_err("the source folder has no pyproject.toml")
        .to_string();
    assert!(
        result.contains("does not contain a 'pyproject.toml'"),
        "{result}"
    );
    assert!(package.join("tcw2-note.txt").is_file());
}
