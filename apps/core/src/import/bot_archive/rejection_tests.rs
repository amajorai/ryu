//! Every case that refuses a whole archive. Nothing is staged in any of them.

use std::io::Write;

use serde_json::json;

use super::stage::Limits;
use super::tests::{fixture, manifest_of, stage_bytes, zip_of};
use super::*;

/// Stage `bytes`, expect a refusal, and check that no staging folder is left.
fn refusal_with(bytes: &[u8], limits: &Limits) -> ArchiveError {
    let (temp, result) = stage_bytes(bytes, limits);
    let error = result.unwrap_err();
    let left = fs::read_dir(temp.path().join("staging"))
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(left, 0, "a refused archive left a staging folder: {error}");
    error
}

fn refusal(bytes: &[u8]) -> ArchiveError {
    refusal_with(bytes, &Limits::default())
}

/// A small valid archive plus one more entry named `name`.
fn fixture_plus(name: &str) -> Vec<u8> {
    let manifest = manifest_of(json!([{ "key": "a" }]));
    zip_of(&[
        (MANIFEST_FILE, &manifest),
        ("bots/a/instructions.md", b"You help.\n"),
        (name, b"x"),
    ])
}

#[test]
fn an_absolute_path_refuses_the_archive() {
    for name in [
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "c:relative.txt",
        "\\\\server\\share\\x",
        "\\x",
    ] {
        assert!(
            matches!(refusal(&fixture_plus(name)), ArchiveError::AbsolutePath(_)),
            "{name}"
        );
    }
}

#[test]
fn a_parent_segment_refuses_the_archive() {
    for name in [
        "../outside.txt",
        "bots/a/files/../../../../outside.txt",
        "bots\\a\\files\\..\\..\\..\\outside.txt",
        "bots/a/files/..",
    ] {
        assert!(
            matches!(refusal(&fixture_plus(name)), ArchiveError::PathTraversal(_)),
            "{name}"
        );
    }
}

#[test]
fn a_control_character_in_a_name_refuses_the_archive() {
    let error = refusal(&fixture_plus("bots/a/files/line\nbreak.txt"));
    let ArchiveError::UnsafeName(shown) = &error else {
        panic!("{error}");
    };
    // The name is shown on one line.
    assert!(!shown.chars().any(char::is_control));
    assert!(!error.to_string().contains('\n'));
}

#[test]
fn a_symbolic_link_refuses_the_archive() {
    let manifest = manifest_of(json!([{ "key": "a" }]));
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file(MANIFEST_FILE, options).unwrap();
    writer.write_all(&manifest).unwrap();
    writer
        .add_symlink("bots/a/files/passwords", "/etc/passwd", options)
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    assert!(matches!(refusal(&bytes), ArchiveError::Symlink(_)));
}

/// Set the "encrypted" flag of every entry, in its local header and in the
/// central directory, the way an encrypting tool marks them.
fn flag_encrypted(mut bytes: Vec<u8>) -> Vec<u8> {
    for (signature, flags_at) in [(*b"PK\x03\x04", 6), (*b"PK\x01\x02", 8)] {
        let mut from = 0;
        loop {
            let found = bytes[from..]
                .windows(4)
                .position(|window| window == signature.as_slice());
            let Some(found) = found else {
                break;
            };
            bytes[from + found + flags_at] |= 1;
            from += found + 4;
        }
    }
    bytes
}

#[test]
fn an_encrypted_entry_refuses_the_archive() {
    let bytes = flag_encrypted(fixture_plus("bots/a/files/secret.txt"));
    assert!(matches!(refusal(&bytes), ArchiveError::Encrypted(_)));
}

#[test]
fn a_file_that_is_not_a_zip_is_refused() {
    assert!(matches!(
        refusal(b"this is not a zip"),
        ArchiveError::NotAZip(_)
    ));
    assert!(matches!(refusal(b""), ArchiveError::NotAZip(_)));
}

