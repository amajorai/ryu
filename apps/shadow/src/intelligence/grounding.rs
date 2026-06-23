use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroundingResult {
    pub x: f32,
    pub y: f32,
    pub confidence: f32,
    pub strategy: GroundingStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GroundingStrategy {
    AxExact,
    AxFuzzy,
    LocalVlm,
    CloudVision,
}

// ─── ShowUI-2B ONNX model (requires `ort` feature) ───────────────────────────

#[cfg(feature = "ort")]
mod showui {
    use super::*;
    use ort::session::{builder::GraphOptimizationLevel, Session};
    use ort::value::Tensor;
    use std::path::Path;
    use std::sync::Mutex;

    #[inline]
    fn oe(e: impl std::fmt::Display) -> anyhow::Error {
        anyhow::anyhow!("{}", e)
    }

    // ShowUI-2B expected input resolution
    const SHOWUI_W: u32 = 1280;
    const SHOWUI_H: u32 = 828;
    const SHOWUI_MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
    const SHOWUI_STD: [f32; 3] = [0.26862954, 0.26130258, 0.27577711];

    pub struct ShowUIModel {
        session: Mutex<Session>,
    }

    impl ShowUIModel {
        pub fn load(model_path: &Path) -> Result<Self> {
            tracing::info!("Loading ShowUI-2B model from {:?}", model_path);
            let session = Session::builder()
                .map_err(oe)?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(oe)?
                .with_intra_threads(4)
                .map_err(oe)?
                .commit_from_file(model_path)
                .map_err(|e| anyhow::anyhow!("Failed to load ShowUI-2B ONNX model: {}", e))?;
            tracing::info!("ShowUI-2B loaded");
            Ok(Self {
                session: Mutex::new(session),
            })
        }

        /// Run grounding: screenshot (BGRA) + instruction → normalised (x, y).
        pub async fn ground(
            &self,
            screenshot: &[u8],
            width: u32,
            height: u32,
            instruction: &str,
        ) -> Result<GroundingResult> {
            let img_pixels = bgra_to_pixels(screenshot, width, height)?;
            let img_tensor = Tensor::<f32>::from_array((
                [1usize, 3, SHOWUI_H as usize, SHOWUI_W as usize],
                img_pixels,
            ))
            .map_err(|e| anyhow::anyhow!("ShowUI image tensor: {}", e))?;

            // Encode instruction as UTF-8 bytes padded to 256 tokens
            let text_tokens: Vec<i64> = instruction
                .bytes()
                .take(255)
                .map(|b| b as i64)
                .chain(std::iter::repeat(0))
                .take(256)
                .collect();
            let text_tensor = Tensor::<i64>::from_array(([1usize, 256], text_tokens))
                .map_err(|e| anyhow::anyhow!("ShowUI text tensor: {}", e))?;

            let mut guard = self
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("ShowUI session mutex poisoned"))?;
            let outputs = guard
                .run(ort::inputs![
                    "image"       => &img_tensor,
                    "instruction" => &text_tensor
                ])
                .map_err(|e| anyhow::anyhow!("ShowUI-2B inference failed: {}", e))?;

            // Model outputs a [1, 2] float tensor: [norm_x, norm_y]
            let (_, flat) = outputs[0].try_extract_tensor::<f32>().map_err(|e| {
                anyhow::anyhow!("ShowUI-2B: failed to extract coordinate tensor: {}", e)
            })?;
            if flat.len() < 2 {
                anyhow::bail!("ShowUI-2B returned unexpected output shape");
            }

            Ok(GroundingResult {
                x: flat[0].clamp(0.0, 1.0),
                y: flat[1].clamp(0.0, 1.0),
                confidence: 0.75,
                strategy: GroundingStrategy::LocalVlm,
            })
        }
    }

    /// Convert BGRA raw pixels → CHW f32 Vec normalised with ImageNet stats,
    /// resized to ShowUI resolution.
    fn bgra_to_pixels(bgra: &[u8], width: u32, height: u32) -> Result<Vec<f32>> {
        let img = image::RgbaImage::from_raw(width, height, bgra.to_vec())
            .ok_or_else(|| anyhow::anyhow!("BGRA→RgbaImage failed"))?;
        let rgb = image::DynamicImage::ImageRgba8(img)
            .resize_exact(SHOWUI_W, SHOWUI_H, image::imageops::FilterType::Lanczos3)
            .to_rgb8();

        let w = SHOWUI_W as usize;
        let h = SHOWUI_H as usize;
        let mut out = vec![0.0f32; 3 * h * w];
        for (x, y, pixel) in rgb.enumerate_pixels() {
            let yi = y as usize;
            let xi = x as usize;
            for c in 0..3usize {
                out[c * h * w + yi * w + xi] =
                    (pixel[c] as f32 / 255.0 - SHOWUI_MEAN[c]) / SHOWUI_STD[c];
            }
        }
        Ok(out)
    }

    pub use ShowUIModel as ShowUI;
}

