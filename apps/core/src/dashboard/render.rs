//! Server-side dashboard rendering for the Ryu hardware display surface.
//!
//! TRMNL model (apps/hardware/DASHBOARD.md): the **node renders** a device's
//! dashboard to an image at the device's resolution + colour depth, and the device
//! is a dumb poll-and-blit client. This module takes a dashboard (its [`Widget`]s
//! with their cached live [`Widget::last_value`] from [`super::sources`]) plus a
//! [`DeviceProfile`] and produces the bytes the firmware blits.
//!
//! ## Pipeline (no headless Chromium)
//!
//! 1. Build an **SVG** document laying out each widget in its grid cell, drawn by a
//!    per-kind [`WidgetRenderer`] as glanceable, low-DPI, monochrome-friendly
//!    vector art.
//! 2. Rasterize the SVG onto a [`tiny_skia`] pixmap with [`resvg`] (pure Rust).
//! 3. Emit per the device's colour mode:
//!    - **e-ink** (`bit_depth == 1`): dither the greyscale pixmap to 1-bit and
//!      **pack** it MSB-first, row-major → `ceil(w/8) * h` bytes. This is the exact
//!      byte format the desk firmware `dash_client` blits (see [`pack_1bit`]).
//!    - **LCD** (`bit_depth > 1`): a colour **PNG** (and, on request, a packed
//!      big-endian **RGB565** buffer for a framebuffer blit).
//!
//! The renderer set is **extensible**: a [`WidgetKind`] maps to a [`WidgetRenderer`]
//! via [`renderer_for`]; add a kind by adding an arm there. Renderers only read the
//! widget's `title` + cached `last_value`, so they never touch the network — the
//! refresh loop already resolved the data.

use std::fmt::Write as _;

use serde_json::Value;

use super::{Widget, WidgetKind};

/// The eight-bit palette mode a device's panel expects. The renderer always draws
/// in greyscale/colour internally; the [`Palette`] only decides the *final*
/// encoding so the firmware receives bytes it can blit directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Palette {
    /// 1-bit black/white (e-ink desk panel). Packed MSB-first, row-major.
    Mono,
    /// Full RGBA colour, encoded as PNG (watch LCD default).
    Rgba,
    /// 16-bit RGB565, big-endian (a direct LCD framebuffer blit; high byte first
    /// to match the firmware `dash_client.h`, which swaps BE→LE before decode).
    Rgb565,
}

impl Palette {
    /// Wire string (kept stable for the firmware + TS mirror).
    pub fn as_str(self) -> &'static str {
        match self {
            Palette::Mono => "mono",
            Palette::Rgba => "rgba",
            Palette::Rgb565 => "rgb565",
        }
    }
}

/// A device's physical screen description. The renderer rasterizes to exactly this
/// geometry; the firmware `dash_client` reports the SAME shape in the display
/// metadata (`GET /api/hardware/display/:id` → `screen`) so the two never disagree.
///
/// Mirrors the firmware-side profile (apps/hardware/firmware/shared/dash_client)
/// and the `screen` object in DASHBOARD.md:
/// `{ w, h, bit_depth, palette, rotation }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceProfile {
    /// Panel width in pixels (the LONG edge for a landscape desk panel).
    pub w: u32,
    /// Panel height in pixels.
    pub h: u32,
    /// Bits per pixel of the final encoding. `1` ⇒ e-ink mono; `16` ⇒ RGB565;
    /// `24`/`32` ⇒ colour PNG.
    pub bit_depth: u8,
    /// Final byte encoding for this panel.
    pub palette: Palette,
    /// Clockwise rotation in degrees the firmware applies on blit. The node renders
    /// upright at `(w, h)`; the device rotates. Carried so the device knows; the
    /// raster itself is always produced at the upright `(w, h)`.
    pub rotation: u16,
}

impl DeviceProfile {
    /// The desk e-ink default: an 800×480 1-bit panel (the common 7.5" SSD168x).
    pub fn desk_eink() -> Self {
        Self {
            w: 800,
            h: 480,
            bit_depth: 1,
            palette: Palette::Mono,
            rotation: 0,
        }
    }

