"""KittenTTS backend — ultra-light ONNX TTS, CPU-only, fixed expressive voices.

Upstream: https://github.com/KittenML/KittenTTS (Apache-2.0). The library bundles
its own g2p/phonemization, so we just call `generate(text, voice=...)` and get a
24 kHz numpy array back. Model id is overridable via `RYU_KITTEN_MODEL`.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np

from ..registry import EngineConfig, get_config

_MODEL_ID = os.environ.get("RYU_KITTEN_MODEL", "KittenML/kitten-tts-mini-0.8")


class KittenBackend:
    config: EngineConfig = get_config("kitten")  # type: ignore[assignment]

    def __init__(self) -> None:
        self._model = None

    def load(self) -> None:
        if self._model is not None:
            return
        from kittentts import KittenTTS  # heavy import, deferred

        self._model = KittenTTS(_MODEL_ID)

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
        audio = self._model.generate(text, voice=chosen, speed=speed)
        return np.asarray(audio, dtype=np.float32), self.config.sample_rate

    def unload(self) -> None:
        self._model = None

    def is_loaded(self) -> bool:
        return self._model is not None
