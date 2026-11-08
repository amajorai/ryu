//! The credential verbs: `browser.fill_credential` and
//! `browser.list_credentials` are canonical machine verbs with closed schemas,
//! listed for session Boxes and named in cloud-task turns, and no Core string
//! names a satellite tool for them.

use super::*;
use crate::agent_execution::{classify_tool_with_metadata, ToolEffect};
use crate::sidecar::mcp::box_desktop::{cloud_machine_tool_name, cloud_machine_verb};

const FILL: &str = "browser.fill_credential";
const LIST: &str = "browser.list_credentials";

#[test]
fn both_credential_verbs_are_browser_machine_verbs() {
    for id in [FILL, LIST] {
        let verb = verb_by_id(id).unwrap_or_else(|| panic!("{id} is a verb"));
        assert_eq!(verb.server, SERVER_BROWSER);
        assert_eq!(verb.capability, CAP_BROWSER);
        assert!(is_machine_verb(id), "{id}");
    }
}

#[test]
fn the_credential_schemas_are_closed() {
    let fill = (verb_by_id(FILL).unwrap().schema)();
    assert_eq!(fill["additionalProperties"], json!(false));
    assert_eq!(fill["required"], json!(["account", "field", "ref"]));
    assert_eq!(
        fill["properties"]["field"]["enum"],
        json!(["username", "email", "password", "totp"])
    );
    let names: Vec<&String> = fill["properties"].as_object().unwrap().keys().collect();
    assert_eq!(names.len(), 5, "{names:?}");
    for forbidden in ["value", "password", "secret", "box_id", "url", "page_url"] {
        assert!(fill["properties"].get(forbidden).is_none(), "{forbidden}");
    }
    let list = (verb_by_id(LIST).unwrap().schema)();
    assert_eq!(list["additionalProperties"], json!(false));
    assert!(list["properties"].as_object().unwrap().is_empty());
}

#[test]
fn filling_is_a_mutation_and_listing_a_read() {
    assert_eq!(
        classify_tool_with_metadata(FILL, verb_annotations(FILL).as_ref(), None),
        ToolEffect::Mutate
    );
    assert_eq!(
        classify_tool_with_metadata(LIST, verb_annotations(LIST).as_ref(), None),
        ToolEffect::Read
    );
    assert_eq!(verb_annotations(FILL).unwrap()["openWorldHint"], true);
    assert_eq!(verb_annotations(LIST).unwrap()["openWorldHint"], false);
}

#[test]
fn session_boxes_list_both_and_cloud_turns_name_them() {
    let listed: Vec<String> = session_box_tools(&[]).into_iter().map(|t| t.id).collect();
    for id in [FILL, LIST] {
        assert!(listed.iter().any(|tool| tool == id), "{id}");
        let name = cloud_machine_tool_name(id);
        assert_eq!(cloud_machine_verb(&name), Some(id));
    }
    assert_eq!(
        cloud_machine_verb("box_browser_fill_credential"),
        Some(FILL)
    );
    assert_eq!(
        cloud_machine_verb("box_browser_list_credentials"),
        Some(LIST)
    );
}

#[test]
fn no_core_string_names_a_satellite_tool() {
    // The node's browser satellite maps the verbs in its own manifest; Core's
    // facade names capabilities only.
    for source in [
        include_str!("../../capability_tools.rs"),
        include_str!("../defaults.rs"),
        include_str!("../mapping.rs"),
        include_str!("../resolve.rs"),
        include_str!("../schemas.rs"),
        include_str!("../schemas_machine.rs"),
        include_str!("../table.rs"),
    ] {
        let needle = format!("{}.", "chromium");
        assert!(
            !source.contains(&needle),
            "a Core facade file names {needle}"
        );
    }
}