#[test]
fn sizes_and_counts_over_a_cap_refuse_the_archive() {
    let fixture = fixture();
    let with = |change: fn(&mut Limits)| {
        let mut limits = Limits::default();
        change(&mut limits);
        refusal_with(&fixture, &limits)
    };
    assert_eq!(
        with(|limits| limits.archive_bytes = 64),
        ArchiveError::ArchiveTooLarge
    );
    assert_eq!(
        with(|limits| limits.entries = 5),
        ArchiveError::TooManyEntries(11)
    );
    assert_eq!(
        with(|limits| limits.total_bytes = 60),
        ArchiveError::TotalTooLarge
    );
    assert_eq!(
        with(|limits| limits.file_entry_bytes = 3),
        ArchiveError::EntryTooLarge {
            name: "bots/research/files/notes/reading-list.md".to_string(),
            limit: 3
        }
    );
    assert_eq!(
        with(|limits| limits.conversation_entry_bytes = 10),
        ArchiveError::EntryTooLarge {
            name: "bots/research/conversations/first-chat.json".to_string(),
            limit: 10
        }
    );
    // The manifest is a text entry too.
    assert_eq!(
        with(|limits| limits.text_entry_bytes = 16),
        ArchiveError::EntryTooLarge {
            name: MANIFEST_FILE.to_string(),
            limit: 16
        }
    );
}

#[test]
fn a_small_zip_that_unpacks_large_is_refused_by_what_it_unpacks_to() {
    let manifest = manifest_of(json!([{ "key": "a" }]));
    let zeros = vec![0u8; 4 * 1024 * 1024];
    let bytes = zip_of(&[
        (MANIFEST_FILE, &manifest),
        ("bots/a/files/zeros.bin", &zeros),
    ]);
    assert!(bytes.len() < 64 * 1024, "{}", bytes.len());
    let limits = Limits {
        file_entry_bytes: 1024 * 1024,
        ..Limits::default()
    };
    assert_eq!(
        refusal_with(&bytes, &limits),
        ArchiveError::EntryTooLarge {
            name: "bots/a/files/zeros.bin".to_string(),
            limit: 1024 * 1024
        }
    );
    let limits = Limits {
        total_bytes: 1024 * 1024,
        ..Limits::default()
    };
    assert_eq!(refusal_with(&bytes, &limits), ArchiveError::TotalTooLarge);
}

#[test]
fn a_zip_without_a_manifest_at_its_top_level_is_refused() {
    let manifest = manifest_of(json!([{ "key": "a" }]));
    for bytes in [
        zip_of(&[("bots/a/instructions.md", b"You help.\n")]),
        zip_of(&[("export/ryu-export.json", &manifest)]),
        zip_of(&[("RYU-EXPORT.JSON", &manifest)]),
    ] {
        assert_eq!(refusal(&bytes), ArchiveError::MissingManifest);
    }
}

#[test]
fn a_manifest_that_is_not_this_format_is_refused() {
    let many: Vec<Value> = (0..=MAX_BOTS)
        .map(|index| json!({ "key": format!("bot-{index}") }))
        .collect();
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        b"[]".to_vec(),
        serde_json::to_vec(&json!({ "format": "other-export", "version": 1, "bots": [] })).unwrap(),
        serde_json::to_vec(&json!({ "format": FORMAT, "version": 2, "bots": [] })).unwrap(),
        serde_json::to_vec(&json!({ "format": FORMAT, "version": "1", "bots": [] })).unwrap(),
        serde_json::to_vec(&json!({ "format": FORMAT, "version": 1 })).unwrap(),
        manifest_of(json!([{ "name": "No key" }])),
        manifest_of(json!([{ "key": "../escape" }])),
        manifest_of(json!([{ "key": "a" }, { "key": "A" }])),
        manifest_of(json!(many)),
    ];
    for manifest in cases {
        let error = refusal(&zip_of(&[(MANIFEST_FILE, &manifest)]));
        assert!(
            matches!(error, ArchiveError::BadManifest(_)),
            "{}: {error}",
            String::from_utf8_lossy(&manifest)
        );
    }
    let empty = manifest_of(json!([]));
    assert_eq!(
        refusal(&zip_of(&[(MANIFEST_FILE, &empty)])),
        ArchiveError::NoBots
    );
}
