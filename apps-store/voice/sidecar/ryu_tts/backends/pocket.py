"""Pocket TTS backend — Kyutai's 100M CPU TTS with voice cloning.

Upstream: https://github.com/kyutai-labs/pocket-tts. Runs ~6x realtime on a
laptop CPU with ~200ms to first audio. Supports preset voices *and* cloning from
a reference wav (path or URL) via `reference_audio`. Output is a torch tensor; we
convert to numpy. Sample rate comes from the model at runtime.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..registry import EngineConfig, get_config


class PocketBackend:
    config: EngineConfig = get_config("pocket")  # type: ignore[assignment]

    def __init__(self) -> None:
        self._model = None

    def load(self) -> None:
        if self._model is not None:
            return
        from pocket_tts import TTSModel  # heavy import, deferred

        self._model = TTSModel.load_model()

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
        # Cloning takes precedence: a reference wav/url is itself a valid prompt.
        prompt = reference_audio or voice or self.config.default_voice
        voice_state = self._model.get_state_for_audio_prompt(prompt)
        audio = self._model.generate_audio(voice_state, text)
        samples = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
        sample_rate = int(getattr(self._model, "sample_rate", self.config.sample_rate))
        return np.asarray(samples, dtype=np.float32), sample_rate

    def unload(self) -> None:
        self._model = None

    def is_loaded(self) -> bool:
        return self._model is not None
