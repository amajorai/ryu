use anyhow::Result;
use serde_json::{json, Value};
use base64::Engine;

use ghost_eyes::{PlatformAXTree, PlatformWindowTracker, AXTree, WindowTracker, quick_screenshot, AXTreeNode};

use super::{bool_param, int_param, str_param};

pub async fn ghost_context(params: Value) -> Result<Value> {
    let _app = str_param(&params, "app");

    let tracker = PlatformWindowTracker::new()?;
    let win  = tracker.get_active_window().await;
    let ax   = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await.ok();

    let interactive = tree.as_ref().map(|t| collect_interactive(t, 0, 3)).unwrap_or_default();

    Ok(json!({
        "app":       win.as_ref().map(|w| w.app_name.as_str()),
        "bundle_id": win.as_ref().and_then(|w| w.bundle_id.as_deref()),
        "pid":       win.as_ref().map(|w| w.pid),
        "title":     win.as_ref().map(|w| w.title.as_str()),
        "url":       win.as_ref().and_then(|w| w.url.as_deref()),
        "focused_element": tree.as_ref().map(focused_element),
        "interactive_count": interactive.len(),
        "interactive": interactive,
        "suggestion": "Use ghost_find to locate specific elements, ghost_click to act."
    }))
}

pub async fn ghost_state(params: Value) -> Result<Value> {
    let app_filter = str_param(&params, "app");

    let tracker = PlatformWindowTracker::new()?;
    let active = tracker.get_active_window().await;
    let ax = PlatformAXTree::new()?;
    let apps = ax.list_apps().await;

    let windows: Vec<Value> = if let Some(win) = &active {
        if app_filter.map(|f| win.app_name.to_lowercase().contains(&f.to_lowercase())).unwrap_or(true) {
            vec![json!({
                "app":       win.app_name,
                "bundle_id": win.bundle_id,
                "title":     win.title,
                "url":       win.url,
                "pid":       win.pid,
                "focused":   true,
            })]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    Ok(json!({ "apps": apps, "windows": windows }))
}

pub async fn ghost_find(params: Value) -> Result<Value> {
    let query      = str_param(&params, "query");
    let role       = str_param(&params, "role");
    let dom_id     = str_param(&params, "dom_id");
    let identifier = str_param(&params, "identifier");
    let dom_class  = str_param(&params, "dom_class");
    let depth      = int_param(&params, "depth", 25).min(100) as u32;

    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await?;

    let q          = query.unwrap_or("").to_lowercase();
    let r          = role.unwrap_or("").to_lowercase();
    let dom_id_str = dom_id.unwrap_or("").to_lowercase();
    let id         = if let Some(ident) = identifier { ident.to_lowercase() } else { dom_id_str.clone() };
    let cls        = dom_class.unwrap_or("").to_lowercase();

    let mut results = vec![];
    find_elements(&tree, &q, &r, &id, &cls, depth, &mut results);

    // CDP fallback: if AX found nothing and Chrome debug port is open, try JS matching.
    // Also triggered when dom_class or dom_id is specified.
    if results.is_empty() && (!q.is_empty() || !cls.is_empty() || !dom_id_str.is_empty()) && ghost_core::cdp::is_available().await {
        // For dom_class, pass as a CSS selector (".className"); for dom_id pass "#id"
        let cdp_query = if !cls.is_empty() && q.is_empty() {
            format!(".{}", cls)
        } else if !dom_id_str.is_empty() && q.is_empty() {
            format!("#{}", dom_id_str)
        } else {
            query.unwrap_or("").to_string()
        };
        if let Ok(cdp_els) = ghost_core::cdp::find_elements(&cdp_query).await {
            for el in cdp_els {
                results.push(json!({
                    "role":   el.tag,
                    "title":  el.text,
                    "x":      el.center_x as i32,
                    "y":      el.center_y as i32,
                    "source": "cdp",
                    "match_type": el.match_type,
                }));
            }
        }
    }

    Ok(json!({
        "count":    results.len(),
        "elements": results,
        "suggestion": if results.is_empty() { "No elements found. Try ghost_annotate for a visual view or ghost_read to see all text." } else { "Use ghost_click with x/y coordinates from the bounds field." }
    }))
}

pub async fn ghost_read(params: Value) -> Result<Value> {
    let query = str_param(&params, "query");
    let depth = int_param(&params, "depth", 25) as u32;

    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await?;

    let q = query.unwrap_or("").to_lowercase();
    let subtree = if q.is_empty() {
        Some(&tree)
    } else {
        find_node_ref(&tree, &q)
    };

    let mut texts = vec![];
    if let Some(node) = subtree {
        collect_text(node, depth, 0, &mut texts);
    }

    Ok(json!({ "text": texts.join("\n"), "lines": texts }))
}

pub async fn ghost_inspect(params: Value) -> Result<Value> {
    let query = str_param(&params, "query").unwrap_or("");

    // dom_id: CDP #id lookup
    let dom_id = str_param(&params, "dom_id");
    if let Some(id) = &dom_id {
        if ghost_core::cdp::is_available().await {
            if let Ok(els) = ghost_core::cdp::find_elements(&format!("#{id}")).await {
                if let Some(el) = els.first() {
                    return Ok(json!({
                        "role": el.tag, "title": el.text, "match_type": el.match_type,
                        "x": el.center_x as i32, "y": el.center_y as i32,
                        "source": "cdp", "actionable": true,
                    }));
                }
            }
        }
    }

    // dom_class: CDP .class lookup
    let dom_class = str_param(&params, "dom_class");
    if let Some(cls) = &dom_class {
        if ghost_core::cdp::is_available().await {
            if let Ok(els) = ghost_core::cdp::find_elements(&format!(".{cls}")).await {
                if let Some(el) = els.first() {
                    return Ok(json!({
                        "role": el.tag, "title": el.text, "match_type": el.match_type,
                        "x": el.center_x as i32, "y": el.center_y as i32,
                        "source": "cdp", "actionable": true,
                    }));
                }
            }
        }
    }

    let ax = PlatformAXTree::new()?;
    let element = ax.find_element(query).await;

    match element {
        Some(el) => Ok(json!({
            "role":           el.role,
            "title":          el.title,
            "value":          el.value,
            "identifier":     el.identifier,
            "bounds":         el.bounds,
            "actionable":     is_actionable(&el),
            "editable":       is_editable(&el),
            "enabled":        el.enabled,
            "focused":        el.focused,
            "hidden":         el.hidden,
            "children_count": el.children.len(),
        })),
        None => {
            // CDP fallback for web elements not in the AX tree
            if ghost_core::cdp::is_available().await {
                if let Ok(els) = ghost_core::cdp::find_elements(query).await {
                    if let Some(el) = els.first() {
                        return Ok(json!({
                            "role":       el.tag,
                            "title":      el.text,
                            "match_type": el.match_type,
                            "x":          el.center_x as i32,
                            "y":          el.center_y as i32,
                            "source":     "cdp",
                            "actionable": true,
                        }));
                    }
                }
            }
            Ok(json!({
                "found": false,
                "suggestion": "Element not found. Try ghost_find with a broader query or ghost_annotate."
            }))
        }
    }
}

pub async fn ghost_element_at(params: Value) -> Result<Value> {
    let x = params["x"].as_f64().ok_or_else(|| anyhow::anyhow!("x required"))? as i32;
    let y = params["y"].as_f64().ok_or_else(|| anyhow::anyhow!("y required"))? as i32;

    let ax = PlatformAXTree::new()?;
    let element = ax.element_at(x, y).await;

    match element {
        Some(el) => Ok(json!({
            "x": x, "y": y,
            "role":       el.role,
            "title":      el.title,
            "value":      el.value,
            "identifier": el.identifier,
            "bounds":     el.bounds,
        })),
        None => Ok(json!({ "x": x, "y": y, "element": null })),
    }
}

pub async fn ghost_screenshot(params: Value) -> Result<Value> {
    let full_resolution = bool_param(&params, "full_resolution", false);

    let frame = quick_screenshot(0).await
        .map_err(|e| anyhow::anyhow!("Screenshot failed: {e}"))?;

    // Convert BGRA -> RGBA
    let mut rgba = vec![0u8; frame.data.len()];
    for i in (0..frame.data.len()).step_by(4) {
        rgba[i]     = frame.data[i + 2];
        rgba[i + 1] = frame.data[i + 1];
        rgba[i + 2] = frame.data[i];
        rgba[i + 3] = frame.data[i + 3];
    }

    let (w, h) = (frame.width, frame.height);
    let img = image::RgbaImage::from_raw(w, h, rgba)
        .ok_or_else(|| anyhow::anyhow!("Buffer mismatch"))?;

    // Optionally resize to max 1280 wide
    let out_img = if !full_resolution && w > 1280 {
        let scale = 1280.0 / w as f64;
        let new_w = 1280u32;
        let new_h = (h as f64 * scale) as u32;
        image::DynamicImage::ImageRgba8(img)
            .resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        image::DynamicImage::ImageRgba8(img)
    };

    let mut png_bytes = Vec::new();
    out_img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(json!({
        "png_base64": b64,
        "width":  out_img.width(),
        "height": out_img.height(),
    }))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn node_to_value(node: &AXTreeNode) -> Value {
    json!({
        "role":       node.role,
        "title":      node.title,
        "value":      node.value,
        "identifier": node.identifier,
        "bounds":     node.bounds,
        "actionable": is_actionable(node),
    })
}

fn is_actionable(node: &AXTreeNode) -> bool {
    let r = node.role.to_lowercase();
    r.contains("button") || r.contains("link") || r.contains("textfield")
    || r.contains("text field") || r.contains("checkbox") || r.contains("combo")
    || r.contains("slider") || r.contains("tab") || r.contains("menu")
    || r.contains("cell") || r.contains("row")
}

fn is_editable(node: &AXTreeNode) -> bool {
    let r = node.role.to_lowercase();
    r.contains("text") || r.contains("field") || r.contains("edit") || r.contains("combo")
}

fn focused_element(tree: &AXTreeNode) -> Value {
    json!({ "role": tree.role, "title": tree.title, "value": tree.value, "editable": is_editable(tree) })
}

/// Returns true for layout-only container roles that cost 0 depth budget.
/// These are structural nodes with no semantic content of their own.
fn is_layout_container(node: &AXTreeNode) -> bool {
    matches!(
        node.role.to_lowercase().as_str(),
        "group" | "axgroup" | "scrollarea" | "axscrollarea" |
        "splitgroup" | "axsplitgroup" | "layoutitem" | "axlayoutitem" |
        "box" | "generic" | "none" | ""
    )
}

fn collect_interactive(node: &AXTreeNode, depth: u32, max_depth: u32) -> Vec<Value> {
    let mut out = vec![];
    if is_actionable(node) {
        out.push(node_to_value(node));
    }
    if depth < max_depth {
        // Layout containers don't consume depth budget — tunnel through them
        let child_depth = if is_layout_container(node) { depth } else { depth + 1 };
        for child in &node.children {
            out.extend(collect_interactive(child, child_depth, max_depth));
        }
    }
    out
}

fn find_elements(
    node: &AXTreeNode,
    query: &str, role: &str, id: &str, class: &str,
    max_depth: u32, out: &mut Vec<Value>
) {
    find_elements_inner(node, query, role, id, class, 0, max_depth, out);
}

fn find_elements_inner(
    node: &AXTreeNode,
    query: &str, role: &str, id: &str, class: &str,
    depth: u32, max_depth: u32, out: &mut Vec<Value>
) {
    if depth > max_depth { return; }

    fn matches(node: &AXTreeNode, query: &str, role: &str, id: &str, class: &str) -> bool {
        let title_lc = node.title.as_deref().unwrap_or("").to_lowercase();
        let value_lc = node.value.as_deref().unwrap_or("").to_lowercase();
        let role_lc  = node.role.to_lowercase();
        let ident_lc = node.identifier.as_deref().unwrap_or("").to_lowercase();

        let q_ok = query.is_empty() || title_lc.contains(query) || value_lc.contains(query) || ident_lc.contains(query);
        let r_ok = role.is_empty()  || role_lc.contains(role);
        let i_ok = id.is_empty()    || ident_lc.contains(id);
        // dom_class: AX trees don't expose CSS classes; best-effort match against identifier
        let c_ok = class.is_empty() || ident_lc.contains(class);
        q_ok && r_ok && i_ok && c_ok
    }

    if matches(node, query, role, id, class) {
        out.push(node_to_value(node));
    }
    if out.len() < 50 {
        // Layout containers don't consume depth budget — tunnel through them
        let child_depth = if is_layout_container(node) { depth } else { depth + 1 };
        for child in &node.children {
            find_elements_inner(child, query, role, id, class, child_depth, max_depth, out);
        }
    }
}

fn find_node_ref<'a>(node: &'a AXTreeNode, query: &str) -> Option<&'a AXTreeNode> {
    let lc = |s: &Option<String>| s.as_deref().unwrap_or("").to_lowercase();
    if lc(&node.title).contains(query) || lc(&node.value).contains(query) || node.role.to_lowercase().contains(query) {
        return Some(node);
    }
    for child in &node.children {
        if let Some(f) = find_node_ref(child, query) { return Some(f); }
    }
    None
}

fn collect_text(node: &AXTreeNode, max_depth: u32, depth: u32, out: &mut Vec<String>) {
    if depth > max_depth { return; }
    if let Some(v) = &node.value { if !v.trim().is_empty() { out.push(v.trim().to_string()); } }
    if let Some(t) = &node.title { if !t.trim().is_empty() && !out.contains(t) { out.push(t.trim().to_string()); } }
    for child in &node.children { collect_text(child, max_depth, depth + 1, out); }
}
