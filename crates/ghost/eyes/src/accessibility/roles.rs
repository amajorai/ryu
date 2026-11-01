// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Canonical role vocabulary shared by every backend.
//!
//! Keys: button togglebutton checkbox radiobutton switch combobox popupbutton
//! textfield textarea link menuitem menu menubar tab tablist list listitem tree
//! treeitem table row cell slider scrollbar spinbutton progressbar disclosure
//! statictext image group window toolbar webarea document pane other.
//! macOS roles outside the table fall back to the role with "AX" stripped, lowercased.

/// macOS AXRole (+ AXSubrole) to a canonical key.
pub fn role_key_from_ax(role: &str, subrole: Option<&str>) -> String {
    if let Some(key) = subrole.and_then(|s| ax_subrole_key(role, s)) {
        return key.to_string();
    }
    ax_role_key(role).map_or_else(
        || role.strip_prefix("AX").unwrap_or(role).to_lowercase(),
        str::to_string,
    )
}

fn ax_subrole_key(role: &str, subrole: &str) -> Option<&'static str> {
    let key = match subrole {
        "AXSwitch" | "AXToggle" => "switch",
        "AXToggleButton" => ax_role_key(role)
            .filter(|k| matches!(*k, "checkbox" | "switch" | "radiobutton"))
            .unwrap_or("togglebutton"),
        "AXTabButton" => "tab",
        "AXOutlineRow" => "treeitem",
        "AXTableRow" => "row",
        "AXSecureTextField" | "AXSearchField" => "textfield",
        "AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXToolbarButton"
        | "AXFullScreenButton" | "AXSortButton" => "button",
        "AXContentList" | "AXDefinitionList" | "AXDescriptionList" => "list",
        _ => return None,
    };
    Some(key)
}

fn ax_role_key(role: &str) -> Option<&'static str> {
    let key = match role {
        "AXButton" => "button",
        "AXPopUpButton" | "AXMenuButton" => "popupbutton",
        "AXComboBox" => "combobox",
        "AXTextField" | "AXSecureTextField" | "AXSearchField" => "textfield",
        "AXTextArea" => "textarea",
        "AXCheckBox" => "checkbox",
        "AXRadioButton" => "radiobutton",
        "AXSwitch" | "AXToggle" => "switch",
        "AXLink" => "link",
        "AXMenuItem" | "AXMenuBarItem" => "menuitem",
        "AXMenu" => "menu",
        "AXMenuBar" => "menubar",
        "AXTabGroup" => "tablist",
        "AXList" => "list",
        "AXOutline" => "tree",
        "AXTable" | "AXGrid" => "table",
        "AXRow" => "row",
        "AXCell" => "cell",
        "AXSlider" => "slider",
        "AXScrollBar" => "scrollbar",
        "AXIncrementor" | "AXStepper" => "spinbutton",
        "AXProgressIndicator" | "AXBusyIndicator" | "AXLevelIndicator" => "progressbar",
        "AXDisclosureTriangle" => "disclosure",
        "AXStaticText" | "AXHeading" => "statictext",
        "AXImage" => "image",
        "AXGroup" | "AXGenericElement" | "AXSplitGroup" | "AXRadioGroup" => "group",
        "AXWindow" | "AXSheet" | "AXDrawer" | "AXDialog" => "window",
        "AXToolbar" => "toolbar",
        "AXWebArea" => "webarea",
        "AXDocument" => "document",
        "AXScrollArea" | "AXLayoutArea" => "pane",
        _ => return None,
    };
    Some(key)
}

/// UIA `ControlTypeId` (50000..=50040) to a canonical key; unknown ids are "other".
pub fn role_key_from_uia(control_type_id: i32) -> String {
    let key = match control_type_id {
        50000 | 50031 => "button",        // Button, SplitButton
        50002 => "checkbox",              // CheckBox
        50003 => "combobox",              // ComboBox
        50004 => "textfield",             // Edit
        50005 => "link",                  // Hyperlink
        50006 => "image",                 // Image
        50007 => "listitem",              // ListItem
        50008 => "list",                  // List
        50009 => "menu",                  // Menu
        50010 => "menubar",               // MenuBar
        50011 => "menuitem",              // MenuItem
        50012 => "progressbar",           // ProgressBar
        50013 => "radiobutton",           // RadioButton
        50014 => "scrollbar",             // ScrollBar
        50015 => "slider",                // Slider
        50016 => "spinbutton",            // Spinner
        50018 => "tablist",               // Tab
        50019 => "tab",                   // TabItem
        50020 => "statictext",            // Text
        50021 | 50040 => "toolbar",       // ToolBar, AppBar
        50023 => "tree",                  // Tree
        50024 => "treeitem",              // TreeItem
        50017 | 50026 | 50034 => "group", // StatusBar, Group, Header
        50028 | 50036 => "table",         // DataGrid, Table
        50029 => "row",                   // DataItem
        50030 => "document",              // Document
        50032 => "window",                // Window
        50033 => "pane",                  // Pane
        50035 => "cell",                  // HeaderItem
        // Calendar, ToolTip, Custom, Thumb, TitleBar, Separator, SemanticZoom, unknown.
        _ => "other",
    };
    key.to_string()
}

