//! Parakeet v3 voice (STT) engine — ONNX-based, runs **alongside** whisper.cpp.
//!
//! Why a separate engine: parakeet is an NVIDIA FastConformer-TDT model that runs
//! on ONNX Runtime, not GGML — whisper.cpp cannot load it. We embed the Rust
//! `transcribe-rs` library (the same engine Handy uses) in-process to run it.
//! Because ONNX Runtime is a heavy native dependency, the actual inference is
//! gated behind the `voice-parakeet` cargo feature.
//!
//! Unlike whisper (an external `whisper-server` process Core proxies over HTTP),
//! parakeet is a library with no server, so there is no process to spawn — the
//! "engine" is an in-process, lazily-loaded model. This is the genuinely
//! in-process hot path of the STT primitive (never IPC).
//!
//! The extracted-model **directory** is resolved by the host (it is a `~/.ryu`
//! path the downloader in Core owns) and passed in, so this crate has ZERO
//! dependency on `apps/core`.

use std::io::Cursor;
use std::path::Path;

use anyhow::{bail, Context, Result};

/// Normalize an uploaded WAV to the exact format required by Parakeet's ONNX
/// model: 16 kHz, mono, signed 16-bit PCM. `transcribe-rs` rejects other WAV
/// headers instead of resampling them, while browser microphones and TTS
/// engines commonly produce 24/48 kHz or stereo audio. Keeping conversion at
/// this boundary makes the public Core route truthful for those valid inputs
/// and leaves the extracted STT crate independent of Core.
pub fn normalize_wav_to_16k_mono(audio: &[u8]) -> Result<Vec<u8>> {
    let mut reader =
        hound::WavReader::new(Cursor::new(audio)).context("reading WAV input for Parakeet")?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels);
    if channels == 0 {
        bail!("WAV input has no channels");
    }
    if spec.sample_rate == 0 {
        bail!("WAV input has no sample rate");
    }
    // Bound both decoding and resampling before allocating sample vectors.
    // Two hours supports long recordings while keeping normalized PCM bounded.
    const MAX_DURATION_SECONDS: u64 = 7200;
    const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
    if audio.len() > MAX_INPUT_BYTES {
        bail!("WAV input exceeds 32 MiB");
    }
    let frames = u64::from(reader.duration());
    if frames == 0 || frames > u64::from(spec.sample_rate) * MAX_DURATION_SECONDS {
        bail!("WAV input must contain at most two hours of audio");
    }
    let scaled = frames
        .checked_mul(16_000)
        .context("WAV output size overflow")?;
    let output_len =
        usize::try_from((scaled + u64::from(spec.sample_rate) / 2) / u64::from(spec.sample_rate))
            .context("WAV output size exceeds platform limits")?
            .max(1);
    if output_len > (32 * 1024 * 1024 - 44) / 2 {
        bail!("Normalized WAV exceeds the sample budget");
    }

    let interleaved = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 8) => reader
            .samples::<i8>()
            .map(|sample| sample.map(|value| value as f32 / 128.0))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("decoding 8-bit WAV input")?,
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("decoding 16-bit WAV input")?,
        (hound::SampleFormat::Int, bits @ (24 | 32)) => {
            let scale = ((1_i64 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("decoding 24/32-bit WAV input")?
        }
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("decoding 32-bit float WAV input")?,
        _ => bail!(
            "unsupported WAV format: {} channels, {} Hz, {}-bit {:?}; expected PCM or 32-bit float",
            spec.channels,
            spec.sample_rate,
            spec.bits_per_sample,
            spec.sample_format
        ),
    };

    if interleaved.len() % channels != 0 {
        bail!("WAV sample count is not divisible by its channel count");
    }
    let mono: Vec<f32> = interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
        .collect();
    if mono.is_empty() {
        bail!("WAV input has no samples");
    }

    let ratio = spec.sample_rate as f64 / 16_000.0;
    let mut normalized = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let position = index as f64 * ratio;
        let lower = position.floor() as usize;
        let upper = (lower + 1).min(mono.len() - 1);
        let fraction = (position - lower as f64) as f32;
        let sample = mono[lower.min(mono.len() - 1)]
            + (mono[upper] - mono[lower.min(mono.len() - 1)]) * fraction;
        normalized.push((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16);
    }

    let output_spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut output, output_spec)
            .context("creating normalized Parakeet WAV")?;
        for sample in normalized {
            writer
                .write_sample(sample)
                .context("writing normalized Parakeet WAV")?;
        }
        writer
            .finalize()
            .context("finalizing normalized Parakeet WAV")?;
    }
    Ok(output.into_inner())
}

