# Real local voice inference proofs

These opt-in tests load genuine Parakeet and Silero ONNX weights through Ryu's
production engines. The standard tests never download models. An explicit proof
run fails if its local assets are missing or inference fails; energy fallback
cannot make the Silero inference proof pass.

Prepare approximately 650 MiB of local assets from the repository root:

```sh
python3 crates/core/stt/tests/runtime_assets/prepare.py
source target/voice-runtime-proof-assets/env.sh
```

The manifest pins the Hugging Face model commit, every model's SHA256, the
vocabulary's Git blob, Microsoft's ONNX Runtime release archive digest, and the
authentic JFK recording distributed in the checksummed `transcribe-rs` crate.
Preparation verifies existing files before reusing them and records provenance
in `verified-assets.json`. `--cache /absolute/path` chooses another asset folder.
The generated environment file uses that folder's genuine ONNX Runtime 1.24.2
library instead of relying on the optional upstream runtime CDN.

With the normal Rust/native build prerequisites configured, run each proof:

```sh
cargo test --locked -j2 -p ryu-stt --features voice-parakeet \
  --test parakeet_runtime_proof -- --ignored --test-threads=1 --nocapture
cargo test --locked -j2 -p ryu-vad --features voice-vad \
  genuine_silero_inference_and_voice_endpointing_runtime_proof \
  -- --ignored --test-threads=1 --nocapture
cargo test --locked -j2 -p ryu-sandbox --features sandbox-wasmtime \
  wasmtime::tests:: -- --test-threads=1 --nocapture
```

Parakeet must produce the exact JFK transcript, reject unavailable weights and
malformed audio, recover for the next recording, and discard cached weights on
unload. Silero must infer low silence and high speech probabilities, initialize
the full voice path with the actual model, and detect turn boundaries across
unaligned input frames. The WASI tests execute real guests, checking filesystem
grants, writes, path traversal refusal, workspace access clamps, compilation
limits, memory limits, and interruption of a guest that never yields.

Compile and verify the configuration used by shipped Core binaries separately:

```sh
cargo test --locked -j2 -p ryu-core \
  --features sandbox-wasmtime,voice-parakeet,voice-vad -- --test-threads=1
cargo build --locked -j2 -p ryu-core \
  --features sandbox-wasmtime,voice-parakeet,voice-vad
```

Passing that normal feature-enabled suite proves its runtime wiring and existing
regressions. It does not substitute for running the explicit inference proofs
above; their ignored status alone is not a passing result.