    /// The watch LCD default: a 240×240 round colour panel rendered as PNG.
    pub fn watch_lcd() -> Self {
        Self {
            w: 240,
            h: 240,
            bit_depth: 24,
            palette: Palette::Rgba,
            rotation: 0,
        }
    }

    /// True when this profile encodes to the packed 1-bit e-ink format.
    pub fn is_eink(self) -> bool {
        matches!(self.palette, Palette::Mono) || self.bit_depth == 1
    }
}

/// The rendered image plus the metadata the display endpoint returns.
pub struct RenderedImage {
    /// The image bytes in the device's encoding (packed 1-bit, RGB565, or PNG).
    pub bytes: Vec<u8>,
    /// MIME-ish content type for the `image` endpoint: `image/png` or
    /// `application/octet-stream` (packed mono / RGB565 are raw byte buffers).
    pub content_type: &'static str,
    /// The profile this was rendered for (echoed in the display metadata).
    pub profile: DeviceProfile,
}

impl RenderedImage {
    /// A short, stable content hash (the `rev`) so a device can skip re-downloading
    /// an unchanged image. FNV-1a over the bytes + the geometry; collision risk is
    /// irrelevant here (a false "unchanged" only delays one refresh, and the bytes
    /// change whenever any widget value does).
    pub fn rev(&self) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |b: u8| {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        };
        for b in self.profile.w.to_le_bytes() {
            mix(b);
        }
        for b in self.profile.h.to_le_bytes() {
            mix(b);
        }
        mix(self.profile.bit_depth);
        for &b in &self.bytes {
            mix(b);
        }
        format!("{h:016x}")
    }
}

/// A drawing surface for one widget's grid cell, in panel pixel coordinates. The
/// renderer appends SVG fragments; the helpers keep callers from hand-writing
/// coordinate math and escaping.
pub struct Cell<'a> {
    svg: &'a mut String,
    /// Cell origin + size in panel pixels.
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    /// `true` when the panel is 1-bit: renderers avoid greys that dither to noise
    /// and lean on pure black/white + bold type.
    mono: bool,
}

impl Cell<'_> {
    /// Foreground (text/strokes) hex for this panel.
    fn fg(&self) -> &'static str {
        "#000000"
    }

    /// A muted/secondary tone. On mono panels this is still black (greys dither to
    /// noise at low DPI); on colour it's a soft grey.
    fn muted(&self) -> &'static str {
        if self.mono {
            "#000000"
        } else {
            "#555555"
        }
    }

    /// Draw the cell's card frame: a thin border so widgets read as tiles.
    fn frame(&mut self) {
        // Compute borrows of `&self` BEFORE the `write!` takes `&mut self.svg`.
        let (x, y, w, h, fg) = (
            self.x + 1.0,
            self.y + 1.0,
            (self.w - 2.0).max(0.0),
            (self.h - 2.0).max(0.0),
            self.fg(),
        );
        let _ = write!(
            self.svg,
            r##"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" fill="none" stroke="{fg}" stroke-width="1.5" rx="6"/>"##,
        );
    }

    /// Draw left-aligned text at `(dx, dy)` offset from the cell origin.
    fn text(&mut self, dx: f32, dy: f32, size: f32, weight: &str, fill: &str, content: &str) {
        // Resolve everything that borrows `&self` first; `write!` then only needs
        // `&mut self.svg` (no aliasing conflict).
        let x = self.x + dx;
        let y = self.y + dy;
        let txt = escape_xml(&truncate(content, self.max_chars(size)));
        let _ = write!(
            self.svg,
            r##"<text x="{x:.1}" y="{y:.1}" font-family="Helvetica, Arial, sans-serif" font-size="{size:.1}" font-weight="{weight}" fill="{fill}">{txt}</text>"##,
        );
    }

    /// Crude character budget for a given font size across the cell width, so long
    /// strings are truncated with an ellipsis rather than overflowing the tile.
    fn max_chars(&self, size: f32) -> usize {
        let avg_char_w = size * 0.55;
        ((self.w - 24.0) / avg_char_w).max(1.0) as usize
    }

    /// The widget's title line (drawn near the top of the card).
    fn title(&mut self, title: &str) {
        if !title.trim().is_empty() {
            let muted = self.muted();
            self.text(12.0, 22.0, 13.0, "600", muted, title);
        }
    }
}