// In-process inference needs BOTH the `voice-parakeet` feature AND a target ONNX
// Runtime ships for. Intel macOS (`x86_64-apple-darwin`) has no ORT prebuilt, so
// Cargo.toml declares transcribe-rs for every other target only: there the
// feature resolves (every build site passes the same `--features` string) but
// this module compiles its "not built" arm, exactly like a lean build, with a
// reason that names the platform instead of a missing flag.

/// Why [`transcribe`] refuses on a build without in-process inference. Both
/// arms name the whisper.cpp fallback.
#[cfg(not(feature = "voice-parakeet"))]
const NOT_BUILT: &str = "parakeet inference is not built into this build. Rebuild with \
     `--features voice-parakeet` (pulls ONNX Runtime via transcribe-rs), or use the \
     whisper.cpp voice engine instead.";
#[cfg(all(
    feature = "voice-parakeet",
    target_os = "macos",
    target_arch = "x86_64"
))]
const NOT_BUILT: &str = "parakeet inference is not built for Intel macOS: ONNX Runtime ships \
     no x86_64-apple-darwin build, so `voice-parakeet` compiles no engine on this platform. \
     Use the whisper.cpp voice engine instead.";

/// Transcribe audio bytes (a WAV upload) with parakeet. Used by the STT dispatch
/// (`transcribe_wav_detailed`) when the parakeet engine is selected. `model_dir`
/// is the extracted ONNX model directory, resolved and owned by the host.
///
/// Without the `voice-parakeet` feature this returns a clear, actionable error
/// rather than silently failing.
pub async fn transcribe(audio: Vec<u8>, model_dir: std::path::PathBuf) -> anyhow::Result<String> {
    #[cfg(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))]
    {
        // Inference is CPU-bound and blocking — run it off the async runtime.
        tokio::task::spawn_blocking(move || engine::transcribe_wav_bytes(&audio, &model_dir))
            .await
            .map_err(|e| anyhow::anyhow!("parakeet transcribe task panicked: {e}"))?
    }
    #[cfg(not(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    )))]
    {
        let _ = (audio, model_dir);
        anyhow::bail!(NOT_BUILT)
    }
}

/// Ensure the parakeet model is loaded into memory (fast first-transcription).
/// A no-op error-free call when the `voice-parakeet` feature is off.
pub fn preload(model_dir: &Path) -> anyhow::Result<()> {
    #[cfg(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))]
    {
        engine::preload(model_dir)
    }
    #[cfg(not(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    )))]
    {
        let _ = model_dir;
        Ok(())
    }
}

/// Drop the in-memory parakeet model. A no-op when the feature is off.
pub fn unload() {
    #[cfg(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))]
    engine::unload();
}

// ── In-process ONNX inference (feature-gated) ─────────────────────────────────
//
// transcribe-rs is a git-only crate (cjpais/transcribe-rs) pulling ort 2.x +
// ONNX Runtime. It is added under the `voice-parakeet` feature in Cargo.toml so
// the default build stays free of the native dependency. This module is the
// only place that touches it.
#[cfg(all(
    feature = "voice-parakeet",
    not(all(target_os = "macos", target_arch = "x86_64"))
))]
mod engine {
    use std::io::Write;
    use std::path::Path;
    use std::sync::Mutex;

    use anyhow::{Context, Result};
    use once_cell::sync::Lazy;
    use transcribe_rs::onnx::parakeet::ParakeetModel;
    use transcribe_rs::onnx::Quantization;
    use transcribe_rs::{SpeechModel, TranscribeOptions};

    /// Process-global model, lazily loaded. Parakeet inference is stateful
    /// (`&mut self`), so it is guarded by a Mutex and reused across requests.
    static MODEL: Lazy<Mutex<Option<ParakeetModel>>> = Lazy::new(|| Mutex::new(None));

    /// Load the model into memory if not already loaded. `ParakeetModel::load`
    /// both constructs and loads from the downloaded int8 model directory.
    pub fn preload(model_dir: &Path) -> Result<()> {
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        if guard.is_some() {
            return Ok(());
        }
        let model = ParakeetModel::load(model_dir, &Quantization::Int8)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("loading parakeet ONNX model")?;
        *guard = Some(model);
        Ok(())
    }

    /// Drop the in-memory model.
    pub fn unload() {
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        *guard = None;
    }

