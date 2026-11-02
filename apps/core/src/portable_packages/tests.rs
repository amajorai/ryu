use std::io::{Cursor, Write};

use serde_json::json;

use super::archive::{read_archive_file, safe_relative_path};
use super::{canonical_json, extract_archive, InstalledPackage};

fn archive_with(extra_name: &str) -> Vec<u8> {
    let manifest = json!({
        "schemaVersion": 1,
        "id": "demo-agent",
        "name": "Demo",
        "version": "1.0.0",
        "kind": "agent",
        "artifacts": ["agent.json"],
        "targets": [],
        "scopes": []
    });
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let entries = [
        ("ryu.package.json", serde_json::to_vec(&manifest).unwrap()),
        ("agent.json", b"{}".to_vec()),
        (extra_name, b"payload".to_vec()),
    ];
    for (name, bytes) in entries {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn canonical_json_sorts_object_keys_without_reordering_arrays() {
    let value = json!({ "z": 1, "a": { "b": true, "a": [2, 1] } });
    assert_eq!(
        canonical_json(&value),
        r#"{"a":{"a":[2,1],"b":true},"z":1}"#
    );
}

#[test]
fn archive_paths_are_flat_and_traversal_safe() {
    assert_eq!(
        safe_relative_path("nested\\file.json").unwrap(),
        "nested/file.json"
    );
    assert!(safe_relative_path("../file.json").is_err());
    assert!(safe_relative_path("nested//file.json").is_err());
    assert!(safe_relative_path("/absolute").is_err());
}

#[test]
fn archive_paths_reject_windows_prefixes_streams_and_devices() {
    for unsafe_path in [
        "C:/evil.txt",
        "c:evil.txt",
        "C:\\evil.txt",
        "dir/C:",
        "a/b:stream",
        "\\\\server\\share\\x",
        "skills/CON",
        "skills/nul.txt",
        "skills/a?b.md",
        "skills/a\u{0}b.md",
    ] {
        let error = safe_relative_path(unsafe_path).unwrap_err().to_string();
        assert!(error.contains("unsafe path"), "{unsafe_path}: {error}");
    }
    assert_eq!(safe_relative_path("skills/a.md").unwrap(), "skills/a.md");
    assert_eq!(
        safe_relative_path("skills/console.md").unwrap(),
        "skills/console.md"
    );
}

#[test]
fn extract_archive_refuses_drive_prefixed_entries() {
    assert!(extract_archive(&archive_with("notes/readme.md")).is_ok());
    for name in ["C:/evil.txt", "C:evil.txt", "C:\\evil.txt", "a/b:stream"] {
        let error = extract_archive(&archive_with(name))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unsafe path"), "{name}: {error}");
    }
}

#[test]
fn installed_package_runtime_ids_are_backward_compatible() {
    let record: InstalledPackage = serde_json::from_value(serde_json::json!({
        "id": "demo",
        "kind": "agent",
        "version": "1.0.0",
        "package_digest": "abc",
        "enabled": false,
        "installed_at_unix_ms": 1
    }))
    .expect("legacy install state should deserialize");
    assert!(record.runtime_ids.is_empty());
}

#[test]
fn archive_reader_enforces_actual_decompressed_bytes() {
    let mut entry = std::io::Cursor::new(vec![0u8; 10]);
    assert!(read_archive_file(&mut entry, "file.bin", 5)
        .unwrap_err()
        .to_string()
        .contains("total file limit"));
}