/// A per-kind widget renderer. Implementors draw glanceable monochrome-friendly art
/// from the widget's cached value. This is the extension point: a new widget kind is
/// one new `impl` + one arm in [`renderer_for`].
pub trait WidgetRenderer {
    /// Draw the widget into its cell. `value` is the widget's cached `last_value`
    /// (already resolved by the refresh loop), or `Value::Null` if it never ran.
    fn render(&self, cell: &mut Cell<'_>, widget: &Widget, value: &Value);
}

/// Resolve a widget kind to its device renderer. Kinds without a bespoke device
/// renderer fall back to a generic key/value [`TextWidget`] so nothing is unhandled.
pub fn renderer_for(kind: WidgetKind) -> Box<dyn WidgetRenderer> {
    match kind {
        WidgetKind::Stat => Box::new(MetricWidget),
        WidgetKind::List => Box::new(ListWidget),
        WidgetKind::Table => Box::new(ListWidget),
        WidgetKind::Text => Box::new(TextWidget),
        WidgetKind::AgentFeed => Box::new(TextWidget),
        // Charts/map have no glanceable low-DPI device form yet; show a labelled
        // placeholder rather than nothing. Add a real renderer here to extend.
        WidgetKind::LineChart
        | WidgetKind::BarChart
        | WidgetKind::AreaChart
        | WidgetKind::PieChart
        | WidgetKind::Map => Box::new(TextWidget),
    }
}

// ── Concrete widget renderers ────────────────────────────────────────────────

/// A big single number / KPI (the `stat` kind, and the generic "metric" surface).
/// Reads `config.value_key` / `config.label` / `config.unit` like the desktop
/// `StatWidget`, falling back to the raw value.
struct MetricWidget;
impl WidgetRenderer for MetricWidget {
    fn render(&self, cell: &mut Cell<'_>, widget: &Widget, value: &Value) {
        cell.frame();
        cell.title(&widget.title);
        let cfg = &widget.config;
        let label = cfg.get("label").and_then(Value::as_str);
        let unit = cfg.get("unit").and_then(Value::as_str).unwrap_or("");
        let key = cfg.get("value_key").and_then(Value::as_str);
        let number = match key {
            Some(k) => value.get(k).cloned().unwrap_or(Value::Null),
            None => value.clone(),
        };
        let shown = scalar_string(&number);
        let big = if unit.is_empty() {
            shown
        } else {
            format!("{shown} {unit}")
        };
        let fg = cell.fg();
        // The value, large and bold, vertically centred-ish.
        cell.text(
            12.0,
            cell.h * 0.62,
            (cell.h * 0.34).clamp(20.0, 56.0),
            "700",
            fg,
            &big,
        );
        if let Some(label) = label {
            let muted = cell.muted();
            cell.text(12.0, cell.h - 12.0, 12.0, "500", muted, label);
        }
    }
}

/// A short list (the `list`/`table`/`agenda` surfaces). Draws up to N rows from an
/// array value, or `config.items_key` into an object.
struct ListWidget;
impl WidgetRenderer for ListWidget {
    fn render(&self, cell: &mut Cell<'_>, widget: &Widget, value: &Value) {
        cell.frame();
        cell.title(&widget.title);
        let items_key = widget.config.get("items_key").and_then(Value::as_str);
        let arr = match items_key.map(|k| value.get(k)) {
            Some(Some(v)) => v.as_array().cloned(),
            _ => value.as_array().cloned(),
        }
        .unwrap_or_default();
        let top = if widget.title.trim().is_empty() {
            20.0
        } else {
            40.0
        };
        let row_h = 22.0;
        let max_rows = (((cell.h - top - 8.0) / row_h).floor() as usize).max(1);
        let fg = cell.fg();
        if arr.is_empty() {
            let muted = cell.muted();
            cell.text(12.0, top + 4.0, 13.0, "400", muted, "No items");
            return;
        }
        for (i, item) in arr.iter().take(max_rows).enumerate() {
            let dy = top + (i as f32) * row_h;
            cell.text(12.0, dy, 14.0, "500", fg, &row_string(item));
        }
    }
}

/// Markdown / prose / generic JSON (the `text`, `agent_feed`, and fallback kinds).
struct TextWidget;
impl WidgetRenderer for TextWidget {
    fn render(&self, cell: &mut Cell<'_>, widget: &Widget, value: &Value) {
        cell.frame();
        cell.title(&widget.title);
        let body = widget
            .config
            .get("markdown")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| match value {
                Value::String(s) => s.clone(),
                Value::Object(map) => map
                    .get("text")
                    .or_else(|| map.get("summary"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| compact_json(value)),
                Value::Null => String::new(),
                other => compact_json(other),
            });
        let top = if widget.title.trim().is_empty() {
            22.0
        } else {
            42.0
        };
        let fg = cell.fg();
        // Wrap the body into lines that fit the cell width.
        let cols = cell.max_chars(14.0);
        let line_h = 19.0;
        let max_lines = (((cell.h - top - 8.0) / line_h).floor() as usize).max(1);
        for (i, line) in wrap(&body, cols).into_iter().take(max_lines).enumerate() {
            let dy = top + (i as f32) * line_h;
            cell.text(12.0, dy, 14.0, "400", fg, &line);
        }
    }
}

// ── SVG assembly + rasterization ─────────────────────────────────────────────

/// Build the full SVG document for a dashboard at a device profile. Lays each
/// widget into a grid cell (down-scaling the 12-col desktop grid to the panel's
/// column count) and dispatches to its [`WidgetRenderer`]. Public so a debug/preview
/// endpoint could return the SVG directly.
pub fn build_svg(widgets: &[Widget], profile: DeviceProfile) -> String {
    let (w, h) = (profile.w as f32, profile.h as f32);
    let mono = profile.is_eink();
    let bg = if mono { "#ffffff" } else { "#ffffff" };
    let mut svg = String::with_capacity(2048);
    let _ = write!(
        svg,
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"##,
        w = profile.w,
        h = profile.h,
    );
    let _ = write!(
        svg,
        r##"<rect x="0" y="0" width="{w}" height="{h}" fill="{bg}"/>"##,
        w = profile.w,
        h = profile.h,
    );

    // Derive the source grid height: the max y+h across widgets, min 1 row, so the
    // panel is filled top-to-bottom regardless of how tall the desktop layout was.
    let src_rows = widgets
        .iter()
        .map(|wd| wd.layout.y + wd.layout.h.max(1))
        .max()
        .unwrap_or(1)
        .max(1);
    // Each grid row maps to this many panel pixels; widget x/w map through the
    // 12-column desktop grid below so the relative layout is preserved on any panel.
    let cell_h = h / src_rows as f32;

    if widgets.is_empty() {
        let _ = write!(
            svg,
            r##"<text x="{cx:.1}" y="{cy:.1}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#000000">No widgets on this dashboard</text>"##,
            cx = w / 2.0,
            cy = h / 2.0,
        );
    }

    for widget in widgets {
        // Map the desktop 12-col x into the panel column count, then to pixels.
        let src_cols = 12u32;
        let x0 = (widget.layout.x.min(src_cols.saturating_sub(1))) as f32 / src_cols as f32 * w;
        let wpx = (widget.layout.w.max(1)) as f32 / src_cols as f32 * w;
        let y0 = widget.layout.y as f32 * cell_h;
        let hpx = (widget.layout.h.max(1)) as f32 * cell_h;
        let mut cell = Cell {
            svg: &mut svg,
            x: x0,
            y: y0,
            w: wpx.min(w - x0),
            h: hpx.min(h - y0),
            mono,
        };
        let value = widget.last_value.clone().unwrap_or(Value::Null);
        renderer_for(widget.kind).render(&mut cell, widget, &value);
    }
    svg.push_str("</svg>");
    svg
}

/// Render a dashboard's widgets to the device's image encoding. This is the entry
/// point the display endpoint calls.
///
/// The firmware `dash_client` does NOT rotate — Core **pre-rotates** to the panel's
/// native orientation (a documented cross-mirror agreement). So we build the SVG
/// upright at the *content* geometry, rasterize, then rotate the raster by
/// `profile.rotation`. For the common `rotation == 0` desk panel this is a no-op.
pub fn render(widgets: &[Widget], profile: DeviceProfile) -> anyhow::Result<RenderedImage> {
    // 90°/270° swap the content axes: render the SVG at the transposed size so a
    // portrait dashboard fills a landscape panel after rotation.
    let quarter = (profile.rotation / 90) % 4;
    let (content_w, content_h) = if quarter == 1 || quarter == 3 {
        (profile.h, profile.w)
    } else {
        (profile.w, profile.h)
    };
    let content_profile = DeviceProfile {
        w: content_w,
        h: content_h,
        ..profile
    };
    let svg = build_svg(widgets, content_profile);
    let upright = rasterize(&svg, content_w, content_h)?;
    let pixmap = rotate_pixmap(&upright, quarter)?;
    let (bytes, content_type) = match profile.palette {
        Palette::Mono => (
            pack_1bit(&pixmap, profile.w, profile.h),
            "application/octet-stream",
        ),
        Palette::Rgb565 => (to_rgb565(&pixmap), "application/octet-stream"),
        Palette::Rgba => (encode_png(&pixmap, profile.w, profile.h)?, "image/png"),
    };
    Ok(RenderedImage {
        bytes,
        content_type,
        profile,
    })
}

/// Rotate a pixmap clockwise by `quarter * 90°`. `quarter == 0` clones (cheap path).
/// Returns a pixmap whose dimensions are swapped for 90°/270°.
fn rotate_pixmap(
    src: &resvg::tiny_skia::Pixmap,
    quarter: u16,
) -> anyhow::Result<resvg::tiny_skia::Pixmap> {
    use resvg::tiny_skia::Pixmap;
    if quarter == 0 {
        return Pixmap::from_vec(
            src.data().to_vec(),
            resvg::tiny_skia::IntSize::from_wh(src.width(), src.height())
                .ok_or_else(|| anyhow::anyhow!("bad pixmap size"))?,
        )
        .ok_or_else(|| anyhow::anyhow!("pixmap clone failed"));
    }
    let (sw, sh) = (src.width(), src.height());
    let (dw, dh) = if quarter == 1 || quarter == 3 {
        (sh, sw)
    } else {
        (sw, sh)
    };
    let mut dst = Pixmap::new(dw, dh).ok_or_else(|| anyhow::anyhow!("rotate alloc failed"))?;
    let src_px = src.pixels();
    let dst_px = dst.pixels_mut();
    for y in 0..sh {
        for x in 0..sw {
            let s = src_px[(y * sw + x) as usize];
            let (nx, ny) = match quarter {
                1 => (dw - 1 - y, x),          // 90° CW
                2 => (sw - 1 - x, sh - 1 - y), // 180°
                _ => (y, dh - 1 - x),          // 270° CW
            };
            dst_px[(ny * dw + nx) as usize] = s;
        }
    }
    Ok(dst)
}

/// A process-wide font database, loaded once. `usvg::Options::default()` ships an
/// EMPTY fontdb, so text would render as nothing — we must populate it with the
/// system fonts (and `load_system_fonts()` is slow, so it is cached here and the
/// `Arc` is cloned into each render's `Options`). On a headless box with no fonts
/// the text simply won't draw, but the layout/shapes still render.
fn font_db() -> std::sync::Arc<resvg::usvg::fontdb::Database> {
    use std::sync::OnceLock;
    static DB: OnceLock<std::sync::Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        // Map the generic families our SVG asks for to whatever the system has, so a
        // box without "Helvetica"/"Arial" still resolves a sans-serif face.
        db.set_sans_serif_family("Arial");
        std::sync::Arc::new(db)
    })
    .clone()
}