    /// Transcribe raw WAV bytes after normalizing the upload to Parakeet's
    /// required 16 kHz mono PCM format.
    pub fn transcribe_wav_bytes(audio: &[u8], model_dir: &Path) -> Result<String> {
        preload(model_dir)?;
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        let model = guard.as_mut().context("parakeet model not loaded")?;

        // transcribe-rs reads WAV from a path (hound) and requires 16 kHz mono
        // PCM. Normalize browser/TTS uploads before staging the temp file.
        let normalized = super::normalize_wav_to_16k_mono(audio)?;
        let mut tmp = tempfile::Builder::new()
            .suffix(".wav")
            .tempfile()
            .context("creating temp wav for parakeet")?;
        tmp.write_all(&normalized)
            .context("writing normalized temp wav")?;
        let path = tmp.path().to_path_buf();

        let result = model
            .transcribe_file(&path, &TranscribeOptions::default())
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("parakeet transcription failed")?;
        Ok(result.text.trim().to_string())
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::normalize_wav_to_16k_mono;
    use std::io::Cursor;

    #[test]
    fn converts_stereo_24khz_input_to_parakeet_format() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 24_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut input = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut input, spec).expect("input wav");
            for index in 0..2_400 {
                let sample = if index % 80 < 40 { 12_000 } else { -12_000 };
                writer.write_sample(sample).expect("left sample");
                writer.write_sample(sample / 2).expect("right sample");
            }
            writer.finalize().expect("finalize input wav");
        }

        let output = normalize_wav_to_16k_mono(&input.into_inner()).expect("normalize wav");
        let mut reader = hound::WavReader::new(Cursor::new(output)).expect("output wav");
        let output_spec = reader.spec();
        assert_eq!(output_spec.channels, 1);
        assert_eq!(output_spec.sample_rate, 16_000);
        assert_eq!(output_spec.bits_per_sample, 16);
        assert_eq!(output_spec.sample_format, hound::SampleFormat::Int);
        let samples = reader
            .samples::<i16>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("output samples");
        assert_eq!(samples.len(), 1_600);
        assert!(samples.iter().any(|sample| *sample != 0));
    }

    #[test]
    fn keeps_native_16khz_mono_input_usable() {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut input = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut input, spec).expect("input wav");
            for sample in [0_i16, 100, -100, 200] {
                writer.write_sample(sample).expect("sample");
            }
            writer.finalize().expect("finalize input wav");
        }
        let output = normalize_wav_to_16k_mono(&input.into_inner()).expect("normalize native wav");
        let mut reader = hound::WavReader::new(Cursor::new(output)).expect("output wav");
        let samples = reader
            .samples::<i16>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("output samples");
        assert_eq!(samples, vec![0, 100, -100, 200]);
    }
}

// The default `cargo test` build compiles WITHOUT `voice-parakeet` (ONNX Runtime
// is a heavy native dep — see Cargo.toml). These tests pin the feature-off
// fallbacks: `transcribe` returns a clear, actionable error; `preload`/`unload`
// are safe no-ops. The real-inference path is deliberately not exercised here —
// it would require downloading and loading a real ONNX model.
#[cfg(all(
    test,
    not(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))
))]
mod tests {
    #[test]
    fn rejects_resampling_amplification_before_allocating_output() {
        for (rate, frames) in [(1, 8000), (2, 16000)] {
            let mut input = std::io::Cursor::new(Vec::new());
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            {
                let mut writer = hound::WavWriter::new(&mut input, spec).unwrap();
                for _ in 0..frames {
                    writer.write_sample(0_i16).unwrap();
                }
                writer.finalize().unwrap();
            }
            assert!(super::normalize_wav_to_16k_mono(&input.into_inner()).is_err());
        }
    }
    use std::path::PathBuf;

    #[tokio::test]
    async fn transcribe_without_feature_returns_actionable_error() {
        let err = super::transcribe(b"audio".to_vec(), PathBuf::from("/nope/model"))
            .await
            .expect_err("feature-off build must not silently succeed");
        let msg = format!("{err:#}");
        assert!(msg.contains("not built"), "got: {msg}");
        assert!(msg.contains("voice-parakeet"), "got: {msg}");
        assert!(
            msg.contains("whisper.cpp"),
            "should suggest the fallback: {msg}"
        );
    }

    #[test]
    fn preload_without_feature_is_ok_noop() {
        // No model is on disk; the feature-off path must still return Ok(()).
        super::preload(&PathBuf::from("/definitely/missing")).expect("no-op preload");
    }
}
