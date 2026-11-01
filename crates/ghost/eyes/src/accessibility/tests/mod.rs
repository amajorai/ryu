use super::*;

mod chain_test;
mod contract_test;
mod find_test;
mod resolve_test;
mod roles_test;
mod verify_test;
mod window_pick_test;

pub(super) fn node(role: &str, title: Option<&str>) -> AXTreeNode {
    AXTreeNode {
        role: role.to_string(),
        title: title.map(str::to_string),
        ..Default::default()
    }
}

pub(super) fn bounds(x: i32, y: i32) -> Bounds {
    Bounds {
        x,
        y,
        width: 10,
        height: 10,
    }
}

fn sample_node() -> AXTreeNode {
    AXTreeNode {
        role: "AXWindow".to_string(),
        title: Some("Editor".to_string()),
        identifier: Some("win-1".to_string()),
        bounds: Some(Bounds {
            x: 10,
            y: -5,
            width: 800,
            height: 600,
        }),
        children: vec![AXTreeNode {
            role: "AXButton".to_string(),
            title: Some("Save".to_string()),
            value: Some("enabled".to_string()),
            focused: true,
            ..Default::default()
        }],
        ..Default::default()
    }
}

#[test]
fn bounds_serde_roundtrip() {
    let b = Bounds {
        x: -100,
        y: 200,
        width: 1920,
        height: 1080,
    };
    let json = serde_json::to_string(&b).expect("serialize");
    let back: Bounds = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(b, back);
    // Field names are the wire contract consumers depend on.
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["x"], -100);
    assert_eq!(v["width"], 1920);
}

#[test]
fn axtreenode_serde_roundtrip_preserves_tree() {
    let node = sample_node();
    let json = serde_json::to_string(&node).expect("serialize");
    let back: AXTreeNode = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.role, "AXWindow");
    assert_eq!(back.title.as_deref(), Some("Editor"));
    assert!(back.value.is_none());
    assert_eq!(back.identifier.as_deref(), Some("win-1"));
    assert_eq!(back.bounds.unwrap().width, 800);
    assert_eq!(back.children.len(), 1);
    let child = &back.children[0];
    assert_eq!(child.role, "AXButton");
    assert!(child.focused);
    assert!(child.bounds.is_none());
}

#[test]
fn axtreenode_optional_fields_serialize_as_null() {
    let node = AXTreeNode {
        role: "AXUnknown".to_string(),
        enabled: false,
        hidden: true,
        ..Default::default()
    };
    let v = serde_json::to_value(&node).unwrap();
    assert!(v["title"].is_null());
    assert!(v["bounds"].is_null());
    assert_eq!(v["enabled"], false);
    assert_eq!(v["hidden"], true);
    assert!(v["children"].as_array().unwrap().is_empty());
}

#[test]
fn old_json_without_new_fields_deserializes() {
    let old = r#"{"role":"AXButton","title":"OK","value":null,"identifier":null,
        "bounds":null,"children":[]}"#;
    let n: AXTreeNode = serde_json::from_str(old).expect("legacy node");
    assert!(n.enabled, "enabled defaults to true");
    assert!(!n.focused && !n.hidden && !n.secure && !n.subtree_truncated);
    assert!(n.role_key.is_none() && n.subrole.is_none() && n.native_id.is_none());
    assert!(n.states.is_none());
    assert_eq!(n.stable_role(), "button");
}

#[test]
fn default_node_serializes_without_new_keys() {
    let v = serde_json::to_value(AXTreeNode::default()).unwrap();
    let obj = v.as_object().unwrap();
    for key in [
        "subrole",
        "role_key",
        "native_id",
        "secure",
        "subtree_truncated",
        "states",
    ] {
        assert!(!obj.contains_key(key), "unexpected key {key}");
    }
    for key in [
        "role",
        "title",
        "value",
        "identifier",
        "bounds",
        "children",
        "enabled",
        "focused",
        "hidden",
    ] {
        assert!(obj.contains_key(key), "missing legacy key {key}");
    }
    assert_eq!(v["enabled"], true);
}

