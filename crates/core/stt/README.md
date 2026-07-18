# ryu-stt

Speech-to-text modality primitive for Ryu: `transcribe(audio) -> text` behind a
swappable engine seam.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: the voice / meetings / hardware data paths reach
it unconditionally. It carries **zero dependency on `apps/core`**. Host couplings
it cannot own (whisper base-url, Gateway url/bearer, the parakeet model dir) inject
via the narrow `SttHost` trait.

## Key API (`src/lib.rs`, `src/parakeet.rs`)

- `SttHost` — supplies whisper base-url, Gateway url/bearer, parakeet model dir.
- `transcribe_wav` / `transcribe_wav_detailed` — the entry points.
- `Transcription` / `TranscriptSegment` — result types.
- `default_stt_engine()` — the cross-surface default engine id.
- `mod parakeet` — the in-process ONNX inference path.

## Swap seam

Three engines behind one `transcribe`:
- **parakeet ONNX** — in-process default, the genuine hot path, behind the
  `voice-parakeet` feature (pulls `transcribe-rs` + native ONNX Runtime, plus a
  process-global lazily-loaded model). With the feature off, `parakeet::transcribe`
  returns a clear "not built" error and the default falls back to whisper.cpp.
- **whisper.cpp** — thin HTTP proxy to a local whisper server.
- **Gateway-routed cloud Whisper** — thin HTTP proxy through the Gateway.

## Consumed as

Compiled-into-Core crate (default path dependency); `voice-parakeet` off by default
to keep `cargo test` / CI lean and the default build free of the native ONNX dep.
