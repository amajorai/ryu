//! Voice activity detection for voice mode: a per-frame speech-probability
//! **probe** feeding an endpointing/barge-in **state machine** ([`VadGate`]).
//!
//! ## Two layers
//!
//! - [`VadGate`] — pure logic over probabilities. Hysteresis (separate speech /
//!   silence thresholds) debounces onset; a silence *hangover* past confirmed
//!   speech marks end-of-turn. This is what turns a noisy per-frame signal into
//!   the clean `SpeechStart` / `SpeechEnd` events the session acts on. Always
//!   compiled; fully tested.
//! - [`SpeechProbe`] — turns one 16 kHz / 256-sample (16 ms) hop into a `0.0..=1.0`
//!   speech probability. Two backends:
//!     - **Energy** (default, always available): normalized RMS. Good enough to
//!       make voice mode work — auto turn-taking + barge-in — with zero model deps.
//!     - **TEN VAD** (`voice-vad` feature): the ONNX model, noise-robust. Wired as
//!       a seam here; see [`tenvad`]. Falls back to Energy when the feature is off
//!       or the model isn't present, so the loop never breaks.
//!
//! TEN VAD operates on 16 kHz audio with a 256-sample (16 ms) hop, so the session
//! resamples the client uplink to [`VAD_RATE`] and feeds it through [`Vad::push`].

/// Sample rate the VAD + STT path operates on.
pub const VAD_RATE: u32 = 16_000;
/// Samples per VAD hop (TEN VAD's 16 ms optimized frame at 16 kHz).
pub const HOP_SAMPLES: usize = 256;
/// Milliseconds of audio per hop (`HOP_SAMPLES / VAD_RATE`).
const HOP_MS: f32 = (HOP_SAMPLES as f32 / VAD_RATE as f32) * 1000.0;

/// A turn boundary the gate detected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    /// Speech onset confirmed (past the debounce). During a listening turn this
    /// begins/continues capture; during assistant playback it is the barge-in
    /// trigger.
    SpeechStart,
    /// End-of-turn: silence sustained for the hangover after confirmed speech.
    SpeechEnd,
}

/// Tunables for [`VadGate`]. Defaults chosen for close-talk laptop mics; expose as
/// prefs later (plan note).
#[derive(Clone, Copy, Debug)]
pub struct VadConfig {
    /// Probability at/above which a frame counts as speech.
    pub speech_threshold: f32,
    /// Probability below which a frame counts as silence (hysteresis gap avoids
    /// flapping on the boundary).
    pub silence_threshold: f32,
    /// Confirmed-speech debounce: this much continuous speech before `SpeechStart`.
    pub min_speech_ms: f32,
    /// Silence past confirmed speech before `SpeechEnd` (end-of-turn endpointing).
    pub hangover_ms: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            speech_threshold: 0.5,
            silence_threshold: 0.35,
            min_speech_ms: 120.0,
            hangover_ms: 800.0,
        }
    }
}

/// Endpointing/barge-in state machine over per-frame speech probabilities.
pub struct VadGate {
    cfg: VadConfig,
    /// Onset confirmed (min_speech satisfied) and not yet ended.
    in_speech: bool,
    /// Continuous speech accumulated before onset is confirmed.
    speech_run_ms: f32,
    /// Continuous silence accumulated after confirmed speech.
    silence_run_ms: f32,
}