/// Rasterize an SVG string onto a premultiplied-RGBA pixmap of the given size.
fn rasterize(svg: &str, w: u32, h: u32) -> anyhow::Result<resvg::tiny_skia::Pixmap> {
    use resvg::tiny_skia::Pixmap;
    use resvg::usvg::{Options, Tree};
    let mut opts = Options::default();
    opts.fontdb = font_db();
    let tree = Tree::from_str(svg, &opts)
        .map_err(|e| anyhow::anyhow!("parsing dashboard SVG failed: {e}"))?;
    let mut pixmap =
        Pixmap::new(w.max(1), h.max(1)).ok_or_else(|| anyhow::anyhow!("pixmap alloc failed"))?;
    // White background already painted by the SVG; render the tree on top.
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    Ok(pixmap)
}

/// Encode a pixmap as a PNG (the LCD colour path).
fn encode_png(pixmap: &resvg::tiny_skia::Pixmap, w: u32, h: u32) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| anyhow::anyhow!("png header: {e}"))?;
        // tiny-skia stores premultiplied RGBA; PNG wants straight RGBA. Un-premultiply.
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for px in pixmap.pixels() {
            let a = px.alpha();
            let (r, g, b) = if a == 0 {
                (0, 0, 0)
            } else {
                let unmul = |c: u8| ((c as u16 * 255 + a as u16 / 2) / a as u16).min(255) as u8;
                (unmul(px.red()), unmul(px.green()), unmul(px.blue()))
            };
            data.extend_from_slice(&[r, g, b, a]);
        }
        writer
            .write_image_data(&data)
            .map_err(|e| anyhow::anyhow!("png data: {e}"))?;
    }
    Ok(out)
}

