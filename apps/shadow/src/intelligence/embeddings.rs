use serde::Serialize;

/// 512-dimensional CLIP embedding.
#[derive(Debug, Clone)]
pub struct Embedding(pub [f32; 512]);

impl Serialize for Embedding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(512))?;
        for item in &self.0 {
            seq.serialize_element(item)?;
        }
        seq.end()
    }
}

/// Calculate cosine similarity between two embeddings.
pub fn cosine_similarity(a: &Embedding, b: &Embedding) -> f32 {
    let dot: f32 = a.0.iter().zip(b.0.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.0.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.0.iter().map(|x| x * x).sum::<f32>().sqrt();

    if mag_a == 0.0 || mag_b == 0.0 {
        0.0
    } else {
        dot / (mag_a * mag_b)
    }
}

#[cfg(feature = "ort")]
mod ort_impl {
    use super::*;
    use anyhow::{Context, Result};
    use ort::session::{builder::GraphOptimizationLevel, Session};
    use ort::value::Tensor;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    /// Convert an ort error (which is !Send) into a Send+Sync anyhow error.
    #[inline]
    fn oe(e: impl std::fmt::Display) -> anyhow::Error {
        anyhow::anyhow!("{}", e)
    }

    // CLIP-ViT-B/32 / MobileCLIP-S2 constants
    const CLIP_IMAGE_SIZE: u32 = 224;
    const CLIP_TOKEN_LEN: usize = 77;
    const MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
    const STD: [f32; 3] = [0.26862954, 0.26130258, 0.27577711];

    /// CLIP encoder backed by two ONNX sessions (image + text).
    /// Sessions are wrapped in Mutex because `Session::run` requires `&mut self`.
    pub struct CLIPEncoder {
        image_session: Option<Mutex<Session>>,
        text_session: Option<Mutex<Session>>,
        tokenizer: Option<ClipTokenizer>,
    }

    impl CLIPEncoder {
        pub fn new() -> Result<Self> {
            Ok(Self {
                image_session: None,
                text_session: None,
                tokenizer: None,
            })
        }

        /// Load CLIP ONNX models from a directory.
        ///
        /// Expected layout:
        ///   <dir>/visual.onnx   — image encoder  input: [1, 3, 224, 224] f32
        ///   <dir>/textual.onnx  — text encoder   inputs: input_ids [1,77] i64 + attention_mask [1,77] i64
        ///   <dir>/vocab.txt     — BPE merge file (optional; falls back to byte-level)
        pub async fn load_model(&mut self, model_dir: &str) -> Result<()> {
            let dir = Path::new(model_dir);
            let vis = dir.join("visual.onnx");
            let txt = dir.join("textual.onnx");

            if vis.exists() {
                let s = Session::builder()
                    .map_err(oe)?
                    .with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(oe)?
                    .with_intra_threads(4)
                    .map_err(oe)?
                    .commit_from_file(&vis)
                    .map_err(|e| anyhow::anyhow!("CLIP visual model {:?}: {}", vis, e))?;
                self.image_session = Some(Mutex::new(s));
                tracing::info!("CLIP visual encoder loaded from {:?}", vis);
            }

            if txt.exists() {
                let s = Session::builder()
                    .map_err(oe)?
                    .with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(oe)?
                    .with_intra_threads(4)
                    .map_err(oe)?
                    .commit_from_file(&txt)
                    .map_err(|e| anyhow::anyhow!("CLIP text model {:?}: {}", txt, e))?;
                self.text_session = Some(Mutex::new(s));
                tracing::info!("CLIP text encoder loaded from {:?}", txt);
            }

            self.tokenizer = Some(ClipTokenizer::load_or_default(&dir.join("vocab.txt")));
            Ok(())
        }

        /// Encode raw image bytes (any format decodable by the `image` crate) → 512-dim embedding.
        pub async fn encode_image(&self, image_bytes: &[u8]) -> Result<Embedding> {
            let mtx = self
                .image_session
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("CLIP image session not loaded"))?;

            let sz = CLIP_IMAGE_SIZE as usize;
            let pixels = preprocess_image(image_bytes, CLIP_IMAGE_SIZE)?;
            let tensor = Tensor::<f32>::from_array(([1usize, 3, sz, sz], pixels))
                .map_err(|e| anyhow::anyhow!("CLIP image tensor: {}", e))?;

            let mut guard = mtx
                .lock()
                .map_err(|_| anyhow::anyhow!("Session mutex poisoned"))?;
            let outputs = guard
                .run(ort::inputs!["image" => &tensor])
                .map_err(|e| anyhow::anyhow!("CLIP image inference: {}", e))?;
            let (_, raw) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| anyhow::anyhow!("CLIP image output extraction: {}", e))?;
            Ok(l2_normalise(raw))
        }

        /// Encode a text string → 512-dim embedding.
        pub async fn encode_text(&self, text: &str) -> Result<Embedding> {
            let mtx = self
                .text_session
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("CLIP text session not loaded"))?;
            let tok = self
                .tokenizer
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("CLIP tokenizer not loaded"))?;

            let (ids_u32, mask_u32) = tok.tokenize(text, CLIP_TOKEN_LEN);
            let ids: Vec<i64> = ids_u32.into_iter().map(|x| x as i64).collect();
            let mask: Vec<i64> = mask_u32.into_iter().map(|x| x as i64).collect();

            let id_tensor = Tensor::<i64>::from_array(([1usize, CLIP_TOKEN_LEN], ids))
                .map_err(|e| anyhow::anyhow!("CLIP id tensor: {}", e))?;
            let mask_tensor = Tensor::<i64>::from_array(([1usize, CLIP_TOKEN_LEN], mask))
                .map_err(|e| anyhow::anyhow!("CLIP mask tensor: {}", e))?;

            let mut guard = mtx
                .lock()
                .map_err(|_| anyhow::anyhow!("Session mutex poisoned"))?;
            let outputs = guard
                .run(ort::inputs![
                    "input_ids"      => &id_tensor,
                    "attention_mask" => &mask_tensor
                ])
                .map_err(|e| anyhow::anyhow!("CLIP text inference: {}", e))?;
            let (_, raw) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| anyhow::anyhow!("CLIP text output extraction: {}", e))?;
            Ok(l2_normalise(raw))
        }
    }

    /// Decode + resize to `size`×`size` RGB, then CHW normalise with ImageNet stats.
    fn preprocess_image(bytes: &[u8], size: u32) -> Result<Vec<f32>> {
        let img = image::load_from_memory(bytes).context("Image decode")?;
        let rgb = img
            .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
            .to_rgb8();
        let n = size as usize;
        let mut out = vec![0.0f32; 3 * n * n]; // CHW layout
        for (x, y, pixel) in rgb.enumerate_pixels() {
            let yi = y as usize;
            let xi = x as usize;
            for c in 0..3usize {
                out[c * n * n + yi * n + xi] = (pixel[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
        Ok(out)
    }

    /// L2-normalise a flat float slice into a 512-dim Embedding.
    fn l2_normalise(raw: &[f32]) -> Embedding {
        let mut emb = [0.0f32; 512];
        let len = raw.len().min(512);
        emb[..len].copy_from_slice(&raw[..len]);
        let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-8);
        for v in &mut emb {
            *v /= norm;
        }
        Embedding(emb)
    }

    // ── CLIP BPE Tokenizer ─────────────────────────────────────────────────────

    /// CLIP BPE tokenizer.
    ///
    /// Loads `bpe_simple_vocab_16e6.txt` (the merge file shipped with CLIP).
    /// Falls back to byte-level encoding when the file is absent — embeddings
    /// will be lower-quality but the shape/dtype contract is still respected.
    pub struct ClipTokenizer {
        token_to_id: HashMap<String, u32>,
        bpe_ranks: HashMap<(String, String), usize>,
        sot: u32, // 49406 <|startoftext|>
        eot: u32, // 49407 <|endoftext|>
        byte_level: bool,
    }

    impl ClipTokenizer {
        pub fn load_or_default(vocab_path: &Path) -> Self {
            if vocab_path.exists() {
                Self::load(vocab_path).unwrap_or_else(|e| {
                    tracing::warn!("CLIP vocab load failed ({}), byte-level fallback", e);
                    Self::fallback()
                })
            } else {
                Self::fallback()
            }
        }

        fn fallback() -> Self {
            Self {
                token_to_id: HashMap::new(),
                bpe_ranks: HashMap::new(),
                sot: 49406,
                eot: 49407,
                byte_level: true,
            }
        }

        fn load(path: &Path) -> Result<Self> {
            let text =
                std::fs::read_to_string(path).with_context(|| format!("Cannot read {:?}", path))?;

            let b2u = clip_bytes_to_unicode();
            let mut token_to_id: HashMap<String, u32> = HashMap::new();
            for (&b, &c) in &b2u {
                token_to_id.insert(c.to_string(), b as u32);
            }

            let mut bpe_ranks: HashMap<(String, String), usize> = HashMap::new();
            let mut rank = 0usize;
            for line in text.lines() {
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let mut parts = line.splitn(2, ' ');
                if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
                    bpe_ranks.insert((a.to_string(), b.to_string()), rank);
                    rank += 1;
                    let merged = format!("{}{}", a, b);
                    let next_id = (token_to_id.len() + 256) as u32;
                    token_to_id.entry(merged).or_insert(next_id);
                }
            }

            Ok(Self {
                token_to_id,
                bpe_ranks,
                sot: 49406,
                eot: 49407,
                byte_level: false,
            })
        }

        pub fn tokenize(&self, text: &str, max_len: usize) -> (Vec<u32>, Vec<u32>) {
            let toks = if self.byte_level {
                text.bytes()
                    .take(max_len.saturating_sub(2))
                    .map(|b| b as u32)
                    .collect()
            } else {
                self.bpe_encode(text, max_len.saturating_sub(2))
            };

            let mut ids = Vec::with_capacity(max_len);
            ids.push(self.sot);
            ids.extend(toks);
            ids.push(self.eot);
            ids.truncate(max_len);

            let used = ids.len();
            ids.resize(max_len, 0);
            let mut mask = vec![0u32; max_len];
            for m in mask.iter_mut().take(used) {
                *m = 1;
            }
            (ids, mask)
        }

        fn bpe_encode(&self, text: &str, max_tokens: usize) -> Vec<u32> {
            let b2u = clip_bytes_to_unicode();
            let lower = text.to_lowercase();

            // Build initial char list; mark word-end with </w>
            let bytes: Vec<u8> = lower.bytes().collect();
            if bytes.is_empty() {
                return vec![];
            }

            let mut tokens: Vec<String> = bytes
                .iter()
                .enumerate()
                .map(|(i, &b)| {
                    let ch = b2u.get(&b).map(|c| c.to_string()).unwrap_or_default();
                    if i + 1 == bytes.len() || bytes[i + 1] == b' ' {
                        format!("{}</w>", ch)
                    } else {
                        ch
                    }
                })
                .collect();

            // Iteratively apply the highest-priority BPE merge
            loop {
                if tokens.len() < 2 {
                    break;
                }
                let best = tokens
                    .windows(2)
                    .enumerate()
                    .filter_map(|(i, p)| {
                        self.bpe_ranks
                            .get(&(p[0].clone(), p[1].clone()))
                            .map(|&r| (i, r))
                    })
                    .min_by_key(|&(_, r)| r);

                let (pos, _) = match best {
                    Some(b) => b,
                    None => break,
                };
                let merged = format!("{}{}", tokens[pos], tokens[pos + 1]);
                tokens.remove(pos + 1);
                tokens[pos] = merged;
            }

            tokens
                .iter()
                .take(max_tokens)
                .filter_map(|t| self.token_to_id.get(t).copied())
                .collect()
        }
    }

    /// CLIP's byte-to-unicode mapping (matches the Python reference implementation).
    fn clip_bytes_to_unicode() -> HashMap<u8, char> {
        let mut map = HashMap::new();
        let mut n = 0u32;
        for b in 0u8..=255 {
            let c = b as char;
            if (c >= '!' && c <= '~')
                || (c >= '\u{00A1}' && c <= '\u{00AC}')
                || (c >= '\u{00AE}' && c <= '\u{00FF}')
            {
                map.insert(b, c);
            } else {
                map.insert(b, char::from_u32(256 + n).unwrap_or('\u{FFFD}'));
                n += 1;
            }
        }
        map
    }

    impl Default for CLIPEncoder {
        fn default() -> Self {
            Self::new().expect("CLIPEncoder")
        }
    }
}

#[cfg(feature = "ort")]
pub use ort_impl::CLIPEncoder;