impl VadGate {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            in_speech: false,
            speech_run_ms: 0.0,
            silence_run_ms: 0.0,
        }
    }

    /// Whether the gate currently considers the user to be speaking.
    pub fn in_speech(&self) -> bool {
        self.in_speech
    }

    /// Reset to the resting (no-speech) state — e.g. at the start of a new turn.
    pub fn reset(&mut self) {
        self.in_speech = false;
        self.speech_run_ms = 0.0;
        self.silence_run_ms = 0.0;
    }

    /// Feed one hop's speech probability; return a boundary event if one crossed.
    pub fn push_prob(&mut self, prob: f32) -> Option<VadEvent> {
        let is_speech = prob >= self.cfg.speech_threshold;
        let is_silence = prob < self.cfg.silence_threshold;

        if self.in_speech {
            if is_silence {
                self.silence_run_ms += HOP_MS;
                if self.silence_run_ms >= self.cfg.hangover_ms {
                    self.reset();
                    return Some(VadEvent::SpeechEnd);
                }
            } else {
                // Any non-silence frame (speech or the hysteresis band) resets the
                // hangover so a brief mid-sentence pause doesn't end the turn.
                self.silence_run_ms = 0.0;
            }
            None
        } else {
            if is_speech {
                self.speech_run_ms += HOP_MS;
                if self.speech_run_ms >= self.cfg.min_speech_ms {
                    self.in_speech = true;
                    self.speech_run_ms = 0.0;
                    self.silence_run_ms = 0.0;
                    return Some(VadEvent::SpeechStart);
                }
            } else {
                // A gap before onset is confirmed drops the partial speech run.
                self.speech_run_ms = 0.0;
            }
            None
        }
    }
}

/// Per-hop speech-probability backend.
enum SpeechProbe {
    /// Normalized-RMS energy heuristic (no model). Always available.
    Energy,
    /// Silero VAD ONNX model (feature `voice-vad`). See [`silero`].
    #[cfg(feature = "voice-vad")]
    Silero(silero::SileroModel),
}

impl SpeechProbe {
    fn probability(&mut self, hop: &[i16]) -> f32 {
        match self {
            SpeechProbe::Energy => energy_probability(hop),
            // Any inference error (bad frame, model quirk) falls back per-hop to
            // the always-available energy heuristic, so voice mode is never worse
            // off than without the model.
            #[cfg(feature = "voice-vad")]
            SpeechProbe::Silero(model) => model
                .probability(hop)
                .unwrap_or_else(|_| energy_probability(hop)),
        }
    }

    fn label(&self) -> &'static str {
        match self {
            SpeechProbe::Energy => "energy",
            #[cfg(feature = "voice-vad")]
            SpeechProbe::Silero(_) => "silero",
        }
    }
}

/// Reference RMS (i16 scale) that maps to ~speech level. Normal speech at a laptop
/// mic sits well above room tone; this puts the `0.5` speech threshold roughly at
/// conversational loudness.
const ENERGY_REF_RMS: f32 = 900.0;

/// Normalized-RMS speech probability for one hop (fallback backend).
fn energy_probability(hop: &[i16]) -> f32 {
    if hop.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = hop.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let rms = (sum_sq / hop.len() as f64).sqrt() as f32;
    (rms / ENERGY_REF_RMS).clamp(0.0, 1.0)
}

/// Complete VAD: buffers the 16 kHz uplink into hops, runs the probe, and drives
/// the gate. One instance per voice session.
pub struct Vad {
    probe: SpeechProbe,
    gate: VadGate,
    /// Sub-hop remainder carried between `push` calls (uplink frames rarely align
    /// to 256 samples).
    pending: Vec<i16>,
}

impl Vad {
    /// Build the VAD, preferring Silero when built + the model is present, else the
    /// energy backend. Never fails — degradation is silent (logged once).
    pub fn new() -> Self {
        let probe = Self::best_probe();
        tracing::info!("voice VAD backend: {}", probe.label());
        Self {
            probe,
            gate: VadGate::new(VadConfig::default()),
            pending: Vec::with_capacity(HOP_SAMPLES * 2),
        }
    }

    #[cfg(feature = "voice-vad")]
    fn best_probe() -> SpeechProbe {
        match silero::SileroModel::load() {
            Ok(model) => SpeechProbe::Silero(model),
            Err(e) => {
                tracing::warn!(
                    "Silero VAD model unavailable ({e:#}); falling back to energy VAD. \
                     The model is fetched by default during onboarding."
                );
                SpeechProbe::Energy
            }
        }
    }

    #[cfg(not(feature = "voice-vad"))]
    fn best_probe() -> SpeechProbe {
        SpeechProbe::Energy
    }

