// No ONNX Runtime exists for Intel macOS, so the feature compiles no engine there
// (see Cargo.toml) and there is nothing to prove.
#![cfg(all(
    feature = "voice-parakeet",
    not(all(target_os = "macos", target_arch = "x86_64"))
))]

use std::path::PathBuf;

struct LocalHost(PathBuf);
impl ryu_stt::SttHost for LocalHost {
    fn whisper_base_url(&self) -> String {
        panic!("Parakeet proof must not fall back to whisper")
    }
    fn gateway_url(&self) -> String {
        panic!("Parakeet proof must not use a cloud service")
    }
    fn gateway_bearer(&self) -> Result<String, String> {
        panic!("Parakeet proof must not use a cloud service")
    }
    fn parakeet_model_dir(&self) -> PathBuf {
        self.0.clone()
    }
}

#[tokio::test]
#[ignore = "requires verified local voice assets; run explicitly with RYU_VOICE_PROOF_DIR"]
async fn genuine_parakeet_transcribes_speech_rejects_bad_audio_and_unloads() {
    let assets = PathBuf::from(std::env::var_os("RYU_VOICE_PROOF_DIR")
        .expect("prepare runtime_assets/prepare.py and set RYU_VOICE_PROOF_DIR; this proof never skips missing assets"));
    let speech =
        std::fs::read(assets.join("jfk.wav")).expect("verified authentic JFK speech fixture");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    ryu_stt::parakeet::unload();
    let missing = tempfile::tempdir().unwrap();
    let error = ryu_stt::transcribe_wav_detailed(
        &client,
        &LocalHost(missing.path().to_owned()),
        speech.clone(),
        "jfk.wav".into(),
        Some("parakeet"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("loading parakeet ONNX model"), "{error}");

    let host = LocalHost(assets.join("models/speech-to-text/parakeet/parakeet-tdt-0.6b-v3-int8"));
    let result = ryu_stt::transcribe_wav_detailed(
        &client,
        &host,
        speech.clone(),
        "jfk.wav".into(),
        Some("parakeet"),
    )
    .await
    .expect("production Parakeet dispatch must load real ONNX weights and infer speech");
    assert_eq!(result.text.trim(),
        "And so, my fellow Americans, ask not what your country can do for you. Ask what you can do for your country.");
    assert!(
        result.segments.is_empty(),
        "Ryu's Parakeet response contract is text-only"
    );

    let error = ryu_stt::transcribe_wav_detailed(
        &client,
        &host,
        b"not a WAV recording".to_vec(),
        "bad.wav".into(),
        Some("parakeet"),
    )
    .await
    .unwrap_err();
    assert!(
        error.contains("WAV"),
        "invalid audio must fail without a transcript: {error}"
    );

    // Cached weights must not turn an invalid request into a successful empty
    // transcript; the next valid recording must still produce the same result.
    let recovered =
        ryu_stt::transcribe_wav(&client, &host, speech, "jfk.wav".into(), Some("parakeet"))
            .await
            .expect("valid speech after malformed upload");
    assert_eq!(recovered.trim(), result.text.trim());
    ryu_stt::parakeet::unload();
    assert!(
        ryu_stt::parakeet::preload(missing.path()).is_err(),
        "unload must discard cached weights"
    );
}
