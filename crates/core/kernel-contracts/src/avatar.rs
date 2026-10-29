//! Data-only **avatar parts** a plugin contributes to the shared glyph system:
//! accessories that dress a region of an avatar (`contributes.avatar_accessories`)
//! and whole avatar styles with their own regions (`contributes.avatar_styles`).
//!
//! # Why shapes, not SVG markup
//!
//! A part is drawn from a closed list of SVG primitives ([`AvatarShapeType`]) whose
//! attributes each have an inert grammar: path data, point lists, transform
//! functions, finite numbers, and a small paint vocabulary ([`is_avatar_paint`]).
//! The shell renders them as framework elements, never as injected markup, so a
//! part cannot carry script, event handlers, `<foreignObject>`, external
//! references, or `url(...)` paint. That keeps avatar packs with themes and
//! backgrounds on the zero-grant side of the line: the worst a hostile part can do
//! is look bad.
//!
//! # Regions
//!
//! The Ryu ghost exposes the costume regions in [`GHOST_AVATAR_REGIONS`]. A style
//! declares its own regions; an accessory whose `target` is a style id dresses one
//! of that style's regions. Cross-plugin targets are resolved by the renderer, not
//! here, because the style may come from a plugin installed later; a part aimed at
//! a region nobody declares is simply never offered.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Maximum accessories one plugin may contribute.
pub const MAX_AVATAR_ACCESSORY_CONTRIBUTIONS: usize = 64;
/// Maximum avatar styles one plugin may contribute.
pub const MAX_AVATAR_STYLE_CONTRIBUTIONS: usize = 16;
/// Maximum primitives in one accessory, style base, or style option.
pub const MAX_AVATAR_SHAPES_PER_PART: usize = 64;
/// Maximum regions one style declares.
pub const MAX_AVATAR_STYLE_REGIONS: usize = 16;
/// Maximum options in one style region.
pub const MAX_AVATAR_REGION_OPTIONS: usize = 64;
/// Maximum palettes one style declares.
pub const MAX_AVATAR_STYLE_PALETTES: usize = 16;
/// Serialized ceiling for one accessory. Parts travel on every contributions
/// response, so they are bounded like other always-served declarations.
pub const MAX_AVATAR_ACCESSORY_BYTES: usize = 32 * 1024;
/// Serialized ceiling for one style, including every region option.
pub const MAX_AVATAR_STYLE_BYTES: usize = 256 * 1024;
/// Longest accepted path `d` or polygon `points` string.
pub const MAX_AVATAR_GEOMETRY_LEN: usize = 8 * 1024;
/// Largest absolute coordinate or length a primitive may use.
pub const MAX_AVATAR_COORDINATE: f64 = 10_000.0;

/// The target id that addresses the built-in Ryu ghost.
pub const GHOST_AVATAR_TARGET: &str = "ghost";

/// Costume regions of the Ryu ghost an accessory may dress.
pub const GHOST_AVATAR_REGIONS: &[&str] = &[
    "eyes",
    "brows",
    "mouth",
    "ears",
    "headwear",
    "glasses",
    "accessory",
    "pattern",
];

/// One SVG primitive kind. Closed on purpose: every member has a renderer in the
/// shell and an attribute grammar here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AvatarShapeType {
    Path,
    Circle,
    Ellipse,
    Rect,
    Polygon,
    Polyline,
    Line,
}

/// Whether a part draws in front of or behind the avatar body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AvatarLayer {
    #[default]
    Front,
    Behind,
}

/// One drawn primitive. Coordinates are in the target's own space: the ghost's
/// 24-unit silhouette, or the style's `viewBox`.
///
/// Paints (`fill`, `stroke`) accept `none`, `currentColor`, a `#rgb`/`#rgba`/
/// `#rrggbb`/`#rrggbbaa` hex colour, `ink`, or a palette token
/// (`palette.base`, `palette.light`, `palette.deep`) so a part recolours with the
/// avatar's palette.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarShape {
    #[serde(rename = "type")]
    pub shape_type: AvatarShapeType,
    /// Path data for `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
    /// Point list for `polygon` / `polyline`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ry: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    /// `butt` | `round` | `square`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_linecap: Option<String>,
    /// `miter` | `round` | `bevel`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_linejoin: Option<String>,
    /// 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// SVG transform list of `translate`, `rotate`, `scale`, `skewX`, `skewY`, or
    /// `matrix` functions with numeric arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<String>,
}

