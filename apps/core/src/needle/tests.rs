use std::collections::HashMap;

use ryu_tool_registry::ToolKind;
use serde_json::json;

use super::install;
use super::library::{schemas_for, selected_ids};
use super::test_support;

#[test]
fn selection_maps_only_known_aliases_and_allows_refusal() {
    let aliases = HashMap::from([("ryu_candidate_0".to_owned(), "exa.search".to_owned())]);
    assert_eq!(
        selected_ids(
            "Needle",
            &json!({ "type": "refuse", "function_calls": [] }),
            &aliases
        )
        .expect("refusal"),
        Vec::<String>::new()
    );
    assert_eq!(
        selected_ids(
            "Needle",
            &json!({
                "type": "call",
                "function_calls": [{ "name": "ryu_candidate_0", "arguments": {} }]
            }),
            &aliases,
        )
        .expect("known alias"),
        vec!["exa.search"]
    );
    assert!(selected_ids(
        "Needle",
        &json!({ "function_calls": [{ "name": "unknown", "arguments": {} }] }),
        &aliases,
    )
    .is_err());
}

#[test]
fn schemas_mark_skills_as_loadable_capabilities() {
    let candidate = test_support::descriptor(
        "skills.web",
        "Web research",
        "Research the web",
        ToolKind::Skill,
        &[],
    );
    let schemas = schemas_for(&[candidate]).expect("schema");
    assert_eq!(schemas[0]["x-ryu-id"], "skills.web");
    assert!(schemas[0]["description"]
        .as_str()
        .expect("description")
        .contains("Agent Skill"));
}

fn wheel_with(member: &str, bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(member, zip::write::SimpleFileOptions::default())
        .expect("start wheel member");
    zip.write_all(bytes).expect("write wheel member");
    zip.finish().expect("finish wheel").into_inner()
}

#[test]
fn extract_library_installs_only_the_named_wheel_member() {
    let dir = std::env::temp_dir().join(format!("ryu-needle-extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let wheel = dir.join("cactus_needle.whl");
    std::fs::write(&wheel, wheel_with("needle/libneedle.so", b"native-bytes")).expect("wheel");
    let library = dir.join("engine").join(install::library_name());

    install::extract_library("Needle", "needle", &wheel, &library, "needle/libneedle.so")
        .expect("extract the library");
    assert_eq!(std::fs::read(&library).expect("installed"), b"native-bytes");
    // Only the library lands in the engine dir: no staging file is left beside it.
    let leftovers: Vec<_> = std::fs::read_dir(library.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");

    let missing = install::extract_library("Needle", "needle", &wheel, &library, "needle/other.so")
        .expect_err("a missing member is an error");
    assert!(missing.contains("needle/other.so"), "{missing}");
    let _ = std::fs::remove_dir_all(&dir);
}