/// AT-SPI role (lowercased `Debug` spelling) to a canonical key; unknown roles are "other".
pub fn role_key_from_atspi(role_debug_lower: &str, editable: bool) -> String {
    atspi_role_key(role_debug_lower, editable)
        .unwrap_or("other")
        .to_string()
}

fn atspi_role_key(role: &str, editable: bool) -> Option<&'static str> {
    let key = match role {
        "button" | "pushbutton" => "button",
        "togglebutton" => "togglebutton",
        "checkbox" => "checkbox",
        "radiobutton" => "radiobutton",
        "switch" => "switch",
        "combobox" => "combobox",
        "pushbuttonmenu" => "popupbutton",
        "passwordtext" | "entry" => "textfield",
        "text" if editable => "textfield",
        "text" | "label" | "static" | "caption" | "heading" | "paragraph" => "statictext",
        "link" => "link",
        "menuitem" | "checkmenuitem" | "radiomenuitem" | "tearoffmenuitem" => "menuitem",
        "menu" | "popupmenu" => "menu",
        "menubar" => "menubar",
        "pagetab" => "tab",
        "pagetablist" => "tablist",
        "list" | "listbox" => "list",
        "listitem" => "listitem",
        "tree" | "treetable" => "tree",
        "treeitem" => "treeitem",
        "table" => "table",
        "tablerow" => "row",
        "tablecell" | "columnheader" | "rowheader" | "tablecolumnheader" | "tablerowheader" => {
            "cell"
        }
        "slider" => "slider",
        "scrollbar" => "scrollbar",
        "spinbutton" => "spinbutton",
        "progressbar" | "levelbar" => "progressbar",
        "image" | "icon" => "image",
        "panel" | "grouping" | "section" | "filler" | "form" | "landmark" | "blockquote"
        | "article" => "group",
        "frame" | "window" | "dialog" | "alert" | "internalframe" => "window",
        "toolbar" => "toolbar",
        "documentweb" => "webarea",
        "documentframe"
        | "documenttext"
        | "documentspreadsheet"
        | "documentpresentation"
        | "documentemail" => "document",
        "scrollpane" | "splitpane" | "viewport" | "rootpane" | "layeredpane" | "glasspane"
        | "optionpane" | "directorypane" => "pane",
        _ => return None,
    };
    Some(key)
}

/// Legacy refs (stored without `role_key`): "AX…" strings go through
/// [`role_key_from_ax`]; otherwise lowercase + strip spaces and use the AT-SPI
/// table when it maps to a canonical key; otherwise that normalized string.
pub fn normalize_legacy_role(role: &str) -> String {
    if role.starts_with("AX") {
        return role_key_from_ax(role, None);
    }
    let squashed: String = role
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    match atspi_role_key(&squashed, false) {
        Some(key) => key.to_string(),
        None => squashed,
    }
}

/// Roles whose value changes in normal use (name == value must not pin identity).
pub fn is_mutable_value_role(role_key: &str) -> bool {
    matches!(
        role_key,
        "checkbox"
            | "radiobutton"
            | "switch"
            | "togglebutton"
            | "combobox"
            | "slider"
            | "scrollbar"
            | "spinbutton"
            | "progressbar"
            | "textfield"
            | "textarea"
            | "disclosure"
            | "list"
    )
}

/// Roles that accept typed text.
pub fn is_editable_role(role_key: &str) -> bool {
    matches!(role_key, "textfield" | "textarea" | "combobox")
}

/// Roles an agent may reasonably act on.
pub fn is_actionable_role(role_key: &str) -> bool {
    matches!(
        role_key,
        "button"
            | "togglebutton"
            | "checkbox"
            | "radiobutton"
            | "switch"
            | "combobox"
            | "popupbutton"
            | "link"
            | "menuitem"
            | "tab"
            | "listitem"
            | "treeitem"
            | "row"
            | "cell"
            | "slider"
            | "spinbutton"
            | "disclosure"
            | "textfield"
            | "textarea"
    )
}

/// macOS: either the role or the subrole is `AXSecureTextField`.
pub fn is_secure_ax(role: &str, subrole: Option<&str>) -> bool {
    role == "AXSecureTextField" || subrole == Some("AXSecureTextField")
}

/// Windows: `IsPassword`; when unknown, fail closed for editable roles.
pub fn is_secure_uia(is_password: Option<bool>, role_key: &str) -> bool {
    match is_password {
        Some(p) => p,
        None => is_editable_role(role_key),
    }
}

/// Linux: the `passwordtext` role.
pub fn is_secure_atspi(role_debug_lower: &str) -> bool {
    role_debug_lower == "passwordtext"
}
