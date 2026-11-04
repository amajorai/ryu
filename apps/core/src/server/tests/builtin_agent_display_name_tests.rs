use crate::server::builtin_agent_display_name;

#[test]
fn saved_name_overrides_the_registry_name() {
    assert_eq!(builtin_agent_display_name("Ryu", "Nova"), "Nova");
}

#[test]
fn blank_saved_name_keeps_the_registry_name() {
    assert_eq!(builtin_agent_display_name("Ryu", "  "), "Ryu");
}
