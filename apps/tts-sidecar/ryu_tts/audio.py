"""Audio encoding helpers — turn a backend's numpy/tensor output into WAV bytes.

Kept dependency-free (stdlib `wave` only) so the encode path never pulls
soundfile/scipy. Backends return raw samples; the server returns `audio/wav` so
Core just streams the bytes through `/api/voice/speak`.
"""

from __future__ import annotations

import io
import wave

import numpy as np


def to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode a 1-D (mono) sample array as 16-bit PCM WAV.

    Accepts float arrays in [-1, 1] or integer arrays. Multi-channel input is
    down-mixed to mono by averaging channels.
    """
    arr = np.asarray(samples)

    # Down-mix anything 2-D to mono (average across the channel axis).
    if arr.ndim > 1:
        # Heuristic: the smaller axis is channels.
        channel_axis = int(np.argmin(arr.shape))
        arr = arr.mean(axis=channel_axis)
    arr = arr.reshape(-1)

    if arr.dtype.kind == "f":
        arr = np.clip(arr, -1.0, 1.0)
        pcm = (arr * 32767.0).astype("<i2")
    elif arr.dtype == np.int16:
        pcm = arr.astype("<i2")
    else:
        # Integer of another width — scale down conservatively to int16.
        pcm = np.clip(arr, -32768, 32767).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()
