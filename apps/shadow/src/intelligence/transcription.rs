use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub segments: Vec<TranscriptSegment>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub start_ts: u64,
    pub end_ts: u64,
    pub text: String,
    pub words: Vec<WordTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTimestamp {
    pub word: String,
    pub start_ts: u64,
    pub end_ts: u64,
}

// ─── whisper-rs implementation ────────────────────────────────────────────────

#[cfg(feature = "whisper-rs")]
mod whisper_impl {
    use super::*;
    use anyhow::Context;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    /// Whisper transcription backed by whisper.cpp via whisper-rs.
    pub struct Transcriber {
        ctx: Arc<WhisperContext>,
        model_path: String,
    }

    impl Transcriber {
        /// Load a Whisper ggml model (e.g. `ggml-tiny.bin`, `ggml-base.bin`).
        pub fn new(model_path: &str) -> Result<Self> {
            tracing::info!("Loading Whisper model from {}", model_path);
            let ctx =
                WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                    .with_context(|| format!("Failed to load Whisper model from {}", model_path))?;
            tracing::info!("Whisper model loaded");
            Ok(Self {
                ctx: Arc::new(ctx),
                model_path: model_path.to_string(),
            })
        }

        /// Transcribe a WAV audio file.
        ///
        /// The file is automatically converted to 16 kHz mono f32 PCM as required
        /// by Whisper. Returns word-level timestamps when the model supports them.
        pub async fn transcribe(&self, audio_path: &str) -> Result<Transcript> {
            let path = audio_path.to_string();
            let ctx = Arc::clone(&self.ctx);

            tokio::task::spawn_blocking(move || transcribe_sync(&ctx, &path))
                .await
                .context("Whisper transcription panicked")?
        }
    }

    fn transcribe_sync(ctx: &WhisperContext, audio_path: &str) -> Result<Transcript> {
        // ── 1. Load audio ──────────────────────────────────────────────────────
        let samples = load_audio_16khz(audio_path)
            .with_context(|| format!("Failed to load audio file: {}", audio_path))?;

        if samples.is_empty() {
            return Ok(Transcript {
                segments: vec![],
                text: String::new(),
            });
        }

        // ── 2. Configure Whisper ───────────────────────────────────────────────
        let mut state = ctx
            .create_state()
            .context("Failed to create Whisper state")?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_token_timestamps(true);
        params.set_max_len(0); // no sentence-length cap
        params.set_split_on_word(true); // better word boundaries
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        // ── 3. Run inference ───────────────────────────────────────────────────
        state
            .full(params, &samples)
            .context("Whisper inference failed")?;

        // ── 4. Extract segments + word timestamps ──────────────────────────────
        let n_segments = state
            .full_n_segments()
            .context("Failed to get segment count")?;

        let mut segments = Vec::with_capacity(n_segments as usize);
        let mut full_text = String::new();

        for seg_idx in 0..n_segments {
            let seg_text = state
                .full_get_segment_text(seg_idx)
                .with_context(|| format!("Segment {} text", seg_idx))?;
            // Whisper timestamps are in centiseconds → convert to microseconds
            let t0 = state.full_get_segment_t0(seg_idx)? as u64 * 10_000;
            let t1 = state.full_get_segment_t1(seg_idx)? as u64 * 10_000;

            // Word-level timestamps from tokens
            let n_tokens = state.full_n_tokens(seg_idx).unwrap_or(0);
            let mut words = Vec::new();
            let mut cur_word = String::new();
            let mut cur_start = t0;

            for tok_idx in 0..n_tokens {
                let tok_text = state
                    .full_get_token_text(seg_idx, tok_idx)
                    .unwrap_or_default();
                let tok_data = state.full_get_token_data(seg_idx, tok_idx).ok();

                let tok_start_us = tok_data
                    .as_ref()
                    .map(|d| d.t0 as u64 * 10_000)
                    .unwrap_or(cur_start);
                let tok_end_us = tok_data
                    .as_ref()
                    .map(|d| d.t1 as u64 * 10_000)
                    .unwrap_or(t1);

                // Special tokens start with '[' (e.g. [_BEG_], [_TT_N]) — skip
                if tok_text.starts_with('[') && tok_text.ends_with(']') {
                    continue;
                }

                // A leading space signals the start of a new word in CLIP/Whisper tokenisation
                if tok_text.starts_with(' ') && !cur_word.is_empty() {
                    words.push(WordTimestamp {
                        word: cur_word.trim().to_string(),
                        start_ts: cur_start,
                        end_ts: tok_start_us,
                    });
                    cur_word = tok_text.trim_start().to_string();
                    cur_start = tok_start_us;
                } else {
                    if cur_word.is_empty() {
                        cur_start = tok_start_us;
                    }
                    cur_word.push_str(tok_text.trim_start());
                }

                // Flush on last token of segment
                if tok_idx == n_tokens - 1 && !cur_word.is_empty() {
                    words.push(WordTimestamp {
                        word: cur_word.trim().to_string(),
                        start_ts: cur_start,
                        end_ts: tok_end_us,
                    });
                    cur_word = String::new();
                }
            }

            full_text.push_str(&seg_text);
            segments.push(TranscriptSegment {
                start_ts: t0,
                end_ts: t1,
                text: seg_text.trim().to_string(),
                words,
            });
        }

        Ok(Transcript {
            segments,
            text: full_text.trim().to_string(),
        })
    }

    /// Load a WAV file and return 16 kHz mono f32 PCM samples.
    ///
    /// Handles stereo→mono downmix and nearest-neighbour sample-rate conversion
    /// for files recorded at rates other than 16 kHz.
    fn load_audio_16khz(path: &str) -> Result<Vec<f32>> {
        let mut reader =
            hound::WavReader::open(path).with_context(|| format!("Cannot open WAV: {}", path))?;
        let spec = reader.spec();

        // Decode to f32 regardless of on-disk format
        let raw: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
            hound::SampleFormat::Int => match spec.bits_per_sample {
                16 => reader
                    .samples::<i16>()
                    .filter_map(|s| s.ok())
                    .map(|s| s as f32 / i16::MAX as f32)
                    .collect(),
                32 => reader
                    .samples::<i32>()
                    .filter_map(|s| s.ok())
                    .map(|s| s as f32 / i32::MAX as f32)
                    .collect(),
                _ => reader
                    .samples::<i16>()
                    .filter_map(|s| s.ok())
                    .map(|s| s as f32 / i16::MAX as f32)
                    .collect(),
            },
        };

        let channels = spec.channels as usize;
        let src_rate = spec.sample_rate;

        // Downmix to mono
        let mono: Vec<f32> = if channels == 1 {
            raw
        } else {
            raw.chunks(channels)
                .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                .collect()
        };

        // Resample to 16 kHz if necessary
        if src_rate == 16_000 {
            return Ok(mono);
        }

        // Linear interpolation resample
        let ratio = src_rate as f64 / 16_000.0;
        let out_len = (mono.len() as f64 / ratio).ceil() as usize;
        let mut resampled = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_pos = i as f64 * ratio;
            let src_idx = src_pos as usize;
            let frac = (src_pos - src_idx as f64) as f32;
            let a = mono.get(src_idx).copied().unwrap_or(0.0);
            let b = mono.get(src_idx + 1).copied().unwrap_or(0.0);
            resampled.push(a + (b - a) * frac);
        }
        Ok(resampled)
    }

    impl Default for Transcriber {
        fn default() -> Self {
            panic!("Transcriber requires a model path; use Transcriber::new(path)");
        }
    }
}

#[cfg(feature = "whisper-rs")]
pub use whisper_impl::Transcriber;
