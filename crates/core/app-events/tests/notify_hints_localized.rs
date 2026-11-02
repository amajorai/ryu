//! Guard: an app satellite raises its Inbox, toast and push notices with
//! `NotifyHint::localized`, never an English-only `NotifyHint::info`, so Core
//! can render them in each recipient's language. Copy lives in the app's
//! `backend/src/fanout_messages.rs` as `*_MESSAGE` templates the i18n
//! extractor catalogs.
//!
//! Skipped when the crate is built outside the monorepo (no `apps-store`).

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "tests") {
                continue;
            }
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn is_test_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name == "tests.rs" || name.ends_with("_test.rs") || name.ends_with("_tests.rs")
}

#[test]
fn satellites_raise_only_localized_notify_hints() {
    let apps_store = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../apps-store");
    let Ok(apps) = std::fs::read_dir(&apps_store) else {
        return;
    };
    let mut files = Vec::new();
    for app in apps.flatten() {
        for part in ["backend/src", "sidecar/src"] {
            rust_files(&app.path().join(part), &mut files);
        }
    }
    let mut offenders = Vec::new();
    for path in files.iter().filter(|path| !is_test_file(path)) {
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        let production = source.split("#[cfg(test)]").next().unwrap_or("");
        if production.contains("NotifyHint::info(") {
            offenders.push(path.display().to_string());
        }
    }
    assert!(
        offenders.is_empty(),
        "raise satellite notices with NotifyHint::localized and `*_MESSAGE` templates in \
         backend/src/fanout_messages.rs, not English-only NotifyHint::info: {offenders:#?}"
    );
}