// ─── AX-based grounding helpers ───────────────────────────────────────────────

/// Try to find an element in the accessibility tree that matches `query` exactly.
/// Returns normalised (x, y) center coordinates if found.
async fn try_ax_exact(query: &str, screen_w: u32, screen_h: u32) -> Option<GroundingResult> {
    use crate::capture::accessibility::{AXTree, PlatformAXTree};
    let ax = PlatformAXTree::new().ok()?;
    let element = ax.find_element(query).await?;
    let bounds = element.bounds?;
    let cx = bounds.x + bounds.width as i32 / 2;
    let cy = bounds.y + bounds.height as i32 / 2;
    Some(GroundingResult {
        x: (cx as f32 / screen_w as f32).clamp(0.0, 1.0),
        y: (cy as f32 / screen_h as f32).clamp(0.0, 1.0),
        confidence: 0.95,
        strategy: GroundingStrategy::AxExact,
    })
}

/// Fuzzy AX match: walk the full tree and pick the element whose title/role
/// has the highest token overlap with the query.
async fn try_ax_fuzzy(query: &str, screen_w: u32, screen_h: u32) -> Option<GroundingResult> {
    use crate::capture::accessibility::{AXTree, AXTreeNode, PlatformAXTree};

    let ax = PlatformAXTree::new().ok()?;
    let tree = ax.get_focused_tree().await.ok()?;

    let query_lower = query.to_lowercase();
    let query_tokens: Vec<&str> = query_lower.split_whitespace().collect();

    let mut best_score = 0.0f32;
    let mut best: Option<GroundingResult> = None;

    fn walk(
        node: &AXTreeNode,
        query_tokens: &[&str],
        screen_w: u32,
        screen_h: u32,
        best_score: &mut f32,
        best: &mut Option<GroundingResult>,
    ) {
        let text = format!(
            "{} {} {}",
            node.role,
            node.title.as_deref().unwrap_or(""),
            node.value.as_deref().unwrap_or("")
        )
        .to_lowercase();

        let matched = query_tokens.iter().filter(|&&t| text.contains(t)).count();
        let score = matched as f32 / query_tokens.len().max(1) as f32;

        if score > *best_score {
            if let Some(ref b) = node.bounds {
                let cx = b.x + b.width as i32 / 2;
                let cy = b.y + b.height as i32 / 2;
                *best_score = score;
                *best = Some(GroundingResult {
                    x: (cx as f32 / screen_w as f32).clamp(0.0, 1.0),
                    y: (cy as f32 / screen_h as f32).clamp(0.0, 1.0),
                    confidence: 0.5 + score * 0.4,
                    strategy: GroundingStrategy::AxFuzzy,
                });
            }
        }

        for child in &node.children {
            walk(child, query_tokens, screen_w, screen_h, best_score, best);
        }
    }

    walk(
        &tree,
        &query_tokens,
        screen_w,
        screen_h,
        &mut best_score,
        &mut best,
    );

    // Only accept if at least half the query tokens matched
    if best_score >= 0.5 {
        best
    } else {
        None
    }
}