/// One accessory a plugin contributes (`contributes.avatar_accessories`).
///
/// ```json
/// "avatar_accessories": [{
///   "id": "@acme/hats:beanie",
///   "label": "Beanie",
///   "target": "ghost",
///   "region": "headwear",
///   "shapes": [{ "type": "path", "d": "M12 2 Q18 -3 24 2 Z", "fill": "palette.deep" }]
/// }]
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarAccessoryContribution {
    /// Stable id in the form `<owning-plugin-id>:<local-id>`. Persisted in avatar
    /// selections, so keep it stable across releases.
    pub id: String,
    /// Name shown in the avatar editor.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `ghost` for the Ryu ghost, or an avatar style id (`<plugin-id>:<local-id>`).
    pub target: String,
    /// Region the accessory dresses: one of [`GHOST_AVATAR_REGIONS`] for the ghost,
    /// or a region id the target style declares.
    pub region: String,
    /// Draw in front of (default) or behind the body.
    #[serde(default)]
    pub layer: AvatarLayer,
    pub shapes: Vec<AvatarShape>,
}

/// A named colour set for an avatar style. Shapes reference it through the
/// `palette.*` paint tokens; `ink` defaults to near-black when absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarStylePalette {
    pub id: String,
    pub label: String,
    pub base: String,
    pub light: String,
    pub deep: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink: Option<String>,
}

/// One selectable option inside a style region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarStyleOption {
    pub id: String,
    pub label: String,
    pub shapes: Vec<AvatarShape>,
}

/// A region of a style (eyes, hair, hat, ...). Regions draw in declaration order
/// within their layer: behind regions, then the base, then front regions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarStyleRegion {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub layer: AvatarLayer,
    /// When true the region may be left empty, and seeded avatars sometimes do.
    #[serde(default)]
    pub optional: bool,
    pub options: Vec<AvatarStyleOption>,
}

/// A whole avatar style a plugin contributes (`contributes.avatar_styles`): a
/// generative look in the spirit of a DiceBear style, chosen by seed and refined
/// per region. Other plugins can dress its regions with accessories.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarStyleContribution {
    /// Stable id in the form `<owning-plugin-id>:<local-id>`.
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `[min-x, min-y, width, height]` of the drawing space.
    pub view_box: [f64; 4],
    pub palettes: Vec<AvatarStylePalette>,
    /// Shapes drawn between the behind and front regions (the body).
    #[serde(default)]
    pub base: Vec<AvatarShape>,
    #[serde(default)]
    pub regions: Vec<AvatarStyleRegion>,
}

/// Validate one plugin's avatar accessories and styles.
pub fn validate_avatar_contributions(
    plugin_id: &str,
    accessories: &[AvatarAccessoryContribution],
    styles: &[AvatarStyleContribution],
) -> Result<(), String> {
    if accessories.len() > MAX_AVATAR_ACCESSORY_CONTRIBUTIONS {
        return Err(format!(
            "avatar_accessories has {} entries (max {MAX_AVATAR_ACCESSORY_CONTRIBUTIONS})",
            accessories.len()
        ));
    }
    if styles.len() > MAX_AVATAR_STYLE_CONTRIBUTIONS {
        return Err(format!(
            "avatar_styles has {} entries (max {MAX_AVATAR_STYLE_CONTRIBUTIONS})",
            styles.len()
        ));
    }
    let prefix = format!("{plugin_id}:");
    let mut seen = BTreeSet::new();
    for accessory in accessories {
        validate_accessory(&prefix, accessory)?;
        if !seen.insert(accessory.id.as_str()) {
            return Err(format!(
                "avatar accessory '{}' is declared twice",
                accessory.id
            ));
        }
    }
    let mut seen = BTreeSet::new();
    for style in styles {
        validate_style(&prefix, style)?;
        if !seen.insert(style.id.as_str()) {
            return Err(format!("avatar style '{}' is declared twice", style.id));
        }
    }
    Ok(())
}