    /// Whether the user is currently mid-utterance per the gate.
    pub fn in_speech(&self) -> bool {
        self.gate.in_speech()
    }

    /// Reset the gate (new turn); keeps any probe/model state.
    pub fn reset(&mut self) {
        self.gate.reset();
        self.pending.clear();
    }

    /// Feed 16 kHz mono PCM; return any boundary events across the contained hops.
    pub fn push(&mut self, pcm_16k: &[i16]) -> Vec<VadEvent> {
        self.pending.extend_from_slice(pcm_16k);
        let mut events = Vec::new();
        let mut offset = 0;
        while offset + HOP_SAMPLES <= self.pending.len() {
            let hop = &self.pending[offset..offset + HOP_SAMPLES];
            let prob = self.probe.probability(hop);
            if let Some(ev) = self.gate.push_prob(prob) {
                events.push(ev);
            }
            offset += HOP_SAMPLES;
        }
        // Drop the consumed hops, keep the remainder.
        if offset > 0 {
            self.pending.drain(0..offset);
        }
        events
    }
}

impl Default for Vad {
    fn default() -> Self {
        Self::new()
    }
}

// ── Silero VAD model download (always compiled) ───────────────────────────────
//
// The model bytes are fetched by onboarding regardless of the `voice-vad` build
// feature (mirrors parakeet: the download + path are always present; only the
// ONNX inference is gated). Originally this seam targeted TEN VAD, but that
// model's ONNX is not usable standalone (its feature extraction lives in a closed
// precompiled native lib), so Silero VAD (fully open) is used instead.

/// Filename of the Silero VAD ONNX model in `~/.ryu/models/`.
pub const SILERO_MODEL_FILE: &str = "silero_vad_v4.onnx";

/// Default Silero VAD v4 model URL (snakers4/silero-vad, MIT/Apache). This is the
/// LSTM (`input`/`sr`/`h`/`c` → `output`/`hn`/`cn`) variant `transcribe_rs::vad::
/// SileroVad` expects. Override via `RYU_SILERO_VAD_MODEL_URL`.
pub const SILERO_MODEL_URL: &str =
    "https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx";

/// SHA-256 of the default Silero VAD model. Override via
/// `RYU_SILERO_VAD_MODEL_SHA256` (empty string skips verification).
pub const SILERO_MODEL_SHA256: &str =
    "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28";

/// Resolved path of the Silero VAD model on disk (`~/.ryu/models/…`).
pub fn silero_model_path() -> std::path::PathBuf {
    crate::paths::ryu_dir()
        .join("models")
        .join(SILERO_MODEL_FILE)
}

