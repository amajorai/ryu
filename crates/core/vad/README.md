# ryu-vad

Voice-activity-detection modality primitive for Ryu: `detect(frame) -> speech_prob`
feeding an endpointing / barge-in state machine.

## Role in the decomposition

An extracted Core capability crate — **in-process FOREVER** (per-frame hot path,
never IPC) and consumed as a **non-optional path dependency**: the voice session
drives it per uplink hop. It carries **zero dependency on `apps/core`**. The one
host coupling it cannot own — the `~/.ryu` data dir the Silero model resolves
against (user-relocatable at runtime) — is injected via the narrow `VadHost` trait
installed at boot (`set_global_host`).

## Key API (`src/lib.rs`)

- `VadHost` — boot-installed trait supplying the runtime data dir.
- `VadGate` / `VadConfig` / `VadEvent` — the endpointing + barge-in state machine
  over per-frame speech probabilities (always compiled).
- `Vad` — the detector; energy speech-probability backend always compiled, Silero
  ONNX preferred when built.
- `silero_model_path()` / `silero_download_spec()` — Silero model metadata (no
  sidecar; single-file model, resolved via `ryu-downloads`).
- `mod silero` — the feature-gated ONNX inference backend.

## Swap seam

Two speech-probability backends behind one detector:
- **energy** — always compiled, keeps voice mode working with no native deps.
- **Silero VAD ONNX** — noise-robust, genuinely in-process, behind the
  `voice-vad` feature (pulls `transcribe-rs` + native ONNX Runtime). Falls back
  **per-hop** to energy on any inference error or missing model, so voice mode
  never breaks.

## Consumed as

Compiled-into-Core crate (default path dependency); `voice-vad` off by default to
keep `cargo test` / CI lean, enabled by the shipped dev/release binaries.