fn validate_accessory(prefix: &str, accessory: &AvatarAccessoryContribution) -> Result<(), String> {
    let id = &accessory.id;
    if !valid_local_id(accessory.id.strip_prefix(prefix).unwrap_or(""), 96) {
        return Err(format!(
            "avatar accessory '{id}' must have an id prefixed by '{prefix}' and a safe lowercase suffix"
        ));
    }
    validate_label(&accessory.label, &format!("avatar accessory '{id}'"))?;
    validate_description(
        accessory.description.as_deref(),
        &format!("avatar accessory '{id}'"),
    )?;
    if accessory.target == GHOST_AVATAR_TARGET {
        if !GHOST_AVATAR_REGIONS.contains(&accessory.region.as_str()) {
            return Err(format!(
                "avatar accessory '{id}' region '{}' is not a ghost region ({})",
                accessory.region,
                GHOST_AVATAR_REGIONS.join(", ")
            ));
        }
    } else {
        if !valid_style_reference(&accessory.target) {
            return Err(format!(
                "avatar accessory '{id}' target must be 'ghost' or an avatar style id"
            ));
        }
        if !valid_local_id(&accessory.region, 48) {
            return Err(format!("avatar accessory '{id}' has an invalid region id"));
        }
    }
    validate_shapes(&accessory.shapes, &format!("avatar accessory '{id}'"), true)?;
    let bytes = serde_json::to_vec(accessory).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_AVATAR_ACCESSORY_BYTES {
        return Err(format!(
            "avatar accessory '{id}' exceeds {MAX_AVATAR_ACCESSORY_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_style(prefix: &str, style: &AvatarStyleContribution) -> Result<(), String> {
    let id = &style.id;
    let owner = format!("avatar style '{id}'");
    if !valid_local_id(style.id.strip_prefix(prefix).unwrap_or(""), 96) {
        return Err(format!(
            "{owner} must have an id prefixed by '{prefix}' and a safe lowercase suffix"
        ));
    }
    validate_label(&style.label, &owner)?;
    validate_description(style.description.as_deref(), &owner)?;
    let [_, _, width, height] = style.view_box;
    if style
        .view_box
        .iter()
        .any(|v| !v.is_finite() || v.abs() > MAX_AVATAR_COORDINATE)
        || width <= 0.0
        || height <= 0.0
    {
        return Err(format!(
            "{owner} viewBox must be four finite numbers with a positive size"
        ));
    }
    if style.palettes.is_empty() || style.palettes.len() > MAX_AVATAR_STYLE_PALETTES {
        return Err(format!(
            "{owner} must declare between 1 and {MAX_AVATAR_STYLE_PALETTES} palettes"
        ));
    }
    let mut palette_ids = BTreeSet::new();
    for palette in &style.palettes {
        if !valid_local_id(&palette.id, 48) || !palette_ids.insert(palette.id.as_str()) {
            return Err(format!(
                "{owner} palette ids must be unique safe lowercase ids"
            ));
        }
        validate_label(&palette.label, &owner)?;
        let colors = [&palette.base, &palette.light, &palette.deep];
        if colors.iter().any(|c| !is_hex_color(c))
            || palette.ink.as_deref().is_some_and(|c| !is_hex_color(c))
        {
            return Err(format!(
                "{owner} palette '{}' colours must be hex values",
                palette.id
            ));
        }
    }
    validate_shapes(&style.base, &owner, false)?;
    if style.regions.len() > MAX_AVATAR_STYLE_REGIONS {
        return Err(format!(
            "{owner} has {} regions (max {MAX_AVATAR_STYLE_REGIONS})",
            style.regions.len()
        ));
    }
    let mut region_ids = BTreeSet::new();
    for region in &style.regions {
        if !valid_local_id(&region.id, 48) || !region_ids.insert(region.id.as_str()) {
            return Err(format!(
                "{owner} region ids must be unique safe lowercase ids"
            ));
        }
        validate_label(&region.label, &owner)?;
        if region.options.is_empty() || region.options.len() > MAX_AVATAR_REGION_OPTIONS {
            return Err(format!(
                "{owner} region '{}' must have between 1 and {MAX_AVATAR_REGION_OPTIONS} options",
                region.id
            ));
        }
        let mut option_ids = BTreeSet::new();
        for option in &region.options {
            if !valid_local_id(&option.id, 48)
                || option.id == "none"
                || !option_ids.insert(option.id.as_str())
            {
                return Err(format!(
                    "{owner} region '{}' option ids must be unique safe lowercase ids other than 'none'",
                    region.id
                ));
            }
            validate_label(&option.label, &owner)?;
            validate_shapes(
                &option.shapes,
                &format!("{owner} option '{}/{}'", region.id, option.id),
                true,
            )?;
        }
    }
    if style.base.is_empty() && style.regions.is_empty() {
        return Err(format!("{owner} draws nothing: add base shapes or regions"));
    }
    let bytes = serde_json::to_vec(style).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_AVATAR_STYLE_BYTES {
        return Err(format!("{owner} exceeds {MAX_AVATAR_STYLE_BYTES} bytes"));
    }
    Ok(())
}

fn validate_shapes(shapes: &[AvatarShape], owner: &str, required: bool) -> Result<(), String> {
    if required && shapes.is_empty() {
        return Err(format!("{owner} must draw at least one shape"));
    }
    if shapes.len() > MAX_AVATAR_SHAPES_PER_PART {
        return Err(format!(
            "{owner} has {} shapes (max {MAX_AVATAR_SHAPES_PER_PART})",
            shapes.len()
        ));
    }
    for (index, shape) in shapes.iter().enumerate() {
        validate_shape(shape).map_err(|reason| format!("{owner} shape {index}: {reason}"))?;
    }
    Ok(())
}

fn validate_shape(shape: &AvatarShape) -> Result<(), String> {
    let coordinates = [
        shape.cx, shape.cy, shape.x, shape.y, shape.x1, shape.y1, shape.x2, shape.y2,
    ];
    if coordinates
        .iter()
        .flatten()
        .any(|v| !v.is_finite() || v.abs() > MAX_AVATAR_COORDINATE)
    {
        return Err("coordinates must be finite and within bounds".to_owned());
    }
    let lengths = [shape.r, shape.rx, shape.ry, shape.width, shape.height];
    if lengths
        .iter()
        .flatten()
        .any(|v| !v.is_finite() || *v < 0.0 || *v > MAX_AVATAR_COORDINATE)
    {
        return Err("lengths must be finite, non-negative, and within bounds".to_owned());
    }
    match shape.shape_type {
        AvatarShapeType::Path => {
            if !shape.d.as_deref().is_some_and(is_path_data) {
                return Err("path needs valid `d` data".to_owned());
            }
        }
        AvatarShapeType::Polygon | AvatarShapeType::Polyline => {
            if !shape.points.as_deref().is_some_and(is_point_list) {
                return Err("polygon/polyline needs a valid `points` list".to_owned());
            }
        }
        AvatarShapeType::Circle => {
            if shape.r.is_none() {
                return Err("circle needs `r`".to_owned());
            }
        }
        AvatarShapeType::Ellipse => {
            if shape.rx.is_none() || shape.ry.is_none() {
                return Err("ellipse needs `rx` and `ry`".to_owned());
            }
        }
        AvatarShapeType::Rect => {
            if shape.width.is_none() || shape.height.is_none() {
                return Err("rect needs `width` and `height`".to_owned());
            }
        }
        AvatarShapeType::Line => {}
    }
    if shape.d.is_some() && shape.shape_type != AvatarShapeType::Path {
        return Err("`d` is only valid on a path".to_owned());
    }
    if shape.points.is_some()
        && !matches!(
            shape.shape_type,
            AvatarShapeType::Polygon | AvatarShapeType::Polyline
        )
    {
        return Err("`points` is only valid on a polygon or polyline".to_owned());
    }
    for paint in [&shape.fill, &shape.stroke].into_iter().flatten() {
        if !is_avatar_paint(paint) {
            return Err(format!(
                "paint '{paint}' is not an accepted colour or token"
            ));
        }
    }
    if shape
        .stroke_width
        .is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v))
    {
        return Err("strokeWidth must be between 0 and 100".to_owned());
    }
    if shape
        .opacity
        .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err("opacity must be between 0 and 1".to_owned());
    }
    if shape
        .stroke_linecap
        .as_deref()
        .is_some_and(|v| !matches!(v, "butt" | "round" | "square"))
    {
        return Err("strokeLinecap must be butt, round, or square".to_owned());
    }
    if shape
        .stroke_linejoin
        .as_deref()
        .is_some_and(|v| !matches!(v, "miter" | "round" | "bevel"))
    {
        return Err("strokeLinejoin must be miter, round, or bevel".to_owned());
    }
    if shape
        .transform
        .as_deref()
        .is_some_and(|v| !is_transform_list(v))
    {
        return Err("transform must be a list of numeric SVG transform functions".to_owned());
    }
    Ok(())
}

