//! Tests for the folder a catalog install writes to (finding TC-W2, the skill id).
//!
//! The install asks the catalog before it builds the folder, and the catalog
//! address is a setting of the whole process. So every case here runs
//! `install_skill` in a CHILD process. Its catalog is a listener on 127.0.0.1
//! that this file starts, and its skills folder, data folder and current folder
//! all lie inside one temp folder. The child does nothing unless its catalog
//! address is on 127.0.0.1. Every name these tests can create holds "tcw2".

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CATALOG_ENV: &str = "SKILLS_SH_API_URL";
const ID_ENV: &str = "RYU_TCW2_SKILL_ID";
const RESULT: &str = "TCW2-RESULT";
/// The folders `install_in_child` makes itself. A refused id leaves only these.
const UNTOUCHED: [&str; 4] = [
    "tcw2-a",
    "tcw2-a/tcw2-b",
    "tcw2-a/tcw2-b/tcw2-skills",
    "tcw2-jail",
];

/// True when `address` is a plain http address on 127.0.0.1.
fn is_loopback_catalog(address: &str) -> bool {
    url::Url::parse(address)
        .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
}

/// The child. Its first step refuses to go on unless the catalog address is on
/// 127.0.0.1, so it can never ask the live catalog. Run by hand it does nothing.
#[tokio::test]
#[ignore = "started only by the tests of this file"]
async fn tcw2_child_installs_in_its_jail() {
    let catalog = std::env::var(CATALOG_ENV).unwrap_or_default();
    if !is_loopback_catalog(&catalog) {
        println!("{RESULT} not started, the catalog address is not on 127.0.0.1");
        return;
    }
    let Ok(id) = std::env::var(ID_ENV) else {
        return;
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();
    match super::install_skill(&client, &id).await {
        Ok(result) => println!("{RESULT} installed {} at {}", result.slug, result.path),
        Err(error) => println!("{RESULT} error {error:#}"),
    }
}

/// A catalog on 127.0.0.1 that answers every request with one small package.
/// Returns its address and the list of the request paths it was asked for.
fn local_catalog() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&asked);
    std::thread::spawn(move || {
        let package = serde_json::json!({ "files": [
            { "path": "SKILL.md", "contents": "---\nname: tcw2\ndescription: a test skill\n---\nBody." },
            { "path": "notes/tcw2-note.txt", "contents": "tcw2" },
        ] })
        .to_string();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let mut head = Vec::new();
            let mut byte = [0_u8; 1];
            while !head.ends_with(b"\r\n\r\n") && matches!(stream.read(&mut byte), Ok(1)) {
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).into_owned();
            let path = head.split_whitespace().nth(1).unwrap_or("?").to_owned();
            seen.lock().unwrap().push(path);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{package}",
                package.len()
            );
            let _ = stream.flush();
        }
    });
    (address, asked)
}

fn list_below(root: &Path, dir: &Path, found: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let rel = path.strip_prefix(root).unwrap().to_string_lossy();
        found.push(rel.replace('\\', "/"));
        if path.is_dir() {
            list_below(root, &path, found);
        }
    }
}

struct Outcome {
    /// What the child printed.
    stdout: String,
    /// The request paths the local catalog was asked for.
    asked: Vec<String>,
    /// Every folder and file in the temp folder after the child ended.
    tree: Vec<String>,
}

/// Runs the child once for the skill id `id` and reports what it did.
fn install_in_child(id: &str) -> Outcome {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // Three levels deep: on the code before the fix a tail of `..` writes one
    // level up, which is still inside the temp folder.
    let skills = root.join("tcw2-a").join("tcw2-b").join("tcw2-skills");
    let jail = root.join("tcw2-jail");
    std::fs::create_dir_all(&skills).unwrap();
    std::fs::create_dir_all(&jail).unwrap();
    let (catalog, asked) = local_catalog();
    let module = module_path!().split_once("::").expect("a module path").1;
    let child = format!("{module}::tcw2_child_installs_in_its_jail");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([child.as_str(), "--exact", "--ignored", "--nocapture"])
        .env(CATALOG_ENV, &catalog)
        .env(ID_ENV, id)
        .env("RYU_SKILLS_DIR", &skills)
        .env("RYU_SKILLS_ACTIVE_FILE", root.join("tcw2-active.json"))
        .env("RYU_DIR", root.join("tcw2-data"))
        .current_dir(&jail)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut tree = Vec::new();
    list_below(root, root, &mut tree);
    tree.sort();
    let asked = asked.lock().unwrap().clone();
    println!("TCW2 id {id:?} asked {asked:?} tree {tree:?}\n{stdout}");
    assert!(
        output.status.success() && stdout.contains(RESULT),
        "the child did not run to its end: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Outcome {
        stdout,
        asked,
        tree,
    }
}