/// Download spec for the Silero VAD model (used by onboarding). Honors the
/// `RYU_SILERO_VAD_MODEL_URL` / `RYU_SILERO_VAD_MODEL_SHA256` overrides.
pub fn silero_download_spec() -> crate::downloads::DownloadSpec {
    let url = std::env::var("RYU_SILERO_VAD_MODEL_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| SILERO_MODEL_URL.to_string());
    let sha = std::env::var("RYU_SILERO_VAD_MODEL_SHA256")
        .ok()
        .unwrap_or_else(|| SILERO_MODEL_SHA256.to_string());
    crate::downloads::DownloadSpec {
        kind: crate::downloads::DownloadKind::Voice,
        label: "Silero VAD model".to_string(),
        url,
        dest: silero_model_path(),
        sha256: (!sha.is_empty()).then_some(sha),
        version_record: Some(crate::downloads::VersionRecord {
            store_key: "vad-model:silero-v4".to_string(),
            version: SILERO_MODEL_FILE.to_string(),
        }),
    }
}

/// Number of samples per Silero VAD frame (30 ms @ 16 kHz). transcribe-rs's
/// `SileroVad::speech_probability` requires exactly this many samples per call.
#[cfg(feature = "voice-vad")]
const SILERO_FRAME_SAMPLES: usize = 480;

/// Silero VAD ONNX backend (feature `voice-vad`), via transcribe-rs's tested
/// `SileroVad`. Our gate feeds 256-sample hops but Silero needs 480-sample
/// windows, so we buffer hops into windows and cache the last windowed
/// probability for the hops in between.
#[cfg(feature = "voice-vad")]
pub mod silero {
    use anyhow::{Context, Result};
    use transcribe_rs::vad::SileroVad;

    use super::{silero_model_path, SILERO_FRAME_SAMPLES};

    pub struct SileroModel {
        vad: SileroVad,
        /// f32 samples pending until a full 480-sample window is available.
        buf: Vec<f32>,
        /// Most recent windowed probability, returned for hops that do not yet
        /// complete a new window (0.0 until the first window fills).
        last_prob: f32,
    }

    impl SileroModel {
        /// Load the model from `~/.ryu/models/silero_vad_v4.onnx`. Errors (missing
        /// file, bad model) propagate so [`super::Vad`] falls back to energy.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed a sequence of probabilities one hop at a time; collect events.
    fn run(gate: &mut VadGate, probs: &[f32]) -> Vec<VadEvent> {
        probs.iter().filter_map(|&p| gate.push_prob(p)).collect()
    }

    #[test]
    fn onset_fires_after_min_speech_debounce() {
        // min_speech 120ms @ 16ms/hop => 8 hops to confirm.
        let mut gate = VadGate::new(VadConfig::default());
        // 7 speech hops: not yet confirmed.
        assert!(run(&mut gate, &[1.0; 7]).is_empty());
        // 8th confirms onset.
        assert_eq!(gate.push_prob(1.0), Some(VadEvent::SpeechStart));
        assert!(gate.in_speech());
    }

    #[test]
    fn brief_blip_before_onset_does_not_fire() {
        let mut gate = VadGate::new(VadConfig::default());
        assert!(run(&mut gate, &[1.0, 1.0, 0.0, 1.0, 0.0]).is_empty());
        assert!(!gate.in_speech());
    }

    #[test]
    fn endpoint_fires_after_hangover() {
        let mut gate = VadGate::new(VadConfig::default());
        // Confirm speech (8 hops).
        run(&mut gate, &[1.0; 8]);
        assert!(gate.in_speech());
        // hangover 800ms @ 16ms/hop => 50 silence hops to end.
        let events = run(&mut gate, &[0.0; 50]);
        assert_eq!(events, vec![VadEvent::SpeechEnd]);
        assert!(!gate.in_speech());
    }

    #[test]
    fn mid_sentence_pause_does_not_end_turn() {
        let mut gate = VadGate::new(VadConfig::default());
        run(&mut gate, &[1.0; 8]);
        // A short 400ms silence (25 hops) then speech again — no SpeechEnd.
        assert!(run(&mut gate, &[0.0; 25]).is_empty());
        assert!(run(&mut gate, &[1.0; 5]).is_empty());
        assert!(gate.in_speech());
    }

    #[test]
    fn energy_probability_ranks_loud_over_quiet() {
        let quiet = vec![0i16; HOP_SAMPLES];
        let loud: Vec<i16> = (0..HOP_SAMPLES)
            .map(|i| if i % 2 == 0 { 8000 } else { -8000 })
            .collect();
        assert!(energy_probability(&quiet) < 0.1);
        assert!(energy_probability(&loud) > 0.9);
    }

    #[test]
    fn vad_hops_across_unaligned_pushes() {
        let mut vad = Vad {
            probe: SpeechProbe::Energy,
            gate: VadGate::new(VadConfig::default()),
            pending: Vec::new(),
        };
        // Push 100 samples at a time (unaligned to 256); loud enough to be speech.
        let chunk: Vec<i16> = (0..100)
            .map(|i| if i % 2 == 0 { 8000 } else { -8000 })
            .collect();
        let mut saw_start = false;
        for _ in 0..40 {
            if vad.push(&chunk).contains(&VadEvent::SpeechStart) {
                saw_start = true;
            }
        }
        assert!(saw_start, "expected an onset from sustained loud audio");
    }
}