fn valid_local_id(id: &str, max: usize) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// A namespaced style id: `<plugin-id>:<local-id>`. The plugin half is checked
/// only for shape here; the owning plugin may not be installed yet.
fn valid_style_reference(id: &str) -> bool {
    let Some((plugin, local)) = id.rsplit_once(':') else {
        return false;
    };
    !plugin.is_empty()
        && plugin.len() <= crate::manifest::MAX_PLUGIN_ID_LEN
        && plugin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-'))
        && valid_local_id(local, 96)
}

fn validate_label(label: &str, owner: &str) -> Result<(), String> {
    if label.trim().is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
        return Err(format!("{owner} has an invalid label"));
    }
    Ok(())
}

fn validate_description(description: Option<&str>, owner: &str) -> Result<(), String> {
    if description.is_some_and(|d| d.len() > 512 || d.chars().any(char::is_control)) {
        return Err(format!("{owner} has an invalid description"));
    }
    Ok(())
}

/// `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`.
pub fn is_hex_color(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|hex| {
        matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
    })
}

/// The paint vocabulary a shape may use. Deliberately excludes `url(...)`, named
/// CSS functions, and free-form strings.
pub fn is_avatar_paint(value: &str) -> bool {
    matches!(
        value,
        "none" | "currentColor" | "ink" | "palette.base" | "palette.light" | "palette.deep"
    ) || is_hex_color(value)
}

