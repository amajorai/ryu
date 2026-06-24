# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="center" alt="" />&nbsp; Ryu TTS Sidecar

> A universal HTTP front over many text-to-speech engines. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../README.md#repository-layout--licensing)
[![Stack](https://shieldcn.dev/badge/Python-FastAPI-3776AB.svg?logo=python&logoColor=white)](../../README.md)

A thin, universal HTTP runtime that fronts many TTS engines behind one contract, the same pattern `jamiepine/voicebox` (MIT) uses, Ryu-shaped. Ryu Core owns lifecycle, model downloads, the catalog, and the `?engine=` selector on `/api/voice/speak`; this process is a pure inference runtime, the same way Core manages whisper.cpp's `whisper-server` and stable-diffusion.cpp's `sd-server`. Fenced out of the bun/turbo workspace; runs on its own Python toolchain.

**Tier:** OSS, Apache-2.0

## Run

```bash
cd apps/tts-sidecar
python -m venv .venv && . .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -e ".[kitten]"                       # base server + KittenTTS
python -m ryu_tts                                 # serves 127.0.0.1:8085 (RYU_TTS_PORT to override)
```

Or from the repo root: `bun run dev:tts`.

## What it provides

- **The universal contract:** `GET /health`, `GET /engines`, `POST /generate` (→ `audio/wav`), `POST /unload`. The HTTP layer never grows a per-engine branch.
- **Swappable engine registry** (`ryu_tts/registry.py`): adding an engine is one `EngineConfig` row plus one `ryu_tts/backends/<module>.py` implementing the `TtsBackend` protocol (`load`/`generate`/`unload`/`is_loaded`).
- **Seeded engines:** `kitten` (KittenTTS, CPU-only ONNX) and `pocket` (Kyutai Pocket TTS, ~6x realtime CPU, voice cloning via `reference_audio`).
- **Lazy heavy deps:** inference libraries are imported inside backend methods, so a missing dep degrades only that one engine. Tier-B engines (dia, IndexTTS2, MisoTTS, …) plug in via the same path as opt-in extras.

## License

Apache-2.0. See [LICENSE](../../README.md#repository-layout--licensing). © 2026 A Major Pte. Ltd.