/// Pack a pixmap to the 1-bit e-ink byte format.
///
/// ## Byte format (NORMATIVE — agreed with the firmware `dash_client.h`)
///
/// - Row-major, top row first. Each row is `ceil(w / 8)` (= `(w + 7) / 8`) bytes
///   (rows are byte-aligned; a width not divisible by 8 pads the last byte's low
///   bits). Total length is `stride * h` bytes.
/// - Within a byte, **MSB is the leftmost pixel** (bit 7 = `x % 8 == 0`).
/// - **POLARITY (the one desync point both sides called out): bit `1` = WHITE,
///   bit `0` = BLACK.** This matches the Waveshare EPD convention the firmware
///   blits (a `0xFF` byte is a white row). The buffer is therefore initialized to
///   `0xFF` (all white) and ink pixels CLEAR their bit.
///
/// The greyscale value is the pixmap luminance composited over white; we threshold
/// via ordered (Bayer 4×4) dithering so photos/gradients render as stippled grey
/// rather than hard clipping.
pub fn pack_1bit(pixmap: &resvg::tiny_skia::Pixmap, w: u32, h: u32) -> Vec<u8> {
    // 4×4 Bayer threshold matrix scaled to 0..255.
    const BAYER: [[u8; 4]; 4] = [
        [0, 128, 32, 160],
        [192, 64, 224, 96],
        [48, 176, 16, 144],
        [240, 112, 208, 80],
    ];
    let row_bytes = w.div_ceil(8) as usize;
    // 0xFF = all-white rows; ink CLEARS bits (firmware polarity: 1=white, 0=black).
    let mut out = vec![0xFFu8; row_bytes * h as usize];
    let pixels = pixmap.pixels();
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let px = pixels[idx];
            let a = px.alpha() as u32;
            // Composite over white, then take luminance (Rec.601). tiny-skia is
            // premultiplied, so the stored channels are already `colour*alpha`.
            let lum_over_white = |c: u8| -> u32 { c as u32 + (255 - a) };
            let r = lum_over_white(px.red());
            let g = lum_over_white(px.green());
            let b = lum_over_white(px.blue());
            let lum = (r * 77 + g * 150 + b * 29) >> 8; // 0..255 (approx)
            let threshold = BAYER[(y % 4) as usize][(x % 4) as usize] as u32;
            // Below threshold ⇒ dark ⇒ ink ⇒ CLEAR the bit (0 = black).
            let ink = lum < threshold.max(1);
            if ink {
                let byte = (y as usize) * row_bytes + (x / 8) as usize;
                let bit = 7 - (x % 8) as u8;
                out[byte] &= !(1 << bit);
            }
        }
    }
    out
}