/// One refused case: the id tail is named in the refusal, the catalog was asked
/// for nothing, and nothing was created anywhere in the temp folder.
fn assert_refused(tail: &str) {
    let outcome = install_in_child(&format!("tcw2-owner/tcw2-repo/{tail}"));
    let refusal = format!("{RESULT} error skill id tail '{tail}' is refused");
    assert!(
        outcome.stdout.contains(&refusal),
        "{tail:?} was not refused: {}",
        outcome.stdout
    );
    assert!(
        outcome.asked.is_empty(),
        "{tail:?} was asked from the catalog: {:?}",
        outcome.asked
    );
    assert_eq!(outcome.tree, UNTOUCHED, "{tail:?} left something behind");
}

/// A drive letter with no volume behind it. Panics, never skips, if none is free.
#[cfg(windows)]
fn unused_drive_letter() -> char {
    ('G'..='Z')
        .rev()
        .find(|letter| !Path::new(&format!("{letter}:\\")).exists())
        .expect("no free drive letter from Z down to G, so this test cannot run safely")
}

/// The drive letter of `root` itself. Panics, never skips, if it has none.
#[cfg(windows)]
fn drive_letter_of(root: &Path) -> char {
    use std::path::{Component, Prefix};
    match root.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter as char,
            other => panic!("the temp folder has no drive letter: {other:?}"),
        },
        _ => panic!("the temp folder {root:?} has no drive letter"),
    }
}

// On Windows a tail such as `Q:tcw2x` is a drive-relative path: joined onto the
// skills folder it drops that folder. The letter has no volume behind it, so
// the code before the fix cannot write anything with it either.
#[cfg(windows)]
#[test]
fn a_drive_form_tail_is_refused_before_any_request() {
    let letter = unused_drive_letter();
    for tail in [
        format!("{letter}:tcw2x"),
        format!("{letter}:"),
        format!("{letter}:.."),
    ] {
        assert_refused(&tail);
    }
}

// The same with the drive letter of the temp folder itself. The child's current
// folder is `tcw2-jail` inside the temp folder, so on the code before the fix
// the skill lands in `tcw2-jail/tcw2x`, not in the skills folder.
#[cfg(windows)]
#[test]
fn a_drive_form_tail_stays_out_of_the_current_folder() {
    let letter = drive_letter_of(&std::env::temp_dir());
    assert_refused(&format!("{letter}:tcw2x"));
}

// A colon that is not a drive form (a stream form on Windows).
#[cfg(windows)]
#[test]
fn a_colon_tail_is_refused_on_windows_before_any_request() {
    assert_refused("react:tcw2");
}

#[test]
fn a_dot_or_dot_dot_tail_is_refused_before_any_request() {
    for tail in ["..", "."] {
        assert_refused(tail);
    }
}

// The folder name must be the same text as the name asked from the catalog. The
// download asks for the whole third part of the id, and the folder used to be
// the text after the LAST slash: `x/..` asked for `x/..` and wrote into the
// parent of the skills folder, `x/` wrote into the skills folder itself.
#[test]
fn a_third_part_that_holds_a_slash_is_refused_before_any_request() {
    for tail in ["tcw2x/..", "tcw2x/", "tcw2x/tcw2y"] {
        assert_refused(tail);
    }
}

#[test]
fn an_ordinary_id_still_installs() {
    let outcome = install_in_child("tcw2-owner/tcw2-repo/tcw2-skill");
    let installed = format!("{RESULT} installed tcw2-skill");
    assert!(outcome.stdout.contains(&installed), "{}", outcome.stdout);
    assert_eq!(
        outcome.asked,
        ["/api/download/tcw2-owner/tcw2-repo/tcw2-skill"]
    );
    for file in ["SKILL.md", "notes/tcw2-note.txt"] {
        let path = format!("tcw2-a/tcw2-b/tcw2-skills/tcw2-skill/{file}");
        assert!(outcome.tree.contains(&path), "{path} is missing");
    }
    let in_jail = |path: &String| path.starts_with("tcw2-jail/");
    assert!(!outcome.tree.iter().any(in_jail), "{:?}", outcome.tree);
    if !cfg!(windows) {
        // Off Windows a colon is an ordinary character in a folder name.
        let outcome = install_in_child("tcw2-owner/tcw2-repo/react:tcw2");
        let installed = format!("{RESULT} installed react:tcw2");
        assert!(outcome.stdout.contains(&installed), "{}", outcome.stdout);
    }
}
