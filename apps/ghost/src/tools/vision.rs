// Vision tools: ghost_ground (element grounding) and ghost_parse_screen (element
// enumeration).
//
// Both are AX-tree-first (zero ML, instant, cross-platform) — the same approach
// upstream uses as the first tier of its grounding cascade (AX → fuzzy → vision →
// cloud). ghost_ground adds a fuzzy match over the AX elements so a natural-language
// description resolves to real pixel coordinates without a model. When built with
// --features ort, ShowUI-2B is used as a fallback only when the AX/fuzzy tier finds
// nothing.

use anyhow::Result;
use serde_json::{json, Value};

use ghost_eyes::{AXTree, AXTreeNode, Bounds, PlatformAXTree};

use super::str_param;

const DEFAULT_ROLES: &[&str] = &[
    "button", "link", "text field", "textfield", "edit", "checkbox", "combo box",
    "combobox", "tab", "slider", "menu item", "radio", "list item", "cell",
    "AXButton", "AXLink", "AXTextField", "AXCheckBox", "AXComboBox", "AXTab",
    "AXSlider", "AXMenuItem", "AXRadioButton",
];

/// A single interactive element resolved from the accessibility tree.
struct Element {
    role: String,
    title: Option<String>,
    bounds: Bounds,
    cx: i32,
    cy: i32,
}

/// Walk an AX subtree collecting interactive elements (those whose role matches a
/// known interactive role and that carry bounds).
fn collect(node: &AXTreeNode, roles: &[String], max: usize, out: &mut Vec<Element>) {
    if out.len() >= max {
        return;
    }
    let role_lc = node.role.to_lowercase();
    let matches = roles.iter().any(|r| role_lc.contains(r.as_str()));
    if matches {
        if let Some(bounds) = &node.bounds {
            // Skip zero-area / off-screen elements.
            if bounds.width > 0 && bounds.height > 0 {
                let cx = bounds.x + bounds.width as i32 / 2;
                let cy = bounds.y + bounds.height as i32 / 2;
                out.push(Element {
                    role: node.role.clone(),
                    title: node.title.clone(),
                    bounds: bounds.clone(),
                    cx,
                    cy,
                });
            }
        }
    }
    for child in &node.children {
        collect(child, roles, max, out);
    }
}

/// Snapshot the focused window's interactive elements via the AX tree.
async fn focused_elements(max: usize) -> Result<Vec<Element>> {
    let roles: Vec<String> = DEFAULT_ROLES.iter().map(|s| s.to_lowercase()).collect();
    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await.unwrap_or_else(|_| AXTreeNode {
        role: "root".to_string(),
        title: None,
        value: None,
        identifier: None,
        bounds: None,
        children: vec![],
        enabled: true,
        focused: false,
        hidden: false,
    });
    let mut elements = Vec::new();
    collect(&tree, &roles, max, &mut elements);
    Ok(elements)
}

/// Score how well `description` matches an element's text (title + role). Returns
/// 0.0–1.0+. A full-substring title match is boosted so exact phrasing wins over
/// scattered token overlap.
fn match_score(description: &str, el: &Element) -> f32 {
    let desc = description.to_lowercase();
    let title = el.title.clone().unwrap_or_default().to_lowercase();
    let text = format!("{} {}", title, el.role.to_lowercase());

    if title.is_empty() {
        return 0.0;
    }

    // Exact / substring match on the title is the strongest signal.
    if title == desc {
        return 1.5;
    }
    if title.contains(&desc) || desc.contains(&title) {
        return 1.2;
    }

    let tokens: Vec<&str> = desc.split_whitespace().filter(|t| t.len() > 1).collect();
    if tokens.is_empty() {
        return 0.0;
    }
    let hits = tokens.iter().filter(|t| text.contains(*t)).count();
    hits as f32 / tokens.len() as f32
}

pub async fn ghost_ground(params: Value) -> Result<Value> {
    let description = params["description"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("'description' required"))?;

    // Tier 1: AX + fuzzy match — real coordinates, no model.
    let elements = focused_elements(400).await.unwrap_or_default();
    let best = elements
        .iter()
        .map(|el| (match_score(description, el), el))
        .filter(|(s, _)| *s > 0.0)
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Accept a confident-enough fuzzy hit (≥ half the description tokens, or any
    // substring/exact match which scores ≥ 1.2).
    if let Some((score, el)) = best {
        if score >= 0.5 {
            return Ok(json!({
                "found": true,
                "x": el.cx,
                "y": el.cy,
                "confidence": (score / 1.5).min(1.0),
                "method": "ax-fuzzy",
                "title": el.title,
                "role": el.role,
                "bounds": el.bounds,
            }));
        }
    }

    // Tier 2: ShowUI-2B vision grounding — only when the AX tier found nothing and
    // the model is compiled in.
    #[cfg(feature = "ort")]
    {
        use crate::vision_model::showui::ShowUIModel;
        use ghost_eyes::quick_screenshot;

        let frame = quick_screenshot(0)
            .await
            .map_err(|e| anyhow::anyhow!("Screenshot failed: {e}"))?;
        let w = frame.width;
        let h = frame.height;
        let bgra = frame.data;
        let desc = description.to_string();

        let result = tokio::task::spawn_blocking(move || {
            let model = ShowUIModel::load()?;
            model.run(&bgra, w, h, &desc)
        })
        .await??;

        let px_x = (result.x * w as f32) as i32;
        let px_y = (result.y * h as f32) as i32;
        return Ok(json!({
            "found": true,
            "x": px_x,
            "y": px_y,
            "confidence": result.confidence,
            "method": "showui-2b",
        }));
    }

    #[cfg(not(feature = "ort"))]
    Ok(json!({
        "found": false,
        "message": "No accessibility element matched the description. Build with --features ort \
                    (ShowUI-2B at ~/.ghost/models/showui-2b.onnx) for vision-based grounding of \
                    elements the AX tree does not expose.",
        "suggestion": "Call ghost_parse_screen or ghost_annotate to see what elements are available, \
                       then ghost_click the one you want.",
        "description_received": description,
        "ax_elements_scanned": elements.len(),
    }))
}

pub async fn ghost_parse_screen(params: Value) -> Result<Value> {
    // `app` is accepted for API compatibility; the AX tree is rooted at the focused
    // window, which is the active app.
    let _app = str_param(&params, "app");

    let elements = focused_elements(200).await?;
    let parsed: Vec<Value> = elements
        .iter()
        .map(|el| {
            json!({
                "role": el.role,
                "title": el.title,
                "x": el.cx,
                "y": el.cy,
                "bounds": el.bounds,
            })
        })
        .collect();

    Ok(json!({
        "element_count": parsed.len(),
        "elements": parsed,
        "method": "accessibility-tree",
        "usage": "Each element carries pixel x/y — pass them to ghost_click/ghost_hover. \
                  Use ghost_annotate for a labeled screenshot of the same elements.",
    }))
}