// ─── Grounding oracle ─────────────────────────────────────────────────────────

/// Multi-strategy grounding oracle.
/// Cascade: AX exact → AX fuzzy → ShowUI-2B (local VLM) → error
pub struct GroundingOracle {
    #[cfg(feature = "ort")]
    showui: Option<showui::ShowUI>,
    vlm_threshold: f32,
}

impl GroundingOracle {
    pub fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(feature = "ort")]
            showui: None,
            vlm_threshold: 0.30,
        })
    }

    /// Load ShowUI-2B model (optional; if not called, the local VLM stage is skipped).
    #[cfg(feature = "ort")]
    pub async fn load_showui(&mut self, model_path: &std::path::Path) -> Result<()> {
        self.showui = Some(showui::ShowUI::load(model_path)?);
        tracing::info!("Grounding oracle: ShowUI-2B ready");
        Ok(())
    }

    /// Ground an instruction against the current screen.
    ///
    /// `screenshot` must be BGRA raw pixel data of dimensions `width` × `height`.
    /// Pass `&[]` to skip ShowUI and rely only on the AX cascade.
    pub async fn ground(
        &self,
        instruction: &str,
        screenshot: &[u8],
        width: u32,
        height: u32,
    ) -> Result<GroundingResult> {
        // 1. AX exact match — near-zero latency, highest confidence
        if let Some(r) = try_ax_exact(instruction, width, height).await {
            tracing::debug!("Grounding: AX exact hit for {:?}", instruction);
            return Ok(r);
        }

        // 2. AX fuzzy match — still free, covers partial descriptions
        if let Some(r) = try_ax_fuzzy(instruction, width, height).await {
            tracing::debug!(
                "Grounding: AX fuzzy hit for {:?} (conf={:.2})",
                instruction,
                r.confidence
            );
            return Ok(r);
        }

        // 3. ShowUI-2B local VLM (~300 ms)
        #[cfg(feature = "ort")]
        if let Some(ref model) = self.showui {
            if !screenshot.is_empty() {
                match model.ground(screenshot, width, height, instruction).await {
                    Ok(r) if r.confidence >= self.vlm_threshold => {
                        tracing::debug!("Grounding: ShowUI-2B hit for {:?}", instruction);
                        return Ok(r);
                    }
                    Ok(r) => tracing::debug!(
                        "Grounding: ShowUI-2B below threshold ({:.2}) for {:?}",
                        r.confidence,
                        instruction
                    ),
                    Err(e) => tracing::warn!("ShowUI-2B error: {}", e),
                }
            }
        }

        anyhow::bail!(
            "Grounding failed: no strategy found a match for {:?}",
            instruction
        )
    }
}

impl Default for GroundingOracle {
    fn default() -> Self {
        Self::new().expect("Failed to create GroundingOracle")
    }
}

/// Parse normalised coordinates from LLM / VLM text output.
/// Handles [x, y], (x, y), click(x=N, y=N) formats.
pub fn parse_coordinates(output: &str) -> Option<(f32, f32)> {
    let patterns: &[&str] = &[
        r"\[(\d+\.?\d*),\s*(\d+\.?\d*)\]",
        r"\((\d+\.?\d*),\s*(\d+\.?\d*)\)",
        r"click\(x=(\d+\.?\d*),\s*y=(\d+\.?\d*)\)",
    ];
    for pat in patterns {
        if let Some(caps) = regex::Regex::new(pat).ok()?.captures(output) {
            let x: f32 = caps.get(1)?.as_str().parse().ok()?;
            let y: f32 = caps.get(2)?.as_str().parse().ok()?;
            return Some((x, y));
        }
    }
    None
}