fn is_path_data(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_AVATAR_GEOMETRY_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || "MmLlHhVvCcSsQqTtAaZz.,-+eE \t\n\r".contains(c))
}

fn is_point_list(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_AVATAR_GEOMETRY_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ".,-+eE \t\n\r".contains(c))
}

fn is_transform_list(value: &str) -> bool {
    const FUNCTIONS: &[&str] = &["translate", "rotate", "scale", "skewX", "skewY", "matrix"];
    if value.trim().is_empty() || value.len() > 256 {
        return false;
    }
    let mut rest = value.trim();
    while !rest.is_empty() {
        let Some(open) = rest.find('(') else {
            return false;
        };
        let Some(close) = rest.find(')') else {
            return false;
        };
        if close < open {
            return false;
        }
        let name = rest[..open].trim_matches(|c: char| c == ',' || c.is_whitespace());
        let args = &rest[open + 1..close];
        if !FUNCTIONS.contains(&name)
            || args.trim().is_empty()
            || !args
                .chars()
                .all(|c| c.is_ascii_digit() || ".,-+eE \t".contains(c))
        {
            return false;
        }
        rest = rest[close + 1..].trim_start_matches(|c: char| c == ',' || c.is_whitespace());
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(d: &str) -> AvatarShape {
        serde_json::from_value(
            serde_json::json!({ "type": "path", "d": d, "fill": "palette.deep" }),
        )
        .expect("path shape decodes")
    }

    fn hat() -> AvatarAccessoryContribution {
        serde_json::from_value(serde_json::json!({
            "id": "@acme/hats:beanie",
            "label": "Beanie",
            "target": "ghost",
            "region": "headwear",
            "shapes": [
                { "type": "path", "d": "M12 2 Q18 -3 24 2 Z", "fill": "palette.deep", "stroke": "ink", "strokeWidth": 0.5 },
                { "type": "circle", "cx": 18, "cy": -2, "r": 1.2, "fill": "#fff", "transform": "rotate(15 18 -2)" }
            ]
        }))
        .expect("accessory decodes")
    }

    fn robot_style() -> AvatarStyleContribution {
        serde_json::from_value(serde_json::json!({
            "id": "@acme/hats:robot",
            "label": "Robot",
            "viewBox": [0, 0, 64, 64],
            "palettes": [{ "id": "steel", "label": "Steel", "base": "#9aa5b1", "light": "#e4e7eb", "deep": "#3e4c59" }],
            "base": [{ "type": "rect", "x": 12, "y": 14, "width": 40, "height": 38, "rx": 8, "fill": "palette.base" }],
            "regions": [{
                "id": "eyes",
                "label": "Eyes",
                "options": [
                    { "id": "dots", "label": "Dots", "shapes": [{ "type": "circle", "cx": 24, "cy": 30, "r": 3, "fill": "ink" }] }
                ]
            }, {
                "id": "antenna",
                "label": "Antenna",
                "layer": "behind",
                "optional": true,
                "options": [
                    { "id": "single", "label": "Single", "shapes": [{ "type": "line", "x1": 32, "y1": 14, "x2": 32, "y2": 4, "stroke": "palette.deep" }] }
                ]
            }]
        }))
        .expect("style decodes")
    }

    #[test]
    fn accepts_namespaced_ghost_accessories_and_styles() {
        let wire = serde_json::to_value(hat()).unwrap();
        assert_eq!(wire["shapes"][0]["strokeWidth"], 0.5);
        assert_eq!(wire["layer"], "front");
        assert!(validate_avatar_contributions("@acme/hats", &[hat()], &[robot_style()]).is_ok());
    }

    #[test]
    fn accessories_may_target_another_plugins_style_region() {
        let mut accessory = hat();
        accessory.target = "@other/robots:robot".to_owned();
        accessory.region = "antenna".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[accessory.clone()], &[]).is_ok());
        accessory.target = "robot".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());
    }

    #[test]
    fn rejects_foreign_ids_unknown_ghost_regions_and_duplicates() {
        let mut accessory = hat();
        accessory.id = "@other/hats:beanie".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut accessory = hat();
        accessory.region = "tail".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        assert!(validate_avatar_contributions("@acme/hats", &[hat(), hat()], &[]).is_err());
    }

    #[test]
    fn rejects_markup_urls_and_script_shaped_attributes() {
        for paint in [
            "url(#x)",
            "javascript:alert(1)",
            "red",
            "#12345",
            "var(--x)",
        ] {
            assert!(!is_avatar_paint(paint), "{paint} must be rejected");
        }
        let mut accessory = hat();
        accessory.shapes = vec![path("M0 0 <script>")];
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut accessory = hat();
        accessory.shapes[1].transform = Some("translate(1 2) expression(alert(1))".to_owned());
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut accessory = hat();
        accessory.shapes[0].d = None;
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        assert!(serde_json::from_value::<AvatarShape>(
            serde_json::json!({ "type": "foreignObject" })
        )
        .is_err());
    }

    #[test]
    fn bounds_counts_sizes_and_numbers() {
        let mut accessory = hat();
        accessory.shapes = vec![path("M0 0 L1 1"); MAX_AVATAR_SHAPES_PER_PART + 1];
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut accessory = hat();
        accessory.shapes[1].opacity = Some(2.0);
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut accessory = hat();
        accessory.shapes[1].r = Some(-1.0);
        assert!(validate_avatar_contributions("@acme/hats", &[accessory], &[]).is_err());

        let mut style = robot_style();
        style.view_box = [0.0, 0.0, 0.0, 64.0];
        assert!(validate_avatar_contributions("@acme/hats", &[], &[style]).is_err());

        let mut style = robot_style();
        style.palettes[0].base = "palette.base".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[], &[style]).is_err());

        let mut style = robot_style();
        style.regions[0].options[0].id = "none".to_owned();
        assert!(validate_avatar_contributions("@acme/hats", &[], &[style]).is_err());
    }

    #[test]
    fn transform_grammar_accepts_svg_lists() {
        assert!(is_transform_list("translate(18 1.3) rotate(15)"));
        assert!(is_transform_list("matrix(1,0,0,1,2,3), scale(-1 1)"));
        assert!(!is_transform_list("rotate()"));
        assert!(!is_transform_list("translate(1 2"));
        assert!(!is_transform_list("url(1)"));
    }
}
