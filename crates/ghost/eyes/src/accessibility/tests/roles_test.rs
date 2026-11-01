use super::super::roles::*;

#[test]
fn uia_control_type_table() {
    let cases = [
        (50000, "button"),
        (50002, "checkbox"),
        (50003, "combobox"),
        (50004, "textfield"),
        (50005, "link"),
        (50006, "image"),
        (50007, "listitem"),
        (50008, "list"),
        (50009, "menu"),
        (50010, "menubar"),
        (50011, "menuitem"),
        (50012, "progressbar"),
        (50013, "radiobutton"),
        (50014, "scrollbar"),
        (50015, "slider"),
        (50016, "spinbutton"),
        (50018, "tablist"),
        (50019, "tab"),
        (50020, "statictext"),
        (50021, "toolbar"),
        (50023, "tree"),
        (50024, "treeitem"),
        (50026, "group"),
        (50028, "table"),
        (50029, "row"),
        (50030, "document"),
        (50031, "button"),
        (50032, "window"),
        (50033, "pane"),
        (50036, "table"),
        (50025, "other"),
        (49999, "other"),
        (50041, "other"),
    ];
    for (id, key) in cases {
        assert_eq!(role_key_from_uia(id), key, "control type {id}");
    }
}

#[test]
fn ax_roles_and_subroles() {
    assert_eq!(role_key_from_ax("AXButton", None), "button");
    assert_eq!(role_key_from_ax("AXSecureTextField", None), "textfield");
    assert_eq!(
        role_key_from_ax("AXTextField", Some("AXSecureTextField")),
        "textfield"
    );
    assert_eq!(role_key_from_ax("AXTextArea", None), "textarea");
    assert_eq!(role_key_from_ax("AXCheckBox", Some("AXSwitch")), "switch");
    assert_eq!(role_key_from_ax("AXCheckBox", None), "checkbox");
    assert_eq!(
        role_key_from_ax("AXButton", Some("AXToggleButton")),
        "togglebutton"
    );
    assert_eq!(
        role_key_from_ax("AXRadioButton", Some("AXTabButton")),
        "tab"
    );
    assert_eq!(role_key_from_ax("AXRow", Some("AXOutlineRow")), "treeitem");
    assert_eq!(
        role_key_from_ax("AXButton", Some("AXCloseButton")),
        "button"
    );
    assert_eq!(role_key_from_ax("AXPopUpButton", None), "popupbutton");
    assert_eq!(role_key_from_ax("AXWebArea", None), "webarea");
    assert_eq!(role_key_from_ax("AXDisclosureTriangle", None), "disclosure");
    // Unknown roles: "AX" stripped, lowercased.
    assert_eq!(role_key_from_ax("AXFancyWidget", None), "fancywidget");
    assert_eq!(
        role_key_from_ax("AXButton", Some("AXUnknownSubrole")),
        "button"
    );
}

#[test]
fn atspi_roles_and_secure() {
    assert_eq!(role_key_from_atspi("passwordtext", false), "textfield");
    assert!(is_secure_atspi("passwordtext"));
    assert!(!is_secure_atspi("text"));
    assert_eq!(role_key_from_atspi("pushbutton", false), "button");
    assert_eq!(role_key_from_atspi("button", false), "button");
    assert_eq!(role_key_from_atspi("text", true), "textfield");
    assert_eq!(role_key_from_atspi("text", false), "statictext");
    assert_eq!(role_key_from_atspi("entry", false), "textfield");
    assert_eq!(role_key_from_atspi("pagetab", false), "tab");
    assert_eq!(role_key_from_atspi("tablecell", false), "cell");
    assert_eq!(role_key_from_atspi("frame", false), "window");
    assert_eq!(role_key_from_atspi("documentweb", false), "webarea");
    assert_eq!(role_key_from_atspi("somethingnew", false), "other");
}

#[test]
fn secure_detection() {
    assert!(is_secure_ax("AXSecureTextField", None));
    assert!(is_secure_ax("AXTextField", Some("AXSecureTextField")));
    assert!(!is_secure_ax("AXTextField", None));
    assert!(is_secure_uia(None, "textfield"));
    assert!(is_secure_uia(Some(true), "button"));
    assert!(!is_secure_uia(Some(false), "textfield"));
    assert!(!is_secure_uia(None, "button"));
}

#[test]
fn legacy_role_normalization() {
    assert_eq!(normalize_legacy_role("pushbutton"), "button");
    assert_eq!(normalize_legacy_role("AXButton"), "button");
    assert_eq!(normalize_legacy_role("check box"), "checkbox");
    assert_eq!(normalize_legacy_role("Page Tab"), "tab");
    assert_eq!(normalize_legacy_role("Edit"), "edit");
    assert_eq!(normalize_legacy_role("frame"), "window");
}

#[test]
fn role_classes() {
    assert!(is_mutable_value_role("slider"));
    assert!(is_mutable_value_role("textfield"));
    assert!(!is_mutable_value_role("button"));
    assert!(is_editable_role("combobox"));
    assert!(!is_editable_role("checkbox"));
    assert!(is_actionable_role("link"));
    assert!(!is_actionable_role("statictext"));
}
