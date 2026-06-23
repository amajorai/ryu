// ghost_annotate: screenshot with numbered labels on interactive AX elements.
// Uses imageproc for drawing; no ML required — purely accessibility tree based.

use anyhow::Result;
use serde_json::{json, Value};
use base64::Engine;
use image::{Rgba, RgbaImage};

use ghost_eyes::{PlatformAXTree, AXTree, AXTreeNode, Bounds, quick_screenshot};

use super::{int_param, str_param};

const DEFAULT_ROLES: &[&str] = &[
    "button", "link", "text field", "textfield", "edit", "checkbox",
    "combo box", "combobox", "tab", "slider", "menu item",
    "AXButton", "AXLink", "AXTextField", "AXCheckBox", "AXComboBox",
    "AXTab", "AXSlider", "AXMenuItem",
];

pub async fn ghost_annotate(params: Value) -> Result<Value> {
    let _app    = str_param(&params, "app");
    let max_labels = int_param(&params, "max_labels", 50).min(100) as usize;

    // Optional role filter
    let roles: Vec<String> = params["roles"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_else(|| DEFAULT_ROLES.iter().map(|s| s.to_lowercase()).collect());

    // Get screenshot
    let frame = quick_screenshot(0).await
        .map_err(|e| anyhow::anyhow!("Screenshot failed: {e}"))?;

    let mut rgba = vec![0u8; frame.data.len()];
    for i in (0..frame.data.len()).step_by(4) {
        rgba[i]     = frame.data[i + 2];
        rgba[i + 1] = frame.data[i + 1];
        rgba[i + 2] = frame.data[i];
        rgba[i + 3] = frame.data[i + 3];
    }

    let mut img = RgbaImage::from_raw(frame.width, frame.height, rgba)
        .ok_or_else(|| anyhow::anyhow!("Buffer size mismatch"))?;

    // Get AX tree
    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await
        .unwrap_or_else(|_| AXTreeNode {
            role: "root".to_string(), title: None, value: None,
            identifier: None, bounds: None, children: vec![],
            enabled: true, focused: false, hidden: false,
        });

    // Collect interactive elements
    let mut elements: Vec<AnnotatedElement> = vec![];
    collect_annotatable(&tree, &roles, max_labels * 2, &mut elements); // collect extra, dedup below

    // Deduplicate: skip elements within 5px of an already-seen element with the same role
    let mut seen_positions: Vec<(i32, i32, String)> = vec![];
    let elements: Vec<AnnotatedElement> = elements.into_iter().filter(|el| {
        if let Some(bounds) = &el.bounds {
            let cx = bounds.x + bounds.width as i32 / 2;
            let cy = bounds.y + bounds.height as i32 / 2;
            let role_lc = el.role.to_lowercase();
            let dup = seen_positions.iter().any(|(sx, sy, sr)| {
                sr == &role_lc && (cx - sx).abs() < 5 && (cy - sy).abs() < 5
            });
            if !dup { seen_positions.push((cx, cy, role_lc)); }
            !dup
        } else {
            false // skip elements with no bounds
        }
    }).take(max_labels).collect();

    // Draw labels on image
    let label_color = Rgba([255u8, 59u8, 48u8, 230u8]); // iOS-red-ish
    let text_color  = Rgba([255u8, 255u8, 255u8, 255u8]);

    let mut index = vec![];
    for (i, el) in elements.iter().enumerate() {
        let n = i + 1;
        if let Some(bounds) = &el.bounds {
            let lx = bounds.x.max(0) as u32;
            let ly = bounds.y.max(0) as u32;
            let lw = bounds.width.min(frame.width.saturating_sub(lx));
            let lh = bounds.height.min(frame.height.saturating_sub(ly));

            if lw == 0 || lh == 0 { continue; }

            // Draw bounding box border (2px)
            draw_rect_border(&mut img, lx, ly, lw, lh, label_color);

            // Draw number label badge at top-left corner of element
            let badge_size = 18u32;
            let bx = lx.min(frame.width.saturating_sub(badge_size));
            let by = ly.min(frame.height.saturating_sub(badge_size));
            draw_filled_rect(&mut img, bx, by, badge_size, badge_size, label_color);
            draw_digit(&mut img, n, bx + 2, by + 2, text_color);

            let cx = bounds.x + bounds.width as i32 / 2;
            let cy = bounds.y + bounds.height as i32 / 2;
            index.push(json!({
                "label": n,
                "role":  el.role,
                "title": el.title,
                "x":     cx,
                "y":     cy,
                "bounds": bounds,
            }));
        }
    }

    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

    Ok(json!({
        "png_base64": b64,
        "label_count": index.len(),
        "index": index,
        "usage": "Use ghost_click with x/y from the index to interact with a labeled element.",
    }))
}

struct AnnotatedElement {
    role:   String,
    title:  Option<String>,
    bounds: Option<Bounds>,
}

fn collect_annotatable(
    node: &AXTreeNode,
    roles: &[String],
    max: usize,
    out: &mut Vec<AnnotatedElement>,
) {
    if out.len() >= max { return; }
    let role_lc = node.role.to_lowercase();
    let matches = roles.iter().any(|r| role_lc.contains(r.as_str()));
    if matches && node.bounds.is_some() {
        out.push(AnnotatedElement {
            role:   node.role.clone(),
            title:  node.title.clone(),
            bounds: node.bounds.clone(),
        });
    }
    for child in &node.children {
        collect_annotatable(child, roles, max, out);
    }
}

fn draw_rect_border(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, color: Rgba<u8>) {
    let (iw, ih) = img.dimensions();
    // top / bottom
    for dx in 0..w {
        let px = x + dx; if px >= iw { continue; }
        for &dy in &[y, y + h.saturating_sub(1)] { if dy < ih { img.put_pixel(px, dy, color); } }
    }
    // left / right
    for dy in 0..h {
        let py = y + dy; if py >= ih { continue; }
        for &dx in &[x, x + w.saturating_sub(1)] { if dx < iw { img.put_pixel(dx, py, color); } }
    }
}

fn draw_filled_rect(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, color: Rgba<u8>) {
    let (iw, ih) = img.dimensions();
    for dy in 0..h { for dx in 0..w {
        let px = x + dx; let py = y + dy;
        if px < iw && py < ih { img.put_pixel(px, py, color); }
    }}
}

/// Draw a 1-3 digit number using a minimal 3×5 bitmap font.
fn draw_digit(img: &mut RgbaImage, n: usize, x: u32, y: u32, color: Rgba<u8>) {
    let s = n.to_string();
    let chars: Vec<char> = s.chars().collect();
    for (ci, ch) in chars.iter().enumerate() {
        let pattern = char_pattern(*ch);
        let ox = x + ci as u32 * 4;
        for (row, bits) in pattern.iter().enumerate() {
            for col in 0..3u32 {
                if (bits >> (2 - col)) & 1 == 1 {
                    let px = ox + col; let py = y + row as u32;
                    let (iw, ih) = img.dimensions();
                    if px < iw && py < ih { img.put_pixel(px, py, color); }
                }
            }
        }
    }
}

/// 3-wide × 5-tall bitmap for each digit character.
fn char_pattern(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        _   => [0b000; 5],
    }
}
