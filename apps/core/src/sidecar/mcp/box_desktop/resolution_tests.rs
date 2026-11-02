//! Tests for the cloud-task machine verb names in [`super`].

use super::*;

#[test]
fn every_machine_verb_round_trips_through_its_cloud_tool_name() {
    let machine_verbs: Vec<&str> = capability_tools::verbs()
        .iter()
        .filter(|verb| capability_tools::is_machine_verb(verb.id))
        .map(|verb| verb.id)
        .collect();
    assert!(machine_verbs.contains(&"computer.click"));
    for verb in machine_verbs {
        let name = cloud_machine_tool_name(verb);
        assert!(
            !name.contains('.'),
            "function names cannot hold a dot: {name}"
        );
        assert_eq!(cloud_machine_verb(&name), Some(verb));
    }
}

#[test]
fn names_outside_the_box_prefix_or_the_machine_verbs_are_not_verbs() {
    assert_eq!(
        cloud_machine_tool_name("computer.click"),
        "box_computer_click"
    );
    assert_eq!(cloud_machine_verb("computer_click"), None);
    assert_eq!(cloud_machine_verb("box_cloud_files_list"), None);
    assert_eq!(cloud_machine_verb("box_memory_search"), None);
}
