// ShowUI-2B ONNX model for vision grounding.
// Only compiled when the `ort` feature is enabled.
// Ported from apps/shadow/src/intelligence/grounding.rs.
//
// Model file expected at: ~/.ghost/models/showui-2b.onnx
// Download: https://huggingface.co/showlab/ShowUI-2B-ONNX

#[cfg(feature = "ort")]
pub mod showui {
    use anyhow::Result;
    use ort::session::{Session, builder::GraphOptimizationLevel};
    use ort::value::Tensor;
    use std::sync::Mutex;

    #[inline]
    fn oe(e: impl std::fmt::Display) -> anyhow::Error {
        anyhow::anyhow!("{}", e)
    }

    // ShowUI-2B expected input resolution
    const SHOWUI_W: u32 = 1280;
    const SHOWUI_H: u32 = 828;
    const SHOWUI_MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
    const SHOWUI_STD:  [f32; 3] = [0.26862954, 0.26130258, 0.27577711];

    /// Return the default model path: `~/.ghost/models/showui-2b.onnx`.
    pub fn default_model_path() -> std::path::PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".ghost")
            .join("models")
            .join("showui-2b.onnx")
    }

    pub struct ShowUIModel {
        session: Mutex<Session>,
    }

    impl ShowUIModel {
        /// Load the model from `~/.ghost/models/showui-2b.onnx`.
        pub fn load() -> Result<Self> {
            let path = default_model_path();
            if !path.exists() {
                anyhow::bail!(
                    "ShowUI-2B model not found at {:?}. \
                     Download from https://huggingface.co/showlab/ShowUI-2B-ONNX \
                     and place at ~/.ghost/models/showui-2b.onnx",
                    path
                );
            }
            tracing::info!("Loading ShowUI-2B from {:?}", path);
            let session = Session::builder()
                .map_err(oe)?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(oe)?
                .with_intra_threads(4)
                .map_err(oe)?
                .commit_from_file(&path)
                .map_err(|e| anyhow::anyhow!("Failed to load ShowUI-2B: {}", e))?;
            tracing::info!("ShowUI-2B loaded");
            Ok(Self { session: Mutex::new(session) })
        }

        /// Run grounding: BGRA screenshot + text instruction → normalised (x, y).
        ///
        /// Returns coordinates clamped to [0.0, 1.0]. Multiply by image width/height
        /// to get pixel coordinates.
        pub fn run(&self, bgra: &[u8], width: u32, height: u32, instruction: &str) -> Result<GroundingOutput> {
            let img_pixels = bgra_to_chw(bgra, width, height)?;
            let img_tensor = Tensor::<f32>::from_array((
                [1usize, 3, SHOWUI_H as usize, SHOWUI_W as usize],
                img_pixels,
            ))
            .map_err(|e| anyhow::anyhow!("image tensor: {}", e))?;

            // Encode instruction as UTF-8 bytes padded / truncated to 256 tokens
            let text_tokens: Vec<i64> = instruction
                .bytes()
                .take(255)
                .map(|b| b as i64)
                .chain(std::iter::repeat(0))
                .take(256)
                .collect();
            let text_tensor = Tensor::<i64>::from_array(([1usize, 256], text_tokens))
                .map_err(|e| anyhow::anyhow!("text tensor: {}", e))?;

            let mut guard = self
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("ShowUI session mutex poisoned"))?;
            let outputs = guard
                .run(ort::inputs![
                    "image"       => &img_tensor,
                    "instruction" => &text_tensor
                ])
                .map_err(|e| anyhow::anyhow!("ShowUI inference failed: {}", e))?;

            // Model outputs [1, 2] float tensor: [norm_x, norm_y]
            let (_, flat) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| anyhow::anyhow!("ShowUI output extraction failed: {}", e))?;
            if flat.len() < 2 {
                anyhow::bail!("ShowUI returned unexpected output shape (expected [1,2])");
            }
            Ok(GroundingOutput {
                x: flat[0].clamp(0.0, 1.0),
                y: flat[1].clamp(0.0, 1.0),
                confidence: 0.75,
            })
        }
    }

    /// Normalised coordinate result from ShowUI grounding.
    #[derive(Debug, Clone)]
    pub struct GroundingOutput {
        /// Normalised x in [0.0, 1.0]. Multiply by screen width for pixels.
        pub x: f32,
        /// Normalised y in [0.0, 1.0]. Multiply by screen height for pixels.
        pub y: f32,
        pub confidence: f32,
    }

    /// Convert BGRA raw pixels to CHW f32 tensor, resized to ShowUI resolution,
    /// normalised with ImageNet mean/std.
    fn bgra_to_chw(bgra: &[u8], width: u32, height: u32) -> Result<Vec<f32>> {
        // image crate treats BGRA as RGBA when building from raw bytes, so swap B↔R
        let mut rgba = bgra.to_vec();
        for chunk in rgba.chunks_exact_mut(4) {
            chunk.swap(0, 2); // B↔R
        }
        let img = image::RgbaImage::from_raw(width, height, rgba)
            .ok_or_else(|| anyhow::anyhow!("BGRA→RgbaImage failed (buffer size mismatch)"))?;
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
}
