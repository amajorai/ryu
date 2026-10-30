//! Unit tests for the VAD gate, probes and the Silero runtime proof.

use super::*;

#[cfg(all(
    feature = "voice-vad",
    not(all(target_os = "macos", target_arch = "x86_64"))
))]
#[test]
#[ignore = "requires verified local voice assets; run explicitly with RYU_VOICE_PROOF_DIR"]
fn genuine_silero_inference_and_voice_endpointing_runtime_proof() {
    struct ProofHost(Arc<std::sync::Mutex<PathBuf>>);
    impl VadHost for ProofHost {
        fn ryu_dir(&self) -> PathBuf {
            self.0.lock().unwrap().clone()
        }
    }
    let assets = PathBuf::from(std::env::var_os("RYU_VOICE_PROOF_DIR")
        .expect("prepare STT runtime_assets/prepare.py and set RYU_VOICE_PROOF_DIR; missing assets never skip this proof"));
    let missing = assets.join("nonexistent-vad-proof-directory");
    assert!(!missing.exists());
    let directory = Arc::new(std::sync::Mutex::new(missing));
    set_global_host(Arc::new(ProofHost(directory.clone())));
    assert!(
        silero::SileroModel::load().is_err(),
        "missing ONNX weights must fail strict engine initialization"
    );
    assert!(
        matches!(Vad::new().probe, SpeechProbe::Energy),
        "missing model must retain the documented fallback"
    );

    *directory.lock().unwrap() = assets.clone();
    let mut reader =
        hound::WavReader::open(assets.join("jfk.wav")).expect("verified authentic speech fixture");
    assert_eq!(reader.spec().sample_rate, VAD_RATE);
    assert_eq!(reader.spec().channels, 1);
    let speech = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let silence = vec![0_i16; VAD_RATE as usize * 2];
    let mut strict = silero::SileroModel::load().expect("real Silero v4 ONNX weights must initialize; energy fallback is not a passing inference proof");
    for hop in silence.chunks(HOP_SAMPLES) {
        let probability = strict.probability(hop).expect("Silero silence inference");
        assert!(
            probability.is_finite() && (0.0..0.1).contains(&probability),
            "silence probability {probability}"
        );
    }
    let mut peak = 0.0_f32;
    for hop in speech.chunks(HOP_SAMPLES) {
        let probability = strict
            .probability(hop)
            .expect("Silero speech inference must never be replaced by energy");
        assert!(probability.is_finite() && (0.0..=1.0).contains(&probability));
        peak = peak.max(probability);
    }
    assert!(
        peak > 0.8,
        "real speech must rank above silence; peak={peak}"
    );
    let mut final_probability = 1.0;
    for hop in silence.chunks(HOP_SAMPLES) {
        final_probability = strict
            .probability(hop)
            .expect("Silero endpoint silence inference");
    }
    assert!(
        final_probability < 0.1,
        "speech state must decay during silence: {final_probability}"
    );

    let mut vad = Vad::new();
    assert!(
        matches!(vad.probe, SpeechProbe::Silero(_)),
        "full voice path must use actual Silero, not silently pass on energy"
    );
    assert!(
        vad.push(&silence).is_empty(),
        "silence must not start a turn"
    );
    let mut events = Vec::new();
    // Actual client frames rarely align to the model's 480-sample window
    // or the voice gate's 256-sample hop.
    for frame in speech.chunks(113) {
        events.extend(vad.push(frame));
    }
    assert!(
        events.contains(&VadEvent::SpeechStart),
        "spoken JFK recording must start a voice turn"
    );
    events.extend(vad.push(&silence));
    assert_eq!(
        events.last(),
        Some(&VadEvent::SpeechEnd),
        "silence after speech must finish the turn"
    );
    assert!(!vad.in_speech());
    vad.reset();
    assert!(
        vad.push(&silence).is_empty(),
        "reset must not manufacture a new onset"
    );
}

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