/// Pack a pixmap to **big-endian** RGB565 (an LCD framebuffer blit). 2 bytes/pixel,
/// row-major, `w * h * 2` bytes, no padding. Composited over white.
///
/// Byte order is big-endian (high byte first) to match the firmware `dash_client.h`
/// contract — any panel-specific byte swap is the board's job, not the renderer's.
pub fn to_rgb565(pixmap: &resvg::tiny_skia::Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixmap.pixels().len() * 2);
    for px in pixmap.pixels() {
        let a = px.alpha() as u32;
        let over = |c: u8| -> u32 { (c as u32 + (255 - a)).min(255) };
        let r = over(px.red());
        let g = over(px.green());
        let b = over(px.blue());
        let v: u16 = (((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) as u16;
        out.extend_from_slice(&v.to_be_bytes());
    }
    out
}

// ── Value → string helpers ───────────────────────────────────────────────────

/// Render a JSON scalar (or compact object) as a short display string.
fn scalar_string(v: &Value) -> String {
    match v {
        Value::Null => "—".to_string(),
        Value::Bool(b) => if *b { "Yes" } else { "No" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.len().to_string(),
        Value::Object(_) => compact_json(v),
    }
}

/// A single list row → a string. Strings/numbers pass through; objects show their
/// most title-like field.
fn row_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(map) => map
            .get("title")
            .or_else(|| map.get("name"))
            .or_else(|| map.get("label"))
            .or_else(|| map.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| compact_json(v)),
        other => scalar_string(other),
    }
}

