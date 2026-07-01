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
    /// TEN VAD ONNX model (feature `voice-vad`). See [`tenvad`].
    #[cfg(feature = "voice-vad")]
    TenVad(tenvad::TenVadModel),
}

impl SpeechProbe {
    fn probability(&mut self, hop: &[i16]) -> f32 {
        match self {
            SpeechProbe::Energy => energy_probability(hop),
            #[cfg(feature = "voice-vad")]
            SpeechProbe::TenVad(model) => model
                .probability(hop)
                .unwrap_or_else(|_| energy_probability(hop)),
        }
    }

    fn label(&self) -> &'static str {
        match self {
            SpeechProbe::Energy => "energy",
            #[cfg(feature = "voice-vad")]
            SpeechProbe::TenVad(_) => "ten-vad",
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
    /// Build the VAD, preferring TEN VAD when built + present, else the energy
    /// backend. Never fails — degradation is silent (logged once).
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
        match tenvad::TenVadModel::load() {
            Ok(model) => SpeechProbe::TenVad(model),
            Err(e) => {
                tracing::warn!(
                    "TEN VAD model unavailable ({e:#}); falling back to energy VAD. \
                     Install the TEN VAD model to enable noise-robust detection."
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

/// TEN VAD ONNX backend (feature `voice-vad`).
///
/// SEAM: TEN VAD ships an open-source ONNX model + preprocessing, but the exact
/// tensor I/O (feature preprocessing + whether hidden state is threaded across
/// frames) is model-file specific and must be wired against the real
/// `ten-vad.onnx` in hand — do NOT guess the tensor layout. Until then `load`
/// returns an error, so [`Vad`] transparently uses the energy backend. When
/// wiring: load via `ort` (the same runtime `voice-parakeet` pulls), fetch the
/// model through a downloader mirroring
/// `crate::sidecar::providers::parakeet::downloader`, and implement
/// `probability` = preprocess(hop) → run → read the speech-prob output.
#[cfg(feature = "voice-vad")]
pub mod tenvad {
    use anyhow::{bail, Result};

    pub struct TenVadModel {
        // ort::Session + carried state go here once wired.
        _private: (),
    }

    impl TenVadModel {
        pub fn load() -> Result<Self> {
            bail!(
                "TEN VAD ONNX inference is not yet wired (needs the model file to fix \
                 preprocessing + tensor I/O); using the energy VAD fallback"
            )
        }

        /// One hop (256 × i16 @ 16 kHz) → speech probability `0.0..=1.0`.
        pub fn probability(&mut self, _hop: &[i16]) -> Result<f32> {
            bail!("TEN VAD model not wired")
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
