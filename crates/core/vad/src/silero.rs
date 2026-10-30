//! Silero VAD ONNX backend (feature `voice-vad`), via transcribe-rs's tested
//! `SileroVad`. Our gate feeds 256-sample hops but Silero needs 480-sample
//! windows, so we buffer hops into windows and cache the last windowed
//! probability for the hops in between.
//!
//! Intel macOS (`x86_64-apple-darwin`) has no ONNX Runtime build, so Cargo.toml
//! declares transcribe-rs for every other target only. There `voice-vad` still
//! resolves but this module compiles [`SileroModel`] as a stub whose `load()`
//! fails, and [`crate::Vad`] runs the always-compiled energy backend.

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub use onnx::SileroModel;
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub use unavailable::SileroModel;

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod onnx {
    use anyhow::{Context, Result};
    use transcribe_rs::vad::SileroVad;

    use crate::silero_model_path;

    /// Number of samples per Silero VAD frame (30 ms @ 16 kHz). transcribe-rs's
    /// `SileroVad::speech_probability` requires exactly this many samples per call.
    const SILERO_FRAME_SAMPLES: usize = 480;

    pub struct SileroModel {
        vad: SileroVad,
        /// f32 samples pending until a full 480-sample window is available.
        buf: Vec<f32>,
        /// Most recent windowed probability, returned for hops that do not yet
        /// complete a new window (0.0 until the first window fills).
        last_prob: f32,
    }

    impl SileroModel {
        /// Load the model from `models/vad/silero_vad_v4.onnx`. Errors (missing
        /// file, bad model) propagate so [`crate::Vad`] falls back to energy.
        pub fn load() -> Result<Self> {
            let path = silero_model_path();
            if !path.exists() {
                anyhow::bail!("silero VAD model not present at {}", path.display());
            }
            let vad = SileroVad::new(&path, 0.5)
                .map_err(|e| anyhow::anyhow!("{e}"))
                .context("loading silero VAD onnx model")?;
            Ok(Self {
                vad,
                buf: Vec::with_capacity(SILERO_FRAME_SAMPLES * 2),
                last_prob: 0.0,
            })
        }

        /// One hop (256 × i16 @ 16 kHz) → speech probability `0.0..=1.0`. Buffers
        /// into Silero's 480-sample window and runs inference once a window fills,
        /// returning the most recent windowed probability.
        pub fn probability(&mut self, hop: &[i16]) -> Result<f32> {
            for &s in hop {
                self.buf.push(f32::from(s) / 32768.0);
            }
            while self.buf.len() >= SILERO_FRAME_SAMPLES {
                let frame: Vec<f32> = self.buf.drain(0..SILERO_FRAME_SAMPLES).collect();
                self.last_prob = self
                    .vad
                    .speech_probability(&frame)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            Ok(self.last_prob)
        }
    }
}

/// The Intel macOS arm: same API, no ONNX Runtime behind it.
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
mod unavailable {
    use anyhow::Result;

    const UNAVAILABLE: &str = "Silero VAD is not built for Intel macOS: ONNX Runtime ships no \
         x86_64-apple-darwin build";

    pub struct SileroModel;

    impl SileroModel {
        /// Always fails, so [`crate::Vad`] falls back to the energy backend.
        pub fn load() -> Result<Self> {
            anyhow::bail!(UNAVAILABLE)
        }

        /// Unreachable: `load()` never returns a model.
        pub fn probability(&mut self, _hop: &[i16]) -> Result<f32> {
            anyhow::bail!(UNAVAILABLE)
        }
    }
}
