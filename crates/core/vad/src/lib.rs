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
//!
//! ## Extraction seam
//!
//! VAD is a per-frame HOT-path primitive — in-process FOREVER, never IPC. The one
//! thing this crate cannot own is the active `~/.ryu` **data dir** the Silero model
//! resolves against (dynamic; the user can relocate the data folder at runtime).
//! That is injected through the narrow [`VadHost`] trait, installed once at boot via
//! [`set_global_host`] BEFORE the first voice session (mirrors the
//! `ryu-downloads`/`ryu-crypto` boot-install precedent). The always-compiled energy
//! backend needs no host, so the crate's own tests run without one.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// Kernel coupling the VAD primitive cannot own: the active `~/.ryu` data dir the
/// Silero model resolves against. Core implements this and installs it at boot via
/// [`set_global_host`], before the first voice session can construct a [`Vad`].
pub trait VadHost: Send + Sync {
    /// The active `~/.ryu` data dir (dynamic — the user can relocate it at runtime).
    fn ryu_dir(&self) -> PathBuf;
}

fn host_slot() -> &'static OnceLock<Arc<dyn VadHost>> {
    static HOST: OnceLock<Arc<dyn VadHost>> = OnceLock::new();
    &HOST
}

/// Install the process-global [`VadHost`]. Called once from Core's boot, before the
/// first voice session. Idempotent (a second call is a no-op).
pub fn set_global_host(host: Arc<dyn VadHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host. Strict by design: panics if [`set_global_host`] was not
/// called (only reachable post-boot — the model path + download spec are resolved at
/// voice-session start / onboarding, never before Core wires the host).
fn host() -> Arc<dyn VadHost> {
    host_slot()
        .get()
        .cloned()
        .expect("ryu-vad host not installed — call ryu_vad::set_global_host at boot")
}

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

/// Filename of the Silero VAD ONNX model in `<data dir>/models/vad/`.
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

/// Resolved path of the Silero VAD model on disk (`models/vad/silero_vad_v4.onnx`). Resolves the
/// data dir through the installed [`VadHost`] (panics if the host is not yet set —
/// only reachable post-boot).
pub fn silero_model_path() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::models_dir(
        &host().ryu_dir(),
        ryu_sidecar_runtime::layout::Modality::Vad,
    )
    .join(SILERO_MODEL_FILE)
}

/// Download spec for the Silero VAD model (used by onboarding). Honors the
/// `RYU_SILERO_VAD_MODEL_URL` / `RYU_SILERO_VAD_MODEL_SHA256` overrides.
pub fn silero_download_spec() -> ryu_downloads::DownloadSpec {
    let url = std::env::var("RYU_SILERO_VAD_MODEL_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| SILERO_MODEL_URL.to_string());
    let sha = std::env::var("RYU_SILERO_VAD_MODEL_SHA256")
        .ok()
        .unwrap_or_else(|| SILERO_MODEL_SHA256.to_string());
    ryu_downloads::DownloadSpec {
        kind: ryu_downloads::DownloadKind::Voice,
        role: ryu_downloads::DownloadRole::SpeechModel,
        label: "Silero VAD model".to_string(),
        url,
        dest: silero_model_path(),
        sha256: (!sha.is_empty()).then_some(sha),
        version_record: Some(ryu_downloads::VersionRecord {
            store_key: "vad-model:silero-v4".to_string(),
            version: SILERO_MODEL_FILE.to_string(),
        }),
    }
}

#[cfg(feature = "voice-vad")]
pub mod silero;

#[cfg(test)]
mod tests;