#[test]
fn secure_node_serializes_value_null_and_never_leaks() {
    let mut n = AXTreeNode {
        role: "AXSecureTextField".to_string(),
        value: Some("hunter2-secret".to_string()),
        secure: true,
        states: Some(ElementState {
            value: Some("hunter2-secret".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };
    n.redact();
    let json = serde_json::to_string(&n).unwrap();
    assert!(!json.contains("hunter2-secret"), "secret leaked: {json}");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(v["value"].is_null());
    assert_eq!(v["secure"], true);
    assert_eq!(v["states"]["secure"], true);
}

#[test]
fn redact_leaves_non_secure_values() {
    let mut n = node("AXTextField", None);
    n.value = Some("visible".to_string());
    n.redact();
    assert_eq!(n.value.as_deref(), Some("visible"));
}

#[test]
fn stable_role_prefers_role_key() {
    let mut n = node("Schaltfläche", None);
    n.role_key = Some("button".to_string());
    assert_eq!(n.stable_role(), "button");
}

#[test]
fn snapshots_from_same_options_each_get_a_full_budget() {
    use std::time::{Duration, Instant};
    let opts = SnapshotOptions {
        limits: WalkLimits::platform_default().with_budget(Duration::from_millis(200)),
        ..Default::default()
    };
    let first = limits::WalkBudget::start(opts.limits);
    std::thread::sleep(Duration::from_millis(50));
    let before_second = Instant::now();
    let second = limits::WalkBudget::start(opts.limits);
    assert!(second.deadline >= before_second + Duration::from_millis(200));
    assert!(second.deadline > first.deadline);
    assert!(second.exhausted().is_none());
}

#[test]
fn walk_budget_reports_node_budget_and_marks_truncation() {
    let limits = WalkLimits {
        max_nodes: 2,
        ..WalkLimits::platform_default()
    };
    let mut budget = limits::WalkBudget::start(limits);
    budget.visit();
    assert!(budget.exhausted().is_none());
    budget.visit();
    let cause = budget.exhausted().expect("node budget");
    let mut n = node("AXGroup", None);
    budget.truncate(&mut n, cause);
    budget.truncate(&mut n, cause);
    assert!(n.subtree_truncated);
    assert_eq!(budget.stats.truncated_nodes, 1);
    assert!(budget.stats.node_budget_hit);
    assert!(!budget.stats.complete());
}

#[test]
fn limits_defaults_preserve_depths() {
    let d = WalkLimits::platform_default();
    assert_eq!((d.max_children, d.max_nodes), (100, 5000));
    assert!(d.read_values);
    let p = WalkLimits::passive();
    assert_eq!(p.max_nodes, 1500);
    assert!(!p.read_values);
    if cfg!(target_os = "linux") {
        assert_eq!(d.max_depth, 6);
        assert_eq!((p.max_depth, p.max_children), (6, 100));
    }
}

#[test]
fn element_action_parse_and_names() {
    for name in [
        "press",
        "focus",
        "toggle",
        "check",
        "uncheck",
        "expand",
        "collapse",
        "select",
        "scroll_into_view",
        "show_menu",
    ] {
        let a = ElementAction::parse(name, None).expect(name);
        assert_eq!(a.name(), name);
    }
    let sv = ElementAction::parse("set_value", Some("x")).unwrap();
    assert_eq!(sv, ElementAction::SetValue("x".to_string()));
    assert!(sv.is_stateful());
    assert!(!ElementAction::Press.is_stateful());
    let err = ElementAction::parse("set_value", None).unwrap_err();
    assert_eq!(err.code, crate::contract::ErrorCode::InvalidArgs);
    let err = ElementAction::parse("explode", None).unwrap_err();
    assert_eq!(err.code, crate::contract::ErrorCode::InvalidArgs);
}

#[test]
fn identity_drops_name_mirroring_value() {
    let id = ElementIdentity::from_parts("slider", Some("50"), Some("50.0"), None, None, None);
    assert!(id.name.is_none());
    let id = ElementIdentity::from_parts("button", Some("50"), Some("50"), None, None, None);
    assert_eq!(id.name.as_deref(), Some("50"));
    assert!(ElementIdentity::from_parts("group", None, None, None, None, None).is_anonymous());
}

#[derive(Default)]
struct StubTree;

#[async_trait]
impl AXTree for StubTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        Ok(sample_node())
    }
    async fn find_element(&self, _d: &str) -> Option<AXTreeNode> {
        None
    }
    async fn element_at(&self, _x: i32, _y: i32) -> Option<AXTreeNode> {
        None
    }
    async fn list_apps(&self) -> Vec<serde_json::Value> {
        vec![]
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(f)
}

#[test]
fn trait_defaults_wrap_focused_tree_and_refuse_the_rest() {
    let tree = StubTree;
    let snap = block_on(tree.snapshot(SnapshotOptions::default())).expect("snapshot");
    assert_eq!(snap.pid, 0);
    assert!(!snap.complete);
    assert_eq!(snap.stats.nodes, 2);
    assert_eq!(snap.window_title.as_deref(), Some("Editor"));
    let opts = SnapshotOptions {
        target: WindowTarget::Pid { pid: 42 },
        ..Default::default()
    };
    let err = block_on(tree.snapshot(opts)).unwrap_err();
    assert_eq!(err.code, crate::contract::ErrorCode::PlatformNotSupported);
    let locator = ElementLocator {
        pid: 0,
        window: WindowTarget::Focused,
        path: vec![0],
        identity: ElementIdentity::default(),
    };
    let err = block_on(tree.resolve(&locator, std::time::Duration::from_secs(1))).unwrap_err();
    assert_eq!(err.code, crate::contract::ErrorCode::PlatformNotSupported);
    let err = block_on(tree.perform(&locator, &ElementAction::Press, &ActionOptions::default()))
        .unwrap_err();
    assert_eq!(err.code, crate::contract::ErrorCode::PlatformNotSupported);
}

#[cfg(target_os = "macos")]
fn rt() -> tokio::runtime::Runtime {
    // The crate does not enable tokio's `macros` feature, so build a
    // current-thread runtime by hand. `spawn_blocking` (used by the impls)
    // is available on it without `rt-multi-thread`.
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
}

#[cfg(target_os = "macos")]
#[test]
fn macos_axtree_new_ok() {
    assert!(MacOSAXTree::new().is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_list_apps_shape() {
    // Reads NSWorkspace.runningApplications — not TCC-gated, no prompt.
    let tree = MacOSAXTree::new().unwrap();
    let apps = rt().block_on(async { tree.list_apps().await });
    // May be empty in a headless session; when populated every entry must
    // carry the {name, pid} contract callers serialize over the wire.
    for app in &apps {
        assert!(app.get("name").is_some(), "app missing name: {app}");
        assert!(app.get("pid").is_some(), "app missing pid: {app}");
        assert!(app["name"].is_string());
        assert!(app["pid"].is_i64() || app["pid"].is_u64());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_element_at_does_not_panic() {
    // `element_at` runs `walk_element`/`walk_ax_element` at depth 0..1 only —
    // bounded, and a plain AX query returns an error (never a TCC prompt)
    // when Accessibility is not granted. Some or None are both valid.
    let tree = MacOSAXTree::new().unwrap();
    let node = rt().block_on(async { tree.element_at(0, 0).await });
    if let Some(n) = node {
        assert!(!n.role.is_empty(), "a returned node must carry a role");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn accessibility_granted_returns_without_prompt() {
    // Pure checker (no kAXTrustedCheckOptionPrompt) — safe to call.
    let _granted: bool = accessibility_granted();
}