/// Compact one-line JSON for fallback rendering.
fn compact_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// Truncate to `max` chars with an ellipsis (counts chars, not bytes).
fn truncate(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let take = max.saturating_sub(1).max(1);
    let mut out: String = s.chars().take(take).collect();
    out.push('…');
    out
}

/// Greedy word-wrap into lines of at most `cols` characters.
fn wrap(text: &str, cols: usize) -> Vec<String> {
    let cols = cols.max(1);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            if line.is_empty() {
                line.push_str(word);
            } else if line.chars().count() + 1 + word.chars().count() <= cols {
                line.push(' ');
                line.push_str(word);
            } else {
                lines.push(std::mem::take(&mut line));
                line.push_str(word);
            }
        }
        lines.push(line);
    }
    lines
}

/// Escape the five XML special chars so JSON text can't break the SVG document.
fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::{GridLayout, WidgetSource};
    use serde_json::json;

    fn widget(kind: WidgetKind, title: &str, value: Value, config: Value) -> Widget {
        Widget {
            id: "w".into(),
            dashboard_id: "d".into(),
            kind,
            title: title.into(),
            config,
            source: WidgetSource::Static { data: Value::Null },
            refresh_interval: None,
            layout: GridLayout {
                x: 0,
                y: 0,
                w: 12,
                h: 4,
            },
            last_value: Some(value),
            last_refresh_at: None,
            last_error: None,
        }
    }

    #[test]
    fn eink_pack_length_is_row_aligned() {
        // 800×480 1-bit = ceil(800/8)*480 = 100*480 = 48000 bytes.
        let profile = DeviceProfile::desk_eink();
        let w = vec![widget(WidgetKind::Stat, "Online", json!(42), json!({}))];
        let img = render(&w, profile).expect("render");
        assert_eq!(img.bytes.len(), 100 * 480);
        assert_eq!(img.content_type, "application/octet-stream");
    }

    #[test]
    fn non_byte_aligned_width_pads_rows() {
        // width 10 ⇒ ceil(10/8)=2 bytes/row.
        let profile = DeviceProfile {
            w: 10,
            h: 3,
            bit_depth: 1,
            palette: Palette::Mono,
            rotation: 0,
        };
        let img = render(&[], profile).expect("render");
        assert_eq!(img.bytes.len(), 2 * 3);
    }

    #[test]
    fn lcd_path_is_png() {
        let profile = DeviceProfile::watch_lcd();
        let w = vec![widget(
            WidgetKind::Text,
            "Note",
            json!("hello world"),
            json!({}),
        )];
        let img = render(&w, profile).expect("render");
        assert_eq!(img.content_type, "image/png");
        // PNG magic.
        assert_eq!(
            &img.bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        );
    }

    #[test]
    fn rgb565_length_is_two_bytes_per_pixel() {
        let profile = DeviceProfile {
            w: 16,
            h: 8,
            bit_depth: 16,
            palette: Palette::Rgb565,
            rotation: 0,
        };
        let img = render(&[], profile).expect("render");
        assert_eq!(img.bytes.len(), 16 * 8 * 2);
    }

    #[test]
    fn rev_changes_with_content() {
        let profile = DeviceProfile::desk_eink();
        let a = render(
            &[widget(WidgetKind::Stat, "A", json!(1), json!({}))],
            profile,
        )
        .unwrap()
        .rev();
        let b = render(
            &[widget(WidgetKind::Stat, "A", json!(999), json!({}))],
            profile,
        )
        .unwrap()
        .rev();
        assert_ne!(a, b, "different values must produce different revs");
    }

    #[test]
    fn svg_escapes_untrusted_text() {
        let svg = build_svg(
            &[widget(
                WidgetKind::Text,
                "T",
                json!("<script>&\"'"),
                json!({}),
            )],
            DeviceProfile::watch_lcd(),
        );
        assert!(!svg.contains("<script>"), "raw markup must be escaped");
        assert!(svg.contains("&lt;script&gt;") || svg.contains("&amp;"));
    }

    #[test]
    fn renderer_for_covers_every_kind() {
        for kind in [
            WidgetKind::Stat,
            WidgetKind::LineChart,
            WidgetKind::BarChart,
            WidgetKind::AreaChart,
            WidgetKind::PieChart,
            WidgetKind::Table,
            WidgetKind::List,
            WidgetKind::Text,
            WidgetKind::Map,
            WidgetKind::AgentFeed,
        ] {
            // Must not panic; every kind resolves to a renderer.
            let _ = renderer_for(kind);
        }
    }

    #[test]
    fn rotated_eink_keeps_panel_byte_length() {
        // A 90° panel renders the content transposed then rotates back to (w,h),
        // so the packed length still matches the panel geometry.
        let profile = DeviceProfile {
            w: 800,
            h: 480,
            bit_depth: 1,
            palette: Palette::Mono,
            rotation: 90,
        };
        let img = render(&[], profile).expect("render");
        assert_eq!(img.bytes.len(), 100 * 480);
    }

    #[test]
    fn mono_blank_is_all_white_bits() {
        // An empty 16×8 panel with no ink → every bit is 1 (white) per firmware
        // polarity (1 = white). 2 bytes/row * 8 rows, all 0xFF except where the
        // "No widgets" text draws — so at least the corner bytes are 0xFF.
        let profile = DeviceProfile {
            w: 16,
            h: 8,
            bit_depth: 1,
            palette: Palette::Mono,
            rotation: 0,
        };
        // No widgets draws a centered string; most of the panel stays white, so
        // at least one fully-white (0xFF) byte must exist (polarity: 1 = white).
        let img = render(&[], profile).expect("render");
        assert!(
            img.bytes.iter().any(|&b| b == 0xFF),
            "a mostly-blank mono panel must contain white (0xFF) bytes"
        );
    }

    #[test]
    fn wrap_breaks_on_width() {
        let lines = wrap("the quick brown fox jumps", 9);
        assert!(lines.len() >= 3);
        assert!(lines.iter().all(|l| l.chars().count() <= 9));
    }
}
