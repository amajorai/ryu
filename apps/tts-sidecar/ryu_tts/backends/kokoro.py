"""Kokoro 82M backend — the Ryu default TTS engine.

Upstream: https://github.com/hexgrad/kokoro (model, Apache-2.0) served through the
`kokoro-onnx` runtime (https://github.com/thewh1teagle/kokoro-onnx, MIT) so it runs
on CPU via ONNX Runtime with no torch dependency — the same "runs on most machines"
posture as the bundled Gemma 4 chat default.

The two model artifacts (`kokoro-v1.0.onnx` weights + `voices-v1.0.bin` voice pack)
are downloaded by **Core** during onboarding (mirroring the Gemma/nomic GGUFs), and
Core injects their local paths via `RYU_KOKORO_MODEL` / `RYU_KOKORO_VOICES` when it
spawns the sidecar. When those env vars are unset we fall back to the conventional
filenames in the process cwd (dev convenience) — both are overridable, never a lock.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np

from ..registry import EngineConfig, get_config

# Local artifact paths, injected by Core (which owns the download). Bare filenames
# are the dev fallback when Core is not managing the process.
_MODEL_PATH = os.environ.get("RYU_KOKORO_MODEL", "kokoro-v1.0.onnx")
_VOICES_PATH = os.environ.get("RYU_KOKORO_VOICES", "voices-v1.0.bin")


def _to_kokoro_lang(language: str) -> str:
    """Map a BCP-47-ish hint to a kokoro-onnx language code. Kokoro's English is
    `en-us` / `en-gb`; other languages pass through as-is. Defaults to `en-us`."""
    lang = (language or "en").lower().replace("_", "-")
    if lang in ("en", "en-us", "us"):
        return "en-us"
    if lang in ("en-gb", "gb", "uk"):
        return "en-gb"
    return lang


class KokoroBackend:
    config: EngineConfig = get_config("kokoro")  # type: ignore[assignment]

    def __init__(self) -> None:
        self._model = None

    def load(self) -> None:
        if self._model is not None:
            return
        from kokoro_onnx import Kokoro  # heavy import, deferred

        self._model = Kokoro(_MODEL_PATH, _VOICES_PATH)

    def generate(
        self,
        text: str,
        *,
        voice: Optional[str] = None,
        speed: float = 1.0,
        language: str = "en",
        reference_audio: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> tuple[np.ndarray, int]:
        self.load()
        assert self._model is not None
        chosen = voice or self.config.default_voice
        samples, sample_rate = self._model.create(
            text, voice=chosen, speed=speed, lang=_to_kokoro_lang(language)
        )
        return np.asarray(samples, dtype=np.float32), int(sample_rate)

    def unload(self) -> None:
        self._model = None

    def is_loaded(self) -> bool:
        return self._model is not None
